'use strict';
const assert = require('assert');
const LR = require('./lib/link-repair.js');
const LG = require('./lib/link-guard.js');
const WA = 'https://api.whatsapp.com/send?phone=62812';
const T = (city, kel, prod = 'Harga Pasang Atap Baja Ringan') => `${prod} Di ${kel} ${city}`;
const pages = new Map();
const add = (slugTitle, section = 'baja-ringan') => { const slug = slugTitle.toLowerCase().replace(/ /g, '-'); pages.set(`/${section}/${slug}/`, { title: slugTitle }); return `/${section}/${slug}/`; };
const SRC = add(T('Jakarta', 'Cawang')), SIB = add(T('Jakarta', 'Ancol')), FAR = add(T('Depok', 'Abadijaya')), OTHER = add(T('Jakarta', 'Angke', 'Jual Pasir'), 'pasir');
const ctx = LR.makeCtx(pages, WA);
const run = body => LR.repairBody(body, SRC, ctx);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

t('link kota lain, jangkar = judul, di akhir kalimat pengisi → kalimat dibuang', () => {
  const r = run(`Awal. Hubungi kami! [${T('Depok', 'Abadijaya')}](${FAR}) bisa jadi referensi tambahan untuk Anda.\n\nPenutup.`);
  assert.strictEqual(r.text, 'Awal. Hubungi kami!\n\nPenutup.');
});
t('frasa di tengah kalimat → link dilepas, teks tetap', () => {
  const r = run(`Anda bisa mencari [harga atap di Abadijaya Depok](${FAR}) untuk pembanding.`);
  assert.strictEqual(r.text, 'Anda bisa mencari harga atap di Abadijaya Depok untuk pembanding.');
});
t('link kota SAMA yang benar tidak disentuh', () => {
  const s = `Lihat [${T('Jakarta', 'Ancol')}](${SIB}) ya.`;
  assert.strictEqual(run(s).text, s); assert(!run(s).changed);
});
t('bocoran "internal link ke" + kota sama → kalimat jembatan baku', () => {
  const r = run(`Terima kasih! [internal link ke ${T('Jakarta', 'Ancol')}](${SIB}) untuk perbandingan harga.`);
  assert(/\[pasang atap baja ringan di Ancol Jakarta\]\(\/baja-ringan\/[^)]+\)\.$/.test(r.text), r.text);
  assert(!/internal link|perbandingan/i.test(r.text), r.text);
});
t('bocoran + kota lain → dibuang beserta sisa kalimat', () => {
  const r = run(`Terima kasih! [Link ke artikel terkait: ${T('Depok', 'Abadijaya')}](https://sumbermaterial.co.id${FAR}) — semoga membantu Anda.\n\nTutup.`);
  assert.strictEqual(r.text, 'Terima kasih!\n\nTutup.');
});
t('[[[PLACEHOLDER_N]]] berdiri sendiri → paragraf dibuang', () => { assert.strictEqual(run('A.\n\n[[[PLACEHOLDER_N]]] (Tabel harga otomatis)\n\nB.').text, 'A.\n\nB.'); });
t('[[[PLACEHOLDER_N]]] di akhir kalimat → hanya penanda dibuang, kalimat sesudahnya aman', () => { assert.strictEqual(run('Selesai. [[[PLACEHOLDER_N]]] Jangan tunda lagi!').text, 'Selesai. Jangan tunda lagi!'); });
t('[[[PLACEHOLDER_N]]] di tengah kalimat → kalimat itu dibuang', () => { assert.strictEqual(run('Satu. Anda bisa cek [[[PLACEHOLDER_N]]] untuk melihat harga. Dua.').text, 'Satu. Dua.'); });
t('[internal link ke halaman kontak] → link WhatsApp resmi (sekali)', () => {
  const r = run('Hubungi kami! [internal link ke halaman kontak] [Internal Link ke halaman kontak]');
  assert.strictEqual(r.text, `Hubungi kami! [Chat WhatsApp](${WA})`);
});
t('/kontak & URL kontak absolut → WhatsApp; /shop → /product/', () => {
  assert.strictEqual(run('[Hubungi Kami](https://www.sumbermaterial.com/kontak)').text, `[Hubungi Kami](${WA})`);
  assert.strictEqual(run('Lihat [produk kami](https://sumbermaterial.com/shop).').text, 'Lihat [produk kami](/product/).');
});
t('jangkar URL mentah dibuang', () => { assert.strictEqual(run('Oke! [https://x.com/a/](https://x.com/a/) — Kami siap.').text, 'Oke! Kami siap.'); });
t('kata "anchor text" tertinggal dibuang', () => { assert.strictEqual(run('Oke! anchor text — untuk info lebih lanjut. Lanjut.').text, 'Oke! Lanjut.'); });
t('tabel [[TABEL_..]] yang gagal dirender dibuang', () => { assert(!/TABEL_/.test(run('A [[TABEL_MULAI]] {rusak [[TABEL_SELESAI]] B').text)); });
t('paragraf yang tidak bermasalah identik byte-per-byte', () => {
  const keep = 'Paragraf  biasa dengan spasi   ganda.  \n*   butir 1\n*   butir 2\n';
  const r = run(`${keep}\n\n[[[PLACEHOLDER_N]]]\n\n${keep}`);
  assert.strictEqual(r.text, `${keep}\n\n${keep}`);
});
t('idempoten: putaran kedua tidak mengubah apa pun', () => {
  const once = run(`Hai! [internal link ke ${T('Jakarta', 'Ancol')}](${SIB}) untuk x. [Hubungi](/kontak) [[[PLACEHOLDER_N]]]`);
  assert(!run(once.text).changed, once.text);
});
t('relevantCandidates: artikel lokasi hanya ke kota & produk sama', () => {
  const cands = [{ url: FAR, title: T('Depok', 'Abadijaya') }, { url: SIB, title: T('Jakarta', 'Ancol') }, { url: OTHER, title: 'Jual Pasir Di Angke Jakarta' }];
  const r = LG.relevantCandidates(T('Jakarta', 'Cawang'), cands, 6);
  assert.deepStrictEqual(r.map(x => x.url), [SIB]);
});
t('relevantCandidates: artikel non-lokasi tidak ditawari halaman kelurahan', () => {
  const r = LG.relevantCandidates('keunggulan baja ringan', [{ url: SIB, title: T('Jakarta', 'Ancol') }, { url: '/blog/x/', title: 'Kelebihan Baja Ringan' }], 6);
  assert.deepStrictEqual(r.map(x => x.url), ['/blog/x/']);
});
t('guardIssues menangkap penanda & bocoran', () => {
  assert(LG.guardIssues('x [[[PLACEHOLDER_N]]]').length); assert(LG.guardIssues('[internal link ke X](/a/b/)').length);
  assert(LG.guardIssues('[internal link ke halaman kontak]').length); assert(LG.guardIssues('[a](https://sumbermaterial.co.id/x/)').length);
  assert(!LG.guardIssues('Normal [harga pasir](/pasir/harga-pasir/) dan [WA](https://api.whatsapp.com/send?phone=1)').length);
});
console.log(`${n} tes lulus`);
