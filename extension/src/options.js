// dsh-insight 设置页。
//
// 三组设置：
//   连接      dsh_url（侧栏/桥接用哪个地址）
//   划词解读  浮标文字 + 解读口径（system prompt）
//   外观      侧栏背景色与正文字号（见 appearance.js）
//
// 口径的「内置文案」不在这里硬编码：从 host 的 GET /dsh-insight 取，保证文案
// 只有 host 一处来源；真正生效的文本存成 insight_system，service worker 只管
// 透传，不需要知道用户选的是内置还是自定义。
//
// 本地修改：内置口径现在也能改，并且可以建多个自定义口径。
//   insight_overrides  内置口径 id -> 被用户改过的文案（不动 host 那一份）
//   insight_custom     [{ id, name, system }] 用户自建的口径
//   insight_preset     当前选中的是哪一个
//   解析出真正要发的文案写进 insight_system（空串 = 让 host 用它自己的默认）

import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  applyAppearance,
  defaultAppearance,
  loadAppearance,
  saveAppearance,
} from "./appearance.js";

const $ = (id) => document.getElementById(id);

// 被侧栏内嵌时（options.html?embed=1）收紧留白、并跟随面板配色与字号 ——
// 见 options.css 里 body.embedded 那一段。独立打开（edge://extensions → 扩展选项）
// 时不受影响，仍是原来的浅色设置页。
// 用可选链：这段在模块顶层执行，拿不到 location 就会把整个设置页带崩。
if (new URLSearchParams(window.location?.search ?? "").get("embed") === "1") {
  document.body.classList.add("embedded");
}

const DEFAULT_LABEL = "解读";
// 与 selection.js 里的集合保持一致：那边只认这些取值，其余（含脏值）按默认处理。
const MODES = new Set(["click", "click-sidebar", "auto", "auto-sidebar"]);
const POSITIONS = new Set(["follow", "fixed"]);
const DEFAULT_MODE = "click";
const DEFAULT_POSITION = "follow";
const DEFAULT_PRESET_ID = "default";
// 旧版只有一个固定 id 为 "custom" 的自定义槽，加载时搬成正式的自定义口径。
const LEGACY_CUSTOM_ID = "custom";
const NEW_PRESET = "__new__";
const CUSTOM_NAME = "自定义口径";

// host 元数据：{ presets: [{id,name,system}], defaultSystem, maxSystem }
let meta = { presets: [], defaultSystem: "", maxSystem: 4000 };

let overrides = {}; // 内置口径 id -> 改过的文案
let customs = []; // 自定义口径
let presetChoice = DEFAULT_PRESET_ID;

/** 把当前 dsh 地址换成 origin（预设元数据走同一条精确路由）。 */
function originOf(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return "http://127.0.0.1:3080";
  }
}

async function loadMeta() {
  const stored = await chrome.storage.local.get("dsh_url");
  const origin = originOf(stored.dsh_url || "http://127.0.0.1:3080");
  try {
    const response = await fetch(`${origin}/dsh-insight`, { method: "GET" });
    const payload = await response.json();
    if (payload?.ok === true && Array.isArray(payload.presets)) {
      meta = payload;
      return { ok: true };
    }
    return { ok: false, error: `响应异常（HTTP ${String(response.status)}）` };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function systemLimit() {
  return Number.isFinite(meta.maxSystem) && meta.maxSystem > 0 ? meta.maxSystem : 4000;
}

// ---- 口径 ----

/**
 * 内置 + 自定义合成一份列表。
 * 内置项即使被改过，也保留 builtinSystem（host 原文），「恢复内置文案」用它。
 */
function allPresets() {
  const builtins = meta.presets.map((p) => {
    const override = typeof overrides[p.id] === "string" ? overrides[p.id] : undefined;
    return {
      id: p.id,
      name: p.name,
      builtin: true,
      // 改回与 host 完全一致时视为「没改」，不留多余的一份。
      edited: override !== undefined && override !== p.system,
      system: override === undefined ? p.system : override,
      builtinSystem: p.system,
    };
  });
  const owned = customs.map((c) => ({
    id: c.id,
    name: c.name,
    builtin: false,
    edited: false,
    system: c.system,
    builtinSystem: "",
  }));
  return [...builtins, ...owned];
}

function findPreset(id) {
  return allPresets().find((p) => p.id === id);
}

/** 这个口径真正要发给 host 的文案；空串 = 让 host 用它自己的默认。 */
function effectiveText(id) {
  const preset = findPreset(id);
  if (preset === undefined) return "";
  // 没改过的「默认解读」发空串，避免把 host 的内置文案复制一份到扩展里。
  if (preset.builtin && id === DEFAULT_PRESET_ID && !preset.edited) return "";
  return preset.system;
}

function fillPresets() {
  const select = $("preset");
  select.textContent = "";
  for (const preset of allPresets()) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.builtin && preset.edited ? `${preset.name}（已修改）` : preset.name;
    select.appendChild(option);
  }
  const add = document.createElement("option");
  add.value = NEW_PRESET;
  add.textContent = "＋ 新建自定义…";
  select.appendChild(add);
}

/** 把当前选中口径的内容搬进编辑器。 */
function loadEditor() {
  const preset = findPreset(presetChoice);
  const isCustom = preset !== undefined && !preset.builtin;

  $("presetName").value = isCustom ? preset.name : "";
  $("presetName").disabled = !isCustom;

  // 内置口径同样可编辑：改完保存进 overrides，host 那一份不动。
  $("system").disabled = false;
  $("system").value = preset === undefined ? meta.defaultSystem : preset.system;

  $("deletePreset").disabled = !isCustom;
  $("revertPreset").disabled = isCustom || preset?.edited !== true;
  updateCount();
}

/**
 * 把编辑器里的内容写回它所属的位置。
 * 内置 -> overrides（改回原文或清空就删掉这条，等于恢复 host 文案）
 * 自定义 -> 直接改 customs 里那一项
 */
function commitEditor() {
  const preset = findPreset(presetChoice);
  if (preset === undefined) return;
  const limit = systemLimit();
  const raw = $("system").value;
  const text = raw.length > limit ? raw.slice(0, limit) : raw;
  if (text !== raw) {
    $("system").value = text;
    setStatus(`口径内容超过 ${String(limit)} 字，已截断。`);
  }

  if (preset.builtin) {
    if (text.trim() === "" || text === preset.builtinSystem) delete overrides[preset.id];
    else overrides[preset.id] = text;
    return;
  }
  const target = customs.find((c) => c.id === preset.id);
  if (target === undefined) return;
  const name = $("presetName").value.trim();
  target.name = name === "" ? CUSTOM_NAME : name;
  target.system = text;
}

function updateCount() {
  $("count").textContent = `${String($("system").value.length)} / ${String(systemLimit())} 字`;
}

function setStatus(text) {
  $("status").textContent = text;
}

async function persist() {
  const url = $("dshUrl").value.trim().replace(/\/+$/, "") || "http://127.0.0.1:3080";
  const label = $("label").value.trim() || DEFAULT_LABEL;
  await chrome.storage.local.set({
    dsh_url: url,
    insight_label: label,
    insight_mode: MODES.has($("mode").value) ? $("mode").value : DEFAULT_MODE,
    insight_position: POSITIONS.has($("position").value) ? $("position").value : DEFAULT_POSITION,
    insight_preset: presetChoice,
    insight_system: effectiveText(presetChoice),
    insight_overrides: overrides,
    insight_custom: customs,
  });
}

/** 刷新下拉与编辑器，让「已修改」标记和按钮可用状态跟上当前数据。 */
function refresh() {
  fillPresets();
  $("preset").value = presetChoice;
  loadEditor();
}

// ---- 交互 ----

$("preset").addEventListener("change", () => {
  if ($("preset").value === NEW_PRESET) {
    newPreset();
    return;
  }
  commitEditor(); // 切走之前先把上一份的编辑落下，别丢
  presetChoice = $("preset").value;
  refresh();
});

$("system").addEventListener("input", updateCount);
$("presetName").addEventListener("input", () => {
  // 名字即时反映到下拉里，方便边改边看。
  const target = customs.find((c) => c.id === presetChoice);
  if (target !== undefined) {
    target.name = $("presetName").value.trim() || CUSTOM_NAME;
    const current = presetChoice;
    fillPresets();
    $("preset").value = current;
  }
});

function newPreset() {
  commitEditor();
  let index = customs.length + 1;
  let name = `${CUSTOM_NAME} ${String(index)}`;
  while (customs.some((c) => c.name === name)) {
    index += 1;
    name = `${CUSTOM_NAME} ${String(index)}`;
  }
  const id = `custom-${String(Date.now())}`;
  // 以内置默认文案作起点，比空白好改。
  customs.push({ id, name, system: meta.defaultSystem });
  presetChoice = id;
  refresh();
  $("presetName").focus();
  $("presetName").select();
  setStatus("已新建口径。改好名字与内容后点「保存」。");
}

$("newPreset").addEventListener("click", newPreset);

$("deletePreset").addEventListener("click", async () => {
  const preset = findPreset(presetChoice);
  if (preset === undefined || preset.builtin) return;
  if (!window.confirm(`删除口径「${preset.name}」？`)) return;
  customs = customs.filter((c) => c.id !== preset.id);
  presetChoice = DEFAULT_PRESET_ID;
  refresh();
  await persist();
  $("saved").textContent = "已删除 ✓";
  window.setTimeout(() => {
    $("saved").textContent = "";
  }, 2500);
});

$("revertPreset").addEventListener("click", async () => {
  const preset = findPreset(presetChoice);
  if (preset === undefined || !preset.builtin) return;
  delete overrides[preset.id];
  refresh();
  await persist();
  setStatus("已恢复 host 的内置文案。");
});

$("save").addEventListener("click", async () => {
  commitEditor();
  refresh();
  await persist();
  $("saved").textContent = "已保存 ✓";
  setStatus("已保存。回到网页重新划词即可生效。");
  window.setTimeout(() => {
    $("saved").textContent = "";
  }, 2500);
});

$("reset").addEventListener("click", async () => {
  if (!window.confirm("全部恢复默认？你改过的内置口径和所有自定义口径都会被清掉。")) return;
  overrides = {};
  customs = [];
  presetChoice = DEFAULT_PRESET_ID;
  $("label").value = DEFAULT_LABEL;
  refresh();
  await persist();
  setStatus("");
  $("saved").textContent = "已恢复默认 ✓";
});

// ---- 外观：改动即时保存 + 即时预览（不走上面的「保存」按钮） ----

function currentAppearance() {
  return { bg: $("bg").value, fontSize: Number($("fontSize").value) };
}

function paintAppearance() {
  const appearance = currentAppearance();
  applyAppearance(appearance); // 变量作用在本页 :root 上，直接驱动下面的预览块
  $("fontSizeValue").textContent = `${String(appearance.fontSize)} px`;
}

async function persistAppearance() {
  paintAppearance();
  await saveAppearance(currentAppearance());
}

$("bg").addEventListener("input", () => void persistAppearance());
$("fontSize").addEventListener("input", () => void persistAppearance());
$("bgReset").addEventListener("click", () => {
  $("bg").value = defaultAppearance().bg;
  void persistAppearance();
});

// ---- 启动 ----

/** 防御性读取：storage 里的东西可能是任意历史遗留，不能直接信。 */
function normalizeOverrides(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function normalizeCustoms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const id = typeof item.id === "string" && item.id !== "" ? item.id : `custom-${String(out.length)}`;
    const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name : CUSTOM_NAME;
    const system = typeof item.system === "string" ? item.system : "";
    out.push({ id, name, system });
  }
  return out;
}

async function load() {
  // 连接
  const storedUrl = await chrome.storage.local.get("dsh_url");
  $("dshUrl").value = storedUrl.dsh_url || "http://127.0.0.1:3080";

  // 划词解读
  const stored = await chrome.storage.local.get([
    "insight_label",
    "insight_mode",
    "insight_position",
    "insight_preset",
    "insight_system",
    "insight_overrides",
    "insight_custom",
  ]);
  $("label").value = stored.insight_label ?? DEFAULT_LABEL;
  // 认不出的值一律回落默认选项，别把脏值回显到界面上。
  $("mode").value = MODES.has(stored.insight_mode) ? stored.insight_mode : DEFAULT_MODE;
  $("position").value = POSITIONS.has(stored.insight_position)
    ? stored.insight_position
    : DEFAULT_POSITION;
  overrides = normalizeOverrides(stored.insight_overrides);
  customs = normalizeCustoms(stored.insight_custom);

  const fetched = await loadMeta();
  if (!fetched.ok) {
    setStatus(
      `取不到预设（${fetched.error}）—— dsh web 在跑吗？\n` +
        "预设不可用时，自定义口径仍然可以编辑和保存。",
    );
  }

  // 兼容旧版：以前只有一个固定 id 为 "custom" 的槽，把它的文案搬成一个自定义口径。
  // 迁移会立刻落盘（也要把 insight_preset 从 "custom" 改写成新 id），否则下次打开
  // 又会按旧槽再迁一遍。
  const saved = stored.insight_preset;
  let migrated = null;
  if (
    saved === LEGACY_CUSTOM_ID &&
    typeof stored.insight_system === "string" &&
    stored.insight_system.trim() !== "" &&
    customs.length === 0
  ) {
    migrated = { id: `custom-${String(Date.now())}`, name: CUSTOM_NAME, system: stored.insight_system };
    customs.push(migrated);
  }

  // 选中的口径：迁移结果优先，其次沿用上次选择，找不到就回到 default。
  presetChoice = migrated === null ? (findPreset(saved) === undefined ? DEFAULT_PRESET_ID : saved) : migrated.id;
  refresh();
  if (migrated !== null) await persist();

  // 外观：范围由 appearance.js 给，避免 HTML 里再写一遍上下限。
  $("fontSize").min = String(FONT_SIZE_MIN);
  $("fontSize").max = String(FONT_SIZE_MAX);
  const appearance = await loadAppearance();
  $("bg").value = appearance.bg;
  $("fontSize").value = String(appearance.fontSize);
  paintAppearance();
}

void load();
