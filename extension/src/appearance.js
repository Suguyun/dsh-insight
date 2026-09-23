// 侧栏外观：背景色 + 正文字号，交给用户配置。
//
// 背景色是任选的，但正文、代码块、边框不能跟着乱套 —— 这里按底色的相对亮度
// 自动推导一整支配色：浅底给深字，深底给浅字，用户不需要自己去调十几个颜色。
// 推导结果写进 CSS 变量，侧栏样式全部走变量（见 sidepanel.css 的 :root）。
//
// 存储键：panel_bg（#rrggbb）、panel_font_size（px 数字）。

// 只给本模块内部用：外部需要默认外观时用 defaultAppearance()，需要钳制/校验时
// 走 loadAppearance/saveAppearance，不必把这三个实现细节暴露出去。
const DEFAULT_BG = "#0d1117";
const DEFAULT_FONT_SIZE = 13;
export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 20;

const HEX = /^#[0-9a-f]{6}$/i;

export function defaultAppearance() {
  return { bg: DEFAULT_BG, fontSize: DEFAULT_FONT_SIZE };
}

function clampFontSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

function normalizeHex(value) {
  if (typeof value !== "string") return DEFAULT_BG;
  const trimmed = value.trim().toLowerCase();
  return HEX.test(trimmed) ? trimmed : DEFAULT_BG;
}

/** 从 storage 读外观；缺失或非法一律回落默认，永远返回可用值。 */
export async function loadAppearance() {
  const stored = await chrome.storage.local.get(["panel_bg", "panel_font_size"]);
  return {
    bg: normalizeHex(stored.panel_bg),
    fontSize: clampFontSize(stored.panel_font_size),
  };
}

export async function saveAppearance({ bg, fontSize }) {
  await chrome.storage.local.set({
    panel_bg: normalizeHex(bg),
    panel_font_size: clampFontSize(fontSize),
  });
}

/** 设置页改完，侧栏不重载也能立刻跟着变。 */
export function watchAppearance(onChange) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.panel_bg === undefined && changes.panel_font_size === undefined) return;
    void loadAppearance().then(onChange);
  });
}

// ---- 由底色推导整支配色 ----

function parseHex(hex) {
  const h = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}

function toHex(rgb) {
  const part = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/** sRGB 线性相对亮度：0 = 纯黑，1 = 纯白。用来决定这套配色偏深还是偏浅。 */
function luminance(rgb) {
  const channels = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** 在底色与目标色之间按比例混合，用来推导表面色 / 边框 / 次要文字。 */
function mix(from, to, t) {
  return toHex([
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ]);
}

/** 把一条外观写进 root 的 CSS 变量。 */
export function applyAppearance({ bg, fontSize }, root = document.documentElement) {
  const base = parseHex(bg);
  const light = luminance(base) > 0.5;
  // 浅底用深字、深底用浅字；其余颜色都从「底色 ↔ 字色」这条轴上取，保证对比度。
  const fg = light ? [31, 35, 40] : [230, 237, 243];
  const vars = {
    "--panel-bg": toHex(base),
    "--panel-fg": toHex(fg),
    "--panel-surface": light ? mix(base, [0, 0, 0], 0.05) : mix(base, [255, 255, 255], 0.06),
    "--panel-border": mix(base, fg, 0.22),
    "--panel-muted": mix(base, fg, 0.55),
    "--panel-quote": mix(base, fg, 0.8),
    // 强调色用扩展自身的品牌靛紫（取自 icons/icon-128.png 的主色 #5048e4），
    // 但按底色深浅分成两调：品牌原色在白底 6.20:1，直接放到深底只有 3.05:1
    // （达不到正文/链接的 4.5:1），所以在深底改用同色相提亮的 #8b85f0（6.05:1）。
    "--panel-accent": light ? "#5048e4" : "#8b85f0",
    "--panel-error": light ? "#cf222e" : "#f85149",
    "--panel-ok": light ? "#1a7f37" : "#7ee787",
    "--panel-warn": light ? "#9a6700" : "#d29922",
    "--panel-orange": light ? "#bc4c00" : "#f0883e",
    "--panel-orange-border": light ? "#bc4c00" : "#9e6a03",
    "--panel-font-size": `${String(clampFontSize(fontSize))}px`,
  };
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
}
