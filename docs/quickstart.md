# 快速开始与排障

> 目标：10 分钟内把「旁问」装到 dsh，并确认它真的在跑。
> 环境：DeepSeek Harness `0.2.0-rc.1 … 0.3.0-0`（在 `0.2.2-rc.1` 上验证）。
> 从源码构建需要 Node ≥ 20；安装预构建 release 不需要 Node。

## 0. 安装

### 从 GitHub 安装（推荐）

```sh
dsh plugin --profile web add github:sleeping112/dsh-sideask
```

- 把 `web` 换成你实际使用的 profile（桌面版通常是 `desktop`，Web 版是 `web`）；
- 仓库声明了 `dsh.bundle` 清单，安装时 `prepare` 会构建宿主与浏览器两半；
- 安装完重启 dsh。

### 预构建 tarball（可选）

Release 附件：`https://github.com/sleeping112/dsh-sideask/releases/latest/download/dsh-sideask.tgz`。
插件市场会自动优先使用它；手动安装时按你的 dsh 版本支持的方式从本地文件安装。

### 从源码安装（开发）

```sh
git clone https://github.com/sleeping112/dsh-sideask.git
cd dsh-sideask
pnpm install                 # prepare 会自动构建一次
pnpm run build               # 可显式再构建
dsh plugin --profile web add link:$PWD
```

Windows 下最后一条用 `link:E:/path/to/dsh-sideask`。

## 1. 首次使用

1. 右上角出现「旁问」悬浮球（可拖动；右键复位到停靠角；`Alt+Shift+A` 唤起窗口）。
2. 点悬浮球或按快捷键 → 小窗展开。
3. 直接提问，例如：`用一句话解释上面这段代码在做什么`。
4. 底部「带上上下文」默认开启；提问时显示 `已用/预算 token`。
5. 在主对话里选中文字 → 选区旁出现「旁问」按钮 → 点击即可用选中内容提问。
6. 回答里的 `cN` chip 表示引用了主对话的哪条消息；点击会滚到并高亮原文。
7. 回答下方可「复制 / 插入引用块 / 引用到主对话 / 作为草稿插入 / 交给主对话」；
   都不会自动发送，主对话保持你的控制权。
8. 「线」管理线程，「详」查看/排除上下文，「模型」选择模型，「模板」插入快捷问法。

## 2. 排障

| 现象 | 检查 |
|---|---|
| 悬浮球不出现 | 服务端 stderr 是否有 `dsh: warning: N entry did not activate`，紧跟的 `failed to import: Error: …` 说明插件加载失败（不会中断服务）；确认 profile 里是 `web` 而不是基础 profile |
| 悬浮球出现但窗口空白 | 浏览器 devtools console 是否有 `__ModuleLoader__` 报错；`GET /plugins/dsh-sideask/api/bootstrap` 是否 200 |
| 提问报 `NO_ADAPTER` | 宿主没有可用模型：在 dsh 设置里选一个默认模型，或在插件配置里指定 `provider`/`model` |
| 提问报 `MISSING_CREDENTIAL` | 宿主账号未登录/无 Key：先在 dsh 里完成登录，或换一个有凭据的模型 |
| 回答说「上下文里没有」 | 当前会话没绑定成功：点窗口顶部会话标签确认；或用选中文本直接提问 |
| 「插入引用块」失败 | 主对话输入框不在纯文本模式（已有附件/引用 chip）：改用「复制」或「作为草稿插入」 |
| 改了配置不生效 | `Config` 字段都是 `.volatile()`，保存即生效；仍不生效则重启 dsh |
| 拖动悬浮球后不弹窗 | 这是设计：拖动结束会吞掉一次 click；单击才打开 |
| 想恢复悬浮球位置 | 右键悬浮球（复位到停靠角） |

服务端日志：插件加载失败只在**服务端 stderr**；`.plugin-manager/logs/operation-*/pnpm.log` 只对 GUI 安装有意义。

## 3. 安全的冒烟测试（不动你的 `~/.dsh`）

```sh
# 用临时 DSH_HOME，避免影响正在使用的配置
$env:DSH_HOME = 'E:\workspace\_probe\dshhome-smoke'   # PowerShell；其它 shell 用 export
$env:ELECTRON_RUN_AS_NODE = 1

dsh plugin --profile web add link:E:/workspace/dsh-sideask
dsh --profile web --port 0 --no-open
# → dsh web: http://127.0.0.1:<port>/?token=<token>
```

打开该 URL 后，在 devtools 里验证：

```js
await (await fetch('/plugins/dsh-sideask/api/bootstrap')).json()
// { apiVersion: 1, settings: {...}, model: {...}, providers: [...], unavailable: null }
```

冒烟通过标准：

1. `bootstrap` 返回 200 且 `apiVersion === 1`；
2. 浏览器 bundle 可下载（HTML 里的 `plugins/??dsh-sideask/client.js&rev=…` 返回 200，body 含 `__ModuleLoader__.load`）；
3. 悬浮球可见、可拖动、位置会被记住；
4. 一次提问能流式返回并带引用（需要可用的模型凭据）。

本机（Windows + dsh 0.2.2-rc.1）的真实证据见 [`verification.md`](verification.md)。

## 4. 卸载

```sh
dsh plugin --profile web remove dsh-sideask
```

卸载不会删除历史文件；需要彻底清理时手动删除：

```sh
rm -rf "$DSH_HOME/storages/sideask"      # PowerShell: Remove-Item "$env:DSH_HOME\storages\sideask" -Recurse -Force
```

浏览器端：清除该站点 localStorage（窗口位置、草稿、摘要缓存、模型偏好）。

## 5. 开发者循环

```sh
pnpm install                # 首次；prepare 自动构建
pnpm run typecheck          # tsc（宿主 + 浏览器半）
node scripts/build.mjs      # 构建 lib/（宿主 + 浏览器 bundle）
node scripts/check.mjs      # 清单/导出/危险 HTML 自检
node scripts/preflight.mjs  # 交付闸门（manifest、包内容、截图、元数据）
node --test                 # 241 项测试
node scripts/memory-check.mjs  # 200 轮内存上界
node scripts/build.mjs --watch # 只重打包浏览器半（配合刷新页面）
```

改宿主半后需要重启 dsh；改浏览器半后重新构建并刷新页面（`link:` 安装指向源码目录）。
