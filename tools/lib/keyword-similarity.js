/**
 * tools/lib/keyword-similarity.js   (algoritma v5 — disesuaikan untuk sumbermaterial.com)
 *
 * Deteksi keyword/artikel yang "satu topik" untuk dedupe-articles.js.
 * Basis: v4 dari creativedesigninterior.com (CDI), dengan perubahan untuk situs material bangunan:
 *
 *  - LOKASI adalah pembeda keras. Situs ini penuh halaman programatik "harga X di <kelurahan> <kota>".
 *    Dua halaman dengan lokasi berbeda BUKAN duplikat, dan halaman berlokasi vs halaman tanpa lokasi
 *    juga bukan duplikat (halaman lokal tidak boleh digabung ke halaman umum). Arah mata angin
 *    (timur/barat/...) ditangani monthly oleh dedup-directional-suffix.js, jadi di sini dianggap konflik.
 *  - SEWA vs JUAL dan JASA vs PRODUK adalah konflik keras (sewa molen != jual molen, jasa cor != harga cor).
 *  - Satuan: kubik/kub/meter kubik => m3, meter persegi/m² => m2 (supaya "per kubik" == "per m3").
 *  - Kata generik diganti ke kosakata material (pasir, batu, bata, besi, baja, semen, cor, dak, ...) dan
 *    nama kota/arah jadi generik (bobot kecil), bukan kata topik penuh.
 *  - Stopword ditambah kata boilerplate toko ("free", "kirim", "supplier", "agen", "ready", "stok", ...).
 *  - Sinonim domain: hollow/holo, galvalum/galvalume, kanopi/canopy, bondek, hebel, dst.
 *
 *  Warisan v4 yang dipertahankan: angka/satuan hanya penanda konflik; mutu/ukuran (k225, fc20, 3x3, 10mm)
 *  = "variant"; intent berbeda => bukan duplikat; syarat kata spesifik bersama; aturan "pembeda".
 */
'use strict';

const STOPWORDS = new Set([
  'jual','jasa','harga','sewa','beli','biaya','tukang','pasang',
  'di','ke','dari','untuk','dan','yang','dengan','atau','per','apa','itu','ini',
  'terbaik','berkualitas','gratis','ongkir','murah','terpercaya','terdekat','bagus',
  'professional','profesional','area','lokasi','wilayah','daerah','kota','kabupaten',
  'kecamatan','jabodetabek','anda','kami','material','konstruksi','desain','interior',
  'bangunan','bangun','apakah','pengertian','alternatif','panduan','lengkap','cara','tips',
  'mengenal','kenali','memilih','adalah','dalam','pada','juga','akan','bisa','dapat',
  'kuat','awet','tahan','lama','baik','jenis','macam','model','membuat','buat','minimalis',
  'terbaru','contoh','proses','sederhana',
  'benar','tepat','efisien','hasil','presisi','optimal','solusi','estimasi','berapa',
  'sendiri','lainnya','tahun','mulai','sampai','sesuai','standar','praktis','cepat','mudah',
  'langkah','tutorial','mitra','sumber',
  'arti','hitung','butuh','takar','borongan','upah','rab','begini','inilah','beberapa','berikut',
  'akurat','ciri','lebih','kurang','fungsi','manfaat','unggul','beda','banding','sebab','penyebab',
  'rekomendasi','tahap','daftar','terlengkap','kenapa','alasan','pilih','pilihan','kelebihan',
  'kekurangan','keunggulan','perbedaan','perbandingan','tahapan','kebutuhan',
  'meter','segi','persegi','kilo','kg','gram','liter','buah','lembar','batang','unit','pcs','permeter',
  // v5: boilerplate toko material / halaman programatik
  'free','kirim','antar','pengiriman','toko','agen','distributor','supplier','suplier','pabrik','stok',
  'ready','resmi','update','kualitas','paling','semua','proyek','pesan','order','hubungi','telepon',
  'info','informasi','terkini','hari','sekarang','langsung','grosir','eceran','satuan','pusat',
]);

// Kata topik yang sangat umum di situs ini: boleh cocok, bobotnya kecil.
const CITY = ['jakarta','bekasi','depok','bogor','tangerang','banten','jawa','barat','timur','utara','selatan',
  'tengah','dki','serang','cikarang','karawang'];
const DIRS = new Set(['timur','barat','utara','selatan','tengah']);
const GENERIC = new Set([
  'cor','dak','besi','baja','rumah','lantai','kolom','balok','bata','batu','pasir','semen','ukur',
  'bekisting','pondasi','atap','dinding','urug','urugan',
  ...CITY,
]);
const GENERIC_WEIGHT = 0.4;

const MANUAL = {
  bondex:'bondek', bondeck:'bondek', bonde:'bondek',
  herbel:'hebel', hebal:'hebel', hebell:'hebel',
  beton:'cor', ngecor:'cor', mengecor:'cor', pengecoran:'cor', coran:'cor', ngecoran:'cor',
  pengecatan:'cat', mengecat:'cat',
  bongkar:'buka', dibongkar:'buka', lepas:'buka', dilepas:'buka', dibuka:'buka',
  dipasang:'pasang', terpasang:'pasang', dibuat:'buat', dihitung:'hitung',
  // v5: sinonim/ejaan domain material
  holo:'hollow', hollo:'hollow', holow:'hollow',
  galvalume:'galvalum', galvanize:'galvanis', galvanised:'galvanis',
  canopy:'kanopi', kanopy:'kanopi', canopi:'kanopi',
  batako:'batako', bataco:'batako',
  molen:'molen', mollen:'molen',
  truck:'truk', trek:'truk',
  sirtu:'sirtu', siltu:'sirtu',
};
const NO_STEM = new Set(['ringan','jalan','tangan','pasangan','urugan','kanopi','bondek','hebel','batako']);
const VARIANT = /^(k|fc)\d+$|^\d+x\d+$|^\d+(mm|cm|kg|ton)$/;

function stem(w) {
  if (MANUAL[w]) return MANUAL[w];
  if (w.length < 6 || /\d/.test(w) || NO_STEM.has(w)) return w;
  let s = w, m;
  if      ((m = s.match(/^(meny|peny)([aiueo].*)$/))) s = 's' + m[2];
  else if ((m = s.match(/^(mem|pem)([aiueo].*)$/)))   s = 'p' + m[2];
  else if ((m = s.match(/^(men|pen)([aiueo].*)$/)))   s = 't' + m[2];
  else if ((m = s.match(/^(meng|peng)(.{4,})$/)))     s = m[2];
  else if ((m = s.match(/^(mem|pem|men|pen|ber|ter|per)(.{4,})$/))) s = m[2];
  else if ((m = s.match(/^ke(.{4,})an$/)))            s = m[1];
  const t = s.replace(/(kan|an|nya)$/, '');
  if (t.length >= 4) s = t;
  return MANUAL[s] || s;
}

function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/wire\s*mesh/g, 'wiremesh')
    .replace(/ready\s*mix/g, 'readymix')
    .replace(/dry\s*mix/g, 'drymix')
    .replace(/u\s*ditch/g, 'uditch')
    .replace(/m²|\bm\s*2\b/g, ' m2 ')
    .replace(/m³|\bm\s*3\b|\bmeter\s+kubik\b|\bkubikasi\b|\bkubik\b|\bkub\b/g, ' m3 ')
    .replace(/\bmeter\s+persegi\b/g, ' m2 ')
    .replace(/(\d)\s+(mm|cm|kg|ton)\b/g, '$1$2')   // "7 cm" == "7cm" (bug yang sama pernah terjadi di generate-articles.js)
    .replace(/\bfc\s*(\d+)/g, 'fc$1')
    .replace(/\bk\s*(\d{2,3})\b/g, 'k$1')
    .replace(/(\d)[.,](\d)/g, '$1$2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Multi-intent. "cara" saja (tanpa kata kerja) hanya jadi 'carabuat' bila tidak ada intent lain.
const INTENTS = [
  ['harga',    /\b(harga|biaya|ongkos|tarif|upah|borongan|rab)\b/],
  ['definisi', /\b(apa itu|apakah|pengertian|arti|definisi|adalah)\b/],
  ['hitung',   /\b(menghitung|hitungan|perhitungan|hitung|rumus|kalkulasi|kebutuhan|takaran|analisa)\b/],
  ['carabuat', /\b(memasang|pemasangan|dipasang|cara pasang|membuat|pembuatan|memperbaiki|mengatasi|merawat|perawatan|menyambung|mengecor|menambal|melapisi|finishing|tutorial)\b/],
  ['jenis',    /\b(jenis|macam|tipe|ragam|perbedaan|dibanding\w*|vs|bagus mana|perbandingan)\b/],
  ['ukuran',   /\b(ukuran|dimensi|kapasitas|tebal|panjang|lebar|tinggi)\b/],
  ['masalah',  /\b(penyebab|solusi)\b/],
  ['manfaat',  /\b(kelebihan|kekurangan|manfaat|fungsi|keunggulan|ciri|ciri ciri)\b/],
  ['waktu',    /\b(berapa lama|berapa hari|berapa jam|kapan)\b/],
  ['ukuran',   /\bberapa (kubik|kg|kilo|m2|m3|meter|besar|banyak|ukuran|kapasitas)\b/],
  ['rekomendasi', /\b(terbaik|rekomendasi|pilihan|memilih)\b/],
];

// v5: bendera hard-conflict. Satu sisi punya, sisi lain tidak => bukan duplikat.
const FLAGS = [
  ['sewa', /\b(sewa|rental)\b/],
  ['jasa', /\b(jasa|tukang|kontraktor|pemborong)\b/],
];

// v5: lokasi = frasa setelah "di"/"ke" di akhir teks (maks 4 kata), mis. "ke kemayoran jakarta".
const LOC_RE = /\b(?:di|ke)\s+(\S+(?:\s+\S+){0,5})$/;
const NON_LOC_FIRST = new Set(['rumah','proyek','bangunan','lapangan','indonesia','tempat','sini','sana','lokasi',
  'jalan','gudang','pabrik','toko','lahan','bawah','atas','dalam','luar','mana','apa','kamar',
  'dapur','teras','halaman','pagar','atap','lantai','dinding','kolam','jalur']);
// CATATAN: 'pasar' (Pasar Manggis/Baru/Rebo), 'tanah' (Tanah Abang/Baru) dan 'sawah' (Sawah Besar) sengaja TIDAK
// dimasukkan — itu awalan nama kelurahan sungguhan di Jabodetabek.
// Kota/kabupaten besar: set-nya harus SAMA di kedua sisi (halaman Tangerang != halaman umum != halaman Bogor).
const CITY_NAMES = new Set(['jakarta','bekasi','depok','bogor','tangerang','banten','serang','cikarang','karawang',
  'purwakarta','bandung','cibubur','sentul','cileungsi','cikupa','cibitung','dki']);
const LOC_DROP = new Set(['kota','kabupaten','kab','jabodetabek','free','ongkir','gratis','dan','di','ke',
  'barat','timur','utara','selatan','tengah','pusat']);

// Mengembalikan { tokens: semua kata frasa lokasi (dibuang dari topik), loc: Set kata lokasi ter-stem }.
// Nama lokasi TIDAK ikut jadi kata topik: kalau ikut, "besi beton di X" dan "batako di X" tampak kembar
// hanya karena sama-sama di X. Lokasi dibandingkan terpisah lewat geoConflict().
function extractLocation(norm) {
  const m = norm.match(LOC_RE);
  if (!m) return { tokens: new Set(), loc: new Set() };
  const toks = m[1].split(' ');
  if (NON_LOC_FIRST.has(toks[0]) || /^\d/.test(toks[0])) return { tokens: new Set(), loc: new Set() };
  return {
    tokens: new Set(toks),
    loc: new Set(toks.filter(t => t.length >= 3 && !LOC_DROP.has(t) && !/\d/.test(t)).map(stem)),
  };
}

function analyze(text) {
  const norm = normalize(text);
  const { tokens: locTokens, loc } = extractLocation(norm);
  const topic = new Map();
  const nums = new Set();
  const dirs = new Set(), cities = new Set();
  for (const raw of norm.split(' ')) {
    if (!raw) continue;
    if (DIRS.has(raw)) dirs.add(raw);
    if (CITY_NAMES.has(raw)) cities.add(raw);
    if (locTokens.has(raw) || CITY_NAMES.has(raw)) continue;   // lokasi bukan kata topik
    if (/^(19|20)\d{2}$/.test(raw)) continue;                 // tahun
    if (/^\d+$/.test(raw)) { nums.add(raw); continue; }       // angka polos: hanya penanda konflik
    if (VARIANT.test(raw)) { topic.set(raw, 1); continue; }   // k225, fc20, 3x3: variant
    if (/\d/.test(raw)) { nums.add(raw); continue; }          // m2, m3, 10mm: satuan
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    topic.set(s, GENERIC.has(s) ? GENERIC_WEIGHT : 1);
  }
  let intents = new Set(INTENTS.filter(([, re]) => re.test(norm)).map(([n]) => n));
  if (!intents.size && /\bcara\b/.test(norm)) intents = new Set(['carabuat']);
  const flags = new Set(FLAGS.filter(([, re]) => re.test(norm)).map(([n]) => n));
  return { topic, nums, intents, flags, dirs, cities, loc };
}

const sum = m => { let t = 0; for (const w of m.values()) t += w; return t; };
const intersects = (a, b) => [...a].some(x => b.has(x));
const subset = (a, b) => [...a].every(x => b.has(x));
const sameSet = (a, b) => a.size === b.size && subset(a, b);

function geoConflict(a, b) {
  if (!sameSet(a.dirs, b.dirs)) return true;                       // bekasi timur != bekasi barat != bekasi
  if (!sameSet(a.cities, b.cities)) return true;                   // bogor != jakarta != tanpa kota
  const la = a.loc, lb = b.loc;
  // Halaman programatik dibuat per kelurahan: "cisalak" != "cisalak pasar", "kapuk" != "kapuk muara".
  if (la.size && lb.size) return !sameSet(la, lb);
  const covered = (loc, other) => [...loc].every(t => other.topic.has(t));
  if (la.size) return !covered(la, b);                              // halaman lokal != halaman umum
  if (lb.size) return !covered(lb, a);
  return false;
}
const flagConflict = (a, b) => FLAGS.some(([n]) => a.flags.has(n) !== b.flags.has(n));

// Konflik KERAS yang tidak boleh dilanggar siapa pun (termasuk AI): satuan beda (m2 vs m3), angka beda,
// mutu/ukuran beda (K225 vs K300), lokasi beda, sewa vs jual, jasa vs produk.
function hardConflict(a, b) {
  // Angka harus SAMA persis: batu split 1-2 vs 2-3 vs 3-5 (beririsan di "2") adalah produk berbeda.
  if (a.nums.size && b.nums.size && !sameSet(a.nums, b.nums)) return true;
  const onlyA = [...a.topic.keys()].filter(t => !b.topic.has(t));
  const onlyB = [...b.topic.keys()].filter(t => !a.topic.has(t));
  if (onlyA.some(t => VARIANT.test(t)) || onlyB.some(t => VARIANT.test(t))) return true;
  return flagConflict(a, b) || geoConflict(a, b);
}

function isDuplicate(a, b, opts = {}) {
  if (!a.topic.size || !b.topic.size) return false;
  if (hardConflict(a, b)) return false;
  if (a.intents.size && b.intents.size && !intersects(a.intents, b.intents)) return false;   // intent beda

  const shared = [...a.topic.keys()].filter(t => b.topic.has(t));
  const onlyA  = [...a.topic.keys()].filter(t => !b.topic.has(t));
  const onlyB  = [...b.topic.keys()].filter(t => !a.topic.has(t));

  // Topik identik (mis. "biaya dak per meter" vs "biaya dak permeter")
  if (!onlyA.length && !onlyB.length) return true;

  const spec = m => [...m.entries()].filter(([, w]) => w === 1).length;
  const specA = spec(a.topic), specB = spec(b.topic);
  const sharedSpec = shared.filter(t => a.topic.get(t) === 1).length;
  const need = Math.min(2, specA, specB);
  if (sharedSpec < need) return false;

  const wShared = shared.reduce((n, t) => n + a.topic.get(t), 0);
  if (wShared < 0.8) return false;

  const sameIntent = a.intents.size && b.intents.size && intersects(a.intents, b.intents);
  const contained = !onlyA.length || !onlyB.length;
  if (Math.min(specA, specB) <= 1 && !sameIntent && !(contained && Math.min(a.topic.size, b.topic.size) >= 2)) return false;

  // Pembeda di kedua sisi => artikel berbeda. Di situs material ini berlaku untuk kata APA PUN (spesifik atau
  // generik): batako 2 lubang vs batako putih vs batako beton, pasir urug vs pasir pasang, atap vs reng.
  // Hanya sisi yang terkandung penuh di sisi lain (onlyA atau onlyB kosong) yang bisa jadi duplikat.
  if (onlyA.length && onlyB.length) return false;

  const overlap = wShared / Math.min(sum(a.topic), sum(b.topic));
  const threshold = opts.strict ? 0.75 : (sameIntent ? 0.5 : 0.6);
  return overlap >= threshold;
}

// Satu artikel = analisa keyword (atau slug) + analisa judul. Judul memakai intent milik keyword.
function analyzeArticle({ keyword, title, slug }) {
  const kw = analyze(keyword || (slug ? String(slug).replace(/-/g, ' ') : title));
  const tt = analyze(title || keyword || '');
  if (kw.intents.size) tt.intents = kw.intents;
  return { kw, tt };
}
function articlesDuplicate(A, B) {
  return isDuplicate(A.kw, B.kw) || isDuplicate(A.tt, B.tt, { strict: true });
}

// Skor kandidat LONGGAR (untuk menyaring sebelum dinilai AI). 0 = bukan kandidat.
function candidateScore(a, b) {
  if (!a.topic.size || !b.topic.size || hardConflict(a, b)) return 0;
  // Kata spesifik berbeda di KEDUA sisi => produk berbeda, tidak perlu menyita kuota AI.
  const specOnly = (x, y) => [...x.topic].some(([t, wt]) => wt === 1 && !y.topic.has(t));
  if (specOnly(a, b) && specOnly(b, a)) return 0;
  let w = 0;
  for (const [t, wt] of a.topic) if (b.topic.has(t)) w += wt;
  if (w < 1) return 0;                       // minimal 1 kata spesifik, atau 3 kata generik
  return w / Math.min(sum(a.topic), sum(b.topic));
}

function compareKeywords(kwA, kwB) { return isDuplicate(analyze(kwA), analyze(kwB)); }

module.exports = { hardConflict, geoConflict, candidateScore, analyze, analyzeArticle, articlesDuplicate,
  isDuplicate, compareKeywords, normalize, stem };
