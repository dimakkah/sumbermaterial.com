/**
 * tools/lib/md-lint.js
 *
 * Perapi + pemeriksa struktur Markdown (deterministik, tanpa AI).
 *
 * KENAPA ADA:
 * Keluaran AI sering "hampir benar" tapi berantakan: daftar menempel ke paragraf, heading tanpa
 * baris kosong, H1 di badan artikel (judul sudah ada di frontmatter), lompat level heading
 * (H2 -> H4), heading berakhir titik dua, `**` tak berpasangan yang membuat satu paragraf jadi
 * tebal semua, dan sebagainya. Semua itu bisa dicek dan diperbaiki kode secara konsisten,
 * jadi tidak perlu AI sebagai pemeriksa struktur.
 *
 * fixMarkdown(body)  -> { text, fixes[] }   perbaikan aman (tidak mengubah arti kalimat)
 * mdIssues(body, opts) -> string[]          peringatan yang tidak bisa diperbaiki otomatis
 * fixMarkdownFile(fullText)                 sama seperti fixMarkdown tapi frontmatter dilewati
 *
 * Bagian yang TIDAK pernah disentuh: frontmatter, blok kode (``` / ~~~), blok HTML
 * (<table>, <div>, ... sampai tag penutupnya), dan baris shortcode Hugo ({{< ... >}}).
 */

const HTML_BLOCK_OPEN = /^\s*<(table|div|ul|ol|figure|section|details|style|script|iframe|blockquote|pre|center|p|h[1-6])\b/i;
const LIST_RE = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(\S.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SHORTCODE_RE = /^\s*\{\{[<%]/;
const IMAGE_ONLY_RE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return { front: '', body: text };
  return { front: m[0], body: text.slice(m[0].length) };
}

function plainHeading(s) {
  return s.replace(/\*\*|__/g, '').replace(/[`]/g, '').trim();
}

/** Klasifikasi tiap baris: blank | code | html | shortcode | heading | list | table | image | para */
function classify(lines) {
  const kinds = [];
  let inFence = null;
  let htmlClose = null;
  for (const line of lines) {
    if (inFence) {
      kinds.push('code');
      if (new RegExp('^\\s*' + inFence + '\\s*$').test(line)) inFence = null;
      continue;
    }
    if (htmlClose) {
      kinds.push('html');
      if (htmlClose.test(line)) htmlClose = null;
      continue;
    }
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) { inFence = fence[1][0].repeat(3) + '+'; kinds.push('code'); continue; }
    if (!line.trim()) { kinds.push('blank'); continue; }
    const h = line.match(HTML_BLOCK_OPEN);
    if (h) {
      const close = new RegExp('</' + h[1] + '\\s*>', 'i');
      kinds.push('html');
      if (!close.test(line)) htmlClose = close;
      continue;
    }
    if (/^\s*<\/?[a-z!]/i.test(line)) { kinds.push('html'); continue; }
    if (SHORTCODE_RE.test(line)) { kinds.push('shortcode'); continue; }
    if (HEADING_RE.test(line) && /^#{1,6}\s/.test(line)) { kinds.push('heading'); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { kinds.push('table'); continue; }
    if (IMAGE_ONLY_RE.test(line)) { kinds.push('image'); continue; }
    if (LIST_RE.test(line) && !/^\s*\*\*/.test(line) && !/^\s*[-*]{3,}\s*$/.test(line)) { kinds.push('list'); continue; }
    // baris menjorok (lanjutan butir daftar) -> ikut daftar jika sebelumnya daftar
    if (/^\s{2,}\S/.test(line) && (kinds[kinds.length - 1] === 'list')) { kinds.push('list'); continue; }
    kinds.push('para');
  }
  return kinds;
}

function fixMarkdown(body) {
  const fixes = [];
  const note = (m) => { if (!fixes.includes(m)) fixes.push(m); };
  let text = String(body || '').replace(/\r\n/g, '\n');

  // karakter tak terlihat / spasi aneh (bukan di dalam kode)
  const cleaned = text.replace(/[​-‍﻿]/g, '').replace(/ /g, ' ');
  if (cleaned !== text) { note('karakter tak terlihat dibersihkan'); text = cleaned; }

  let lines = text.split('\n');
  let kinds = classify(lines);

  // ── 0. "### Judul" kosong yang langsung disusul "### 1. ..", "### 2. .." (sejajar) -> yang bernomor jadi anak ──
  {
    const hIdx = [];
    for (let i = 0; i < lines.length; i++) if (kinds[i] === 'heading') hIdx.push(i);
    const only = (from, to) => { for (let x = from + 1; x < to; x++) if (kinds[x] !== 'blank') return false; return true; };
    const lvOf = (l) => (l.match(/^#+/) || [''])[0].length;
    const numbered = (l) => /^#{1,6}\s+\**\d{1,2}\\?[.)]\s/.test(l);
    for (let n = 0; n < hIdx.length - 1; n++) {
      const i = hIdx[n], j = hIdx[n + 1];
      if (!only(i, j) || numbered(lines[i]) || !numbered(lines[j]) || lvOf(lines[i]) !== lvOf(lines[j]) || lvOf(lines[i]) >= 6) continue;
      let k = n + 1;
      while (k < hIdx.length && numbered(lines[hIdx[k]]) && lvOf(lines[hIdx[k]]) === lvOf(lines[i])) {
        lines[hIdx[k]] = '#' + lines[hIdx[k]];
        k++;
      }
      note('sub-bagian bernomor ditempatkan di bawah heading induknya');
    }
  }

  // ── 1. perbaikan per baris (tidak mengubah jumlah baris) ───────────────────────────────
  let prevLevel = 1;                  // judul artikel (H1) ada di frontmatter
  let lastHeadingText = null;
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    const k = kinds[i];
    if (k === 'code' || k === 'html' || k === 'shortcode') continue;

    if (k === 'para') {
      let lm;
      // simbol Wingdings/Symbol (karakter private-use, tampil sebagai kotak) & bullet unicode -> "- "
      if ((lm = lines[i].match(/^\s*[\ue000-\uf8ff●▪◦‣▫■□✓✔➤➢►]\s*(\S.*)$/))) {
        lines[i] = `- ${lm[1]}`; kinds[i] = 'list'; note('simbol bullet aneh (kotak/Wingdings) diubah jadi daftar "-"');
      }
      // "\- item" (tanda hubung di-escape, jadi teks biasa menempel) -> "- item"
      else if ((lm = lines[i].match(/^(\s*)\\([-*+])\s+(\S.*)$/))) {
        lines[i] = `${lm[1]}- ${lm[3]}`; kinds[i] = 'list'; note('"\\-" di awal baris diubah jadi daftar "-"');
      }
      // "1\. item" (titik di-escape, bukan daftar) -> "1. item"
      else if ((lm = lines[i].match(/^(\s*)(\d{1,3})\\([.)])\s*(\S.*)$/))) {
        lines[i] = `${lm[1]}${lm[2]}${lm[3]} ${lm[4]}`; kinds[i] = 'list'; note('daftar bernomor yang di-escape dirapikan');
      }
    }

    // "##Judul" tanpa spasi -> "## Judul" (hanya level 2+, supaya #hashtag aman)
    if (k === 'para') {
      const m = lines[i].match(/^(#{2,6})([^\s#].*)$/);
      if (m) { lines[i] = `${m[1]} ${m[2]}`; kinds[i] = 'heading'; note('heading tanpa spasi diperbaiki'); }
    }

    if (kinds[i] === 'heading') {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (!m) { drop.add(i); note('heading kosong dibuang'); continue; }   // "##" tanpa teks
      let level = m[1].length;
      let txt = m[2].replace(/\s+#+\s*$/, '').trim();
      // heading dibungkus tebal: ## **Judul** -> ## Judul
      const bold = txt.match(/^(\*\*|__)(.+)\1$/);
      if (bold) { txt = bold[2].trim(); note('heading dibungkus tebal dirapikan'); }
      txt = txt.replace(/^(\**)(\d{1,3})\\([.)])/, '$1$2$3');   // "1\." -> "1."
      const stripped = txt.replace(/\s*[:.;,]+$/, '');
      if (stripped !== txt) { txt = stripped; note('tanda baca di akhir heading dibuang'); }
      if (!plainHeading(txt)) { drop.add(i); note('heading kosong dibuang'); continue; }
      if (level === 1) { level = 2; note('H1 di badan artikel diturunkan ke H2'); }
      if (level > prevLevel + 1) { level = prevLevel + 1; note('lompatan level heading diperbaiki'); }
      prevLevel = level;
      const key = plainHeading(txt).toLowerCase();
      if (key === lastHeadingText) { drop.add(i); note('heading kembar berurutan dibuang'); continue; }
      lastHeadingText = key;
      lines[i] = `${'#'.repeat(level)} ${txt}`;
      continue;
    }
    if (k !== 'blank') lastHeadingText = null;

    // penanda daftar seragam: "* item" / "• item" / "+ item" -> "- item"
    if (k === 'list') {
      const lm = lines[i].match(/^(\s*)([*+•])\s+(\S.*)$/);
      if (lm) { lines[i] = `${lm[1]}- ${lm[3]}`; note('penanda daftar diseragamkan'); }
    }

    // ** tak berpasangan pada satu baris -> hapus semua ** di baris itu
    if (k !== 'table') {
      const stars = (lines[i].match(/\*\*/g) || []).length;
      if (stars % 2 === 1) { lines[i] = lines[i].replace(/\*\*/g, ''); note('tanda ** tak berpasangan dibuang'); }
    }
  }
  if (drop.size) { lines = lines.filter((_, i) => !drop.has(i)); kinds = classify(lines); }
  else kinds = classify(lines);

  // spasi di akhir baris dibuang (kecuali "  " sebagai <br> yang disengaja di antara dua baris paragraf)
  for (let i = 0; i < lines.length; i++) {
    const k = kinds[i];
    if (k === 'code' || k === 'html' || k === 'shortcode' || !/[ \t]+$/.test(lines[i])) continue;
    const hardBreak = / {2,}$/.test(lines[i]) && k === 'para' && kinds[i + 1] === 'para';
    lines[i] = lines[i].replace(/[ \t]+$/, hardBreak ? '  ' : '');
  }

  // ── 2. baris kosong antar-blok ──────────────────────────────────────────────────────────
  const out = [];
  const outKinds = [];
  const needBlank = (a, b) => {
    if (a === 'blank' || b === 'blank') return false;
    if (a === 'code' && b === 'code') return false;
    if (a === 'html' && b === 'html') return false;
    if (a === 'table' && b === 'table') return false;
    if (a === 'list' && b === 'list') return false;
    if (a === 'para' && b === 'para') return false;            // satu paragraf, baris disambung
    if (a === 'code' || b === 'code') return false;            // jangan sentuh sekitar kode
    return true;                                               // semua perpindahan blok lain
  };
  for (let i = 0; i < lines.length; i++) {
    const k = kinds[i];
    if (out.length) {
      const pk = outKinds[outKinds.length - 1];
      if (needBlank(pk, k)) { out.push(''); outKinds.push('blank'); note('baris kosong antar-blok ditambahkan'); }
    }
    out.push(lines[i]); outKinds.push(k);
  }
  // rapatkan baris kosong berlebihan (di luar blok kode)
  const squeezed = [];
  let blanks = 0;
  for (let i = 0; i < out.length; i++) {
    if (outKinds[i] === 'blank') { blanks++; if (blanks > 1) { note('baris kosong berlebih dirapatkan'); continue; } }
    else blanks = 0;
    squeezed.push(out[i]);
  }
  const joined = squeezed.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  const result = joined ? joined + '\n' : '';
  return { text: result, fixes };
}

function fixMarkdownFile(fullText) {
  const { front, body } = splitFrontmatter(fullText);
  const lead = body.startsWith('\n') ? '\n' : '';
  const r = fixMarkdown(body);
  return { text: front + lead + r.text, fixes: r.fixes };
}

/**
 * Peringatan yang tidak bisa (dan tidak boleh) diperbaiki otomatis.
 * opts: { minH2 = 3, maxH2 = 7, maxParagraphWords = 200 }
 */
function mdIssues(body, opts = {}) {
  const { minH2 = 3, maxH2 = 7, maxParagraphWords = 200 } = opts;
  const issues = [];
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const kinds = classify(lines);
  const h2 = lines.filter((l, i) => kinds[i] === 'heading' && /^##\s/.test(l));
  if (h2.length < minH2) issues.push(`struktur: hanya ${h2.length} heading H2 (minimal ${minH2})`);
  if (h2.length > maxH2) issues.push(`struktur: ${h2.length} heading H2 (maksimal ${maxH2})`);
  // bagian kosong: heading langsung diikuti heading
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] !== 'heading') continue;
    let j = i + 1;
    while (j < lines.length && kinds[j] === 'blank') j++;
    const lv = (l) => l.match(/^#+/)[0].length;
    if (j < lines.length && kinds[j] === 'heading' && lv(lines[j]) <= lv(lines[i])) { issues.push(`struktur: heading tanpa isi: "${lines[i].replace(/^#+\s*/, '').slice(0, 50)}"`); break; }
  }
  // paragraf kepanjangan (dinding teks)
  let cur = [];
  const flush = () => {
    const words = cur.join(' ').split(/\s+/).filter(Boolean).length;
    if (words > maxParagraphWords) issues.push(`struktur: ada paragraf ${words} kata (pecah jadi paragraf lebih pendek)`);
    cur = [];
  };
  let flagged = false;
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] === 'para') cur.push(lines[i]);
    else if (cur.length) { if (!flagged) { const n = issues.length; flush(); if (issues.length > n) flagged = true; } else cur = []; }
  }
  if (cur.length && !flagged) flush();
  // heading terlalu panjang
  const longH = lines.find((l, i) => kinds[i] === 'heading' && l.replace(/^#+\s*/, '').split(/\s+/).length > 18);
  if (longH) issues.push(`struktur: heading terlalu panjang: "${longH.replace(/^#+\s*/, '').slice(0, 60)}..."`);
  return issues;
}

module.exports = { fixMarkdown, fixMarkdownFile, mdIssues, splitFrontmatter };
