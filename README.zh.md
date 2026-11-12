# dsh-sideask · 旁问（Side Ask）

> 在 DeepSeek Harness 的当前对话旁边，开一个**悬浮的轻对话**：只读当前上下文提问，回答带引用，只有你点它才写回主对话——绝不污染主线程。

[English](README.md) ｜ 中文

---

## 它是什么

你在一个很长的对话里，想插一句题外话：「这段代码为什么这么写？」「帮我解释一下刚才那个报错」「这个 API 还有别的用法吗？」

直接问会打断主线、污染上下文；另开窗口又要重新贴一遍背景。

**旁问**挂在主对话旁边：

- 点悬浮球或按 `Alt+Shift+A` 打开一个小窗；
- 它**只读**当前主对话里你能看到的最近消息（+ 你选中的文本）做上下文；
- 在它自己的线程里多轮问答，回答标注引用了主对话的哪几条；
- 想合流时，点「复制 / 插入引用块 / 引用到主对话 / 作为草稿插入」——**只有显式操作才会碰到主对话**；
- 关掉小窗、清空历史，主对话状态一点都不变。

## 为什么不会污染主对话（机制保证，不是承诺）

| 层 | 保证 |
|---|---|
| 宿主半 | 不 import 任何会话/Agent 写接口；模型调用只是一次 `ctx.llm.stream(...)`，不建立 dsh 会话、不写会话日志 |
| 模型输入 | 用 request-only 的 user 输入（无 id/source），不产生 durable message |
| 存储 | 轻对话线程只存在插件自己的 `$DSH_HOME/storages/sideask/threads.json` |
| 浏览器半 | 只读 `eventSource.getSnapshot()` 快照，不 mutate 会话状态 |
| 回写 | 仅四个显式动作，全部经过主对话输入框的公开 API（`insertQuote`/`setDraft`/剪贴板），失败可回退 |

## 功能

- **悬浮窗**：拖拽、四角吸附、最小化/展开、位置与尺寸记忆、快捷键唤起
- **轻对话**：独立线程、多轮、流式回答、停止、清空、历史本地保存、加载态/错误态/重试
- **上下文**：最近 N 条 + 用户选中文本 + 历史摘要位；token 预算分配、去重、敏感信息双层脱敏；增量刷新（投影缓存），不重复全量读取
- **引用**：回答标注引用了 `c1..cN`，点引用看原文摘录
- **隐私**：可一键关闭上下文读取；可清空历史；可关历史落盘；空网络权限（不向任何远端发送数据）

## 安装

前置：dsh ≥ 0.2.0-rc.1（本文档针对本机 0.2.2-rc.1 验证）。

```powershell
# 1) 构建（需要 Node ≥ 20）
node scripts/build.mjs
node scripts/check.mjs

# 2) 装到你的 profile（先用 --dump-config 确认行已插入）
$env:ELECTRON_RUN_AS_NODE=1
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile web add link:E:/workspace/dsh-sideask
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' --profile web --dump-config

# 3) 启动
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' --profile web --port 0 --no-open
```

本机路径细节与实测证据见 [`docs/quickstart.md`](docs/quickstart.md) 与 [`docs/verification.md`](docs/verification.md)。

## 使用

| 动作 | 操作 |
|---|---|
| 打开/收起 | `Alt+Shift+A` 或点右下角悬浮球 |
| 提问 | 输入后 `Enter`（`Shift+Enter` 换行） |
| 带上上下文 | 底部开关「带上主对话上下文」（显示 `1.2k/3k token`） |
| 用选中文本提问 | 在主对话选中文本 → 点选区旁「旁问」 |
| 停止生成 | 流式过程中点「停止」 |
| 查看引用了什么 | 点回答里的 `cN` chip，或点 token 计数看「上下文详情」 |
| 合流回主对话 | 回答下方：复制 / 插入引用块 / 引用到主对话 / 作为草稿插入 |
| 清空 | 头部菜单清空当前线程；设置面板清空全部历史 |

## 配置

宿主设置页（schemastery `Config`，**假设**由插件管理器渲染）或窗口内设置面板：

| 键 | 默认 | 说明 |
|---|---|---|
| `readContext` | `true` | 隐私总开关：关掉后完全不读主对话 |
| `redactSensitive` | `true` | 敏感信息脱敏（浏览器 + 宿主双层） |
| `persistHistory` | `true` | 轻对话历史是否落盘 |
| `recentMessageLimit` | `12` | 最近 N 条 |
| `contextBudgetTokens` | `3000` | 上下文 token 预算上限 |
| `autoSummary` | `true` | 历史摘要层（P1 生效） |
| `answerMaxTokens` | `1200` | 回答长度上限 |
| `defaultCorner` | `bottom-right` | 悬浮窗默认角 |
| `hotkey` | `Alt+Shift+A` | 唤起快捷键 |
| `provider` / `model` | `''` | 留空 = 用宿主默认模型 |
| `customRedactionPatterns` | `[]` | 自定义脱敏正则 |

## 文档

- [设计文档（12 节：方案对比/架构/状态机/预算策略/接口/测试/风险/MVP）](docs/design.md)
- [宿主能力清单与取证](docs/research/host-api.md) · [客户端 API 取证](docs/research/client-api.md) · [装载与冒烟](docs/research/patterns.md)
- [线框与交互](docs/ui-wireframe.md) · [冒烟证据](docs/verification.md)

## 开发

```powershell
node scripts/build.mjs          # tsc(host) + tsc(纯逻辑) + esbuild(client) + bundle 形状校验
node scripts/check.mjs          # 清单/导出/无 import 自检
node --test                     # 130 项单测（预算/脱敏/引用/上下文/host harness/窗口几何/SSE/内存上界）
node scripts/memory-check.mjs   # 200 轮内存增长检查（断言堆不增长、线程被裁剪）
node scripts/build.mjs --watch  # 只重打包浏览器半（配合刷新页面）
```

结构：`src/shared`（双端纯逻辑，可单测）· `src/host`（Node ESM 插件）· `src/client`（浏览器 bundle，Shadow DOM）。

## 资源与内存边界（为什么它不会吃掉内存）

| 结构 | 上限 |
|---|---|
| 上下文 token 预算 | 默认 3000，硬顶 64000（配置钳制） |
| 单条上下文消息 | 预算的 35% |
| 线程 / 单线程消息 | 30 / 200（可配），超出丢最旧 |
| 投影缓存（增量） | 512 条 |
| SSE 缓冲 | 只保留未完成的半帧 |
| 内嵌历史轮数 | 8 |

实测：`node scripts/memory-check.mjs` 跑 200 轮真实 `ask` 后 V8 堆稳定在 6–7 MB（预热后无增长），
RSS 在 43 MB 平台化；隔离 home 里的真实 dsh 实例（Electron）约 533 MB，属 Electron 基线量级。
详见 [`docs/verification.md`](docs/verification.md) §5。

## 权限声明

```jsonc
"dshhub": { "surfaces": ["host", "web"], "permissions": { "network": [] } }
```

- **无网络外连**：唯一网络访问由宿主模型服务代发（复用你的 dsh 账号/模型配置）。
- **本地存储**：`$DSH_HOME/storages/sideask/threads.json` 与浏览器 localStorage（仅窗口几何/UI 开关）。
- **宿主能力**：`webServer.register`（本地同源路由）、`llm.stream`（模型调用）、本地线程存储。

## 许可

MIT
