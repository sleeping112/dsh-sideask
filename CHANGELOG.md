# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); the project
adheres to [Semantic Versioning](https://semver.org/).

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
