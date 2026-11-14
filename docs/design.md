# dsh-sideask 设计文档 —— 当前对话旁的悬浮轻对话助手

> 产品名：**旁问 Side Ask** ｜ 插件包名：`dsh-sideask` ｜ 宿主：DeepSeek Harness（dsh）0.2.2-rc.1
> 代码位置：`E:\workspace\dsh-sideask` ｜ 事实依据：`docs/research/client-api.md`、`docs/research/host-api.md`、`docs/research/patterns.md`、`docs/verification.md`
> 标记约定：**[已验证]** = 有源码 file:line 证据；**[假设]** = 未证明，已附降级方案；**[契约]** = 本插件自定义的接口。

---

## 1. 澄清问题与假设清单

### 1.1 已提出的澄清问题（5 个，均已回答）

| # | 问题 | 你的选择 | 对设计的影响 |
|---|---|---|---|
| Q1 | dsh 插件 API 未知时怎么处理？ | **授权读本机 dsh 源码摸 API** | 不再猜 API：从 `app.asar` 解出 331 个 `@deepseek-ai/*` 包，逐个 README + `lib/*.js` 核对，设计里每条宿主能力都能落到 file:line |
| Q2 | 交付形态？ | **完整可运行插件，含真实宿主对接** | 不只写文档：产出可安装的 `dsh-sideask` 包（host half + web client bundle）+ 构建/测试/安装脚本 |
| Q3 | 前端技术栈？ | **TypeScript + Web Component / Shadow DOM** | 浏览器半部分用 TS + esbuild 打包成单文件 Module Loader bundle；窗口渲染在 Shadow Root 内做样式隔离 |
| Q4 | 轻对话的模型调用走哪条路？ | **复用宿主已有模型会话能力** | 宿主侧 `ctx.llm.stream(...)`（复用已登录账号/默认模型），插件不建 session、不存 Key |
| Q5 | 首版范围？ | **稳妥 MVP：悬浮窗 + 轻对话 + 手动上下文快照** | 增量刷新/自动摘要/引用高亮进 P1；P0 先把“不污染 + 可引用回 + 隐私开关”做扎实 |

### 1.2 假设清单（不回答就按此继续；每条都有降级）

| # | 假设 | 证据/置信度 | 如果不成立 | 降级方案 |
|---|---|---|---|---|
| A1 | 宿主提供 `ctx.sessions.retain(id).ready` → `binding.eventSource.getSnapshot().entries` 可只读拿到当前会话可见消息 | **[已验证]** 结构见 `dsh-api-session-controller/lib/client.js:4072,4145-4150,1741-1762`；消息形状见 `dsh-client-ui-chat/lib/client.js:11955-11992` | 客户端拿不到 transcript | 降级到会话作用域 Slot 注入的 `useSession`/`useConversation` 标准 props；再降级到 DOM 选区（`window.getSelection()`）+ 用户手动粘贴 |
| A2 | 能确定“当前会话 id” | **[假设]** 没有单一 `currentSession` 服务；需自建探针（见 §7.2） | 探针不发火 | 三级回退：选区交互回调里的 `request.sessionId` → `ctx.sessions.list()` 最近活跃 → 只回答问题（无上下文） |
| A3 | 悬浮窗可挂在 `shell.overlay` 根级插槽，且可在自建 Shadow Root 内渲染 React | 插槽层 **[已验证]**（`dsh-client-ui-layout/lib/client.js:401-405`，层 `z-index:20`）；Shadow DOM **[假设]**（全仓无 `attachShadow` 先例，但属纯 DOM API） | React 在 Shadow Root 内事件异常 | 自动回退 light DOM + `.sideask-` 类名前缀（所有官方插件都是这么做的） |
| A4 | 能把文本插回主对话输入框 | **[已验证]** `ctx.conversation.input.for(binding.ctx).actions.insertQuote(text)`（`dsh-client-ui-conversation/lib/client.js:15186-15197,15368-15395,16127-16133`） | `input.for` 调用路径不稳 | 回退 `setDraft(text)`，再回退“复制到剪贴板 + 提示用户粘贴”；`insertQuote` 返回 `false` 时 UI 明确提示“输入框当前不是纯文本模式” |
| A5 | 宿主模型服务可从插件调用：`ctx.llm.stream({provider, model, messages, signal, temperature, maxTokens})` | **[已验证]** `dsh-llm/README.md:47-59`（流式示例）、`dsh-llm/lib/index.js:2395-2400`（`stream`）、`dsh-llm/lib/types/assembler.js`（chunk 协议）、`dsh-llm-deepseek/lib/index.js:2019-2028`（`usage`/`finish` 形状） | `ctx.llm` 未挂载或 provider 未注册 | 返回 `NO_ADAPTER` 并给出可操作提示（去设置里选默认模型）；窗口进入 `unavailable` 状态而非崩溃 |
| A6 | 模型路由可由插件配置或宿主默认模型解析：`ctx.get('agentDefaultModel').currentSelection()` | **[已验证]** `dsh-agent-default-model/lib/index.js`（`currentSelection()` 返回 `{provider, model, reasoningEffort?}`） | 该服务不存在 | 用 `ctx.llm.listProviders()[0].id` + 配置里的 `model`；再不行要求用户显式配置 provider/model |
| A7 | 插件可注册 HTTP 路由：`ctx.webServer.register({kind, path, handler \| resource})`，返回 disposer | **[已验证]** `dsh-spend-wallpaper/lib/http.js:144-156`（真实第三方插件用法） | 路由前缀被占用/不支持 SSE | 改用 `resource`（Fetch `Request→Response`）形态；或退回“轮询式”分帧（`POST ask` + `GET poll`） |
| A8 | schemastery `Config` 会出现在插件设置页，且 `.volatile()` 字段以 `{get()}` 形式传入、改配置无需重载 | **[已验证]** 配置读取模式见 `dsh-spend-wallpaper/lib/index.js:232-253`（注释明说 volatile 字段是 getter refs）；设置页渲染 **[假设]** | 宿主不自动渲染设置页 | 悬浮窗自带完整设置面板（P0 已含），宿主设置页仅作为增强 |
| A9 | 线程历史可落盘到 `$DSH_HOME/storages/<plugin>/` | **[已验证]** 同类插件先例 `dsh-spend-wallpaper/lib/store.js:11-19,64-86` | 目录不可写 | 内存态 + localStorage 镜像；UI 标注“本次会话有效” |
| A10 | 同源检查（`Sec-Fetch-Site` / `Origin` vs `Host`）足够保护本地插件路由 | **[已验证]** 同类插件实现 `dsh-spend-wallpaper/lib/http.js:25-43` | 需要更强鉴权 | 追加一次性 token（启动时注入到页面，路由校验 `x-sideask-token`） |

### 1.3 需要宿主提供的能力清单（**这是本设计对宿主的全部依赖**）

| # | 能力 | 精确接口 | 状态 | 用途 | 没有它时 |
|---|---|---|---|---|---|
| H1 | 插件装载（行配置 + bundle patch） | `package.json.dsh.{manifestVersion,bundle.patch,client.platform}`、`cordis.patch.yml` 的 `insert` 行 | **[已验证]** | 让 `dsh plugin add` 能装上 | 无法安装（硬依赖） |
| H2 | 插件生命周期 | `apply(ctx, config)`、`ctx.effect(fn, label)`、`ctx.inject(deps, cb)`、`ctx.provide(name, value)`、`ctx.get(name)` | **[已验证]** | 注册/注销路由与监听 | 无法加载（硬依赖） |
| H3 | 配置 | `@deepseek-ai/schemastery` 的 `Config`；volatile 字段 getter refs | **[已验证]** | 上下文条数/预算/隐私开关/快捷键/默认位置 | 用内置默认值 + 窗口内设置面板 |
| H4 | 模型调用 | `ctx.llm.stream(options)` → async iterable；`ctx.llm.listProviders()` | **[已验证]** | 轻对话回答（复用宿主账号/模型） | 窗口进入 `unavailable`，不崩页 |
| H5 | 默认模型路由 | `ctx.get('agentDefaultModel').currentSelection()` | **[已验证]** | 用户不改配置时用宿主默认模型 | 要求显式配置 provider/model |
| H6 | HTTP 路由 | `ctx.webServer.register({kind, path, handler})` → disposer | **[已验证]** | 浏览器半 ↔ 宿主半 的唯一通道（含 SSE 流式） | 只能纯客户端降级（无模型能力）→ 功能不可用 |
| H7 | 会话只读视图（客户端） | `ctx.sessions.retain(id,{source}).ready` → `binding.eventSource.getSnapshot()/.subscribe()` | **[已验证]**（`retain→ready→entries` 组合 **[假设]**） | 提取当前主对话可见消息 + 增量刷新 | 手动快照（用户点“抓取上下文”）或 DOM 选区 |
| H8 | 选中文本交互（客户端） | `ctx.uiConversation.interactions.register({id, onInteraction})`、`request.readText()` | **[已验证]** | 取用户选中文本作为最高优先级上下文 | `window.getSelection()` 兜底 |
| H9 | 输入框写入（客户端） | `ctx.conversation.input.for(binding.ctx).actions.insertQuote/setDraft/captureInsertion+insertText` | **[已验证]**（调用路径 **[假设]**） | “引用到主对话/插入引用块/作为草稿” | 复制到剪贴板 + 提示粘贴 |
| H10 | 覆盖层插槽（客户端） | `ctx.slots.inject('shell.overlay', () => ctx.slots.register({name:'shell.overlay'}, Comp))` | **[已验证]** | 悬浮窗挂载点（`z-index:20` 层） | `createPortal(node, document.body)` 兜底 |
| H11 | 快捷键（客户端） | ~~`ctx.shortcuts.register(...)`~~ → **插件自建 `keydown` 监听**（见 R12）| **[已验证，且已放弃宿主服务]** | 唤起/收起悬浮窗 | 无依赖；不依赖宿主即可用 |
| H12 | 设置页插槽（客户端，可选） | `ctx.slots.inject('settings.section', …)` | **[已验证]** | 在 dsh 设置里放“旁问”分区 | 只用窗口内设置面板 |
| H13 | 国际化（可选） | `ctx.locale.register(ns, {zh, en})` | **[已验证]** | 中英文案 | 内置 zh/en 切换 |
| H14 | 主题变量（可选） | CSS `--dsw-*` 变量（跨 Shadow 边界继承） | **[已验证]** | 与宿主亮/暗主题一致 | 自带 light/dark 变量 + `prefers-color-scheme` |
| H15 | 本地存储（可选） | `$DSH_HOME/storages/sideask/threads.json`（约定俗成） | **[已验证（先例）]** | 轻对话历史 | localStorage 或纯内存 |

> **权威性说明**：H1–H3、H5–H6、H10–H11 的证据都在本机 0.2.2-rc.1 的打包源码里；H7/H9 有结构性证据但“组合调用路径”仍是假设，客户端半已按“探测 → 用 → 失败回退”三态实现，**任何一条假设失效都不会让主对话页面白屏**。

---

## 2. 需求清单（P0 / P1 / P2）

### P0 —— 没有它产品不成立（本版全部实现）

| ID | 需求 | 验收要点 |
|---|---|---|
| P0-1 | 悬浮入口 + 悬浮小窗：可拖拽、四角吸附、最小化、展开/收起、位置记忆 | 拖拽有指针捕获；松手 24px 内自动吸附；刷新后位置/尺寸/折叠态还原 |
| P0-2 | 快捷键唤起/收起（默认 `Alt+Shift+A`） | 全局生效（含输入框聚焦时），可在配置中改，冲突时给出提示 |
| P0-3 | 独立轻对话线程：多轮、清空、历史保存、加载态/错误态/重试 | 主对话不受影响；刷新后历史仍在；错误可重试或“仅用问题回答” |
| P0-4 | 流式回答 | 首字 ≤ 2s 出现（取决于模型）；可“停止”；停止后已生成内容保留 |
| P0-5 | 上下文提取：最近 N 条 + 用户选中文本 + 当前问题；token 预算；去重；敏感信息过滤 | 预算硬上限不被突破；去重与脱敏有单测；预算不足时按优先级降级并**在 UI 里说明为什么** |
| P0-6 | 回答标注引用 | 回答只引用实际发给模型的 `cN`；未知引用丢弃；点引用可定位/看到摘录 |
| P0-7 | 默认不写回；显式“复制 / 插入引用块 / 引用到主对话 / 作为草稿插入” | 任何写回都由用户点击触发；失败有提示与回退 |
| P0-8 | 隐私：权限声明、本地存储、可关闭上下文读取、可清空历史 | 关闭后请求里不含任何对话内容（host 侧有断言测试） |
| P0-9 | 不阻塞主对话渲染 | 提取异步 + 可取消 + 超时降级；主线程无同步大循环（>16ms 的分片均异步） |

### P1 —— 体验与规模（下一迭代）

| ID | 需求 | 说明 |
|---|---|---|
| P1-1 | 增量刷新水位线 + 订阅 | 已实现投影缓存；P1 补“会话事件流按 `change.kind` 精确增量”与后台预取 |
| P1-2 | 自动历史摘要（滚动） | 复用 `buildSummaryPrompt` + 同一 `ctx.llm.stream`，按“消息集合哈希”缓存，避免重复摘要 |
| P1-3 | 引用高亮联动主对话 | 点击引用滚动定位并对原文做 1.2s 高亮（需要 DOM 锚点，**假设**） |
| P1-4 | 宿主设置页分区 | 复用 schemastery `Config` 自动渲染（**假设**），否则保留窗口内设置 |
| P1-5 | 多线程管理面板 | 列表/重命名/删除/按主会话分组 |
| P1-6 | 对话内搜索 | 只搜插件自己的线程历史 |

### P2 —— 增强（远期）

| ID | 需求 |
|---|---|
| P2-1 | 把轻对话“升级为主对话的一个正式会话”（用户显式操作，走宿主 session API） |
| P2-2 | 多模态：把截图/选区图片作为上下文 |
| P2-3 | 团队/共享：线程导出为 Markdown、分享链接 |
| P2-4 | 自定义 prompt 模板库（“解释这段”“生成测试”“找风险”一键问） |
| P2-5 | 离线/无模型模式：仅做上下文整理与本地规则回答 |

---

## 3. 方案对比与推荐

### 3.1 四个候选架构

**方案 A：纯浏览器旁路 + 插件自带 API Key**
- 做法：客户端直接 `fetch('https://api.deepseek.com/chat/completions')`，Key 存 localStorage。
- 优点：宿主依赖最少；实现最快。
- 缺点：**违背“复用宿主模型能力”**；Key 暴露在页面/localStorage（XSS 即泄）；与宿主账号额度、模型目录、路由策略脱节；企业环境通常禁外连；无法复用宿主的重试/限流/计费埋点。
- 结论：**否决**（只作为 H4/H6 全失效时的最后兜底，不实现）。

**方案 B：宿主网关 + 客户端只读取证（推荐 ✅）**
- 做法：浏览器半只做“读取 → 预算 → 渲染 → 显式回写”；宿主半做“模型调用 + 线程存储 + 隐私闸门 + HTTP/SSE”。
- 优点：
  1. **不污染主对话是结构性保证**：宿主半根本不 import 任何 session/agent 写接口，模型调用用 request-only 输入，不产生 durable message；
  2. 复用宿主模型/账号/路由（`ctx.llm` + `agentDefaultModel`）；
  3. 上下文抽取在客户端，天然贴合“用户可见/用户选中”，且不需要把整段 transcript 传到宿主再传回；
  4. 隐私可做**双层过滤**（浏览器先脱敏，宿主再校验），并且 host 有硬上限校验（不信任客户端）；
  5. 传输只是本地同源 HTTP，无跨进程/跨窗口复杂性。
- 缺点：需要 `ctx.webServer`（H6）；SSE 需宿主 HTTP 层不缓冲（已用 `x-accel-buffering: no` + 每帧 flush）。
- 结论：**推荐**。

**方案 C：另开一个真实 dsh 会话（右侧栏/新 tab）**
- 做法：用宿主 session API 建一个“轻会话”，复用完整 agent 能力。
- 优点：能力最全（工具、文件、引用、模型选择全都有）；实现最省事。
- 缺点：**直接违背需求**——“轻对话不应污染主对话”在用户心智里包含“不要在会话列表里多出一个会话、不要把主对话状态带偏”；会真实产生持久会话与 token 计费记录；每次提问都要把上下文重新灌进会话（成本更高）；关闭后宿主侧状态已经变了，做不到“关闭后主对话状态不变”。
- 结论：**否决为默认**，但保留为 P2-1“显式升级为主对话”。

**方案 D：独立 iframe / 原生 WebView 侧窗**
- 做法：宿主开一个独立窗口/iframe，插件在其中渲染。
- 优点：进程/样式隔离最彻底；适合桌面端多屏。
- 缺点：跨窗口通信、主题同步、快捷键归属、会话权限都要重做一遍；dsh web 形态下没有对等 API。
- 结论：不适用于 MVP；桌面端可作为 P2 的“独立窗口模式”。

### 3.2 方案评分（1–5）

| 维度 | A 纯客户端+自带Key | B 宿主网关+客户端抽取 | C 真实新会话 | D 独立窗口 |
|---|---|---|---|---|
| 不污染主对话 | 5 | **5** | 1 | 5 |
| 复用宿主模型能力 | 1 | **5** | 5 | 4 |
| 隐私/密钥安全 | 1 | **5** | 4 | 4 |
| 上下文贴合度（可见/选中） | 4 | **5** | 3 | 3 |
| 实现与维护成本 | 5 | 3 | **5** | 2 |
| 权限与审计 | 2 | **4** | 5 | 3 |
| 与需求匹配度 | 2 | **5** | 3 | 3 |
| **加权结论** | 兜底 | **推荐** | P2 升级路径 | P2 桌面模式 |

### 3.3 关键取舍（明确写出来，避免开发时反复）

1. **多轮对话用“单条 user 消息内嵌历史 transcript”，而不是真正的多轮 messages 数组**：`GenerateOptions.messages` 支持 durable `Message` 与 request-only user 输入，但 durable assistant 消息需要 session 身份（我们刻意不创建）；为保持 provider-neutral 且不发明 API，历史以 `Q:/A:` 形式内嵌在一条请求里。代价：失去严格 role 交替；收益：**绝不可能写入任何会话日志**。见 `src/shared/prompt.ts`。
2. **Token 估算用保守启发式，不引入 tokenizer**：宁可多估 10–15%，也不冒“请求被 provider 截断”的风险；包体也保持在 100KB 级。见 `src/shared/tokens.ts`。
3. **引用协议用末尾机器可读块 `⟦refs: c1, c3⟧` + 行内 `[cN]` 双支持**：模型即使忘记协议也只是少几个引用 chip，不会污染正文。见 `src/shared/citations.ts`。
4. **线程历史归宿主所有，窗口几何归 localStorage**：历史要跨浏览器/跨设备一致且“可清空”，窗口位置是纯 UI 偏好，不该走宿主。见 §8。
5. **写回永远是显式动作**：没有“自动把回答贴回去”的隐式路径，连“复制”都要用户点。

---

## 4. 架构图（文字版）

```
┌──────────────────────────────── dsh 宿主进程（Node / Electron）────────────────────────────────┐
│                                                                                                │
│  plugin loader（cordis 行图）                                                                   │
│   ├─ 行: id=sideask  name=dsh-sideask ← cordis.patch.yml 的 insert                             │
│   └─ 载入 lib/host/index.js  → apply(ctx, config)                                              │
│                                                                                                │
│  ┌────────────────────────── 宿主半（src/host → lib/host）──────────────────────────┐          │
│  │ index.ts    插件入口：name / Config / apply                                     │          │
│  │   ├─ ctx.provide('sideAsk', runtime)          （对其它插件可观测，可选）        │          │
│  │   ├─ ctx.inject(['webServer'], …) → http.ts   （路由注册 + disposer）           │          │
│  │   └─ ctx.effect(() => () => runtime.dispose())（GPU/句柄/定时器清理）           │          │
│  │ runtime.ts  编排：校验 → 隐私闸门 → 组 prompt → 调模型 → 落线程 → 发事件        │          │
│  │  ├─ sanitizeBundle()  不信任客户端：重算 token、重脱敏、砍到预算内              │          │
│  │  ├─ AsyncQueue        模型增量 → SSE 帧                                         │          │
│  │  └─ cancel/dispose    AbortController 表 + 超时                                  │          │
│  │ llm.ts      模型网关：resolveRoute() / callModel() / finish→错误码映射           │          │
│  │ store.ts    线程存储：$DSH_HOME/storages/sideask/threads.json（原子写、有界）   │          │
│  │ config.ts   Config(schemastery) + readConfig()（volatile getter 解包 + 钳制）     │          │
│  │ http.ts     路由：bootstrap / ask(SSE) / cancel / threads / health               │          │
│  └──────────────────────────────────────────────────────────────────────────────────┘          │
│            ▲                                      │                                            │
│            │ 同源 HTTP（JSON + text/event-stream）│  ctx.llm.stream({provider,model,messages})  │
│            │                                      ▼                                            │
│            │                          ┌───────────────────────────┐                            │
│            │                          │ dsh-llm（宿主已有服务）    │→ provider 适配器 → 模型 API │
│            │                          │ 复用账号/默认模型/重试策略 │                            │
│            │                          └───────────────────────────┘                            │
└────────────┼───────────────────────────────────────────────────────────────────────────────────┘
             │  fetch('/plugins/dsh-sideask/api/…')
┌────────────┼──────────────────────────── dsh Web 前端（浏览器）─────────────────────────────────┐
│            ▼                                                                                   │
│  ┌──────────────────────── 浏览器半（src/client → lib/client.js）─────────────────────┐        │
│  │ index.ts         window.__ModuleLoader__.load({id:'dsh-sideask', factory(require)}) │        │
│  │ plugin.ts        apply(ctx)：locale / shortcuts / inter actions / shell.overlay     │        │
│  │                  ↓                                                                 │        │
│  │ ┌──────────── shadow root（隔离样式） ────────────┐   ┌─ 主对话只读通道 ────────┐   │        │
│  │ │ window-shell.tsx  悬浮窗外壳/拖拽/吸附/最小化    │   │ ctx.sessions.retain(id) │   │        │
│  │ │ thread-view.tsx   消息流 + 流式 + 引用 chip      │◀──│  .ready → eventSource   │   │        │
│  │ │ context-panel.tsx 上下文详情/预算/降级原因       │   │  getSnapshot/subscribe  │   │        │
│  │ │ writeback.ts      复制/插入引用块/引用到主对话   │──▶│ ctx.conversation.input  │   │        │
│  │ └──────────────────────────────────────────────────┘   └─────────────────────────┘   │        │
│  │ 纯逻辑（可单测、无 DOM）：window-state.ts / stream.ts / transcript.ts / markdown.ts  │        │
│  │ 复用 shared：context.ts（预算+去重+缓存） tokens.ts redact.ts citations.ts prompt.ts │        │
│  └────────────────────────────────────────────────────────────────────────────────────┘        │
│                                                                                                │
│  主对话区域（ui-chat / ui-conversation）：**不被写入**，只有用户点“引用”时才通过输入框 API 插入 │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 数据流（一次提问的完整链路）

```
① 快捷键/点悬浮球
   → window-shell 展开（位置从 localStorage 恢复）
② 用户输入问题（可点“带上上下文”开关）
   → 若开关关：context = null，直接 question-only
③ 提取（异步、可取消）
   ctx.sessions.retain(当前会话).ready
   → binding.eventSource.getSnapshot().entries  （只读）
   → transcript.ts 映射为 ChatMessage[]（只取 user/assistant 的 text block）
   → 增量：投影缓存按 id+hash 命中，只有新消息/流式改写才重算
   → buildContext()：去重 → 窗口(最近 N) → 预算分配(选中>最近>摘要) → 脱敏 → 引用编号 c1..cN
   → 得到 ContextBundle{items, summary, selection, stats}
④ 发问
   POST /plugins/dsh-sideask/api/ask  {apiVersion, requestId, threadId, question, context, sessionId}
   → hosted: 校验 apiVersion/长度 → 隐私闸门(readContext) → sanitizeBundle(重算+重脱敏+砍预算)
   → 线程记录 user 消息 → 组 prompt（system 指令 + 上下文/历史/问题）
   → ctx.llm.stream(...) → SSE 帧：accepted → settings → delta* → usage → done{citations}
   → 线程记录 assistant 消息（含 citations / error / replyTo）
⑤ 渲染
   delta 逐字追加；done 后把 ⟦refs⟧ 解析成 citation chips
   点 chip → 显示被引用原文摘录（P1：定位并高亮主对话原文）
⑥ 回写（只有用户点才发生）
   复制 → navigator.clipboard.writeText
   插入引用块 → inputActions.insertQuote(text)  （失败 → setDraft → 再失败 → 复制兜底）
   引用到主对话 → insertQuote(带问题摘要与来源)
   作为草稿 → setDraft(text)
⑦ 关闭/清空
   关闭窗口：只改窗口状态；清空线程：只删插件自己的存储；主对话零变化
```

### 4.2 部署/装载视图（**已验证**的装载事实）

```
dsh-spend-wallpaper 的真实装载方式（本插件同构）：
profile/package.json 定义 bundles → 每个 bundle 的 cordis.patch.yml 有：
    - insert:
        - id: sideask
          name: dsh-sideask
安装：dsh plugin --profile <p> add link:E:/workspace/dsh-sideask   （link: 即本地链接）
浏览器侧：dsh-client-modules 按 package.json 的 exports["./client"] 提供 bundle，
          页面里执行 window.__ModuleLoader__.load({id, factory})
          执行 bundle 只是“注册 factory”，副作用（CSS 注入等）延迟到首次 materialize
```

---

## 5. 模块与接口定义

### 5.1 文件树（交付形态，类 git 项目）

```
dsh-sideask/
├─ package.json                # dsh 清单：manifestVersion/bundle.patch/client.platform、exports["./client"]
├─ cordis.patch.yml            # 插件行：insert {id: sideask, name: dsh-sideask}
├─ tsconfig.json               # 类型检查（host+shared+client，strict）
├─ tsconfig.host.json          # host 侧构建（module NodeNext）
├─ src/
│  ├─ shared/                  # 双端共用纯逻辑（无平台 API，可单测）
│  │  ├─ contract.ts           # 线协议：AskRequest/AskEvent/ContextBundle/Thread/SideAskError…
│  │  ├─ tokens.ts             # 保守 token 估算 + 头尾截断
│  │  ├─ redact.ts             # 敏感信息脱敏（双端同源，幂等）
│  │  ├─ context.ts            # 去重 + 预算 + 优先级降级 + ProjectionCache(增量)
│  │  ├─ citations.ts          # 引用协议解析/解析映射
│  │  ├─ prompt.ts             # prompt 组装（system + user 分节）
│  │  └─ errors.ts             # provider failure code → 用户可读错误 + 可重试/可降级
│  ├─ host/                    # 宿主半（Node ESM）
│  │  ├─ index.ts              # name / Config / apply
│  │  ├─ config.ts             # schemastery Config + readConfig()（getter 解包/钳制）
│  │  ├─ runtime.ts            # 编排 + sanitizeBundle + AsyncQueue + 取消/超时
│  │  ├─ llm.ts                # resolveRoute / callModel / finish 处理
│  │  ├─ store.ts              # 线程持久化（原子写、有界、防损坏）
│  │  └─ http.ts               # 路由注册 + 同源校验 + SSE
│  └─ client/                  # 浏览器半（TS → esbuild 单文件 bundle）
│     ├─ index.ts              # ModuleLoader 注册入口
│     ├─ plugin.ts             # apply(ctx)：各插槽/快捷键/交互注册与卸载
│     ├─ window-state.ts       # 拖拽/吸附/缩放/记忆（纯函数，可测）
│     ├─ stream.ts             # SSE 帧解析 + 流式状态归约（纯）
│     ├─ transcript.ts         # 会话事件 → ChatMessage[]（纯）+ 增量水位
│     ├─ markdown.ts           # 安全最小渲染（纯）
│     ├─ context-source.ts     # 会话绑定/选区捕获/预算调用
│     ├─ host-api.ts           # /plugins/dsh-sideask/api 客户端（fetch + abort）
│     ├─ writeback.ts          # 复制/插入引用块/引用到主对话/草稿
│     ├─ window-shell.tsx      # 悬浮窗外壳（Shadow DOM 挂载、拖拽）
│     ├─ thread-view.tsx       # 轻对话 UI（消息/流式/引用/错误/重试）
│     └─ context-panel.tsx     # 上下文详情（预算/降级原因/开关）
├─ scripts/build.mjs           # tsc(host) + esbuild(client) + bundle 形状校验
├─ scripts/check.mjs           # 静态自检（清单/导出/无 import 等）
├─ test/                       # node --test：shared / host(harness) / client(纯模块)
├─ docs/
│  ├─ design.md                # 本文档
│  ├─ ui-wireframe.md          # 线框与交互流程
│  ├─ quickstart.md            # 安装/配置/自查
│  ├─ verification.md          # 真机冒烟证据（命令 + 输出）
│  └─ research/                # 宿主 API 取证（client-api/host-api/patterns）
└─ examples/profile-patch.yml  # 本地体验用配置覆盖
```

### 5.2 宿主半接口（cordis 契约，**已验证**）

```ts
// lib/host/index.js
export const name = 'sideask'
export const Config = z.object({ /* 见 5.4 */ })
export function apply(ctx: Context, config: ConfigShape): void
```

| 用到的 ctx 成员 | 语义 | 证据 |
|---|---|---|
| `ctx.get('llm')` / `ctx.inject(['llm'], cb)` | 模型服务 | `dsh-llm/lib/index.js:2395` |
| `ctx.get('agentDefaultModel').currentSelection()` | 宿主默认模型 | `dsh-agent-default-model/lib/index.js` |
| `ctx.get('webServer')` / `ctx.inject(['webServer'], cb)` | HTTP 路由宿主 | `dsh-spend-wallpaper/lib/http.js:146` |
| `ctx.effect(fn, label)` | 注册可清理副作用（`fn` 返回 disposer） | `dsh-spend-wallpaper/lib/index.js:577,583-585` |
| `ctx.provide(name, value)` | 提供服务（可选，便于其它插件复用） | 同上 `:579` |

### 5.3 HTTP 接口（**[契约]**，前缀 `ROUTE_PREFIX = /plugins/dsh-sideask/api`）

| 方法 | 路径 | 请求 | 响应 | 说明 |
|---|---|---|---|---|
| GET | `/bootstrap` | — | `BootstrapResponse` | 设置投影、解析出的模型、可用 provider、不可用原因 |
| POST | `/ask` | `AskRequest` | `text/event-stream`（`AskEvent` 逐帧） | 唯一模型调用入口；支持取消 |
| POST | `/cancel` | `{requestId}` | `{cancelled: boolean}` | 与 `/ask` 的 abort 幂等 |
| GET | `/threads` | — | `ThreadListEntry[]` | 按更新时间倒序 |
| POST | `/threads` | `{sessionId?}` | `Thread` (201) | 新建空线程 |
| GET | `/threads/:id` | — | `Thread` \| 404 | 含全部消息 |
| DELETE | `/threads/:id` | — | `{deleted: boolean}` | 删除单线程 |
| DELETE | `/threads` | — | `{cleared: n}` | 清空全部历史（隐私开关用） |
| GET | `/health` | — | `{ok, model, providers, unavailable}` | 200/503，排障用 |

**SSE 帧序列（成功）**

```
data: {"type":"accepted","requestId":"r1","mode":"context"}
data: {"type":"settings","requestId":"r1","settings":{...}}
data: {"type":"delta","requestId":"r1","text":"根据"}
data: {"type":"delta","requestId":"r1","text":" [c1] …"}
data: {"type":"usage","requestId":"r1","promptTokens":2211,"completionTokens":133}
data: {"type":"done","requestId":"r1","messageId":"m_...","text":"…","citations":[{"ref":"c1","messageId":"msg-9","role":"user","excerpt":"…"}]}
```

**SSE 帧序列（失败）**：`accepted` → `error{code, message, retryable, degradableToQuestionOnly}`；客户端据此显示“重试 / 仅用问题回答”。

**错误码表**（`SideAskErrorCode`）：`API_MISMATCH`、`BAD_REQUEST`、`CONTEXT_DISABLED`、`NO_ADAPTER`、`MISSING_CREDENTIAL`、`AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`ABORTED`、`TIMEOUT`、`PROVIDER_ERROR`、`INTERNAL`。映射自 provider 的稳定 failure code（`dsh-llm/README.md` 的 `NO_ADAPTER/MISSING_CREDENTIAL/AUTH/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED/QUOTA/ACCOUNT_QUOTA`）。

### 5.4 配置 Schema（schemastery，**[已验证]** 语法）

| 字段 | 类型/范围 | 默认 | 作用 |
|---|---|---|---|
| `enabled` | bool | true | 总开关（关掉后 `/ask` 直接报错） |
| `provider` / `model` | string | `''` | 空 = 用宿主默认模型 |
| `answerMaxTokens` | 64–8192 | 1200 | 回答长度上限 |
| `temperature` | 0–2 | 0.4 | 采样温度（旁问偏确定） |
| `recentMessageLimit` | 2–80 | 12 | 最近 N 条 |
| `contextBudgetTokens` | 256–64000 | 3000 | 上下文预算硬上限 |
| `autoSummary` | bool | true | 是否启用历史摘要层（P1 生效） |
| `requireCitations` | bool | true | 是否要求引用块 |
| `readContext` | bool | true | **隐私开关**：关掉后不读主对话 |
| `redactSensitive` | bool | true | 敏感信息脱敏（双端） |
| `persistHistory` | bool | true | 轻对话历史是否落盘 |
| `defaultCorner` | 4 角枚举 | top-right | 悬浮球与悬浮窗的默认停靠角 |
| `hotkey` | string | `Alt+Shift+A` | 唤起快捷键 |
| `customRedactionPatterns` | string[] | [] | 自定义脱敏正则 |
| `historyTurns` | 0–40 | 8 | 内嵌的历史旁问轮数 |
| `maxThreads` | 1–200 | 30 | 线程数上限 |
| `maxMessagesPerThread` | 10–1000 | 200 | 单线程消息上限 |
| `requestTimeoutMs` | 5s–600s | 120s | 单次调用墙钟上限 |

> 全部字段 `.volatile()`：**改配置即时生效、无需重载插件**（读取时解包 getter，见 `config.ts:readConfig`）。

### 5.5 共享契约核心类型（节选，完整见 `src/shared/contract.ts`）

```ts
interface ChatMessage  { id, role, text, createdAt?, toolName?, truncated? }
interface TranscriptSnapshot { sessionId, revision, messages }
interface ContextItem  { ref, messageId, role, text, tokens, truncated, source }
interface ContextStats { budgetTokens, usedTokens, dedupedCount, redactedCount, truncations, degradations }
interface ContextBundle{ items, summary, selection, stats }
interface Thread       { id, title, createdAt, updatedAt, sessionId, messages }
interface AskRequest   { apiVersion, requestId, threadId, question, context, sessionId?, settings? }
```

---

## 6. 上下文提取与 Token 策略

### 6.1 提取范围：**只读、只读“可见”**

| 事件类型 | 处理 | 理由 |
|---|---|---|
| `user/message` | 取 `event.data.content` 中 `type==='text'` 的块 | 用户可见 |
| `assistant/message` | 取 `event.data.message.content` 的 text 块 | 用户可见 |
| `reasoning` / COT 流 | **丢弃** | 隐藏推理，不该外传 |
| 工具调用参数与结果 | 仅取可见文本摘要，单条按 `MAX_ITEM_RATIO` 截断 | 可能含大量噪声/敏感数据 |
| 结构事件（`turn/start`、`step/start`、compaction checkpoint、审批等） | **丢弃** | 非对话内容 |
| 附件/图片 | MVP 丢弃（P2 再做） | 成本与隐私 |

实现：`src/client/transcript.ts`（纯函数）+ `eventSource.subscribe` 增量。

### 6.2 组合配方（“最近 N 条 + 历史摘要 + 用户选中 + 当前问题”）

```
context = {
  selection : 用户高亮文本（最高优先级，上限 40% 预算）
  recent    : 最近 N 条可见消息（N = recentMessageLimit，新→旧填充）
  summary   : 更早历史的摘要（自动摘要层，上限 25% 预算；P1）
  question  : 当前问题（始终保留，单独计数）
}
```

顺序原则：**用户选中 > 最近消息 > 历史摘要**。注意“摘要优先”的正确语义是：当更早的消息放不进窗口时，用摘要**代表**它们，而不是用摘要挤掉最近的真实消息（实现里表现为“摘要先被丢弃”）。

### 6.3 Token 预算算法（`src/shared/context.ts:buildContext`）

```
输入：transcript, question, selection?, settings{recentMessageLimit, contextBudgetTokens, autoSummary}, overflowSummary?
B = max(256, contextBudgetTokens)

1) 去重：从新→旧扫描，丢弃“归一化后完全相同”的旧消息；对 ≥240 字符的行做“包含”去重（工具输出被引用是典型场景）。记录 dedupedCount。
2) 取窗口：最近 N 条（N=recentMessageLimit）
3) 选中：cap = max(48, floor(B × 0.40))；超长则头尾截断（head 60% / tail 40%，中间加省略标记）
4) 摘要：cap = max(48, floor(B × 0.25))；autoSummary=false 或没有摘要则跳过
5) 最近消息：可用 = B − 选中token − 摘要token；
   从最新往旧累加，单条上限 = max(48, floor(B × 0.35))，放不下就截断该条并停止
6) 降级（按序，写进 stats.degradations）：
   a. 若最近消息被裁 → 先丢摘要，重算最近（'summary-dropped-for-recent'）
   b. 仍超 → 'recent-trimmed'
   c. 一条都放不下且无选中 → 'question-only'
   d. 兜底断言：used ≤ B，否则 'over-budget-trimmed'
7) 编号：选中=c1，其余按从旧→新 c2..cN
8) 脱敏：逐项脱敏后再计 token（掩码本身占 token，必须计入）
```

**不变量（单测覆盖）**：`Σitems.tokens + tokens(summary) ≤ contextBudgetTokens`，任何预算/输入组合都不破。

### 6.4 增量刷新（不重复全量读取）

- **水位线**：`TranscriptSnapshot.revision` 单调递增；`eventSource.subscribe` 的 `change.kind ∈ {replace, prepend, append, settle-assistant}`。
- **投影缓存** `ProjectionCache`：键 = `messageId`，值 = `{hash, redactedText, tokens, redactions}`；hash = FNV-1a(`id|role|toolName|text|脱敏选项`)。
  - 新消息 → 1 次投影；
  - 流式改写的最后一条 → hash 变，重算 1 次；
  - 其余 → 命中缓存（0 次）。
- **单测证据**：`ProjectionCache: unchanged messages are served from cache`（跨两次构建，第二次 `misses` 只 +1）、`edited message is re-projected`、`prune` 释放窗口外内存。
- **异步与可取消**：提取在 `requestIdleCallback`/`setTimeout(0)` 中分片执行，带 `AbortController`；新提问会 abort 上一次提取；硬超时（默认 1.5s）后降级为 `buildQuestionOnlyBundle`（`degradations: ['extraction-failed']`）。

### 6.5 去重策略（三类）

| 类型 | 规则 | 例子 |
|---|---|---|
| 完全重复 | 空白归一化后字符串相等，保留最新 | 用户重复粘贴同一段 |
| 包含关系 | 短（≥240 字符）完全包含于长消息，保留长（新） | 工具输出 → 助手复述 |
| 空消息 | 归一化后为空 | 纯空白/纯附件消息 |

### 6.6 敏感信息过滤（双层、幂等）

**规则集**（`src/shared/redact.ts`）：
1. PEM 私钥块；2. `*_KEY/TOKEN/SECRET/PASSWORD=…` 赋值（保留变量名）；3. `sk-/ak-/ghp_/xox*` 类 API Key；4. JWT；5. `Bearer/Basic` 令牌；6. 邮箱；7. 中国手机号；8. 15–19 位卡号；9. 公网 IPv4（保留 `127.0.0.1` 等调试地址）；10. home 目录与用户名（由宿主注入）；11. 用户自定义正则（非法正则忽略，不报错）。

**双层流程**：
```
浏览器：transcript → redact(敏感) → buildContext → 只发掩码后的 ContextBundle
  ↓（本地同源 HTTP）
宿主：sanitizeBundle() → 再 redact 一次（幂等，防客户端被篡改）→ 重算 token/预算
  ↓
prompt → ctx.llm.stream
```
**为什么要双层**：浏览器不是信任边界（插件/脚本可被注入），宿主必须独立保证“发出去的 prompt 里没有原始敏感串”。单测断言：掩码幂等（跑两次结果不变，第二次命中 0）。

### 6.7 引用标注机制

- 每条上下文条目带短编号 `cN`（选中为 `c1`），prompt 里用 `[c3｜用户｜msg:abc123] + 正文` 的形式标注来源。
- system 指令要求：正文正常作答，**结尾另起一行**输出 `⟦refs: c1, c3⟧`；无引用输出 `⟦refs:⟧`。
- 解析：末尾块为准；行内 `[cN]` 作为补充；**未知编号直接丢弃**（模型不能引用没给过它的东西）；正文保留行内标记用于渲染。
- 渲染：chip 显示 `c3`，悬浮/点击显示被引用条目的 120 字摘录 + 来源角色；P1 可滚动定位主对话原文。

### 6.8 Token 超限的降级矩阵

| 触发条件 | 表现 | UI 提示 |
|---|---|---|
| 上下文预算不足 | 丢摘要 → 裁最近 → 只留选中/问题 | “上下文已按预算压缩：丢弃摘要” |
| 选中文本过长 | 头尾截断到 40% 预算 | “选中内容已截断” |
| 单条消息过长 | 截到 35% 预算，标记 `truncated` | 条目上显示“已截断” |
| 提取超时/异常 | `question-only` | “未能读取上下文，仅按问题回答” |
| 模型侧 `CONTEXT_WINDOW_EXCEEDED` | 错误可降级 | “重试（仅用问题）” |
| 回答达到 maxTokens | 末尾追加“已截断” | 提示可继续追问 |

---

## 7. UI / 交互流程

> 详细线框见 `docs/ui-wireframe.md`；本节给状态与交互定义。

### 7.1 悬浮入口与窗口

- **入口**：默认右上角 42px 圆形悬浮球（`defaultCorner` 可配 4 角），带未读/流式小圆点；点击或快捷键展开。球的位置跟随停靠角：窗口被拖动/吸附到哪个角，收起后的球就在哪个角。
- **窗口**：默认 380×520（min 300×320，max 70vw×80vh），圆角 14px，`backdrop-filter` 磨砂，边框/背景取 `--dsw-*` 变量 + 兜底值。
- **拖拽**：按住标题栏拖动（`setPointerCapture`，拖动时 `user-select:none`），松手距边 <24px 吸附到对应角。
- **吸附/记忆**：`localStorage['dsh-sideask.window.v1'] = {corner,x,y,w,h,minimized,collapsed,contextOn}`；刷新恢复。
- **最小化**：收成贴边小胶囊（显示“旁问”+当前状态点）；**展开/收起**是内容区折叠（标题栏保留）。
- **快捷键**：`Alt+Shift+A` 切换显示；`Esc` 收起；`Ctrl/Cmd+Enter` 发送（可配）。

### 7.2 当前会话跟踪（**最大风险点，三级回退**）

```
① 探针法（首选）：向会话作用域插槽（conversation.input.dock）注入一个 display:none 的组件，
   读取标准 Hook/Prop 上的当前会话 id → 写入窗口状态（会话切换时自动更新）
② 事件法：用户在主对话里选中文本 → 选区交互回调带 request.sessionId → 顺带更新
③ 列表法：ctx.sessions.list() 取最近活跃会话 id（可能不准，作为兜底）
④ 全都失败：窗口显示“未绑定对话”，仍可纯提问（question-only），并提供“手动抓取上下文”按钮
```
窗口顶部始终显示当前绑定的会话小标签（可点开看会话标题），让用户能确认“我正在问哪个对话”。

### 7.3 轻对话状态机

```
                 ┌──────────────── unavailable（无模型/无 server）──────────────┐
                 │  (bootstrap.unavailable != null)  重试: 重新 bootstrap      │
                 ▼                                                             │
 idle ──send──▶ extracting ──timeout/error──▶ degraded(question-only) ──send──▶ asking
   ▲                │ ok                                                          │
   │                └──────────────────────────────▶ asking ──cancel──▶ cancelled(保留已得文本)
   │                                                   │
   │                                          ┌────────┴─────────┐
   │                                       done              error{retryable, degradable}
   │                                          │                  └─retry→asking / 降级→degraded
   └──────────────────────────────────────────┴─── clear/switchThread ──▶ idle
```

要点：
- `extracting` 期间发送按钮显示“正在整理上下文…”，但**不阻塞**用户继续输入；用户可点“跳过上下文”。
- `asking` 期间可停止；停止后保留已生成文本并标记“已停止”。
- `error` 一定显示：错误码、可读消息、是否有“重试”/“仅用问题回答”。
- 线程切换/清空只影响插件自己的存储，主对话状态零变化。

### 7.4 窗口状态机（几何）

```
hidden ⇄ docked{expanded | collapsed | minimized}
  docked 拖动 → dragging → （松手，距边<24px）→ snap(吸附角)
  docked 拖右下角 → resizing → （钳制 min/max）→ docked
  minimized 点击 → docked.expanded
  collapsed 点击标题 → docked.expanded
  任何状态 → hidden（快捷键/Esc/关闭）  ※ 保留几何与线程
```

纯函数 `window-state.ts` 导出 `applyDrag`, `snapCorner`, `clampResize`, `serialize/restore`，单测覆盖越界与四角吸附。

### 7.5 关键交互清单

| 交互 | 触发 | 结果 | 失败处理 |
|---|---|---|---|
| 问 | Enter / 发送按钮 | 提取→请求→流式渲染 | 错误态 + 重试/降级 |
| 停 | 停止按钮 / Esc（流式中） | abort 请求 + 保留文本 | — |
| 带上下文开关 | 底部开关 | 立即重算 `c1..cN` 计数徽标 | 关闭时不读任何消息 |
| 选中文本提问 | 主对话选中 → 我们的选区交互按钮“旁问” | 选中作为 `c1` 最高优先级 | 无选中 → 忽略 |
| 复制 | 回答下方按钮 | 写剪贴板 + toast | 剪贴板不可用 → 提示手动选择 |
| 插入引用块 | 同上 | `insertQuote` → 主对话输入框出现 `> ` 引用块 | 返回 false → 试 `setDraft` → 再失败 → 复制+提示 |
| 引用到主对话 | 同上 | 引用块 + 一句“来自旁问”的说明 | 同上 |
| 作为草稿 | 同上 | `setDraft(text)` | 同上 |
| 清空线程 | 头部菜单 | 删除当前线程消息 | 确认弹窗（不可撤销） |
| 清空全部历史 | 设置面板 | `DELETE /threads` | 同上 |
| 上下文详情 | 计数徽标 | 显示预算/命中/去重/脱敏/降级原因 | — |

---

## 8. 数据模型与存储

### 8.1 宿主线程存储（`$DSH_HOME/storages/sideask/threads.json`）

```jsonc
{
  "schema": 1,
  "threads": [
    {
      "id": "sa_lx8k2p_ab12cd34",
      "title": "解释这段重试逻辑",          // 首条用户问题自动截断生成
      "createdAt": 1762xxxxxxx000,
      "updatedAt": 1762xxxxxxx000,
      "sessionId": "sess-abc",             // 关联主会话（advisory，不用于写）
      "messages": [
        {
          "id": "m_lx8k3q_9f21",
          "role": "user",
          "text": "为什么这里要退避？",
          "createdAt": 1762xxxxxxx000,
          "context": { "budgetTokens": 3000, "usedTokens": 2211, "dedupedCount": 2,
                       "redactedCount": 3, "truncations": {"selection":0,"recent":1,"summary":0},
                       "degradations": ["summary-dropped-for-recent"] }
        },
        {
          "id": "m_lx8k4r_7a02",
          "role": "assistant",
          "text": "因为 429 之后立即重试会放大拥塞…",
          "createdAt": 1762xxxxxxx120,
          "citations": [{ "ref": "c1", "messageId": "msg-9", "role": "user", "excerpt": "…" }],
          "replyTo": "m_lx8k3q_9f21"
        }
      ]
    }
  ]
}
```

- **原子写**：写临时文件 → `rename`（崩溃不会留半截 JSON）。
- **有界**：`maxThreads`（默认 30，超出丢最旧）、`maxMessagesPerThread`（默认 200，超出丢最旧）；读取时逐字段 `sanitize*`，损坏则视为空并从下一次写开始自愈。
- **防抖**：400ms 合并写；`dispose()` 强制 flush。
- **隐私开关**：`persistHistory=false` 时仍可用（内存态），但**不落盘**；`DELETE /threads` 清空文件内容。

### 8.2 浏览器本地存储（只放 UI 偏好）

| key | 内容 | 说明 |
|---|---|---|
| `dsh-sideask.window.v1` | `{corner,x,y,w,h,minimized,collapsed}` | 窗口几何/折叠态；官方右侧栏同款做法 |
| `dsh-sideask.ui.v1` | `{contextOn,lastThreadId,showContextDetails}` | UI 开关与最后线程 |
| `dsh-sideask.draft.v1` | `{threadId, text}` | 输入框草稿（刷新不丢） |

**不放**：任何对话内容、任何凭据、任何上下文快照（避免二次留存）。

### 8.3 数据生命周期（隐私视角）

| 数据 | 产生 | 存储 | 清除方式 | 默认 |
|---|---|---|---|---|
| 主对话消息 | 宿主 | 宿主会话日志 | 宿主 | **本插件只读、不复制到插件存储** |
| 上下文快照（ContextBundle） | 浏览器内存 | 仅在请求期间存在（含缓存对象） | 关闭页面/清缓存 | 不持久化 |
| 轻对话线程 | 宿主 store | `storages/sideask/threads.json` | 线程删除 / 清空历史 / 关 `persistHistory` | 落盘 |
| 窗口几何/UI 开关 | 浏览器 | localStorage | 浏览器清站点数据 / 设置里“重置布局” | 落盘 |
| 脱敏后的 prompt | 宿主内存 | 不落盘（只记录 usage 数字与 citations） | 请求结束释放 | 不持久化 |

---

## 9. 关键伪代码

### 9.1 上下文构建（核心，节选真实实现 `src/shared/context.ts`）

```ts
export function buildContext(input: ContextBuildInput): ContextBundle {
  const B = Math.max(256, input.settings.contextBudgetTokens)
  if (!input.settings.readContext) return empty('context-disabled')

  const { kept, dropped } = dedupeMessages(input.snapshot.messages)   // 去重
  const window = kept.slice(-input.settings.recentMessageLimit)        // 最近 N 条

  // 1. 选中优先（上限 40%）
  let selectionTokens = 0
  if (input.selection) {
    const masked = redact(input.selection.text, input.redactOptions)   // 先脱敏
    const fitted = truncateToTokens(masked.text, Math.floor(B * 0.40))
    selectionTokens = estimateTokens(fitted.text)
  }

  // 2. 摘要（上限 25%）
  let summaryTokens = input.settings.autoSummary && input.overflowSummary
    ? estimateTokens(truncateToTokens(input.overflowSummary.text, Math.floor(B * 0.25)).text)
    : 0

  // 3. 最近消息：从新到旧填充剩余预算，单条上限 35%
  const fill = () => {
    const available = B - selectionTokens - summaryTokens
    const maxItem = Math.floor(B * 0.35)
    const chosen = []
    let used = 0
    for (let i = window.length - 1; i >= 0; i--) {
      const p = cache.project(window[i], input.redactOptions)          // 增量：命中即复用
      const cap = Math.min(available - used, maxItem)
      if (cap < 48) break
      const fitted = truncateToTokens(p.text, cap)
      const tokens = estimateTokens(fitted.text) + MESSAGE_OVERHEAD_TOKENS
      chosen.push({ messageId: window[i].id, role: window[i].role, text: fitted.text, tokens, source: 'recent' })
      used += tokens
      if (fitted.truncated) break
    }
    return { chosen: chosen.reverse(), used, trimmed: /* 是否还有没塞进来的 */ }
  }

  let recent = fill()
  // 4. 降级：最近消息优于摘要
  if (recent.trimmed && summaryTokens > 0) {
    summaryTokens = 0; stats.degradations.push('summary-dropped-for-recent')
    recent = fill()
  }

  // 5. 编号 + 不变量
  const items = assignRefs(selection, recent)   // c1, c2, …
  const usedTokens = selectionTokens + summaryTokens + recent.used
  if (items.length === 0 && !summary) stats.degradations.push('question-only')
  return { items, summary, selection, stats: { ...stats, usedTokens, dedupedCount: dropped } }
}
```

### 9.2 Prompt 组装（`src/shared/prompt.ts`）

```ts
function buildPrompt({ question, bundle, history, requireCitations }) {
  const system = [
    '你是 DSH 主对话旁的「旁问」助手。',
    '只基于提供的只读上下文回答；上下文不足时明说「上下文里没有」，不要臆测。',
    '你无法修改主对话，也不要声称已经修改。默认不超过 12 行。',
    requireCitations
      ? '结束时另起一行输出引用块：⟦refs: c1, c3⟧（无引用则 ⟦refs:⟧）。'
      : '本次不需要输出引用块。',
  ].join('\n')

  const user = [
    history.length   ? `## 之前的旁问对话\n${renderHistory(history)}\n` : '',
    bundle?.summary ? `## 主对话历史摘要\n${bundle.summary}\n` : '',
    bundle?.items?.length
      ? `## 主对话上下文（只读，按编号引用）\n${bundle.items.map(i =>
          `[${i.ref}｜${labelOf(i)}｜msg:${i.messageId}]${i.truncated ? '｜已截断' : ''}\n${i.text}`).join('\n\n')}\n`
      : '## 主对话上下文\n（本次没有可用上下文，请仅基于当前问题回答。）\n',
    `## 当前问题\n${question}`,
  ].join('\n')

  return { system, user }
}
```

### 9.3 宿主一次调用的编排（`src/host/runtime.ts:ask`，节选）

```ts
async *ask(request, transportSignal) {
  // 1) 校验
  if (request.apiVersion !== API_VERSION) return yield err('API_MISMATCH')
  const q = request.question?.trim()
  if (!q) return yield err('BAD_REQUEST')
  if (q.length > 8000) return yield err('BAD_REQUEST')

  // 2) 路由 + 隐私闸门
  const route = resolveRoute(config, ctx.get('llm'), ctx.get('agentDefaultModel'))
  if ('error' in route) return yield err(route.error)
  const bundle = config.readContext ? sanitizeBundle(request.context, config) : null

  // 3) 线程记账（只写插件自己的 store）
  store.ensure(threadId, sessionId)
  const userMsg = { id: newId('m'), role: 'user', text: q, createdAt: Date.now(), context: bundle?.stats }
  store.append(threadId, userMsg)

  // 4) prompt + 事件
  const prompt = buildPrompt({ question: q, bundle, history: priorMessages, requireCitations: config.requireCitations })
  yield { type: 'accepted', requestId, mode: bundle ? 'context' : 'question-only' }

  // 5) 调用模型（可取消 + 墙钟超时）
  const controller = new AbortController()
  this.inflight.set(requestId, controller)
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, config.requestTimeoutMs)
  const result = await callModel(llm, route, {
    instruction: prompt.system, body: prompt.user,
    signal: controller.signal, maxTokens: config.answerMaxTokens, temperature: config.temperature,
  }, delta => queue.push({ type: 'delta', requestId, text: delta }))

  // 6) 终态：错误要落线程（可重试），成功要解析引用
  if (result.failure) {
    store.append(threadId, { ...assistantStub(result.text), error: result.failure, replyTo: userMsg.id })
    return yield { type: 'error', requestId, error: result.failure }
  }
  const { text, citations } = finaliseAnswer(result.text, bundle?.items ?? [])
  const assistant = { id: newId('m'), role: 'assistant', text, citations, replyTo: userMsg.id, createdAt: Date.now() }
  store.append(threadId, assistant)
  yield { type: 'done', requestId, messageId: assistant.id, text, citations }
}
```

### 9.4 客户端流式解析 + 取消（`src/client/stream.ts` + `host-api.ts`）

```ts
async function ask(req: AskRequest, onEvent: (e: AskEvent) => void, signal: AbortSignal) {
  const res = await fetch(`${ROUTE_PREFIX}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal,
    credentials: 'same-origin',
  })
  if (!res.ok) throw await toSideAskError(res)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {      // SSE 帧边界
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = frame.split('\n').find(l => l.startsWith('data: '))
      if (line) onEvent(JSON.parse(line.slice(6)))
    }
  }
}
// 用户点“停止”：abort() 本地请求，并 POST /cancel {requestId}（幂等，防宿主侧空转）
```

### 9.5 脱敏（`src/shared/redact.ts`，节选规则）

```ts
const rules = [
  { kind: 'pem',          pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'env-assignment', pattern: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*("([^"\n]{4,})"|'([^'\n]{4,})'|([^\s,;]{4,}))/g },
  { kind: 'api-key',      pattern: /\b(?:sk|ak|rk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g },
  { kind: 'jwt',          pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  { kind: 'bearer',       pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { kind: 'email',        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'phone-cn',     pattern: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g },
  // …卡号/公网 IP/home 目录/用户名/用户自定义
]
// 掩码形如 «密钥:****»；设计上保证幂等：掩码串不会再被任何规则命中
```

---

## 10. 测试与验收标准

### 10.1 自动化测试（`node --test test/`）

| 层 | 文件 | 覆盖 | 现状 |
|---|---|---|---|
| Token | `shared.tokens.test.mjs` | CJK/拉丁估算、截断后不超预算、标记存在 | ✅ 9 例 |
| 脱敏 | `shared.redact.test.mjs` | Key/JWT/邮箱/手机/私钥/路径/自定义/幂等/白名单 | ✅ 10 例 |
| 上下文 | `shared.context.test.mjs` | 预算硬上限、选中优先、最近优先于摘要、去重(完全/包含)、增量缓存命中、限额、只读模式、编号 | ✅ 17 例 |
| 引用/提示词 | `shared.citations.test.mjs` | 末尾块/全角/行内/未知引用丢弃/去重/摘录/分节 | ✅ 16 例 |
| 宿主 HTTP | `test/host.http.test.mjs` | bootstrap、ask 流、错误码、隐私闸门、403、线程 CRUD、不落盘、预算 | 见 `docs/verification.md` |
| 浏览器纯逻辑 | `test/client.*.test.mjs` | 窗口几何/吸附/钳制、SSE 解析、transcript 映射、安全渲染 | 见 `docs/ui-wireframe.md` |
| 真机冒烟 | `test/verify/*` | 安装到临时 profile → 启动 → `GET /plugins/dsh-sideask/api/bootstrap` 200 → client bundle 可下载 | 见 `docs/verification.md` |

### 10.2 验收标准（逐条对应你给的 5 条）

| 你的验收标准 | 本设计如何满足 | 证据位置 |
|---|---|---|
| **能说清“当前对话上下文如何被安全、增量、限额地提取”** | 只读 `eventSource` 快照 → 只取可见 text 块 → 去重 → 优先级预算 → 双层脱敏；增量靠 `ProjectionCache(id+hash)` + revision 水位 | §6.1–6.7、`src/shared/context.ts`、`test/shared.context.test.mjs` |
| **能说清“轻对话为什么不污染主对话，以及如何显式引用回去”** | ①宿主半不 import 任何 session/agent 写接口 ②模型输入是 request-only user 输入，不产生 durable message ③线程只存插件 store ④浏览器只读快照、不 mutate ⑤回写仅 `insertQuote/setDraft/copy` 且必须是用户点击 | §3.1/§3.3、§9.3、`src/host/runtime.ts`、`src/client/writeback.ts` |
| **每个宿主能力都有“假设/待确认”标记** | H1–H15 清单逐条标注 `[已验证]/[假设]`，并给降级 | §1.3 |
| **有失败降级和隐私开关** | 错误码表 + `retryable/degradableToQuestionOnly`；`readContext/redactSensitive/persistHistory/自定义脱敏`；六种降级（见 §6.8/§11） | §5.3、§6.8、§11 |
| **输出可直接交给开发拆分任务** | P0 表 → 每项对应模块/文件/验收点；文件树即任务边界 | §2、§5.1、§12 |

### 10.3 手工验收脚本（10 分钟）

1. 装好并打开主对话 → 右上角出现悬浮球；`Alt+Shift+A` 展开/收起；拖动到其它角松手吸附；刷新后位置保持。
2. 问一个**只有看上下文才能答**的问题（如“上面那段代码里我改了什么？”）→ 回答带 `cN` 引用 chip；点 chip 能看到原文摘录。
3. 关闭“带上上下文”重问 → 回答明确说缺少上下文；请求里无对话内容（DevTools Network 可验证）。
4. 关闭 `readContext` 重问 → host 返回 `question-only` 模式，prompt 不含 transcript（harness 断言）。
5. 选中主对话一段文本 → 点选区旁的“旁问” → 选中作为 `c1`，答案引用 c1。
6. 点“插入引用块” → 主框出现 `> ` 引用块；点“复制” → 剪贴板有内容；点“引用到主对话” → 引用块 + 说明。
7. 在输入框非纯文本模式（如插入附件/引用 chip）下点“插入引用块” → 提示失败并可复制兜底。
8. 断开模型（或改错 provider）→ 错误态显示“重试 / 仅用问题回答”，点重试可恢复。
9. 清空线程 / 清空历史 → 主对话消息、滚动位置、草稿均无变化。
10. 刷新页面 → 线程历史仍在（`persistHistory=true`）；关掉 `persistHistory` 后再刷新 → 历史为空且无落盘文件。

---

## 11. 风险与降级

| # | 风险 | 影响 | 概率 | 检测方式 | 降级/缓解 |
|---|---|---|---|---|---|
| R1 | **拿不到“当前会话 id”** | 无法读取上下文 | 中 | 窗口会话标签为空 / `context-source` 日志 | 三级回退（§7.2）+ 手动抓取；仍可用纯问答 |
| R2 | Shadow DOM 内 React 事件/主题异常 | 窗口交互失效或样式破 | 低 | 面板挂载自检（attachShadow 后渲染探针节点） | 自动回退 light DOM + `.sideask-` 前缀（官方插件同款） |
| R3 | `insertQuote` 仅在纯文本模式可用，返回 false | “插入引用块”失败 | 中 | 返回值判断 | 依次回退 `setDraft` → 剪贴板 + 提示；UI 说明原因 |
| R4 | 宿主未挂载 `ctx.llm` / 未注册 provider | 无法回答 | 低 | `bootstrap.unavailable` / `/health` 503 | 窗口显式“模型不可用”+ 去设置里选默认模型的指引；不崩页 |
| R5 | `ctx.webServer` 缺失或 SSE 被缓冲 | 浏览器半连不上/不流式 | 低 | `bootstrap` 失败 / 首字延迟 | 提示重载；退化为“非流式一次性返回”（`POST ask` 的 `Accept: application/json` 分支，P1） |
| R6 | provider 上下文窗口不足 | 请求失败 | 中 | `CONTEXT_WINDOW_EXCEEDED` | 错误带 `degradableToQuestionOnly` → 用户一键“仅用问题回答”；也可自动降一档预算重试（P1） |
| R7 | 敏感信息漏检（自定义格式） | 隐私泄露 | 中 | 用户自定义正则 + 人工审计 | 双层脱敏 + 默认关闭外发前显示“上下文详情”让用户复核；`readContext` 一键关 |
| R8 | 长会话性能（数千条消息） | 提取卡顿 | 中 | 提取耗时埋点 | 只取窗口 + 增量缓存 + 分片/空闲调度 + 1.5s 超时降级 |
| R9 | 线程存储损坏/只读盘 | 历史丢失 | 低 | 读取 sanitize 失败 | 视为空并自愈；内存态继续工作 |
| R10 | dsh 版本升级导致 API 漂移 | 插件失效 | 中 | `dsh.compatibility` 版本范围 + 启动探测 | 每项能力 `feature-detect`，缺能力只降级不抛错；`API_MISMATCH` 提示升级 |
| R11 | 多标签页/多窗口并发写线程 | 覆盖 | 低 | 更新时间戳 | 服务端“先读后写 + 单次请求原子 append”，冲突时后写覆盖（历史可接受） |
| R12 | 快捷键与宿主冲突 / 被宿主服务拒绝 | **激活失败 → web boot 失败 → 应用禁用第三方插件**（真实发生，v0.1.2 及以前） | 已发生 | 真机 CDP 验证 | 已改为**插件自建 keydown 监听**：宿主 `ctx.shortcuts` 对 Web 组合有白名单校验（需 3+ 修饰键或含 primary），`Alt+Shift+A` 会被判非法并**抛错**；现在快捷键与宿主解耦，`apply()` 也做了"永不抛错"兜底 |
| R13 | 引用错配（模型编造 cN） | 误导 | 中 | 未知引用丢弃 + 只回显实际条目 | 已实现丢弃策略；UI 不显示不存在的引用 |
| R14 | 隐私开关被误关 | 数据外传 | 低 | 设置页显式文案 | 关闭“读上下文”时窗口顶部常驻“上下文已关闭”徽标 |

---

## 12. MVP 范围与后续迭代

### 12.1 本版（MVP，P0）交付物清单

| 交付物 | 路径 | 状态 |
|---|---|---|
| 设计文档（12 节） | `docs/design.md` | ✅ |
| 宿主 API 取证（896 行，file:line） | `docs/research/host-api.md` | ✅ |
| 客户端 API 取证（500 行，file:line） | `docs/research/client-api.md` | ✅ |
| 装载与冒烟取证 | `docs/research/patterns.md` | ✅ |
| 共享纯逻辑（预算/去重/脱敏/引用/prompt） | `src/shared/**` | ✅ 52 项单测通过 |
| 宿主半（入口/配置/存储/模型网关/HTTP+SSE） | `src/host/**` → `lib/host/**` | ✅ 编译 + 28 项 host 测试通过 |
| 浏览器半（悬浮窗/Shadow DOM/轻对话/提取/回写） | `src/client/**` → `lib/client.js`（98.9 KiB） | ✅ 编译 + 4 组纯逻辑单测通过 |
| 线框与交互 | `docs/ui-wireframe.md` | ✅ |
| 真机冒烟证据（含内存测量） | `docs/verification.md` | ✅ |
| 内存/泄漏验收 | `scripts/memory-check.mjs`、`test/bounds.memory.test.mjs` | ✅ 200 轮堆稳定 6 MB |
| 安装/配置说明 | `docs/quickstart.md`、`README.md`、`README.zh.md` | ✅ |
| 工程化 | `scripts/build.mjs`、`scripts/check.mjs`、`tsconfig*.json`、`package.json`、`cordis.patch.yml`、CI | ✅ |

**当前验收状态**：`node --test` → **130/130 通过**；`node scripts/check.mjs` → `check ok`；
`node scripts/memory-check.mjs` → `MEMORY CHECK PASSED`；隔离 home 的真实 dsh 实例上
`bootstrap` / `health` / `threads` / `ask(SSE)` / CORS 403 全部按契约响应。
唯一未覆盖项：真实模型**回答内容**（隔离 home 无凭据 → `MISSING_CREDENTIAL`），
以及浏览器 UI 的自动化点击（本机无浏览器驱动，见 `docs/verification.md` §9）。

### 12.2 分期任务拆分（可直接建 issue）

**Sprint 1（MVP 收口，P0）**
1. `[host]` 路由与 SSE 稳定性：背压、断连、超时、取消（`src/host/http.ts`）
2. `[host]` 线程存储边界与损坏自愈测试（`src/host/store.ts`）
3. `[client]` 悬浮窗几何状态机 + 单测（`window-state.ts`）
4. `[client]` 会话探针与三级回退（`context-source.ts`）
5. `[client]` 流式渲染 + 引用 chip + 错误/重试（`thread-view.tsx`）
6. `[client]` 写回四动作 + 失败回退链（`writeback.ts`）
7. `[qa]` 假宿主 harness（10 条断言）+ 真机冒烟（`test/harness`、`docs/verification.md`）
8. `[docs]` quickstart + README + 线框定稿

**Sprint 2（P1）**
9. 会话事件流精确增量（`change.kind`）+ 后台预取
10. 自动摘要层（`buildSummaryPrompt` + 集合哈希缓存）
11. 引用定位/高亮主对话
12. 宿主设置页分区 + 窗口内设置收敛
13. 多线程面板与搜索

**Sprint 3（P2）**
14. 显式“升级为主对话会话”（走宿主 session API）
15. 多模态上下文（选区截图）
16. 线程导出/分享、prompt 模板库
17. 无模型本地模式

### 12.3 明确“不做什么”（边界）

- ❌ 不自动把回答写回主对话（任何情况下都需要用户点击）
- ❌ 不改写/删除主对话消息，不创建 dsh 会话，不注入 agent 工具
- ❌ 不读取隐藏推理（reasoning/COT）、不读取未渲染内容、不读取其它会话
- ❌ 不把上下文/线程同步到任何远端（无外连；`dshhub.permissions.network` 为空）
- ❌ MVP 不做多模态、不做跨设备同步、不做团队共享

---

## 附录 A：与 dsh 版本绑定的注意点

- `manifestVersion: 1`，`dsh.compatibility: ">=0.2.0-rc.1 <0.3.0-0"`（本机 0.2.2-rc.1 实测装载）。
- 浏览器 bundle 的 `id` **必须等于包名** `dsh-sideask`（否则 loader 报 `loaded without registering "…"`，见 `dsh-client-modules/lib/client.js:760`）。
- 客户端 `require` 只有 10 个种子模块（react/react-dom/cordis/zod/react-virtual + 4 个 dsh-* UI 包），其余必须打进 bundle；因此本插件除 React 外零运行时依赖。
- 所有宿主能力都走 `ctx.get(...)` 并在缺失时降级，**不假设挂载顺序**。

## 附录 B：证据索引

| 主题 | 文件 | 关键行 |
|---|---|---|
| 客户端 bundle 形状 | `dsh-message-quotes/lib/client.js` | 1-9, 193-196 |
| 种子 require 表 | `dsh-web-frontend/dist/assets/index-*.js` | 196 |
| 会话只读 feed | `dsh-api-session-controller/lib/client.js` | 3856, 4072, 4145-4150, 1741-1798 |
| 消息文本块 | `dsh-client-ui-chat/lib/client.js` | 11955-11992, 10096, 10412 |
| 选区交互 | `dsh-message-quotes/lib/client.js`、`dsh-client-ui-conversation/README.md` | 170-185, 29-50；README:66 |
| 输入框写入 | `dsh-client-ui-conversation/lib/client.js` | 15186-15197, 15368-15395, 16127-16133 |
| 覆盖层插槽 | `dsh-client-ui-layout/lib/client.js` | 401-405, 74 |
| 快捷键 | `dsh-client-ui-layout/lib/client.js`、`dsh-client-shortcuts/README.md` | 737-771；README:30-34 |
| 模型服务 | `dsh-llm/README.md`、`dsh-llm/lib/index.js`、`dsh-llm/lib/types/assembler.js` | 47-59, 95；2395-2400；chunk 协议 |
| 默认模型 | `dsh-agent-default-model/lib/index.js` | `currentSelection()` |
| 路由注册 | `dsh-spend-wallpaper/lib/http.js` | 144-156 |
| 配置 getter refs | `dsh-spend-wallpaper/lib/index.js` | 232-253 |
| 本地存储先例 | `dsh-spend-wallpaper/lib/store.js` | 11-19, 64-86 |
| 窗口位置记忆先例 | `dsh-client-ui-sidebar-right/lib/client.js` | 886-926 |

## 附录 C：实测结果（摘要）

完整证据见 [`verification.md`](verification.md)。隔离 `DSH_HOME`（不触碰用户 profile）上的真实 dsh 0.2.2-rc.1：

| 项目 | 结果 |
|---|---|
| 安装（`dsh plugin add link:…`） | ✅ 写入 profile `dsh.profile.bundles`，node_modules 为 junction |
| 宿主半加载 | ✅ `GET /plugins/dsh-sideask/api/bootstrap` → 200，`apiVersion=1`，解析出宿主模型路由，`Config` 默认值正确 |
| 浏览器 bundle 进入启动图 | ✅ 首页组合 URL 含 `dsh-sideask/client.js`；组合 URL 200（2.68 MB，`text/javascript`） |
| SSE 流 | ✅ `POST /ask` → 200 `text/event-stream`，帧序 `accepted,settings,error`；错误为 **预期** 的 `MISSING_CREDENTIAL`（隔离 home 无凭据） |
| 线程落盘 | ✅ `GET /threads` 返回自动创建的线程（标题、messageCount=2，失败回答也留痕以供重试） |
| 同源围栏 | ✅ 跨站 Origin → 403 |
| 内存 | ✅ 200 轮 ask：堆稳定 6–7 MB（预热后无增长），RSS 39→43 MB 平台化；线程被 `maxThreads` 裁剪；真实 Electron 实例约 533 MB（Electron 基线量级） |
| 自动化测试 | ✅ 130/130（shared 52 · host 28 · client 44 · bounds 6） |

**本版未验证、但已用契约与降级覆盖的部分**：真实模型回答内容（隔离环境无凭据）、
浏览器 UI 的人工点击路径（本机无浏览器自动化驱动，已提供 10 分钟手工验收脚本）。

