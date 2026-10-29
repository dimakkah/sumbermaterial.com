/**
 * tools/lib/link-anchor.js
 *
 * Teks tautan (anchor) internal link dibuat SCRIPT, bukan AI.
 *
 * MASALAH YANG DISELESAIKAN: kalau AI diberi daftar artikel dengan judul penuh, ia cenderung menyalin
 * judul itu sebagai anchor ("Harga Pasang Atap Baja Ringan Di Ancol Jakarta") — panjang, tidak mengalir
 * dalam kalimat, dan sering ditaruh sendirian di paragraf baru (mis. setelah kalimat penutup).
 *
 * shortAnchor(title)            judul -> frasa topik pendek (maks. 7 kata), mis.
 *                               "Harga Batu Split 1/2 Free Ongkir Ke Babakan Bogor" -> "batu split 1/2 ke Babakan Bogor"
 * isTitleLike(anchor, title)    true bila anchor terlalu panjang / nyaris sama dengan judul tujuan
 * standalonePara(text, i)       true bila posisi i berada di paragraf yang praktis hanya berisi link
 */

const FLUFF = /^(free|gratis|ongkir|terbaru|termurah|murah|terbaik|promo|hari|ini|update|2\d{3})$/i;
const LEAD = /^(harga|jual|biaya|tarif)$/i;
const CITIES = new Set(['jakarta', 'bekasi', 'depok', 'bogor', 'tangerang', 'banten', 'serang', 'cikarang', 'karawang', 'purwakarta', 'bandung', 'cibubur', 'sentul', 'cileungsi', 'cikupa', 'cibitung', 'dki', 'rangkasbitung', 'sukabumi', 'cilegon']);
const MAX_WORDS = 7;
const CONNECT = /^(dan|untuk|atau|dengan|yang|di|ke|per|pada|dari)$/i;

function shortAnchor(title) {
  let words = String(title || '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 2 && LEAD.test(words[0])) words.shift();

  // pisahkan frasa lokasi (setelah "di"/"ke" terakhir) dari frasa produk
  let locAt = -1;
  for (let i = words.length - 2; i >= 1; i--) if (/^(di|ke)$/i.test(words[i])) { locAt = i; break; }
  let product = locAt === -1 ? words : words.slice(0, locAt);
  let loc = locAt === -1 ? [] : words.slice(locAt);          // ["Ke","Babakan","Bogor"]

  product = product.filter(w => !FLUFF.test(w));
  if (loc.length) {
    loc[0] = loc[0].toLowerCase();                           // "di"/"ke" huruf kecil, nama tempat tetap kapital
    // buang nama kota di ujung bila lokasinya >= 2 kata ("Babakan Bogor" -> "Babakan") dan frasa terlalu panjang
    if (product.length + loc.length > MAX_WORDS && loc.length > 2 && CITIES.has(loc[loc.length - 1].toLowerCase())) loc.pop();
  }
  // Produk dijaga utuh (maks. 5 kata); yang dipotong adalah ujung nama lokasi bila frasa masih > MAX_WORDS.
  if (product.length > 5) product = product.slice(0, product.slice(5).some(w => /\d/.test(w)) ? 6 : 5);   // ukuran/satuan ("per m3") ikut dijaga
  while (product.length > 1 && CONNECT.test(product[product.length - 1])) product.pop();
  const locRoom = Math.max(2, MAX_WORDS - product.length);          // preposisi + minimal 1 kata tempat
  if (loc.length > locRoom) {
    let keep = locRoom;
    while (keep < loc.length && /^(kecamatan|kelurahan|kota|kabupaten|kab\.?|desa|jalan|jl\.?)$/i.test(loc[keep - 1])) keep++;   // jangan berhenti di "Kota"/"Kecamatan"
    loc = loc.slice(0, keep);
  }

  const keepCase = (w) => /\d/.test(w) || (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) || w.length === 1;
  const prod = product.map(w => (keepCase(w) ? w : w.toLowerCase()));
  return [...prod, ...loc].join(' ').trim();
}

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').split(/\s+/).filter(Boolean);
}

/** Anchor "mirip judul": >= 7 kata, atau >= 5 kata dan >= 80% kata judul tujuan terkandung di dalamnya. */
function isTitleLike(anchor, title) {
  const a = tokens(anchor);
  if (a.length >= 7) return true;
  if (a.length < 5) return false;
  const t = tokens(title);
  if (!t.length) return false;
  const aset = new Set(a);
  return t.filter(w => aset.has(w)).length / t.length >= 0.8;
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

/**
 * Paragraf (dibatasi baris kosong) di sekitar posisi `index` — apakah tersisa < minWords kata selain link/token?
 * Dipakai untuk membuang link yang "berdiri sendiri" (hanya judul, atau judul + beberapa kata).
 */
function paragraphBounds(text, index) {
  const s = text.lastIndexOf('\n\n', index);
  const e = text.indexOf('\n\n', index);
  return { start: s === -1 ? 0 : s + 2, end: e === -1 ? text.length : e };
}
function remainderWords(para) {
  return wordCount(para
    .replace(/\[\[LINK:[^\]]*\]\]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/[*_>#-]/g, ' '));
}
function standalonePara(text, index, minWords = 10) {
  const { start, end } = paragraphBounds(text, index);
  return remainderWords(text.slice(start, end)) < minWords;
}

module.exports = { shortAnchor, isTitleLike, standalonePara, paragraphBounds, remainderWords, MAX_WORDS };
