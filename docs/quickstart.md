# 快速开始（本机实测流程）

> 目标：10 分钟内把「旁问」装到本机 dsh 并确认它真的在跑。
> 环境：Windows + dsh 0.2.2-rc.1（`D:\deepseek\resources\`），Node ≥ 20。

## 0. 前置检查

```powershell
# dsh CLI（Electron 以 Node 身份运行）
$env:ELECTRON_RUN_AS_NODE=1
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' --version      # → 0.2.2-rc.1

# 构建工具
node scripts/build.mjs        # host(tsc) + client(esbuild)
node scripts/check.mjs        # 清单/导出自检
node --test test/             # 单测
```

`npm run build` 后应看到：

```
host: lib/host + lib/shared
client: lib/client.js (xxx KiB)
check ok
```

## 1. 本地构建

```powershell
cd E:\workspace\dsh-sideask
node scripts/build.mjs
node scripts/check.mjs
```

## 2. 安装到 profile

> **重要**：CLI 的 `--profile <name>` 会到 `$DSH_HOME/profiles/<name>` 找 profile。自定义名字初始化出来的是「基础 profile」，**不含 web 应用**，所以浏览器端插件不会被服务。要验证 Web UI，请使用名为 `web` 的 profile —— 建议放在**临时的 `DSH_HOME`** 里，避免动到你正在用的 `~/.dsh`（见 §5 冒烟测试）。

正常安装到你自己的工作环境（`~/.dsh`）：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
$dsh = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd'

# 以 link: 方式安装（本地开发：指向源码目录，改代码后重新 build 即可生效）
& $dsh plugin --profile web add link:E:/workspace/dsh-sideask

# 确认行已插入（搜 dsh-sideask）
& $dsh --profile web --dump-config

# 启动（--port 0 = 随机端口，--no-open = 不自动开浏览器）
& $dsh --profile web --port 0 --no-open
```

启动输出形如：

```
dsh web: http://127.0.0.1:<port>/?token=...
```

用浏览器打开该 URL。

## 3. 首次使用

1. **右上角**出现「旁问」悬浮球（若没出现，先看 §4 排障）。
2. 按 `Alt+Shift+A` 或点悬浮球 → 小窗展开。
3. 直接提问，例如：`用一句话解释上面这段代码在做什么`。
4. 打开底部「带上主对话上下文」→ 提问时会显示 `x/y token` 徽标。
5. 回答下方的 `cN` chip 表示引用了主对话的哪条消息。
6. 点「插入引用块」→ 文本进入主对话输入框（`> ` 引用块），你仍需自己按发送。

## 4. 排障

| 现象 | 检查 |
|---|---|
| 悬浮球不出现 | 服务端 stderr 是否有 `dsh: warning: N entry did not activate`；有则看紧跟的 `failed to import: Error: …`（插件加载失败不会中断服务） |
| 悬浮球出现但窗口空白 | 浏览器 devtools console 是否有 `__ModuleLoader__` 报错；`GET /plugins/dsh-sideask/api/bootstrap` 是否 200 |
| 提问报 `NO_ADAPTER` | 宿主没挂 `ctx.llm` 或没注册 provider：到 dsh 设置里选一个默认模型（本机配置项 `agent-default-model`: `deepseek-account / deepseek-flash`） |
| 提问报 `MISSING_CREDENTIAL` | 宿主账号未登录/无 Key：先在 dsh 里完成登录 |
| 回答说「上下文里没有」 | 当前会话没绑定成功（会话探针未生效）：点窗口顶部会话标签确认；或直接用选中文本提问 |
| 「插入引用块」失败提示 | 主对话输入框不在纯文本模式（如已插入附件/引用 chip）：改用「复制」或「作为草稿插入」 |
| 改了配置不生效 | `Config` 字段都是 `.volatile()`，保存即生效；若仍不生效，重启 dsh 再试 |

服务端日志：插件加载失败只在**服务端 stderr**，没有单独的插件日志文件（`.plugin-manager/logs/operation-*/pnpm.log` 只对 GUI 安装有意义）。

## 5. 安全的冒烟测试（不动你的 `~/.dsh`）

```powershell
$env:DSH_HOME = 'E:\workspace\_probe\dshhome-smoke'
$env:ELECTRON_RUN_AS_NODE = 1
$dsh = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd'

# 首次会初始化一个新的 home；profile 名必须是 web 才有 Web 应用
& $dsh plugin --profile web add link:E:/workspace/dsh-sideask
& $dsh --profile web --port 0 --no-open
# → dsh web: http://127.0.0.1:<port>/?token=<token>

# 另一个窗口验证宿主路由（token 需要放在 query 或 cookie，见下）
# 最简单的验证：浏览器打开该 URL 后，devtools 里执行
#   await (await fetch('/plugins/dsh-sideask/api/bootstrap')).json()
# 期望：{ apiVersion: 1, settings: {...}, model: { provider: ..., model: ... }, providers: [...], unavailable: null }

# 停止：按 Ctrl+C，或
# taskkill /T /F /PID <该进程 PID>
```

断言点（冒烟通过标准）：
1. `bootstrap` 返回 200 且 `apiVersion === 1`；
2. 浏览器 bundle 可下载：页面 HTML 里能找到 `plugins/??dsh-sideask/client.js&rev=…` 组合 URL，且该 URL 返回 200、`content-type: text/javascript`、body 含 `__ModuleLoader__.load`；
3. 悬浮球可见、可拖动、可记忆位置；
4. 一次提问能流式返回并带引用。

本机已记录的真实证据见 [`verification.md`](verification.md)。

## 6. 卸载

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile web remove dsh-sideask
```

卸载不会删除历史文件；需要彻底清理时手动删除：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\storages\sideask" -Recurse -Force
# 浏览器端：清除该站点 localStorage（窗口位置/UI 开关）
```

## 7. 开发者循环

```powershell
node scripts/build.mjs --watch     # 只重打包浏览器半（host 半由 loader 重新 require）
node --test test/                  # 单测
node scripts/check.mjs             # 静态自检
```

改 host 半后需要重启 dsh；改 client 半后刷新页面即可（`link:` 安装指向源码目录）。
