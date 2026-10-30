/**
 * tools/lib/title-style.js
 *
 * Judul artikel AI yang natural & bervariasi (bukan pola "Keyword: slogan"):
 *   - pickTitleStyle(keyword, attempt) : pilih gaya judul. Keyword transaksional (harga/jual/jasa/sewa/lokasi...) memakai
 *                                        gaya "sales"; keyword informasional memakai gaya "info". Dipilih dari hash keyword
 *                                        (hasil konsisten saat keyword sama dibuat ulang), digeser per `attempt` agar
 *                                        regenerate pasti memberi gaya berbeda.
 *   - buildTitleRules(keyword, style, year)  : teks ATURAN JUDUL siap disisipkan ke prompt ({{titleRules}}).
 *   - titleIssues(title, keyword)      : daftar masalah (titik dua/pemisah, klise, tahun, terlalu panjang, keyword hilang).
 *   - fixTitle(rawTitle, keyword)      : bersihkan judul AI; kalau keyword hilang -> pakai keyword sebagai judul.
 * Tanpa dependensi ke modul lain.
 */
'use strict';
const T = require('../prompts/title-styles.json');

const BANNED_RE = T.bannedRegex.map(p => new RegExp(`(^|[^a-z])${p}`, 'i'));
const SEPARATOR_RE = /[:|｜–—]|\s-\s/;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const SALES_RE = /\b(harga|jual|jasa|sewa|rental|biaya|toko|agen|supplier|pabrik|distributor|grosir|beli|murah|kirim|pesan|ongkir|tarif|per\s?(m2|m3|kubik|truk|batang|lembar|sak|meter))\b/i;

function isTransactional(keyword) { return SALES_RE.test(String(keyword || '')); }

function hash(str) {
  let h = 5381;
  for (const ch of String(str)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h;
}

function pickTitleStyle(keyword, attempt = 1) {
  const list = isTransactional(keyword) ? T.salesStyles : T.infoStyles;
  const i = (hash(String(keyword).toLowerCase()) + (attempt - 1)) % list.length;   // attempt berbeda -> gaya berbeda (berurutan)
  return list[i];
}

function render(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function buildTitleRules(keyword, style, year) {
  return render(T.rules, {
    keyword,
    titleStyle: style.instruction,
    banned: T.bannedDisplay.map(b => `"${b}"`).join(', '),
    currentYear: String(year || new Date().getFullYear()),
  });
}

const SMALL = new Set(['di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'pada', 'dalam']);
function toTitleCase(text) {
  return String(text).trim().split(/\s+/).map((w, i) => (i > 0 && SMALL.has(w.toLowerCase())) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
function hasKeyword(title, keyword) {
  const kw = words(keyword).join(' ');
  return kw.length > 0 && (` ${words(title).join(' ')} `).includes(` ${kw} `);
}

// Wilayah/kota yang TIDAK boleh ditambahkan AI ke judul bila tidak ada di keyword (keyword "terdekat" != "Jabodetabek").
const REGION_RE = /\b(jabodetabek|jabodetabekser|jabotabek|jakarta|bekasi|depok|bogor|tangerang|banten|serang|cikarang|karawang|purwakarta|bandung|cibubur|sentul|cileungsi|jawa barat|jawa)\b/gi;
function titleIssues(title, keyword) {
  const issues = [];
  if (!hasKeyword(title, keyword)) issues.push('keyword tidak ada utuh di judul');
  if (SEPARATOR_RE.test(title)) issues.push('pemisah (: | - – —) di judul');
  // frasa klise — kecuali frasa itu memang bagian dari keyword (mis. keyword "tips memilih pasir")
  if (BANNED_RE.some(re => re.test(title) && !re.test(keyword))) issues.push('frasa klise');
  const kwL = String(keyword || '').toLowerCase();
  const extra = [...new Set((String(title).match(REGION_RE) || []).map(x => x.toLowerCase()))].filter(x => !kwL.includes(x));
  if (extra.length) issues.push(`menambah wilayah yang tidak ada di keyword: ${extra.join(', ')}`);
  if (/\b(harga|biaya)\b/i.test(title) && !/\b(harga|biaya)\b/i.test(keyword)) issues.push('menambah kata harga/biaya yang tidak ada di keyword');
  if (YEAR_RE.test(title)) issues.push('angka tahun di judul');
  if (title.length > Math.max(70, String(keyword).length + 22)) issues.push(`judul terlalu panjang (${title.length} karakter)`);
  return issues;
}

function fixTitle(rawTitle, keyword) {
  const title = String(rawTitle || '').replace(/\*\*/g, '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  if (!title || !hasKeyword(title, keyword)) return { title: toTitleCase(keyword), changed: true, reason: 'keyword tidak ada di judul AI' };
  return { title, changed: title !== String(rawTitle || '').trim(), reason: 'dibersihkan' };
}

module.exports = { pickTitleStyle, buildTitleRules, titleIssues, fixTitle, toTitleCase, hasKeyword, isTransactional };
