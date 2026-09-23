// dsh-insight 桥接插件（宿主侧）。
//
// 在 dsh web 服务器上注册 WebSocket 升级路由 /dsh-insight/bridge，并对外提供
// `dshInsightBridge` 服务：
//   - call(action, params, timeoutMs)  → 向浏览器扩展发起一次动作并等待结果
//   - onPage(listener) / currentPage() → “当前页面”快照的推送与读取
//     （由页面注入插件消费，注入到最近活跃会话）
//   - isConnected()                    → 当前是否有扩展连着
//
// 协议（与 extension/src/background.js 对应）：
//   扩展 → dsh：{type:"result", id, ok, result, error} 动作应答
//               {type:"page", tab:{url,title,content,truncated}} 页面变化推送
//               {type:"ping"}
//   dsh → 扩展：{type:"action", id, action, params}
//               {type:"pong"}
//               {type:"graph-changed"} 模块图变化广播（无 id、无应答），
//                 扩展收到后刷新侧栏内嵌的 dsh 页面；注入 clientModules
//                 就是为了订阅这个变化。
//
// 安全说明：该路由与 dsh web 的 /api 一样，仅在回环/受信主机上可达；
// 本机任意程序都能连接，这与现有回环信任模型一致。

import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

export const name = "dsh-insight-bridge";
export const inject = ["webServer", "clientModules"];

// 页面正文字符上限。封顶与“是否已截断”的判定都只在这里做，页面注入器只
// 消费结论。（扩展侧 MAX_PAGE 是跨运行时不得不复制的一份，改动时须同步
// extension/src/background.js。）
//
// 本地修改：上游是 1_000_000。它只是本机任意程序都能连上的回环路由的
// 内存/帧大小保护阀，而按需读取的额度另有其人（扩展侧
// GET_PAGE_TEXT_LIMIT = 40_000），所以这个阀不需要 1MB 那么大。收紧到
// 200_000 后，即使有人推来超长正文，也不会把几十 MB 的原串钉在内存里。
const MAX_PAGE_CONTENT = 200_000;

/**
 * 把 slice 出来的字符串复制成独立字符串。
 * V8 的 slice 返回的是共享原串内存的视图，直接存进长生命周期的 currentPage
 * 会把整个超长原串一起钉在内存里（50MB 推送 → 常驻 50MB 而不是 1MB）。
 */
const flatten = (s) => (" " + s).slice(1);

export function apply(ctx) {
  const sockets = new Set();
  const pending = new Map(); // id -> { resolve, timer }
  const pageListeners = new Set();
  let currentPage = null;

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => {
      sockets.delete(ws);
      if (sockets.size === 0) currentPage = null; // browser gone → drop stale page
    });
    ws.on("error", () => {});
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {}
        return;
      }
      if (msg.type === "result") {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg);
        return;
      }
      if (msg.type === "page") {
        const tab = msg.tab && typeof msg.tab === "object" ? msg.tab : null;
        if (!tab || typeof tab.url !== "string") return;
        // 入口处就截断正文：本机任意程序都能连上桥接，不能让超长推送滞留在
        // currentPage 或原样扇出给监听者。
        const raw = typeof tab.content === "string" ? tab.content : "";
        const content = raw.length > MAX_PAGE_CONTENT ? flatten(raw.slice(0, MAX_PAGE_CONTENT)) : raw;
        // 扩展侧已截断时随帧上报 truncated；旧版扩展不发这个字段，而它切出来
        // 的正文长度恰好等于上限，因此长度达到上限也视为已截断（代价是正好
        // 等于上限的完整页面会被多标一次，可接受）。
        const truncated = tab.truncated === true || raw.length >= MAX_PAGE_CONTENT;
        currentPage = {
          url: tab.url,
          title: typeof tab.title === "string" ? tab.title : "",
          content,
          truncated,
          at: Date.now(),
        };
        for (const listener of pageListeners) {
          try {
            listener(currentPage);
          } catch {}
        }
        return;
      }
    });
  });

  const disposer = ctx.webServer.registerUpgrade({
    path: "/dsh-insight/bridge",
    handler: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
  });

  // 模块图变化（新增/移除插件行）→ 通知扩展自动刷新侧栏里的 dsh 页面。
  // 跳过启动后 5 秒内的初始图构建通知，避免刚连接就刷一次。
  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {}
    }
  };
  let graphSettled = false;
  const settleTimer = setTimeout(() => {
    graphSettled = true;
  }, 5000);
  const offGraph = ctx.clientModules.onGraphChanged(() => {
    if (!graphSettled) return;
    broadcast({ type: "graph-changed" });
  });

  ctx.effect(
    () => () => {
      clearTimeout(settleTimer);
      offGraph();
      disposer();
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: "bridge disposed" });
      }
      pending.clear();
      currentPage = null; // don't let a stale page survive a disconnect/reload
      try {
        wss.close();
      } catch {}
    },
    "dsh-insight-bridge: route"
  );

  const bridge = {
    isConnected: () => sockets.size > 0,
    currentPage: () => currentPage,
    onPage(listener) {
      pageListeners.add(listener);
      return () => pageListeners.delete(listener);
    },
    /** 向浏览器扩展发起一次动作（browser_* 工具调用）。 */
    call(action, params = {}, timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        const ws = [...sockets].at(-1);
        if (!ws) {
          reject(new Error("browser bridge not connected — open the dsh-insight side panel (and make sure dsh web is running)"));
          return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`browser action ${action} timed out`));
        }, timeoutMs);
        pending.set(id, {
          timer,
          resolve: (m) => {
            if (m.ok === false) {
              reject(new Error(m.error || `browser action ${action} failed`));
            } else {
              resolve(m.result ?? null);
            }
          },
        });
        try {
          ws.send(JSON.stringify({ type: "action", id, action, params }));
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        }
      });
    },
  };

  ctx.provide("dshInsightBridge", bridge);
}
