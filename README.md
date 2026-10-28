# dsh-tunnel-control

把本机 dsh 的 Web UI 一键变成一条带密码的公网链接。开关就挂在 dsh「设置」面板里，不用记命令。

- **面板内开关**：状态灯、公网链接、访问密码、开启/关闭，全在一张卡片上
- **Cloudflare 快速隧道**：不注册域名、不要 Cloudflare 账号，每次开启给一条新的 `*.trycloudflare.com`
- **前面有密码门**：没过密码连登录页都看不到，过了门发一枚 HMAC 签名的会话 cookie，记住 7 天
- **自动代签 dsh 认证 cookie**：外部访客不用持有 launch token（那个只在 dsh 进程内存里）
- **零依赖**：只需要 Node ≥ 20，没有任何 npm 依赖

## 它怎么工作

```
公网浏览器 ──https──▶ Cloudflare 边缘 ──▶ cloudflared ──▶ 127.0.0.1:3081  密码门
                                                              │  认证通过
                                                              ▼
                                                      127.0.0.1:3080  dsh web
        ▲
        └── 设置面板那张卡片每 3 秒轮询 127.0.0.1:3082 拿状态、点按钮
```

两个端口分工：

| 端口 | 是什么 |
| --- | --- |
| `3081` | 密码门反代，cloudflared 指向它 |
| `3082` | 控制 API，只给本机页面用（`/api/state`、`/api/start`、`/api/stop`） |

密码门做三件必须做的事，少一件 dsh 就把请求顶回来：

1. **`Host` 改回 `127.0.0.1:3080`**：dsh 的 `/api` 有独立的 Host 围栏，只认回环地址或 `trustedHosts`
2. **删掉 `Origin` 与 `sec-fetch-*`**：dsh 要求 Origin 与 Host 同源，隧道域名下的 Origin 会被判跨站，`/api` 全 403
3. **注入自签的 dsh cookie**：`dsh-auth-<base64url(sha256(authority))>=v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`，`secret` 取自 `~/.dsh/.credentials.yaml` 里 `records."client-connection/browser-session".payload.secret`，`payload` 的时间戳是毫秒

WebSocket（`/api/remote.mux`，dsh 的实时通道）走 `upgrade` 事件按同一套规则透传，否则界面能开但对话不刷新。

## 安装

### 1. 准备 cloudflared

放到 `~/.dsh/tools/cloudflared.exe`（Windows）或 `~/.dsh/tools/cloudflared`（Linux/macOS），或者放进 `PATH`。

```powershell
# Windows（走镜像，GitHub 直连常常卡在 0 字节）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\tools" | Out-Null
curl.exe -L -o "$env:USERPROFILE\.dsh\tools\cloudflared.exe" `
  "https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
```

```bash
# Linux
mkdir -p ~/.dsh/tools
curl -L -o ~/.dsh/tools/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.dsh/tools/cloudflared
```

装完自检：`~/.dsh/tools/cloudflared.exe --version`。

### 2. 把插件放进 dsh 的 `@local` 目录

```bash
git clone https://github.com/Chaos-Hyper/dsh-tunnel-control.git \
  ~/.dsh/profiles/node_modules/@local/dsh-tunnel-control
```

Windows（PowerShell 版）：

```powershell
git clone https://github.com/Chaos-Hyper/dsh-tunnel-control.git `
  "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-tunnel-control"
```

要让某个 profile 也能用，把同一份目录复制一份到该 profile 的 `node_modules/@local/` 下，或直接用同一个目录（`@local` 是跨 profile 共享层，通常放在 `~/.dsh/profiles/node_modules/@local/` 就够）。

### 3. 在 profile 的 patch 里注册

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，在 `- insert:` 列表里加两行：

```yaml
- insert:
    - id: dsh-tunnel-control
      name: '@local/dsh-tunnel-control'
```

`<profile>` 是你在用的那个：`desktop` 还是 `web`，看环境变量 `DSH_PROFILE`。装完**重启 dsh**（新增 host 侧插件必须重启才进 Loader）。

### 4. 起控制服务

```bash
node ~/.dsh/profiles/node_modules/@local/dsh-tunnel-control/bin/dsh-tunnel.mjs start
```

Windows 也可以直接用仓库里的 `dsh-tunnel.cmd start`。它做的事是后台拉起 `server/control.mjs`，日志写到 `~/.dsh/logs/tunnel.log`。

### 5. 打开面板

dsh 设置面板 → 「通用设置」（Web 端）或「账号与余额」（桌面端）→ 顶部那张「远程访问」卡片 → 点「开启」。等十秒左右出现公网链接与访问密码。

## 用法

```bash
dsh-tunnel start         # 后台起控制服务
dsh-tunnel stop          # 停控制服务，连带关掉隧道
dsh-tunnel status        # 状态、公网链接、访问密码
dsh-tunnel run           # 前台跑，Ctrl+C 退出（调试）
dsh-tunnel cloudflared   # 打印 cloudflared 的下载方式
```

`dsh-tunnel` 这个命令来自 `package.json` 的 `bin`，`npm link` 或全局安装后可用；不想装就 `node bin/dsh-tunnel.mjs <命令>`，或者用 `dsh-tunnel.cmd`。

## 配置

全走环境变量，都有默认值：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | dsh 主目录，用来找 `.credentials.yaml` |
| `DSH_TUNNEL_UPSTREAM` | `http://127.0.0.1:3080` | 要暴露的 dsh web |
| `DSH_TUNNEL_GATE_PORT` | `3081` | 密码门端口 |
| `DSH_TUNNEL_CTL_PORT` | `3082` | 控制 API 端口 |
| `DSH_TUNNEL_PASSWORD` | 随机 10 位 | 固定访问密码；不设就随机生成并记住 |
| `DSH_TUNNEL_CLOUDFLARED` | 自动查找 | cloudflared 可执行文件路径 |
| `DSH_TUNNEL_PROTOCOL` | `http2` | QUIC（UDP 7844）在受限网络常被墙，走 TCP 更稳 |
| `DSH_TUNNEL_STATE_DIR` | `~/.dsh/logs` | 状态、密钥、日志的落点 |

状态文件（`tunnel-state.json`）里存着当前密码和上次的链接，密钥单独放在 `tunnel-gate.key`。两个都在你自己的 home 目录里，不要把 `~/.dsh/logs` 分享出去。

## 安全模型

说清楚它保护了什么、没保护什么：

- **保护**：任何请求先过密码门，密码错 8 次锁 1 分钟；会话 cookie 用 HMAC 签名，改一个字节就失效；控制 API 只监听 `127.0.0.1`，`POST` 还必须带 `x-control: 1` 自定义头（跨站表单打不进来），`Origin` 白名单只放回环地址和 `*.trycloudflare.com`
- **保护**：密码门的 cookie 不会转发给 dsh，dsh 拿到的是另一枚代签 cookie
- **没保护**：过门之后就是完整的 dsh web。所有会话、工作区、文件浏览权限和你本机一样。**别把密码发给不该给的人**
- **没保护**：`trycloudflare` 是 Cloudflare 的免费快速隧道，域名随机、无 SLA、随时可能断
- **没保护**：`~/.dsh/.credentials.yaml` 的 secret 被本机任何进程读到，就能伪造 dsh cookie。这是 dsh 自己的信任边界，本插件不改变它，只是使用它

日常建议：用完就点「关闭」。隧道一断，旧链接立刻失效（回 530）。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 卡片一直显示「读取状态…」 | 控制服务没起。`dsh-tunnel status` 看一眼，没跑就 `dsh-tunnel start` |
| 卡片提示「本机隧道服务未启动」 | 同上；或者控制服务换了端口，在页面注入 `window.__DSH_TUNNEL_API = "http://127.0.0.1:<端口>"` |
| 点开启后提示「找不到 cloudflared」 | 回到安装第 1 步，放到 `~/.dsh/tools/` 或写 `DSH_TUNNEL_CLOUDFLARED` |
| 公网打开一直 401 登录页 | 密码错了；或者连续错太多次被锁，等 1 分钟 |
| 密码过了但界面是 dsh 的 401 | 没读到 `.credentials.yaml` 的签名密钥，看 `tunnel.log` 里有没有「未读到 dsh cookie 签名密钥」。dsh 版本不同则字段位置可能变 |
| 公网能开首页，但对话不刷新 | WebSocket 被掐了。查 `tunnel.log`、确认走的是同一个密码门端口 |
| 隧道域名下卡片按钮是灰的 | 设计如此：https 页面不允许回连 `http://127.0.0.1`。要开关请回本机操作 |
| 刚开启时打开链接报「找不到服务器」或 `ENOTFOUND` | `trycloudflare` 的新域名要几秒到几十秒才传播完 DNS。等 20–30 秒再刷新；本机能 `Resolve-DnsName <域名>` 解析出地址了再试 |
| 白屏 | 首屏经隧道要十秒量级，先等；仍白屏就对照 `http://127.0.0.1:3080`，两边一样说明是前端自己的问题，与隧道无关 |
| 每次开启链接都变 | `trycloudflare` 免费隧道就是这样。要固定域名得换 Cloudflare named tunnel |
| `tunnel.log` 里 cloudflared 报 QUIC 失败 | 默认已用 `--protocol http2`；还是失败就查本机出网 |

## 已知限制

- 只支持 `dsh web` 与桌面宿主这两种带 Web UI 的形态，纯 CLI 用不上
- 单密码单用户，没有账号体系；要多人用就得改成多密码或对接 SSO
- 每次开启域名都变，长连接会被打断
- 只做 HTTP 与 WebSocket 透传，不做流式响应改写与前端产物注入
- 需要 Node ≥ 20（用到 `fetch`、`AbortSignal.timeout`、`base64url` 编码）

## 目录结构

```
lib/client.js        设置面板里的卡片（浏览器端注入，Shadow DOM 隔离样式）
lib/index.js         占位 apply，只为了让插件进 Loader
server/control.mjs   控制服务：管理 cloudflared、给卡片供数据
server/gateway.mjs   密码门反代：认证、改 Host/Origin、代签 dsh cookie、透传 WebSocket
bin/dsh-tunnel.mjs   命令行：start / stop / status / run
dsh-tunnel.cmd       Windows 快捷入口
```

## License

MIT，见 [LICENSE](LICENSE)。
