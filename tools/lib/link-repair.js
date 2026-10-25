/**
 * tools/lib/link-repair.js — perbaikan link/penanda rusak di body artikel, TANPA AI (deterministik).
 *
 * Yang diperbaiki (lihat tools/audit-links.js untuk daftar deteksinya):
 *   marker        [[[PLACEHOLDER_N]]], [[TABEL_MULAI]]...[[TABEL_SELESAI]] yang tidak ter-render → tabel dirender / dibuang
 *   leak-bracket  "[internal link ke halaman kontak]" tanpa link → jadi link WhatsApp resmi (maks. 1) atau dibuang
 *   anchor text   kata "anchor text" yang tertinggal di kalimat
 *   kontak        /kontak, /kontak/, https://www.sumbermaterial.com/kontak (halaman tidak ada) → link WhatsApp resmi
 *   /shop         → /product/
 *   url-anchor    jangkar berupa URL mentah → dibuang
 *   leak          jangkar bocoran instruksi ("internal link ke X", "Link ke artikel terkait: X", "Baca juga ...")
 *                   · tujuan RELEVAN (kota sama & produk sama)  → kalimat jembatan baku (BRIDGE) / jangkar singkat
 *                   · tujuan tidak relevan                      → link + sisa kalimatnya dibuang
 *   beda-kota     link dari artikel lokasi ke artikel lokasi di KOTA lain (mis. Jakarta → Abadijaya Depok)
 *                   · paragraf isinya hanya link → paragraf dibuang
 *                   · kalimat "pengisi" (contoh lain layanan kami / baca juga / dsb.) → kalimat dibuang
 *                   · kalimat isi biasa → link dilepas, teks tetap
 * Link lain TIDAK disentuh. Perubahan hanya terjadi di paragraf yang bermasalah.
 */
'use strict';
const OL = require('./orphan-link.js');
const { LEAK_ANCHOR_RE } = require('./related-articles.js');
const SAFE = require('./safe-table.js');

const OWN_RE = /^https?:\/\/(?:www\.)?sumbermaterial\.(?:com|co\.id)(\/[^?#\s]*)?(?:[?#]\S*)?$/i;
const CONTACT_PATH_RE = /^\/(kontak|contact|hubungi(-kami)?|whatsapp|wa|telepon|telp)\/?$/i;
const REAL_CONTACT_RE = /^https?:\/\/(api\.whatsapp\.com|wa\.me)\//i;
const NATURAL_PREFIX_RE = /^((?:baca|lihat)\s+juga(?:\s+artikel\s+\S+)?(?:\s+tentang)?)\s+(\S.*)$/i;
const FILLER_RE = /(contoh lain|mungkin juga|bermanfaat|baca juga|lihat juga|membaca artikel|artikel (?:ini|kami|terkait|lain)|perbandingan|area tetangga|wilayah sekitar|informasi lebih lanjut|informasi tambahan|selengkapnya|layanan kami|portofolio|referensi)/i;
const LINK_RE_G = () => /(?<![!\[])\[(?!\[)([^\]\n]*)\]\(([^)\n]*)\)/g;
const DASH_TAIL_RE = /^\s*(?:[—–]|-\s)\s*/;
const CONTACT_ANCHOR = 'Chat WhatsApp';

const titleHead = t => String(t || '').split(/\s*[:|–—]\s+/)[0];

function makeCtx(pages, contactUrl) {
  const slugMap = new Map();
  for (const url of pages.keys()) {
    const slug = url.replace(/\/$/, '').split('/').pop();
    if (!slugMap.has(slug)) slugMap.set(slug, []);
    slugMap.get(slug).push(url);
  }
  return { pages, slugMap, contactUrl, desc: new Map() };
}
function describe(ctx, url) {
  if (!ctx.desc.has(url)) ctx.desc.set(url, OL.describe(ctx.pages.get(url).title));
  return ctx.desc.get(url);
}
function resolveUrl(ctx, p) {
  if (!p) return null;
  const u = p.endsWith('/') ? p : p + '/';
  if (ctx.pages.has(u)) return u;
  const slugs = ctx.slugMap.get(u.replace(/\/$/, '').split('/').pop());
  return slugs && slugs.length === 1 ? slugs[0] : null;
}
// Hubungan relevansi sumber → tujuan. 'loc' = halaman lokasi (null bila tidak relevan); 'topic' = non-lokasi.
function relevance(ctx, srcUrl, dstUrl) {
  const a = describe(ctx, srcUrl), b = describe(ctx, dstUrl);
  if (a.hasLoc && b.hasLoc) {
    const rel = OL.relation(b, a) || OL.relation(a, b);
    return { ok: !!rel, type: rel && rel.type, crossCity: a.cityKey !== b.cityKey, loc: true };
  }
  const sim = OL.weightedJaccard(a.topic, b.topic);
  return { ok: sim >= 0.12, type: null, crossCity: false, loc: false };
}

// ───────────────────────── util teks
function sentenceBounds(p, start, end) {
  const before = p.slice(0, start);
  const ms = [...before.matchAll(/[.!?]["')]*\s+/g)].pop();
  let s = ms ? ms.index + ms[0].length : 0;
  s = Math.max(s, before.lastIndexOf('\n') + 1);
  const after = p.slice(end);
  const me = after.match(/[.!?]["')]*(?=\s|$)|\n/);
  const e = me ? end + me.index + (me[0] === '\n' ? 0 : me[0].length) : p.length;
  return [s, e];
}
function cut(p, s, e) {
  let out = p.slice(0, s) + p.slice(e);
  if (s > 0 && /[ \t]/.test(out[s - 1]) && (s >= out.length || /[ \t\n]/.test(out[s]))) out = out.slice(0, s - 1) + out.slice(s);
  else if (s === 0) out = out.replace(/^[ \t]+/, '');
  return out;
}
const isEmpty = p => !p.replace(/[\s—–\-.,!?;:*]+/g, '');
function tailEnd(p, end) {                     // sisa kalimat yang menggantung setelah link bocoran
  const rest = p.slice(end);
  const dash = rest.match(DASH_TAIL_RE);
  const first = rest.replace(DASH_TAIL_RE, '').match(/^\s*(\S)/);
  if (!dash && !(first && /[a-z]/.test(first[1]))) return end;
  const base = dash ? dash[0].length : 0;
  const m = rest.slice(base).match(/^[^.!?\n]*[.!?]?/);
  return end + base + (m ? m[0].length : 0);
}

// ───────────────────────── perbaikan satu paragraf
function repairParagraph(p, srcUrl, ctx, st) {
  let out = p;

  // 1. penanda sisa
  if (/\[\[\[PLACEHOLDER_[^\]]*\]\]\]/.test(out)) {
    const re = /\[\[\[PLACEHOLDER_[^\]]*\]\]\](?:[ \t]*\([^)\n]*\))?/;
    const m = out.match(re);
    if (out.replace(re, '').trim() === '' || isEmpty(out.replace(re, ''))) { st.marker++; return ''; }
    const [s, e] = sentenceBounds(out, m.index, m.index + m[0].length);
    const pre = out.slice(s, m.index).trim(), post = out.slice(m.index + m[0].length, e).trim();
    const hasLinks = LINK_RE_G().test(out.slice(s, e));
    // penanda berdiri sendiri (di awal/akhir kalimat) → buang penandanya saja; penanda di TENGAH kalimat ("cek [..] untuk melihat ...")
    // membuat kalimat itu tak bermakna → seluruh kalimat dibuang (kecuali berisi link lain).
    if (!pre || !post.replace(/[.!?]+$/, '') || hasLinks) out = cut(out, m.index, m.index + m[0].length);
    else out = cut(out, s, e);
    st.marker++;
  }
  if (/\[\[TABEL_(?:MULAI|SELESAI)\]\]/.test(out)) {
    let r = SAFE.renderSafeTables(out);
    if (SAFE.hasLeftoverTableMarkers(r)) r = r.replace(/\[\[TABEL_MULAI\]\][\s\S]*?\[\[TABEL_SELESAI\]\]/g, '').replace(/\[\[TABEL_(?:MULAI|SELESAI)\]\]/g, '');
    out = r; st.marker++;
  }

  // 2. kata "anchor text" yang tertinggal
  out = out.replace(/([ \t]?)\banchor text\b\s*(?:([—–])\s*([^.!?\n]*[.!?]?))?/gi, () => { st.anchorText++; return ''; });

  // 3. kurung siku bocoran tanpa link
  out = out.replace(/([ \t]?)\[((?:internal\s*link|link\s+ke|anchor\s*text)[^\]\n]*)\](?!\()/gi, (m, sp, inner) => {
    st.bracket++;
    if (/kontak/i.test(inner) && ctx.contactUrl && st.contactBudget > 0) { st.contactBudget--; return `${sp}[${CONTACT_ANCHOR}](${ctx.contactUrl})`; }
    return '';
  });

  // 4. link
  const links = [...out.matchAll(LINK_RE_G())].map(m => ({ s: m.index, e: m.index + m[0].length, anchor: m[1].trim(), raw: (m[2].trim().split(/\s+/)[0] || ''), full: m[0] }));
  for (const L of links.reverse()) {
    const own = L.raw.match(OWN_RE);
    const pth = own ? (own[1] || '/') : (L.raw.startsWith('/') ? L.raw : null);
    const clean = pth && pth.split(/[?#]/)[0];
    const isUrlAnchor = /^https?:\/\/\S+$/i.test(L.anchor);
    const leak = LEAK_ANCHOR_RE.test(L.anchor);

    // kontak (halaman tidak ada)
    if (clean && CONTACT_PATH_RE.test(clean)) {
      const anchorOk = L.anchor && !isUrlAnchor && !leak;
      if (ctx.contactUrl && st.contactBudget > 0 && anchorOk) { st.contactBudget--; out = out.slice(0, L.s) + `[${L.anchor}](${ctx.contactUrl})` + out.slice(L.e); st.contact++; }
      else { out = out.slice(0, L.s) + (anchorOk ? L.anchor : '') + out.slice(L.e); st.contact++; }
      continue;
    }
    if (clean && /^\/shop\/?$/i.test(clean)) { out = out.slice(0, L.s) + `[${L.anchor}](/product/)` + out.slice(L.e); st.shop++; continue; }

    const dst = resolveUrl(ctx, clean);
    const dstPage = dst && ctx.pages.get(dst);

    // jangkar berupa URL mentah
    if (isUrlAnchor) {
      let end = L.e; const d = out.slice(end).match(DASH_TAIL_RE); if (d) end += d[0].length;
      out = cut(out, L.s, end); st.urlAnchor++; continue;
    }

    // bocoran instruksi di jangkar
    if (leak) {
      const rel = dst && dst !== srcUrl ? relevance(ctx, srcUrl, dst) : null;
      const natural = L.anchor.match(NATURAL_PREFIX_RE);
      if (rel && rel.ok && rel.loc && rel.type) {                       // lokasi: kalimat jembatan baku
        const bridge = OL.buildBridge({ title: dstPage.title, url: dst }, { type: rel.type }).paragraph;
        const e = tailEnd(out, L.e);
        out = out.slice(0, L.s) + bridge + out.slice(e); st.leakBridge++;
      } else if (rel && rel.ok && !rel.loc && natural) {                // non-lokasi, awalan alami ("Baca juga artikel kami tentang")
        out = out.slice(0, L.s) + `${natural[1]} [${OL.anchorFromTitle(titleHead(dstPage.title))}](${dst})` + out.slice(L.e); st.leakShort++;
      } else {                                                          // tidak relevan / tak ada tujuan: buang link + sisa kalimat
        const e = tailEnd(out, L.e);
        out = cut(out, L.s, e); st.leakDrop++;
      }
      continue;
    }

    // domain salah (.co.id) pada link yang tujuannya ada → jadikan path relatif
    if (own && /sumbermaterial\.co\.id/i.test(L.raw) && dst) { out = out.slice(0, L.s) + `[${L.anchor}](${dst})` + out.slice(L.e); st.domain++; continue; }

    // artikel lokasi → artikel lokasi di kota lain
    if (dst && dst !== srcUrl) {
      const rel = relevance(ctx, srcUrl, dst);
      if (rel.loc && rel.crossCity) {
        const [s, e] = sentenceBounds(out, L.s, L.e);
        const sentence = out.slice(s, e);
        const others = [...sentence.matchAll(LINK_RE_G())].filter(m => s + m.index !== L.s);
        const remainder = sentence.replace(LINK_RE_G(), '').trim();
        const words = remainder.split(/\s+/).filter(Boolean).length;
        const prefixWords = sentence.slice(0, L.s - s).split(/\s+/).filter(Boolean).length;
        let dashEnd = L.e; const dm = out.slice(dashEnd).match(DASH_TAIL_RE); if (dm) dashEnd += dm[0].length;
        if (prefixWords >= 3) { out = out.slice(0, L.s) + L.anchor + out.slice(L.e); st.crossUnwrap++; }      // frasa di dalam kalimat: lepas link, teks tetap
        else if (others.length) { out = cut(out, L.s, dashEnd); st.crossDrop++; }                            // ada link lain di kalimat itu: buang markup ini saja
        else if (words <= 2 || (FILLER_RE.test(remainder) && words <= 16)) { out = cut(out, s, e); st.crossDrop++; }   // kalimat pengisi: buang seluruh kalimat
        else { out = cut(out, L.s, dashEnd); st.crossDrop++; }                                               // link berdiri sendiri di awal kalimat: buang markup-nya
        continue;
      }
    }
  }
  out = out.replace(/\[[A-Z][A-Z \t]{5,}\](?!\()[ \t]*/g, '').replace(/[ \t]*\(\s*\)/g, '').replace(/[ \t]*\[\s*\]/g, '');
  if (!/[ \t]$/.test(p)) out = out.replace(/[ \t]+$/, '');          // jangan menambah spasi di ujung paragraf
  return isEmpty(out) ? '' : out;
}

// ───────────────────────── perbaikan seluruh body
// Dijalankan sampai stabil (maks. 3 putaran): satu perbaikan (mis. domain .co.id) bisa membuka perbaikan lain pada link yang sama.
function repairBody(body, srcUrl, ctx) {
  let text = body, changed = false;
  const total = {};
  for (let i = 0; i < 3; i++) {
    const r = repairOnce(text, srcUrl, ctx);
    for (const [k, v] of Object.entries(r.stats)) total[k] = (total[k] || 0) + v;
    if (!r.changed) break;
    changed = true; text = r.text;
  }
  return { text, changed: text !== body, stats: total };
}

function repairOnce(body, srcUrl, ctx) {
  const st = { marker: 0, anchorText: 0, bracket: 0, contact: 0, shop: 0, urlAnchor: 0, leakBridge: 0, leakShort: 0, leakDrop: 0, domain: 0, crossDrop: 0, crossUnwrap: 0 };
  const have = [...(body || '').matchAll(/(?<![!\[])\[[^\]\n]*\]\(([^)\s]+)\)/g)].filter(m => REAL_CONTACT_RE.test(m[1])).length;
  st.contactBudget = have ? 0 : 1;
  const parts = (body || '').split(/(\n[ \t]*\n+)/);                     // genap = paragraf, ganjil = pemisah
  const P = [], S = [];
  for (let i = 0; i < parts.length; i += 2) { P.push(parts[i]); S.push(i + 1 < parts.length ? parts[i + 1] : ''); }
  const keep = P.map(() => true);
  for (let k = 0; k < P.length; k++) {
    if (!/\[\[|anchor text|\]\(|\[(?:internal|link\s+ke|anchor)/i.test(P[k])) continue;
    const fixed = repairParagraph(P[k], srcUrl, ctx, st);
    if (fixed === '' && P[k] !== '') keep[k] = false; else P[k] = fixed;
  }
  const idx = P.map((_, k) => k).filter(k => keep[k]);
  let text = '';
  idx.forEach((k, n) => { text += P[k] + (n === idx.length - 1 ? S[P.length - 1] : S[k]); });
  if (/\n$/.test(body || '') && !/\n$/.test(text)) text += '\n';
  const changed = text !== body;
  delete st.contactBudget;
  return { text, changed, stats: st };
}

module.exports = { makeCtx, repairBody, relevance, CONTACT_ANCHOR };
