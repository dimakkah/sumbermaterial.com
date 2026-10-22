/**
 * tools/dedupe-articles.js  — SEKALI PAKAI, penilaian oleh AI, eksekusi oleh script
 * (disesuaikan untuk sumbermaterial.com dari versi creativedesigninterior.com)
 *
 * Alur 3 tahap:
 *   1. SCRIPT (offline)  : urutkan artikel dari yang terbaik (inbound link, panjang, umur), lalu untuk tiap
 *                          artikel "utama" cari KANDIDAT mirip secara longgar (lib/keyword-similarity.js).
 *   2. AI (Cloudflare)   : menilai kandidat mana yang benar-benar DUPLIKAT dari artikel utama
 *                          (produk + lokasi + maksud pencarian sama). Keputusan disimpan di
 *                          .dedupe-decisions.json sehingga bisa dilanjutkan di run berikutnya (--limit per run).
 *   3. SCRIPT (--apply)  : memvalidasi keputusan AI, lalu hapus artikel, tulis static/redirects.js
 *                          (URL biasa + varian /amp/), alihkan link internal, dan masukkan keyword ke
 *                          .excluded-keywords.json supaya generate-articles.js tidak membuatnya lagi.
 *
 * Pengaman: AI hanya boleh memilih dari kandidat yang ditawarkan; konflik keras (m2 vs m3, K225 vs K300,
 * lokasi beda, sewa vs jual, jasa vs produk) membatalkan keputusan AI; kelompok > --max-cluster dilewati;
 * total hapus > --max-delete dibatalkan; --apply menolak jika masih ada artikel yang belum dinilai
 * (kecuali --allow-partial).
 *
 * USAGE:
 *   node tools/dedupe-articles.js --daily --limit=40 --max-delete=25  → JADWAL: nilai 40 artikel + hapus maks 25 per run
 *   node tools/dedupe-articles.js --auto                 → SEKALI JALAN: nilai semua artikel lalu eksekusi (tanpa file manual)
 *   node tools/dedupe-articles.js --judge --limit=40     → AI menilai (dilanjutkan di run berikutnya)
 *   node tools/dedupe-articles.js                        → LAPORAN dari keputusan yang ada (tanpa AI)
 *   node tools/dedupe-articles.js --apply                → eksekusi
 *   opsi: --section=all (default) | --section=blog,info,pasir   (nama folder di content/, pisah koma)
 *         --max-delete-pct=10  (hanya --auto: batalkan bila > N% artikel akan dihapus; default 10)
 *         --max-delete=40 --max-cluster=8 --retry-errors --allow-partial --min-score=0.5 --min-score-local=0.8
 *         --ai-only  (percaya AI saja; DEFAULT = konsensus: AI dan aturan kata harus sama-sama setuju)
 *   file manual di root repo (opsional; satu baris per entri, "#" = komentar; entri = URL penuh /pasir/slug/ atau
 *   slug saja bila slug itu unik di seluruh content/):
 *     .dedupe-approve.txt  setujui usulan AI yang disengketakan aturan kata; "korban > pemenang" = gabungkan manual
 *     .dedupe-protect.txt  JANGAN pernah hapus
 *         --mock-ai  (uji offline TANPA AI: memakai aturan kata sebagai "juri"; hanya untuk pengujian)
 *
 * REQUIRES (hanya --judge): CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (boleh multi-baris, berpasangan 1:1).
 */
'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const KS    = require('./lib/keyword-similarity.js');
const J     = require('./lib/dedupe-judge.js');
const PROMPTS = require('./prompts/dedupe-articles.json');

const ARGS = process.argv.slice(2);
const has  = f => ARGS.includes(f);
const arg  = (n, d) => { const a = ARGS.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const AUTO = has('--auto');   // SEKALI JALAN: nilai semua -> eksekusi; file approve/protect diabaikan
const DAILY = has('--daily'); // JADWAL HARIAN: nilai --limit artikel, eksekusi bertahap (maks --max-delete per run); file manual diabaikan
const HANDS_OFF = AUTO || DAILY;
const JUDGE = has('--judge') || HANDS_OFF, APPLY = has('--apply'), MOCK = has('--mock-ai');
const RETRY = has('--retry-errors') || HANDS_OFF, ALLOW_PARTIAL = has('--allow-partial');
const AI_ONLY = has('--ai-only'); // default: KONSENSUS (AI DAN aturan kata harus sama-sama setuju)
const SECTION_ARG = arg('section', 'all');
const LIMIT = AUTO ? Infinity : parseInt(arg('limit', '40'), 10);
const MAX_DELETE = parseInt(arg('max-delete', '40'), 10);
const MAX_CLUSTER = parseInt(arg('max-cluster', '8'), 10);
const MAX_DELETE_PCT = parseFloat(arg('max-delete-pct', '10'));
const MAX_CANDIDATES = 7;
// Section "artikel utama" (default: product). Artikelnya TIDAK PERNAH dihapus/digabung sebagai korban, dan bila mirip dengan
// artikel section lain, yang dipertahankan adalah artikel utama. Dua artikel utama tidak dibandingkan satu sama lain.
const MAIN_SECTIONS = new Set(arg('main-sections', 'product').split(',').map(x => x.trim()).filter(Boolean));
const sectionOf = url => url.split('/')[1] || '';
// Ambang kandidat untuk AI. Halaman tanpa lokasi (blog/product/info umum) pakai ambang longgar; halaman programatik
// per-kelurahan pakai ambang ketat — ada ribuan "saudara" berpola sama (harga-X-ke-<kelurahan>) yang jelas bukan
// duplikat dan hanya menghabiskan kuota Workers AI.
const MIN_CAND_SCORE = parseFloat(arg('min-score', '0.5'));
const MIN_CAND_SCORE_LOCAL = parseFloat(arg('min-score-local', '0.8'));
const LIB_VERSION = 5; // versi keyword-similarity.js; keputusan AI dari versi lain dibuang (kandidat bisa beda)

const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const REDIRECTS = path.join(ROOT, 'static', 'redirects.js');
const EXCLUDED = path.join(ROOT, '.excluded-keywords.json');
const DECISIONS = path.join(ROOT, '.dedupe-decisions.json');
const REPORT = path.join(ROOT, 'dedupe-report.json');
const APPROVE_FILE = path.join(ROOT, '.dedupe-approve.txt');
const PROTECT_FILE = path.join(ROOT, '.dedupe-protect.txt');

const ALL_SECTIONS = fs.existsSync(CONTENT)
  ? fs.readdirSync(CONTENT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : [];
const SECTIONS = SECTION_ARG === 'all' ? ALL_SECTIONS : SECTION_ARG.split(',').map(x => x.trim()).filter(Boolean);

// generate-articles.js membaca .excluded-keywords.json dan MELEPAS entri yang algoVersion-nya beda dari
// SIMILARITY_ALGO_VERSION miliknya (keyword lalu dibuat ulang jadi artikel). Jadi tulis versi milik generate.
function generateAlgoVersion() {
  try {
    const m = fs.readFileSync(path.join(__dirname, 'generate-articles.js'), 'utf8').match(/SIMILARITY_ALGO_VERSION\s*=\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return 2;
}
const ALGO_VERSION = generateAlgoVersion();

if ((has('--judge') || HANDS_OFF) && APPLY) { console.error('Pilih salah satu: --auto / --daily / --judge ATAU --apply.'); process.exit(1); }
if (AUTO && DAILY) { console.error('Pilih salah satu: --auto ATAU --daily.'); process.exit(1); }
for (const s of SECTIONS) if (!ALL_SECTIONS.includes(s)) { console.error(`Section "${s}" tidak ada di content/. Tersedia: ${ALL_SECTIONS.join(', ')}`); process.exit(1); }

// ── Cloudflare Workers AI (model & pola env sama dengan generate-articles.js) ─────────────
const parseTokens = raw => (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
const CF = {
  IDS: parseTokens(process.env.CLOUDFLARE_ACCOUNT_ID), TOKENS: parseTokens(process.env.CLOUDFLARE_API_TOKEN),
  HOST: 'api.cloudflare.com', MODEL: '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
};
let tokenIdx = 0;
const curToken = () => CF.TOKENS[tokenIdx] || '';
const curPath = () => `/client/v4/accounts/${CF.IDS[tokenIdx] || CF.IDS[0] || ''}/ai/v1/chat/completions`;
const rotate = () => { tokenIdx = (tokenIdx + 1) % CF.TOKENS.length; };

function httpPost(pathname, token, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: CF.HOST, path: pathname, method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d)); } catch { resolve(d); } return; }
        const e = new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`);
        e.isRateLimit = res.statusCode === 429;
        e.isAuthError = res.statusCode === 401 || res.statusCode === 403;
        e.retryAfterSec = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
        reject(e);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout ${timeoutMs / 1000}s`)));
    req.on('error', reject); req.write(body); req.end();
  });
}

async function callAI(messages, retries = 3) {
  const body = JSON.stringify({ model: CF.MODEL, messages, temperature: 0.1, max_tokens: 600 });
  let rotated = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await httpPost(curPath(), curToken(), body);
      const c = r?.choices?.[0]?.message?.content;
      if (!c) throw new Error('respons AI kosong');
      return c;
    } catch (err) {
      if (err.isRateLimit || err.isAuthError) {
        if (CF.TOKENS.length > 1 && rotated < CF.TOKENS.length - 1) { rotated++; rotate(); attempt--; continue; }
        if (err.isRateLimit && err.retryAfterSec && err.retryAfterSec <= 90 && attempt < retries) {
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500)); continue;
        }
        throw err;
      }
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
}

// ── Muat artikel ─────────────────────────────────────────────────────────────
function walk(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith('.md') && e.name !== '_index.md') out.push(full);
  }
  return out;
}
const toUrl = f => '/' + path.relative(CONTENT, f).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
const withSlash = u => (u.endsWith('/') ? u : u + '/');
// Link internal: relatif (/x/y/) atau absolut ke domain sendiri; query/hash dibuang.
const LINK_RE = /(?<!!)\[([^\]]+)\]\((?:https?:\/\/(?:www\.)?sumbermaterial\.com)?(\/[^)\s#?]+?\/?)(?:[#?][^)\s]*)?\)/g;

function parseFront(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const y = m[1];
  const get = k => {
    const r = y.match(new RegExp(`^${k}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')) || y.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm'));
    return r ? r[1].replace(/\\"/g, '"').trim() : '';
  };
  return { title: get('title'), keyword: get('keywords'), date: get('date'), draft: /^draft:\s*true/m.test(y), body: m[2] || '' };
}

const articles = [];
for (const file of SECTIONS.flatMap(sec => walk(path.join(CONTENT, sec)))) {
  let p; try { p = parseFront(fs.readFileSync(file, 'utf8')); } catch { continue; }
  if (!p || !p.title || p.draft) continue;
  const slug = path.basename(file, '.md');
  articles.push({
    file, slug, url: toUrl(file), title: p.title, keyword: p.keyword, date: p.date || '9999',
    main: MAIN_SECTIONS.has(sectionOf(toUrl(file))),
    words: p.body.trim().split(/\s+/).length, body: p.body, inbound: 0,
    excerpt: J.excerptOf(p.body), info: KS.analyzeArticle({ keyword: p.keyword, title: p.title, slug }),
  });
}
console.log(`\n📁 ${articles.length} artikel non-draft di content/{${SECTIONS.join(',')}}`);
const byUrl = new Map(articles.map(a => [a.url, a]));
for (const a of articles) {
  const seen = new Set();
  for (const m of a.body.matchAll(LINK_RE)) {
    const u = withSlash(m[2]);
    if (u !== a.url && byUrl.has(u) && !seen.has(u)) { seen.add(u); byUrl.get(u).inbound++; }
  }
}
// Urutan "terbaik dulu": inbound link terbanyak → isi terpanjang → tanggal terlama. Yang pertama jadi PEMENANG.
const ranked = [...articles].sort((a, b) => (b.main - a.main) || b.inbound - a.inbound || b.words - a.words || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// Indeks token → artikel, supaya pencarian kandidat tidak O(n²) (situs ini 13 ribu+ artikel).
// Hanya kata SPESIFIK (bobot 1) yang diindeks; kata generik saja (pasir, besi, jakarta, ...) tidak cukup jadi kandidat
// kecuali artikel tidak punya kata spesifik sama sekali.
const tokenIndex = new Map();
const specTokens = a => {
  const t = new Set();
  for (const m of [a.info.kw.topic, a.info.tt.topic]) for (const [k, w] of m) if (w === 1) t.add(k);
  return t;
};
for (const a of articles) {
  a._spec = specTokens(a);
  const toks = a._spec.size ? a._spec : new Set([...a.info.kw.topic.keys(), ...a.info.tt.topic.keys()]);
  for (const t of toks) { if (!tokenIndex.has(t)) tokenIndex.set(t, []); tokenIndex.get(t).push(a); }
}

// ── Keputusan (cache lintas-run) ─────────────────────────────────────────────
// version 2 = penilaian per-kandidat (OBJEK/MAKSUD/VONIS); keputusan dari prompt lama (v1, terlalu longgar) dibuang.
// libVersion = versi keyword-similarity.js; kandidat bisa berubah bila algoritma berubah, jadi keputusan lama dibuang juga.
const DECISIONS_VERSION = 2;
function loadDecisions() {
  try {
    const j = JSON.parse(fs.readFileSync(DECISIONS, 'utf8'));
    if (j.version !== DECISIONS_VERSION || (j.libVersion || 0) !== LIB_VERSION) {
      console.log('♻️  .dedupe-decisions.json versi lama dibuang (prompt/algoritma diperbarui) — semua dinilai ulang.'); return {};
    }
    return j.decisions || {};
  } catch { return {}; }
}
function saveDecisions(d) {
  fs.writeFileSync(DECISIONS, JSON.stringify({ version: DECISIONS_VERSION, libVersion: LIB_VERSION, updatedAt: new Date().toISOString(), decisions: d }, null, 1));
}

// File manual. Entri = URL penuh atau slug; slug yang ada di >1 folder dianggap ambigu dan dilewati dengan peringatan.
const bySlug = new Map();
for (const a of articles) { if (!bySlug.has(a.slug)) bySlug.set(a.slug, []); bySlug.get(a.slug).push(a); }
function resolveRef(x, warn) {
  x = x.trim();
  if (x.startsWith('/')) { const u = withSlash(x); if (!byUrl.has(u)) warn(`${u} tidak ditemukan di content`); return byUrl.has(u) ? u : null; }
  const slug = x.replace(/\.md$/, '');
  const hit = bySlug.get(slug) || [];
  if (hit.length === 1) return hit[0].url;
  warn(hit.length ? `"${slug}" ambigu (${hit.map(h => h.url).join(', ')}) — tulis URL penuh` : `"${slug}" tidak ditemukan di content`);
  return null;
}
function readManual(file, label) {
  const out = []; let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { exists: false, lines: out }; }
  for (const l of raw.split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'))) out.push(l);
  return { exists: true, lines: out };
}
const decisions = loadDecisions();

function candidatesFor(seed, used) {
  const pool = new Map();
  const minScore = (seed.info.kw.loc.size || seed.info.kw.cities.size || seed.info.kw.dirs.size) ? MIN_CAND_SCORE_LOCAL : MIN_CAND_SCORE;
  const toks = seed._spec.size ? seed._spec : new Set([...seed.info.kw.topic.keys(), ...seed.info.tt.topic.keys()]);
  for (const t of toks) for (const o of tokenIndex.get(t) || []) if (o !== seed && !used.has(o.url) && !(seed.main && o.main)) pool.set(o.url, o);
  return [...pool.values()]
    .map(o => ({ o, s: Math.max(KS.candidateScore(seed.info.kw, o.info.kw), KS.candidateScore(seed.info.tt, o.info.tt)) }))
    .filter(x => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, MAX_CANDIDATES).map(x => x.o);
}
// juri tiruan untuk pengujian offline
const mockJudge = (seed, cands) => ({ ids: cands.map((c, i) => KS.articlesDuplicate(seed.info, c.info) ? i + 1 : 0).filter(Boolean), reason: 'mock (aturan kata)' });

let mockCalls = 0; // hanya untuk pengujian: DEDUPE_MOCK_RATELIMIT_AFTER=N mensimulasikan rate limit setelah N panggilan
async function judgeOne(seed, cands) {
  if (MOCK) {
    if (process.env.DEDUPE_MOCK_RATELIMIT_AFTER && ++mockCalls > +process.env.DEDUPE_MOCK_RATELIMIT_AFTER) { const e = new Error('rate limit (tiruan)'); e.isRateLimit = true; throw e; }
    return mockJudge(seed, cands);
  }
  const raw = await callAI(J.buildMessages(PROMPTS, seed, cands));
  return J.parseVerdict(raw, cands.length);
}

// ── Susun rencana (+ penilaian AI bila --judge) ──────────────────────────────
async function main() {
  if (JUDGE && !MOCK) {
    if (!CF.TOKENS.length || !CF.IDS.length) throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID belum diset (diperlukan untuk --judge).');
    if (CF.IDS.length > 1 && CF.IDS.length !== CF.TOKENS.length) console.warn('⚠️  Jumlah baris CLOUDFLARE_ACCOUNT_ID dan CLOUDFLARE_API_TOKEN tidak sama — pasangan bisa salah.');
  }

  const used = new Set(), undecided = [], vetoed = [], disputed = [];
  let allClusters = [];
  let judged = 0, stop = false, stopReason = '', needAI = 0;

  // File manual: protect = jangan hapus; approve = setujui sengketa; "korban > pemenang" = gabung manual.
  const warn = m => console.log(`   ⚠️  ${m}`);
  const prot = HANDS_OFF ? { exists: false, lines: [] } : readManual(PROTECT_FILE);
  const appr = HANDS_OFF ? { exists: false, lines: [] } : readManual(APPROVE_FILE);
  if (HANDS_OFF) console.log(`🤖 MODE ${DAILY ? 'HARIAN' : 'OTOMATIS'}: .dedupe-approve.txt / .dedupe-protect.txt DIABAIKAN; hanya usulan yang disetujui AI DAN aturan kata yang dieksekusi.`);
  const protectedUrls = new Set(), approved = new Set(), forced = new Map();
  for (const l of prot.lines) { const u = resolveRef(l, m => warn(`${path.basename(PROTECT_FILE)}: ${m}`)); if (u) protectedUrls.add(u); }
  for (const l of appr.lines) {
    const w = m => warn(`${path.basename(APPROVE_FILE)}: ${m}`);
    if (l.includes('>')) { const [a, b] = l.split('>'); const lu = resolveRef(a, w), wu = resolveRef(b, w); if (lu && wu) forced.set(lu, wu); }
    else { const u = resolveRef(l, w); if (u) approved.add(u); }
  }
  console.log(`🛡️  ${protectedUrls.size} URL dilindungi (${path.basename(PROTECT_FILE)}${prot.exists ? '' : ' — file tidak ada'}), ✅ ${approved.size} disetujui manual + ${forced.size} penggabungan manual (${path.basename(APPROVE_FILE)}${appr.exists ? '' : ' — file tidak ada'}); mode: ${AI_ONLY ? 'AI saja' : 'konsensus AI + aturan kata'}`);
  for (const u of protectedUrls) if (approved.has(u) || forced.has(u)) warn(`${u} ada di protect DAN approve — protect menang (tidak akan dihapus)`);

  for (const seed of ranked) {
    if (used.has(seed.url)) continue;
    used.add(seed.url);
    let d = decisions[seed.url];
    if (d && d.error && JUDGE && RETRY) d = null;

    if (!d) {
      const cands = candidatesFor(seed, used);
      if (!cands.length) d = { candidates: [], duplicates: [] };            // tidak perlu AI
      else if (JUDGE && !stop && judged < LIMIT) {
        process.stdout.write(`\r🤖 AI menilai ${judged + 1}${LIMIT === Infinity ? '' : '/' + LIMIT}: ${seed.slug.slice(0, 50).padEnd(50)}`);
        try {
          const v = await judgeOne(seed, cands);
          judged++;
          d = v.error
            ? { candidates: cands.map(c => c.url), duplicates: [], error: v.error, judgedAt: new Date().toISOString() }
            : { candidates: cands.map(c => c.url), duplicates: v.ids.map(i => cands[i - 1].url), reason: v.reason, judgedAt: new Date().toISOString() };
          decisions[seed.url] = d;
          if (judged % 5 === 0) saveDecisions(decisions);
        } catch (err) {
          stop = true; stopReason = err.isRateLimit ? 'rate limit (semua key)' : err.isAuthError ? 'auth error (semua pasangan)' : err.message;
          undecided.push(seed); continue;
        }
      } else { undecided.push(seed); continue; }
    }
    if (d.candidates && d.candidates.length) needAI++;

    const losers = [];
    for (const u of d.duplicates || []) {
      const o = byUrl.get(u);
      if (!o || used.has(o.url)) continue;
      if (o.main) continue;                                                                                      // artikel utama (product) tidak pernah dihapus
      if (protectedUrls.has(o.url)) continue;                                                                    // dilindungi manual
      if (forced.has(o.url) && forced.get(o.url) !== seed.url) continue;                                         // sudah ditetapkan manual ke pemenang lain
      if (KS.hardConflict(seed.info.kw, o.info.kw)) { vetoed.push({ keep: seed.url, drop: o.url }); continue; } // veto script
      if (!AI_ONLY && !approved.has(o.url) && !KS.articlesDuplicate(seed.info, o.info)) {                         // konsensus
        disputed.push({ keep: seed.url, drop: o.url, aiReason: d.reason || '' }); continue;
      }
      losers.push({ ...o, reason: d.reason || '' }); used.add(o.url);
    }
    if (losers.length) allClusters.push({ winner: seed, losers, reason: d.reason || '' });
  }
  // Penggabungan manual "korban > pemenang": keputusan manusia, tidak bergantung pada AI/aturan kata
  for (const [lu, wu] of forced) {
    const L = byUrl.get(lu), W = byUrl.get(wu);
    const skip = m => warn(`penggabungan manual dilewati: ${lu} > ${wu} — ${m}`);
    if (L && L.main) { skip(`korban adalah artikel utama (section ${[...MAIN_SECTIONS].join('/')}) — tidak boleh dihapus`); continue; }
    if (protectedUrls.has(lu)) { skip('korban ada di .dedupe-protect.txt'); continue; }
    if (allClusters.some(c => c.losers.some(x => x.url === wu))) { skip('pemenang sendiri akan dihapus di kelompok lain'); continue; }
    if (allClusters.some(c => c.winner.url === lu)) { skip('korban adalah pemenang kelompok lain — selesaikan manual'); continue; }
    for (const c of allClusters) c.losers = c.losers.filter(x => x.url !== lu);
    let c = allClusters.find(x => x.winner.url === wu);
    if (!c) { c = { winner: W, losers: [], reason: 'penggabungan manual' }; allClusters.push(c); }
    c.losers.push({ ...L, reason: 'penggabungan manual (.dedupe-approve.txt)' });
  }
  allClusters = allClusters.filter(c => c.losers.length);
  if (JUDGE) { saveDecisions(decisions); process.stdout.write('\n'); }

  const clusters = allClusters.filter(c => c.losers.length <= MAX_CLUSTER);
  const reviewClusters = allClusters.filter(c => c.losers.length > MAX_CLUSTER);
  const totalLosers = clusters.reduce((n, c) => n + c.losers.length, 0);
  const errors = Object.entries(decisions).filter(([, d]) => d.error);

  console.log(`\n🔎 ${undecided.length + needAI} artikel utama punya kandidat mirip (butuh/sudah dinilai AI): ${needAI} sudah, ${undecided.length} belum.`);
  console.log(`🔗 ${clusters.length} kelompok duplikat, ${totalLosers} artikel akan dihapus.`);
  if (reviewClusters.length) console.log(`⚠️  ${reviewClusters.length} kelompok dilewati (> ${MAX_CLUSTER} artikel) — tinjau manual.`);
  if (disputed.length) console.log(`🤝 ${disputed.length} usulan AI TIDAK dieksekusi karena aturan kata tidak setuju (konsensus) — lihat "disputedAiOnly" di laporan; setujui lewat .dedupe-approve.txt bila memang benar.`);
  if (vetoed.length) console.log(`🛑 ${vetoed.length} keputusan AI dibatalkan script (konflik satuan/mutu/lokasi/jasa).`);
  if (errors.length) console.log(`⚠️  ${errors.length} penilaian gagal diparse (dianggap BUKAN duplikat). Ulangi dengan --judge --retry-errors.`);
  if (undecided.length) console.log(`⏳ ${undecided.length} artikel utama belum dinilai AI${stopReason ? ` (berhenti: ${stopReason})` : ''}. Jalankan --judge lagi.`);
  console.log('');
  for (const c of clusters) {
    console.log(`✅ PERTAHANKAN  ${c.winner.url}  (inbound ${c.winner.inbound}, ${c.winner.words} kata)\n   "${c.winner.title}"\n   💬 ${c.reason}`);
    for (const l of c.losers) console.log(`   ❌ hapus  ${l.url}  (inbound ${l.inbound}, ${l.words} kata)\n      "${l.title}"`);
    console.log('');
  }

  const brief = a => ({ url: a.url, title: a.title, keyword: a.keyword, words: a.words, inbound: a.inbound });
  fs.writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(), mode: DAILY ? 'daily' : AUTO ? 'auto' : APPLY ? 'apply' : JUDGE ? 'judge' : 'report', sections: SECTIONS,
    complete: undecided.length === 0, clusterCount: clusters.length, deleteCount: totalLosers, undecidedSeeds: undecided.length, judgeErrors: errors.length,
    clusters: clusters.map(c => ({ keep: brief(c.winner), reason: c.reason, remove: c.losers.map(brief) })),
    skippedForManualReview: reviewClusters.map(c => ({ keep: brief(c.winner), reason: c.reason, remove: c.losers.map(brief) })),
    vetoedByScript: vetoed,
    disputedAiOnly: disputed,
  }, null, 2));
  console.log('📝 Laporan: dedupe-report.json');

  if (AUTO && undecided.length) {
    console.log(`\n⏳ Mode otomatis BELUM selesai: ${undecided.length} artikel utama belum dinilai${stopReason ? ` (berhenti: ${stopReason})` : ''}.`);
    console.log('   Keputusan sudah disimpan. Jalankan workflow lagi (pengaturan sama) sampai selesai — penghapusan baru dilakukan setelah SEMUA dinilai.');
    return;
  }
  if (!APPLY && !HANDS_OFF) { console.log(JUDGE ? '\nℹ️  Selesai menilai. Ulangi --judge sampai tidak ada yang tertunda, lalu tinjau laporan, lalu --apply.' : '\nℹ️  LAPORAN saja — tidak ada file diubah.'); return; }

  // ── Guard sebelum eksekusi ──
  if (!HANDS_OFF && undecided.length && !ALLOW_PARTIAL) { console.error(`\n🛑 ${undecided.length} artikel utama belum dinilai AI. Selesaikan --judge dulu (atau pakai --allow-partial).`); process.exit(1); }
  if (!totalLosers) { console.log('\n✅ Tidak ada yang perlu dihapus.'); return; }
  if (AUTO) {
    // Pengaman relatif terhadap ukuran situs. Di sumbermaterial.com duplikat sungguhan ±1-2%; ambang CDI (35%) tidak
    // akan menangkap ledakan false positive (pada percobaan, aturan kata lama menandai ±33% artikel). Default 10%.
    const cap = Math.floor(articles.length * MAX_DELETE_PCT / 100);
    if (totalLosers > cap) {
      console.error(`\n🛑 Mode otomatis: ${totalLosers} dari ${articles.length} artikel akan dihapus (> ${MAX_DELETE_PCT}%). Dibatalkan demi keamanan; tidak ada artikel yang diubah. Periksa dedupe-report.json.`);
      // Tandai BELUM selesai supaya opsi cleanup di workflow tidak menghapus script padahal tidak ada yang dieksekusi.
      try { const r = JSON.parse(fs.readFileSync(REPORT, 'utf8')); r.complete = false; r.aborted = `melebihi ${MAX_DELETE_PCT}% (${totalLosers}/${articles.length})`; fs.writeFileSync(REPORT, JSON.stringify(r, null, 2)); } catch {}
      return;
    }
  } else if (!DAILY && totalLosers > MAX_DELETE) { console.error(`\n🛑 ${totalLosers} artikel akan dihapus, melebihi --max-delete=${MAX_DELETE}. Dibatalkan.`); process.exit(1); }
  if (DAILY) { // eksekusi bertahap: maksimal --max-delete artikel per run, sisanya besok
    let n = 0, pending = 0; const toRun = [];
    for (const c of clusters) {
      if (n + c.losers.length > MAX_DELETE && toRun.length) { pending++; continue; }
      toRun.push(c); n += c.losers.length;
    }
    try { const r = JSON.parse(fs.readFileSync(REPORT, 'utf8')); r.pendingClusters = pending; r.complete = undecided.length === 0 && pending === 0; fs.writeFileSync(REPORT, JSON.stringify(r, null, 2)); } catch {}
    if (pending) console.log(`⏭️  ${pending} kelompok ditunda ke run berikutnya (batas ${MAX_DELETE} artikel per run).`);
    execute(toRun, n);
    return;
  }
  execute(clusters, totalLosers);
}

// ── Eksekusi ─────────────────────────────────────────────────────────────────
// Format static/redirects.js sumbermaterial: `const redirectMap = { "/a/": "/b/", ... };` + IIFE klien di bawahnya.
const DEFAULT_TAIL = [
  '(function () {',
  '    function getCurrentPath() {',
  '        // Ambil path + query string',
  '        let path = window.location.pathname + window.location.search;',
  "        path = path.replace(/\\/$/, '') || '/';",
  '        return path;',
  '    }',
  "    document.addEventListener('DOMContentLoaded', () => {",
  '        const currentPath = getCurrentPath();',
  "        const redirectUrl = redirectMap[currentPath] || ",
  "                            redirectMap[currentPath + '/'] || ",
  "                            redirectMap[currentPath.replace(/\\/$/, '')];",
  '        if (redirectUrl) {',
  "            console.log(`Redirecting from ${currentPath} to ${redirectUrl}`);",
  '            window.location.replace(window.location.origin + redirectUrl);',
  '        }',
  '    });',
  '})();',
  '',
].join('\n');

function loadRedirects() {
  if (!fs.existsSync(REDIRECTS)) return { head: '// Redirect Map\n', map: {}, tail: '\n' + DEFAULT_TAIL, eol: '\n' };
  const raw = fs.readFileSync(REDIRECTS, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';   // file di repo memakai CRLF; pertahankan agar diff git tetap kecil
  const start = raw.indexOf('const redirectMap = {');
  const end = start >= 0 ? raw.indexOf('};', start) : -1;
  if (start < 0 || end < 0) throw new Error('Format static/redirects.js tidak dikenali (const redirectMap = { ... }; tidak ditemukan).');
  const block = raw.slice(start + 'const redirectMap = {'.length, end).replace(/^\s*\/\/.*$/gm, '');
  const map = {};
  for (const m of block.matchAll(/(["'])(.+?)\1\s*:\s*(["'])(.*?)\3/g)) map[m[2]] = m[4];
  return { head: raw.slice(0, start), map, tail: raw.slice(end + 2), eol };
}

function execute(clusters, totalLosers) {
  const redirect = loadRedirects(), map = redirect.map;
  // URL biasa + varian /amp/ (tema memakai AMP; dedup-directional-suffix.js juga menulis keduanya)
  const loserToWinner = new Map();
  for (const c of clusters) for (const l of c.losers) {
    loserToWinner.set(l.url, c.winner.url);
    loserToWinner.set(l.url + 'amp/', c.winner.url + 'amp/');
  }
  const winnerUrls = new Set(clusters.flatMap(c => [c.winner.url, c.winner.url + 'amp/']));
  const redirectDst = d => withSlash(d.replace(/[?#].*$/, ''));

  for (const [src, dst] of Object.entries(map)) if (loserToWinner.has(redirectDst(dst))) map[src] = loserToWinner.get(redirectDst(dst)); // hindari rantai
  for (const w of winnerUrls) { delete map[w]; delete map[w.replace(/\/$/, '')]; }                                                   // hindari loop
  for (const [l, w] of loserToWinner) map[l] = w;
  for (const [src, dst] of Object.entries(map)) if (src === dst) delete map[src];

  let rewrittenFiles = 0, rewrittenLinks = 0;
  const loserFiles = new Set(clusters.flatMap(c => c.losers.map(l => path.resolve(l.file))));

  // Link yang KELUAR dari artikel yang dihapus ikut hilang. Hitung dulu siapa yang kehilangan SEMUA inbound link
  // (artikel yatim baru) agar bisa dilaporkan & diperbaiki (fix-orphans.yml).
  const allFiles = walk(CONTENT);
  const allUrls = new Set(allFiles.map(toUrl));
  const inboundOf = files => {
    const m = new Map();
    for (const f of files) {
      const self = toUrl(f), raw = fs.readFileSync(f, 'utf8');
      if (!raw.includes('](')) continue;
      for (const mm of raw.matchAll(LINK_RE)) {
        const t = withSlash(mm[2]);
        if (t === self || !allUrls.has(t)) continue;
        if (!m.has(t)) m.set(t, new Set());
        m.get(t).add(self);
      }
    }
    return m;
  };
  const inboundBefore = inboundOf(allFiles);

  for (const file of allFiles) {
    if (loserFiles.has(path.resolve(file))) continue;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('](')) continue;
    const self = toUrl(file); let changed = false;
    const out = raw.replace(LINK_RE, (m, text, url) => {
      const u = withSlash(url);
      if (!loserToWinner.has(u)) return m;
      changed = true; rewrittenLinks++;
      const w = loserToWinner.get(u);
      return w === self ? text : `[${text}](${w})`;
    });
    if (changed) { fs.writeFileSync(file, out); rewrittenFiles++; }
  }
  const inboundAfter = inboundOf(allFiles.filter(f => !loserFiles.has(path.resolve(f))));
  const newOrphans = [];
  for (const [t, srcs] of inboundBefore) {
    if (loserToWinner.has(t) || inboundAfter.has(t)) continue;
    newOrphans.push({ url: t, lostFrom: [...srcs].filter(u => loserToWinner.has(u)) });
  }
  for (const f of loserFiles) fs.unlinkSync(f);

  fs.mkdirSync(path.dirname(REDIRECTS), { recursive: true });
  const eol = redirect.eol;
  const entries = Object.entries(map).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(`,${eol}`);
  fs.writeFileSync(REDIRECTS, `${redirect.head}const redirectMap = {${eol}${entries}${eol}};${redirect.tail}`);

  let excluded = {}; try { excluded = JSON.parse(fs.readFileSync(EXCLUDED, 'utf8')); } catch {}
  for (const c of clusters) for (const l of c.losers) {
    const key = (l.keyword || l.slug.replace(/-/g, ' ')).toLowerCase().trim();
    excluded[key] = { reason: 'merged duplicate (dedupe-articles.js, AI-judged)', matchedFile: path.basename(c.winner.file),
      matchedTitle: c.winner.title, taggedAt: new Date().toISOString(), algoVersion: ALGO_VERSION };
  }
  fs.writeFileSync(EXCLUDED, JSON.stringify(excluded, null, 2));

  console.log(`\n✅ SELESAI: ${totalLosers} artikel dihapus, ${rewrittenLinks} link internal di ${rewrittenFiles} file dialihkan,`);
  console.log(`   redirects.js sekarang berisi ${Object.keys(map).length} entri (algoVersion exclude-list = ${ALGO_VERSION}).`);
  try { const r = JSON.parse(fs.readFileSync(REPORT, 'utf8')); r.newOrphanCount = newOrphans.length; r.newOrphans = newOrphans; fs.writeFileSync(REPORT, JSON.stringify(r, null, 2)); } catch {}
  if (newOrphans.length) {
    console.log(`\n⚠️  ${newOrphans.length} artikel kehilangan SEMUA link masuk karena artikel penaut-nya dihapus (artikel yatim baru):`);
    for (const o of newOrphans.slice(0, 15)) console.log(`   • ${o.url}  (dulu ditaut dari: ${o.lostFrom.join(', ')})`);
    if (newOrphans.length > 15) console.log(`   … dan ${newOrphans.length - 15} lainnya (lihat newOrphans di dedupe-report.json)`);
    console.log('   → fix-orphans.yml akan menyisipkan link baru (maks. 10 per run; cron mingguan melanjutkan sisanya).');
  } else console.log('   Tidak ada artikel yatim baru.');
}

main().catch(err => { console.error('\n💥 Fatal error:', err.message); process.exit(1); });
