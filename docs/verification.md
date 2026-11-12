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
