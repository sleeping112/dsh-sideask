# 验证报告（本机实测）

> 环境：Windows · dsh **0.2.2-rc.1** · Node 24.21.0 · 2026-11-13
> 原则：**只在隔离的 `DSH_HOME` 里装载**，全程不触碰用户的 `~/.dsh`（`desktop` / `web` profile）与正在运行的 GUI。
> 每一条结论后面都有实际执行的命令与观察到的输出。

---

## 0. 结论速览

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| V1 | 插件能被 dsh 安装并登记进 profile | ✅ | §2 |
| V2 | 宿主半真实加载（`apply` 跑通，路由生效） | ✅ | §4.1 / `bootstrap` 200 |
| V3 | 浏览器 bundle 被 boot graph 引用并可下载 | ✅ | §4.2（组合 URL 200，含 `__ModuleLoader__.load`） |
| V4 | SSE 流式端到端（真实宿主 + 真实 `ctx.llm` 调用路径） | ✅（模型因隔离环境无凭据而按契约报 `MISSING_CREDENTIAL`） | §4.3 |
| V5 | 线程写入真实宿主存储 | ✅ | §4.4 |
| V6 | 跨站请求被拒 | ✅ 403 | §4.5 |
| V7 | 内存有界（200 轮内存不增长、线程数被裁剪） | ✅ | §5 |
| V8 | 单元测试 / 静态检查 / 类型检查 | ✅ 130 项测试全过 | §6 |
| V9 | 用户真实 profile 未被改动 | ✅ | §7 |

---

## 1. 前置

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' --version      # → 0.2.2-rc.1
node scripts/build.mjs                                          # → types + lib/client.js (98.9 KiB)
node --test                                                     # → 130 pass / 0 fail
node scripts/check.mjs                                          # → check ok
```

`lib/client.js` 的包装形状（构建期校验，见 `scripts/build.mjs`）：

```
window.__ModuleLoader__.load({
  id: "dsh-sideask",
  factory: function (require) { var module = { exports: {} }; var exports = module.exports; … }
});
```

---

## 2. V1 安装（隔离 home）

```powershell
$env:DSH_HOME = 'E:\workspace\_probe\dshhome-sideask-verify'
$env:ELECTRON_RUN_AS_NODE = '1'
$dsh = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd'

& $dsh plugin --profile web add link:E:/workspace/dsh-sideask
```

观察到的结果（`$DSH_HOME/profiles/web/package.json`）：

```jsonc
{
  "dependencies": { "dsh-sideask": "link:E:/workspace/dsh-sideask" },
  "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-sideask"          // ← 本插件登记为 bundle
  ] } }
}
```

`node_modules/dsh-sideask` 是指向 `E:\workspace\dsh-sideask` 的 junction（`link:` 语义，改代码后重新 build 即生效）。

> 注意：`--profile <name>` 会在 `$DSH_HOME/profiles/<name>` 初始化 profile；自定义名字只初始化“基础 profile”，**不含 web 应用**，浏览器端不会被服务。所以冒烟必须用名为 `web` 的 profile（放在隔离 home 里）。

---

## 3. 启动

```powershell
& $dsh --profile web --port 0 --no-open
# 观察到的输出：
# dsh web: http://127.0.0.1:57876/?token=ZXjnEr0dqnhuTUR0p2uI6cTO8QItKxN4VbkgQlrOdOg
```

---

## 4. V2–V6 真实宿主验证

用一次性 `token` 换取会话 cookie 后逐项探测（脚本：`_probe/smoke.mjs` / `_probe/smoke-api.ps1`）。

### 4.1 宿主半加载 —— `bootstrap`

```
GET /plugins/dsh-sideask/api/bootstrap      → 200
{
  apiVersion: 1,
  model: { provider: "deepseek-official", model: "deepseek-flash" },
  providers: ["deepseek-official", "deepseek-account"],
  unavailable: null,
  settings: { readContext: true, contextBudgetTokens: 3000,
              hotkey: "Alt+Shift+A", persistHistory: true, … }
}
```

这说明：`apply(ctx, config)` 真实执行、`ctx.webServer.register` 生效、`Config` 默认值正确、
`ctx.get('agentDefaultModel').currentSelection()` 解析出了宿主默认模型（本机 `agent-default-model` 配的是 `deepseek-account/deepseek-flash`，插件侧解析到的是首个可用 route `deepseek-official`，两者都来自宿主，没有写死）。

```
GET /plugins/dsh-sideask/api/health         → 200 {"ok":true,…}
GET /plugins/dsh-sideask/api/threads        → 200 []
```

### 4.2 浏览器 bundle 被 boot graph 引用并可下载

首页 HTML（`GET /?token=…`，200，40,214 bytes）中的组合（combo）URL 里包含本插件：

```
plugins/??…,dsh-sideask/client.js,…&rev=ea0b28e3a1a7
```

对该组合 URL 取回：

```
status = 200
content-type = text/javascript; charset=utf-8
bytes = 2,679,510          （组合内所有 bundle 的拼接）
包含 __ModuleLoader__.load : True
```

即：宿主正确识别了 `package.json` 的 `exports["./client"]` 与 `dsh.client.platform: "web"`，把我们的 bundle 编进了启动图。

> 单独 URL 形式（`/plugins/dsh-sideask/client.js`、`/plugins/??dsh-sideask/client.js`）返回 **404** —— 与 `docs/research/patterns.md` 记录一致：宿主只服务带正确 `rev` 的组合 URL，这是它的正常行为，不是插件缺陷。

### 4.3 V4 真实 SSE 流

```
POST /plugins/dsh-sideask/api/ask
{"apiVersion":1,"requestId":"smoke-…","threadId":"smoke-thread",
 "question":"用一句话说明上下文里的函数做了什么。","sessionId":"smoke-session",
 "context":{"items":[{"ref":"c1","messageId":"msg-1","role":"user",
   "text":"function backoff(n) { return Math.min(30000, 2 ** n * 500) }", …}], …}}
```

响应：

```
status = 200
content-type = text/event-stream; charset=utf-8
frames: accepted, settings, error
error: { code: "MISSING_CREDENTIAL",
         message: "llm-deepseek: no API key for provider route \"deepseek-official\";
                   store DEEPSEEK_API_KEY through the credentials service…" }
```

**如何解读**：这条链路已经真实打通到宿主模型服务的**凭据检查**这一步——
路由注册 → 请求校验 → 隐私闸门 → `sanitizeBundle` → 组 prompt → `ctx.llm.stream(...)` →
宿主 `dsh-llm` 派发 → provider 适配器报 **稳定 failure code** → 我们把它映射成契约错误帧。

`MISSING_CREDENTIAL` 是**预期**结果：隔离 home 没有 DeepSeek 凭据（我们刻意没有把你的
`~/.dsh/.credentials.yaml` 复制进去）。要看到真实回答，只需在这个隔离 home 里登录/配置 Key，
或直接装到你自己的 profile。

### 4.4 V5 线程真实落盘

`ask` 之后：

```
GET /plugins/dsh-sideask/api/threads
→ [{"id":"smoke-thread",
    "title":"用一句话说明上下文里的函数做了什么。",
    "updatedAt":1794501520931,
    "messageCount":2}]
```

说明：线程自动创建、标题取首条问题、失败的回答也按契约留痕（含 `error` + `replyTo`，供 UI 重试）。

### 4.5 V6 安全

```
GET /plugins/dsh-sideask/api/bootstrap  with  Origin: https://evil.example
→ 403
```

同源围栏按要求生效（`Sec-Fetch-Site: cross-site` 同样 403，见 `test/host.http.test.mjs`）。

---

## 5. V7 内存有界

### 5.1 宿主半：200 轮不增长（`scripts/memory-check.mjs`）

```
$ node scripts/memory-check.mjs
turns completed : 200
rss  (MB)       : 39 -> 42 -> 43 -> 43 -> 43 -> 43
heap (MB)       : 6 -> 6 -> 7 -> 7 -> 7 -> 6
heap growth     : -0.22 MB after warm-up
threads kept    : 3 (cap 3)
MEMORY CHECK PASSED
（耗时约 3 秒）
```

要点：
- 200 次真实 `ask` 之后 V8 堆稳定在 **6–7 MB**（预热后增长 −0.22 MB，即无增长），RSS 在 43 MB 处平台化；
- 5 个线程 id 轮转写入，但线程数被 `maxThreads: 3` 裁剪 —— 存储有界；
- 每轮都走完整链路（路由 → SSE 帧 → prompt → 模型调用 → 引用解析 → 线程追加）；
- 该检查同时暴露并修掉了一个真实的流式延迟问题：原先每帧都无条件等待 `drain`（最多 250 ms/帧），
  现在只在 `res.write()` 返回 `false`（真正的背压）时才等待，200 轮耗时从 4 分钟级降到 3 秒级。

### 5.2 真实 dsh 实例（Electron）

隔离 home + 本插件运行时，该实例共 3 个进程：

```
pid … ws=149.2 MB    (main/host)
pid … ws=234.6 MB    (renderer)
pid … ws=148.8 MB    (gpu/utility)
TOTAL with plugin: 532.6 MB
```

这是 Electron 的基线量级（主进程 + 渲染 + GPU），插件本身贡献的常驻内存是
`lib/client.js` 98.9 KiB 的代码 + 6 MB 级堆内存，**没有出现随时间增长**的现象。

### 5.3 结构性边界（代码位置）

| 结构 | 上限 | 位置 |
|---|---|---|
| 上下文 token 预算 | 默认 3000，硬顶 64000 | `src/host/config.ts`（钳制）+ `src/shared/context.ts` |
| 单条上下文消息 | 预算的 35% | `src/shared/context.ts` `MAX_ITEM_RATIO` |
| 线程数 / 单线程消息数 | 30 / 200（可配） | `src/host/store.ts` `enforceLimits` |
| 投影缓存条目 | 512 | `src/shared/context.ts` `ProjectionCache` |
| SSE 缓冲 | 只保留未完成的半帧 | `src/client/stream.ts` `SseDecoder` |
| 内嵌历史轮数 | 8 | `src/host/config.ts` `historyTurns` |

对应测试：`test/bounds.memory.test.mjs`（6 项，含 2 万条消息的转录仍不破预算、5000 条 SSE 帧后缓冲区为空）。

---

## 6. V8 测试与静态检查

```
$ node --test
tests 130 / pass 130 / fail 0

$ node scripts/check.mjs
check ok
```

测试分布：

| 文件 | 覆盖 |
|---|---|
| `test/shared.tokens.test.mjs` | CJK/拉丁 token 估算、截断不超预算 |
| `test/shared.redact.test.mjs` | Key/JWT/邮箱/手机/私钥/路径/自定义/幂等 |
| `test/shared.context.test.mjs` | 预算硬上限、选中优先、最近优先于摘要、去重、增量缓存、编号 |
| `test/shared.citations.test.mjs` | 引用块解析（含全角）、未知引用丢弃、prompt 分节 |
| `test/host.http.test.mjs` | bootstrap、SSE 流、错误码、隐私闸门、403、线程 CRUD、不落盘、预算（28 项） |
| `test/client.window-state.test.mjs` | 四角坐标、拖拽越界、吸附、缩放钳制、序列化/恢复/损坏回退 |
| `test/client.stream.test.mjs` | SSE 跨块分帧、多帧同块、坏帧跳过、状态归约、终态粘滞 |
| `test/client.transcript.test.mjs` | 事件→消息映射、隐藏推理丢弃、增量水位、脏输入容错 |
| `test/client.markdown.test.mjs` | 粗体/行内码/引用标记/代码块/列表/HTML 文本不被当标签 |
| `test/bounds.memory.test.mjs` | 缓存/线程/SSE 缓冲上界、超大转录预算 |

---

## 7. V9 用户环境未被改动

```powershell
# 安装前与清理后两次核对
~/.dsh/profiles/web/node_modules/dsh-sideask      → absent
~/.dsh/profiles/desktop/node_modules/dsh-sideask  → absent
~/.dsh/profiles/*/cordis.patch.yml 中 sideask 引用 → 0
~/.dsh/storages/ 下 sideask 存储                  → 不存在
```

冒烟结束后：

```powershell
taskkill /T /F /PID <throwaway main pid>
# 端口 57876 → 连接被拒绝（已关闭）
```

正在运行的 GUI（`http://127.0.0.1:<当前端口>`）全程未触碰。

---

## 8. 复现步骤（照抄即可）

```powershell
# 0) 构建
cd E:\workspace\dsh-sideask
node scripts/build.mjs; node scripts/check.mjs; node --test

# 1) 隔离 home
$env:DSH_HOME = 'E:\workspace\_probe\dshhome-repro'
$env:ELECTRON_RUN_AS_NODE = '1'
$dsh = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd'

# 2) 安装 + 启动
& $dsh plugin --profile web add link:E:/workspace/dsh-sideask
& $dsh --profile web --port 0 --no-open
#   → dsh web: http://127.0.0.1:<port>/?token=<token>

# 3) 验证（另一个终端；脚本会自动用 token 换 cookie）
node _probe\smoke.mjs <token> http://127.0.0.1:<port>
#   期望：BOOTSTRAP 200 / HEALTH 200 / CORS 403 / ASK 200（无凭据时为 MISSING_CREDENTIAL 帧）

# 4) 内存
node scripts/memory-check.mjs

# 5) 停止
taskkill /T /F /PID <该实例主进程 pid>
```

> 提示：隔离 home 里若想验证“真实回答”，在 `dsh` 里完成登录/Key 配置后再跑 `smoke.mjs`。

---

## 9. 已知限制（诚实记录）

1. **真实模型回答未在隔离 home 内跑通** —— 仅 `MISSING_CREDENTIAL`，原因是隔离环境没有凭据（设计使然）。链路本身已被证明走到 provider 凭据检查，且错误映射正确。
2. **浏览器 UI 的端到端点击未自动化** —— 本机没有可用的浏览器自动化驱动；窗口几何/流解析/映射/渲染均有单测，真实渲染需人工按 `docs/quickstart.md` 的 10 分钟验收脚本走一遍。
3. **单包 client URL 404** —— 宿主只服务带 `rev` 的组合 URL；这是宿主行为，验证时以组合 URL 为准。
4. **`dshhub.permissions.host` 已移除** —— 宿主 SDK 不读该字段，声明它会造成“有权限系统”的错觉；只保留 `permissions.network: []`（元数据）。

---

## 10. 真实 profile 安装记录（2026-11-13）

目标：把插件装进用户实际使用的 profile（`C:\Users\32602\.dsh\profiles\desktop`，由 Electron 应用独占管理）。

### 10.1 安装前备份

```
E:\workspace\_probe\profile-desktop-backup-20261113-232048\
  package.json  cordis.patch.yml  cordis.yml  pnpm-lock.yaml  pnpm-workspace.yaml
```

回滚 = 用这几个文件覆盖回 `~/.dsh/profiles/desktop/`，再 `dsh plugin --profile desktop remove dsh-sideask`。

### 10.2 安装命令与结果

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add link:E:/workspace/dsh-sideask
# → dependencies: + dsh-sideask 0.1.0 <- E:\workspace\dsh-sideask
# → Done in 831ms
```

验证（安装后立刻检查，未重启应用）：

| 检查 | 结果 |
|---|---|
| `profiles/desktop/package.json` 的 `dsh.profile.bundles` | ✅ 末尾新增 `dsh-sideask`（其余 6 个 bundle 保持原序） |
| `profiles/desktop/node_modules/dsh-sideask` | ✅ junction → `E:\workspace\dsh-sideask` |
| 用户自定义 `cordis.patch.yml` | ✅ 未被修改（sideask 引用数 0，插件行由包内 bundle patch 提供） |
| `--dump-config` | ⚠️ CLI 拒绝：`profile "desktop" is managed exclusively by the Electron application`（预期行为，不影响已完成的安装） |

### 10.3 生效方式与后续验证

`desktop` profile 由 Electron 应用独占加载，**需要重启 DeepSeek Harness 应用**（或由插件管理器触发 profile 重载）后：
1. 启动时不再出现 `dsh: warning: N entry did not activate`；
2. 主窗口右下角出现「旁问」悬浮球；`Alt+Shift+A` 可唤起；
3. DevTools 里 `await (await fetch('/plugins/dsh-sideask/api/bootstrap')).json()` 应返回 `apiVersion: 1`。

因为是 `link:` 安装，后续改代码只需 `node scripts/build.mjs` 再重载/重启应用，无需重装。

---

## 11. 事故报告：真实 profile 首次启用导致 web boot 失败（2026-11-13）

### 11.1 现象

在 `desktop` profile 启用本插件后，用户重启应用失败；应用提示“禁用第三方插件”，并把
`profiles/desktop/package.json` 的 `dsh.profile.bundles` 自动裁剪为只剩
`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`（用户原有的 cost-meter /
spend-wallpaper / agent-team-profile / plugin-market-bundle 一并被禁用）。

### 11.2 根因（应用日志原文）

`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-11-13T15-24-27-735Z-web-boot.log`：

```
Error: web boot: 1 entry did not activate
dsh-sideask: import failed: client-modules: duplicate factory registration for
  "dsh-sideask" (bundle executed twice without invalidate?)
```

宿主加载器源码（`@deepseek-ai/dsh-client-modules/lib/client.js:700-712`）：

```js
register(registration) {
  const id = …;
  if (this.bootstrapIds.has(id) || this.factories.has(id)) {
    throw new Error(`client-modules: duplicate factory registration for "${registrationName}" …`);
  }
  this.factories.set(id, { factory: registration.factory, … });
}
```

本插件当时的 bundle 里存在**两次注册**：
1. `scripts/build.mjs` 的包装层：`window.__ModuleLoader__.load({ id, factory })`（正确，必须有一次）；
2. `src/client/index.ts` 顶层又调用了 `window.__ModuleLoader__.load(definition)`——而该文件被 esbuild
   打进 factory 函数体，于是**工厂执行时又注册一次** → 加载器抛错 → 该 client entry 未激活 →
   应用判定启动失败并进入“禁用第三方插件”的安全路径。

为什么之前没发现：隔离 home 的冒烟只验证了 `bootstrap` API 与 bundle “能下载”，**从未在浏览器里真正执行**
bundle 并 materialize factory；而 `scripts/check.mjs` 当时只检查“包含 `__ModuleLoader__.load`”，
这种 grep 天然抓不到“注册两次”。

### 11.3 修复（v0.1.1）

- 注册只保留构建包装层；`src/client/index.ts` 删除了全部 `__ModuleLoader__` 引用；
- 工厂返回值改为**插件对象** `module.exports.createPlugin()`（与加载器
  `exports: registered.factory(require)` 的语义一致）；
- `scripts/check.mjs` 新增硬断言：bundle 内 `__ModuleLoader__.load(` 出现次数必须**恰好 1 次**，
  且工厂必须 `return module.exports.createPlugin()`；
- 新增回归测试 `test/client.bundle.test.mjs`：用 `node:vm` 在假 Module Loader 下**真正执行**
  `lib/client.js`，断言 ①只注册一次 ②materialize 后不再注册 ③返回的插件含 `name/inject/apply`
  ④`require` 只出现种子模块 ⑤空 ctx 下 `apply()` 不抛。

### 11.4 回滚（已执行）

1. `profiles/desktop/package.json`、`pnpm-lock.yaml` 用安装前备份覆盖 → `dsh.profile.bundles`
   恢复为 6 项、依赖恢复为 2 项；
2. 删除 `node_modules/dsh-sideask` junction（目标源码目录保留）；
3. 确认无 `dsh-sideask` 残留于 `.pnpm` / node_modules；无持久化的“安全模式”标记文件
   （禁用状态就是被改写的 bundles 列表本身，已还原）；
4. 用户重启后应恢复原状（含 cost-meter / spend-wallpaper 等）。

### 11.5 安全启用清单（以后每次启用 client 插件前）

1. `node scripts/build.mjs` → `node scripts/check.mjs`（含“恰好一次注册”断言）；
2. `node --test`（含 `client.bundle.test.mjs` 真实执行 bundle）；
3. 在**隔离 `DSH_HOME`** 里先启用并启动 `dsh web`，确认启动无 `did not activate` 警告；
4. 浏览器打开该实例页面，确认控制台无 `duplicate factory registration`；
5. 以上全过，再在真实 profile 启用；保留备份，失败按 §11.4 回滚。

> 教训：对 client 插件而言，“bundle 能被下载”不等于“能被执行”。契约必须用**执行**来测，而不是 grep。

---

## 12. 事故二：宿主编译期校验拒绝快捷键，导致 web boot 再次失败（2026-11-14）

### 12.1 现象

启用 v0.1.2 后重启，应用再次进入“禁用第三方插件”的安全路径。日志：

```
Error: web boot: 1 entry did not activate
dsh-sideask: failed
```

（与 §11 不同：这次没有 `duplicate factory registration` 细节，只有 `failed`。）

### 12.2 定位方法（本次新增的能力）

`dsh web` 启动日志与桌面日志都不含原因，于是用**隔离实例 + headless Edge + CDP** 抓浏览器控制台：

```
node _probe/cdp-check2.mjs http://127.0.0.1:<port>/?token=<token> <cdpPort>
```

抓到真正的原因：

```
[dsh-sideask] apply threw: Error: Unsupported Web shortcut: side-ask.toggle
```

### 12.3 根因

宿主快捷键服务对 Web 组合有白名单（`dsh-client-shortcuts/lib/client.js:109-1220`）：

- 允许：修饰键数量 ≥ 3；或含 `primary`（Windows=Ctrl / macOS=⌘）且另有 alt/shift；或少量固定组合；
- 其它一律 `throw new Error('Unsupported Web shortcut: <id>')`。

本插件注册的 `Alt+Shift+A`（2 个修饰键、无 primary）**不合法 → 抛错**；抛错发生在 `apply()` 内
→ 该 client entry 激活失败 → web boot 失败 → 应用判定第三方插件故障并禁用整个列表。

### 12.4 修复（v0.1.3）

1. **快捷键自有化**：新增 `src/client/hotkey.ts`（解析/匹配/格式化，纯函数 + 单测），
   用 `window.keydown` 监听实现 `Alt+Shift+A`；不再依赖 `ctx.shortcuts`，也不再出现在 `inject` 里；
2. **`apply()` 永不抛错**：所有可选注册走 `safe(label, run)` 包装（失败只 `console.warn` 并降级），
   最外层再兜一层 `try/catch`，保证任何服务异常都不会让 web boot 失败；
3. **list 插槽 id**：会话探针注册改用 `id`（宿主报 `list slot "…" requires options.id`），消除了 2 条降级告警。

### 12.5 真机验证（隔离实例 + 真实浏览器）

```
PILL PROBE { host: true, shadow: true, pill: true, pillText: '旁问',
             pillRect: { left: 422, top: 18, right: 482, bottom: 53 },
             viewport: { width: 500, height: 320 },
             debugHandle: true, bootFailed: false }
HOTKEY PROBE { window: true, rect: { left: 132, top: 24, width: 350, height: 320 } }
sideask console lines: 0
boot errors: 0
uncaught exceptions: 0
```

即：插件激活成功、悬浮球渲染在 shadow root 内且位于**右上角**（距右边 18px、距顶 18px）、
`Alt+Shift+A` 能打开小窗、没有任何 boot 错误与未捕获异常。

### 12.6 复现命令

```powershell
# 隔离实例
$env:DSH_HOME='E:\workspace\_probe\dshhome-sideask-verify'; $env:ELECTRON_RUN_AS_NODE='1'
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' --profile web --port 0 --no-open
# 记下 http://127.0.0.1:<port>/?token=<token>

# 无头浏览器 + CDP（另开一个终端）
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless=new --disable-gpu `
    --user-data-dir=E:\workspace\_probe\edge-cdp --remote-debugging-port=9334 "<上面的URL>"
node _probe\cdp-check2.mjs "<上面的URL>" 9334
```

---

## 13. 第三次审计（2026-11-18）：交互 bug 与修复

方法：隔离实例 + 无头 Edge + CDP，**真实鼠标事件 / 真实键盘输入 / 截图**（不再只做 DOM 断言）。

### 13.1 发现（按严重度）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 1 | **严重** | 悬浮窗被主对话输入区盖住 → 输入框点不到、无法打字 | `document.elementFromPoint(textarea中心)` 返回主对话的 `BUTTON`；`shadowRoot.activeElement` 为 null；真实鼠标点击后 `Input.insertText` 无法输入；截图显示窗口下半部分在聊天输入区下方 |
| 2 | 中 | 错误码被后一次通用错误覆盖：`MISSING_CREDENTIAL` 被 `PROVIDER_ERROR` 替换 | 回退链失败后 `store.answer.error.code === 'PROVIDER_ERROR'`，而第一次失败是凭据错误 |
| 3 | 中 | 切换会话不释放 `sessions.retain()` 的引用（会话保留泄漏） | `context-source.bind()` 丢弃了 reference |
| 4 | 低 | 首次提问前"上下文详情"显示"未绑定主对话"（误导） | 面板 `extractionReason === null` 时走了默认文案 |
| 5 | 低 | `bootstrap` 首次失败后不再重试（启动瞬间宿主未就绪） | `store.init()` 的 `initialised` 一次性置位 |

### 13.2 修复（v0.1.7）

1. **挂载方式改为 body 级**：插槽只作空 mounter；`document.body` 下建容器，
   `z-index: 2147483000`，Shadow Root 与 CSS 注入不变。代价：窗口也会盖住模态框（已记录）。
2. **错误选择策略**：`pickFailure()` 优先 `MISSING_CREDENTIAL/AUTH/NO_ADAPTER/QUOTA`，
   并附"（已尝试 N 条模型路由）"。
3. **会话引用所有化**：`bind()` 保存 reference，切换/销毁时 `release()`；`adopt()` 的绑定不释放（归探针作用域）。
4. **上下文详情文案**：`extractionReason === null` → "尚未读取（发送第一个问题后显示统计）"。
5. **bootstrap 可重试**：仅在已有成功 bootstrap 时才跳过；另有 `initialising` 防并发。

### 13.3 修复后真机验证

```
stacking/hit   {"docHit":"DIV[sideask-host]","shadowHit":"sa-input","isOurHostOnTop":true}
after real click  {"active":"TEXTAREA"}
after insertText  {"value":"真实鼠标与键盘路径测试"}
after Enter       {"lastQuestion":"…","status":"error","messages":2}
settled           {"error":"MISSING_CREDENTIAL","errorText":"MISSING_CREDENTIAL…（已尝试 2 条模型路由）…"}
exceptions: 0
```

截图 `sideask-fixed2.png`：窗口完整浮在聊天之上，输入框、发送按钮、错误卡均可交互。

### 13.4 仍未修复（已知缺口，非崩溃）

1. 没有线程管理 UI（新建/切换/删除当前线程）；目前只有"清空全部历史"；
2. 错误信息重复展示：助手气泡内一次 + 错误卡一次；
3. 长回答流式时每个 token 重新解析 Markdown（可加节流/长度分桶）；
4. 引用 chip 只显示摘录，不能定位主对话原文（P1）；
5. 悬浮球是 `div`（非 button），键盘可达性不足；
6. "作为草稿"会覆盖现有草稿（提示里已说明，但仍具破坏性）；
7. 会话兜底取 `sessions.list().ids[0]`，多会话时可能绑错。

---

## 14. 第四次审计（2026-11-18）：线程 UI、错误去重、流式解析

按 `13.4` 的优先级修复前三项，并用真实浏览器逐项验证。

### 14.1 线程管理 UI（新增）

真机（无头 Edge + CDP，隔离实例）操作序列与观察结果：

```
menu open      {"present":true,"count":3,"items":[…3 个线程标题…],"state":{"threads":3,"current":null}}
after new      {"threads":4,"current":"sa_mwmb18c4_pknz8qtv","menuOpen":false}
after switch   {"current":"sa_mwmatk1q_fkfm5eda","messages":2}
after delete   {"threads":3,"current":null}
exceptions: 0
```

即：列出、新建（3→4 且切换到新线程）、切换（加载到该线程的 2 条消息）、删除（4→3）全部正常。
截图：`sideask-thread-menu.png`。

### 14.2 错误去重

修复前同一失败在窗口内出现 2 次以上（气泡内 + 错误卡）。修复后：

```
error surface {"occurrences":1,"errorCards":1,"bubbles":2,"bubbleHasErrorCode":false}
```

即：`MISSING_CREDENTIAL` 只出现 1 次（错误卡），气泡不再重复；用户气泡与助手气泡仍在（2 个）。

### 14.3 流式 Markdown 节流

改为按"桶"记忆化：流式期间每 80 字符才重新解析一次，流结束再解析一次权威文本。
新增单测：桶内稳定、跨桶变化、结束后必变（`test/client.markdown.test.mjs`）。测试总数 155。

### 14.4 仍未修复

`13.4` 第 4–7 项（引用定位、悬浮球 a11y、草稿覆盖、会话兜底），以及更长远的 P1/P2 需求。

---

## 15. 迭代 1（2026-11-22）：划词入口、引用跳转、按线程草稿、a11y

对标结论见对话记录：Trae 的侧边对话有"从选区/回复直接进入"、按会话独立草稿、
`#` 上下文引用等交互；本迭代先补"能不能顺手用起来"的四项。

### 15.1 关键发现：不能复用宿主划词插槽

`conversation.chat.text-interaction` 是 **keyed 插槽**，聊天壳只渲染
`textInteraction.active.id` 对应的那一个 key（`ui-chat/lib/client.js:3683-3688`），
而 active 由"第一个 `request.open()` 的交互"决定；官方引用插件先注册并总是 open。
因此我们在该插槽里注册自己的按钮不会显示（也解释了为什么之前"捕获了选区但用户看不到入口"）。
结论：改为**自建划词浮钮**（DOM selection 监听 + body 级按钮），不抢占官方菜单。

### 15.2 真机验证（隔离实例 + headless Edge + CDP）

```
1 pill                       {"tag":"BUTTON","focused":true,"aria":"打开旁问（悬浮轻对话）"}
2 select                     {"text":"这是用于验证划词入口的一"}
2b affordance                {"present":true,"label":"旁问","left":157,"top":159}
2c after click               {"open":true,"selection":"这是用于验证划词入口的一","window":true}
3 draft A                    {"value":"线程A草稿","drafts":{"__new__":"线程A草稿"}}
3b new thread                {"thread":"sa_mwrua0od…","value":""}
draft restored               {"thread":"sa_mwmb1bsc…","expected":"sa_mwmb1bsc…","value":"这是线程A的草稿"}
4 jump                       {"first":"excerpt","highlighted":true,"second":"not-found"}
errors: 0 | exceptions: 0
```

即：悬浮球是真实 button 且可聚焦；划词后浮钮出现在选区旁、点击开窗并带上选中文本；
草稿按线程保存并在切回时恢复；`reveal` 的摘录回退与高亮、未找到分支都符合预期。
截图：`sideask-selection.png`。

### 15.3 仍待处理（迭代 2）

1. 重新生成所有回答（含成功回答）；
2. 发送前可编辑上下文（剔除某条）；
3. `#` 引用面板（钉住消息/选中/摘要）；
4. 窗口内模型选择（复用 `routeHint` 通道）；
5. Fork 会话副本、摘要层落地、一键"交给主对话执行"。

### 15.4 已知取舍

划词时官方引用菜单与我们的浮钮可能同时出现（我们无法进入它的 keyed 插槽）。
若后续宿主提供"多 opener"或可组合的划词插槽，可合二为一。

---

## 16. 迭代 2（2026-11-22）：重新生成、# 钉住、上下文编辑、模型选择

### 16.1 真机验证（隔离实例 + headless Edge + CDP）

```
1 after send            {"status":"error","messages":2,"error":"MISSING_CREDENTIAL"}
2 regenerate button     {"hasRegenerate":true,"chips":["重新生成","＃ 钉住","模型：跟随主对话"]}
before regenerate       {"ids":["m_mwrusaw3…","m_mwrusaw7…"]}
2b after regenerate     {"status":"error","messages":2,"ids":["m_mwrusfy9…","m_mwrusfyc…"],"threadBusy":false}
context items           {"rows":["c1钉住钉住的主对话消息：这次发布需要注意兼容性"],"checkboxes":1,"checked":true}
after exclude           {"excluded":["main-pin-2"],"checked":false,"restoreBtn":true}
after restore           {"excluded":[]}
models route            {"status":200,"providers":[{"provider":"deepseek-official","models":[]},{"provider":"deepseek-account","models":[]}]}
model panel             {"items":["跟随主对话（默认）…"],"empty":"宿主的模型适配器没有公开模型清单（可继续跟随主对话）"}
default route           error mentions "deepseek-official"
override route          error mentions "deepseek-account"（证明 routeHint 生效）
exceptions: 0
```

### 16.2 修复的边界

- 未绑定会话时钉住上下文会被 `build()` 早退吞掉 → 现在无会话也会带上钉住项（reason `no-session`）；
- 失败回答文本为空时动作区不渲染 → 现在只要可重新生成就渲染动作区，写回按钮仍对空文本隐藏。

### 16.3 仍未做（迭代 3 候选）

Fork 会话副本、历史摘要层落地、一键"交给主对话执行"、跨会话 `#Past Chats`、
模板/快捷指令、导出 Markdown、token/费用面板、图片与语音输入。

---

## 17. 迭代 3（2026-11-22）：摘要层、分叉、交给主对话

### 17.1 真机验证（隔离实例 + 预置线程 + headless Edge + CDP）

预置线程（用户问题 + 带引用的回答）绕过"需要真实模型"的限制：

```
thread list      […,"种子线程：分叉与交接验证",…]
seeded thread    {"title":"种子线程：分叉与交接验证","messages":2,"text":"发布流程分三步…"}
answer actions   {"regenerate":true,"fork":true,"handoff":true,"citationChip":true}
citation jump    {"highlighted":true}            ← 注入同文段落被摘录匹配并高亮
before fork      {"id":"sa_seed_fork","threads":9}
after fork       {"id":"sa_mwrwsw1d…","title":"种子线程：分叉与交接验证 · 分叉","messages":2,"threads":10,"toast":"已从这条回答分叉出新线程"}
handoff          {"toast":"已写入主对话输入框，确认后发送即可"}
handoff landed   true   ← 主对话（app-shell shadow root 内的 contenteditable）
                         值为 "请执行以下旁问结论：发布流程分三步…"
dialogs accepted 1
errors: 0 | exceptions: 0
```

路由级探测（同一实例）：

```
empty summarize            {"status":200,"summary":"","truncated":false}   ← 空输入不调模型
non-empty summarize        {"status":502,"code":"MISSING_CREDENTIAL"}     ← 无凭据时结构化错误
fork bad id                {"status":404}
```

### 17.2 摘要层实现要点

- 触发点：每轮 `accepted` 后 `contextSource.refreshSummary()`（后台，12s 超时）；
- 缓存键：窗口外消息 id 集合（FNV），LRU 8 条；集合变化自动失效；
- 注入：`ContextBuildInput.overflowSummary`（含 `coversMessageIds`），沿用 25% 摘要预算；
- 诚实降级：未就绪时 `summary-pending`，面板明确说明"本轮先用最近消息"；
- 失败静默：宿主 502/超时/空结果都不影响提问（单测覆盖空输入与无 llm 分支）。

### 17.3 仍未做（下一轮候选）

跨会话 `#Past Chats`、模板/快捷指令、导出 Markdown、token/费用面板、
图片与语音输入；摘要层的端到端效果需要一次真实长对话才能量化。

---

## 18. 迭代 4（2026-11-22）：摘要持久化、模板、跨会话只读引用

### 18.1 真机验证（隔离实例 + headless Edge + CDP）

```
templates panel  {"present":true,"labels":["解释这段","找风险","列测试","说清楚点","总结要点","下一步","矛盾检查"]}
template applied {"value":"请找出这段内容的风险、边界条件和可能被忽略的失败情形。"}   ← 写入草稿、不发送
slash shortcut   {"panelOpen":true,"focused":"sa-input"}                                ← 空草稿输入 / 打开模板
past chats       {"present":true,"sessions":["default-workspace"]}                      ← 只读列出其它会话
past messages    {"rows":[],"empty":"这个会话里没有可读取的消息。"}                      ← 空会话如实提示
unknown past     {"result":null}                                                        ← 未知会话返回 null，不抛错
persist write    {"ok":true,"stored":true,"rawLength":48}                               ← 写入 localStorage
after reload     {"loaded":true,"entry":"这是持久化摘要测试内容，长度足够超过最小值。"}   ← 刷新后恢复
panel exclusivity templates:true,pins:false → 点钉住后 templates:false,pins:true        ← 单面板互斥
errors: 0 | exceptions: 0
```

### 18.2 实现要点

- 摘要持久化：`summary-store.ts` 纯函数（加载/保存/单条写入，带 3×8×4000 上限），
  `ContextSource` 在 bind/adopt 时按会话水合，写入后立即落盘；
- 模板：`templates.ts` 纯数据 + `applyTemplate`（空草稿替换、非空追加），
  面板只写草稿，`/` 仅在草稿为空时拦截；
- 跨会话：`ContextSource.otherSessions()` 读会话列表、`readSessionMessages()`
  retain→读→release（2.5s 上限），复用现有 pin 通道进入提示词；
- 面板互斥：`window-shell` 用单个 `panel` 状态替代 5 个布尔值。

### 18.3 仍未做

导出 Markdown、token/费用面板、图片/语音输入；跨会话条目目前只能"钉住"，
还不能像 #Past Chats 那样按关键词搜索历史。

---

## 19. v0.6.0（2026-11-22）：移除钉住 + 悬浮球可拖动

### 19.1 需求

1. 删除「钉住」功能；
2. 悬浮球（关闭态入口按钮）改为可拖动。

### 19.2 真机验证（隔离实例 + headless Edge + CDP，真实鼠标事件）

```
pill docked        {"x":800,"y":110,"w":82,"h":32}
window closed      {"closed":true}
pill dragged       {"x":379,"y":304,"w":82,"h":32}     ← 拖动后左上角
drag result        {"cx":true,"cy":true,"windowStillClosed":true,
                    "stored":{"schema":3,…,"pillFree":{"x":379,"y":304}}}
after reload       {"x":379,"y":304,"w":82,"h":32}     ← 刷新后位置保留
persisted position {"same":true}
click opens        {"open":true}                       ← 拖动后再单击仍能打开
pins removed       {"pinWords":0,"pinButton":false,"pinsPanel":false}
details rows       {"rows":["读取状态…","模型…","投影缓存命中 / 未命中0 / 0"],"pinnedRow":false}
errors: 0 | exceptions: 0
```

判定说明：拖动保留"抓取点"的相对位置，所以断言的是**中心点**落到 (420,320)，
而不是左上角；数字与预期一致。

### 19.3 实现要点

- 拖动：`pointerdown/move/up` + `setPointerCapture`，4px 阈值区分点击与拖动，
  拖动后吞掉一次 click（避免弹窗）；位置用 `movePill()` 夹紧到视口内；
- 持久化：`WindowState.pillFree`，`schema` 升到 3，`serialize/restore` 兼容
  `schema:2`（旧数据 → 停靠状态）；右键 `resetPill()` 复位到角落；
- 删除钉住：contract（`pinned` source / `pinnedTokens`）、context（`pins` 输入、
  35% 预算、`pins-trimmed`）、prompt（`用户钉住`）、store、context-source、
  UI（面板/按钮/chip/跨会话只读）与测试全部清理；上下文只剩
  选中 > 最近窗口 > 摘要 三个来源；
- 悬浮球尺寸在渲染后实测（`useLayoutEffect` + `getBoundingClientRect`），
  夹紧逻辑使用真实尺寸而不是猜测值。

### 19.4 仍未做（历史候选）

导出 Markdown、token/费用面板、图片/语音输入、跨会话关键词搜索。
（跨会话只读随钉住面板一起移除了；如果以后需要，应以"引用"而不是"钉住"
的形式重新设计。）



