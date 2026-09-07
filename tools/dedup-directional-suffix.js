/**
 * dedup-directional-suffix.js
 *
 * Finds articles whose slug only differs from another existing article by ONE directional/
 * area-qualifier word — "timur", "barat", "utara", "selatan", "tengah", "pusat", "kota" — and
 * deletes the variant ONLY when the "parent" article (the same slug WITHOUT that word) already
 * exists in the same category folder. If no parent exists, the file is left untouched — this
 * is the same rule for BOTH slug shapes seen in practice:
 *
 *   Shape A (word inserted mid-slug, followed by a city name):
 *     harga-pasang-atap-baja-ringan-di-cakung-timur-jakarta.md   (child)
 *     harga-pasang-atap-baja-ringan-di-cakung-barat-jakarta.md   (child)
 *     harga-pasang-atap-baja-ringan-di-cakung-jakarta.md         (parent — exists, so children
 *                                                                  above get deleted)
 *
 *   Shape B (word appended at the very end, nothing after it):
 *     harga-pasang-atap-baja-ringan-di-bekasi-barat.md
 *     harga-pasang-atap-baja-ringan-di-bekasi-selatan.md
 *     harga-pasang-atap-baja-ringan-di-bekasi-timur.md
 *     harga-pasang-atap-baja-ringan-di-bekasi-utara.md
 *     harga-pasang-atap-baja-ringan-di-bekasi.md   ← does NOT exist, so NONE of the 4 files
 *                                                     above are touched.
 *
 * For every file that IS deleted, a redirect entry (old URL → surviving parent's URL) is added
 * to static/redirects.js — both the plain page and its /amp/ variant — so any existing
 * inbound links/search-engine-indexed URLs still resolve instead of 404ing.
 *
 * static/redirects.js is updated SURGICALLY: only the `redirectMap` object's contents are
 * touched. Every entry already in the file is preserved as-is; if a new entry would use a key
 * that's already present, the EXISTING entry wins and the new one is skipped (logged, never
 * silently dropped) — this file is never overwritten wholesale.
 *
 * USAGE:
 *   node dedup-directional-suffix.js                 → dry-run, preview only, nothing written
 *   node dedup-directional-suffix.js --apply          → delete files + update redirects.js
 *   node dedup-directional-suffix.js --apply --dir=content/baja-ringan   → limit to one folder
 */

const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content').replace('--dir=', '');

const CONTENT_ROOT = path.join(process.cwd(), DIR_ARG);
const CONTENT_BASE = path.join(process.cwd(), 'content'); // used to compute category prefix for URLs
const REDIRECTS_FILE = path.join(process.cwd(), 'static', 'redirects.js');

// Whole-token match only (split on "-") — never a substring match — so a district legitimately
// containing one of these words as part of a longer token would never be mistaken for a match.
const DIRECTION_WORDS = new Set(['timur', 'barat', 'utara', 'selatan', 'tengah', 'pusat', 'kota']);

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

// Category = first path segment under content/ (matches the URL convention already used
// throughout this repo's other tools, e.g. dedup-lapis1.js's toUrl()).
function toCategory(filePath) {
  const rel = path.relative(CONTENT_BASE, filePath).replace(/\\/g, '/');
  return rel.split('/')[0] || '';
}

function toUrl(category, slug) {
  return `/${category}/${slug}/`;
}

/**
 * Returns every candidate "parent slug" for a given slug — one candidate per directional word
 * token found (usually just one, but a slug could theoretically contain more than one).
 */
function candidateParentSlugs(slug) {
  const tokens = slug.split('-');
  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    if (DIRECTION_WORDS.has(tokens[i].toLowerCase())) {
      const parentTokens = tokens.slice(0, i).concat(tokens.slice(i + 1));
      candidates.push(parentTokens.join('-'));
    }
  }
  return candidates;
}

function main() {
  console.log(`\n🔍 dedup-directional-suffix.js`);
  console.log(`   Mode: ${APPLY ? 'APPLY (will delete files + update redirects.js)' : 'DRY-RUN (preview only)'}`);
  console.log(`   Directory: ${CONTENT_ROOT}`);
  console.log(`   Directional words: ${[...DIRECTION_WORDS].join(', ')}`);
  console.log(`${'─'.repeat(60)}`);

  const files = walkMarkdownFiles(CONTENT_ROOT);
  // Build a lookup of existing slug -> true, PER CATEGORY FOLDER (so a slug in one category
  // never accidentally "parents" a same-named slug living in a different category).
  const slugsByCategory = new Map(); // category -> Set(slug)
  const fileByCategorySlug = new Map(); // "category/slug" -> full file path

  for (const f of files) {
    const category = toCategory(f);
    const slug = path.basename(f, '.md');
    if (!slugsByCategory.has(category)) slugsByCategory.set(category, new Set());
    slugsByCategory.get(category).add(slug);
    fileByCategorySlug.set(`${category}/${slug}`, f);
  }

  console.log(`📁 ${files.length} article(s) scanned across ${slugsByCategory.size} categor${slugsByCategory.size === 1 ? 'y' : 'ies'}.\n`);

  const toDelete = []; // { file, category, slug, parentSlug }
  let skippedNoParent = 0;
  let skippedNoDirectionWord = 0;

  for (const f of files) {
    const category = toCategory(f);
    const slug = path.basename(f, '.md');
    const candidates = candidateParentSlugs(slug);

    if (candidates.length === 0) {
      skippedNoDirectionWord++;
      continue;
    }

    const knownSlugs = slugsByCategory.get(category);
    const validParent = candidates.find(c => knownSlugs.has(c));

    if (validParent) {
      toDelete.push({ file: f, category, slug, parentSlug: validParent });
    } else {
      skippedNoParent++;
      console.log(`⏭️  ${category}/${slug}.md — has direction word but no matching parent (${candidates.join(', ')}) — left untouched`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🗑️  ${toDelete.length} file(s) to delete (parent confirmed to exist):`);
  for (const d of toDelete) {
    console.log(`   ${d.category}/${d.slug}.md  →  redirects to  →  ${d.category}/${d.parentSlug}/`);
  }
  console.log(`\n⏭️  ${skippedNoParent} file(s) had a direction word but NO parent — left untouched`);
  console.log(`⏭️  ${skippedNoDirectionWord} file(s) had no direction word at all — not a candidate`);

  if (toDelete.length === 0) {
    console.log(`\n✅ Nothing to do.`);
    return;
  }

  // Build new redirect entries: old article URL -> surviving parent's URL, plus /amp/ variant.
  const newEntries = {};
  for (const d of toDelete) {
    const oldUrl = toUrl(d.category, d.slug);
    const newUrl = toUrl(d.category, d.parentSlug);
    newEntries[oldUrl] = newUrl;
    newEntries[`${oldUrl}amp/`] = `${newUrl}amp/`;
  }

  if (!APPLY) {
    console.log(`\nℹ️  DRY-RUN — no files deleted, redirects.js not touched.`);
    console.log(`   Re-run with --apply once this list looks correct.\n`);
    return;
  }

  // ── Delete the files ─────────────────────────────────────────────────────
  for (const d of toDelete) {
    fs.unlinkSync(d.file);
  }
  console.log(`\n✅ Deleted ${toDelete.length} file(s).`);

  // ── Merge new entries into static/redirects.js WITHOUT touching anything else in the file ──
  if (!fs.existsSync(REDIRECTS_FILE)) {
    console.error(`❌ ${REDIRECTS_FILE} not found — cannot add redirects. Files were already deleted; add redirects manually.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(REDIRECTS_FILE, 'utf8');
  const mapMatch = raw.match(/const redirectMap = \{([\s\S]*?)\};/);
  if (!mapMatch) {
    console.error(`❌ Could not find "const redirectMap = {...};" in ${REDIRECTS_FILE} — file format unexpected. Files were already deleted; add redirects manually.`);
    process.exit(1);
  }

  let existingMap;
  try {
    // Safe here: this file's object body is simple string-to-string data we generated
    // ourselves in earlier runs, no untrusted input — evaluated once, locally.
    existingMap = Function('"use strict"; return ({' + mapMatch[1] + '})')();
  } catch (err) {
    console.error(`❌ Could not parse existing redirectMap — aborting redirects.js update to avoid corrupting it: ${err.message}`);
    console.error(`   Files were already deleted; add these redirects manually:`);
    console.error(JSON.stringify(newEntries, null, 2));
    process.exit(1);
  }

  let added = 0, skippedExisting = 0;
  for (const [key, value] of Object.entries(newEntries)) {
    if (Object.prototype.hasOwnProperty.call(existingMap, key)) {
      skippedExisting++;
      console.log(`   ⏭️  Redirect for "${key}" already exists — NOT overwritten (kept existing value).`);
      continue;
    }
    existingMap[key] = value;
    added++;
  }

  const mergedEntries = Object.entries(existingMap);
  const newMapBody = '\n' + mergedEntries.map(([k, v]) => `"${k}": "${v}"`).join(',\n') + '\n';
  const newRaw = raw.slice(0, mapMatch.index)
    + `const redirectMap = {${newMapBody}};`
    + raw.slice(mapMatch.index + mapMatch[0].length);

  fs.writeFileSync(REDIRECTS_FILE, newRaw);

  console.log(`\n✅ redirects.js updated: ${added} new entr${added === 1 ? 'y' : 'ies'} added, ${skippedExisting} already existed and were left alone.`);
  console.log(`   Total entries in redirectMap now: ${mergedEntries.length}\n`);
}

main();
