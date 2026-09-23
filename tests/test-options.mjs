// ── 测试用路径解析：仓库任意位置 clone 后都能直接跑 ──────────────
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "extension", "src");
import { pathToFileURL } from "node:url";

// ---- 极简 DOM / chrome 桩 ----
class El {
  constructor(id) {
    this.id = id; this.value = ""; this.disabled = false; this._text = "";
    this.children = []; this.handlers = {}; this.style = { setProperty() {} };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); }
  addEventListener(t, h) { (this.handlers[t] ||= []).push(h); }
  fire(t) { for (const h of this.handlers[t] || []) h({ target: this }); }
  focus() {} select() {}
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
globalThis.document = {
  getElementById: (id) => el(id),
  createElement: (tag) => new El(tag),
  documentElement: { style: { setProperty() {} } },
};
globalThis.window = { confirm: () => true, setTimeout: (fn, ms) => setTimeout(fn, ms), location: { search: "" } };

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); },
    },
    onChanged: { addListener() {} },
  },
};
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({
    ok: true, maxSystem: 4000, defaultSystem: "HOST_DEFAULT",
    presets: [
      { id: "default", name: "默认解读", system: "HOST_DEFAULT" },
      { id: "tldr", name: "一句话讲清", system: "TLDR_TEXT" },
    ],
  }),
});

const URL_ = pathToFileURL(`${SRC_DIR}/options.js`).href;
await import(URL_);
await new Promise((r) => setTimeout(r, 80));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const optionValues = () => el("preset").children.map((c) => c.value);
const optionLabels = () => el("preset").children.map((c) => c.textContent);

console.log("1) 初始下拉（内置 + 新建项）");
check("含 default/tldr/新建", JSON.stringify(optionValues()) === JSON.stringify(["default","tldr","__new__"]), JSON.stringify(optionValues()));

console.log("2) 编辑内置「默认解读」并保存");
el("system").value = "MY_EDITED_DEFAULT";
el("save").fire("click");
await new Promise((r) => setTimeout(r, 30));
check("overrides.default 已记录", store.insight_overrides?.default === "MY_EDITED_DEFAULT", JSON.stringify(store.insight_overrides));
check("insight_system 发的是改后文案", store.insight_system === "MY_EDITED_DEFAULT", store.insight_system);
check("下拉标出「已修改」", optionLabels()[0].includes("已修改"), optionLabels()[0]);

console.log("3) 新建两个自定义口径");
el("preset").value = "__new__"; el("preset").fire("change");
el("presetName").value = "我的口径A"; el("system").value = "AAA"; el("save").fire("click");
await new Promise((r) => setTimeout(r, 20));
el("preset").value = "__new__"; el("preset").fire("change");
el("presetName").value = "我的口径B"; el("system").value = "BBB"; el("save").fire("click");
await new Promise((r) => setTimeout(r, 20));
check("insight_custom 有 2 条", store.insight_custom?.length === 2, JSON.stringify(store.insight_custom));
check("名字与内容都存下", store.insight_custom[0].name === "我的口径A" && store.insight_custom[1].system === "BBB");
check("切到 B 时 insight_system=BBB", store.insight_system === "BBB", store.insight_system);
check("下拉含两个自定义", optionLabels().includes("我的口径A") && optionLabels().includes("我的口径B"));

console.log("4) 切换回内置 tldr");
el("preset").value = "tldr"; el("preset").fire("change");
await new Promise((r) => setTimeout(r, 20));
check("编辑器载入 host 原文", el("system").value === "TLDR_TEXT", el("system").value);
check("名称框对内置禁用", el("presetName").disabled === true);
check("删除按钮对内置禁用", el("deletePreset").disabled === true);

console.log("5) 撤销内置改动");
el("preset").value = "default"; el("preset").fire("change");
await new Promise((r) => setTimeout(r, 20));
check("恢复按钮可用（改过）", el("revertPreset").disabled === false);
el("revertPreset").fire("click");
await new Promise((r) => setTimeout(r, 30));
check("override 已清空", store.insight_overrides?.default === undefined, JSON.stringify(store.insight_overrides));
check("默认口径发空串（用 host 默认）", store.insight_system === "", JSON.stringify(store.insight_system));

console.log("6) 删除一个自定义口径");
el("preset").value = store.insight_custom[1].id; el("preset").fire("change");
el("deletePreset").fire("click");
await new Promise((r) => setTimeout(r, 30));
check("只剩 1 条自定义", store.insight_custom?.length === 1, JSON.stringify(store.insight_custom));
check("选中回到 default", store.insight_preset === "default", store.insight_preset);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
