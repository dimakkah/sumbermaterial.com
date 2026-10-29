/**
 * tools/lib/link-anchor.js
 *
 * Teks tautan (anchor) internal link dibuat SCRIPT, bukan AI.
 *
 * MASALAH YANG DISELESAIKAN: kalau AI diberi daftar artikel dengan judul penuh, ia cenderung menyalin
 * judul itu sebagai anchor ("Harga Pasang Atap Baja Ringan Di Ancol Jakarta") — panjang, tidak mengalir
 * dalam kalimat, dan sering ditaruh sendirian di paragraf baru (mis. setelah kalimat penutup).
 *
 * shortAnchor(title)            judul -> frasa topik pendek (sependek mungkin, rata-rata 5 kata), mis.
 *                               "Harga Batu Split 1/2 Free Ongkir Ke Babakan Bogor" -> "batu split 1/2 ke Babakan Bogor"
 * isTitleLike(anchor, title)    true bila anchor terlalu panjang / nyaris sama dengan judul tujuan
 * standalonePara(text, i)       true bila posisi i berada di paragraf yang praktis hanya berisi link
 */

const KS = require('./keyword-similarity.js');

const FLUFF = /^(free|gratis|ongkir|terbaru|termurah|murah|terbaik|promo|hari|ini|update|2\d{3})$/i;
const LEAD = /^(harga|jual|biaya|tarif)$/i;
const VERB = /^(pasang|jasa|sewa|jual|kirim|layanan|harga|biaya|tarif)$/i;
const CONNECT = /^(dan|untuk|atau|dengan|yang|di|ke|per|pada|dari)$/i;
const GENERIC_PLACE = /^(kecamatan|kelurahan|kota|kabupaten|kab\.?|desa|jalan|jl\.?)$/i;
const CITIES = new Set(['jakarta', 'bekasi', 'depok', 'bogor', 'tangerang', 'banten', 'serang', 'cikarang', 'karawang', 'purwakarta', 'bandung', 'cibubur', 'sentul', 'cileungsi', 'cikupa', 'cibitung', 'dki', 'rangkasbitung', 'sukabumi', 'cilegon']);

// Panjang anchor: dibuat sependek mungkin tanpa kehilangan produk/kata pembeda/ukuran dan nama tempat.
//   frasa produk  : 2–3 kata (maks. PRODUCT_MAX, kecuali ukuran/mutu harus ikut)
//   frasa lokasi  : "di" + nama tempat 1–2 kata (nama kota di ujung dibuang)
// Contoh: "Harga Pasang Atap Baja Ringan Di Bale Kambang Jakarta" -> "atap baja ringan di Bale Kambang"
const MAX_WORDS = 6;
const PRODUCT_MAX = 3;

function shortAnchor(title) {
  const head = String(title || '').split(/\s*[:|–—]\s+/)[0] || String(title || '');
  let words = head.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 2 && LEAD.test(words[0])) words.shift();

  // pisahkan frasa lokasi (setelah "di"/"ke" terakhir) dari frasa produk
  let locAt = -1;
  for (let i = words.length - 2; i >= 1; i--) if (/^(di|ke)$/i.test(words[i])) { locAt = i; break; }
  let product = (locAt === -1 ? words : words.slice(0, locAt)).filter(w => !FLUFF.test(w));
  let loc = locAt === -1 ? [] : words.slice(locAt + 1);           // nama tempat saja (tanpa "di"/"ke")
  const prep = locAt === -1 ? '' : words[locAt].toLowerCase();

  // nama tempat: buang nama kota di ujung (bila masih ada kata tempat), maksimal 2 kata (perpanjang bila berhenti di "Kecamatan"/"Kota")
  if (loc.length > 1 && CITIES.has(loc[loc.length - 1].toLowerCase())) loc = loc.slice(0, -1);
  if (loc.length > 2) {
    let keep = GENERIC_PLACE.test(loc[0]) ? 3 : 2;               // "Kecamatan Bogor Tengah" dijaga utuh
    while (keep < loc.length && GENERIC_PLACE.test(loc[keep - 1])) keep++;
    loc = loc.slice(0, keep);
  }

  // frasa produk: buang kata kerja/jenis layanan di depan ("pasang", "jasa") selama masih >= 2 kata
  while (product.length > 2 && VERB.test(product[0])) product.shift();
  while (product.length > 1 && CONNECT.test(product[product.length - 1])) product.pop();
  // terlalu panjang -> ambil jendela PRODUCT_MAX kata yang memuat kata pembeda (core)
  if (product.length > PRODUCT_MAX) {
    const core = new Set([...KS.analyze(head).topic].filter(([, w]) => w >= 1).map(([k]) => k));
    const isCore = (w) => KS.normalize(w).split(' ').some(t => core.has(KS.stem(t)));
    let best = 0, bestScore = -1;
    for (let i = 0; i + PRODUCT_MAX <= product.length; i++) {
      const sc = product.slice(i, i + PRODUCT_MAX).filter(isCore).length * 2 + (i === 0 ? 0.1 : 0);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    product = product.slice(best, best + PRODUCT_MAX);
    // jendela yang memuat kata sambung/& ("polos & ulir") kehilangan kata kepala -> pakai 2 kata awal + kata pembeda terakhir
    if (product.slice(1, -1).some(w => CONNECT.test(w) || w === '&') || CONNECT.test(product[0]) || product[0] === '&') {
      const all = locAt === -1 ? words : words.slice(0, locAt);
      const lastCore = [...all].reverse().find(isCore);
      product = [...all.slice(0, 2), ...(lastCore && !all.slice(0, 2).includes(lastCore) ? [lastCore] : [])];
    }
    // ukuran/mutu ("B0", "1/2", "10 mm") yang terpotong tetap dibawa bila ada
    const dropped = (locAt === -1 ? words : words.slice(0, locAt)).filter(w => /\d/.test(w) && !product.includes(w));
    if (dropped.length && product.length + 1 <= PRODUCT_MAX + 1 && !product.some(w => /\d/.test(w))) product = [...product, dropped[0]];
  }
  while (product.length > 1 && CONNECT.test(product[product.length - 1])) product.pop();

  const keepCase = (w) => /\d/.test(w) || (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) || w.length === 1;
  const prod = product.map(w => (keepCase(w) ? w : w.toLowerCase()));
  return [...prod, ...(loc.length ? [prep, ...loc] : [])].join(' ').trim();
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

/** Semua kata anchor berasal dari judul tujuan (anchor hasil turunan judul, bukan frasa bebas dari kalimat). */
function derivedFromTitle(anchor, title) {
  const a = tokens(anchor), t = new Set(tokens(title));
  return a.length >= 3 && a.every(w => t.has(w));
}

module.exports = { derivedFromTitle, shortAnchor, isTitleLike, standalonePara, paragraphBounds, remainderWords, MAX_WORDS };
