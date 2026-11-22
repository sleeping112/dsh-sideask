# Contributing

Thanks for taking a look. This is a small plugin, and the rules below exist
because two early mistakes (a duplicated browser registration and a throwing
`apply()`) made DSH disable **every** third-party plugin in the process. The
invariants are not style preferences.

## Setup

- Node ≥ 20, pnpm (the repository pins `packageManager` in `package.json`).
- DeepSeek Harness `0.2.0-rc.1 … 0.3.0-0` for manual testing.

```sh
pnpm install
pnpm run typecheck
node scripts/build.mjs
node scripts/check.mjs
node scripts/preflight.mjs
node --test
```

`pnpm install` runs the `prepare` script, which builds `lib/` (host half and the
browser bundle). `lib/` is not committed.

## Layout

```
src/shared/   pure logic used by both halves: contracts, context budgeting,
              redaction, citations, prompts, token estimates, summary helpers
src/host/     Node ESM plugin: manifest side, HTTP routes, model calls,
              thread storage, config
src/client/   browser half: Shadow-DOM floating window, context extraction,
              streaming, citations, write-back; bundled to lib/client.js
test/         node --test suites plus a fake host harness
scripts/      build, static checks, delivery preflight, memory check
docs/         design, wireframes, verification evidence, research notes
```

## Hard invariants

1. **`apply()` never throws.** The browser half is mounted into a live host; a
   throw during boot fails the whole web application and DSH then disables all
   third-party plugins. Every host-API call is wrapped (`safe(...)`) and unknown
   capabilities degrade instead of failing.
2. **Exactly one Module Loader registration.** The bundle is built as a single
   `window.__ModuleLoader__.load({ id: 'dsh-sideask', factory })`. Registers are
   counted by `scripts/check.mjs`; the bundle test executes the real file under a
   fake loader.
3. **No writes to the main conversation, ever, unless the user clicks.** The host
   half must not import session/agent write APIs. Read-only context only.
4. **No `dangerouslySetInnerHTML`.** Markdown is rendered from a small AST; HTML
   in model output is shown literally.
5. **No new runtime dependencies** without a discussion. The browser bundle only
   requires seed modules provided by the host (`react`, `react-dom`,
   `@deepseek-ai/*`, `dsh-client-store`, …).
6. **Bounded resources.** Threads, messages, caches, drafts and SSE buffers have
   explicit caps; `scripts/memory-check.mjs` must stay flat over 200 turns.

## Testing policy

- Unit tests are pure and fast; run `node --test`.
- Anything touching the renderer is additionally verified in a real browser
  (headless Edge + CDP) in an isolated `DSH_HOME`, never in the user's desktop
  profile.
- Verification evidence belongs in `docs/verification.md` with the observed
  output, not just "should work".

## Pull requests

- Keep changes scoped; update `CHANGELOG.md` under a new version heading and bump
  `package.json` together (the preflight checks they match).
- Run the full gate before pushing:

  ```sh
  pnpm run typecheck
  node scripts/build.mjs
  node scripts/check.mjs
  node scripts/preflight.mjs
  node --test
  node scripts/memory-check.mjs
  ```

- If you touch the browser half, say how you verified it in the PR description.
- Documentation is bilingual: update `README.md` and `README.zh.md` when user-facing
  behaviour changes. Internal docs under `docs/` may stay Chinese; keep the facts
  (paths, commands, limits) accurate.

## Commit messages

Conventional-ish, sentence case, with the version when relevant:

```
fix(client): keep focus when switching threads (v0.6.1)
feat(host): truncate endpoint for regenerate
docs: rewrite install section for github: installs
```

## Release process

Maintainers only: bump version + CHANGELOG, tag `vX.Y.Z`, push the tag (the
release workflow builds, runs the gate, and attaches `dsh-sideask.tgz`), then
update the marketplace entry — see [PUBLISHING.md](PUBLISHING.md).

## Reporting

- Bugs and feature requests: use the issue templates.
- Security: private advisory process in [SECURITY.md](SECURITY.md).
