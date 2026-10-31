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
  if (process.env.TITLE_BY_AI !== '1') {
    return 'JUDUL: tulis satu judul sementara (boleh singkat); judul final dibuat dan dipasang oleh sistem dari keyword, jadi tidak perlu dipoles. Yang penting isi artikel menjawab keyword "' + cleanKeyword(keyword) + '".';
  }
  return render(T.rules, {
    keyword: cleanKeyword(keyword),
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
// Keyword dibersihkan sebelum dipakai di aturan/pemeriksaan: tahun dibuang (judul dilarang memuat tahun) dan "perbatang"/"perkubik" -> "per batang"/"per kubik".
function cleanKeyword(k) {
  return String(k || '').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\bper(?=(batang|kubik|meter|biji|lembar|sak|truk|colt|buah|m2|m3)\b)/gi, 'per ').replace(/\s+/g, ' ').trim();
}

function titleIssues(title, keyword) {
  keyword = cleanKeyword(keyword);
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
  keyword = cleanKeyword(keyword);
  const title = String(rawTitle || '').replace(/\*\*/g, '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  if (!title || !hasKeyword(title, keyword)) return { title: toTitleCase(keyword), changed: true, reason: 'keyword tidak ada di judul AI' };
  return { title, changed: title !== String(rawTitle || '').trim(), reason: 'dibersihkan' };
}


// ───────────────────────── JUDUL DIBUAT SCRIPT (tanpa AI)
// Judul AI sering ambigu dan tidak konsisten: keyword disisipkan mentah (huruf kecil) di tengah kalimat, ditambah penutup
// yang tidak nyambung ("... Mitra Konstruksi", "... untuk mengatasi masalah perencanaan?"). Karena itu judul dirangkai SCRIPT
// dari keyword + templat yang sudah pasti jelas dan benar tata bahasanya. Huruf kapital selalu konsisten (Title Case).
const TC_SMALL = new Set(['di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'pada', 'dalam', 'agar', 'saat', 'sebelum', 'bagi']);
const TC_ACRONYM = new Set(['wf', 'sni', 'pvc', 'upvc', 'grc', 'dki', 'cv', 'pt', 'hdpe', 'ac', 'led']);
function titleCaseKeyword(k) {
  return String(k || '').trim().split(/\s+/).filter(Boolean).map((w, i) => {
    const lw = w.toLowerCase();
    if (/^k\d+$/i.test(w)) return w.toUpperCase();                  // mutu beton K300
    if (TC_ACRONYM.has(lw)) return lw.toUpperCase();
    if (/^\d/.test(w)) return lw;                                    // 10mm, 1/2, 2/3, 7cm -> sebagaimana adanya (huruf kecil)
    if (/^(mm|cm|kg|m2|m3|ton)$/.test(lw)) return lw;               // satuan
    if (i > 0 && TC_SMALL.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}

const Q_RE = /\b(berapa|apa|apakah|mana|bagaimana|gimana|kenapa|mengapa|kapan|siapa|bisa|boleh|isi)\b|\bcara\b/i;
const PRICE_RE = /^(harga|biaya|tarif|upah|ongkos)\b/i;
const SERVICE_RE = /^(jasa|tukang|bengkel|kontraktor|sewa|rental|pembuatan|pemasangan|borongan|pengaspalan)\b/i;
const VENDOR_RE = /\b(toko|agen|supplier|pabrik|distributor|grosir|tempat|terdekat|jual|beli)\b/i;

const TITLE_BANK = {
  price: [
    '{K} dan Hal yang Perlu Dicek sebelum Memesan',
    '{K} Berdasarkan Jenis dan Ukurannya',
    '{K} untuk Kebutuhan Rumah dan Proyek Kecil',
    'Cara Membaca {K} agar Anggaran Tidak Meleset',
    '{K} dan Faktor yang Memengaruhinya',
    'Cek {K} sebelum Menyusun Anggaran',
    '{K}, Cara Menghitung dan Memesannya',
    'Memahami {K} sebelum Memesan',
    'Kenapa {K} Bisa Berbeda di Tiap Penjual?',
    'Apa Saja yang Menentukan {K}?',
    'Cara Membandingkan {K} dari Beberapa Penjual',
    '{K} dan Perhitungan Kebutuhan Proyek',
    'Panduan Singkat Membaca {K}',
    '{K} dan Cara Menghitung Kebutuhan Material',
    'Sebelum Membandingkan {K}, Cek Dulu Hal Ini',
    'Hal yang Memengaruhi {K} di Lapangan',
    'Cara Menyusun Anggaran dari {K}',
    '{K}, Apa yang Sudah dan Belum Termasuk?',
    'Pertanyaan Seputar {K} yang Sering Muncul',
    'Tanyakan Ini sebelum Menyetujui {K}',
    '{K} dan Cara Mencocokkannya dengan Kebutuhan',
    'Mengapa {K} Perlu Dicek Ulang saat Memesan?',
    '{K} untuk Rumah Tinggal dan Ruko',
    'Cara Menghindari Salah Hitung pada {K}',
  ],
  service: [
    '{K} dan Hal yang Perlu Disiapkan sebelum Memesan',
    'Cara Memilih {K} agar Hasil Sesuai Rencana',
    '{K} untuk Renovasi dan Bangunan Baru',
    'Memilih {K} yang Sesuai Kebutuhan Proyek',
    '{K}, dari Survei sampai Pengerjaan',
    'Yang Perlu Ditanyakan sebelum Memakai {K}',
    'Tahapan Kerja {K} dari Awal sampai Selesai',
    'Cara Menilai {K} sebelum Menyetujui Kesepakatan',
    '{K}? Cek Dulu Hal Ini',
    'Kapan Waktu yang Tepat Memakai {K}?',
    '{K} untuk Rumah Tinggal dan Usaha',
    'Persiapan sebelum Memakai {K}',
    'Cara Membandingkan Penawaran {K}',
    'Kesalahan yang Sering Terjadi pada {K}',
    'Daftar Periksa sebelum Memakai {K}',
    'Membaca Penawaran {K} dengan Teliti',
    'Apa yang Perlu Disepakati dalam {K}?',
    '{K} untuk Proyek Skala Kecil sampai Menengah',
    'Mengenal Cara Kerja {K}',
    '{K} dan Jadwal Pengerjaan yang Realistis',
    'Panduan Memakai {K} Langkah demi Langkah',
    'Sebelum Memutuskan {K}, Pahami Ini',
    'Cara Menghindari Masalah pada {K}',
    '{K} dan Cara Menyiapkan Lokasi Kerja',
  ],
  vendor: [
    'Cara Memilih {K} yang Sesuai Kebutuhan',
    '{K} untuk Renovasi dan Bangunan Baru',
    'Yang Perlu Dicek saat Mencari {K}',
    'Mencari {K}? Ini Pertimbangannya',
    '{K} dan Cara Memastikan Pesanan Sesuai',
    '{K} untuk Proyek Rumah dan Usaha',
    'Cara Menilai {K} sebelum Memesan',
    'Daftar Periksa saat Memilih {K}',
    '{K}? Cek Dulu Hal Ini',
    'Pertanyaan untuk Diajukan saat Menghubungi {K}',
    'Cara Memastikan Stok dan Kualitas {K}',
    'Kesalahan Umum saat Memilih {K}',
    '{K} dan Cara Mengatur Pengiriman Material',
    'Membandingkan Pilihan {K} secara Teliti',
    'Tanda {K} yang Dapat Dipercaya',
    'Langkah Aman Memesan dari {K}',
    '{K} untuk Pembeli Satuan dan Proyek',
    'Hal yang Perlu Dipastikan pada {K}',
    'Cara Memeriksa Kualitas dari {K}',
    'Panduan Memesan dari {K}',
    '{K} dan Cara Menjadwalkan Pengiriman',
    'Sebelum Memilih {K}, Cek Dulu Hal Ini',
    'Mencari {K} untuk Kebutuhan Proyek',
    'Kapan Perlu Mencari {K} Lebih Awal?',
  ],
  question: [
    '{K}? Ini Penjelasan Singkatnya',
    '{K}? Simak Jawabannya',
    '{K}? Ini yang Perlu Diketahui',
    '{K}? Jawabannya dan Contoh Penerapannya',
    '{K}? Penjelasan yang Mudah Dipahami',
    '{K}? Begini Cara Memahaminya',
    '{K}? Berikut Rinciannya',
    '{K}? Ini Dasar yang Perlu Dipahami',
    '{K}? Jawaban untuk Pemula',
    '{K}? Pahami Dulu sebelum Memutuskan',
    '{K}? Ini Faktor Penentunya',
    '{K}? Jawaban Praktis untuk Proyek Rumah',
    '{K}? Penjelasan dan Contohnya',
    '{K}? Begini Penjelasannya',
    '{K}? Ini Rangkuman Jawabannya',
    '{K}? Jawaban Singkat dan Contoh Hitungannya',
  ],
  info: [
    '{K} dan Hal yang Perlu Diketahui',
    'Mengenal {K} untuk Rumah dan Proyek Kecil',
    'Cara Memilih {K} yang Sesuai Kebutuhan',
    'Kelebihan dan Batasan {K}',
    'Memahami {K} sebelum Memesan',
    'Cara Memilih {K} untuk Proyek Rumah',
    '{K}, Jenis dan Kegunaannya',
    'Mengenal Jenis dan Ukuran {K}',
    'Kapan {K} Cocok Dipakai?',
    '{K} dan Cara Memeriksa Kualitasnya',
    'Perbedaan Jenis {K} dan Cara Memilihnya',
    'Hal yang Perlu Dicek pada {K}',
    '{K}, Kelebihan dan Kekurangannya',
    'Kenali Ciri {K} yang Baik',
    'Cara Memakai {K} dengan Benar',
    '{K} untuk Pemula yang Baru Membangun',
    'Kesalahan Umum saat Memakai {K}',
    '{K} dan Penerapannya di Lapangan',
    'Pertimbangan Memakai {K} di Rumah',
    '{K} dan Cara Menghitung Kebutuhannya',
    'Apa yang Perlu Diketahui tentang {K}?',
    'Penjelasan Singkat tentang {K}',
    'Sebelum Memakai {K}, Pahami Dulu Hal Ini',
    '{K} dan Hal yang Sering Terlewat',
  ],
};

function titleKind(kw) {
  if (Q_RE.test(kw)) return 'question';
  if (PRICE_RE.test(kw)) return 'price';
  if (SERVICE_RE.test(kw)) return 'service';
  if (VENDOR_RE.test(kw)) return 'vendor';
  return 'info';
}

const tplRe = (tpl) => new RegExp('^' + tpl.split('{K}').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)') + '$', 'i');
const BANK_RE = Object.fromEntries(Object.entries(TITLE_BANK).map(([k, v]) => [k, v.map(tplRe)]));

/** Hitung berapa kali tiap templat sudah dipakai oleh daftar judul yang ada -> { kind: [count...] } (untuk meratakan pemakaian). */
function templateUsage(titles) {
  const use = Object.fromEntries(Object.entries(TITLE_BANK).map(([k, v]) => [k, v.map(() => 0)]));
  for (const t of titles || []) {
    outer: for (const [kind, res] of Object.entries(BANK_RE)) {
      for (let i = 0; i < res.length; i++) if (res[i].test(String(t).trim())) { use[kind][i]++; break outer; }
    }
  }
  return use;
}

/**
 * Judul final dari keyword — Title Case konsisten, selalu jelas.
 * `usage` (hasil templateUsage, opsional): templat yang paling jarang dipakai dipilih lebih dulu (seri diputuskan hash keyword),
 * dan hitungannya ditambah — jadi pemakaian templat merata dan judul berdekatan tidak berpola sama.
 * Tanpa `usage`: murni deterministik dari keyword.
 */
function buildTitle(keyword, usage) {
  const clean = cleanKeyword(keyword);
  const K = titleCaseKeyword(clean);
  const kind = titleKind(clean);
  const bank = TITLE_BANK[kind];
  const fits = (t) => t.length <= 66 && !titleIssues(t, keyword).length;
  const start = hash(clean.toLowerCase());
  const counts = usage && usage[kind];
  const order = bank.map((_, i) => i).sort((x, y) => {
    const d = counts ? counts[x] - counts[y] : 0;
    return d || ((x - start % bank.length + bank.length) % bank.length) - ((y - start % bank.length + bank.length) % bank.length);
  });
  for (const i of order) {
    const t = bank[i].replace('{K}', kind === 'question' ? K.replace(/\?+$/, '') : K).replace(/\s+/g, ' ');
    if (fits(t)) { if (counts) counts[i]++; return t; }
  }
  // keyword terlalu panjang untuk templat apa pun -> keyword saja (tanpa tambahan), tetap Title Case
  return K.replace(/\?+$/, '') + (kind === 'question' ? '?' : '');
}

module.exports = { buildTitle, templateUsage, TITLE_BANK, titleCaseKeyword, titleKind, cleanKeyword, pickTitleStyle, buildTitleRules, titleIssues, fixTitle, toTitleCase, hasKeyword, isTransactional };
