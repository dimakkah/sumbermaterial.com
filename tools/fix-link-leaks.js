/**
 * tools/fix-link-leaks.js — perbaiki link/penanda rusak di content/ (tanpa AI). Detailnya: lib/link-repair.js.
 *   node tools/fix-link-leaks.js                 → laporan saja
 *   node tools/fix-link-leaks.js --apply         → tulis perubahan
 *   node tools/fix-link-leaks.js --file=beji     → batasi ke file yang namanya memuat teks itu
 *   node tools/fix-link-leaks.js --show=10       → tampilkan 10 contoh sebelum/sesudah
 * Setelah --apply, jalankan: node tools/audit-links.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LR = require('./lib/link-repair.js');
const { CONTACT_URL } = require('./lib/contact-link.js');

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const FILTER = (ARGV.find(a => a.startsWith('--file=')) || '').slice(7);
const SHOW = parseInt((ARGV.find(a => a.startsWith('--show=')) || '--show=3').slice(7), 10);
const ROOT = path.join(__dirname, '..'), CONTENT = path.join(ROOT, 'content');

function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) yield* walk(f); else if (e.name.endsWith('.md')) yield f; } }
const toUrl = f => { const r = '/' + path.relative(CONTENT, f).replace(/\\/g, '/').replace(/\.md$/, '').replace(/\/_index$/, ''); return r === '/_index' ? '/' : r + '/'; };
const split = raw => { const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/); return m ? { head: m[0], body: raw.slice(m[0].length) } : { head: '', body: raw }; };
const titleOf = head => { const m = head.match(/^title:\s*"?(.*?)"?\s*$/m); return m ? m[1] : ''; };

const files = [...walk(CONTENT)], pages = new Map(), raws = new Map();
for (const f of files) { const raw = fs.readFileSync(f, 'utf8'); raws.set(f, raw); pages.set(toUrl(f), { file: f, title: titleOf(split(raw).head) }); }
const ctx = LR.makeCtx(pages, CONTACT_URL);

const total = {}; let changed = 0, shown = 0;
for (const f of files) {
  if (FILTER && !f.includes(FILTER)) continue;
  const raw = raws.get(f);
  if (!/\[\[|anchor text|\]\(|\[(?:internal|link\s+ke|anchor)/i.test(raw)) continue;
  const { head, body } = split(raw);
  const r = LR.repairBody(body, toUrl(f), ctx);
  if (!r.changed) continue;
  changed++;
  for (const [k, v] of Object.entries(r.stats)) total[k] = (total[k] || 0) + v;
  if (shown < SHOW) {
    shown++;
    const a = body.split('\n'), b = r.text.split('\n');
    console.log(`\n── ${path.relative(ROOT, f).replace('content/', '')}`);
    const bs = new Set(b), as = new Set(a);
    const gone = a.filter(l => !bs.has(l)), added = b.filter(l => !as.has(l));
    const short = (o, n) => { let i = 0; while (i < o.length && i < n.length && o[i] === n[i]) i++; let j = 0; while (j < o.length - i && j < n.length - i && o[o.length - 1 - j] === n[n.length - 1 - j]) j++; const ctx = x => x.slice(Math.max(0, i - 40), x.length - j + 25); return [ctx(o).slice(0, 230), ctx(n).slice(0, 230)]; };
    gone.forEach((o, k) => { const n = added[k]; if (n === undefined) console.log('  ✂ ' + o.slice(0, 200)); else { const [x, y] = short(o, n); console.log('  - …' + x + '\n  + …' + y); } });
  }
  if (APPLY) fs.writeFileSync(f, head + r.text);
}
console.log(`\n${APPLY ? '✏️  Diperbaiki' : '🔎 Perlu diperbaiki'}: ${changed} file`);
console.log(Object.entries(total).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('  '));
if (!APPLY) console.log('Jalankan dengan --apply untuk menulis perubahan.');
