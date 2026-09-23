// selection-insight — “网页划词 → AI 解读”的 host 半边。
//
// 只做一件事：注册一条本机精确路由 POST /dsh-insight。浏览器扩展把选区文本
// （外加页面 URL/标题）POST 过来，这里用 dsh 自己的 llm 服务生成解读，把纯文本
// 回给扩展。
//
// 为什么是精确路由而不是 /api：webServer 的精确路由不在 Connection 的
// Host/Origin 与 cookie 围栏之内（dsh-restart-button 就是这么做的），所以
// 扩展侧不需要任何鉴权，也不会碰上“第三方 iframe 带不上 SameSite cookie”的
// 问题——这正是侧栏内嵌 dsh 界面那条路踩到的坑。
//
// 不建会话、不写日志：划词解读是一次性的问答，不该污染任何会话。

import { createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "selection-insight";

// llm 是硬依赖：没有它这个插件没有任何意义。
// webServer 用来挂路由。agentDefaultModel 用 ctx.get 读，缺了也不影响加载。
export const inject = ["webServer", "llm"];

const MAX_TEXT = 12_000; // 选区文本上限
const MAX_BODY = 256 * 1024; // 请求体上限
const MAX_TOKENS = 4_000; // 解读长度上限（推理模型会先花掉一部分在 reasoning 上）
const TIMEOUT_MS = 120_000;

// 多轮讨论：只接受最近这么多轮、每轮这么长。不设上限的话，侧栏那边一旦出问题
// （或有人直接打这个路由）就能把一次请求放大到任意大。
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_TEXT = 4_000;

// 追问轮次的补充口径。第一轮那套「极简」类限制（比如 tldr 的「最多三句话」）
// 不该绑住后续讨论 —— 用户追问「展开讲讲」的时候，答案是越短越糟。
const DISCUSSION_ADDENDUM = [
  "现在起是就这段选中文字（以及你上一条解读）与用户的追问讨论。",
  "1. 直接回答用户这一问，不要重复已经说过的结论，除非用户要求。",
  "2. 追问轮次不受「最多三句话」「不要分点」之类的篇幅限制，按问题需要展开。",
  "3. 仍然遵守上面的 Markdown 输出约定。",
].join("\n");

// 扩展来源的等价写法（Chromium 家族用 chrome-extension:，Edge 也是它）。
const EXTENSION_ORIGIN_SCHEMES = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
]);

// 所有口径共用的输出格式约定。
//
// 本地修改：显式要求 Markdown，而且只承诺下游真正能渲染的东西 —— 侧栏渲染器
// （extension/src/md.js）支持标题/列表/加粗/斜体/行内代码/围栏代码/引用/链接/
// 分隔线，**不支持表格**，所以这里明确禁用表格（需要对照就用列表）。
// 放在一处，避免六个预设各写一套格式要求然后慢慢漂移。
const MD_RULES = [
  "输出格式：Markdown（下游按 Markdown 渲染）。",
  "1. 结论放最前面；内容较长时用 ## / ### 小标题分段。",
  "2. 并列或分步用无序/有序列表；关键结论用 **加粗**。",
  "3. 术语、标识符、文件名、命令用 `反引号`。",
  "4. 代码、命令、配置、报错一律放进带语言标注的围栏代码块，例如 ```python。",
  "5. 不要用表格（渲染器不支持表格），需要对照就改用列表；不要输出 HTML。",
  "6. 不要客套话，不要复述原文。",
].join("\n");

// 内置默认解读口径。扩展设置页可以覆盖它（POST 时带 system），这里只做兜底。
const DEFAULT_SYSTEM = [
  "你是一个划词解读助手：用户在任意网页上选中一段文字，你负责直接解读它。",
  "输出要求：",
  "1. 先用一句话说清这段文字是什么、在说什么。",
  "2. 再补必要的背景、术语或上下文。代码/报错按代码解释，公式按公式解释，",
  "   外语或行业黑话直接给含义和用法。",
  "3. 只依据给出的文字与页面信息，拿不准就明说不确定。",
  MD_RULES,
].join("\n");

const MAX_SYSTEM = 4_000; // 自定义口径长度上限

// 预设口径。设置页通过 GET /dsh-insight 读它们，所以文案只有这一处来源。
const PRESETS = [
  { id: "default", name: "默认解读", system: DEFAULT_SYSTEM },
  {
    id: "tldr",
    name: "一句话讲清",
    system: [
      "你是一个极简解读助手：用最少的话把用户选中的文字说清楚。",
      "输出要求：",
      "1. 第一句就给结论，之后只留真正必要的信息，总体控制在三句话以内。",
      "2. 确实存在并列要点时才用一个短列表，否则不要分点。",
      "3. 不要复述原文，不要客套话。",
      // 极简口径的 Markdown 也要克制：不加标题、不用表格，只借加粗与行内代码。
      "输出格式：简体中文 Markdown，但要克制 —— 用 **加粗** 点出结论、",
      "`反引号` 标术语或代码标识符；不要标题，不要表格（渲染器不支持表格）。",
    ].join("\n"),
  },
  {
    id: "translate",
    name: "直译 + 术语",
    system: [
      "你是一个翻译与术语助手。用户选中的是外语或行业黑话片段。",
      "输出要求：",
      "1. 先给准确直译。",
      "2. 再逐个解释其中的术语、缩写、俚语，说明使用场景与语气。",
      "3. 如果有多义，分别列出适用语境。",
      // 术语对照本来是表格的天然场景，但渲染器不支持表格，这里改钉成列表格式。
      "术语逐条写成 `- **原词**：含义与用法` 的列表，不要用表格。",
      MD_RULES,
    ].join("\n"),
  },
  {
    id: "code",
    name: "代码 / 报错讲解",
    system: [
      "你是一个代码讲解助手。用户选中的可能是代码、命令、配置或报错信息。",
      "输出要求：",
      "1. 先说这段在做什么；是报错就先说清根因。",
      "2. 逐行或逐段说明关键语句，指出易错点。",
      "3. 如有必要，给出可执行的修复或改进建议。",
      MD_RULES,
    ].join("\n"),
  },
  {
    id: "critique",
    name: "批判性审阅",
    system: [
      "你是一个严格的审阅者。用户选中了一段论述、方案或结论。",
      "输出要求：",
      "1. 先概括它主张了什么。",
      "2. 指出论证里的隐含前提、跳步，以及证据不足之处。",
      "3. 说明它在什么条件下才成立。",
      "实事求是：不要为了挑刺而挑刺，也不要附和。",
      MD_RULES,
    ].join("\n"),
  },
  {
    id: "plain",
    name: "讲给完全不懂的人",
    system: [
      "你是一个耐心的科普者。用户选中了一段专业内容。",
      "输出要求：假设读者完全没有背景知识，用日常语言和恰当类比解释它，",
      "尽量不堆术语；必须使用术语时，立刻用一句话解释。",
      MD_RULES,
    ].join("\n"),
  },
];

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-insight",
        handler: (req, res) => {
          // GET = 设置页取「默认口径 + 预设」；POST = 真正解读。
          const run = req.method === "GET" ? () => metadata(res) : () => handle(ctx, req, res);
          Promise.resolve()
            .then(run)
            .catch((error) => {
              // 响应头已经发出去时不能再写，静默收尾即可。
              if (!res.headersSent) fail(res, 500, String(error?.message ?? error));
            });
        },
      }),
    "selection-insight: /dsh-insight route",
  );
}

/** 设置页要的元数据：默认口径、预设列表、长度上限。 */
function metadata(res) {
  ok(res, {
    ok: true,
    defaultSystem: DEFAULT_SYSTEM,
    presets: PRESETS,
    maxSystem: MAX_SYSTEM,
  });
}

/** 自定义口径：只有非空字符串才生效，并且限长。 */
function resolveSystem(payload) {
  const raw = typeof payload?.system === "string" ? payload.system.trim() : "";
  if (raw === "") return DEFAULT_SYSTEM;
  return raw.slice(0, MAX_SYSTEM);
}

async function handle(ctx, req, res) {
  if (req.method !== "POST") return fail(res, 405, "method not allowed");
  if (!isLoopbackRequest(req)) {
    // 把观察到的现场写进错误里：下次不用再靠猜是围栏的哪一条挂的。
    const origin = req.headers.origin ?? "(none)";
    const address = req.socket?.remoteAddress ?? "(unknown)";
    return fail(res, 403, `forbidden (origin=${origin}, addr=${address})`);
  }
  if (ctx.get("agentDefaultModel") === undefined || ctx.get("llm") === undefined) {
    return fail(res, 503, "llm service unavailable");
  }

  const raw = await readBody(req);
  if (raw === undefined) return fail(res, 413, "request body too large");

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail(res, 400, "invalid json");
  }

  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (text === "") return fail(res, 400, "empty text");

  const selection = {
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    url: stringOr(payload?.url, ""),
    title: stringOr(payload?.title, ""),
  };

  const model = resolveModel(ctx);
  if (model === undefined) return fail(res, 503, "no default model selected");

  const system = resolveSystem(payload);
  const history = resolveHistory(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  req.on("close", () => controller.abort());

  try {
    const result = await generate(ctx, model, selection, system, history, controller.signal);
    if (result.text.trim() === "") return fail(res, 502, "model returned an empty answer");
    // 撞上长度上限时，已经生成的内容仍然有效：照常返回，只在末尾说明一句。
    const text = result.truncated
      ? `${result.text}\n\n——（输出达到长度上限，已截断；可以选更小的片段再问一次）`
      : result.text;
    ok(res, {
      ok: true,
      text,
      truncated: result.truncated,
      provider: model.provider,
      model: model.model,
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (controller.signal.aborted) return fail(res, 504, `timeout or cancelled: ${message}`);
    fail(res, 502, message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 归一化追问历史：只认 user / assistant 两种角色，条数与单条长度都封顶，
 * 不合规的条目直接丢弃。宁可少带几轮，也不让畸形输入进到模型上下文里。
 */
function resolveHistory(payload) {
  const raw = Array.isArray(payload?.history) ? payload.history : [];
  const turns = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    if (role === null) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text === "") continue;
    turns.push({ role, text: text.slice(0, MAX_HISTORY_TEXT) });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

/** 用 dsh 自己的 llm 服务跑一次不落会话的调用，累积 text-delta。 */
async function generate(ctx, model, selection, system, history, signal) {
  const prompt = [
    selection.url === "" ? "" : `页面：${selection.title || "(无标题)"}\n${selection.url}`,
    selection.truncated ? "(选区过长，已截断)" : "",
    "选中的文字：",
    "```",
    selection.text,
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n");

  // 第一条永远是「页面信息 + 选区」；之后是追问讨论的往返。
  // 角色必须用 dsh-llm 的构造函数生成，不要手拼消息对象。
  const messages = [
    createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }),
    ...history.map((turn) =>
      turn.role === "assistant"
        ? createAssistantMessage({
            content: [{ type: "text", text: turn.text }],
            provider: model.provider,
            model: model.model,
          })
        : createUserMessage({
            content: [{ type: "text", text: turn.text }],
            source: { kind: "user" },
          })
    ),
  ];

  const stream = ctx.llm.stream({
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    system: history.length === 0 ? system : `${system}\n\n${DISCUSSION_ADDENDUM}`,
    maxTokens: MAX_TOKENS,
    messages,
    signal,
  });

  let output = "";
  let truncated = false;
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") {
      output += chunk.text;
    } else if (chunk.type === "finish") {
      const kind = chunk.reason.kind;
      // error / aborted 才是真失败。
      if (kind === "error" || kind === "aborted") {
        const failure = chunk.reason.failure;
        throw new Error(failure?.message ?? `model finish: ${kind}`);
      }
      // max-tokens 只是撞上了长度上限：已生成的部分是有效的，照常交出去。
      if (kind === "max-tokens") truncated = true;
    }
  }
  return { text: output, truncated };
}

/** 默认模型来自 agentDefaultModel，与 dsh 界面里那个选择器同源。 */
function resolveModel(ctx) {
  const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
  const provider = stringOr(selection?.provider, "");
  const model = stringOr(selection?.model, "");
  if (provider === "" || model === "") return undefined;
  return {
    provider,
    model,
    reasoningEffort: selection?.reasoningEffort,
  };
}

/** 只接受本机客户端；Origin 存在时必须与本服务同源（照抄 restart-button 的围栏）。 */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? "";
  const loopback =
    address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  if (!loopback) return false;
  const origin = req.headers.origin;
  if (origin === undefined || origin === "") return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // 浏览器扩展的请求带 Origin: chrome-extension://<id> —— 它没有 host 能跟服务端
  // 比对，但这是我们要支持的主要调用方（扩展只能由用户自己安装，且 socket 已经
  // 要求是回环地址）。Edge/Chrome 都是 chrome-extension:，另外带上 Firefox/Safari。
  if (EXTENSION_ORIGIN_SCHEMES.has(url.protocol)) return true;
  return url.host === (req.headers.host ?? "");
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

function stringOr(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function ok(res, body) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function fail(res, status, error) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, error }));
}
