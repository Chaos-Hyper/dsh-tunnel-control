// @local/dsh-tunnel-control — dsh web「设置」面板内的远程访问开关。
//
// 一段浏览器端注入：找到设置面板的内容区，在最上面挂一张卡片，
// 显示隧道状态、公网链接与访问密码，并提供「开启 / 关闭」两个按钮。
// 数据来自本机 127.0.0.1:3082 的隧道控制服务。
// 经外部隧道访问时浏览器禁止页面回连本机 HTTP，卡片会提示去本机操作。
(function () {
  // 加载器缺失时静默退出，绝不把异常抛进同一批合并 bundle。
  var loader = window.__ModuleLoader__;
  if (!loader || typeof loader.load !== "function") return;

  loader.load({
  id: "@local/dsh-tunnel-control",
  factory: function () {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // 控制服务地址：默认 3082。控制服务换了端口时，在页面里注入
    // window.__DSH_TUNNEL_API = "http://127.0.0.1:其他端口" 即可覆盖。
    var API = (typeof window.__DSH_TUNNEL_API === "string" && window.__DSH_TUNNEL_API)
      || "http://127.0.0.1:3082";
    var CARD_ID = "dsh-tunnel-control-card";
    var POLL_MS = 3000;

    var CSS = [
      ":host{all:initial;display:block}",
      ".card{box-sizing:border-box;margin:10px 0 14px;padding:14px 16px;border-radius:12px;",
      "border:1px solid rgba(127,137,153,.28);font:13px/1.55 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;",
      "color:inherit;background:rgba(127,137,153,.07)}",
      ".head{display:flex;align-items:center;gap:10px;margin-bottom:10px}",
      ".dot{width:8px;height:8px;border-radius:50%;background:#94a3b8;flex:0 0 auto}",
      ".dot.on{background:#22c55e}.dot.busy{background:#f59e0b}",
      ".ttl{flex:1;min-width:0}",
      ".ttl b{display:block;font-size:13.5px;font-weight:600}",
      ".ttl span{display:block;font-size:12px;opacity:.66;margin-top:1px}",
      ".row{display:flex;gap:8px;flex-wrap:wrap}",
      "button{font:inherit;font-weight:600;border-radius:9px;cursor:pointer;padding:7px 14px;",
      "border:1px solid transparent;transition:.15s}",
      "button:disabled{opacity:.42;cursor:not-allowed}",
      ".start{background:#2563eb;color:#fff}.start:hover:not(:disabled){background:#1d4ed8}",
      ".stop{background:transparent;color:#ef4444;border-color:rgba(239,68,68,.42)}",
      ".stop:hover:not(:disabled){background:rgba(239,68,68,.1)}",
      ".msg{font-size:12px;opacity:.72;min-height:17px;margin:6px 0 0}",
      ".msg.good{color:#16a34a;opacity:1}.msg.bad{color:#ef4444;opacity:1}",
      ".field{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;border-radius:8px;",
      "border:1px solid rgba(127,137,153,.24);background:rgba(127,137,153,.06)}",
      ".field .k{opacity:.66;font-size:12px;flex:0 0 auto}",
      ".field code{flex:1;min-width:0;font:12px/1.45 ui-monospace,Consolas,monospace;word-break:break-all}",
      ".mini{font-size:11.5px;font-weight:500;padding:4px 9px;border-radius:7px;cursor:pointer;",
      "border:1px solid rgba(127,137,153,.34);background:transparent;color:inherit;opacity:.85}",
      ".mini:hover{opacity:1;border-color:#2563eb}",
      ".hint{margin:10px 0 0;font-size:11.5px;opacity:.56;line-height:1.5}",
    ].join("\n");

    var HTML = [
      '<div class="card">',
      '  <div class="head">',
      '    <span class="dot"></span>',
      '    <div class="ttl"><b>远程访问</b><span class="sub">读取状态…</span></div>',
      '    <div class="row"><button class="start" type="button">开启</button><button class="stop" type="button">关闭</button></div>',
      '  </div>',
      '  <div class="msg"></div>',
      '  <div class="field"><span class="k">公网链接</span><code class="url">—</code><button class="mini copyUrl" type="button">复制</button></div>',
      '  <div class="field"><span class="k">访问密码</span><code class="pwd">••••••••</code><button class="mini peek" type="button">显示</button><button class="mini copyPwd" type="button">复制</button></div>',
      '  <p class="hint">通过 Cloudflare 隧道把本机 dsh 暴露成临时公网链接：每次开启生成新的随机域名，关闭后旧链接立即失效。</p>',
      '</div>',
    ].join("\n");

    var host = null;
    var shadow = null;
    var ticker = 0;
    var remoteMode = false;
    var snap = { online: false, busy: false, url: "", password: "", message: "", peek: false };

    /**
     * 是不是本机页面。
     * 桌面宿主的文档 origin 是 dsh-app://app —— 宿主用
     * protocol.registerSchemesAsPrivileged({ scheme: "dsh-app",
     * privileges: { standard: true, secure: true, corsEnabled: true } })
     * 注册的自有 scheme，所以 location.hostname 是 "app"，既不是回环地址，
     * 也不是外部链接。桌面端恒为本机，先按 dshDesktop 桥判定。
     */
    function localMode() {
      if (isDesktop()) return true;
      var h = location.hostname;
      return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
    }

    function q(sel) { return shadow ? shadow.querySelector(sel) : null; }

    /* 桌面端带 dshDesktop 桥；Web 端（dsh web / 浏览器直连）没有。 */
    function isDesktop() {
      try { return "dshDesktop" in globalThis; } catch (e) { return false; }
    }

    /** 卡片应归属的板块：桌面端 → 账号与余额；Web 端 → 通用设置。 */
    function targetSection() {
      return isDesktop() ? "account" : "general";
    }

    /**
     * 设置面板：带导航栏与板块内容槽口的 dialog。
     * 板块内容槽口是 data-slot="settings.section"，它由渲染器给出，跨版本稳定。
     */
    function settingsPanel() {
      var panels = document.querySelectorAll('div[role="dialog"]');
      for (var i = 0; i < panels.length; i++) {
        var panel = panels[i];
        if (!panel.querySelector('[data-slot="settings.section"]')) continue;
        if (!panel.querySelector("nav")) continue;
        return panel;
      }
      return null;
    }

    /** 当前选中板块的导航标签文本。 */
    function activeNavLabel(panel) {
      var current = panel.querySelector('nav button[aria-current="true"]');
      if (!current) return "";
      var span = current.querySelector("span");
      return (span ? span.textContent : current.textContent) || "";
    }

    /**
     * 当前渲染出来的板块属于哪一类：
     *   general → 通用设置（内容区里有 settings.general.item 子槽口）
     *   account → 账号与余额（内容区是一个 aria-label 等于导航标题的 section）
     *   其它 → null
     */
    function currentSectionKind(panel) {
      var outlet = panel.querySelector('[data-slot="settings.section"]');
      if (!outlet) return null;
      if (outlet.querySelector('[data-slot="settings.general.item"]')) return "general";
      var label = activeNavLabel(panel);
      if (!label) return null;
      var sections = outlet.querySelectorAll("section[aria-label]");
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].getAttribute("aria-label") === label) return "account";
      }
      return null;
    }

    /**
     * 目标板块在导航里的下标。桌面端 → 账号与余额，Web 端 → 通用设置。
     * 找不到时回退到另一个已知板块，保证卡片永远只落在一个板块里；
     * 两个都没有（部署裁剪掉了这两块）就返回 -1，卡片隐藏。
     */
    function targetNavIndex(panel) {
      var items = panel.querySelectorAll("nav button");
      var preferred = targetSection();
      var fallback = preferred === "account" ? "general" : "account";
      var labels = { account: "账号与余额", general: "通用设置" };
      var order = [preferred, fallback];
      for (var o = 0; o < order.length; o++) {
        for (var i = 0; i < items.length; i++) {
          if ((items[i].textContent ?? "").trim() === labels[order[o]]) return i;
        }
      }
      return -1;
    }

    /** 目标板块是否就是当前选中的板块。 */
    function isTargetActive(panel) {
      var items = panel.querySelectorAll("nav button");
      var index = targetNavIndex(panel);
      if (index < 0) return false;
      var current = panel.querySelector('nav button[aria-current="true"]');
      if (!current) return false;
      return items[index] === current;
    }
    function paint() {
      if (!shadow) return;
      var e = {
        dot: q(".head .dot"), sub: q(".head .sub"), url: q(".url"), pwd: q(".pwd"),
        msg: q(".msg"), start: q(".start"), stop: q(".stop"), peek: q(".peek"),
      };
      var busy = !!snap.busy;
      var online = !!snap.online;
      e.dot.className = "dot" + (busy ? " busy" : online ? " on" : "");
      e.sub.textContent = busy ? "处理中…" : online ? "运行中 · 外部可访问" : "已关闭 · 外部不可访问";
      e.url.textContent = online ? snap.url : "—";
      e.pwd.textContent = snap.peek ? (snap.password || "—") : "••••••••";
      e.peek.textContent = snap.peek ? "隐藏" : "显示";
      var locked = busy || remoteMode;
      e.start.disabled = locked || online;
      e.stop.disabled = locked || !online;
      var text = snap.message;
      if (!text && remoteMode) text = "当前是外部链接访问，开关请在运行 dsh 的那台机器的设置里操作。";
      e.msg.textContent = text || "";
      e.msg.className = "msg" + (busy || remoteMode ? "" : online ? " good" : "");
    }

    function api(path, options) {
      return fetch(API + path, Object.assign({ cache: "no-store" }, options || {})).then(function (r) { return r.json(); });
    }

    function refresh() {
      if (remoteMode) { paint(); return Promise.resolve(); }
      return api("/api/state").then(function (s) {
        snap = Object.assign({}, s, { peek: snap.peek });
        paint();
      }).catch(function () {
        snap = Object.assign({}, snap, { online: false, busy: false, message: "本机隧道服务未启动：请先在命令行运行 dsh-tunnel start" });
        paint();
      });
    }

    function startTicker() {
      if (ticker || remoteMode) return;
      ticker = setInterval(function () {
        if (!host || !document.contains(host)) { stopTicker(); return; }
        refresh();
      }, POLL_MS);
    }
    function stopTicker() { if (ticker) { clearInterval(ticker); ticker = 0; } }

    function act(kind) {
      if (remoteMode) return;
      snap.busy = true;
      snap.message = kind === "start" ? "正在建立隧道…" : "正在关闭…";
      paint();
      api("/api/" + kind, { method: "POST", headers: { "x-control": "1" } })
        .then(function (res) {
          if (res && res.state) snap = Object.assign({}, res.state, { peek: snap.peek, message: res.message });
          return refresh();
        })
        .then(function () { paint(); })
        .catch(function (err) {
          snap.busy = false;
          snap.message = "操作失败：" + (err && err.message ? err.message : "未知错误");
          paint();
        });
    }

    function copy(text) {
      var value = String(text || "");
      if (!value || value === "—") return;
      navigator.clipboard.writeText(value).then(function () {
        snap.message = "已复制";
        paint();
      }).catch(function () {
        snap.message = "复制失败，请手动选中文本";
        paint();
      });
    }

    function build() {
      host = document.createElement("div");
      host.id = CARD_ID;
      shadow = host.attachShadow({ mode: "open" });
      var style = document.createElement("style");
      style.textContent = CSS;
      shadow.appendChild(style);
      var holder = document.createElement("div");
      holder.innerHTML = HTML;
      while (holder.firstChild) shadow.appendChild(holder.firstChild);

      q(".start").addEventListener("click", function () { act("start"); });
      q(".stop").addEventListener("click", function () { act("stop"); });
      q(".peek").addEventListener("click", function () { snap.peek = !snap.peek; paint(); });
      q(".copyUrl").addEventListener("click", function () { copy(snap.url); });
      q(".copyPwd").addEventListener("click", function () { copy(snap.password); });

      remoteMode = !localMode();
      paint();
    }

    function unmount() {
      stopTicker();
      if (host && document.contains(host)) host.remove();
      host = null;
      shadow = null;
    }

    /**
     * 卡片只出现在一个板块：当前选中的板块不是落点时卸载，是落点时挂到该板块
     * 内容区顶部。落点由 targetNavIndex 决定（优先目标板块，缺失时回退）。
     */
    function ensureMounted() {
      var panel = settingsPanel();
      if (!panel) { unmount(); return; }
      var items = panel.querySelectorAll("nav button");
      var index = targetNavIndex(panel);
      if (index < 0) { unmount(); return; }
      var current = panel.querySelector('nav button[aria-current="true"]');
      if (!current || items[index] !== current) { unmount(); return; }
      var outlet = panel.querySelector('[data-slot="settings.section"]');
      var container = outlet && outlet.parentElement;
      if (!container) { unmount(); return; }
      if (host && document.contains(host) && host.parentElement === container) {
        startTicker();
        return;
      }
      if (!host) build();
      container.insertBefore(host, outlet);
      refresh();
      startTicker();
    }

    var observer = null;
    var pending = false;
    var booted = false;

    function schedule() {
      if (pending) return;
      pending = true;
      var run = function () {
        pending = false;
        try { ensureMounted(); } catch (e) { /* 设置面板结构变化时静默重试 */ }
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 32);
    }

    function apply(ctx) {
      if (typeof document === "undefined") return;
      if (booted) return;
      booted = true;
      var boot = function () {
        if (!document.body) { setTimeout(boot, 120); return; }
        schedule();
        // 设置面板是整块挂进 body 的，板块内容区又是整块重渲染的，两次变更
        // 的 mutation target 都不一定落在 nav / settings.section 里面，所以这里
        // 统一重新评估；schedule() 用 rAF 合帧，一次变更风暴只会跑一次。
        // ensureMounted 内部有「卡片已在正确位置就直接返回」的短路，代价很小。
        observer = new MutationObserver(function () { schedule(); });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-current"]
        });
      };
      if (document.body) boot();
      else document.addEventListener("DOMContentLoaded", boot, { once: true });

      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function () {
          return function () {
            stopTicker();
            if (observer) { observer.disconnect(); observer = null; }
            unmount();
          };
        }, "tunnel-control: settings card");
      }
    }

    exports.apply = apply;
    exports.__dev = {
      ensureMounted: ensureMounted,
      settingsPanel: settingsPanel,
      currentSectionKind: currentSectionKind,
      targetSection: targetSection,
      snapshot: function () { return snap; }
    };

    return module.exports;
  }
  });
})();
