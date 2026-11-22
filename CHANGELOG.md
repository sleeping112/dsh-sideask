# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.6.1] — 2026-11-23

Delivery / packaging release ahead of the awesome-dsh-plugin submission. No
runtime behaviour changed.

### Added
- `prepare` script: `dsh plugin --profile <name> add github:sleeping112/dsh-sideask`
  now builds the host half and browser bundle during install (previously a
  source install produced no `lib/` and the plugin could not load).
- Repository assets: storefront icon (`assets/icon-180.png`), four screenshots
  (`assets/screenshot-1..4.png`) and `screenshots.json` so marketplaces can show
  the UI without hand-maintained URLs.
- `scripts/preflight.mjs` delivery gate (16 checks: manifest, patch consistency,
  built artifacts, package `files[]`, screenshots, icon, license, metadata,
  README install instructions) — wired into CI, `prepublishOnly` and documented
  in `PUBLISHING.md`.
- CI now also runs the preflight and the memory-bounds check, uses pnpm with the
  committed lockfile, and triggers on the `master` branch (the previous workflow
  only listed `main`, so push builds never ran).
- `pnpm-workspace.yaml` with `allowBuilds: { esbuild: true }`: pnpm 11 removed
  `pnpm.onlyBuiltDependencies`, so installs failed with
  `ERR_PNPM_IGNORED_BUILDS` before any check could run. esbuild's postinstall
  (which places the platform binary) is now approved explicitly.
- `release` workflow: pushing a `v*` tag builds, runs the gate and attaches a
  version-free `dsh-sideask.tgz` prebuilt tarball to the GitHub Release.
- `SECURITY.md`, `CONTRIBUTING.md`, `PUBLISHING.md` (awesome-dsh-plugin
  submission playbook with the exact entry YAML), issue templates.
- `package.json`: `repository` / `homepage` / `bugs` / `packageManager`; package
  description rewritten to a single factual sentence.

### Changed
- `README.md` and `README.zh.md` rewritten for delivery: badges, screenshots,
  generic `github:` install, current feature set (v0.6: draggable bubble, thread
  menu/fork/regenerate, model picker, templates, summary, hand-off), accurate
  configuration and limits tables, security/privacy/support sections.
- `docs/quickstart.md` rewritten generically (profile-independent install,
  current troubleshooting incl. draggable bubble), keeping the isolated
  `DSH_HOME` smoke-test recipe.

### Verified
- `node scripts/preflight.mjs` → 16/16 checks; build + 241 tests unchanged.
- `npm pack` contents include `lib/`, `cordis.patch.yml`, `assets/`,
  `screenshots.json`, docs and policies.
- Clean-room install check: `dsh plugin --profile web add github:sleeping112/dsh-sideask`
  in a throwaway `DSH_HOME` (recorded in `docs/verification.md` §20).

## [0.6.0] — 2026-11-22

### Removed
- **Pin (`钉住`) feature, end to end**: the composer pin chips, the `#` pin picker,
  the cross-session "其它会话（只读）" section that lived in it, the `pinned`
  context source, the pinned budget share/`pinnedTokens` stat, and the
  `用户钉住` prompt label. Context now has exactly three sources: selection,
  recent window and summary. The details panel keeps its per-item exclusion
  checkboxes (a separate feature).
  - Reason: the pin surface duplicated what "select text" already does, and it
    was the most crowded part of the UI.

### Added
- **Draggable entrance pill**: the floating pill can be dragged anywhere in the
  viewport (pointer drag with a 4 px threshold so taps stay taps), and the
  position is persisted with the rest of the window geometry
  (`schema: 3`, `pillFree`). A drag never opens the window; a plain click does.
  Right-click re-docks it to the window corner. Free positions are clamped on
  restore and on viewport resize. Old `schema: 2` records are still accepted
  (the pill simply starts docked).

### Verified
- 241/241 tests (6 new pill tests; 4 obsolete pin tests removed).
- Real-browser CDP: docked pill at (800,110) dragged so its centre sat at
  (420,320) (`cx:true, cy:true`), window stayed closed during the drag,
  `pillFree:{x:379,y:304}` persisted in `schema:3`, the position survived a page
  reload, and a plain click still opened the window; the shadow root contains no
  "钉住" text, no pin button and no pin panel; the details panel no longer shows
  a pinned row; 0 console errors / 0 uncaught exceptions.

## [0.5.0] — 2026-11-22

Iteration 4 of the competitive-gap plan (see `docs/verification.md` §18).

### Added
- **Persisted summary cache**: summaries are now stored per session in
  `localStorage['dsh-sideask.summary.v1']` (bounded: 3 sessions × 8 entries ×
  4000 chars) and rehydrated when the session binds, so a page reload no longer
  forces a re-summarisation of the same history. Stale entries are harmless
  because the cache key is the exact overflowing message-id set.
- **Quick templates**: a "模板" picker (also opened by typing `/` in an empty
  draft) inserts a well-formed question into the composer — 解释这段 / 找风险 /
  列测试 / 说清楚点 / 总结要点 / 下一步 / 矛盾检查. Templates are never sent
  automatically and merge with existing draft text.
- **Past chats (read-only)**: the `#` pin picker now lists the other sessions;
  selecting one reads its newest messages (retain → read → release, 2.5 s cap)
  and lets you pin one as high-priority context. Nothing is written to that
  session.

### Changed
- **One popover at a time**: the window shell now keeps a single panel slot
  (details / threads / pins / models / templates), so two panels can no longer
  overlap (found in a screenshot during verification).

### Verified
- 237/237 tests (6 summary-store + 4 template tests added).
- Real-browser CDP: template picker lists all 7 templates and inserting "找风险"
  wrote the text into the composer; `/` opened the picker; the pin panel showed
  the other session, reading it returned the honest "no messages" state for an
  empty session, and `loadPastSession('missing')` returned `null`;
  `persistSummary` wrote the entry to localStorage and after a full page reload
  the store hydrated it back; opening pins closed the templates panel; 0 console
  errors / 0 uncaught exceptions.

## [0.4.0] — 2026-11-22

Iteration 3 of the competitive-gap plan (see `docs/verification.md` §17).

### Added
- **History summary layer** (multi-turn context beyond the recent window): after
  a turn settles, the client compresses the messages that fell out of the recent
  window through the new host route `POST /summarize` and caches the result by the
  exact overflowing message-id set (`src/client/summary.ts`). Later questions get
  the summary inserted at the existing summary budget share (25%); when it is not
  ready yet the details panel says "历史摘要正在后台生成，本轮先用最近消息"
  (`summary-pending`). Empty inputs never call the model; failures are silent and
  never break a question.
- **Fork a side thread**: "分叉" on an answer copies the thread prefix (up to and
  including that answer) into a new thread (`ThreadStore.fork`, fresh message ids,
  remapped `replyTo`, title suffix "· 分叉") and switches to it.
- **Hand off to the main conversation**: "交给主对话" writes an explicit
  `请执行以下旁问结论：…` task into the main composer after one confirmation.
  It never sends automatically and never touches the main conversation otherwise.

### Changed
- The write-back "as draft" confirmation can be skipped by callers that already
  confirmed intent (the handoff action), avoiding a double dialog.

### Verified
- 227/227 tests (13 new host summary/fork tests, 11 summary plan/cache tests,
  3 handoff/quote-block tests).
- Real-browser CDP with a seeded answer: 重新生成/分叉/交给主对话/引用 c1 all
  render; citation jump highlights the injected source paragraph; fork produced
  `… · 分叉` with 2 messages and switched threads; handoff wrote
  `请执行以下旁问结论：…` into the real main composer (inside the app's shadow
  root); `/summarize` empty → 200 `""` (no model call), non-empty without
  credentials → 502 `MISSING_CREDENTIAL`, bad fork id → 404; 0 console errors /
  0 uncaught exceptions.

## [0.3.0] — 2026-11-22

Iteration 2 of the competitive-gap plan (see `docs/verification.md` §16).

### Added
- **Regenerate any (last) answer**: a "重新生成" button on the last assistant
  message truncates that turn on the host (`POST /threads/<id>/truncate`) and
  re-asks the same question. Works for failed answers with empty text too; only
  the last answer is allowed (removing later turns silently would be surprising).
- **`#` pinned context**: a picker lists the newest main-conversation messages and
  pins the chosen ones. Pins rank below a live selection but above the automatic
  recent window, appear as `c1…` with the `用户钉住` label in the prompt, get their
  own budget share (35%, `DEFAULT_PINS_RATIO`), and are consumed by the next ask.
  Pinned chips are shown above the composer and can be removed individually.
- **Editable context before sending**: the details panel can run extraction on
  demand ("读取当前上下文") and lists every item with a checkbox; unchecked items
  are removed from the request and the used-token count is recomputed.
- **In-window model picker**: `GET /models` lists provider/model catalogs
  (`ctx.llm.listModels` normalised, capped, 5 s timeout); selecting one is stored
  locally and sent as the `routeHint`, so it only affects side questions. The
  default stays "follow the main conversation"; adapters that advertise no models
  show an honest empty state.

### Fixed
- Explicit pins are still usable when no main session is bound (they no longer
  fall into the question-only bundle).
- The last assistant message with empty text (failed turn) now exposes its actions
  (regenerate), while write-back buttons stay hidden for empty text.

### Verified
- 200/200 tests (10 host truncate/models + 8 draft helpers + 4 pinned-context
  cases added in this iteration).
- Real-browser CDP: regenerate changed both turn ids while keeping 2 messages;
  pinned item rendered as `c1 钉住`, exclusion set `excludedMessageIds`, restore
  cleared it; `/models` returned 200; selecting a model changed the host's error
  from `deepseek-official` to `deepseek-account`, proving the route hint took
  effect; 0 console errors / 0 uncaught exceptions.

## [0.2.0] — 2026-11-22

Iteration 1 of the competitive-gap plan (see `docs/verification.md` §15).

### Added
- **Selection affordance**: selecting text anywhere in the main conversation
  shows a small floating 「旁问」 button next to the selection; clicking it
  captures that text as the highest-priority context and opens the side thread.
  Implemented as our own DOM listener, because the host's
  `conversation.chat.text-interaction` slot is KEYED and only the interaction
  that calls `request.open()` is rendered (`ui-chat/lib/client.js:3683-3688`) —
  the official quote plugin owns that slot.
- **Per-thread composer drafts**: each thread keeps its own draft (and the
  "new question" slot has one too), persisted in
  `localStorage['dsh-sideask.draft.v2']`. Switching threads no longer loses what
  you were typing; sending or deleting a thread clears its draft.
- **Citation jump**: clicking an inline `cN` chip or a citation chip now reveals
  the source message in the main conversation (scroll + temporary outline).
  Exact message ids are tried first, then a text-excerpt match; when nothing
  matches, the excerpt is shown in a toast instead of failing silently.
- **Session fallback picker**: the advisory session binding no longer blindly
  takes `sessions.list().ids[0]`; it prefers the session retained by the main
  view, then the most recently updated one, and ignores blank sessions
  (`src/client/session-fallback.ts`).

### Changed
- **Accessibility**: the entrance pill is a real `<button>` now (focusable,
  labelled, Enter/Space activate it) instead of a clickable `<div>`.
- **Safety**: "插入为草稿" asks for confirmation before replacing whatever is
  already in the main composer.

### Verified
- 179/179 tests (`jump` 14 + `session-fallback` 10 + draft helpers).
- Real-browser CDP: pill is a focused BUTTON with an aria-label; selection
  affordance appears at the selection and clicking it opens the window with the
  selected text captured; per-thread drafts survive thread switches (and a new
  thread starts empty); `reveal` returns `excerpt` + applies the highlight and
  `not-found` for an unknown excerpt; 0 console errors / 0 uncaught exceptions.

## [0.1.8] — 2026-11-18

### Added
- **Thread management UI** (was the biggest functional gap): a header button
  ("线") opens a thread menu listing every side thread with message count and
  relative time; selecting one switches to it, "＋ 新建" creates an empty thread,
  "删除当前" deletes the current one. Verified in a real browser: create switched
  the current thread (3→4 threads), switching loaded that thread's messages, and
  delete removed it (4→3).

### Changed
- **One error surface**: while a failure is the current answer, the matching
  assistant bubble no longer repeats the error text (the retry card owns it).
  Measured in the browser: `MISSING_CREDENTIAL` occurrences in the window went
  from 2+ to 1, `errorCards: 1`, `bubbleHasErrorCode: false`. Historical failures
  still show a compact code line in their bubble.
- **Streaming Markdown is parsed per bucket, not per token**: the view memoises
  on `markdownBucket(text, streaming)` (80-character buckets while streaming,
  one final parse on settle), removing the O(n²) re-parse of long answers.
  Added unit tests for bucket stability/boundaries and the final key.

### Verified
- 155/155 tests; real-browser CDP run: thread menu 4 interactions + single error
  surface + 0 uncaught exceptions (screenshot `sideask-thread-menu.png`).

## [0.1.7] — 2026-11-18

### Fixed
- **CRITICAL: the floating window was unclickable.** It was mounted inside the
  `shell.overlay` slot, which is z-index 20 in the app frame; the main chat's
  sticky composer/pane paints above that layer, so the lower half of the window
  (including the input box) sat *underneath* the chat composer. Real-browser
  audit evidence: `document.elementFromPoint` at the textarea centre returned the
  chat's own button, the textarea could not take focus, and typing did nothing.
  - the window is now mounted from `document.body` into a container that owns a
    maximal stacking rank (`z-index: 2147483000`); the slot contribution is a
    no-op mounter. Style isolation is unchanged (open Shadow Root + injected CSS);
  - verified: `docHit` is now our host, a real mouse click focuses the textarea
    (`shadowRoot.activeElement === TEXTAREA`), real `Input.insertText` types into
    it, and Enter sends the question.
  - trade-off: the window now also floats above modals/drawers, because anything
    body-level beats the whole app frame. Documented in the design doc.
- **Misleading error code**: when the fallback routes also failed, the last
  generic failure (`PROVIDER_ERROR`) replaced the actionable first one
  (`MISSING_CREDENTIAL`). The reported error now prefers the most actionable
  failure and appends "（已尝试 N 条模型路由）".
- **Session retention leak**: `sessions.retain()` was called on every session
  switch but the returned reference was never released. The reference is now
  owned and released; adopted probe bindings are left to their own scope.
- **Bootstrap failure was permanent**: a failed first `bootstrap` (overlay mounts
  before the host may be ready) disabled settings loading for the rest of the
  session. `init()` now retries while no successful bootstrap is cached.
- **Context details panel said "未绑定主对话"** before the first extraction had
  ever run; it now says statistics appear after the first question.

## [0.1.6] — 2026-11-15

### Fixed
- **The closed-state pill ignored host settings.** `store.init()` (which loads
  `bootstrap.settings`) only ran when the window was opened, so the entrance pill
  kept using the local fallback (`pillOffset: 40`, `defaultCorner: bottom-right`
  era values) instead of the configured values — changing `pillOffset` appeared to
  do nothing until the panel was opened. Settings now load on mount; verified in a
  real browser with `pillOffset: 110` (pill rect top = 110px, right margin 18px).

## [0.1.5] — 2026-11-15

### Changed
- **The entrance pill sits a little lower**: the vertical offset from the top
  edge is now a configuration field `pillOffset` (default 40 px, range 0–240)
  instead of the fixed 18 px shared with the horizontal margin. Horizontal
  offset stays 18 px; bottom corners keep 18 px. Verified in a real browser:
  pill rect top = 40, right margin = 18, hotkey still opens the window, no boot
  errors.

## [0.1.4] — 2026-11-15

### Fixed
- **`MISSING_CREDENTIAL` on the first question**: the plugin resolved the *global
  default model* (`deepseek-official`, an API-key route) while the user's
  conversation was running on the signed-in account route (`deepseek-account`),
  which is why the main chat worked and the side thread did not.
  - the client now extracts the conversation's current model from the last
    assistant message (`source: { provider, model }` — routing metadata only, no
    content) and sends it as `AskRequest.routeHint`;
  - the host builds an ordered candidate list — explicit config → route hint →
    global default → every other registered provider with a known model — and
    retries only on `NO_ADAPTER` / `MISSING_CREDENTIAL` / `AUTH` failures that
    happened **before any token**, so streamed text is never duplicated;
  - credential failures now carry an actionable message (use the conversation's
    model, change the host default, or set `provider`/`model` in the plugin).
- Tests: `test/host.routing.test.mjs` (hint priority, config priority, fallback
  queue, de-duplication, broken services) and `lastRouteHint` cases in
  `test/client.transcript.test.mjs`. 153 tests total.

## [0.1.3] — 2026-11-14

### Fixed
- **CRITICAL: a rejected hotkey registration broke web boot.** `apply()` called
  `ctx.shortcuts.register({ id: 'side-ask.toggle', defaults: { 'web:*': Alt+Shift+A } })`.
  The host shortcut service validates every Web default and **throws**
  `Unsupported Web shortcut: side-ask.toggle` because a Web binding must have
  3+ modifiers or include `primary` (Ctrl/⌘)
  (`dsh-client-shortcuts/lib/client.js:109-1220`). The throw escaped `apply()`,
  failed the client entry, failed web boot, and the app offered to disable all
  third-party plugins.
  - the plugin now owns its hotkey (`src/client/hotkey.ts` + a `keydown`
    listener), keeping the documented `Alt+Shift+A`; the host shortcuts service
    is no longer required (removed from `inject`);
  - **`apply()` can no longer throw**: every optional registration goes through a
    `safe()` guard, and a top-level catch logs and degrades instead of failing
    the entry;
  - list-slot probes now pass `id` (not `key`), which the slot registry requires
    (`list slot "…" requires options.id`).
- Added regression tests: `test/client.hotkey.test.mjs` (parse/match/format) and
  a hostile-context case in `test/client.bundle.test.mjs` where every service
  throws — `apply()` must still not throw; the bundle test also asserts the
  plugin no longer injects `shortcuts`.

### Verified
- Real browser (headless Edge + CDP) against an isolated `dsh web` instance:
  `boot errors: 0`, `uncaught exceptions: 0`, pill rendered inside the shadow
  root at the top-right, and `Alt+Shift+A` opens the window.

## [0.1.2] — 2026-11-14

### Changed
- **Default dock corner is now `top-right`** (was `bottom-right`), so the
  floating entrance pill and the window start in the top-right corner.
  Configurable via `defaultCorner` (`top-left` / `top-right` / `bottom-left` /
  `bottom-right`).
- The entrance pill now honours the docked corner instead of being hard-coded to
  the bottom-right; it follows whichever corner the window was dragged to.

### Fixed
- **Remembered geometry no longer pins the initial default.** v0.1.1 wrote the
  default geometry to localStorage on first mount, so changing `defaultCorner`
  afterwards appeared to do nothing. Geometry is now only persisted after the
  user drags, resizes, collapses or minimizes the window, and the storage key was
  bumped to `dsh-sideask.window.v2` (a stored record without `schema: 2` is
  ignored, which migrates old installs to the configured default once).

## [0.1.1] — 2026-11-13

### Fixed
- **CRITICAL: duplicate Module Loader registration broke web boot.** The browser
  bundle registered its factory twice — once from the build wrapper and once from
  `src/client/index.ts`, which ran inside the factory body. dsh's loader rejects
  that with `duplicate factory registration for "dsh-sideask" (bundle executed
  twice without invalidate?)`, the client entry fails to activate, and the app
  treats the boot as failed and offers to disable **all** third-party plugins.
  This is exactly what happened when the plugin was enabled in a real profile.
  - registration now happens in the build wrapper only (`scripts/build.mjs`),
    and the factory body has no `__ModuleLoader__` reference at all;
  - the factory now returns the plugin object (`{ name, inject, apply }`) rather
    than the CJS module namespace, matching `registered.factory(require)` in the
    loader (`dsh-client-modules/lib/client.js:706-712`);
  - `scripts/check.mjs` asserts the bundle contains exactly **one**
    `__ModuleLoader__.load(` call and that the factory returns `createPlugin()`;
  - new regression test `test/client.bundle.test.mjs` executes the REAL built
    bundle under a fake loader and asserts one registration, the plugin shape,
    the seed-only `require` set, and that materialising the factory does not
    register a second time. This failure mode could not be caught by a
    "contains `__ModuleLoader__.load`" grep, which is why it shipped.
- `package.json` restored and version bumped; a PowerShell rewrite of the file
  had corrupted non-ASCII fields (now regenerated and validated as JSON).

### Added
- Incident report in `docs/verification.md` §11 with the app log excerpt, the
  loader source evidence, the rollback procedure and the safe-enable checklist.

## [Unreleased]

### Fixed
- **SSE streams aborted immediately on real hosts**: the ask handler aborted on
  the *request* `close` event, which Node fires as soon as the POST body is
  consumed. Disconnect detection now listens on the *response* (plus request
  `aborted`/`error`), and only while the response is still open.
- **Streaming felt chunky**: every SSE frame waited for `drain` (up to 250 ms).
  The wait is now conditional on `res.write()` returning `false` — real
  backpressure only. This cut a 200-turn benchmark from ~4 minutes to ~3 seconds
  and removes per-token latency in the browser.
- **Thread routes by id were unreachable**: the id-scoped routes were registered
  under a trailing-slash prefix, which the host matcher (`pathname === prefix ||
  pathname.startsWith(prefix + '/')`) can never match for `/threads/<id>`. The
  prefix is now slash-less.
- **`persistHistory: false` still wrote history**: persistence is now gated in
  the store itself (no load, no write), applied before the first read and on
  every config change.
- **Client transcript mapping crashed on junk entries** (`null` in the event
  window); non-object entries are skipped now. Caught by the new client tests.
- **`node --test test/` did not run** on Node 24 (a directory is not a test
  target); the script now uses auto-discovery (`node --test`).
- `dshhub.permissions.host` removed: the host never reads that vocabulary, so it
  would have implied a permission system that does not exist. Only
  `permissions.network` (empty) remains, which is metadata.
- `dsh.client.immediately` set to `true` so the hotkey works before the user
  visits any settings surface.

### Added
- `scripts/memory-check.mjs` (`npm run test:memory`): 200-turn growth check that
  asserts a flat heap and a bounded thread store, plus `test/bounds.memory.test.mjs`
  pinning every unbounded-looking structure to an explicit cap.
- Real-host verification report (`docs/verification.md`) with the throwaway-home
  install/launch commands, HTTP evidence, and memory measurements.
- UI wireframes and interaction/keyboard flows (`docs/ui-wireframe.md`).

## [0.1.0] — 2025-11-12

### Added
- Host half: plugin entry (`name` / `Config` / `apply`), schemastery config with
  live (volatile) updates, thread store under
  `$DSH_HOME/storages/sideask/threads.json` (atomic writes, bounded, corrupt-file
  self-healing), model gateway over `ctx.llm.stream`, and an HTTP API
  (`bootstrap` / `ask` SSE / `cancel` / `threads` / `health`) with a same-origin
  guard.
- Browser half: Module Loader bundle registering a floating window in the
  `shell.overlay` slot, rendered inside a Shadow Root; drag/snap/minimize/
  expand/position memory; global hotkey; side-thread UI with streaming,
  citations, error/retry and context details.
- Context engine: read-only transcript projection, de-duplication (exact +
  containment), conservative CJK-aware token estimation, priority budgeting
  (selection > recent > summary), head/tail truncation, and an incremental
  projection cache keyed by message identity + content hash.
- Privacy: two-layer secret redaction (browser + host, idempotent), one-click
  context-off, history clearing, and a no-persist mode that never touches disk.
- Citations: `⟦refs: c1, c3⟧` protocol with inline `[cN]` fallback; unknown
  references are dropped rather than displayed.
- Explicit write-back only: copy / insert quote / quote to main chat / insert as
  draft, with `setDraft` → clipboard fallbacks.
- Tests: 52 shared-logic unit tests (tokens, redaction, context/budget,
  citations/prompt) plus a host harness and a real-launch smoke script.
- Docs: 12-section design document, API evidence with file:line citations,
  wireframes, quickstart, verification report.
