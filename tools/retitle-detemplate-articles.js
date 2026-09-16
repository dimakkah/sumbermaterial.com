/**
 * retitle-detemplate-articles.js
 *
 * ONE-TIME(ish) batch tool: for EVERY article in a content folder (default content/blog),
 * rewrite the TITLE + META DESCRIPTION to remove generic news-SEO template phrasing
 * ("Panduan Lengkap & Estimasi Biaya", "Terbaru [tahun]", "Update [tahun]") and — critically —
 * strip any explicit year so the article reads as evergreen, plus a light TARGETED revision
 * of the body prose (opening paragraphs, section intros, heading variety) for the same reason,
 * while preserving this site's established brand voice, all images/shortcodes/tables/links,
 * and NOT adding any new structural elements (no new tables/links).
 *
 * Unlike revise-articles.js (which deliberately NEVER touches the title, and only targets
 * articles flagged as cross-city near-duplicates via candidates.json), this tool targets
 * EVERY .md file directly in the given folder and DOES rewrite title + description.
 *
 * USAGE:
 *   node retitle-detemplate-articles.js                          → dry-run, all files, preview only
 *   node retitle-detemplate-articles.js --apply                  → apply to files (resumable)
 *   node retitle-detemplate-articles.js --apply --limit=5         → apply to up to 5 this run
 *   node retitle-detemplate-articles.js --only=slug-a,slug-b      → limit to specific slugs
 *   node retitle-detemplate-articles.js --dir=content/blog        → target folder (default)
 *   node retitle-detemplate-articles.js --verify-cf               → test CF account/token pairs
 *
 * REQUIRES: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI), npm install gray-matter
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const matter = require('gray-matter');

const PROMPTS = require('./prompts/retitle-detemplate-articles.json');

const { renderSafeTables, hasLeftoverTableMarkers } = require('./lib/safe-table.js');

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

const ARGS  = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const VERIFY_CF = ARGS.includes('--verify-cf');
const LIMIT_ARG = (ARGS.find(a => a.startsWith('--limit=')) || '').replace('--limit=', '');
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG, 10) : 20;
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content/blog').replace('--dir=', '');
const ONLY_ARG = (ARGS.find(a => a.startsWith('--only=')) || '').replace('--only=', '');
const ONLY_SLUGS = ONLY_ARG ? new Set(ONLY_ARG.split(',').map(s => s.trim()).filter(Boolean)) : null;

const CONTENT_DIR   = path.join(process.cwd(), DIR_ARG);
const PROGRESS_FILE = path.join(process.cwd(), '.retitle-detemplate-progress.json');
const LOG_FILE      = path.join(process.cwd(), 'retitled-articles.log');

function parseTokens(raw) {
  return (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

const CONFIG = {
  CF_ACCOUNT_IDS: parseTokens(process.env.CLOUDFLARE_ACCOUNT_ID),
  CF_API_TOKENS : parseTokens(process.env.CLOUDFLARE_API_TOKEN),
  HOST        : 'api.cloudflare.com',
  MODEL       : '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  TIMEOUT_MS  : 60000,
  MAX_RETRIES_PER_ARTICLE: 2,
  // Extra AI regeneration attempts (same article, same call) specifically when the title/
  // description still fail the year/template checks — separate budget from network-error
  // retries, because "AI ignored an instruction" needs a fresh generation, not a resend.
  MAX_CONTENT_RETRIES: 2,
};

CONFIG.CF_ACCOUNT_IDS.forEach((id, i) => {
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID line ${i + 1} doesn't look like a valid Cloudflare account ID ` +
      `(expected 32 hex characters, got ${id.length} chars: "${id}").`);
  }
});
if (CONFIG.CF_ACCOUNT_IDS.length > 1 && CONFIG.CF_ACCOUNT_IDS.length !== CONFIG.CF_API_TOKENS.length) {
  console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID has ${CONFIG.CF_ACCOUNT_IDS.length} line(s) but CLOUDFLARE_API_TOKEN has ` +
    `${CONFIG.CF_API_TOKENS.length} line(s). For multi-account rotation these must match 1:1.`);
}

let tokenIdx = 0;
function currentToken() { return CONFIG.CF_API_TOKENS[tokenIdx] || ''; }
function currentAccountId() { return CONFIG.CF_ACCOUNT_IDS[tokenIdx] || CONFIG.CF_ACCOUNT_IDS[0] || ''; }
function currentPath() { return `/client/v4/accounts/${currentAccountId()}/ai/v1/chat/completions`; }
function rotateToken() { tokenIdx = (tokenIdx + 1) % CONFIG.CF_API_TOKENS.length; }

function log(msg) { console.log(msg); }

async function verifyCfPairs() {
  log(`\n🔍 Verifying CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN pair(s)`);
  log(`${'─'.repeat(60)}\n`);
  if (CONFIG.CF_API_TOKENS.length === 0) { log('❌ CLOUDFLARE_API_TOKEN not found.'); return; }
  if (CONFIG.CF_ACCOUNT_IDS.length === 0) { log('❌ CLOUDFLARE_ACCOUNT_ID not found.'); return; }

  let anyFailed = false;
  for (let i = 0; i < CONFIG.CF_API_TOKENS.length; i++) {
    const token = CONFIG.CF_API_TOKENS[i];
    const accountId = CONFIG.CF_ACCOUNT_IDS[i] || CONFIG.CF_ACCOUNT_IDS[0];
    const label = `Pair ${i + 1} (account ...${accountId.slice(-6)})`;
    try {
      const body = JSON.stringify({ model: CONFIG.MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
      await httpRequest(CONFIG.HOST, `/client/v4/accounts/${accountId}/ai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, body, 20000);
      log(`   ✅ ${label}: OK`);
    } catch (err) {
      anyFailed = true;
      log(`   ❌ ${label}: ${err.message}`);
    }
  }
  log(anyFailed ? '\n⚠️  One or more pairs failed.' : '\n✅ All pairs authenticated successfully.');
}

function yamlEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Surgically set/replace a single frontmatter field in the RAW frontmatter text (never a
// full YAML re-serialize — see setLastmod() in revise-articles.js for why: avoids noisy,
// unrelated-looking git diffs from quote-style/key-order/array-layout changes).
function setFrontmatterField(rawMatter, field, value) {
  const line = `${field}: "${yamlEscape(value)}"`;
  const re = new RegExp(`^${field}:\\s*.*$`, 'm');
  if (re.test(rawMatter)) return rawMatter.replace(re, line);
  return `${rawMatter}\n${line}`;
}
function setLastmod(rawMatter, newDate) {
  return setFrontmatterField(rawMatter, 'lastmod', newDate);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function httpRequest(hostname, reqPath, options, body, timeoutMs = CONFIG.TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, ...options }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode === 429) {
          const err = new Error(`Rate limited: ${data.slice(0, 200)}`);
          err.isRateLimit = true;
          err.retryAfterSec = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
          reject(err);
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          err.isAuthError = (res.statusCode === 401 || res.statusCode === 403);
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs/1000}s`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callAI(messages, retries = 3) {
  const body = JSON.stringify({ model: CONFIG.MODEL, messages, temperature: 0.8, max_tokens: 4096 });
  let keysTriedThisCall = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await httpRequest(CONFIG.HOST, currentPath(), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken()}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, body);
      const choice = result?.choices?.[0];
      const content = choice?.message?.content;
      if (!content) throw new Error(`AI returned empty content. Raw response: ${JSON.stringify(result).slice(0, 300)}`);
      if (choice.finish_reason === 'length') throw new Error('AI output truncated (finish_reason=length) — increase max_tokens.');
      return content;
    } catch (err) {
      if (err.isRateLimit || err.isAuthError) {
        if (CONFIG.CF_API_TOKENS.length > 1 && keysTriedThisCall < CONFIG.CF_API_TOKENS.length - 1) {
          keysTriedThisCall++;
          const reason = err.isRateLimit ? 'rate-limited' : 'auth error';
          log(`   🔁 Key #${tokenIdx + 1} ${reason} — rotating...`);
          rotateToken();
          attempt--;
          continue;
        }
        if (err.isRateLimit && err.retryAfterSec && err.retryAfterSec <= 90 && attempt < retries) {
          log(`   ⏳ Rate limit, waiting ${err.retryAfterSec}s...`);
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500));
          continue;
        }
        throw err;
      }
      if (attempt === retries) throw err;
      const waitMs = attempt * 3000;
      log(`   ⚠️  Failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${waitMs/1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// ─── Structure protection: images, shortcodes, raw HTML blocks, markdown links, AND
//     markdown pipe-tables (this site mixes raw <table> HTML AND plain markdown "| a | b |"
//     tables across older/newer articles — revise-articles.js only ever had to protect the
//     HTML form, since the markdown-table AI-output convention ([[TABEL_MULAI]] blocks) gets
//     converted to HTML/safe form before being saved; but EXISTING saved files on disk can
//     already contain literal markdown pipe-table syntax, so this tool protects that too). ──
function protectMarkdownTables(text, placeholders) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  const isPipeLine = l => /^\s*\|.*\|\s*$/.test(l);
  while (i < lines.length) {
    if (isPipeLine(lines[i])) {
      let j = i;
      while (j < lines.length && isPipeLine(lines[j])) j++;
      if (j - i >= 2) { // header + separator (or more rows) — a lone "|" line is left alone
        const idx = placeholders.length;
        placeholders.push(lines.slice(i, j).join('\n'));
        out.push(`[[[PLACEHOLDER_${idx}]]]`);
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

function protectStructure(content) {
  const placeholders = [];
  let protectedContent = content;

  protectedContent = protectedContent.replace(/<table[\s\S]*?<\/table>/gi, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });
  protectedContent = protectedContent.replace(/<div class="video-responsive">[\s\S]*?<\/div>/gi, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });

  protectedContent = protectMarkdownTables(protectedContent, placeholders);

  protectedContent = protectedContent.replace(/!\[.*?\]\(.*?\)/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });

  protectedContent = protectedContent.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });

  protectedContent = protectedContent.replace(/\{\{<.*?>\}\}/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });

  return { protectedContent, placeholders };
}

function restoreStructure(content, placeholders) {
  return content.replace(/\[\[\[PLACEHOLDER_(\d+)\]\]\]/g, (_, idx) => placeholders[parseInt(idx, 10)] || '');
}

function stripTrailingMarker(content) {
  const trailingMarkerPattern = /^(ARTIKEL[_\s]?SELESAI|SELESAI|\[?END\]?|TAMAT)\.?$/i;
  const lines = content.split('\n');
  while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || trailingMarkerPattern.test(lines[lines.length - 1].trim()))) {
    lines.pop();
  }
  return lines.join('\n');
}

function cleanupAIChatter(text) {
  let lines = text.split('\n');
  const preamblePatterns = [
    /^berikut(lah)? (adalah )?(artikel|hasil|versi)/i,
    /^tentu[,.]?\s*(berikut|ini)/i,
    /^ini (adalah )?(artikel|hasil|versi) yang (sudah|telah) (direvisi|ditulis ulang)/i,
  ];
  while (lines.length && preamblePatterns.some(p => p.test(lines[0].trim()))) {
    lines.shift();
    while (lines.length && lines[0].trim() === '') lines.shift();
  }
  const closingPatterns = [
    /^ARTIKEL[_\s]?SELESAI$/i, /^SELESAI$/i, /^\[?END\]?$/i, /^TAMAT$/i, /^---+$/, /^===+$/,
    /^semoga (artikel|tulisan) ini (bermanfaat|membantu)/i,
  ];
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && closingPatterns.some(p => p.test(lines[lines.length - 1].trim()))) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }
  return lines.join('\n');
}

// ─── Parse the AI response: JUDUL_BARU / DESCRIPTION_BARU / ARTIKEL_MULAI ────────────
function parseAIResponse(raw) {
  const lines = raw.split('\n');
  let title = '', description = '', body = '', inBody = false;
  for (const line of lines) {
    const t = line.trim();
    if (!inBody && t.startsWith('JUDUL_BARU:'))       { title = t.replace('JUDUL_BARU:', '').replace(/\*\*/g, '').replace(/^#+\s*/, '').replace(/^["']|["']$/g, '').trim(); continue; }
    if (!inBody && t.startsWith('DESCRIPTION_BARU:'))  { description = t.replace('DESCRIPTION_BARU:', '').replace(/^["']|["']$/g, '').trim(); continue; }
    if (t === 'ARTIKEL_MULAI') { inBody = true; continue; }
    if (inBody) body += line + '\n';
  }
  if (!inBody) body = raw; // AI didn't follow the marker format — fall back to treating everything as body (will likely fail validation downstream)
  return { title, description, body: body.trim() };
}

// ─── Title/description evergreen + anti-template checks ─────────────────────────────
const YEAR_RE = /\b(19|20)\d{2}\b/;
const BOILERPLATE_PATTERNS = [/panduan lengkap/i, /estimasi biaya/i, /update terbaru/i];

function titleIssues(title) {
  const issues = [];
  if (!title) { issues.push('judul kosong'); return issues; }
  if (YEAR_RE.test(title)) issues.push(`judul masih mengandung angka tahun ("${title}")`);
  const hits = BOILERPLATE_PATTERNS.filter(p => p.test(title));
  if (hits.length >= 2) issues.push(`judul masih terasa template SEO-berita ("${title}")`);
  return issues;
}
function descriptionIssues(description) {
  const issues = [];
  if (description && YEAR_RE.test(description)) issues.push(`description masih mengandung angka tahun ("${description}")`);
  return issues;
}

function validatePlaceholders(revisedProtected, placeholders) {
  const issues = [];
  for (let i = 0; i < placeholders.length; i++) {
    const token = `[[[PLACEHOLDER_${i}]]]`;
    const count = (revisedProtected.match(new RegExp(token.replace(/[[\]]/g, '\\$&'), 'g')) || []).length;
    if (count !== 1) issues.push(`Placeholder ${i} muncul ${count}x di output AI (harusnya tepat 1x)`);
  }
  return issues;
}

function validateFinalContent(original, revisedContent) {
  const issues = [];
  if (!/mitra\b/i.test(revisedContent)) issues.push('Sapaan "Mitra" (brand voice) hilang di hasil revisi');
  if (revisedContent.length < original.length * 0.75) {
    issues.push(`Hasil revisi terlalu pendek (${revisedContent.length} vs asli ${original.length} karakter)`);
  }
  return issues;
}

// Deterministic safety net: force the leading bold "**Title**" at the very start of the body
// to match the NEW title exactly, regardless of whether the AI did this correctly itself
// (instruction #5 in the prompt asks for it, but this guarantees it rather than trusting it).
function forceLeadingTitle(body, newTitle) {
  const trimmed = body.replace(/^\s+/, '');
  const boldStart = trimmed.match(/^\*\*[^*]+\*\*/);
  if (boldStart) {
    return `**${newTitle}**` + trimmed.slice(boldStart[0].length);
  }
  return body; // no leading bold found — leave body untouched rather than guessing where to insert
}

function buildPrompt(title, description, category, protectedContent) {
  return [
    { role: 'system', content: PROMPTS.revision.systemTemplate },
    {
      role: 'user',
      content: renderTemplate(PROMPTS.revision.userTemplate, {
        title, description: description || '(tidak ada)', category,
        length: protectedContent.length,
        wordCount: protectedContent.split(/\s+/).length,
        protectedContent,
      }),
    },
  ];
}

async function main() {
  if (VERIFY_CF) { await verifyCfPairs(); return; }

  const t0 = Date.now();
  log(`\n✍️  RETITLE + DE-TEMPLATE — ${DIR_ARG}`);
  log(`   Mode  : ${APPLY ? 'APPLY' : 'DRY-RUN'}  (limit ${LIMIT} per session)`);
  log(`${'─'.repeat(60)}\n`);

  if (CONFIG.CF_API_TOKENS.length === 0) throw new Error('CLOUDFLARE_API_TOKEN not found.');
  if (CONFIG.CF_ACCOUNT_IDS.length === 0) throw new Error('CLOUDFLARE_ACCOUNT_ID not found.');

  if (!fs.existsSync(CONTENT_DIR)) throw new Error(`Directory not found: ${CONTENT_DIR}`);

  let allFiles = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md') && f !== '_index.md');
  if (ONLY_SLUGS) allFiles = allFiles.filter(f => ONLY_SLUGS.has(path.basename(f, '.md')));

  log(`📄 ${allFiles.length} article(s) found in ${DIR_ARG}.\n`);

  const progress = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    : { done: [], failed: {} };

  const todo = allFiles.filter(f => !progress.done.includes(f) && (progress.failed[f] || 0) < CONFIG.MAX_RETRIES_PER_ARTICLE);
  log(`   Already done before : ${progress.done.length}`);
  log(`   Awaiting            : ${todo.length}`);
  log(`   Will process now    : ${Math.min(LIMIT, todo.length)}\n`);

  let processed = 0, success = 0, failedThisSession = 0;
  const logLines = [];

  for (const fname of todo) {
    if (processed >= LIMIT) break;
    processed++;

    const filePath = path.join(CONTENT_DIR, fname);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    const oldTitle = parsed.data.title || '';
    const oldDescription = parsed.data.description || '';
    const category = Array.isArray(parsed.data.categories) ? parsed.data.categories.join(', ') : (parsed.data.categories || '');

    log(`📝 [${processed}/${Math.min(LIMIT, todo.length)}] ${fname}`);
    log(`   Judul lama: "${oldTitle}"`);

    const { protectedContent, placeholders } = protectStructure(parsed.content);
    const tArticle = Date.now();

    let finalTitle = null, finalDescription = null, finalBody = null, lastIssues = [];

    for (let contentAttempt = 1; contentAttempt <= CONFIG.MAX_CONTENT_RETRIES + 1; contentAttempt++) {
      try {
        const messages = buildPrompt(oldTitle, oldDescription, category, protectedContent);
        let aiRaw = await callAI(messages);
        aiRaw = cleanupAIChatter(aiRaw);
        const { title: newTitle, description: newDescription, body: revisedProtectedBody } = parseAIResponse(aiRaw);

        const issues = [
          ...titleIssues(newTitle),
          ...descriptionIssues(newDescription),
          ...validatePlaceholders(revisedProtectedBody, placeholders),
        ];

        if (issues.length > 0) {
          lastIssues = issues;
          log(`   ⚠️  Percobaan ${contentAttempt} gagal validasi: ${issues.join('; ')}`);
          if (contentAttempt <= CONFIG.MAX_CONTENT_RETRIES) continue; else break;
        }

        let revisedBody = stripTrailingMarker(restoreStructure(revisedProtectedBody, placeholders));
        revisedBody = renderSafeTables(revisedBody);
        if (hasLeftoverTableMarkers(revisedBody)) {
          log('   ⚠️  Leftover [[TABEL_...]] marker ditemukan setelah render — periksa manual.');
        }
        revisedBody = forceLeadingTitle(revisedBody, newTitle);

        const finalIssues = validateFinalContent(parsed.content, revisedBody);
        if (finalIssues.length > 0) {
          lastIssues = finalIssues;
          log(`   ⚠️  Percobaan ${contentAttempt} gagal validasi akhir: ${finalIssues.join('; ')}`);
          if (contentAttempt <= CONFIG.MAX_CONTENT_RETRIES) continue; else break;
        }

        finalTitle = newTitle;
        finalDescription = newDescription;
        finalBody = revisedBody;
        break;
      } catch (err) {
        lastIssues = [err.message];
        if (err.isRateLimit || err.isAuthError) {
          const keyNote = CONFIG.CF_API_TOKENS.length > 1 ? ` (semua ${CONFIG.CF_API_TOKENS.length} key sudah dicoba)` : '';
          log(`\n🛑 ${err.isRateLimit ? 'Rate limited' : 'Auth error'}${keyNote}. Progress tersimpan (${success} sukses sesi ini).`);
          if (APPLY) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
          if (logLines.length) fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n');
          return;
        }
        log(`   ❌ Error percobaan ${contentAttempt}: ${err.message}`);
        if (contentAttempt <= CONFIG.MAX_CONTENT_RETRIES) continue; else break;
      }
    }

    if (!finalTitle) {
      log(`   ❌ Dilewati setelah ${CONFIG.MAX_CONTENT_RETRIES + 1} percobaan: ${lastIssues.join('; ')}`);
      progress.failed[fname] = (progress.failed[fname] || 0) + 1;
      failedThisSession++;
      logLines.push(`FAILED,${fname},"${lastIssues.join(' | ')}"`);
      if (APPLY) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      continue;
    }

    log(`   ✅ Judul baru: "${finalTitle}" (${fmtDuration(Date.now() - tArticle)})`);
    log(`   📋 Description baru: "${finalDescription}"`);

    if (APPLY) {
      let newRawMatter = setFrontmatterField(parsed.matter, 'title', finalTitle);
      newRawMatter = setFrontmatterField(newRawMatter, 'description', finalDescription);
      newRawMatter = setLastmod(newRawMatter, new Date().toISOString().split('T')[0]);
      const newFileContent = `---${newRawMatter}\n---\n${finalBody}\n`;
      fs.writeFileSync(filePath, newFileContent);
      progress.done.push(fname);
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    }
    success++;
    logLines.push(`SUCCESS,${fname},"${oldTitle}" -> "${finalTitle}"`);
  }

  if (logLines.length) fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n');

  const stillTodo = allFiles.filter(f => !progress.done.includes(f) && (progress.failed[f] || 0) < CONFIG.MAX_RETRIES_PER_ARTICLE).length;
  log(`\n${'─'.repeat(60)}`);
  log(APPLY ? '✅ DONE (APPLY)' : '🧪 DRY-RUN COMPLETE (tidak ada file yang diubah)');
  log(`   Berhasil sesi ini : ${success}`);
  log(`   Gagal/dilewati    : ${failedThisSession}`);
  log(`   Sisa              : ${stillTodo}`);
  log(`   Total waktu       : ${fmtDuration(Date.now() - t0)}`);
  log(`   Log detail        : ${LOG_FILE}`);
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
