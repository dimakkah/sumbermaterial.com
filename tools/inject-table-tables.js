/**
 * inject-table-tables.js
 *
 * Two modes for getting articles onto the {{< table-tables table="..." >}} shortcode instead
 * of a hand-written price table, so every article's price list is always driven by the single
 * source of truth in config.toml's [[params.products]]:
 *
 * MODE 1 — heading injection (default, original behavior):
 *   Insert {{< table-tables table="..." >}} exactly ONCE per article, right below the FIRST
 *   "## Harga..." (or "## Daftar Harga...") heading found. For articles that don't have a
 *   price table at all yet.
 *
 * MODE 2 — HTML table conversion (--convert-html-tables):
 *   Find the first raw `<table>...</table>` block in an article's body and REPLACE it in place
 *   with {{< table-tables table="..." >}}. For older articles that already have a hand-written
 *   HTML price table baked into the body (bgcolor/width attributes, inline styles etc. —
 *   common in this site's older content) — converting these means price updates in
 *   config.toml automatically apply everywhere, instead of being frozen at whatever numbers
 *   were hardcoded when the article was written.
 *
 * BOTH modes are idempotent and safe to re-run: if an article already has a table-tables
 * shortcode anywhere in its body, it's skipped entirely (never produces two shortcodes, and
 * mode 2 never touches an article mode 1 already handled or vice versa).
 *
 * RECOMMENDED ORDER when processing a category that has a mix of old-HTML-table articles and
 * plain-text articles: run --convert-html-tables FIRST, then run mode 1 (no flag) afterward —
 * that way mode 1's "already has a shortcode" check correctly skips every article mode 2 just
 * converted, and mode 1 only ever adds a shortcode to articles that never had a price table at
 * all. Running them in the opposite order risks mode 1 injecting a shortcode UNDER a "## Harga"
 * heading in an article that still has its old HTML table sitting elsewhere in the body,
 * leaving two price displays until mode 2 also runs.
 *
 * WHY A SCRIPT (not vscode.dev's regex Find & Replace) FOR EITHER MODE:
 * vscode.dev's "Replace All" acts per-MATCH, not per-FILE — an article with more than one
 * "## Harga..." heading (mode 1) or more than one raw <table> block (mode 2) would get the
 * shortcode inserted/table replaced more than once. Both modes here explicitly stop after the
 * FIRST match per file; any additional matches in the same file are reported but left alone.
 *
 * CAN RUN BOTH LOCALLY (dry-run always available, no CI required) AND VIA GITHUB ACTIONS —
 * see .github/workflows/inject-table-tables.yml for the CI version of this same script.
 *
 * CATEGORY FOLDER → table="..." MAPPING (must match [[params.products]] "name" fields in
 * config.toml EXACTLY). Covers all 17 categories currently defined there. A few of this site's
 * folder names (info, info-be*, info-ur*, produk, jasa, jasa-co*, jasa-ur*, wf) are either
 * ambiguous or purely editorial/informational content with no natural price-table category —
 * these are commented out below rather than guessed; override with --dir=/--table= if you do
 * want one of them mapped, or add it to the map directly once you've confirmed the right
 * config.toml category for it.
 *
 * USAGE:
 *   node inject-table-tables.js                                    → mode 1, dry-run, all categories
 *   node inject-table-tables.js --apply                             → mode 1, apply
 *   node inject-table-tables.js --convert-html-tables                → mode 2, dry-run, all categories
 *   node inject-table-tables.js --convert-html-tables --apply        → mode 2, apply
 *   node inject-table-tables.js --apply --dir=content/pasir --table="Pasir"
 *                                                                     → either mode, one custom
 *                                                                       folder outside the map below
 */

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const CONVERT_MODE = ARGS.includes('--convert-html-tables');
const CUSTOM_DIR = (ARGS.find(a => a.startsWith('--dir=')) || '').replace('--dir=', '');
const CUSTOM_TABLE = (ARGS.find(a => a.startsWith('--table=')) || '').replace('--table=', '');

const CONTENT_ROOT = path.join(process.cwd(), 'content');

// Default mapping — all confidently-known categories, now confirmed against REAL articles
// from this repo (not guessed). Folder name (key) must match the real folder under content/
// exactly; value must match a [[params.products]] "name" field in config.toml exactly.
const DEFAULT_CATEGORY_TABLE_MAP = {
  'pasir': 'Pasir',
  'batu': 'Batu',
  'bata': 'Bata dan Batako',
  'batako': 'Bata dan Batako',
  'hebel': 'Bata dan Batako',
  'readymix': 'Beton Readymix',
  'aspal': 'Aspal',
  'wiremesh': 'Wiremesh',
  'baja-ringan': 'Baja Ringan',
  'besi': 'Besi',
  'baja': 'Baja',
  'wf': 'Baja', // confirmed via harga-besi-h-beam-dan-wf-... .md (categories: "wf") — WF/H-Beam
                // steel already lives under config.toml's "Baja" category
  'jasa-urug': 'Jasa Urug', // confirmed via jasa-urug-tanah-pemadatan-... .md — genuinely a
                            // different price structure (service, priced per m² per fill
                            // depth) from raw material "Batu"/"Pasir" categories, so this got
                            // its own new config.toml category rather than being folded in
  'jasa-cor': 'Jasa Cor',   // confirmed via jasa-cor-lantai-dan-jalan-...  .md — new category,
                            // combined beton+tukang+bekisting price per m², not a raw material
  'bangunan': 'Bangunan',
  'bengkel': 'Bengkel',
  'kanopi': 'Kanopi',
  'kusen': 'Kusen',
  'pagar': 'Pagar',
  // Confirmed EXCLUDED after reviewing real articles from these folders — do NOT map by
  // default, a single category can't represent them correctly:
  // 'jasa':       biaya-pengaspalan-jalan-...  .md lives here, but this folder is a generic
  //               catch-all for MANY unrelated service topics — mapping the WHOLE folder to
  //               one table would misrepresent every article that isn't about that one topic.
  //               For an individual article you're sure about (e.g. that specific aspal one,
  //               which could reasonably use table="Aspal"), use --dir=/--table= per file
  //               instead of relying on this default map.
  // 'info-besi':  harga-bondek-wiremesh-baja-ringan-...  .md lives here, and its own table
  //               mixes THREE different categories at once (Baja Ringan + Wiremesh + Material
  //               Atap items all in one table) — the table-tables shortcode only accepts ONE
  //               "table" value, so there is no single correct category for this folder's
  //               articles. Leave as-is (raw HTML table stays) or handle case-by-case.
  // 'info':      not a product folder (informational/blog content), no price table needed
  // 'info-ur...': same category of content as 'info-besi' above — likely also multi-category,
  //               review individually before mapping
  // 'produk':    generic name, unclear which [[params.products]] entry (or entries) it maps to
};

// Matches H2 heading "## Harga ..." OR "## Daftar Harga ..." (any continuation) — covers the
// pattern already used across this site's older articles, e.g. "## Daftar Harga Hebel 7 cm
// 10 cm Kirim Ke Abadijaya Depok".
const HEADING_RE = /^##[ \t]+(?:Daftar[ \t]+)?Harga\b.*$/im;

// Raw HTML table block — same regex convention already used in tools/revise-articles.js's
// protectStructure() for the same kind of hand-written price tables in older articles.
const HTML_TABLE_RE = /<table[\s\S]*?<\/table>/i;

// Same frontmatter split convention used across this repo's other tools (lib/orphan-link.js,
// dedup-directional-suffix.js, etc.) — rawMatter deliberately keeps its leading newline so
// reconstruction as `---${rawMatter}\n---\n${body}` never reformats the original frontmatter.
function splitFrontMatter(raw) {
  const m = raw.match(/^---(\r?\n[\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { rawMatter: m[1], body: m[2] || '' };
}

function walkMarkdownFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walkMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_index.md') {
      results.push(full);
    }
  }
  return results;
}

/**
 * MODE 1 — insert shortcode below the first "## Harga..." heading.
 */
function injectAfterHeading(filePath, tableName) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = splitFrontMatter(raw);
  if (!parsed) return { status: 'skip', reason: 'frontmatter tidak terbaca (bukan file .md standar)' };

  const { rawMatter, body } = parsed;

  if (/\{\{<\s*table-tables\b/i.test(body)) {
    return { status: 'skip', reason: 'sudah ada shortcode table-tables di artikel ini' };
  }

  const allMatches = body.match(new RegExp(HEADING_RE.source, 'gim')) || [];
  if (allMatches.length === 0) {
    return { status: 'skip', reason: 'tidak ditemukan sub-judul "## Harga..." di artikel ini' };
  }

  const firstHeading = allMatches[0];
  const headingIndex = body.indexOf(firstHeading);
  const insertAt = headingIndex + firstHeading.length;

  const insertion = `\n\n{{< table-tables table="${tableName}" >}}`;
  const newBody = body.slice(0, insertAt) + insertion + body.slice(insertAt);

  if (APPLY) {
    fs.writeFileSync(filePath, `---${rawMatter}\n---\n${newBody}`);
  }

  return {
    status: 'injected',
    detail: `disisipkan di bawah: "${firstHeading.trim()}"`,
    extraSkippedNote: allMatches.length - 1 > 0
      ? `ada ${allMatches.length - 1} heading "## Harga..." lain di file ini, sengaja dilewati`
      : null,
  };
}

/**
 * MODE 2 — replace the first raw <table>...</table> block with the shortcode.
 */
function convertHtmlTable(filePath, tableName) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = splitFrontMatter(raw);
  if (!parsed) return { status: 'skip', reason: 'frontmatter tidak terbaca (bukan file .md standar)' };

  const { rawMatter, body } = parsed;

  if (/\{\{<\s*table-tables\b/i.test(body)) {
    return { status: 'skip', reason: 'sudah ada shortcode table-tables di artikel ini' };
  }

  const allMatches = body.match(new RegExp(HTML_TABLE_RE.source, 'gi')) || [];
  if (allMatches.length === 0) {
    return { status: 'skip', reason: 'tidak ada tabel HTML <table>...</table> ditemukan' };
  }

  const firstTable = allMatches[0];
  const shortcode = `{{< table-tables table="${tableName}" >}}`;
  // String.prototype.replace with a STRING (not regex) needle replaces only the FIRST
  // occurrence — exactly the "just the first table" behavior we want.
  const newBody = body.replace(firstTable, shortcode);

  if (APPLY) {
    fs.writeFileSync(filePath, `---${rawMatter}\n---\n${newBody}`);
  }

  return {
    status: 'converted',
    detail: `tabel HTML (${firstTable.length} karakter) diganti shortcode`,
    extraSkippedNote: allMatches.length - 1 > 0
      ? `ada ${allMatches.length - 1} tabel HTML lain di file ini, sengaja dilewati`
      : null,
  };
}

function processCategory(folderName, tableName) {
  const dir = path.join(CONTENT_ROOT, folderName);
  const files = walkMarkdownFiles(dir);
  const processFn = CONVERT_MODE ? convertHtmlTable : injectAfterHeading;
  const actionWord = CONVERT_MODE ? 'converted' : 'injected';

  console.log(`\n📁 ${folderName}/  →  table="${tableName}"`);
  console.log(`   ${'─'.repeat(60)}`);

  if (files.length === 0) {
    console.log(`   ⚠️  Folder tidak ditemukan atau kosong: ${dir}`);
    return { done: 0, skipped: 0, total: 0 };
  }

  let done = 0, skipped = 0;
  for (const file of files) {
    const rel = path.relative(CONTENT_ROOT, file);
    const result = processFn(file, tableName);

    if (result.status === actionWord) {
      done++;
      const note = result.extraSkippedNote ? ` (${result.extraSkippedNote})` : '';
      console.log(`   ✅ ${rel}`);
      console.log(`      → ${result.detail}${note}`);
    } else {
      skipped++;
      console.log(`   ⏭️  ${rel} — ${result.reason}`);
    }
  }

  console.log(`   ${'─'.repeat(60)}`);
  console.log(`   Ringkasan ${folderName}: ${done} ${actionWord === 'converted' ? 'dikonversi' : 'disisipkan'}, ${skipped} dilewati, ${files.length} total file`);

  return { done, skipped, total: files.length };
}

function main() {
  console.log(`\n🔧 inject-table-tables.js`);
  console.log(`   Mode  : ${CONVERT_MODE ? 'CONVERT-HTML-TABLES (ganti tabel HTML jadi shortcode)' : 'HEADING-INJECTION (sisip shortcode di bawah "## Harga...")'}`);
  console.log(`   Apply : ${APPLY ? 'YA (akan menulis perubahan ke file)' : 'TIDAK (dry-run, preview saja)'}`);

  const categoryMap = (CUSTOM_DIR && CUSTOM_TABLE)
    ? { [CUSTOM_DIR.replace(/^content\//, '')]: CUSTOM_TABLE }
    : DEFAULT_CATEGORY_TABLE_MAP;

  console.log(`   Kategori diproses: ${Object.keys(categoryMap).join(', ')}`);

  let totalDone = 0, totalSkipped = 0, totalFiles = 0;
  for (const [folder, table] of Object.entries(categoryMap)) {
    const r = processCategory(folder, table);
    totalDone += r.done;
    totalSkipped += r.skipped;
    totalFiles += r.total;
  }

  const actionLabel = CONVERT_MODE ? 'dikonversi' : 'disisipkan';
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Total ${actionLabel} : ${totalDone}`);
  console.log(`⏭️  Total dilewati    : ${totalSkipped}`);
  console.log(`📁 Total file dicek  : ${totalFiles}`);
  console.log(`${'═'.repeat(60)}`);

  if (!APPLY) {
    console.log(`\nℹ️  Ini baru DRY-RUN — tidak ada file yang benar-benar diubah.`);
    console.log(`   Cek dulu daftar di atas, kalau sudah sesuai jalankan ulang dengan --apply.\n`);
  } else {
    console.log(`\n✅ Selesai — ${totalDone} file sudah diubah. Cek git diff sebelum commit.\n`);
  }
}

main();
