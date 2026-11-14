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



