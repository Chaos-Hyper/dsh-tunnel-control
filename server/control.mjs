#!/usr/bin/env node
// 隧道控制服务：设置面板里那张「远程访问」卡片的后端。
//
//   127.0.0.1:3082  控制 API（卡片轮询这个端口）：state / start / stop
//   127.0.0.1:3081  密码门反代 → 本机 dsh web（cloudflared 指向这里）
//
// 数据全部落在 state 文件里，卡片读的是内存态，进程重启后按文件恢复。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createGate } from './gateway.mjs';

// ── 配置 ────────────────────────────────────────────────────────────────
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const num = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const CFG = {
  upstream: process.env.DSH_TUNNEL_UPSTREAM || 'http://127.0.0.1:3080',
  gatePort: num('DSH_TUNNEL_GATE_PORT', 3081),
  ctlPort: num('DSH_TUNNEL_CTL_PORT', 3082),
  stateDir: process.env.DSH_TUNNEL_STATE_DIR || join(HOME, 'logs'),
  cloudflared: process.env.DSH_TUNNEL_CLOUDFLARED || '',
  protocol: process.env.DSH_TUNNEL_PROTOCOL || 'http2',
  fixedPassword: process.env.DSH_TUNNEL_PASSWORD || '',
  host: '127.0.0.1',
};

const STATE_FILE = join(CFG.stateDir, 'tunnel-state.json');
const KEY_FILE = join(CFG.stateDir, 'tunnel-gate.key');
const PID_FILE = join(CFG.stateDir, 'tunnel-control.pid');
const LOG_FILE = join(CFG.stateDir, 'tunnel.log');

mkdirSync(CFG.stateDir, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* 日志写不进去不影响主流程 */ }
  process.stdout.write(line);
}

function readJson(file, fallback) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

// ── 运行态 ──────────────────────────────────────────────────────────────
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomPassword(len = 10) {
  let out = '';
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function loadKey() {
  try {
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    if (raw.length >= 32) return Buffer.from(raw, 'base64url');
  } catch { /* 首次运行，下面生成 */ }
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key.toString('base64url'), 'utf8');
  return key;
}

/** 读 dsh web 的 cookie 签名密钥：.credentials.yaml → records."client-connection/browser-session".payload.secret */
function readDshSecret() {
  const file = join(HOME, '.credentials.yaml');
  if (!existsSync(file)) return null;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('client-connection/browser-session'));
  if (start < 0) return null;
  const baseIndent = lines[start].match(/^\s*/)[0].length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;
    const m = line.match(/^\s*secret:\s*(\S+)\s*$/);
    if (m) return Buffer.from(m[1], 'base64url');
  }
  return null;
}

const saved = readJson(STATE_FILE, {});
const state = {
  online: false,
  busy: false,
  url: '',
  password: CFG.fixedPassword || saved.password || randomPassword(),
  message: saved.message || '',
};

/** @type {import('node:child_process').ChildProcess | null} */
let tunnel = null;
let startTimer = null;
let stopping = false;

function publicState() {
  return {
    online: state.online,
    busy: state.busy,
    url: state.url,
    password: state.password,
    message: state.message,
  };
}

function persist() {
  writeJson(STATE_FILE, {
    online: state.online,
    url: state.url,
    password: state.password,
    message: state.message,
    updatedAt: Date.now(),
  });
}

function settle(message) {
  state.busy = false;
  state.message = message;
  persist();
}

// ── cloudflared ─────────────────────────────────────────────────────────
function findCloudflared() {
  if (CFG.cloudflared) return CFG.cloudflared;
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const candidate of [join(HOME, 'tools', name), join(HOME, 'tools', 'cloudflared', name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return name; // 交给 PATH
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function startTunnel() {
  if (state.busy) return { accepted: false, reason: '正在处理上一个操作' };
  if (tunnel) return { accepted: false, reason: '隧道已在运行' };

  state.busy = true;
  state.message = '正在建立隧道…';
  persist();

  const bin = findCloudflared();
  const target = `http://${CFG.host}:${CFG.gatePort}`;
  log(`启动 cloudflared：${bin} → ${target}`);

  let child;
  try {
    child = spawn(
      bin,
      ['tunnel', '--url', target, '--no-autoupdate', '--protocol', CFG.protocol],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    settle(`启动 cloudflared 失败：${err.message}`);
    return { accepted: true };
  }
  tunnel = child;
  stopping = false;

  let matched = '';
  const scan = (chunk) => {
    appendFileSync(LOG_FILE, chunk);
    if (matched) return;
    const hit = chunk.toString('utf8').match(URL_RE);
    if (!hit) return;
    matched = hit[0];
    clearTimeout(startTimer);
    state.online = true;
    state.url = matched;
    log(`隧道已上线：${matched}`);
    settle('隧道已开启，外部可访问');
  };

  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('error', (err) => {
    clearTimeout(startTimer);
    tunnel = null;
    state.online = false;
    state.url = '';
    if (err.code === 'ENOENT') {
      settle('找不到 cloudflared，请先下载放到 ~/.dsh/tools/ 或加进 PATH（见 README）');
    } else {
      settle(`cloudflared 启动失败：${err.message}`);
    }
  });

  child.on('exit', (code) => {
    clearTimeout(startTimer);
    tunnel = null;
    state.online = false;
    state.url = '';
    if (stopping) settle('隧道已关闭');
    else settle(`隧道进程退出（code ${code}）`);
    log(`cloudflared 退出，code=${code}`);
  });

  startTimer = setTimeout(() => {
    if (state.online) return;
    settle('建立隧道超时（60 秒没拿到公网链接），请查看 tunnel.log');
    stopTunnel();
  }, 60_000);

  return { accepted: true };
}

function stopTunnel() {
  if (state.busy && !tunnel) return { accepted: false, reason: '正在处理上一个操作' };
  if (!tunnel) {
    state.online = false;
    state.url = '';
    settle('隧道本来就没在运行');
    return { accepted: true };
  }
  state.busy = true;
  state.message = '正在关闭…';
  persist();
  stopping = true;

  const child = tunnel;
  const pid = child.pid;
  log(`关闭 cloudflared pid=${pid}`);
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 3000).unref();
    }
  } catch (err) {
    settle(`关闭失败：${err.message}`);
    return { accepted: true };
  }

  // exit 事件负责收尾；这里兜住「进程已消失但事件没来」的情况。
  setTimeout(() => {
    if (stopping && !tunnel) return;
    if (stopping) {
      tunnel = null;
      state.online = false;
      state.url = '';
      settle('隧道已关闭');
    }
  }, 5000).unref();

  return { accepted: true };
}

// ── 控制 API（只给本机页面用）──────────────────────────────────────────
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const TUNNEL_ORIGIN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

function originAllowed(origin) {
  if (!origin) return false;
  return LOOPBACK.test(origin) || TUNNEL_ORIGIN.test(origin);
}

function cors(res, origin) {
  if (!originAllowed(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'x-control, content-type');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'origin');
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const control = createServer((req, res) => {
  const origin = req.headers.origin || '';
  cors(res, origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(originAllowed(origin) ? 204 : 403);
    res.end();
    return;
  }

  if (req.url === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, publicState());
  }

  if (req.method === 'POST' && (req.url === '/api/start' || req.url === '/api/stop')) {
    // 自定义头挡掉浏览器简单请求（跨站表单/图片打不进来）。
    if (req.headers['x-control'] !== '1') return sendJson(res, 403, { error: 'missing x-control' });
    if (origin && !originAllowed(origin)) return sendJson(res, 403, { error: 'origin not allowed' });

    const result = req.url === '/api/start' ? startTunnel() : stopTunnel();
    return sendJson(res, 200, { ...result, state: publicState() });
  }

  sendJson(res, 404, { error: 'not found' });
});

// ── 启动 ────────────────────────────────────────────────────────────────
const key = loadKey();
const dshSecret = readDshSecret();
const gate = createGate({
  host: CFG.host,
  port: CFG.gatePort,
  upstream: CFG.upstream,
  password: state.password,
  key,
  dshSecret,
  log,
});

const ready = await gate.listen();
log(`密码门就绪：${ready} → ${CFG.upstream}`);
log(dshSecret ? '已读到 dsh cookie 签名密钥，外部访问会代签认证 cookie' : '未读到 dsh cookie 签名密钥，外部访问可能停在 401');

if (!state.message) state.message = '就绪 · 尚未开启';
persist();

await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(CFG.ctlPort, CFG.host, resolve);
});
log(`控制服务就绪：http://${CFG.host}:${CFG.ctlPort}/api/state`);
writeFileSync(PID_FILE, String(process.pid), 'utf8');

function shutdown(signal) {
  log(`收到 ${signal}，准备退出`);
  try {
    if (tunnel) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(tunnel.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        tunnel.kill('SIGTERM');
      }
    }
  } catch { /* 忽略 */ }
  state.online = false;
  state.url = '';
  persist();
  try { writeFileSync(PID_FILE, '', 'utf8'); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
