#!/usr/bin/env node
/**
 * tools/fix-markdown-structure.js  — SEKALI PAKAI
 *
 * Merapikan struktur Markdown artikel LAMA di content/ memakai lib/md-lint.js (tanpa AI, tanpa secret):
 *   - bullet berupa kotak/Wingdings (karakter private-use U+F0FC dst.) dan bullet unicode -> daftar "- "
 *   - "\- item" dan "1\. item" (di-escape sehingga tampil sebagai paragraf menyatu) -> daftar sungguhan
 *   - baris kosong antar-blok (daftar menempel ke paragraf, heading, tabel, gambar)
 *   - H1 di badan, lompatan level heading, heading kosong/kembar, tanda ** tak berpasangan, dst.
 *   - sub-bagian bernomor ("### 1. ...") ditempatkan di bawah heading induknya
 * Blok HTML, tabel, shortcode, blok kode, dan frontmatter tidak disentuh.
 *
 * Pengaman: setiap file diperiksa dulu — teks yang terlihat pembaca (tanpa simbol Markdown/spasi) harus
 * SAMA sebelum dan sesudah, begitu juga baris HTML/shortcode/tabel. File yang tidak lolos TIDAK ditulis
 * dan dilaporkan di akhir.
 *
 *   node tools/fix-markdown-structure.js                 → pratinjau (tidak menulis apa pun)
 *   node tools/fix-markdown-structure.js --apply         → tulis perubahan
 *   node tools/fix-markdown-structure.js --show=5        → tampilkan 5 contoh perubahan (default 3)
 *   node tools/fix-markdown-structure.js --dir=content/baja-ringan   → batasi ke satu folder
 *
 * Setelah dipakai dan hasilnya sudah di-commit, script ini dan workflow-nya boleh dihapus
 * (lib/md-lint.js JANGAN dihapus: dipakai generate-articles.js dan revise-articles.js).
 */
const fs = require('fs');
const path = require('path');
const MdLint = require('./lib/md-lint.js');

const APPLY = process.argv.includes('--apply');
const SHOW = Number((process.argv.find(a => a.startsWith('--show=')) || '--show=3').split('=')[1]);
const DIR = path.resolve(path.join(__dirname, '..'), (process.argv.find(a => a.startsWith('--dir=')) || '--dir=content').split('=')[1]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md') && e.name !== '_index.md') out.push(p);
  }
  return out;
}

// Teks yang terlihat pembaca, tanpa simbol Markdown, escape, bullet aneh, tanda baca akhir heading, dan spasi.
function visibleText(s) {
  return s
    .replace(/[-​-‍﻿]/g, '')
    .replace(/\\/g, '')
    .replace(/[#*_\-•●▪◦‣▫■□✓✔➤➢►:;,.]/g, '')
    .replace(/\s+/g, '');
}
function rawLines(s) {
  return s.split('\n').filter(l => /^\s*(<|\{\{|\|)/.test(l)).map(l => l.trim()).join('\n');
}

function main() {
  const files = walk(DIR);
  console.log(`\n🧹 Rapikan struktur Markdown — ${APPLY ? 'APPLY' : 'PRATINJAU (tanpa menulis)'}  | ${files.length} file di ${path.relative(process.cwd(), DIR) || '.'}`);
  const stat = {};
  let changed = 0, written = 0, shown = 0;
  const skipped = [];

  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8');
    const r = MdLint.fixMarkdownFile(before);
    if (r.text === before) continue;
    changed++;

    const { body: b0 } = MdLint.splitFrontmatter(before);
    const { body: b1 } = MdLint.splitFrontmatter(r.text);
    if (visibleText(b0) !== visibleText(b1) || rawLines(b0) !== rawLines(b1)) {
      skipped.push(path.relative(process.cwd(), f));
      continue;
    }
    r.fixes.forEach(x => { stat[x] = (stat[x] || 0) + 1; });

    if (shown < SHOW) {
      shown++;
      console.log(`\n── ${path.relative(process.cwd(), f)}  [${r.fixes.join('; ')}]`);
      const a = b0.split('\n'), b = b1.split('\n');
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      console.log('   sebelum: ' + JSON.stringify(a.slice(Math.max(0, i - 1), i + 3).join('\n').slice(0, 260)));
      console.log('   sesudah: ' + JSON.stringify(b.slice(Math.max(0, i - 1), i + 4).join('\n').slice(0, 260)));
    }
    if (APPLY) { fs.writeFileSync(f, r.text); written++; }
  }

  console.log(`\n📊 ${changed} file perlu dirapikan, ${changed - skipped.length} lolos pengaman${APPLY ? `, ${written} ditulis` : ''}, ${skipped.length} dilewati.`);
  Object.entries(stat).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
  if (skipped.length) {
    console.log(`\n⚠️  ${skipped.length} file TIDAK diubah karena teks/HTML-nya akan ikut berubah (cek manual bila perlu):`);
    skipped.slice(0, 30).forEach(s => console.log('   - ' + s));
    if (skipped.length > 30) console.log(`   ... +${skipped.length - 30} lagi`);
  }
  if (!APPLY) console.log('\nℹ️  Pratinjau saja. Jalankan dengan --apply untuk menulis.');
}

main();
