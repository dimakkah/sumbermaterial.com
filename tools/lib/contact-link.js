/**
 * tools/lib/contact-link.js — link KONTAK ditulis oleh SCRIPT, bukan AI.
 *
 * Masalah: AI kadang menulis placeholder seperti [Hubungi Kami](/[URL_KONTAK]) atau
 * (/[kode-tombol-telepon-atau-whatsapp]). Solusi (sama seperti link internal [[LINK:N|...]]):
 *   1. AI hanya boleh memakai TOKEN  [[KONTAK|teks ajakan]]  — tidak pernah menulis URL.
 *   2. applyContactLinks() mengubah token itu menjadi link ke URL kontak RESMI situs
 *      (diambil dari hugo.toml → params.whatsapp; bisa ditimpa env CONTACT_URL).
 *   3. Link rusak/placeholder dengan teks ajakan menghubungi DIPERBAIKI ke URL resmi itu;
 *      link rusak lain dijadikan teks biasa. Link yang sudah benar tidak disentuh.
 *   4. contactIssues() = penjaga akhir: file yang masih memuat placeholder/token sisa ditolak.
 * Maksimal MAX_CONTACT_LINKS (default 1) link kontak yang DIBUAT script per artikel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { isValidLinkTarget } = require('./related-articles.js');

const ROOT = path.join(__dirname, '..', '..');
const MAX_CONTACT_LINKS = 1;

// Alamat link Markdown TIDAK boleh berisi spasi atau tanda kurung: parser berhenti di spasi pertama dan sisanya tampil sebagai teks
// (mis. text=*Halo sumbermaterial.com*). hugo.toml menyimpan URL WhatsApp dengan spasi karena dipakai di atribut HTML, jadi
// untuk Markdown harus di-encode dulu.
const safeUrl = u => String(u).trim().replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
const BROKEN_WA_RE = /(\]\()(https?:\/\/(?:api\.whatsapp\.com|wa\.me)\/[^)\n]*?\s[^)\n]*)(\))/g;   // link WhatsApp yang sudah terlanjur memuat spasi

function readContactUrl() {
  if (process.env.CONTACT_URL && process.env.CONTACT_URL.trim()) return safeUrl(process.env.CONTACT_URL);
  for (const f of ['hugo.toml', 'config.toml']) {
    try {
      const m = fs.readFileSync(path.join(ROOT, f), 'utf8').match(/^\s*whatsapp\s*=\s*"([^"]+)"/m);
      if (m) return safeUrl(m[1].startsWith('//') ? 'https:' + m[1] : m[1]);
    } catch { /* coba file berikutnya */ }
  }
  return null;
}
const CONTACT_URL = readContactUrl();

const CONTACT_ANCHOR_RE = /\b(hubungi|kontak|whatsapp|telepon|telp|chat|konsultasi|konsultasikan|tanya|pesan|order|wa)\b/i;
const CONTACT_PATH_RE = /^\/(kontak|contact|hubungi(-kami)?|whatsapp|wa|telepon|telp)\/?$/i;   // halaman yang memang tidak ada di situs
const REAL_CONTACT_RE = /^https?:\/\/(api\.whatsapp\.com|wa\.me)\//i;
const COMBINED_RE = /\[\[KONTAK\|([^\]\n]+?)\]\]|(?<!!)\[([^\]]+)\]\(([^)]*)\)/g;

function applyContactLinks(text, max = MAX_CONTACT_LINKS, url = CONTACT_URL) {
  url = url ? safeUrl(url) : url;
  let waFixed = 0;
  const src = (text || '').replace(BROKEN_WA_RE, (m, a, u, c) => { waFixed++; return a + safeUrl(u) + c; });
  let have = 0;
  for (const m of src.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)\)/g)) if (REAL_CONTACT_RE.test(m[1])) have++;
  let created = 0, repaired = 0, demoted = 0;
  const link = anchor => {
    if (url && have + created < max) { created++; return `[${anchor.trim()}](${url})`; }
    return null;
  };
  const out = src.replace(COMBINED_RE, (match, tokAnchor, anchor, target) => {
    if (tokAnchor !== undefined) {                                   // token resmi dari AI
      const l = link(tokAnchor);
      if (l) return l;
      demoted++; return tokAnchor.trim();
    }
    const t = (target || '').trim().split(/\s+/)[0] || '';
    if (isValidLinkTarget(t) && !CONTACT_PATH_RE.test(t)) return match;   // link normal/benar: JANGAN disentuh
    if (CONTACT_ANCHOR_RE.test(anchor) && anchor.trim().split(/\s+/).length <= 8) {
      const l = link(anchor);
      if (l) { repaired++; return l; }
    }
    demoted++; return anchor;                                        // placeholder tanpa pengganti → teks biasa
  });
  return { text: out, created: created - repaired, repaired: repaired + waFixed, demoted };
}

// Penjaga akhir: placeholder / token sisa yang tidak boleh sampai ke file.
function contactIssues(body) {
  const issues = [];
  const b = body || '';
  if (/\[\[KONTAK\|/.test(b)) issues.push('token [[KONTAK|...]] belum diubah menjadi link');
  if (new RegExp(BROKEN_WA_RE.source).test(b)) issues.push('link WhatsApp memuat spasi (tidak akan terbaca sebagai link)');
  const bad = [...b.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]*)\)/g)].filter(m => {
    const t = m[2].trim().split(/\s+/)[0] || '';
    return !isValidLinkTarget(t) || CONTACT_PATH_RE.test(t);
  });
  if (bad.length) issues.push(`link placeholder/rusak: ${bad.slice(0, 3).map(m => `[${m[1]}](${m[2]})`).join(', ')}`);
  return issues;
}

module.exports = { CONTACT_URL, MAX_CONTACT_LINKS, applyContactLinks, contactIssues };
