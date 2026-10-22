/**
 * fix-orphans.js  (v2 — tanpa AI, anchor dijamin relevan lewat aturan + verifikasi)
 *
 * LAYER 2 — untuk tiap orphan di orphans.json (hasil find-orphans.js) sisipkan SATU internal link dari artikel donor
 * yang sepadan. Seluruh keputusan dibuat aturan (lib/orphan-link.js), bukan AI:
 *   - halaman LOKASI  -> satu paragraf penghubung (template) di donor yang produknya sama & kotanya sama
 *                        ("wilayah lain yang juga Kami layani") atau lokasinya sama ("layanan lain di area yang sama");
 *   - artikel NON-LOKASI -> frasa yang SUDAH ADA di kalimat donor dan memuat kata topik tujuan dijadikan anchor.
 * Setiap sisipan lolos verifyEdit(): tepat +1 link, link lama utuh, isi lain tidak berubah, anchor memuat produk
 * (+ nama lokasi + angka/ukuran) halaman tujuan. Kalau tidak ada donor yang lolos, orphan DIBIARKAN (kualitas > jumlah).
 *
 * Mengapa AI dibuang (bukti dari log produksi): 43 kegagalan "format tidak sesuai", anchor lokasi salah (halaman
 * "Abadijaya Depok" memuat anchor "…di Cakung Jakarta"), dan link orphan lama ditimpa link orphan baru di kalimat yang sama.
 *
 * USAGE:
 *   node fix-orphans.js --dry-run                  → pratinjau
 *   node fix-orphans.js --apply --limit=10         → sisipkan untuk maks. 10 orphan
 *   node fix-orphans.js --audit                    → periksa link hasil orphan-fix lama (dari orphan-fixes.log) yang anchor/lokasinya
 *                                                     tidak relevan. Tambahkan --all untuk memeriksa SEMUA link pada halaman lokasi.
 *   node fix-orphans.js --audit --repair           → ...dan lepas link bermasalah itu (teks anchor tetap, hanya link dibuang)
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const OL   = require('./lib/orphan-link.js');
const { buildArticleIndex } = require('./lib/related-articles.js');

const ARGS   = process.argv.slice(2);
const APPLY  = ARGS.includes('--apply');
const AUDIT  = ARGS.includes('--audit');
const REPAIR = ARGS.includes('--repair');
const AUDIT_ALL = ARGS.includes('--all');
const arg = (n, d) => { const a = ARGS.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const LIMIT = parseInt(arg('limit', '10'), 10);
const DIR_ARG = arg('dir', 'content');
const MAX_DONOR_LINKS = parseInt(arg('max-donor-links', '4'), 10);
const ENGINE_VERSION = 2;

const CONTENT_DIR   = path.join(process.cwd(), DIR_ARG);
const ORPHANS_FILE  = path.join(process.cwd(), 'orphans.json');
const PROGRESS_FILE = path.join(process.cwd(), '.orphan-fix-progress.json');
const LOG_FILE      = path.join(process.cwd(), 'orphan-fixes.log');
const log = m => console.log(m);
const today = () => new Date().toISOString().split('T')[0];

const internalLinks = body => [...body.matchAll(OL.LINK_RE)].filter(m => /^\/[a-z0-9-]+\/[^\s)]+\/$/.test(m[2]));

// ───────────────────────────────────────── AUDIT: link lama yang tidak relevan (khusus zona halaman lokasi)
function audit() {
  log(`\n🔎 Audit link internal pada halaman lokasi — mencari anchor/lokasi yang tidak relevan`);
  log('─'.repeat(60));
  const index = buildArticleIndex(CONTENT_DIR, { includeBody: true });
  const byUrl = new Map(index.map(a => [a.url, { a, d: OL.describe(a.title) }]));
  // Default: hanya link yang DIBUAT orphan-fix (pasangan donor→orphan di orphan-fixes.log). Link lain (mis. link ke halaman hub
  // yang sengaja dibuat) tidak disentuh kecuali --all.
  const made = new Set();
  if (fs.existsSync(LOG_FILE)) for (const l of fs.readFileSync(LOG_FILE, 'utf8').split('\n')) {
    const m = l.match(/^SUCCESS,(\S+?),".*?(?:linked from|from) (\/\S+?\/)(?:\s|")/);
    if (m) made.add(`${m[2]}|${m[1]}`);
  }
  log(`   Mode: ${AUDIT_ALL ? 'SEMUA link pada halaman lokasi' : `hanya link buatan orphan-fix (${made.size} pasangan di log)`}`);
  const flagged = [];
  let checked = 0;
  for (const { a, d: src } of byUrl.values()) {
    for (const m of internalLinks(a.body)) {
      const tgt = byUrl.get(m[2]);
      if (!tgt || (!src.hasLoc && !tgt.d.hasLoc)) continue;       // blog -> blog (link semantik hasil generate) tidak diaudit
      if (!AUDIT_ALL && !made.has(`${a.url}|${m[2]}`)) continue;
      checked++;
      const orphan = Object.assign({}, tgt.d, { url: m[2], title: tgt.a.title });
      const reasons = [];
      if (src.hasLoc && tgt.d.hasLoc && src.cityKey !== tgt.d.cityKey) reasons.push('beda kota');
      else if (src.hasLoc && tgt.d.hasLoc && !OL.relation(orphan, src) && !OL.relation(src, orphan)) reasons.push('produk & lokasi tidak sepadan');
      const bad = OL.relevantAnchor(m[1], orphan);
      if (bad) reasons.push(bad);
      if (reasons.length) flagged.push({ file: a.file, source: a.url, target: m[2], anchor: m[1], reasons });
    }
  }
  log(`   ${checked} link diperiksa, ${flagged.length} bermasalah.`);
  const byReason = {}; flagged.forEach(f => f.reasons.forEach(r => { byReason[r] = (byReason[r] || 0) + 1; }));
  Object.entries(byReason).forEach(([r, n]) => log(`     • ${r}: ${n}`));
  flagged.slice(0, 15).forEach(f => log(`   - ${f.source}  →  "${f.anchor}" → ${f.target}  [${f.reasons.join('; ')}]`));
  fs.writeFileSync(path.join(process.cwd(), 'orphan-link-audit.json'), JSON.stringify(flagged.map(({ file, ...r }) => r), null, 2));
  log(`   Detail lengkap: orphan-link-audit.json`);
  if (!REPAIR) { log('\nℹ️  Tambahkan --repair untuk melepas link bermasalah (teks anchor dipertahankan).'); return; }
  const perFile = new Map(); flagged.forEach(f => { if (!perFile.has(f.file)) perFile.set(f.file, []); perFile.get(f.file).push(f); });
  let fixed = 0;
  for (const [file, items] of perFile) {
    const raw = fs.readFileSync(file, 'utf8'); const fm = OL.splitFrontMatter(raw); if (!fm) continue;
    let body = fm.body;
    for (const it of items) { const tok = `[${it.anchor}](${it.target})`; if (body.includes(tok)) { body = body.replace(tok, it.anchor); fixed++; } }
    fs.writeFileSync(file, OL.assemble(fm.rawMatter, body, today()));
  }
  log(`\n✅ ${fixed} link dilepas pada ${perFile.size} file. Orphan yang terdampak akan diproses ulang oleh find-orphans + fix-orphans.`);
}

// ───────────────────────────────────────── FIX
function main() {
  if (AUDIT) return audit();
  log(`\n🕸️  fix-orphans v${ENGINE_VERSION} — satu link relevan per orphan (aturan + verifikasi, tanpa AI)`);
  log(`   Mode  : ${APPLY ? 'APPLY (menulis file)' : 'DRY-RUN (pratinjau saja)'}`);
  log(`   Limit : ${LIMIT} orphan per run, maks. ${MAX_DONOR_LINKS} link keluar per donor`);
  log('─'.repeat(60) + '\n');
  if (!fs.existsSync(ORPHANS_FILE)) { log(`❌ ${ORPHANS_FILE} tidak ada — jalankan: node tools/find-orphans.js`); process.exit(1); }

  const orphans = (JSON.parse(fs.readFileSync(ORPHANS_FILE, 'utf8')).orphans || []).filter(o => o.donors && o.donors.length);
  let progress = fs.existsSync(PROGRESS_FILE) ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) : {};
  progress = { fixed: progress.fixed || [], failed: progress.engine === ENGINE_VERSION ? (progress.failed || {}) : {}, engine: ENGINE_VERSION };
  // orphans.json dibuat ulang dari kondisi terkini setiap run: yang masih tercantum = MEMANG masih orphan,
  // jadi riwayat "fixed" tidak boleh menghalangi (link lama bisa saja tertimpa/hilang). Hanya "failed" yang dibatasi percobaannya.
  const todo = orphans.filter(o => (progress.failed[o.url] || 0) < 2);
  log(`   Orphan dengan kandidat donor : ${orphans.length}`);
  log(`   Siap diproses                : ${todo.length}\n`);

  const usedDonors = new Set(), logLines = [];
  let done = 0, ok = 0, fail = 0;
  for (const o of todo) {
    if (done >= LIMIT) break;
    const orphan = Object.assign(OL.describe(o.title), { url: o.url, title: o.title });
    let fixed = false, lastReason = 'tidak ada donor yang lolos';
    for (const donor of o.donors) {
      if (usedDonors.has(donor.url)) { lastReason = 'donor sudah dipakai run ini'; continue; }
      const file = path.join(CONTENT_DIR, donor.url.slice(1, -1) + '.md');
      if (!fs.existsSync(file)) { lastReason = `file donor tidak ada: ${donor.url}`; continue; }
      const raw = fs.readFileSync(file, 'utf8'), fm = OL.splitFrontMatter(raw);
      if (!fm) { lastReason = `frontmatter tak terbaca: ${donor.url}`; continue; }
      if (internalLinks(fm.body).length >= MAX_DONOR_LINKS) { lastReason = `donor penuh (≥${MAX_DONOR_LINKS} link): ${donor.url}`; continue; }
      if (fm.body.includes(`](${orphan.url})`)) { lastReason = 'donor sudah menautkan orphan ini'; continue; }
      const donorTitle = (raw.match(/^title:\s*"((?:[^"\\]|\\.)*)"/m) || [])[1] || donor.title;
      const plan = OL.planInsertion(orphan, OL.describe(donorTitle), fm.body);
      if (plan.reject) { lastReason = `${donor.url}: ${plan.reject}`; continue; }
      if (done === 0 || ok < 3) log('');
      log(`🔗 [${done + 1}] ${o.title}`);
      log(`   donor  : ${donorTitle}  (${plan.mode}/${plan.note})`);
      log(`   anchor : "${plan.anchor}"`);
      log(`   kalimat: ${plan.sentence.slice(0, 200)}`);
      if (APPLY) { fs.writeFileSync(file, OL.assemble(fm.rawMatter, plan.newBody, today())); progress.fixed.push(orphan.url); }
      usedDonors.add(donor.url);
      logLines.push(`SUCCESS,${orphan.url},"${plan.mode}/${plan.note} from ${donor.url} anchor=${plan.anchor.replace(/"/g, "'")}"`);
      ok++; fixed = true; break;
    }
    done++;
    if (!fixed) { fail++; progress.failed[o.url] = (progress.failed[o.url] || 0) + 1; logLines.push(`FAILED,${o.url},"${lastReason}"`); log(`⏭️  ${o.title} — dilewati (${lastReason})`); }
  }
  if (APPLY) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    if (logLines.length) fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n');
  }
  log(`\n${'─'.repeat(60)}\n✅ Disisipkan run ini : ${ok}\n⏭️  Dilewati run ini   : ${fail}\n⏳ Sisa orphan         : ${Math.max(0, todo.length - done)}`);
  if (!APPLY) log('\nℹ️  Dry-run — tidak ada file diubah. Jalankan ulang dengan --apply.');
}

try { main(); } catch (e) { console.error('\n💥 Fatal error:', e.message); process.exit(1); }
