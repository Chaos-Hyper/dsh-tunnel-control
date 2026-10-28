// 密码门反代：把公网请求挡在一道密码后面，通过后转给本机 dsh web。
//
// 三件事：
//   1. 未认证 → 登录页；认证成功 → HMAC 会话 cookie
//   2. 转发前把 Host 改回 upstream，删掉 Origin / sec-fetch-*（否则 dsh 的
//      Host·Origin 同源围栏一律 403）
//   3. 注入一枚自签的 dsh 认证 cookie，让外部访客不必持有 launch token
//      （launch token 只在 dsh 进程内存里，外部拿不到）
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const GATE_COOKIE = 'dsh-gate';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILURES = 8;
const LOCK_MS = 60 * 1000;

/**
 * 自签一枚 dsh 的浏览器认证 cookie。
 * 实测格式（dsh 2026.10 / lib/types/browser-auth.js）：
 *   cookie 名 = "dsh-auth-" + base64url(sha256(authority))
 *   cookie 值 = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, base64url(JSON payload)))
 *   payload   = { version: 1, authority, issuedAt, expiresAt }，时间戳是 **毫秒**
 */
export function signDshCookie(secret, authority, ttlMs = SESSION_TTL_MS) {
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + ttlMs };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
  return `${name}=v1.${body}.${sig}`;
}

function b64url(text) {
  return Buffer.from(text).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const LOGIN_PAGE = (message) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要密码</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    background:#0f1115;color:#e6e8ec}
  form{width:100%;max-width:340px;padding:26px 24px;border-radius:16px;
    border:1px solid rgba(148,163,184,.22);background:rgba(148,163,184,.06)}
  h1{margin:0 0 6px;font-size:17px;font-weight:650}
  p.sub{margin:0 0 18px;font-size:12.5px;color:#94a3b8}
  input{width:100%;padding:10px 12px;border-radius:10px;font:inherit;
    border:1px solid rgba(148,163,184,.32);background:rgba(15,17,21,.6);color:inherit}
  input:focus{outline:none;border-color:#2563eb}
  button{margin-top:12px;width:100%;padding:10px 12px;border:0;border-radius:10px;
    font:inherit;font-weight:650;color:#fff;background:#2563eb;cursor:pointer}
  button:hover{background:#1d4ed8}
  .err{margin:10px 0 0;font-size:12.5px;color:#f87171;min-height:18px}
</style></head>
<body>
<form method="post" action="/__gateway/login">
  <h1>远程访问 dsh</h1>
  <p class="sub">这台 dsh 在密码门后面，请输入访问密码。</p>
  <input type="password" name="password" placeholder="访问密码" autocomplete="current-password" autofocus required>
  <button type="submit">进入</button>
  <p class="err">${message || ''}</p>
</form>
</body></html>`;

/**
 * @param {object} opts
 * @param {string} opts.host        监听地址（默认 127.0.0.1）
 * @param {number} opts.port        监听端口
 * @param {string} opts.upstream    要暴露的本机地址，如 http://127.0.0.1:3080
 * @param {string} opts.password    访问密码
 * @param {Buffer} opts.key         会话 cookie 的 HMAC 密钥（32 字节）
 * @param {Buffer|null} opts.dshSecret  dsh cookie 签名密钥，读不到就传 null
 * @param {(msg: string) => void} [opts.log]
 */
export function createGate(opts) {
  const host = opts.host || '127.0.0.1';
  const upstream = new URL(opts.upstream);
  const upHost = upstream.hostname;
  const upPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  const authority = `${upHost}:${upPort}`;
  const key = opts.key;
  const password = opts.password;
  const log = opts.log || (() => {});
  const dshCookie = opts.dshSecret ? signDshCookie(opts.dshSecret, authority) : '';

  const failures = new Map();

  function issueSession() {
    const body = b64url(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }));
    const sig = createHmac('sha256', key).update(body).digest('base64url');
    return `${GATE_COOKIE}=v1.${body}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  function sessionOk(cookies) {
    const raw = cookies[GATE_COOKIE];
    if (!raw || !raw.startsWith('v1.')) return false;
    const rest = raw.slice(3);
    const dot = rest.lastIndexOf('.');
    if (dot < 0) return false;
    const body = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);
    const want = createHmac('sha256', key).update(body).digest('base64url');
    if (!safeEqual(sig, want)) return false;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return typeof payload.exp === 'number' && payload.exp > Date.now();
    } catch {
      return false;
    }
  }

  function clientIp(req) {
    return req.socket.remoteAddress || '?';
  }

  function locked(ip) {
    const rec = failures.get(ip);
    if (!rec) return false;
    if (rec.count < MAX_FAILURES) return false;
    if (Date.now() - rec.at > LOCK_MS) {
      failures.delete(ip);
      return false;
    }
    return true;
  }

  function noteFailure(ip) {
    const rec = failures.get(ip) || { count: 0, at: 0 };
    rec.count += 1;
    rec.at = Date.now();
    failures.set(ip, rec);
  }

  function sendPage(res, status, message, extraHeaders = {}) {
    const html = LOGIN_PAGE(message);
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html),
      ...extraHeaders,
    });
    res.end(html);
  }

  function proxyHeaders(req) {
    const headers = { ...req.headers };
    delete headers.origin;
    delete headers['sec-fetch-site'];
    delete headers['sec-fetch-mode'];
    delete headers['sec-fetch-dest'];
    delete headers.host;
    headers.host = authority;
    // 只把 dsh 自己的 cookie 递进去，密码门的 cookie 不外传。
    const incoming = parseCookies(req.headers.cookie);
    delete incoming[GATE_COOKIE];
    const parts = Object.entries(incoming).map(([k, v]) => `${k}=${v}`);
    if (dshCookie) parts.push(dshCookie);
    if (parts.length) headers.cookie = parts.join('; ');
    else delete headers.cookie;
    return headers;
  }

  function forward(req, res) {
    const proxy = request(
      { host: upHost, port: upPort, method: req.method, path: req.url, headers: proxyHeaders(req) },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    proxy.on('error', (err) => {
      log(`upstream 请求失败：${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`上游 ${authority} 连不上：${err.message}\ndsh web 起来了吗？`);
      } else {
        res.destroy();
      }
    });
    req.pipe(proxy);
  }

  const server = createServer((req, res) => {
    const ip = clientIp(req);

    if (req.method === 'POST' && req.url === '/__gateway/login') {
      if (locked(ip)) return sendPage(res, 429, '尝试次数过多，请等一分钟再来。');
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 4096) req.destroy();
      });
      req.on('end', () => {
        const given = new URLSearchParams(raw).get('password') || '';
        if (!safeEqual(given, password)) {
          noteFailure(ip);
          log(`密码错误：${ip}`);
          return sendPage(res, 401, '密码不对，请再试一次。');
        }
        failures.delete(ip);
        log(`密码通过：${ip}`);
        res.writeHead(303, { location: '/', 'set-cookie': issueSession(), 'cache-control': 'no-store' });
        res.end();
      });
      return;
    }

    if (req.url === '/__gateway/logout') {
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${GATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (!sessionOk(parseCookies(req.headers.cookie))) return sendPage(res, 401, '');

    forward(req, res);
  });

  // WebSocket：dsh 的实时通道复用同一个 cookie，必须走同一条改写规则透传。
  server.on('upgrade', (req, socket, head) => {
    if (!sessionOk(parseCookies(req.headers.cookie))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const headers = proxyHeaders(req);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
      else lines.push(`${k}: ${v}`);
    }
    const rawHead = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8');

    const up = connect(upPort, upHost, () => {
      up.write(rawHead);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => {
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'); } catch { /* 已断开 */ }
      socket.destroy();
    });
    socket.on('error', () => up.destroy());
  });

  return {
    authority,
    hasDshCookie: Boolean(dshCookie),
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, host, () => resolve(`http://${host}:${opts.port}`));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export { GATE_COOKIE };
