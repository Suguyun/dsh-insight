# dsh-insight

**dsh（DeepSeek Harness）的浏览器伴侣。** 在网页上选中任意一段文字即时解读，并在侧栏就这段解读继续追问；同时把浏览器交给 dsh 智能体 —— 读页面、点击、抓包、开标签页。

![侧栏](docs/screenshot.png)

## 功能

### 划词即解读

选中文字后浮现一个小浮标（文字可自定义，默认「解读」），点一下就把**选区文本 + 页面 URL + 标题**发给本机 dsh，解读结果用 Markdown 渲染出来。

四种触发与展示方式：

| 模式 | 触发 | 结果去哪 |
| --- | --- | --- |
| `click`（默认） | 选中后点浮标 | 页面浮窗 |
| `click-sidebar` | 选中后点浮标 | 只进侧栏 |
| `auto` | 划词即解读（停手约 0.45 秒） | 页面浮窗 |
| `auto-sidebar` | 划词即解读 | 只进侧栏，页面不出现任何元素 |

同一段文字只解读一次。连续划词时新选区**排队覆盖旧选区**，不会像早期版本那样在请求飞行途中把新选区丢掉。浮窗位置可选「跟随选区」或「固定在右下角」。

### 侧栏原生多轮追问

解读结果下方就是追问输入框（`Enter` 发送 · `Shift+Enter` 换行）。追问走原生多轮，携带最近 16 轮、每轮上限 4000 字符的历史，不跳转到别处开新会话。

### 设置就在侧栏里

点侧栏右上角「设置」就地切换，不再跳独立的扩展选项页；按钮会变成「返回解读」。设置页是懒加载的，没点开不会加载。

### 外观可配置

侧栏背景色与字号（11–20px）可调，跟随浅色 / 深色主题。

### 解读口径：内置 + 自定义

内置六种口径：**默认解读**、**一句话讲清**、**直译 + 术语**、**代码 / 报错讲解**、**批判性审阅**、**讲给完全不懂的人**。

内置口径**也可以改**（改动作为覆盖层保存，可恢复默认），另可新建任意多个自定义口径。

### 智能体侧：`browser_*` 工具

装上宿主半边后，dsh 智能体获得 8 个工具：`browser_get_page`、`browser_list_tabs`、`browser_navigate`、`browser_click`、`browser_open_tab`、`browser_start_capture`、`browser_stop_capture`、`browser_capture_requests`。

抓包走 CDP，**默认对凭据脱敏**（`redactCredentials: true`）。会改动页面的动作（导航 / 点击 / 开标签 / 开始抓包）要求本轮用户消息里含明确意图词才放行 —— 这是防提示注入的闸门，不是 bug。

## 组成

两个半边，缺一不可：

| 路径 | 作用 |
| --- | --- |
| `extension/` | MV3 扩展：侧栏、划词、浮窗、设置 |
| `host/bridge.js` | 扩展 ↔ dsh 的 WebSocket 桥接（路由 `/dsh-insight/bridge`） |
| `host/browser-tools.js` | 注册 `browser_*` 工具 |
| `host/insight.js` | 划词解读路由 `POST /dsh-insight` |
| `host/page-injector.js` | 把「当前页面」注入会话 —— **默认不挂载**，见下 |

协议细节见 `docs/bridge-protocol.md`。

## 环境要求

- 一个跑得起来的 dsh，且启用了 web profile（默认 `http://127.0.0.1:3080`）
- Node.js ≥ 18，以及 pnpm（`dsh plugin` 依赖它）
- Chrome 或 Edge ≥ 118

## 安装

### 1. 装宿主半边

```bash
dsh plugin --profile web add github:Suguyun/dsh-insight
```

这条命令会安装本包，并自动把 `dsh-insight` 写进该 profile 的 `dsh.profile.bundles`（`dsh plugin` 是 pnpm 的转发器，装完会对齐 bundles 列表）。

> **为什么不用 `link:` 指向本地克隆？** Node 按模块的**真实路径**向上解析依赖，符号链接进来的包实际留在 profile 之外，解析不到 dsh 自己的 `@deepseek-ai/dsh-llm`，插件会加载失败。

若访问 github.com 的 HTTPS 受限（`github:` 规格拉不动），可改用 SSH 克隆到 profile 目录**内部**再安装 —— 这样它就在 profile 里，依赖能正常解析：

```bash
cd ~/.dsh/profiles/web
git clone git@github.com:Suguyun/dsh-insight.git
dsh plugin --profile web add ./dsh-insight
```

### 2. 装扩展

**方式 A：用发布包（不需要命令行）**

从 [Releases](https://github.com/Suguyun/dsh-insight/releases) 下载 `dsh-insight-<版本>.zip`，解压到一个**固定不动**的目录（`manifest.json` 就在解压出的那一层）。

**方式 B：命令行**

```bash
npx github:Suguyun/dsh-insight install
```

它会把 `extension/` 复制到一个稳定的用户目录并打印该路径。
注意：本包**没有发布到 npm**，所以必须带 `github:` 前缀，直接 `npx dsh-insight` 会失败。

两种方式之后都一样：

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开「开发者模式」；
2. 点「加载已解压的扩展程序」，选择上面那个目录；
3. 点工具栏图标打开侧栏。

扩展是从该目录**就地加载**的：改完源码（或换了新版本）后，重新复制一次文件，并在扩展页点一次「重新加载」。注意别删掉这个目录，否则扩展会失效。

### 3. 验证

侧栏顶部应显示 **「桥接已连接」**。若显示「未连接」，确认 dsh 在跑、地址填对，然后刷新页面。

## 数据流向与隐私

- 划词解读会把**选区文本 + 页面 URL / 标题** POST 到 `{你的 dsh}/dsh-insight`，由 dsh 用它自己配置的模型生成解读。这段文本是否离开你的机器，取决于你给 dsh 配的模型服务商 —— 这一层由 dsh 决定，不由本扩展决定。
- 扩展自身的对外请求**只有两类，且都指向本机**：你配置的 dsh 地址（默认 `127.0.0.1:3080`），以及跨扩展页面回退用的 CDP 端点 `127.0.0.1:9222`。没有遥测，没有第三方端点。
- **页面自动注入默认关闭**（两层都关：宿主不挂载 + 扩展推送开关默认 `false`）。开启后你浏览的页面正文会进模型上下文，是否接受请自行判断。
- 抓包默认脱敏；要抓未脱敏的原始流量需在 `cordis.patch.yml` 里显式把 `redactCredentials` 设为 `false`。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `sidePanel` | 侧栏本身 |
| `storage` | 保存设置与最近一次解读 |
| `tabs` / `activeTab` | 列出标签页、读取活动标签页 |
| `scripting` | 注入脚本读取正文与链接、执行点击 |
| `webNavigation` | 标签切换 / 导航 / SPA 路由变化时推送页面变化 |
| `debugger` | 用 CDP 抓取网络请求（`Network.enable`） |
| `<all_urls>` | 内容脚本需要能作用于你浏览的任意页面 |

`debugger` 是强权限，这里只用于抓包。它会让被调试的标签页顶部出现「正在调试」提示条，停止抓包即断开。

另外，**别的扩展的 `chrome-extension://` 页面**既不能注入脚本、也不能用 `debugger` 读，唯一通道是浏览器远程调试协议。要读这类页面，需要用 `--remote-debugging-port=9222` 启动浏览器。

## 配置

侧栏「设置」里可改：dsh 地址、浮标文字、触发与展示模式、浮窗位置、侧栏背景色与字号、解读口径。

设置存在 `chrome.storage.local`，键名如下（便于脚本化改写）：

| 键 | 含义 |
| --- | --- |
| `dsh_url` | dsh 地址 |
| `insight_mode` | `click` / `click-sidebar` / `auto` / `auto-sidebar` |
| `insight_label` | 浮标文字 |
| `insight_position` | `follow` / `fixed` |
| `insight_preset` | 当前选中的口径 id |
| `insight_system` | 当前生效的口径全文 |
| `insight_overrides` | 对内置口径的修改 |
| `insight_custom` | 自定义口径列表 |
| `insight_thread` | 追问线程 |
| `last_insight` | 最近一次解读记录 |
| `panel_bg` / `panel_font_size` | 侧栏外观 |
| `insight_autopush` | 页面推送开关，**默认 `false`** |

例：

```js
chrome.storage.local.set({ insight_mode: "auto-sidebar" });
```

### 想打开页面自动注入

需要**两处一起开**，只开一处会静默空转（生产端与消费端互不感知，不报错）：

1. `cordis.patch.yml` 里把 `dsh-insight-page-injector` 那两行取消注释；
2. `chrome.storage.local.set({ insight_autopush: true })`。

本仓库的实现是**有界**的：单次最多 4000 字符、正文里出现注入标记（自身回声）就整条跳过、单会话累计 60000 字符封顶。

## 已知限制

- 侧栏宽度由浏览器决定（Chrome 最小约 320px），扩展无法控制。
- Markdown 渲染器是零依赖自研的，**不支持表格**；支持标题、列表、引用、代码块、行内代码、加粗、链接。
- 只在 Chrome / Edge（MV3）上验证过，未测 Firefox。
- 划词解读只处理单段选区，不做整页摘要。
- 划词解读不建会话、不写日志，是一次性的问答。

## 开发

```bash
git clone https://github.com/Suguyun/dsh-insight
cd dsh-insight
node tests/run.mjs      # 或 npm test
```

`tests/` 下是 15 个自包含套件、137+ 项断言，覆盖划词触发模式、请求队列、孤儿脚本守卫、侧栏视图与追问、Markdown 渲染、设置页、口径预设、抓包脱敏等。

每个套件自带 DOM / chrome API 打桩并直接 import 仓库源码，不需要构建。其中 `test-host-mt` 与 `test-presets` 直接测 `host/insight.js`，需要能解析到 dsh 的 `@deepseek-ai/dsh-llm`；裸克隆里它们会打印 `SKIP` 并计为跳过，而不是失败。

侧栏截图（`docs/screenshot.png`）由 headless Edge + playwright-core 渲染生成。

## 致谢

本项目 fork 自 [stuarthu/dsh-chrome](https://github.com/stuarthu/dsh-chrome)（MIT）。上游提供了桥接、浏览器工具与页面注入的原始实现；本仓库在其之上做了划词解读、侧栏原生多轮追问、设置内嵌、外观定制等改造，并收紧了页面注入与正文上限。上游的版权与许可声明按 MIT 要求保留在 `LICENSE` 中。

## License

MIT，见 [`LICENSE`](LICENSE)。
