# dsh-sideask · Side Ask

> A floating **light conversation** beside your current DeepSeek Harness chat: ask with read-only context, get answers with citations, and write back only when *you* click — never polluting the main thread.

English ｜ [中文](README.zh.md)

---

## What it is

You are deep into a long conversation and want to ask a side question: *"Why is this code written that way?"*, *"Explain that error again"*, *"What else can this API do?"*

Asking inline derails the thread and pollutes the context; opening another window means pasting all the background again.

**Side Ask** docks next to the main conversation:

- Click the floating bubble or press `Alt+Shift+A`;
- It reads **only** the recent messages you can see in the main conversation (plus any text you selected) as context;
- It answers in its **own thread**, with multiple turns, marking which messages it cited;
- When you want it in the main thread, click **Copy / Insert quote block / Quote to main chat / Insert as draft** — *only an explicit click touches the main conversation*;
- Closing the window or clearing the thread leaves the main conversation untouched.

## Why it cannot pollute the main conversation (mechanism, not a promise)

| Layer | Guarantee |
|---|---|
| Host half | Imports no session/agent write API; one `ctx.llm.stream(...)` call, no dsh session created, no session log written |
| Model input | Request-only user inputs (no id/source); no durable message is produced |
| Storage | Threads live only in the plugin's own `$DSH_HOME/storages/sideask/threads.json` |
| Browser half | Reads `eventSource.getSnapshot()` snapshots; never mutates conversation state |
| Write-back | Four explicit actions only, all through the public composer API (`insertQuote` / `setDraft` / clipboard), with fallbacks |

## Features

- **Floating window**: drag, snap to four corners, minimize/expand, position + size memory, global hotkey
- **Light conversation**: independent thread, multi-turn, streaming, stop, clear, local history, loading/error/retry states
- **Context**: recent N messages + user selection + summary slot; token-budgeted, de-duplicated, two-layer secret redaction; incremental refresh via a projection cache
- **Citations**: answers cite `c1..cN`; click a citation to see the source excerpt
- **Privacy**: one-click context off, clear history, optional no-persist, zero network permissions

## Install

Requires dsh ≥ 0.2.0-rc.1 (verified on 0.2.2-rc.1).

```powershell
# 1) Build (Node ≥ 20)
node scripts/build.mjs
node scripts/check.mjs

# 2) Install into your profile (check the row with --dump-config)
$env:ELECTRON_RUN_AS_NODE=1
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile web add link:E:/workspace/dsh-sideask
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' --profile web --dump-config

# 3) Launch
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' --profile web --port 0 --no-open
```

See [`docs/quickstart.md`](docs/quickstart.md) and [`docs/verification.md`](docs/verification.md) for machine-specific commands and observed evidence.

## Usage

| Action | How |
|---|---|
| Open / close | `Alt+Shift+A` or the floating bubble |
| Ask | Type, `Enter` sends (`Shift+Enter` newline) |
| Include context | Bottom toggle "include main-chat context" (`1.2k/3k token`) |
| Ask about a selection | Select text in the main chat → click "Side Ask" next to the selection |
| Stop | "Stop" while streaming |
| See what was cited | Click a `cN` chip, or the token counter for "context details" |
| Merge back | Under an answer: Copy / Insert quote / Quote to main / Insert as draft |
| Clear | Header menu clears the thread; settings clears all history |

## Configuration

Host settings page (schemastery `Config`; rendering by the plugin manager is **assumed**) or the in-window settings panel:

| Key | Default | Meaning |
|---|---|---|
| `readContext` | `true` | Privacy master switch: off ⇒ never reads the main chat |
| `redactSensitive` | `true` | Secret redaction (browser + host, two layers) |
| `persistHistory` | `true` | Persist side-thread history |
| `recentMessageLimit` | `12` | Recent message window |
| `contextBudgetTokens` | `3000` | Hard context token budget |
| `autoSummary` | `true` | History summary layer (active in P1) |
| `answerMaxTokens` | `1200` | Answer length cap |
| `defaultCorner` | `top-right` | Default dock corner for the pill and the window |
| `hotkey` | `Alt+Shift+A` | Toggle shortcut |
| `provider` / `model` | `''` | Empty ⇒ host default model |
| `customRedactionPatterns` | `[]` | Extra redaction regexes |

## Docs

- [Design document (12 sections: alternatives, architecture, state machines, budget strategy, contracts, tests, risks, MVP)](docs/design.md)
- [Host capability map](docs/research/host-api.md) · [Client API evidence](docs/research/client-api.md) · [Loading + smoke](docs/research/patterns.md)
- [Wireframes and interaction](docs/ui-wireframe.md) · [Verification evidence](docs/verification.md)

## Development

```powershell
node scripts/build.mjs          # tsc(host) + tsc(pure modules) + esbuild(client) + bundle shape checks
node scripts/check.mjs          # manifest/export/no-import self checks
node --test                     # 130 unit tests (budget/redaction/citations/context/host harness/window geometry/SSE/memory bounds)
node scripts/memory-check.mjs   # 200-turn memory-growth check (heap must not grow; threads trimmed)
node scripts/build.mjs --watch  # rebuild the browser half only (refresh the page)
```

Layout: `src/shared` (pure, cross-platform logic) · `src/host` (Node ESM plugin) · `src/client` (browser bundle, Shadow DOM).

## Resource and memory bounds (why it will not eat your RAM)

| Structure | Bound |
|---|---|
| Context token budget | 3000 default, hard cap 64000 (clamped in config) |
| Single context message | 35% of the budget |
| Threads / messages per thread | 30 / 200 (configurable), oldest dropped |
| Projection cache (incremental) | 512 entries |
| SSE buffer | only the unfinished half-frame |
| Embedded history turns | 8 |

Measured: 200 real `ask` turns leave the V8 heap flat at 6–7 MB (no growth after warm-up) with RSS
plateauing at 43 MB; a real dsh instance (Electron, throwaway home) with the plugin loaded sits at
~533 MB, i.e. Electron baseline. See [`docs/verification.md`](docs/verification.md) §5.

## Permissions

```jsonc
"dshhub": { "surfaces": ["host", "web"], "permissions": { "network": [] } }
```

- **No outbound network of its own**: the only network access is the host model service, reusing your dsh account/model configuration.
- **Local storage**: `$DSH_HOME/storages/sideask/threads.json` and browser localStorage (window geometry / UI toggles only).
- **Host capabilities**: `webServer.register` (local same-origin routes), `llm.stream` (model calls), local thread storage.

## License

MIT
