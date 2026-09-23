// 网页划词 → AI 解读（页面侧）。
//
// 在任意 http(s) 页面里：选中文字 → 弹出一个小浮标「解读」→ 点它，选区被发给
// service worker，由它 POST 到本机 dsh 的 /dsh-insight 取回解读文本 → 在选区
// 旁边弹一张卡片显示。
//
// 刻意不依赖侧栏：解读结果直接出现在你划词的地方，不需要任何 iframe、cookie 或
// 鉴权。侧栏那边只是同步显示同一条记录（见 sidepanel.js）。
//
// 样式全部用 CSSOM 逐条赋值（不用 <style> 标签），避免撞上页面的 CSP 与样式。

(() => {
  // 只在主框架运行；iframe 里的划词没有意义，还会重复插入浮标。
  if (window.top !== window) return;

  // 注入自检：内容脚本可以直接用 chrome.storage，所以把这一笔直接落盘。
  // 「到底有没有注入」从此不需要靠猜 —— 能从扩展存储里读出来。
  void (async () => {
    try {
      const seen = await chrome.storage.local.get("content_ready");
      const list = Array.isArray(seen.content_ready) ? seen.content_ready : [];
      list.unshift({ at: new Date().toISOString(), url: location.href });
      await chrome.storage.local.set({ content_ready: list.slice(0, 10) });
    } catch {}
  })();

  const MAX_TEXT = 12_000;
  const MIN_TEXT = 1;
  // 单次解读请求的兜底上限：host 侧是 120 秒，这里略高一点。
  const REQUEST_TIMEOUT_MS = 130_000;

  let bubble = null;
  let card = null;
  let busy = false;

  // ---- 设置：浮标文字 / 触发与展示方式 / 浮窗位置 ----
  //
  // 内容脚本在 manifest 里是普通脚本（没有 type: module），不能 import 设置模块，
  // 所以自己读 storage。取值只认下面两个集合，其余（缺失、脏值）一律按默认的
  // 「点浮标 + 页面浮窗」走 —— 默认值因此只需要在设置页维护一份。
  const DEFAULT_LABEL = "解读";
  const AUTO_MODES = new Set(["auto", "auto-sidebar"]);
  const SIDEBAR_ONLY_MODES = new Set(["click-sidebar", "auto-sidebar"]);
  const SETTING_KEYS = ["insight_label", "insight_mode", "insight_position"];

  // 固定位置时统一留的边距。
  const FIXED_MARGIN = 16;

  let label = DEFAULT_LABEL;
  let mode = "click";
  let position = "follow";

  const autoMode = () => AUTO_MODES.has(mode);
  const sidebarOnly = () => SIDEBAR_ONLY_MODES.has(mode);

  function readSettings(stored) {
    if (stored === null || typeof stored !== "object") return;
    if (typeof stored.insight_label === "string" && stored.insight_label.trim() !== "") {
      label = stored.insight_label.trim();
    }
    if (typeof stored.insight_mode === "string") mode = stored.insight_mode;
    if (typeof stored.insight_position === "string") position = stored.insight_position;
  }

  async function reloadSettings() {
    try {
      readSettings(await chrome.storage.local.get(SETTING_KEYS));
    } catch {}
  }

  void reloadSettings();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!SETTING_KEYS.some((key) => changes[key] !== undefined)) return;
      // changes 只带改动过的键，逐字段合并容易漏，整组重读更省心。
      void reloadSettings();
    });
  } catch {}

  const dark = () =>
    window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;

  function make(tag, styles, text) {
    const el = document.createElement(tag);
    el.setAttribute("data-dsh-insight", "");
    for (const key of Object.keys(styles)) el.style[key] = styles[key];
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function drop(el) {
    if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el);
  }

  function clearBubble() {
    drop(bubble);
    bubble = null;
  }

  function clearCard() {
    drop(card);
    card = null;
  }

  function clearAll() {
    clearBubble();
    clearCard();
  }

  // ---- 孤儿内容脚本检测 ----
  //
  // 扩展被重载/更新后，**已经打开的页面**里的内容脚本会和扩展失去联系：
  // chrome.runtime.id 变成 undefined，sendMessage 会抛 "Extension context
  // invalidated"。这类失败用户完全看不见 —— auto-sidebar 模式下连卡片都没有，
  // 表现就是「划了词，什么都没发生」。所以专门识别它，并在页面上说清原因。

  let notice = null;
  let noticeTimer = null;

  /** 当前内容脚本是否已经和扩展断开。 */
  function isOrphaned() {
    try {
      return chrome === undefined || chrome.runtime === undefined || chrome.runtime.id === undefined;
    } catch {
      // 光是访问就可能抛 —— 那就按孤儿处理。
      return true;
    }
  }

  function showOrphanNotice() {
    if (notice !== null) return;
    const isDark = dark();
    const box = make("div", {
      position: "fixed",
      zIndex: "2147483647",
      left: "50%",
      transform: "translateX(-50%)",
      bottom: "20px",
      maxWidth: "min(520px, calc(100vw - 32px))",
      padding: "8px 14px",
      font: "13px/1.5 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
      color: isDark ? "#e6edf3" : "#1f2328",
      background: isDark ? "#21262d" : "#ffffff",
      border: `1px solid ${isDark ? "#3d444d" : "#d1d9e0"}`,
      borderRadius: "8px",
      boxShadow: "0 4px 16px rgba(0,0,0,.22)",
      textAlign: "center",
    });
    box.textContent = "dsh-insight 已更新：刷新本页后划词解读才能继续工作。";
    document.documentElement.appendChild(box);
    notice = box;
    // 别一直挂着，用户看见就够了。
    noticeTimer = window.setTimeout(() => {
      clearOrphanNotice();
    }, 8000);
  }

  function clearOrphanNotice() {
    if (noticeTimer !== null) {
      window.clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    drop(notice);
    notice = null;
  }

  /** 当前选区；不可用（折叠、太短、没有几何信息）时返回 undefined。 */
  function currentSelection() {
    const selection = window.getSelection();
    if (selection === null || selection === undefined || selection.isCollapsed) return undefined;
    const text = selection.toString().trim();
    if (text.length < MIN_TEXT) return undefined;
    let rect;
    try {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    } catch {
      return undefined;
    }
    if (rect === undefined || (rect.width === 0 && rect.height === 0)) return undefined;
    return { text: text.slice(0, MAX_TEXT), rect };
  }

  // ---- 浮标 ----

  function showBubble(selection) {
    clearBubble();
    const isDark = dark();
    const button = make(
      "button",
      {
        position: "fixed",
        zIndex: "2147483647",
        padding: "4px 10px",
        font: "12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif",
        color: isDark ? "#e6edf3" : "#1f2328",
        background: isDark ? "#21262d" : "#ffffff",
        border: `1px solid ${isDark ? "#3d444d" : "#d1d9e0"}`,
        borderRadius: "6px",
        boxShadow: "0 2px 10px rgba(0,0,0,.18)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
      label,
    );
    if (position === "fixed") {
      // 固定在右下角：不用每次都去追选区，鼠标习惯性回到同一处就能点到。
      button.style.right = `${String(FIXED_MARGIN)}px`;
      button.style.bottom = `${String(FIXED_MARGIN)}px`;
    } else {
      // 按钮宽度随文字变化，所以靠右对齐时留出一点余量。
      const estimated = 26 + label.length * 13;
      const left = Math.max(
        8,
        Math.min(window.innerWidth - estimated, selection.rect.right - estimated / 2),
      );
      const top = selection.rect.top > 40 ? selection.rect.top - 32 : selection.rect.bottom + 8;
      button.style.left = `${String(left)}px`;
      button.style.top = `${String(Math.max(8, top))}px`;
    }
    button.addEventListener("mousedown", (event) => {
      // 别让点击清掉选区。
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void interpret(selection.text, selection.rect);
    });
    document.documentElement.appendChild(button);
    bubble = button;
  }

  // ---- 卡片 ----

  function showCard(anchorRect, body) {
    clearBubble();
    clearCard();
    const isDark = dark();
    const width = Math.min(420, Math.max(260, window.innerWidth - 24));

    const shell = make("div", {
      position: "fixed",
      zIndex: "2147483647",
      width: `${String(width)}px`,
      maxHeight: "60vh",
      overflow: "auto",
      padding: "10px 12px",
      font: "13px/1.6 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
      color: isDark ? "#e6edf3" : "#1f2328",
      background: isDark ? "#161b22" : "#ffffff",
      border: `1px solid ${isDark ? "#3d444d" : "#d1d9e0"}`,
      borderRadius: "10px",
      boxShadow: "0 6px 24px rgba(0,0,0,.22)",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    });

    const bar = make("div", {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      marginBottom: "6px",
    });
    const label = make(
      "span",
      {
        flex: "1",
        fontSize: "11px",
        letterSpacing: ".04em",
        textTransform: "uppercase",
        color: isDark ? "#8b949e" : "#6a737d",
      },
      "dsh 解读",
    );
    const close = make(
      "button",
      {
        border: "0",
        background: "transparent",
        color: isDark ? "#8b949e" : "#6a737d",
        cursor: "pointer",
        font: "14px/1 system-ui, sans-serif",
        padding: "2px 4px",
      },
      "✕",
    );
    close.addEventListener("click", () => {
      clearCard();
    });
    bar.appendChild(label);
    bar.appendChild(close);

    const content = make("div", {}, body);
    shell.appendChild(bar);
    shell.appendChild(content);

    if (position === "fixed") {
      // 固定在右下角：钉住不动，读长文时不会随选区乱跑。
      shell.style.right = `${String(FIXED_MARGIN)}px`;
      shell.style.bottom = `${String(FIXED_MARGIN)}px`;
      shell.style.maxHeight = "50vh";
    } else {
      const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchorRect.left));
      const below = anchorRect.bottom + 10;
      shell.style.left = `${String(left)}px`;
      shell.style.top = `${String(Math.max(12, Math.min(window.innerHeight - 120, below)))}px`;
    }
    document.documentElement.appendChild(shell);
    card = shell;
    return content;
  }

  async function interpret(text, anchorRect) {
    if (busy) return;
    busy = true;
    // 「只用侧边栏」时不建卡片：结果由 background 广播 + 落 last_insight 给侧栏。
    // 浮标也要收起来 —— 原来是被 showCard 里的 clearBubble 顺带收掉的，不建卡片
    // 就没人收，会留一个点过的按钮挂在页面上。
    let content = null;
    if (sidebarOnly()) clearBubble();
    else content = showCard(anchorRect, "解读中…");
    const started = Date.now();
    let timer = null;
    try {
      // host 侧超时是 120 秒，这里比它略高一点兜底。没有这层的话，万一 sendMessage
      // 因为 service worker 被回收之类的原因永远不 settle，busy 会一直挂着 ——
      // 那样整个自动解读就彻底哑了，而且表面上看不出原因。
      const reply = await Promise.race([
        chrome.runtime.sendMessage({
          type: "interpret",
          text,
          url: location.href,
          title: document.title,
        }),
        new Promise((_, reject) => {
          timer = window.setTimeout(() => reject(new Error("请求超时（130 秒）")), REQUEST_TIMEOUT_MS);
        }),
      ]);
      recordTrace({ event: autoMode() ? "auto" : "click", ok: reply?.ok === true, ms: Date.now() - started, error: reply?.ok === true ? "" : String(reply?.error ?? "") });
      if (content !== null) {
        content.textContent =
          reply?.ok === true ? reply.text : `解读失败：${String(reply?.error ?? "未知错误")}`;
      }
    } catch (error) {
      // 请求途中扩展被重载也会走到这里 —— 同样属于「孤儿」，给出能照做的提示。
      const orphaned = isOrphaned();
      if (orphaned) showOrphanNotice();
      recordTrace({ event: autoMode() ? "auto" : "click", ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
      if (content !== null) {
        content.textContent = orphaned
          ? "解读失败：扩展已更新，请刷新本页后重试。"
          : `解读失败：${String(error?.message ?? error)}`;
      }
    } finally {
      if (timer !== null) window.clearTimeout(timer);
      busy = false;
      // 排队中的那次选区（等这次期间用户选的）现在补上。
      flushPendingAuto();
    }
  }

  // ---- 事件 ----

  let debounce = null;
  // 自动模式下去重：selectionchange 会为同一段选区反复触发，不能每次都问一次模型。
  let lastAutoText = null;
  // 一次解读可能要十几到几十秒。这期间用户很可能已经选中了下一段文字 ——
  // 以前 onSelectionSettled 开头直接 `if (busy) return`，那次选中就被永久丢掉了，
  // 表现就是「选中新的不会解读，侧栏还停在旧的」。现在改成排队：只留最新的一次，
  // 等当前这次结束后立刻处理。
  let pendingAuto = null;

  /** 诊断：记下最近几次尝试的结果（和 content_ready 同一思路，出事不用靠猜）。只记元信息。 */
  function recordTrace(entry) {
    void (async () => {
      try {
        const stored = await chrome.storage.local.get("content_last");
        const list = Array.isArray(stored.content_last) ? stored.content_last : [];
        list.unshift({ at: new Date().toISOString(), url: location.href, ...entry });
        await chrome.storage.local.set({ content_last: list.slice(0, 10) });
      } catch {}
    })();
  }

  /** 上一次结束后，把排队中的那次选区补上。 */
  function flushPendingAuto() {
    if (pendingAuto === null) return;
    const next = pendingAuto;
    pendingAuto = null;
    lastAutoText = next.text;
    void interpret(next.text, next.rect);
  }

  function onSelectionSettled() {
    // 注意：这里**不能**因为 busy 就提前 return —— 那正是丢事件的根源。计时器照排，
    // 由计时器内部决定是执行还是排队。
    window.clearTimeout(debounce);
    // 自动模式等久一点：拖选过程中会不断「稳定」，太灵敏会白跑好几次请求。
    const wait = autoMode() ? 450 : 220;
    debounce = window.setTimeout(() => {
      const selection = currentSelection();
      if (selection === undefined) {
        clearBubble();
        lastAutoText = null;
        pendingAuto = null; // 选区都取消了，排队的那次也没必要了
        return;
      }
      // 扩展重载后本页的脚本已成孤儿：任何请求都注定失败，直接说清原因。
      // （两种触发模式都要提示 —— 手动模式连浮标都不该弹出来。）
      if (isOrphaned()) {
        clearBubble();
        showOrphanNotice();
        return;
      }
      if (autoMode()) {
        // 划词即解读：不弹浮标，直接发请求。
        if (selection.text === lastAutoText) return;
        if (busy) {
          // 上一次还在跑：记下来，等它结束立刻补上（只留最新的一次）。
          pendingAuto = { text: selection.text, rect: selection.rect };
          return;
        }
        lastAutoText = selection.text;
        void interpret(selection.text, selection.rect);
        return;
      }
      // 手动模式：解析中不弹浮标（省得点了一个正在跑的东西）。
      if (busy) return;
      showBubble(selection);
    }, wait);
  }

  document.addEventListener("mouseup", onSelectionSettled, true);
  document.addEventListener("keyup", (event) => {
    const key = event.key ?? "";
    if (key === "Shift" || key.startsWith("Arrow")) onSelectionSettled();
  }, true);
  // 双击选词、三击选段、以及键盘选中都不一定伴随 mouseup；selectionchange 兜底。
  document.addEventListener("selectionchange", onSelectionSettled, true);

  document.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-dsh-insight]") !== null) return;
    clearAll();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") clearAll();
  }, true);

  // 切回一个「扩展重载前就打开」的标签页时提前告知，别等用户划完词才发现。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isOrphaned()) showOrphanNotice();
  }, true);
})();
