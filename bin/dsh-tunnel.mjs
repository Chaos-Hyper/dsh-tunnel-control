#!/usr/bin/env node
// dsh-tunnel — 命令行入口。
//   dsh-tunnel start    后台起控制服务（面板卡片就有数据了）
//   dsh-tunnel stop     停控制服务（连带关掉隧道）
//   dsh-tunnel status   看一眼现在的状态
//   dsh-tunnel run      前台跑，Ctrl+C 退出（调试用）
//   dsh-tunnel help     这份说明
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROL = join(HERE, '..', 'server', 'control.mjs');

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_DIR = process.env.DSH_TUNNEL_STATE_DIR || join(HOME, 'logs');
const STATE_FILE = join(STATE_DIR, 'tunnel-state.json');
const PID_FILE = join(STATE_DIR, 'tunnel-control.pid');
const CTL_PORT = Number(process.env.DSH_TUNNEL_CTL_PORT || 3082);

const isWin = process.platform === 'win32';

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function pid() {
  try {
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

function alive(pidValue) {
  if (!pidValue) return false;
  try {
    process.kill(pidValue, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(pidValue) {
  if (!pidValue) return false;
  try {
    if (isWin) {
      spawn('taskkill', ['/PID', String(pidValue), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pidValue, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

async function remoteState() {
  try {
    const res = await fetch(`http://127.0.0.1:${CTL_PORT}/api/state`, { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return null;
  }
}

const commands = {
  start() {
    const running = pid();
    if (alive(running)) {
      console.log(`控制服务已在运行（pid ${running}）`);
      return;
    }
    if (!existsSync(CONTROL)) {
      console.error(`找不到 ${CONTROL}`);
      process.exitCode = 1;
      return;
    }
    const child = spawn(process.execPath, [CONTROL], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    // 等它把端口监听起来再报成功，避免用户看到「启动了但卡片还是空」。
    const deadline = Date.now() + 8000;
    const poll = setInterval(async () => {
      const s = await remoteState();
      if (s) {
        clearInterval(poll);
        console.log(`控制服务已启动（pid ${child.pid}）`);
        console.log(`  控制 API  http://127.0.0.1:${CTL_PORT}/api/state`);
        console.log(`  日志       ${join(STATE_DIR, 'tunnel.log')}`);
        console.log('到 dsh 设置面板里点「开启」即可拿到公网链接。');
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        console.error(`控制服务没起来，看日志：${join(STATE_DIR, 'tunnel.log')}`);
        process.exitCode = 1;
      }
    }, 300);
  },

  async stop() {
    const running = pid();
    if (!alive(running)) {
      writeFileSync(PID_FILE, '', 'utf8');
      console.log('控制服务没在运行');
      return;
    }
    kill(running);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!alive(running)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(alive(running) ? `没能停下 pid ${running}，请手动结束` : '控制服务已停止');
  },

  async status() {
    const running = pid();
    const s = await remoteState();
    const saved = readJson(STATE_FILE, {});
    console.log(`控制服务  ${alive(running) ? `运行中 (pid ${running})` : '未运行'}`);
    if (s) {
      console.log(`隧道      ${s.online ? '已开启' : '已关闭'}${s.busy ? '（处理中）' : ''}`);
      if (s.url) console.log(`公网链接  ${s.url}`);
      if (s.password) console.log(`访问密码  ${s.password}`);
      if (s.message) console.log(`提示      ${s.message}`);
    } else if (saved.url) {
      console.log(`上次记录  ${saved.url}（服务未运行，链接已失效）`);
    }
  },

  run() {
    const child = spawn(process.execPath, [CONTROL], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => { process.exitCode = code ?? 0; });
  },

  cloudflared() {
    console.log(`cloudflared 放在 ${join(HOME, 'tools', isWin ? 'cloudflared.exe' : 'cloudflared')}，或者加进 PATH。`);
    console.log('');
    if (isWin) {
      console.log('Windows（PowerShell，走镜像）：');
      console.log('  New-Item -ItemType Directory -Force "$env:USERPROFILE\\.dsh\\tools" | Out-Null');
      console.log('  curl.exe -L -o "$env:USERPROFILE\\.dsh\\tools\\cloudflared.exe" "https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"');
    } else {
      console.log('Linux：');
      console.log('  curl -L -o ~/.dsh/tools/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
      console.log('  chmod +x ~/.dsh/tools/cloudflared');
    }
  },

  help() {
    console.log(`用法：dsh-tunnel <命令>

  start        后台起控制服务（dsh 设置面板里的「远程访问」卡片随之可用）
  stop         停控制服务，连带关掉隧道
  status       查看状态、公网链接与访问密码
  run          前台运行（调试用，Ctrl+C 退出）
  cloudflared  打印 cloudflared 的下载方式

环境变量（都有默认值）：
  DSH_HOME                  默认 ~/.dsh
  DSH_TUNNEL_UPSTREAM       默认 http://127.0.0.1:3080（要暴露的 dsh web）
  DSH_TUNNEL_GATE_PORT      默认 3081（密码门）
  DSH_TUNNEL_CTL_PORT       默认 3082（控制 API）
  DSH_TUNNEL_PASSWORD       固定访问密码；不给就随机生成并记住
  DSH_TUNNEL_CLOUDFLARED    cloudflared 可执行文件路径
  DSH_TUNNEL_PROTOCOL       默认 http2（QUIC 常被墙）
  DSH_TUNNEL_STATE_DIR      状态与日志目录，默认 ~/.dsh/logs`);
  },
};

const name = process.argv[2] || 'status';
const fn = commands[name];
if (!fn) {
  commands.help();
  process.exitCode = 1;
} else {
  await fn();
}
