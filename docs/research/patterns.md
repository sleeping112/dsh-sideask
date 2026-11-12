# dsh plugin patterns — verified on this machine

Recon date: 2026-11-12. Every command/output below was actually run in this session.
Reference plugins: `E:\workspace\dsh-spend-wallpaper` (read-only) and the probe I built at
`E:\workspace\_probe\sideask-probe\min-plugin` (throwaway, used to prove the minimal shape).

Environment facts used throughout:

| Fact | Verified value |
|---|---|
| dsh CLI | `D:\deepseek\resources\runtime\cli\bin\dsh.cmd` (must run with `$env:ELECTRON_RUN_AS_NODE=1`) |
| dsh version | `0.2.2-rc.1` (`dsh --version`) |
| plain node | `D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe` |
| bundled SDK | `@deepseek-ai/cordis@4.1.0`, `@deepseek-ai/schemastery@3.19.0` |
| pnpm used by `dsh plugin` | v11.28.5 (from PATH; the CLI forwards args to it) |
| throwaway home used | `E:\workspace\_probe\dshhome` |

Source of truth for the loader/client machinery (read, not guessed):
`E:\workspace\_probe\asar-out\dsh\node_modules\@deepseek-ai\dsh-client-modules\README.md`
and `...\dsh-client-modules\lib\index.js`, `...\dsh-client-modules\lib\client.js`.
Profile templates: `...\@deepseek-ai\dsh-official-bundles\lib\index.js`.

---

## 1. Verbatim minimal skeletons

### 1.1 `package.json` — the actual probe that loaded and served a client bundle

This exact file was installed and booted successfully. `dsh` / `dshhub` annotations say what is
REQUIRED vs optional (node loading it is the proof).

```json
{
  "name": "dsh-sideask-probe",
  "version": "0.0.1",
  "description": "throwaway recon probe plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true },
    "compatibility": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" }
  },
  "engines": { "node": ">=20" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/schemastery": "~3.19.0"
  }
}
```

Field by field (evidence in §2):

- **REQUIRED to be a plugin at all** — `name` (identity of the module; resolved from the profile's
  `node_modules`), `type: "module"` + `main`/`exports["."]` (host half is a real ESM module; the
  loader `import()`s it), `dsh.manifestVersion: 1`, `dsh.bundle.patch` pointing at the patch file.
- **REQUIRED for the web/client half** — `exports["./client"]` (the bundle path that
  `dsh-client-modules` reads; without it there is no `/plugins` entry) and
  `dsh.client.platform: "web"`. `dsh.client.immediately: true` is **optional**: it selects the
  boot-prefetch tier (the shell's `prefetchImmediateTier()` filters `manifest.plugins` by it;
  official `ui-theme` declares it). The row enters the boot graph from the package declaration
  either way — the probe used `true` and was served normally.
- **OPTIONAL** — `dsh.compatibility.dsh`, `engines`, `peerDependencies` (peer versions are NOT
  installed; the host resolves `@deepseek-ai/*` itself — see §4), `files`, `description`, `version`.
- `dshhub` is **not** needed for local install/load. It is the marketplace/hub display metadata.
  Shape used by the real plugin (`dsh-spend-wallpaper/package.json`, verbatim):

```jsonc
"dshhub": {
  "schemaVersion": 1,
  "displayName": "余额壁纸",
  "summary": "…",
  "categories": ["Web UI", "观测", "娱乐"],
  "surfaces": ["host", "web"],
  "permissions": { "network": ["https://api.deepseek.com"] }
}
```

- For comparison, the real plugin's `dsh` block is identical in shape, plus a `bin` CLI
  (`"bin": { "dsh-spend-wallpaper": "./bin/dsh-spend-wallpaper.mjs" }`) which is optional.

### 1.2 `cordis.patch.yml` — a single insert row (verbatim, worked)

```yaml
- insert:
    - id: sideask-probe
      name: dsh-sideask-probe
```

`id` is the **row id** (loader id / `ctx` entry id); `name` is the **package name** resolved from
the profile's `node_modules`. Both may differ; this is the #1 naming gotcha (§5).
The real plugin uses `id: spend-wallpaper, name: dsh-spend-wallpaper` — same pattern.

### 1.3 `lib/index.js` — host half, verbatim probe (loaded, `apply` ran, Config projected)

```js
import z from '@deepseek-ai/schemastery'

export const name = 'sideask-probe'

export const Config = z.object({
  greeting: z.string().default('hello from sideask-probe'),
  enabled: z.boolean().default(true).volatile(),
})

function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && value.length === undefined) {
    try { return value.get() } catch { return undefined }
  }
  return value
}

export function apply(ctx, config) {
  console.log(
    `[sideask-probe] apply greeting=${JSON.stringify(unwrap(config?.greeting))} enabled=${unwrap(config?.enabled)}`,
  )
  ctx.effect(() => {
    console.log('[sideask-probe] effect start')
    return () => console.log('[sideask-probe] effect dispose')
  }, 'sideask-probe: probe effect')
}
```

Observed stdout on boot:

```
[sideask-probe] apply greeting="hello from sideask-probe" enabled=true
[sideask-probe] effect start
dsh web: http://127.0.0.1:50183/?token=…
```

- **REQUIRED**: an ESM module that exports `apply(ctx, config)` (a named function). `export const
  name` is conventional and is used in loader diagnostics; keep it.
- **REQUIRED**: cleanup via `ctx.effect(fn, label)` returning a disposer — this is what HMR/unload
  calls. Do not leave timers/sockets un-disposed.
- **OPTIONAL but recommended**: `export const Config = z.object({...})`. Proved optional in two
  ways: (a) the first probe version had no `Config` and still loaded + `apply` ran; (b) with
  `Config`, `--dump-config-schema` changes `status` from `absent` to `schema` and projects defaults
  (see §2). Without `Config` the row still validates as `absent`/`unknownConfig` — that is normal
  (official `ui-*` client rows are `absent` too).
- **VOLATILE FIELDS ARE REFS**: `z.*().volatile()` fields arrive at runtime as `{ get() }`, not as
  values. `dsh-spend-wallpaper/lib/index.js:232` unwraps exactly like the `unwrap()` above on every
  read. A non-volatile field is a plain value (`greeting` above logged directly).
- Services/HTTP: register via `ctx.inject(['webServer'], (child) => { child.effect(...) })` and
  `ctx.webServer.register({ kind: 'exact'|'prefix', path, resource|handler })` — verbatim pattern in
  `dsh-spend-wallpaper/lib/http.js:144-155` (routes under `/plugins/<package-name>/…`).

### 1.4 `lib/client.js` — ModuleLoader bundle wrapper, verbatim probe (served byte-for-byte, HTTP 200)

```js
window.__ModuleLoader__.load({
  id: 'dsh-sideask-probe',
  factory: (require) => {
    return {
      name: 'sideask-probe-client',
      inject: [],
      apply(ctx) {
        const start = () => {
          const el = document.createElement('div')
          el.id = 'sideask-probe'
          el.textContent = 'sideask-probe client loaded'
          document.body.appendChild(el)
          return () => el.remove()
        }
        if (typeof ctx.effect === 'function') ctx.effect(start, 'sideask-probe: probe layer')
        else start()
      },
    }
  },
})
```

Served body observed on the wire (`GET /plugins/??dsh-sideask-probe/client.js&rev=…` → 200):

```js
window.__ModuleLoader__.load({
  id: 'sideask-probe',
  factory: (require) => { … })
})
;
//# sourceMappingURL=??dsh-sideask-probe/client.js.map&rev=0fea6d2f192e
```

The host appends `\n;\n//# sourceMappingURL=…`; the file itself must stay self-contained.

- **REQUIRED**: `window.__ModuleLoader__.load({ id, factory })`; `id` must equal the **package
  name** used by the boot graph (see §5), `factory` is `(require) => exports`.
- **REQUIRED exports of the factory**: `{ name, apply(ctx) }`. `inject: []` is optional but
  conventional (dependency ids the client row needs materialized first).
- Cleanup: return a disposer from `ctx.effect` (probe) — the real plugin's `apply` wraps `install(ctx)`
  the same way (`dsh-spend-wallpaper/lib/client.js`, tail).
- Real plugin's shape, verbatim:

```js
window.__ModuleLoader__.load({
  id: 'dsh-spend-wallpaper',
  factory: (require) => { 'use strict'; … return exports },
})
```

---

## 2. Proven install → launch → verify loop

All below ran against a throwaway home; the real `desktop`/`web` profiles under
`C:\Users\32602\.dsh` were never touched.

### 2.1 Exact commands (PowerShell)

```powershell
# 0. throwaway home + CLI wrapper
$dsh  = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = 'E:\workspace\_probe\dshhome'
$env:ELECTRON_RUN_AS_NODE = 1

# 1. initialize the profile AND install the plugin by local path, in one step.
#    `dsh plugin --profile <p>` forwards every remaining arg to pnpm inside the profile.
& $dsh plugin --profile web add link:E:/workspace/_probe/sideask-probe/min-plugin

# 2. prove the host row is in the composed tree
& $dsh --profile web --dump-config          # row printed under "# == dsh-sideask-probe"
& $dsh --profile web --dump-config-schema   # row status "schema", configRef "#/$defs/configNN"

# 3. launch on an OS-picked free port, no browser
& $dsh --profile web --port 0 --no-open     # prints "dsh web: http://127.0.0.1:<port>/?token=…"
```

Observed outputs (excerpts):

```
dsh: initialized profile web at E:\workspace\_probe\dshhome\profiles\web
[WARN] The store at C:\Users\32602\AppData\Local\pnpm\store\v11 is not used because packages cannot be hard linked from this project. Using the store at E:\.pnpm-store\v11 instead.
Already up to date
dependencies:
+ dsh-sideask-probe 0.0.1 <- ..\..\..\sideask-probe\min-plugin
Done in 405ms using pnpm v11.28.5
```

`dsh --profile web --dump-config` end:

```
# == dsh-sideask-probe
- id: sideask-probe
  name: dsh-sideask-probe
```

With a profile override it is annotated with the layer that changed it:

```
# == dsh-sideask-probe, patched by E:\workspace\_probe\dshhome\profiles\web\cordis.patch.yml
- id: sideask-probe
  name: dsh-sideask-probe
  config:
    greeting: from-profile-patch
```

`--dump-config-schema` (probe row) — `status : "schema"`, `configRef : "#/$defs/config102"`, and the
projected definition contains `"greeting": { "default": "hello from sideask-probe" }` and
`"enabled": { "x-cordis": { "volatile": true } }`.

**Important**: `--dump-config-schema` exited with **code 1** in this profile, with four *pre-existing*
errors unrelated to the plugin:

```
dsh: error: [/192] unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection
dsh: error: [/193] …
dsh: error: [/194] …
dsh: error: [/195] …
```

Those rows are `preset-standard/ptc/minimal/cordis` in the shipped `web` profile. Judge by the
printed row, not the exit code.

### 2.2 Confirm the client bundle is actually served (this exact check returned 200)

The bare `/plugins/<package>/client.js` path is **404**. The real URL is the *advertised combo URL*
that dsh-client-modules writes into the page HTML. Verified full loop, in one PowerShell command:

```powershell
$env:DSH_HOME='E:\workspace\_probe\dshhome'; $env:ELECTRON_RUN_AS_NODE=1
$out='E:\workspace\_probe\run.out'; $err='E:\workspace\_probe\run.err'
$p = Start-Process -FilePath 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' `
     -ArgumentList '--profile','web','--port','0','--no-open' `
     -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
$url=$null
for ($i=0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $m = Select-String -Path $out -Pattern 'dsh web: (http://\S+)' | Select-Object -First 1
  if ($m) { $url = $m.Matches[0].Groups[1].Value; break }
}
$base = ($url -replace '/\?.*$','')
$r = Invoke-WebRequest -Uri $url -UseBasicParsing            # page needs the ?token=
$combo = [regex]::Matches($r.Content,'plugins/\?\?[^"''\s<>]*dsh-sideask-probe[^"''\s<>]*') |
         ForEach-Object { $_.Value.Replace('&amp;','&') } | Select-Object -Unique
foreach ($c in $combo) { (Invoke-WebRequest -Uri "$base/$c" -UseBasicParsing).StatusCode }
taskkill /T /F /PID $p.Id                                    # clean shutdown of cmd + electron child
```

Observed:

```
PID=9440 URL=http://127.0.0.1:50183/?token=8obT_COqhbGgbPxEK8fU3IAfBDZY7_3VlP6QTeUjdz0
index status=200 len=40244
probe combo URLs: 2
GET http://127.0.0.1:50183/plugins/??…,dsh-sideask-probe/client.js,…&rev=dcfc6f8f07aa -> 200 ct=text/javascript; charset=utf-8 len=2576909
GET http://127.0.0.1:50183/plugins/??dsh-sideask-probe/client.js&rev=0fea6d2f192e -> 200 ct=text/javascript; charset=utf-8 len=639
body head: window.__ModuleLoader__.load({
```

Notes:

- The page URL always carries `?token=…`; without it `/` answers **401**. `/plugins/…` needs **no**
  token/cookie (verified 200 without a session).
- Our row appeared both inside a big application combo and as its own one-resource combo
  (`plugins/??dsh-sideask-probe/client.js&rev=<rev>`). Both 200. The URL in the HTML is
  document-relative (`plugins/...`), so prefix `http://host:port/`.
- `&rev=<12 hex>` is required. Requests observed:
  - `/plugins/??dsh-sideask-probe/client.js` → **404**
  - `…&rev=deadbeef0000` (wrong rev) → **404**
  - `/plugins/??dsh-sideask-probe/client.js.map&rev=<rev>` → **200**, `application/json`, 881 bytes
    (Indexed Source Map v3 whose `sourcesContent` holds the bundle)
  - `/plugins/dsh-sideask-probe/client.js?rev=<rev>` → **404** (the "obvious" URL does not exist)
- `rev` is derived from the client file's `mtimeMs`/`ctimeMs`/`size` (source:
  `dsh-client-modules/lib/index.js` `artifactRevision()`), so any rebuild changes it and HMR
  reloads that row.
- Shutdown: `taskkill /T /F /PID <dsh.cmd pid>` printed `SUCCESS: The process with PID … has been
  terminated.` for both the electron child and the cmd parent. The port was released.

### 2.3 What `dsh plugin … add link:<dir>` actually writes

`<DSH_HOME>\profiles\web\package.json` after install:

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-sideask-probe": "link:E:/workspace/_probe/sideask-probe/min-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-sideask-probe"]
    }
  }
}
```

- The profile is **auto-initialized on first use** (`dsh plugin`) from a shipped template. Profile
  names `web|headless|acp|sdk|sdk-minimal` get templates; a custom name gets
  `["@deepseek-ai/dsh-base"]` only. **Name the throwaway profile `web`** (inside the throwaway
  `$DSH_HOME`) or you get a base-only tree with no web server. Verified: `sideask-dev` got
  `["@deepseek-ai/dsh-base", "dsh-sideask-probe"]`; `web` got base + `@deepseek-ai/dsh-web-app`.
- `link:` produces a **directory junction** in the profile:
  `node_modules\dsh-sideask-probe` → `LinkType : Junction`, `Target : E:\workspace\_probe\sideask-probe\min-plugin`.
  Editing the source files is immediately visible to the next boot (no copy step).
- `dsh plugin --profile web remove dsh-sideask-probe` removes the dependency **and** the
  `dsh.profile.bundles` entry (observed), but left the `node_modules\dsh-sideask-probe` junction in
  place (stale link; harmless, reconciled on the next install).

### 2.4 Profile patch (`cordis.patch.yml`) gotcha

The generated profile patch starts as the YAML document `[]`. Appending `- id: …` after it is a
parse error:

```
Error: dsh: failed to parse overlay …\profiles\web\cordis.patch.yml: YAMLException: end of the stream or a document separator is expected (6:1)
```

**Fix**: replace `[]` with the list (as done for the config-override test in §2.1). The real
`desktop` profile's `cordis.patch.yml` is a plain list for the same reason.

---

## 3. Logs and reading a load failure

### 3.1 Runtime load failure → server stderr (this is the one that matters)

Deliberately broke the host half with `throw new Error('probe-load-failure: …')` at module top level,
relaunched with `--port 0 --no-open`. The server **kept running** and printed:

```
dsh web: http://127.0.0.1:58292/?token=246CVlxz5d4DwUTtxpZXtnqn72DQc01FrwI0mg-0x5Y
[stderr]
dsh: warning: 1 entry did not activate
sideask-probe (dsh-sideask-probe): failed to import: Error: probe-load-failure: deliberate import-time throw
    at file:///E:/workspace/_probe/sideask-probe/min-plugin/lib/index.js:3:7
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
    at async file:///D:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:342:41
    …
    at async Promise.all (index 196)
```

Format: `<row id> (<package name>): failed to import: Error: <message>` + a real stack, preceded by
`dsh: warning: N entry did not activate`.

**Capture it on Windows**: stderr through `2>&1` arrives as PowerShell `NativeCommandError` records;
`Start-Process -RedirectStandardError <file>` is the clean way to keep it readable.

Secondary symptom: with the host row failed, **the client bundle disappears from the page** — the same
index fetch showed `sideask refs: 0` (vs. present when the host row loaded). So "bundle missing from
`/plugins`" can mean "host half failed to import", not "client file missing".

### 3.2 Where logs live

- **Runtime** (plugin load/apply errors, `console.log` from `apply`): the dsh process's **stdout/
  stderr**. There is no per-plugin log file. Redirect it yourself when scripting
  (`-RedirectStandardOutput/-RedirectStandardError`).
- **Package operations**: `<DSH_HOME>\profiles\<profile>\.plugin-manager\logs\operation-<id>\pnpm.log`.
  - For CLI-driven `dsh plugin …` runs this file was created but **0 bytes**; the pnpm output went to
    the CLI's stdout.
  - GUI/plugin-manager-driven installs do fill it. Real example from the desktop profile
    (`…\desktop\.plugin-manager\logs\operation-jttBkg\pnpm.log`):

    ```
    Progress: resolved 3, reused 0, downloaded 3, added 3, done
    dependencies:
    + dsh-cost-meter 1.9.46
    Done in 2.4s using pnpm v11.28.5
    ```
- **Plugin state/config**: `<DSH_HOME>\storages\…` (plugins choose their own file; e.g.
  `$DSH_HOME/storages/spend-wallpaper/state.json`), and the profile's `cordis.patch.yml` /
  `package.json` for composition.
- Throwaway home created on first boot: `profiles/`, `storages/workspace.json`,
  `.anonymous-user-id`, `.credentials.yaml`.

### 3.3 Fast checks that don't need a browser

```powershell
node --check lib/client.js          # exit 0 for the probe and for dsh-spend-wallpaper's 42 KiB bundle
dsh --profile web --dump-config     # row present? config merged? (layer annotation)
dsh --profile web --dump-config-schema
```

`node --check` validates the bundle's syntax only (it is a browser script referencing
`window`/`document`; don't `node lib/client.js`).

---

## 4. Build/dev-loop constraints

**A bundler is not required.** `lib/client.js` is a hand-authored, self-contained classic script.

- **Module format**: the file is a plain browser `<script>` body (served as
  `content-type: text/javascript; charset=utf-8`, cache
  `public, max-age=31536000, immutable`). No `import`/`export` — it only calls
  `window.__ModuleLoader__.load({...})`. The `factory(require)` is CJS-factory form: it must
  *return* the exports object; there is no ESM `export` inside a bundle.
  Host half is real **ESM** (`type: "module"`, `import`/`export`, loaded via `import()` by
  `cordis-plugin-loader`). Do not mix: `require()` at host top level is not available.
- **How it is served**: not at `/plugins/<pkg>/client.js`. The host publishes each bundle in the
  page's boot graph as a *combo* resource:
  `GET /plugins/??<pkg>/client.js&rev=<12-hex>` (one row may be folded into a bigger app combo).
  Only advertised URLs with the right `rev` answer 200; anything else is 404 (evidenced in §2.2).
  The package-asset route for `dsh.client` assets is `/plugins/<pkg>/assets/<path>` (documented in
  `dsh-client-modules/README.md`; not exercised here — no assets in the probe).
- **`require(...)` inside the factory does NOT get Node modules.** It resolves only against the
  frozen platform seed table, already-materialized bundles, boot-graph rows, and registered
  factories. Exact seed table (read from the built shell
  `@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js`, `function YZ()`):

  ```
  react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod,
  @tanstack/react-virtual, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
  @deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
  ```

  Any other sync request throws (exact runtime message from `dsh-client-modules/lib/client.js`):

  ```
  client-modules: require("<spec>") missed the module table — not a platform seed word, not a
  materialized module, and no registered package factory (a build-time externals drift, or a
  dynamic dependency that did not arrive)
  ```

  Cross-plugin requests are declared as `dsh.client.external: ["@deepseek-ai/<pkg>/client"]`
  (six official packages do this) and are async-loaded through the graph. **For a self-contained
  plugin: use no `require` at all** — the probe and `dsh-spend-wallpaper` both do exactly that.
- **Size**: no hard cap was found in the client-modules code. Constraints that do exist: a combo
  URL is partitioned before it exceeds 3 KiB, and the host serves chunk revisions by metadata.
  `dsh-spend-wallpaper/scripts/build-client.mjs` only *validates* the wrapper and enforces its own
  author-chosen 512 KiB cap — it is a project convention, not a host limit. Probe bundle: 639 bytes.
- **Rebuild semantics**: the served `rev` comes from `mtimeMs`/`ctimeMs`/`size` of `exports["./client"]`,
  captured at boot; HMR (`dsh-hmr`, enabled in base) swaps a changed row. With `--port 0` one-off
  runs, editing `lib/client.js` and relaunching is enough.
- **Verification recipe** (no browser): boot, fetch the page, regex out
  `plugins/\?\?[^"']*<pkg>[^"']*`, replace `&amp;`→`&`, GET it, assert 200 + body contains
  `window.__ModuleLoader__.load(`. That is exactly the §2.2 script.
- **Validated client-bundle wrapper test**: spend-wallpaper runs `test/client.test.mjs` with
  `node --test` (its `scripts/build-client.mjs` greps for `id`, `factory:`, `name:`, `apply:`).
  Copying that regex check into `dsh-sideask/scripts/check.mjs` gives a zero-dep client guard.

---

## 5. Pitfalls (each observed or read from the shipping code)

1. **Package name vs row id vs loader id — three different strings.**
   - package name `dsh-sideask-probe` — resolved from the profile's `node_modules`; the `name` in
     `cordis.patch.yml`; the `id` in the **client** bundle; the URL segment in `/plugins/…`; the
     directory name under the profile's `node_modules`.
   - row id `sideask-probe` — the `id` in `cordis.patch.yml` and the id in `- id: <row>` config
     overrides. `dsh-spend-wallpaper` uses row id `spend-wallpaper` + package `dsh-spend-wallpaper`.
   - client `exports.name` (`'sideask-probe-client'`) is just a label.
   Mixing them is the most likely cause of "installed but nothing loads": the client bundle `id`
   MUST be the package name; the patch `name` MUST be the package name; the patch `id` is what
   config overrides target.
2. **`manifestVersion: 1`** — required key of `package.json#dsh`. Same value in the real plugin.
3. **dsh compatibility** — the real plugin declares `>=0.2.0-rc.1 <0.3.0-0`; installed dsh is
   `0.2.2-rc.1`. `engines.dsh` is checked by the plugin manager for updates; keep it aligned with
   `dsh.compatibility.dsh`. (Probe with that range installed/booted fine.)
4. **Windows paths / quoting**
   - Use `link:E:/workspace/...` with forward slashes; the profile records it verbatim and it worked.
   - The CLI is `dsh.cmd`, so `& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' …` with
     `$env:ELECTRON_RUN_AS_NODE=1` set in the same process; without it the Electron binary tries to
     start as a GUI app.
   - stderr merges into PowerShell as `NativeCommandError`; capture with redirection when you care.
   - Always force-kill with `taskkill /T /F /PID` (kills the electron child), not `Stop-Process`.
5. **`link:` install semantics**
   - Creates a junction → **code edits are live at next boot**; no reinstall needed for source
     changes. `package.json` (`dsh.*`, `exports`) changes DO need a re-add/boot re-read; the
     installed profile dependency string stays `link:E:/…`.
   - pnpm warns, verbatim: *"The package dsh-sideask-probe, which you have just pnpm linked, has the
     following peerDependencies … The linked in dependency will not resolve the peer dependencies
     from the target node_modules. This might cause issues in your project."* In practice it is
     fine: the host supplies `@deepseek-ai/schemastery` (proved by the importing probe), and
     `dsh-spend-wallpaper` ships with the same peerDependencies.
   - The installed bundle directory is `node_modules/<package>` but pnpm's store/virtual store lives
     beside it; a missing `node_modules` in the plugin repo is fine (host resolves SDK packages).
6. **Offline behavior** — `dsh plugin … add link:<abs path>` completed with no registry traffic:
   `Already up to date`, `Done in 405ms/457ms using pnpm v11.28.5`, plus a cached
   `✓ Lockfile passes supply-chain policies (verified 3m ago)`. Network is needed for **registry
   specs** (`add dsh-cost-meter` resolved/downloaded 3 packages) and pnpm may warn about updates.
   So a `link:` dev loop works offline; installing by name does not necessarily.
7. **Custom profile names get a base-only tree.** `web|headless|acp|sdk|sdk-minimal` are the shipped
   templates (`PROFILE_TEMPLATES` in `@deepseek-ai/dsh-official-bundles`); anything else starts from
   `["@deepseek-ai/dsh-base"]` — no Web app, no client bundle serving. Use the throwaway home +
   profile named `web` for web-plugin testing.
8. **`dsh web --help` flags that matter** (observed): `--port <port>` (`0` = OS-picked free port),
   `--no-open`, `--host`, `--public-url`, `--trusted-host`, `--tls-cert/--tls-key`. Run them through
   `dsh --profile web …` (the help header says `dsh --profile web`).
9. **`dsh web --help` vs `dsh --help`** — `dsh --help` shows launcher flags (`--profile`,
   `--patch`, `--dump-config`, `--dump-config-schema`, `--from-default-profile`); app flags only
   appear after `--profile web`.
10. **Never test in the real profiles.** The running GUI serves `http://127.0.0.1:61865` from the
    `desktop` profile; installing/removing there while it runs impacts the user's live app. Use
    `$env:DSH_HOME` + a new profile name (all of §2 ran that way) and kill the test server with
    `taskkill /T /F`.

---

## 6. Copy-paste dev loop for dsh-sideask

```powershell
$dsh = 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = 'E:\workspace\_probe\dshhome'   # once per shell
$env:ELECTRON_RUN_AS_NODE = 1

# install/refresh the local package into a throwaway web profile
& $dsh plugin --profile web add link:E:/workspace/dsh-sideask

# static checks
& 'D:\deepseek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' --check E:\workspace\dsh-sideask\lib\client.js
& $dsh --profile web --dump-config | Select-String 'sideask'

# boot + verify bundle + shutdown (full script in §2.2)
```

Prereq for the client bundle: `package.json` must expose `"./client": "./lib/client.js"` and
`dsh.client.platform === "web"`; the host row must import cleanly, otherwise the bundle never enters
the boot graph (§3.1).

Not verified in this session (don't rely on it without checking): package-asset route
`/plugins/<pkg>/assets/<path>`, per-row chunk URLs `client.<name>.js?rev=`, and Desktop (Electron
`file://`) `/plugins` fetch bridging.
