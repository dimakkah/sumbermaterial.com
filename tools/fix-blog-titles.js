#!/usr/bin/env node
/**
 * tools/fix-blog-titles.js  — SEKALI PAKAI (tanpa AI, tanpa secret)
 *
 * Mengganti judul artikel blog dengan judul buatan script (lib/title-style.js buildTitle): dirangkai dari keyword + templat
 * yang jelas dan tidak ambigu, Title Case konsisten. Menggantikan judul AI yang ambigu / huruf kapitalnya tidak konsisten
 * (mis. "Pilih Besi Rumah Sesuai Proyek harga besi rumah per batang"). Slug/URL TIDAK berubah, hanya judul.
 * Yang diperbarui bersama judul: baris `title:`, kalimat pembuka tebal di badan artikel (**Judul** - Halo Mitra ...),
 * dan teks alternatif gambar yang sama persis dengan judul lama; `lastmod` ikut diperbarui.
 * Judul yang sudah sama dengan hasil script dilewati (aman dijalankan berulang).
 *
 *   node tools/fix-blog-titles.js                       → pratinjau: judul lama -> baru (tidak menulis)
 *   node tools/fix-blog-titles.js --apply               → tulis perubahan
 *   node tools/fix-blog-titles.js --show=40             → tampilkan 40 contoh di pratinjau (default 30)
 *   node tools/fix-blog-titles.js --dir=content/blog    → folder lain (default content/blog)
 *
 * Setelah dipakai dan hasilnya di-commit, script ini dan workflow-nya boleh dihapus
 * (lib/title-style.js JANGAN dihapus: dipakai generate-articles.js).
 */
const fs = require('fs');
const path = require('path');
const TS = require('./lib/title-style.js');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const SHOW = Number((ARGS.find(a => a.startsWith('--show=')) || '--show=30').split('=')[1]);
const DIR = path.resolve(path.join(__dirname, '..'), (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content/blog').split('=')[1]);

function fm(raw) {
  const m = raw.match(/^---(\r?\n[\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { matter: m[1], body: m[2], head: raw.slice(0, raw.length - m[2].length) } : null;
}
const getField = (matter, k) => { const m = matter.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm')); return m ? m[1].replace(/\\"/g, '"') : ''; };
const yamlEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function main() {
  console.log(`\n📰 Judul blog oleh script — ${APPLY ? 'APPLY' : 'PRATINJAU (tanpa menulis)'}  | ${path.relative(process.cwd(), DIR)}`);
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md') && f !== '_index.md').sort();
  const todo = [];
  const usage = TS.templateUsage([]);   // dihitung dari nol, urut nama file: hasil sama setiap dijalankan (idempoten) dan templat merata
  let same = 0, noKw = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    const p = fm(raw); if (!p) continue;
    const title = getField(p.matter, 'title'), keyword = getField(p.matter, 'keywords');
    if (!title) continue;
    if (!keyword) { noKw++; continue; }
    const next = TS.buildTitle(keyword, usage);
    if (next === title) { same++; continue; }
    todo.push({ f, p, title, next, keyword });
  }
  console.log(`   ${todo.length} judul akan diganti, ${same} sudah sesuai${noKw ? `, ${noKw} tanpa keyword (dilewati)` : ''}.\n`);
  const today = new Date().toISOString().split('T')[0];
  todo.forEach((x, i) => {
    if (!APPLY && i < SHOW) console.log(`   • ${x.title}\n  →   ${x.next}`);
    if (!APPLY) return;
    let matter = x.p.matter.replace(/^title:.*$/m, `title: "${yamlEscape(x.next)}"`);
    matter = /^lastmod:/m.test(matter) ? matter.replace(/^lastmod:.*$/m, `lastmod: "${today}"`) : matter.replace(/^(date:.*)$/m, `$1\nlastmod: "${today}"`);
    let body = x.p.body.replace(/^(\s*)\*\*[^*\n]+\*\*/, (m, sp) => `${sp}**${x.next}**`);   // kalimat pembuka tebal = judul baru (apa pun isi lamanya)
    body = body.split(`![${x.title}](`).join(`![${x.next}](`);
    fs.writeFileSync(path.join(DIR, x.f), `---${matter}\n---\n${body}`);
  });
  if (!APPLY && todo.length > SHOW) console.log(`   ... +${todo.length - SHOW} lagi`);
  console.log(APPLY ? `\n✅ ${todo.length} judul diperbarui.` : '\nℹ️  Pratinjau saja. Jalankan dengan --apply untuk menulis.');
}

main();
