/**
 * QuickBooks OAuth2 Authorization Script (ES Module)
 * Chạy: node qb-auth.mjs
 */

import http from 'http';
import https from 'https';
import { parse as parseUrl } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Đọc .env ──────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) {
    console.error('❌ Không tìm thấy file .env!');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const env = loadEnv();
const CLIENT_ID     = env.QUICKBOOKS_CLIENT_ID;
const CLIENT_SECRET = env.QUICKBOOKS_CLIENT_SECRET;
const REDIRECT_URI  = env.QUICKBOOKS_REDIRECT_URI || 'http://localhost:3000/callback';
const PORT          = 3000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Thiếu QUICKBOOKS_CLIENT_ID hoặc QUICKBOOKS_CLIENT_SECRET trong .env');
  process.exit(1);
}

// ─── Authorization URL ──────────────────────────────────────────────────────
const STATE = 'qbo_' + Math.random().toString(36).slice(2);
const AUTH_URL =
  'https://appcenter.intuit.com/connect/oauth2' +
  '?client_id='    + encodeURIComponent(CLIENT_ID) +
  '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
  '&response_type=code' +
  '&scope='        + encodeURIComponent('com.intuit.quickbooks.accounting') +
  '&state='        + STATE;

// ─── Đổi code lấy tokens ───────────────────────────────────────────────────
function exchangeCode(code, realmId) {
  return new Promise((resolve, reject) => {
    const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body  = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    const req = https.request({
      hostname: 'oauth.platform.intuit.com',
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Authorization':  `Basic ${creds}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error_description || json.error));
          else resolve({ ...json, realmId });
        } catch { reject(new Error('Response lỗi: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Ghi token vào .env ─────────────────────────────────────────────────────
function saveTokens(tokens) {
  const envPath = join(__dirname, '.env');
  let content   = readFileSync(envPath, 'utf8');

  const updates = {
    QUICKBOOKS_REALM_ID:      tokens.realmId,
    QUICKBOOKS_ACCESS_TOKEN:  tokens.access_token,
    QUICKBOOKS_REFRESH_TOKEN: tokens.refresh_token,
  };

  for (const [key, value] of Object.entries(updates)) {
    if (new RegExp(`^${key}=`, 'm').test(content)) {
      content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  writeFileSync(envPath, content, 'utf8');
}

// ─── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname, query } = parseUrl(req.url, true);

  if (pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  const { code, state, realmId, error } = query;

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Lỗi: ${error}</h2>`);
    server.close(); return;
  }

  if (state !== STATE) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>❌ State không khớp!</h2>');
    server.close(); return;
  }

  console.log('\n⏳ Đang lấy tokens từ Intuit...');

  try {
    const tokens = await exchangeCode(code, realmId);

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║        ✅  AUTHORIZATION THÀNH CÔNG!         ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Realm ID      : ${tokens.realmId}`);
    console.log(`║  Access Token  : ${tokens.access_token.slice(0,30)}...`);
    console.log(`║  Refresh Token : ${tokens.refresh_token.slice(0,30)}...`);
    console.log('╚══════════════════════════════════════════════╝\n');

    saveTokens(tokens);
    console.log('✅ Đã ghi tokens vào file .env thành công!\n');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fff4">
        <h1 style="color:#16a34a">✅ Authorization thành công!</h1>
        <p>Tokens đã được lưu vào <strong>.env</strong></p>
        <p><strong>Realm ID:</strong> ${tokens.realmId}</p>
        <p style="color:#666">Bạn có thể đóng tab này.</p>
      </body></html>
    `);

    setTimeout(() => { console.log('🔒 Đóng server.'); server.close(); process.exit(0); }, 1500);

  } catch (err) {
    console.error('❌ Lỗi:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ ${err.message}</h2>`);
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║    QuickBooks OAuth2 - Authorization Tool    ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`🚀 Server chạy tại http://localhost:${PORT}\n`);
  console.log('🌐 Đang mở trình duyệt...\n');
  console.log('   Nếu trình duyệt không tự mở, copy link này:\n');
  console.log('   ' + AUTH_URL + '\n');

  // Mở trình duyệt tự động (Windows)
  exec(`start "" "${AUTH_URL}"`, (err) => {
    if (err) console.log('ℹ️  Hãy copy link trên và mở thủ công trong Chrome.');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE')
    console.error(`❌ Port ${PORT} đang bị dùng. Đóng ứng dụng khác rồi thử lại.`);
  else
    console.error('❌', err.message);
  process.exit(1);
});
