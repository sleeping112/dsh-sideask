# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); the project
adheres to [Semantic Versioning](https://semver.org/).

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
