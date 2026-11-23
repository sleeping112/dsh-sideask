# Security policy

## Supported versions

| Version | Supported |
|---|---|
| `0.6.x` (current) | ✅ |
| older tags | ❌ — upgrade to the latest release |

The plugin is a **DeepSeek Harness** plugin. Vulnerabilities in the harness itself
should be reported to the DSH project, not here.

## What this plugin can access

Being precise here matters more than promising perfection:

| Capability | Details |
|---|---|
| Read the current conversation | The browser half reads the **visible messages** of the bound session through the host's read-only event snapshot. It does not read hidden reasoning traces, unrendered content, attachments, or any other session. |
| Read the current selection | Only text the user has explicitly selected in the main chat. |
| Call a model | Through the host's `ctx.llm.stream(...)`, using your existing account/model configuration. The plugin has no network code of its own and no API keys. |
| Local storage | Side threads: `$DSH_HOME/storages/sideask/threads.json`. Browser `localStorage`: window geometry (`dsh-sideask.window.v2`), drafts (`dsh-sideask.draft.v2`), summary cache (`dsh-sideask.summary.v1`), model preference (`dsh-sideask.model.v1`). |
| HTTP routes | A small local HTTP surface under `/plugins/dsh-sideask/api`, served by the same-origin dsh web server. Every route first applies DSH's `connection.requestRejection` fence (Host/Origin + browser authentication), then the plugin's own same-origin guard. |
| Tools / files / shell | **None.** The plugin does not execute tools, does not read files, and does not spawn processes. |
| Write to the main conversation | Only through explicit user actions: copy, quote, insert as draft, hand off as a task. Nothing is sent automatically. |

## Secret redaction

Before context leaves the browser, the plugin masks common secrets (email, phone,
IP, cards, API keys, JWT, bearer tokens, PEM blocks, home paths, usernames and
user-configured patterns). The host re-validates and redacts again. This is
**best-effort**: no regex set catches every secret. If you are working with
credentials, turn context reading off (`readContext: false`) or exclude the
draft before sending.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**:

<https://github.com/sleeping112/dsh-sideask/security/advisories/new>

Include the plugin version, DSH version, operating system, reproduction steps,
impact, and any suggested fix. Do **not** open a public issue for an
exploitable problem, and do not include real credentials or private
conversation content in the report — redact them.

You can expect an acknowledgement within a few days. Fixes are released as a new
patch version with a `CHANGELOG.md` entry; security-relevant changes are called
out explicitly.

## Scope

In scope: the plugin's host half (`src/host`), browser bundle (`src/client`),
shared logic (`src/shared`), build scripts, and the published package contents.

Out of scope: the DSH application/harness itself, model providers, and
third-party plugins you have installed. Reports about the plugin's *model
answers* (for example hallucinated content) are not security vulnerabilities —
open a regular issue instead.
