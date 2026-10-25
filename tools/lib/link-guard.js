/**
 * tools/lib/link-guard.js — pencegahan: link TIDAK RELEVAN & sisa penanda/instruksi tidak boleh masuk artikel baru.
 *   relevantCandidates()  menyaring daftar "artikel terkait" yang ditawarkan ke AI:
 *                           · artikel lokasi hanya boleh menaut ke artikel lokasi lain di KOTA SAMA & produk SAMA
 *                             (atau ke artikel non-lokasi yang topiknya sama);
 *                           · artikel non-lokasi tidak ditawari halaman kelurahan acak;
 *                           · urutan seri (alfabet nama file: Abadijaya, Ancol, Angke, Anyar ...) diacak deterministik per artikel,
 *                             supaya bukan halaman yang itu-itu saja yang selalu terpilih.
 *   guardIssues()         penjaga akhir untuk validator: penanda [[[PLACEHOLDER_N]]] / [[TABEL_..]] / [[LINK..]] sisa,
 *                         jangkar bocoran instruksi ("internal link ke ..."), kata "anchor text", domain salah.
 */
'use strict';
const OL = require('./orphan-link.js');
const { LEAK_ANCHOR_RE } = require('./related-articles.js');

function relevantCandidates(sourceText, candidates, max = 6) {
  const a = OL.describe(sourceText);
  const ok = (candidates || []).filter(c => {
    const b = OL.describe(c.title);
    if (a.hasLoc && b.hasLoc) return !!(OL.relation(b, a) || OL.relation(a, b));
    if (!a.hasLoc && b.hasLoc) return false;
    return true;
  });
  if (a.hasLoc) ok.sort((x, y) => OL.hash(sourceText + '|' + x.url) - OL.hash(sourceText + '|' + y.url));
  return ok.slice(0, max);
}

function guardIssues(body) {
  const issues = [];
  const b = body || '';
  const markers = b.match(/\[\[\[PLACEHOLDER_[^\]]*\]\]\]|\[\[(?:TABEL_|LINK:|KONTAK)[^\]]*\]\]/g);
  if (markers) issues.push(`penanda sisa di teks: ${[...new Set(markers)].slice(0, 3).join(', ')}`);
  const leaks = [...b.matchAll(/(?<![!\[])\[([^\]\n]*)\]\(([^)\n]*)\)/g)].filter(m => LEAK_ANCHOR_RE.test(m[1]));
  if (leaks.length) issues.push(`jangkar bocoran instruksi: "${leaks[0][1].slice(0, 60)}"`);
  if (/\[(?:internal\s*link|link\s+ke|anchor\s*text)[^\]\n]*\](?!\()/i.test(b)) issues.push('kurung siku bocoran instruksi (mis. [internal link ke ...])');
  if (/\banchor text\b/i.test(b)) issues.push('kata "anchor text" tertinggal di teks');
  const dom = b.match(/\]\(https?:\/\/(?:www\.)?sumbermaterial\.(?!com\b)[a-z.]+/i);
  if (dom) issues.push(`link ke domain yang salah: ${dom[0].slice(2)}`);
  return issues;
}

module.exports = { relevantCandidates, guardIssues };
