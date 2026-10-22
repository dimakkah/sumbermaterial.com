/**
 * find-orphans.js
 *
 * LAYER 1 ONLY — find "orphan" articles (zero inbound internal links from anywhere else on
 * the site) and match each one to candidate "donor" articles that could reasonably link to
 * it. Entirely offline/non-AI (fast, no API calls) — results are stored in `orphans.json`,
 * to be used by `fix-orphans.js` in the next step.
 *
 * Same two-layer split as dedup-lapis1.js / revise-articles.js: this step is cheap and safe
 * to re-run anytime; the AI-assisted step (fix-orphans.js) is the one that costs quota and
 * actually edits files, so it stays separate and rate-limited.
 *
 * HOW "ORPHAN" IS DETECTED:
 *   1. Every article's body is scanned for internal links (the same URL shape
 *      enforceInternalLinks() enforces elsewhere: [text](/section/slug/)).
 *   2. Every found link target is tallied as one inbound link for that URL.
 *   3. Any article whose URL is NEVER a target anywhere else on the site has an inbound
 *      count of 0 — it's an orphan. (Its own outbound links don't count as inbound to itself.)
 *
 * HOW DONORS ARE MATCHED (non-AI, v2 — location-aware):
 *   - Orphan = halaman LOKASI ("Harga X Di Cakung Jakarta"): donor hanya halaman lokasi lain yang
 *       a) produk SAMA & kota SAMA, kelurahan beda  -> relation 'sibling-area' (kelurahan bertetangga diutamakan), atau
 *       b) lokasi SAMA, produk berbeda tapi terkait   -> relation 'same-area-related'.
 *     Kota berbeda (Depok -> Jakarta) TIDAK PERNAH dijadikan donor: pembaca di Depok tidak butuh harga di Cakung.
 *   - Orphan = artikel non-lokasi: kandidat donor dari findRelatedCandidates() (kecocokan kata topik), lalu fix-orphans.js
 *     hanya menerima donor bila di dalamnya ada FRASA ASLI yang relevan untuk dijadikan anchor.
 *
 *   Donors already carrying a lot of outbound links (MAX_DONOR_OUTBOUND, default 4) are
 *   skipped as candidates — this stops any single popular donor from silently accumulating
 *   dozens of inserted links over many weekly runs.
 *
 * USAGE:
 *   node find-orphans.js
 *   node find-orphans.js --min-shared=2       (stricter donor matching, fewer but safer matches)
 *   node find-orphans.js --max-donor-links=5  (lower cap on how "full" a donor may already be)
 *   node find-orphans.js --dir=content
 *
 * Re-run anytime after content changes — regenerates orphans.json from current content/.
 */

const fs   = require('fs');
const path = require('path');
const { buildArticleIndex, findRelatedCandidates, guessCategoryHint, extractOutboundUrls } =
  require('./lib/related-articles.js');
const OL = require('./lib/orphan-link.js');   // v2: donor dipilih dengan aturan produk + kota/lokasi (lihat header file itu)

const ARGS = process.argv.slice(2);
const MIN_SHARED = parseInt((ARGS.find(a => a.startsWith('--min-shared=')) || '').replace('--min-shared=', ''), 10) || 2;
const MAX_DONOR_OUTBOUND = parseInt((ARGS.find(a => a.startsWith('--max-donor-links=')) || '').replace('--max-donor-links=', ''), 10) || 4;
const MAX_DONORS_PER_ORPHAN = 3;
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content').replace('--dir=', '');

const CONTENT_DIR  = path.join(process.cwd(), DIR_ARG);
const ORPHANS_FILE = path.join(process.cwd(), 'orphans.json');

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function main() {
  const t0 = Date.now();
  console.log(`\n🕸️  find-orphans — detect articles with zero inbound internal links (offline, no AI)`);
  console.log(`   Directory        : ${CONTENT_DIR}`);
  console.log(`   Min shared words : ${MIN_SHARED} (donor-matching strictness)`);
  console.log(`   Max donor links  : ${MAX_DONOR_OUTBOUND} (skip donors already this "full")`);
  console.log(`${'─'.repeat(60)}\n`);

  const index = buildArticleIndex(CONTENT_DIR, { includeBody: true });
  console.log(`📁 ${index.length} articles indexed.\n`);
  if (index.length < 2) { console.log('Not enough articles. Done.'); return; }

  // ─── Build the inbound-link graph ───────────────────────────────────────
  const knownUrls = new Set(index.map(a => a.url));
  const inboundCount = new Map();  // url -> count of inbound links FROM other indexed articles
  const outboundCount = new Map(); // url -> count of outbound links this article already has
  for (const url of knownUrls) inboundCount.set(url, 0);

  for (const article of index) {
    const outLinks = extractOutboundUrls(article.body).filter(u => knownUrls.has(u) && u !== article.url);
    outboundCount.set(article.url, outLinks.length);
    for (const target of outLinks) {
      inboundCount.set(target, (inboundCount.get(target) || 0) + 1);
    }
  }

  const orphans = index.filter(a => (inboundCount.get(a.url) || 0) === 0);

  // ─── Indeks bantu untuk pencocokan donor halaman lokasi (blocking supaya 13rb artikel tetap cepat) ───
  const descByUrl = new Map(index.map(a => [a.url, OL.describe(a.title)]));
  const bySig = new Map(), byLoc = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const a of index) {
    const d = descByUrl.get(a.url);
    if (!d.hasLoc || !d.topicSig) continue;
    push(bySig, `${d.cityKey}|${d.flagKey}|${d.topicSig}|${d.numKey}`, a);
    push(byLoc, `${d.cityKey}|${d.flagKey}|${d.locKey}`, a);
  }
  console.log(`🕸️  ${orphans.length} orphan article(s) found (0 inbound links) out of ${index.length}.\n`);

  if (!orphans.length) {
    fs.writeFileSync(ORPHANS_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), totalArticles: index.length, orphanCount: 0, orphans: [] }, null, 2));
    console.log(`💾 Saved to ${ORPHANS_FILE} (empty — nothing to fix). Done in ${fmtDuration(Date.now() - t0)}.`);
    return;
  }

  // knownCategories used for the same category-hint boost generate/revise already use.
  const knownCategories = [...new Set(index.map(a => a.category))];

  // ─── Match each orphan to donor candidates ──────────────────────────────
  const results = [];
  let processed = 0;
  for (const orphan of orphans) {
    processed++;
    const od = descByUrl.get(orphan.url);
    let donors;
    if (od.hasLoc && od.topicSig) {
      // Halaman lokasi: donor hanya yang sepadan secara produk + kota/lokasi (lihat OL.relation).
      const pool = [
        ...(bySig.get(`${od.cityKey}|${od.flagKey}|${od.topicSig}|${od.numKey}`) || []),
        ...(byLoc.get(`${od.cityKey}|${od.flagKey}|${od.locKey}`) || []),
      ];
      const seen = new Set();
      donors = pool
        .filter(a => a.url !== orphan.url && !seen.has(a.url) && seen.add(a.url) && (outboundCount.get(a.url) || 0) < MAX_DONOR_OUTBOUND)
        .map(a => ({ a, rel: OL.relation(od, descByUrl.get(a.url)) }))
        .filter(x => x.rel)
        .map(x => {
          const dd = descByUrl.get(x.a.url);
          const nearLoc = [...od.loc].filter(t => dd.loc.has(t)).length;          // "Cakung" ~ "Cakung Barat": tetangga lebih relevan
          const inb = inboundCount.get(x.a.url) || 0;
          return { ...x, rank: x.rel.type === 'sibling-area' ? 10 + nearLoc * 5 + Math.min(inb, 3) : 4 + x.rel.sim * 5 };
        })
        .sort((p, q) => q.rank - p.rank || OL.hash(orphan.url + p.a.url) - OL.hash(orphan.url + q.a.url))
        .slice(0, MAX_DONORS_PER_ORPHAN)
        .map(x => ({ url: x.a.url, title: x.a.title, relation: x.rel.type, excerpt: x.a.excerpt }));
    } else {
      const categoryHint = guessCategoryHint(orphan.title, knownCategories);
      const allCandidates = findRelatedCandidates(
        { text: orphan.title, excludeUrl: orphan.url, categoryHint },
        index,
        { max: MAX_DONORS_PER_ORPHAN * 4, minShared: MIN_SHARED } // over-fetch, then filter by outbound cap below
      );
      donors = allCandidates
        .filter(c => (outboundCount.get(c.url) || 0) < MAX_DONOR_OUTBOUND)
        .slice(0, MAX_DONORS_PER_ORPHAN)
        .map(c => ({ url: c.url, title: c.title, relation: 'topik', excerpt: c.excerpt }));
    }

    results.push({
      url: orphan.url,
      title: orphan.title,
      category: orphan.category,
      excerpt: orphan.excerpt,
      donors,
    });

    if (processed % 500 === 0 || processed === orphans.length) process.stdout.write(`\r   ${processed}/${orphans.length} orphans matched...   `);
  }
  console.log(`\n\n🔗 Completed in ${fmtDuration(Date.now() - t0)}.\n`);

  const withDonors = results.filter(r => r.donors.length > 0);
  const withoutDonors = results.length - withDonors.length;
  if (withoutDonors > 0) {
    console.log(`⚠️  ${withoutDonors} orphan(s) have NO donor candidate above the min-shared-words threshold — nothing safe to link them from yet. They'll stay orphaned until a more related article exists (e.g. once generate-articles.js publishes something closer in topic).\n`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    totalArticles: index.length,
    orphanCount: orphans.length,
    orphansWithDonors: withDonors.length,
    minSharedWords: MIN_SHARED,
    maxDonorOutbound: MAX_DONOR_OUTBOUND,
    orphans: results,
  };
  fs.writeFileSync(ORPHANS_FILE, JSON.stringify(out, null, 2));

  console.log(`💾 Saved to ${ORPHANS_FILE}`);
  console.log(`   Orphans with ≥1 donor candidate : ${withDonors.length}/${orphans.length}`);
  console.log(`\n➡️  Next: run: node fix-orphans.js --apply --limit=10`);
}

main();
