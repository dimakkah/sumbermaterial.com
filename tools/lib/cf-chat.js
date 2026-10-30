/**
 * tools/lib/cf-chat.js — panggilan chat Cloudflare Workers AI yang ringkas (tanpa dependensi), untuk script kecil.
 * Memakai CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (boleh banyak baris/koma, dipasangkan 1:1 berurutan, rotasi bila rate-limit/auth).
 * Model sama dengan revise-articles.js.
 */
'use strict';
const https = require('https');

const parse = (raw) => (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
const IDS = parse(process.env.CLOUDFLARE_ACCOUNT_ID);
const TOKENS = parse(process.env.CLOUDFLARE_API_TOKEN);
const MODEL = process.env.CF_CHAT_MODEL || '@cf/aisingapore/gemma-sea-lion-v4-27b-it';
let idx = 0;

function available() { return IDS.length > 0 && TOKENS.length > 0; }

function post(body) {
  return new Promise((resolve, reject) => {
    const id = IDS[idx] || IDS[0];
    const req = https.request({
      host: 'api.cloudflare.com', path: `/client/v4/accounts/${id}/ai/v1/chat/completions`, method: 'POST',
      headers: { Authorization: `Bearer ${TOKENS[idx] || TOKENS[0]}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error('rate limit'), { rotate: true }));
        if (res.statusCode === 401 || res.statusCode === 403) return reject(Object.assign(new Error('auth error'), { rotate: true }));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('respons bukan JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function chat(messages, { temperature = 0.8, max_tokens = 80 } = {}) {
  const body = JSON.stringify({ model: MODEL, messages, temperature, max_tokens });
  let rotations = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await post(body);
      const content = r?.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI mengembalikan isi kosong');
      return content;
    } catch (err) {
      if (err.rotate && TOKENS.length > 1 && rotations < TOKENS.length - 1) { rotations++; idx = (idx + 1) % TOKENS.length; attempt--; continue; }
      if (attempt === 4) throw err;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
}

module.exports = { chat, available };
