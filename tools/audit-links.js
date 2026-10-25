/**
 * tools/audit-links.js — audit SEMUA link di body artikel (tanpa AI, hanya membaca, tidak mengubah file).
 *   node tools/audit-links.js              → ringkasan + link-audit-report.json
 *   node tools/audit-links.js --show=20    → tampilkan 20 contoh per kategori
 * Kategori:
 *   invalid        target placeholder/rusak, mis. (/[URL_KONTAK])
 *   dead           link internal ke halaman yang TIDAK ADA di content/ (404)
 *   redirected     link internal ke URL yang sudah di-redirect (sebaiknya langsung ke tujuan akhir)
 *   leak           teks jangkar bocoran instruksi prompt, mis. [internal link ke ...] / [Link ke artikel terkait: ...]
 *   leak-bracket   kurung siku bocoran TANPA link, mis. "[Internal Link ke halaman kontak]"
 *   long-anchor    jangkar > 12 kata
 *   self           link ke halaman sendiri
 *   dup            target yang sama ditautkan lebih dari sekali dalam satu artikel
 *   beda-kota      artikel lokasi menaut ke artikel lokasi di KOTA berbeda
 *   beda-produk    artikel lokasi menaut ke produk yang tidak terkait di lokasi lain
 *   topik-jauh     artikel non-lokasi menaut ke artikel yang topiknya hampir tidak beririsan
 *   anchor-lokasi  jangkar menyebut lokasi yang berbeda dari halaman tujuan
 *   marker         sisa penanda internal di teks, mis. [[[PLACEHOLDER_N]]] / [[TABEL_..]] / [[LINK:..]]
 *   wrong-domain   link absolut ke domain lain (mis. sumbermaterial.co.id) padahal situs ini sumbermaterial.com
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OL = require('./lib/orphan-link.js');
const KS = require('./lib/keyword-similarity.js');
const { isValidLinkTarget } = require('./lib/related-articles.js');

const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const SHOW = parseInt((process.argv.find(a => a.startsWith('--show=')) || '--show=5').split('=')[1], 10);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(f); else if (e.name.endsWith('.md')) yield f;
  }
}
const toUrl = f => { const r = '/' + path.relative(CONTENT, f).replace(/\\/g, '/').replace(/\.md$/, '').replace(/\/_index$/, ''); return r === '/_index' ? '/' : r + '/'; };
const fm = raw => { const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/); return m ? { head: m[1], body: raw.slice(m[0].length) } : { head: '', body: raw }; };
const titleOf = head => { const m = head.match(/^title:\s*"?(.*?)"?\s*$/m); return m ? m[1] : ''; };

// peta halaman & redirect
const files = [...walk(CONTENT)];
const pages = new Map();                                // url -> {title,file}
for (const f of files) { const raw = fs.readFileSync(f, 'utf8'); pages.set(toUrl(f), { file: f, title: titleOf(fm(raw).head), raw }); }
const redirects = new Map();
try { for (const m of fs.readFileSync(path.join(ROOT, 'static', 'redirects.js'), 'utf8').matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) redirects.set(m[1].replace(/\/?$/, '/'), m[2]); } catch {}
const staticExists = p => { try { return fs.existsSync(path.join(ROOT, 'static', decodeURIComponent(p.split(/[?#]/)[0]))); } catch { return false; } };

const LEAK_RE = /(internal\s*link|link\s+ke\b|anchor\s*text|teks\s+tautan|\[\[|LINK:\d|klik\s+di\s+sini|baca\s+juga|artikel\s+nomor|link\s+artikel)/i;
const cats = {};
const add = (cat, rec) => { (cats[cat] = cats[cat] || []).push(rec); };
const descCache = new Map();
const desc = (url, title) => { if (!descCache.has(url)) descCache.set(url, OL.describe(title)); return descCache.get(url); };

let linkCount = 0;
for (const [url, pg] of pages) {
  const { body } = fm(pg.raw);
  const text = body.replace(/```[\s\S]*?```/g, '').replace(/\{\{<[\s\S]*?>\}\}/g, '');
  for (const m of text.matchAll(/(?<![!\[])\[(?!\[)([^\]\n]*)\]\(([^)\n]*)\)/g)) {
    linkCount++;
    const anchor = m[1].trim(), target = (m[2].trim().split(/\s+/)[0] || '');
    const rec = { page: url, anchor, target };
    if (/^data:|^mailto:|^tel:|^#/.test(target)) continue;
    if (!isValidLinkTarget(target)) { add('invalid', rec); continue; }
    if (LEAK_RE.test(anchor)) add('leak', rec);
    if (anchor.split(/\s+/).length > 12) add('long-anchor', rec);
    if (/^https?:\/\//i.test(target)) {
      const own = target.match(/^https?:\/\/(?:www\.)?sumbermaterial\.(?:com|co\.id)(\/[^?#]*)?/i);
      if (!own) { if (/^http:\/\//i.test(target) && !/wa\.me|whatsapp/.test(target)) add('http-non-https', rec); continue; }
      if (!/^https?:\/\/(www\.)?sumbermaterial\.com/i.test(target)) add('wrong-domain', rec);
      rec.target = own[1] || '/';
    }
    const t = rec.target.split(/[?#]/)[0];
    if (!t.startsWith('/')) continue;
    const tu = t.endsWith('/') ? t : t + '/';
    if (/\.[a-z0-9]{2,5}$/i.test(t)) { if (!staticExists(t) && !fs.existsSync(path.join(ROOT, 'static', t))) add('dead-asset', rec); continue; }
    if (tu === url) { add('self', rec); continue; }
    if (!pages.has(tu) && tu !== '/') {
      if (redirects.has(tu)) add('redirected', { ...rec, to: redirects.get(tu) }); else add('dead', rec);
      continue;
    }
    if (tu.split('/').length === 3) continue;                       // link ke halaman seksi (/batu/, /bangunan/) tidak dinilai relevansinya
    // relevansi (hanya artikel ↔ artikel)
    const src = pages.get(url), dst = pages.get(tu);
    if (!dst || !dst.title || !src.title) continue;
    const a = desc(url, src.title), b = desc(tu, dst.title);
    if (a.hasLoc && b.hasLoc) {
      if (a.cityKey !== b.cityKey) add('beda-kota', { ...rec, from: src.title, toTitle: dst.title });
      else if (!OL.relation(a, b)) add('beda-produk', { ...rec, from: src.title, toTitle: dst.title });
    } else if (!a.hasLoc && !b.hasLoc || !a.hasLoc) {
      const sim = OL.weightedJaccard(a.topic, b.topic);
      if (sim < 0.12) add('topik-jauh', { ...rec, from: src.title, toTitle: dst.title, sim: +sim.toFixed(2) });
    }
    if (anchor) {
      const aa = OL.describe(anchor);
      if (aa.hasLoc && b.hasLoc && ([...aa.loc].some(x => !b.loc.has(x)))) add('anchor-lokasi', { ...rec, toTitle: dst.title });
    }
  }
  for (const m of text.matchAll(/\[((?:internal\s*link|link\s+ke|anchor\s*text)[^\]\n]*)\](?!\()/gi)) add('leak-bracket', { page: url, anchor: m[1], target: '' });
  for (const m of text.matchAll(/\[\[\[PLACEHOLDER_[^\]]*\]\]\]|\[\[(?:TABEL_|LINK:|KONTAK)[^\]]*\]\]/g)) add('marker', { page: url, anchor: m[0], target: '' });
  const seen = new Map();
  for (const m of text.matchAll(/(?<![!\[])\[(?!\[)[^\]\n]*\]\((\/[^)\s#?]+?\/?)\)/g)) { const k = m[1].replace(/\/?$/, '/'); seen.set(k, (seen.get(k) || 0) + 1); }
  for (const [k, n] of seen) if (n > 1) add('dup', { page: url, anchor: '', target: k, count: n });
}

const order = ['invalid', 'dead', 'redirected', 'leak', 'leak-bracket', 'marker', 'wrong-domain', 'long-anchor', 'self', 'dup', 'dead-asset', 'http-non-https', 'beda-kota', 'beda-produk', 'topik-jauh', 'anchor-lokasi'];
console.log(`\n${pages.size} halaman, ${linkCount} link di body.\n`);
for (const c of order) {
  const list = cats[c] || [];
  const pagesN = new Set(list.map(r => r.page)).size;
  console.log(`${list.length ? '⚠️ ' : '✅'} ${c.padEnd(14)} ${String(list.length).padStart(5)} link di ${pagesN} halaman`);
  for (const r of list.slice(0, SHOW)) console.log(`      ${r.page}\n        [${r.anchor.slice(0, 90)}](${r.target}${r.to ? ' → ' + r.to : ''})${r.toTitle ? '  ⇒ "' + r.toTitle + '"' : ''}`);
}
fs.writeFileSync(path.join(ROOT, 'link-audit-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), pages: pages.size, links: linkCount, categories: Object.fromEntries(order.map(c => [c, cats[c] || []])) }, null, 1));
console.log('\nLaporan lengkap: link-audit-report.json');
