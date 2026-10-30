#!/usr/bin/env node
/**
 * tools/fix-blog-titles.js  — SEKALI PAKAI
 *
 * Menulis ulang judul artikel blog yang kaku / tidak nyambung dengan keyword-nya, memakai aturan judul terbaru
 * (lib/title-style.js + prompts/title-styles.json, adaptasi metode CDI). Slug/URL TIDAK berubah, hanya judul.
 *
 * Artikel dianggap bermasalah bila judulnya: memakai pemisah (: | - – —), frasa klise ("Update Terbaru", "Tips ...",
 * "Pilihan Tepat", "Kisaran Harganya", ...), menambah wilayah yang tidak ada di keyword (mis. "Jabodetabek" pada
 * keyword "terdekat"), memuat tahun, atau keyword-nya tidak utuh. Artikel yang judulnya sudah baik TIDAK disentuh.
 * Yang diperbarui bersama judul: baris `title:`, kalimat pembuka tebal di badan artikel (**Judul** - Halo Mitra ...),
 * dan teks alternatif gambar yang sama persis dengan judul lama. `lastmod` ikut diperbarui.
 *
 *   node tools/fix-blog-titles.js                       → pratinjau: daftar judul bermasalah + alasan (tanpa AI)
 *   node tools/fix-blog-titles.js --apply               → tulis judul baru (butuh CLOUDFLARE_ACCOUNT_ID/_API_TOKEN)
 *   node tools/fix-blog-titles.js --apply --limit=30    → batasi jumlah per run (default semua)
 *   node tools/fix-blog-titles.js --dir=content/blog    → folder lain (default content/blog)
 *
 * Setelah dipakai dan hasilnya di-commit, script ini dan workflow-nya boleh dihapus
 * (lib/title-style.js dan prompts/title-styles.json JANGAN dihapus: dipakai generate-articles.js).
 */
const fs = require('fs');
const path = require('path');
const TS = require('./lib/title-style.js');
const AI = require('./lib/cf-chat.js');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const LIMIT = Number((ARGS.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const DIR = path.resolve(path.join(__dirname, '..'), (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content/blog').split('=')[1]);
const YEAR = new Date().getFullYear();

function fm(raw) {
  const m = raw.match(/^---(\r?\n[\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { matter: m[1], body: m[2], head: raw.slice(0, raw.length - m[2].length) } : null;
}
const getField = (matter, k) => { const m = matter.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm')); return m ? m[1].replace(/\\"/g, '"') : ''; };
const yamlEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function newTitle(keyword, oldTitle, body) {
  const excerpt = body.replace(/\*\*/g, '').replace(/\{\{[^}]*\}\}|!\[[^\]]*\]\([^)]*\)/g, '').trim().slice(0, 700);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const style = TS.pickTitleStyle(keyword, attempt);
    const out = await AI.chat([
      { role: 'system', content: 'Kamu editor judul untuk toko bahan bangunan. Keluarkan HANYA satu judul, tanpa tanda kutip, tanpa penjelasan.' },
      { role: 'user', content: `${TS.buildTitleRules(keyword, style, YEAR)}\n\nJudul lama (jelek, jangan ditiru): ${oldTitle}\n\nAwal artikel (konteks isi):\n${excerpt}\n\nTulis HANYA judul barunya.` },
    ], { temperature: 0.85, max_tokens: 80 });
    const cand = TS.fixTitle(out.split('\n').find(l => l.trim()) || '', keyword).title;
    if (!TS.titleIssues(cand, keyword).length && cand !== oldTitle) return { title: cand, style: style.name };
  }
  return null;
}

async function main() {
  console.log(`\n📰 Perbaiki judul blog — ${APPLY ? 'APPLY' : 'PRATINJAU (tanpa AI, tanpa menulis)'}  | ${path.relative(process.cwd(), DIR)}`);
  if (APPLY && !AI.available()) { console.error('❌ CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN tidak ada.'); process.exit(1); }
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md') && f !== '_index.md').sort();
  const flagged = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    const p = fm(raw); if (!p) continue;
    const title = getField(p.matter, 'title'), keyword = getField(p.matter, 'keywords');
    if (!title || !keyword) continue;
    const issues = TS.titleIssues(title, keyword);
    if (issues.length) flagged.push({ f, raw, p, title, keyword, issues });
  }
  console.log(`   ${flagged.length} dari ${files.length} judul bermasalah.\n`);
  if (!APPLY) {
    flagged.slice(0, 40).forEach(x => console.log(`   • [${x.keyword}] ${x.title}\n       ↳ ${x.issues.join('; ')}`));
    if (flagged.length > 40) console.log(`   ... +${flagged.length - 40} lagi`);
    console.log('\nℹ️  Pratinjau saja. Jalankan dengan --apply untuk menulis judul baru.');
    return;
  }
  let done = 0, skipped = 0;
  for (const x of flagged.slice(0, LIMIT)) {
    try {
      const r = await newTitle(x.keyword, x.title, x.p.body);
      if (!r) { skipped++; console.log(`   ⏭️  ${x.f}: tidak ada judul baru yang lolos aturan — dibiarkan`); continue; }
      let matter = x.p.matter.replace(/^title:.*$/m, `title: "${yamlEscape(r.title)}"`);
      const today = new Date().toISOString().split('T')[0];
      matter = /^lastmod:/m.test(matter) ? matter.replace(/^lastmod:.*$/m, `lastmod: "${today}"`) : matter.replace(/^(date:.*)$/m, `$1\nlastmod: "${today}"`);
      let body = x.p.body;
      body = body.replace(new RegExp(`^(\\s*)\\*\\*${esc(x.title)}\\*\\*`), (m, sp) => `${sp}**${r.title}**`);
      body = body.split(`![${x.title}](`).join(`![${r.title}](`);
      fs.writeFileSync(path.join(DIR, x.f), `---${matter}\n---\n${body}`);
      done++;
      console.log(`   ✅ ${x.f}\n       ${x.title}\n    →  ${r.title}  (${r.style})`);
      await new Promise(r2 => setTimeout(r2, 800));
    } catch (err) {
      skipped++; console.log(`   ❌ ${x.f}: ${err.message}`);
      if (/rate limit|auth/.test(err.message)) { console.log('   🛑 Berhenti (kuota/auth). Jalankan lagi nanti; yang sudah diperbaiki tidak diulang.'); break; }
    }
  }
  console.log(`\n📊 ${done} judul diperbarui, ${skipped} dilewati, ${Math.max(0, flagged.length - done - skipped)} belum diproses.`);
}

main().catch(e => { console.error(e); process.exit(1); });
