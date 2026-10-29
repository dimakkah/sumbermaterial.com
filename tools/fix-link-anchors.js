#!/usr/bin/env node
/**
 * tools/fix-link-anchors.js  — SEKALI PAKAI
 *
 * Merapikan internal link LAMA di content/ (tanpa AI, tanpa secret):
 *   1. Paragraf pendek (< 40 kata) yang DIAWALI link — biasanya hanya judul artikel lain yang "berdiri sendiri"
 *      di akhir artikel ("[Harga … Di Ancol Jakarta](…)" / "… — Informasi mengenai …") — paragrafnya dibuang.
 *   2. Kalimat penghubung hasil fix-orphans lama yang berdiri sebagai paragraf sendiri ("Selain di sini, Kami juga
 *      melayani [..](..).") — ditempel ke akhir paragraf isi sebelumnya.
 *   3. Anchor yang menyalin judul artikel tujuan / terlalu panjang (>= 7 kata) — diganti frasa pendek buatan script
 *      (lib/link-anchor.js), mis. "Harga Batu Split 1/2 Free Ongkir Ke Babakan Bogor" -> "batu split 1/2 ke Babakan Bogor".
 * Artikel yang kehilangan link masuk akan dilink ulang oleh fix-orphans.yml (aturan baru: anchor pendek, di dalam paragraf).
 *
 *   node tools/fix-link-anchors.js                 → pratinjau (tidak menulis)
 *   node tools/fix-link-anchors.js --apply         → tulis perubahan
 *   node tools/fix-link-anchors.js --show=10       → tampilkan 10 contoh (default 5)
 *
 * Setelah dipakai dan hasilnya di-commit, script ini dan workflow-nya boleh dihapus
 * (lib/link-anchor.js JANGAN dihapus: dipakai generate, revise, dan fix-orphans).
 */
const fs = require('fs');
const path = require('path');
const LA = require('./lib/link-anchor.js');
const OL = require('./lib/orphan-link.js');
const { buildArticleIndex } = require('./lib/related-articles.js');

const APPLY = process.argv.includes('--apply');
const SHOW = Number((process.argv.find(a => a.startsWith('--show=')) || '--show=5').split('=')[1]);
const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');

const LINK = /(?<!!)\[([^\]]+)\]\((\/[^)\s]+)\)/g;
const BRIDGE_STARTS = Object.values(OL.BRIDGE).flat().map(t => t.split('{a}')[0].trim()).filter(Boolean);

const wc = (s) => s.split(/\s+/).filter(Boolean).length;
const isPlain = (p) => { const t = p.trim(); return wc(t) >= 25 && !/^(#|\*|-|\||!\[|\{\{|\[\[|>|\d+\.\s|<|\[[^\]]+\]\()/.test(t) && !/telepon|whatsapp|hubungi|kontak|penawaran/i.test(t.slice(-220)); };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md') && e.name !== '_index.md') out.push(p);
  }
  return out;
}

function fixBody(body, titleOf) {
  const parts = body.split(/(\r?\n[ \t]*\r?\n)/);            // [para, sep, para, sep, ...]
  const acts = { removed: 0, merged: 0, shortened: 0 };
  const drop = new Set();

  for (let i = 0; i < parts.length; i += 2) {
    const p = parts[i];
    const links = [...p.matchAll(LINK)];
    if (!links.length) continue;
    const t = p.trim();

    // 1. paragraf pendek yang diawali link -> buang
    if (new RegExp(LINK.source).exec(t)?.index === 0 && wc(t) < 40 && !/^(#|\*|-|\||\d+\.)/.test(t)) { drop.add(i); acts.removed++; continue; }

    // 2. kalimat penghubung berdiri sendiri -> tempel ke paragraf isi sebelumnya
    if (links.length === 1 && BRIDGE_STARTS.some(s => t.startsWith(s)) && wc(t) < 40) {
      let j = i - 2;
      while (j >= 0 && drop.has(j)) j -= 2;
      if (j >= 0 && isPlain(parts[j])) {
        const trail = parts[j].match(/\s*$/)[0];
        parts[j] = parts[j].slice(0, parts[j].length - trail.length) + ' ' + t + trail;
        drop.add(i); acts.merged++;
        continue;
      }
    }
  }

  // 3. di paragraf yang tersisa:
  //    a. link di baris sendiri (judul artikel lain menempel di akhir paragraf) -> baris dibuang
  //    b. link berjudul-panjang yang membuka kalimat baru ("… terbaik! [Judul](url) mungkin juga bisa jadi referensi.") -> kalimatnya dibuang
  //    c. anchor mirip judul / terlalu panjang di tengah kalimat -> frasa pendek buatan script
  const titleFor = (url) => titleOf.get(url) || titleOf.get(url.endsWith('/') ? url : url + '/');
  for (let i = 0; i < parts.length; i += 2) {
    if (drop.has(i)) continue;
    let p = parts[i];
    const before = p;

    p = p.replace(/(^|\r?\n)[ \t]*\[([^\]]+)\]\((\/[^)\s]+)\)[ \t]*(?=\r?\n|$)/g, (m, nl) => { acts.removed++; return ''; });

    for (let guard = 0; guard < 6; guard++) {
      let hit = null;
      for (const m of p.matchAll(LINK)) {
        const title = titleFor(m[2]);
        if (!title || !LA.isTitleLike(m[1], title) || m[1] === LA.shortAnchor(title)) continue;   // anchor pendek buatan script dibiarkan
        const pre = p.slice(0, m.index).replace(/[ \t]+$/, '');
        if (pre === '' || /[.!?…]$/.test(pre) || /\n$/.test(pre)) { hit = m; break; }
      }
      if (!hit) break;
      const rest = p.slice(hit.index + hit[0].length);
      const endRel = rest.search(/[.!?](?=\s|$)|\n/);
      const cut = endRel === -1 ? rest.length : endRel + (/[.!?]/.test(rest[endRel]) ? 1 : 0);
      p = (p.slice(0, hit.index).replace(/[ \t]+$/, '') + ' ' + rest.slice(cut).replace(/^[ \t]+/, '')).replace(/[ \t]+$/, '');
      acts.removed++;
    }

    p = p.replace(LINK, (m, anchor, url) => {
      const title = titleFor(url);
      if (!title) return m;
      const short = LA.shortAnchor(title);
      if (!short || short === anchor) return m;
      const longer = anchor.split(/\s+/).length > short.split(/\s+/).length;
      if (!(LA.isTitleLike(anchor, title) || (longer && LA.derivedFromTitle(anchor, title)))) return m;
      acts.shortened++;
      return `[${short}](${url})`;
    });

    if (p !== before) parts[i] = p;
    if (!/\S/.test(parts[i])) drop.add(i);                       // paragraf jadi kosong
  }

  // susun ulang tanpa paragraf yang dibuang (beserta separatornya)
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (drop.has(i)) continue;
    if (out.length) out.push(parts[i - 1] !== undefined ? parts[i - 1] : '\n\n');
    out.push(parts[i]);
  }
  let text = out.join('');
  if (drop.size && /\S/.test(body)) text = text.replace(/\s+$/, '') + (body.match(/\s*$/)[0] || '\n');
  return { text, acts };
}

function main() {
  console.log(`\n🔗 Rapikan anchor internal link lama — ${APPLY ? 'APPLY' : 'PRATINJAU (tanpa menulis)'}`);
  const index = buildArticleIndex(CONTENT);
  const titleOf = new Map(index.map(a => [a.url, a.title]));
  const files = walk(CONTENT);
  let changed = 0, shown = 0;
  const tot = { removed: 0, merged: 0, shortened: 0 };
  const touchedTargets = new Set();

  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const m = raw.match(/^---(\r?\n[\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) continue;
    const body = m[2];
    if (!/\]\(\/[^)\s]+\)/.test(body)) continue;
    const { text, acts } = fixBody(body, titleOf);
    if (text === body) continue;
    changed++;
    for (const k of Object.keys(tot)) tot[k] += acts[k];
    if (shown < SHOW) {
      shown++;
      console.log(`\n── ${path.relative(ROOT, f)}  [dibuang ${acts.removed}, digabung ${acts.merged}, anchor dipendekkan ${acts.shortened}]`);
      const a = body.split('\n'), b = text.split('\n');
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      console.log('   sebelum: ' + JSON.stringify(a.slice(i, i + 2).join('\n').slice(0, 240)));
      console.log('   sesudah: ' + JSON.stringify(b.slice(i, i + 2).join('\n').slice(0, 240)));
    }
    if (APPLY) fs.writeFileSync(f, raw.slice(0, raw.length - body.length) + text);
  }

  console.log(`\n📊 ${changed} file ${APPLY ? 'diperbaiki' : 'akan diperbaiki'}: ${tot.removed} paragraf link-sendirian dibuang, ${tot.merged} kalimat penghubung digabung ke paragraf isi, ${tot.shortened} anchor dipendekkan.`);
  if (!APPLY) console.log('ℹ️  Pratinjau saja. Jalankan dengan --apply untuk menulis.');
}

main();
