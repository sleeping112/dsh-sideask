# Publishing / listing checklist

This is the playbook for listing **dsh-sideask** in
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
It is written for this repository; the authoritative source is their
[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
— if the two disagree, theirs wins.

## 0. Prerequisites (all verified by this repo)

| Rule | Status |
|---|---|
| `package.json` declares `dsh.bundle.patch` → `./cordis.patch.yml` | ✅ present |
| `cordis.patch.yml` inserts `id: sideask`, `name: dsh-sideask` | ✅ verified by `node scripts/preflight.mjs` |
| Real, working code (not a placeholder or a meta-package) | ✅ host + browser halves, 241 tests |
| Repository at least 1 day old | ✅ created 2026-11-18 |
| `dsh-plugin` topic added to the repository | ✅ added (see below) |
| Description states facts only, no marketing | ✅ see the entry below |
| Category matches what it does | `ui` (a floating chat window inside the web UI) |
| Up to 3 entries per PR | 1 entry here |
| CI passes on `master` | ✅ install uses pnpm 11 `allowBuilds` (see `pnpm-workspace.yaml`) |

## 1. The `dsh-plugin` topic

Already added on 2026-11-23 (GitHub topics API). If it ever goes missing, re-add
it in GitHub → **About** (gear icon) → **Topics**; there is no git command for
topics.

Suggested About description:

> A floating side-conversation window for DeepSeek Harness: read-only context,
> cited answers in its own thread, explicit write-back to the main composer.

## 2. Cut a release (optional, recommended)

A prebuilt tarball lets storefronts skip source builds and the `allowBuilds`
approval step. Push the version tag; the `release` workflow builds, runs the
delivery gate and attaches `dsh-sideask.tgz`:

```sh
git tag -a v0.6.1 -m "dsh-sideask v0.6.1"
git push origin v0.6.1
```

The asset name is intentionally version-free, so this URL never rots:

```
https://github.com/sleeping112/dsh-sideask/releases/latest/download/dsh-sideask.tgz
```

## 3. The entry (the whole submission is one file)

Fork `awesome-dsh-plugin/awesome-dsh-plugin`, then add **one new file**:

`data/plugins/sleeping112__dsh-sideask.yml`

```yaml
url: https://github.com/sleeping112/dsh-sideask
name: sleeping112/dsh-sideask
category: ui
description:
  en: 'Adds a floating side-chat window that reads the current conversation read-only, answers with citations in its own thread, and writes back to the main composer only when the user clicks a write-back action.'
  zh: '在当前对话旁提供悬浮轻对话窗口：只读当前上下文提问、在独立线程中带引用回答，只在用户点击写回按钮时才写入主对话输入框。'
icon: https://raw.githubusercontent.com/sleeping112/dsh-sideask/master/assets/icon-180.png
tarball: https://github.com/sleeping112/dsh-sideask/releases/latest/download/dsh-sideask.tgz
```

Notes:

- The English description contains `: ` only if you add one — if so, **quote it**
  (as above) or YAML reads a nested key.
- Delete the `tarball:` line if you do not cut a release.
- Do **not** hand-edit either generated README; that is explicitly rejected.
- A PR may add at most 3 entries; this one adds one.

## 4. Open the PR

Title: `Add sleeping112/dsh-sideask (ui)`

Body:

```
Adds a floating side-chat window for DeepSeek Harness.

- Repository: https://github.com/sleeping112/dsh-sideask
- Manifest: dsh.bundle + cordis.patch.yml (installable via `dsh plugin add`)
- Category: ui — a floating chat window inside the web UI
- Icon + screenshots are declared in the repository (screenshots.json)
- Prebuilt tarball attached to the v0.6.1 release (version-free asset name)
- 241 tests; CI green on master
```

Only that one file belongs in the diff. CI checks, in order: entry count,
`dsh.bundle`, repo age (1 day), `awesome-lint` / site build.

## 5. What the maintainer review checks

- The code does what the description says (no inflated numbers or APIs that do
  not exist). Keep the description literal.
- Category is reasonable (`ui` here; a maintainer may re-file it without
  bouncing the PR).
- Real code, no obfuscation, no credential exfiltration, no surprising
  install-time behaviour.
- Not already covered by an existing entry.
- The PR does not touch other entries.

If changes are requested, the PR gets the `held: author` label. Push the fix to
the same branch and leave **one** comment describing it; the label is retired by
a re-review, not automatically.

## 6. Updating the listing later

Edit your own `data/plugins/sleeping112__dsh-sideask.yml` (usually only the
description/icon, version is not stored there) and regenerate the READMEs if you
wanted a preview; never edit another plugin's entry.

## 7. Before every submission, run

```sh
node scripts/build.mjs
node scripts/check.mjs
node scripts/preflight.mjs
node --test
```

`preflight` verifies: manifest shape, `cordis.patch.yml` consistency, built
artifacts, package `files[]`, screenshot declarations, icon, license, metadata
and README install instructions — the same mechanical ground the listing CI
checks.
