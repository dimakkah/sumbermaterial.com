/**
 * tools/lib/orphan-link.js  (v2 — relevansi anchor dijamin lewat aturan, bukan lewat tebakan AI)
 *
 * Mengapa v1 diganti: AI diminta "menyisipkan satu link" ke kalimat bebas, sehingga (a) anchor sering tidak
 * nyambung dengan halaman donor (halaman "Abadijaya Depok" memuat anchor "harga ... di Cakung Jakarta"),
 * (b) kalimat yang sudah berisi link orphan lain ikut ditimpa (link lama hilang -> orphan lama muncul lagi),
 * (c) AI ikut menulis ulang isi kalimat (nama lokasi berubah). Di sini semuanya ditentukan aturan & diverifikasi.
 *
 * Dua cara menyisipkan link (keduanya tanpa AI):
 *   1. BRIDGE  — halaman lokasi (mis. "Harga X Di Cakung Jakarta"): satu kalimat penghubung baru, ditulis dari
 *                template, ditaruh sebagai paragraf sendiri di halaman donor yang PRODUK-nya sama dan KOTA-nya sama
 *                (wilayah lain) atau LOKASI-nya sama (layanan lain di area yang sama). Anchor = judul tujuan.
 *   2. SPAN    — artikel non-lokasi: mencari frasa yang SUDAH ADA di kalimat donor dan mengandung kata topik tujuan
 *                (+ angka/ukuran yang sama persis); frasa itu yang dijadikan anchor. Tidak ada kata yang ditambah.
 * Setiap hasil WAJIB lolos verifyEdit(): tepat 1 link baru, link lama utuh, isi lain byte-identik, anchor relevan.
 */
'use strict';
const KS = require('./keyword-similarity.js');
const LA = require('./link-anchor.js');

const SMALL = new Set(['di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'pada', 'dalam']);
const EDGE_STOP = new Set([...SMALL, 'ini', 'itu', 'anda', 'kami', 'mitra', 'juga', 'akan', 'bisa', 'adalah', 'kita', 'sebuah', 'para']);
const VARIANT = /^(k|fc)\d+$|^\d+x\d+$|^\d+(mm|cm|kg|ton)$/;
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

// ───────────────────────── util
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
function hash(str) { let h = 5381; for (const ch of String(str)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0; return h; }

const CITY_RE = /\b(jakarta|bekasi|depok|bogor|tangerang|banten|serang|cikarang|karawang|purwakarta|bandung|cibubur|sentul|cileungsi|cikupa|cibitung|dki|rangkasbitung|sukabumi|cilegon)\b/;
function describe(title) {
  // Tagline setelah ":" ("Pasir Cimangkok: Kenali Kualitas…") bukan bagian topik/keyword — buang dari analisis.
  const head = String(title || '').split(/\s*[:|–—]\s+/)[0] || title;
  const a = KS.analyze(head);
  // Nama kelurahan yang kebetulan sama dengan kata biasa ("Gudang", "Pasar", "Rumah") dibuang KS dari lokasi. Bila frasa setelah
  // "di/ke" berakhir di nama kota, tetap anggap itu LOKASI dan keluarkan dari kata topik.
  if (!a.loc.size) {
    const m = KS.normalize(head).match(/\b(?:di|ke)\s+((?:\S+\s+){0,4}\S+)$/);
    if (m && CITY_RE.test(m[1])) {
      for (const t of m[1].split(' ')) { const st = KS.stem(t); if (t.length >= 3 && !/\d/.test(t)) { a.loc.add(st); a.topic.delete(st); } }
      for (const c of m[1].split(' ')) if (CITY_RE.test(c) && !/^(banten|dki)$/.test(c)) a.cities.add(c);
    }
  }
  const keys = new Set(a.topic.keys());                       // SEMUA kata topik (termasuk kata umum seperti besi/pasir/cor)
  const core = new Set([...a.topic].filter(([, w]) => w >= 1).map(([k]) => k));   // hanya kata pembeda (beam, hitam, wiremesh, ...)
  const surf = new Map();   // stem -> bentuk tulisan asli di judul (untuk mencegah kecocokan stem palsu: "menyatukan" != "satu")
  for (const w of KS.normalize(head).split(' ')) { const st = KS.stem(w); if (!surf.has(st)) surf.set(st, new Set()); surf.get(st).add(w); }
  return { title, ...a, keys, core, surf,
    topicSig: [...keys].sort().join(' '),
    coreSig: [...core].sort().join(' '),
    cityKey: [...a.cities].sort().join(','),
    locKey: [...a.loc].sort().join(' '),
    flagKey: [...a.flags].sort().join(','),
    numKey: [...a.nums].sort().join(','),
    hasLoc: a.loc.size > 0 };
}

function weightedJaccard(a, b) {
  let inter = 0, uni = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) { const x = a.get(k) || 0, y = b.get(k) || 0; inter += Math.min(x, y); uni += Math.max(x, y); }
  return uni ? inter / uni : 0;
}

function variantsDiffer(a, b) {
  const onlyA = [...a.topic.keys()].filter(t => !b.topic.has(t)), onlyB = [...b.topic.keys()].filter(t => !a.topic.has(t));
  return onlyA.some(t => VARIANT.test(t)) || onlyB.some(t => VARIANT.test(t));
}

/**
 * Hubungan donor -> tujuan (keduanya halaman lokasi). null = jangan dihubungkan.
 *  - 'sibling-area'      : produk SAMA, kota SAMA, kelurahan beda  ("wilayah lain yang juga Kami layani")
 *  - 'same-area-related' : lokasi SAMA, produk BERBEDA tapi terkait ("layanan lain di area yang sama")
 */
function relation(orphan, donor) {
  if (!orphan.hasLoc || !donor.hasLoc) return null;
  if (orphan.cityKey !== donor.cityKey || orphan.flagKey !== donor.flagKey) return null;
  const sameLoc = sameSet(orphan.loc, donor.loc);
  const sim = weightedJaccard(orphan.topic, donor.topic);
  if (!sameLoc) {
    if (orphan.topicSig && orphan.topicSig === donor.topicSig && orphan.numKey === donor.numKey && !variantsDiffer(orphan, donor)) return { type: 'sibling-area', sim };
    return null;
  }
  const shared = [...orphan.keys].filter(t => donor.keys.has(t)).length;
  if (shared >= 1 && sim >= 0.1 && sim < 0.8 && orphan.topicSig !== donor.topicSig && orphan.numKey === donor.numKey) return { type: 'same-area-related', sim };
  return null;
}

// ───────────────────────── anchor dari judul tujuan (untuk BRIDGE)
function anchorFromTitle(title) {
  let t = String(title || '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().replace(/^(harga|jual|biaya|tarif)\s+/i, '');
  const words = t.split(' ');
  let locStart = words.length;                      // frasa lokasi = setelah "di"/"ke" terakhir -> pertahankan huruf kapital
  for (let i = words.length - 2; i >= 1; i--) if (/^(di|ke)$/i.test(words[i])) { locStart = i + 1; break; }
  return words.map((w, i) => {
    if (i >= locStart) return w;
    if (/\d/.test(w) || (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) || w.length === 1) return w; // K500, WF, H
    return w.toLowerCase();
  }).join(' ');
}

const BRIDGE = {
  'sibling-area': [
    'Kebutuhan serupa di wilayah lain juga Kami layani, misalnya {a}.',
    'Mitra yang berada di area berbeda juga bisa memesan, termasuk untuk {a}.',
    'Selain di sini, Kami juga melayani {a}.',
    'Proyek Mitra ada di daerah lain? Kami juga melayani {a}.',
    'Untuk lokasi proyek di tempat lain, silakan lihat informasi {a}.',
    'Informasi untuk wilayah lain bisa dilihat pada halaman {a}.',
  ],
  'same-area-related': [
    'Di wilayah yang sama, Kami juga menyediakan {a}.',
    'Selain itu, Mitra di area ini juga bisa menanyakan {a}.',
    'Butuh material atau layanan lain untuk proyek yang sama? Lihat juga {a}.',
    'Untuk kebutuhan lain di lokasi yang sama, tersedia pula {a}.',
  ],
};

function buildBridge(orphan, rel) {
  const anchor = LA.shortAnchor(orphan.title);              // frasa pendek buatan script, bukan judul penuh
  const list = BRIDGE[rel.type];
  const tpl = list[hash(orphan.url || orphan.title) % list.length];
  return { anchor, paragraph: tpl.replace('{a}', `[${anchor}](${orphan.url})`) };
}

// Tempel kalimat penghubung di AKHIR paragraf isi terakhir (bukan paragraf penutup/CTA) — bukan paragraf baru sendirian.
// null bila tidak ada paragraf isi yang cocok (pemanggil memakai insertParagraph sebagai cadangan).
function appendToParagraph(body, sentence) {
  const parts = body.split(/(\r?\n[ \t]*\r?\n)/);
  const plain = (p) => { const t = p.trim(); return !!t && t.split(/\s+/).length >= 25 && !/^(#|\*|-|\||!\[|\{\{|\[\[|>|\d+\.\s|<|\[[^\]]+\]\()/.test(t); };
  const closing = (p) => /telepon|whatsapp|hubungi|kontak|penawaran/i.test(p.slice(-220));
  for (let i = parts.length - 1; i >= 0; i -= 2) {
    if (!plain(parts[i]) || closing(parts[i])) continue;
    const trail = parts[i].match(/\s*$/)[0];
    parts[i] = parts[i].slice(0, parts[i].length - trail.length) + ' ' + sentence + trail;
    return parts.join('');
  }
  return null;
}

// Sisipkan paragraf sebagai paragraf tersendiri: sebelum paragraf penutup (CTA) bila ada, kalau tidak di akhir.
function insertParagraph(body, paragraph) {
  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const core = body.replace(/\s+$/, '');
  const tail = body.slice(core.length);                       // spasi/newline di akhir file
  const spaces = (tail.match(/^[ \t]*/) || [''])[0];           // spasi akhir baris terakhir tetap menempel di baris itu
  const rest = tail.slice(spaces.length);
  const paras = core.split(/(?:\r?\n){2,}/);
  const last = paras[paras.length - 1] || '';
  // Paragraf terakhir yang dilewati: penutup/CTA ("hubungi Kami…") atau blok daftar link di akhir halaman ("[Harga … Di …](…)").
  const isLinkBlock = /^\[[^\]]+\]\(\/[^)]*\)/.test(last.trim());
  const closing = paras.length > 2 && ((!/^(#|\*|-|\||!\[|\{\{|\[\[|>|\d+\.)/.test(last.trim()) && /telepon|whatsapp|hubungi|kontak/i.test(last)) || isLinkBlock);
  if (closing) {
    const idx = core.lastIndexOf(last);
    return core.slice(0, idx) + paragraph + eol + eol + core.slice(idx) + spaces + rest;   // akhir file dipertahankan apa adanya
  }
  return core + spaces + eol + eol + paragraph + rest;
}

// ───────────────────────── SPAN: cari frasa yang sudah ada di kalimat donor
function stemOf(word) { return KS.stem(String(word).toLowerCase()); }
const SKIP_LINE = /^\s*(#|\*|-|\||!\[|\{\{|\[\[|>|\d+\.\s|\*\*|<)/;

function linkRanges(line) { const r = []; let m; const re = new RegExp(LINK_RE.source, 'g'); while ((m = re.exec(line))) r.push([m.index, m.index + m[0].length]); return r; }

function findSpan(body, orphan) {
  if (orphan.keys.size < 2 || orphan.hasLoc) return null;       // topik terlalu umum / halaman lokasi (pakai BRIDGE)
  const need = 2;
  const orphanTokens = new Set([...orphan.keys, ...orphan.nums]);
  let best = null, offset = 0;
  const lines = body.split(/(\r?\n)/);
  for (let li = 0; li < lines.length; li += 2) {
    const line = lines[li], lineStart = offset;
    offset += line.length + (lines[li + 1] ? lines[li + 1].length : 0);
    if (!line.trim() || SKIP_LINE.test(line) || line.length < 60) continue;
    const toks = []; const re = /[A-Za-z0-9][A-Za-z0-9-]*/g; let m;
    while ((m = re.exec(line))) toks.push({ w: m[0], s: m.index, e: m.index + m[0].length, st: stemOf(m[0]), nn: KS.normalize(m[0]) });
    const links = linkRanges(line);
    for (let i = 0; i < toks.length; i++) for (let n = 2; n <= 7 && i + n <= toks.length; n++) {
      const win = toks.slice(i, i + n);
      if (win.some((t, k) => k && /[^ ]/.test(line.slice(win[k - 1].e, t.s)))) break;           // tidak melewati tanda baca
      const hit = t => orphan.nums.has(t.nn) || (orphan.keys.has(t.st) && [...(orphan.surf.get(t.st) || [])].some(sf => sf.slice(0, 4) === t.nn.slice(0, 4)));
      if (!hit(win[0]) || !hit(win[n - 1]) || EDGE_STOP.has(win[0].w.toLowerCase()) || EDGE_STOP.has(win[n - 1].w.toLowerCase())) continue;
      const matchedCore = new Set(win.filter(t => hit(t) && orphan.keys.has(t.st)).map(t => t.st));
      if (orphan.core.size && ![...orphan.core].some(c => matchedCore.has(c))) continue;      // wajib memuat kata pembeda (jalupang, pipih, wiremesh, ...)
      if (matchedCore.size < need) continue;
      // Semua kata di frasa harus kata topik tujuan (boleh 1 kata sambung di tengah) — mencegah frasa campuran
      // seperti "batako press ini secara biasa" atau "baja ringan" untuk halaman "Sumber Baja".
      const CONNECT = new Set(['dan', 'untuk', 'per', 'dengan', 'di', 'ke', 'atau', 'yang']);
      const foreign = win.filter(t => !hit(t));
      if (foreign.length > 1 || foreign.some(t => !CONNECT.has(t.w.toLowerCase()))) continue;
      const matchedW = [...matchedCore].reduce((x, k) => x + orphan.topic.get(k), 0);
      const totalW = [...orphan.topic.values()].reduce((x, y) => x + y, 0);
      if (matchedW < 1) continue;                                   // bukan hanya kata umum ("besi", "pasir")
      if (matchedW / totalW < 0.7) continue;                        // anchor harus mewakili SEBAGIAN BESAR topik tujuan (bukan "batu kali" untuk "batu kali bulat besar")
      if (matchedCore.size / n < 0.4) continue;                     // dan padat: bukan frasa panjang dengan 2 kata cocok
      const winNorm = new Set(win.map(t => t.nn)), winSt = new Set(win.map(t => t.st));
      if ([...orphan.nums].some(x => !winNorm.has(x))) continue;                                 // angka/ukuran harus sama persis
      if ([...orphanTokens].filter(t => VARIANT.test(t)).some(t => !winSt.has(t))) continue;      // mutu/varian (K225, 3x3) harus ikut
      if (win.some(t => KS.normalize(t.w).split(' ').some(x => ['jakarta', 'bekasi', 'depok', 'bogor', 'tangerang', 'serang', 'karawang', 'purwakarta', 'banten'].includes(x)))) continue; // tujuan non-lokasi
      const start = win[0].s, end = win[n - 1].e;
      if (links.some(([a, b]) => start < b && end > a)) continue;                                // bukan di dalam link lama
      if (((line.slice(0, start).match(/\*\*/g) || []).length) % 2) continue;                     // bukan di dalam teks tebal
      if (/[[\]()]/.test(line.slice(Math.max(0, start - 1), start)) || /[[\]()]/.test(line.slice(end, end + 1))) continue;
      const density = matchedCore.size / n;
      const score = matchedCore.size * 2 + density - (n > 5 ? 0.5 : 0) + (lineStart > 0 ? 0.2 : 0);
      if (!best || score > best.score) best = { score, anchor: line.slice(start, end), abs: lineStart + start, absEnd: lineStart + end };
    }
  }
  return best;
}

function applySpan(body, span, url) { return body.slice(0, span.abs) + `[${span.anchor}](${url})` + body.slice(span.absEnd); }

// ───────────────────────── verifikasi akhir (semua hasil WAJIB lewat sini)
function relevantAnchor(anchor, orphan) {
  const toks = KS.normalize(anchor).split(' ').filter(Boolean);
  const st = new Set(toks.map(stemOf));
  const hits = [...orphan.keys].filter(t => st.has(t));
  if (hits.length < Math.min(2, orphan.keys.size) || hits.reduce((x, k) => x + orphan.topic.get(k), 0) < Math.min(1, [...orphan.topic.values()].reduce((x, y) => x + y, 0))) return 'anchor tidak memuat kata topik halaman tujuan';
  if (orphan.core.size && ![...orphan.core].some(t => st.has(t))) return 'anchor tidak memuat kata pembeda halaman tujuan';
  const totW = [...orphan.topic.values()].reduce((x, y) => x + y, 0), gotW = hits.reduce((x, k) => x + orphan.topic.get(k), 0);
  if (totW && gotW / totW < 0.7) return 'anchor hanya mewakili sebagian kecil topik halaman tujuan';
  if (orphan.hasLoc && ![...orphan.loc].some(t => st.has(t))) return 'anchor tidak memuat nama lokasi halaman tujuan';
  if ([...orphan.nums].some(x => !toks.includes(x))) return 'anchor tidak memuat angka/ukuran halaman tujuan';
  if (toks.length < 2) return 'anchor terlalu pendek';
  if (toks.length > 12) return 'anchor terlalu panjang';
  if (/^(klik|baca|selengkapnya|di sini|lihat)/i.test(anchor.trim())) return 'anchor generik';
  return null;
}

function linksOf(text) { return [...text.matchAll(LINK_RE)].map(m => `${m[1]}\u0000${m[2]}`); }

/** null = valid; selain itu alasan penolakan. mode: 'bridge' | 'span'. */
function verifyEdit(oldBody, newBody, orphan, anchor, mode, paragraph) {
  const oldL = linksOf(oldBody), newL = linksOf(newBody);
  if (newL.length !== oldL.length + 1) return `jumlah link berubah ${oldL.length} -> ${newL.length} (harus +1)`;
  const rest = [...newL]; for (const l of oldL) { const i = rest.indexOf(l); if (i < 0) return 'link lama hilang/berubah'; rest.splice(i, 1); }
  if (rest[0] !== `${anchor}\u0000${orphan.url}`) return 'link baru bukan anchor/URL yang dimaksud';
  const delinked = newBody.replace(`[${anchor}](${orphan.url})`, anchor);
  if (mode === 'span' && delinked !== oldBody) return 'isi lain ikut berubah (bukan hanya penambahan link)';
  if (mode === 'bridge') {
    const plain = paragraph.replace(`[${anchor}](${orphan.url})`, anchor);
    const norm = (x) => x.replace(/\s+/g, ' ').trim();
    if (norm(delinked.replace(plain, '')) !== norm(oldBody)) return 'isi lain ikut berubah (bukan hanya paragraf penghubung)';
  }
  return relevantAnchor(anchor, orphan);
}

// ───────────────────────── front matter (sama seperti v1)
function splitFrontMatter(raw) {
  const m = raw.match(/^---(\r?\n[\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { rawMatter: m[1], body: m[2] || '' } : null;
}
function setLastmod(rawMatter, newDate) {
  const line = `lastmod: "${newDate}"`;
  if (/^lastmod:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^lastmod:\s*.*$/m, line);
  if (/^date:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^(date:\s*.*)$/m, `$1\n${line}`);
  return `${rawMatter}\n${line}`;
}
function assemble(rawMatter, newBody, newDate) { return `---${setLastmod(rawMatter, newDate)}\n---\n${newBody}`; }

/** Satu pintu: rencanakan sisipan untuk (orphan, donor). Mengembalikan { newBody, anchor, mode, note } atau { reject }. */
function planInsertion(orphan, donorDesc, donorBody) {
  if (orphan.hasLoc) {
    const rel = relation(orphan, donorDesc);
    if (!rel) return { reject: 'donor tidak sepadan (produk/kota/lokasi)' };
    const { anchor, paragraph } = buildBridge(orphan, rel);
    const newBody = appendToParagraph(donorBody, paragraph) || insertParagraph(donorBody, paragraph);
    const err = verifyEdit(donorBody, newBody, orphan, anchor, 'bridge', paragraph);
    return err ? { reject: err } : { newBody, anchor, mode: 'bridge', note: rel.type, sentence: paragraph };
  }
  if (orphan.cities.size && !sameSet(orphan.cities, donorDesc.cities)) return { reject: 'halaman tujuan spesifik kota, donor beda kota' };
  const span = findSpan(donorBody, orphan);
  if (!span) return { reject: 'tidak ada frasa relevan di donor' };
  const newBody = applySpan(donorBody, span, orphan.url);
  const err = verifyEdit(donorBody, newBody, orphan, span.anchor, 'span');
  return err ? { reject: err } : { newBody, anchor: span.anchor, mode: 'span', note: 'frasa-asli', sentence: span.anchor };
}

module.exports = { BRIDGE, describe, relation, anchorFromTitle, buildBridge, insertParagraph, appendToParagraph, findSpan, applySpan, verifyEdit, relevantAnchor,
  planInsertion, splitFrontMatter, setLastmod, assemble, weightedJaccard, hash, LINK_RE };
