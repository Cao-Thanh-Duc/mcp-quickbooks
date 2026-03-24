/**
 * QuickBooks OAuth2 Authorization Script
 * Chạy: node qb-auth.js
 * Yêu cầu: Node.js >= 18, file .env đã có CLIENT_ID và CLIENT_SECRET
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// ─── Đọc .env thủ công (không cần thư viện dotenv) ───────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ Không tìm thấy file .env bên cạnh script này!');
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    env[key] = val;
  }
  return env;
}

const env = loadEnv();

const CLIENT_ID     = env.QUICKBOOKS_CLIENT_ID;
const CLIENT_SECRET = env.QUICKBOOKS_CLIENT_SECRET;
const REDIRECT_URI  = env.QUICKBOOKS_REDIRECT_URI || 'http://localhost:3000/callback';
const ENVIRONMENT   = env.QUICKBOOKS_ENVIRONMENT  || 'sandbox';
const PORT          = 3000;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ QUICKBOOKS_CLIENT_ID hoặc QUICKBOOKS_CLIENT_SECRET chưa có trong .env');
  process.exit(1);
}

// ─── Tạo Authorization URL ─────────────────────────────────────────────────
const STATE = 'qbo_auth_' + Math.random().toString(36).slice(2);
const AUTH_URL =
  'https://appcenter.intuit.com/connect/oauth2' +
  '?client_id='    + encodeURIComponent(CLIENT_ID) +
  '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
  '&response_type=code' +
  '&scope='        + encodeURIComponent('com.intuit.quickbooks.accounting') +
  '&state='        + STATE;

// ─── Đổi Authorization Code → Tokens ──────────────────────────────────────
function exchangeCodeForTokens(code, realmId) {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    const options = {
      hostname: 'oauth.platform.intuit.com',
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error_description || parsed.error));
          else resolve({ ...parsed, realmId });
        } catch (e) {
          reject(new Error('Không parse được response: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Cập nhật file .env với tokens mới ────────────────────────────────────
function updateEnvFile(tokens) {
  const envPath = path.join(__dirname, '.env');
  let content = fs.readFileSync(envPath, 'utf8');

  const updates = {
    QUICKBOOKS_REALM_ID:      tokens.realmId,
    QUICKBOOKS_ACCESS_TOKEN:  tokens.access_token,
    QUICKBOOKS_REFRESH_TOKEN: tokens.refresh_token,
  };

  for (const [key, value] of Object.entries(updates)) {
    if (content.includes(key + '=')) {
      content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(envPath, content, 'utf8');
  console.log('✅ Đã cập nhật file .env với tokens mới!');
}

// ─── Khởi động HTTP Server ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const { code, state, realmId, error } = parsed.query;

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Lỗi Authorization: ${error}</h2>`);
    server.close();
    return;
  }

  if (state !== STATE) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>❌ State không khớp — có thể bị tấn công CSRF!</h2>');
    server.close();
    return;
  }

  console.log('\n⏳ Đang đổi authorization code lấy tokens...');

  try {
    const tokens = await exchangeCodeForTokens(code, realmId);

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║              ✅ AUTHORIZATION THÀNH CÔNG!               ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║ Realm ID:      ${tokens.realmId}`);
    console.log(`║ Access Token:  ${tokens.access_token.slice(0, 40)}...`);
    console.log(`║ Refresh Token: ${tokens.refresh_token.slice(0, 40)}...`);
    console.log(`║ Hết hạn sau:   ${tokens.expires_in} giây (~1 giờ)`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    updateEnvFile(tokens);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fff4">
        <h1 style="color:#22c55e">✅ Authorization thành công!</h1>
        <p>Tokens đã được lưu vào file <strong>.env</strong></p>
        <p>Bạn có thể đóng tab này và quay lại VS Code.</p>
        <hr/>
        <p><strong>Realm ID:</strong> ${tokens.realmId}</p>
      </body></html>
    `);

    setTimeout(() => {
      console.log('🔒 Đóng auth server.');
      server.close();
      process.exit(0);
    }, 2000);

  } catch (err) {
    console.error('❌ Lỗi khi đổi token:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Lỗi: ${err.message}</h2>`);
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         QuickBooks OAuth2 Authorization Server          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n🚀 Server đang chạy tại http://localhost:${PORT}`);
  console.log('\n📋 Mở link sau trong trình duyệt để đăng nhập QuickBooks:\n');
  console.log('   ' + AUTH_URL);
  console.log('\n⏳ Đang chờ callback từ QuickBooks...\n');

  // Thử tự động mở trình duyệt (Windows)
  try {
    const { exec } = require('child_process');
    exec(`start "" "${AUTH_URL}"`);
    console.log('🌐 Đã tự động mở trình duyệt!');
  } catch (e) {
    console.log('ℹ️  Hãy copy link trên và mở thủ công trong trình duyệt.');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} đang bị chiếm dụng. Đóng ứng dụng khác dùng port này rồi thử lại.`);
  } else {
    console.error('❌ Server error:', err.message);
  }
  process.exit(1);
});
