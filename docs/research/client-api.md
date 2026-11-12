# dsh Web-Client Plugin API — research for a floating "side ask" assistant

Product: dsh **0.2.2-rc.1**. All evidence is from read-only extracted SDK at
`E:\workspace\_probe\asar-out\dsh\node_modules\@deepseek-ai\` (abbreviated below as `<pkg>/...`)
and from the two real installed third-party plugins
(`C:\Users\32602\.dsh\profiles\desktop\node_modules\dsh-cost-meter`, `E:\workspace\dsh-spend-wallpaper`).
Nothing below is invented: every row has a file:line and a verbatim excerpt. Unproven items are marked **ASSUMED**.

Legend: `<pkg>` = `...\node_modules\@deepseek-ai\<pkg>`.

---

## 1. Module-loader contract (how a client bundle is written and loaded)

### 1.1 Exact bundle shape

Every shipped bundle is a tiny wrapper around a CJS factory. Verbatim, `@deepseek-ai/dsh-message-quotes/lib/client.js:1-9`:

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-message-quotes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
```

Same wrapper in the real third-party plugin, `dsh-cost-meter/lib/client.js:2`:

```js
window.__ModuleLoader__.load({id:"dsh-cost-meter",factory:Ne=>{var Ma={exports:{}},jt=Ma.exports;Object.defineProperty(jt,Symbol.toStringTag,{value:"Module"});const Ae=Ne("react"),...
```

- `id` **must be the package name** the host resolves for that entry; the loader fails loudly otherwise: `dsh-client-modules/lib/client.js:760` → `loaded without registering "${id}" via __ModuleLoader__.load`, and again `:877`.
- Executing the bundle only **registers** the factory. Side effects (CSS injection, listeners) run at first materialization: `dsh-client-modules/lib/client.js:16-19` — *"executing a plugin bundle only REGISTERS its factory (`window.__ModuleLoader__.load({id, factory})`); every module body side effect — including CSS injection — lives inside the factory closure and runs at materialization"*.

### 1.2 Plugin object shape returned by the factory

The factory returns `module.exports` with cordis plugin fields. `dsh-message-quotes/lib/client.js:193-196`:

```js
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports;
```

`dsh-client-ui-session/lib/client.js:1150-1153` is the same (`exports.UiSession`, `exports.apply`, `exports.inject`). `inject` is the cordis dependency list, e.g. `dsh-message-quotes/lib/client.js:148-153`:

```js
const inject = [ "slots", "locale", "sessions", "uiConversation" ];
```

`apply(ctx)` is the entry; everything disposable goes through `ctx.effect(() => disposer, "label")` (e.g. `dsh-message-quotes/lib/client.js:159`, `dsh-client-ui-layout/lib/client.js:782`). Client services are reached as `ctx.<service>` (`ctx.slots`, `ctx.sessions`, `ctx.uiConversation`, `ctx.locale`, `ctx.shortcuts`, `ctx.theme`, `ctx.layout`, `ctx.configForms`, `ctx.conversation`, `ctx.uiSession`) or `ctx.get("sessions")` (`dsh-client-ui-session/lib/client.js:1119` `new UiSession(ctx, ctx.sessions)`; `dsh-client-ui-conversation/lib/client.js:16314` `this.rootCtx.get("sessions")`).

### 1.3 What `require` resolves inside a factory

`require` is a **synchronous CJS resolver over a frozen platform seed table** plus the boot graph; anything else throws. `dsh-client-modules/README.md:77` — *"Resolution checks the platform seed table, memoized records, boot-graph rows, and registered factories in that order; anything else throws."*

The complete seed table, verbatim from the shipped shell `@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196` (function `YZ`):

```js
{react:fk,"react/jsx-runtime":gk,"react-dom":xk,"react-dom/client":Ck,
 "@deepseek-ai/cordis":Rb,zod:JS,"@tanstack/react-virtual":rI,
 "@deepseek-ai/dsh-client-store":SI,"@deepseek-ai/dsh-client-ui-slots":MI,
 "@deepseek-ai/dsh-client-ui-primitives":FU,"@deepseek-ai/dsh-client-ui-dockkit":WZ}
```

So a side-ask bundle may `require("react")`, `require("react-dom")`, `require("react-dom/client")`, `require("@deepseek-ai/cordis")`, `require("@deepseek-ai/dsh-client-ui-primitives")`, `require("@deepseek-ai/dsh-client-ui-slots")`, `require("@deepseek-ai/dsh-client-store")`, `require("@deepseek-ai/dsh-client-ui-dockkit")`, `require("zod")`, `require("@tanstack/react-virtual")` — **no more**. Any other import must either be bundled into `lib/client.js` (cost-meter inlines `acorn`/`zod` usage and its own React components) or declared in `dsh.client.external` (and then it must be supplied by another loaded row).

Two extra require verbs exist:
- `require.async("./client.<name>.js")` — code-split chunk loader (`dsh-client-modules/README.md:77`, real use `dsh-cost-meter/lib/client.js`: `Ne.async("./client."+N+".js")`).
- `require.asset("plugins/<package>/assets/<file>?rev")` — revisioned asset URL (`dsh-client-modules/README.md:39`).

### 1.4 Declaration in package.json (real, loadable example)

`dsh-cost-meter/package.json` (installed, real):

```json
"main": "lib/bootstrap.js",
"exports": { "./client": { "default": "./lib/client.js" }, "./typert": { "default": "./lib/typert.host.js" } },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
```

Rule from `dsh-client-modules/README.md:34`: *"A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline module requests under `dsh.client.external`."* Served at `/plugins`; `<id>/client` and the bare id resolve to the same exports (`README.md:43`).

---

## 2. Reading the current conversation (transcript + incremental updates)

### 2.1 The client session object model

`ctx.sessions` is the Client Session Controller. It is provided at the client root:
`@deepseek-ai/dsh-api-session-controller/lib/client.js:3856`

```js
rootCtx.reflect.provide("sessions", this, void 0);
```

`retain()` opens/normalizes a session and returns a reference whose `.ready` resolves to the **binding**; `binding(id)` borrows an already-retained one (`dsh-api-session-controller/lib/client.js:4072-4074`):

```js
binding(id) { return this.scopes.get(id)?.binding; }
```

The binding's exact shape is created at `dsh-api-session-controller/lib/client.js:4145-4150`:

```js
binding: { sessionId: id, session, eventSource: session.eventSource, ctx },
```

`eventSource` is a `MutableSessionEventSource` with `getSnapshot()`/`subscribe()` (`dsh-api-session-controller/lib/client.js:1741-1762`):

```js
var MutableSessionEventSource = class {
	listeners = new Set(); window = leaf([]);
	getSnapshot() { return this.snapshot; }            // { entries, hasMore, revision, change }
	subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
```

`getSnapshot().entries` is the loaded contiguous event window; `change.kind` is one of `replace | prepend | append | settle-assistant` (`dsh-api-session-controller/lib/client.js:1730-1738`, `:1768-1798`; the published change set is stated in `dsh-api-session-controller/README.md:58`).

### 2.2 Message/event shape

Each entry is `{ event: { type, data, seq, time }, ... }`. Chat's own user-message Definition reads it as follows (`@deepseek-ai/dsh-client-ui-chat/lib/client.js:11955-11992`, excerpts):

```js
if (event.type === "user/message") return isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event) ? { id: String(event.data.id), role: "start" } : null;
...
content: event.data.content, source: event.data.source
```

Assistant messages: `event.data.message.content` and role/content blocks (`dsh-client-ui-chat/lib/client.js:10096`, `:12012`, `:10122`):

```js
const blocks = toAssistantBlocks(event.data.message.content);
...
id: String(event.data.message.id),
```

Text extraction is `block.type === "text" ? block.text` (`dsh-client-ui-chat/lib/client.js:10412`, `:11644`, `:12757`). Roles are encoded by event type, not by a `role` field: `user/message`, `assistant/message`, `developer/message`, plus structural `turn/start`, `step/start` (`dsh-api-session-controller/lib/client.js:144,196,207-208,235`; conversation Definition list `dsh-client-ui-chat/lib/client.js:11951`).

**Practical read recipe (all pieces VERIFIED, composition ASSUMED):**

```js
const ref = ctx.sessions.retain(sessionId, { source: "side-ask", signal }); // :3858
const binding = await ref.ready;                       // :3761-3790 readiness promise
const feed = binding.eventSource;                       // :4148
let entries = feed.getSnapshot().entries;               // :1749
const off = feed.subscribe(() => { entries = feed.getSnapshot().entries; /* incremental */ });
// ... ref.release() when done (:3791)
```

For message text only: `entry.event.type === "user/message"` → join `entry.event.data.content.filter(b => b.type === "text").map(b => b.text)`; `entry.event.type === "assistant/message"` → `entry.event.data.message.content` same way.

The alternative, higher-level path is `ctx.uiConversation.binding(bindingOrId).target("chat")` which returns a `{getSnapshot, subscribe}` source of **assembled visible nodes** (`dsh-client-ui-conversation/lib/client.js:3989-4004`) — richer but it materializes only registered View targets and needs `slots`/View wiring; the raw `eventSource` is the simpler, decisive read.

---

## 3. Selection, composer insertion, clipboard

### 3.1 Selection (VERIFIED — this is the sanctioned plugin hook)

`ctx.uiConversation.interactions` owns plugin registrations for selected-text gestures: `@deepseek-ai/dsh-client-ui-conversation/README.md:66`:

> `UiConversation.interactions` owns plugin registrations for selected-text and context-menu gestures. A registration supplies a synchronous handler whose ID selects its keyed Slot component; plugins use the Slot injection mechanism for rendering. ... Chat supplies DOM selections and local layout.

Real implementation — official quote plugin, `@deepseek-ai/dsh-message-quotes/lib/client.js:170-180`:

```js
ctx.effect(() => ctx.uiConversation.interactions.register({
	id: "quote",
	onInteraction(request) {
		if (request.trigger !== "selection" || request.readText() === null) return;
		const binding = ctx.sessions.binding(request.sessionId);
		...
		request.open();
	}
}), "message-quotes: selection interaction");
```

The action button itself is a Slot component on `conversation.chat.text-interaction` keyed by the interaction id (`dsh-message-quotes/lib/client.js:181-185`), and its props are the selection API (`dsh-message-quotes/lib/client.js:29-50`):

```js
function QuoteSelectionAction({ dismiss, readText, clearSelection, inputActions, useSession, t }) {
	...
	const text = readText();
	if (text === null) { dismiss(); return; }
	if (!inputActions.insertQuote(text)) return;
	clearSelection(); dismiss();
```

So: **`readText()` = current selection text**, `dismiss()`, `clearSelection()`, and the per-session `inputActions` all arrive as props on the interaction's button slot. This is the exact mechanism our side-ask floating window should reuse (register a second interaction id, render our own button, or call `readText()` from a hotkey-driven capture by mirroring the same Slot props).

### 3.2 Insert into the composer (VERIFIED)

`@deepseek-ai/dsh-client-ui-conversation/README.md:64`:
> `inputActions.insertQuote(text)` inserts a nonblank selection only while the composer is in plain mode.

The action face, `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:15368-15395`:

```js
actions = {
	insertQuote: (text) => this.insertQuote(text),
	captureInsertion: () => ({ ...this.caretSpan(), draftRev: this.rev }),
	insertText: (text, span) => { if (frozen(this.snapshot.phase) || this.disposed) return false;
		if (span.draftRev !== this.rev) return false;
		return this.draftEditor.insertAsyncText(span, text); },
	setDraft: (text) => { this.setDraft(text); },
	persistDraft: () => { this.persistCurrentDraft(); },
	addAttachments: (ids) => this.addAttachments(ids),
	removeAttachment: (id) => ..., pruneAttachments: (ids) => ..., submit: () => { this.submit("queue"); }
};
```

`insertQuote` inserts one quote node **after the retained draft selection** and returns whether it applied (`dsh-client-ui-conversation/lib/client.js:15186-15197`):

```js
insertQuote(text, labels) {
	let applied = false;
	this.applyEdit(() => { ... $replaceDetectSpanWithNodes({ start: at, end: at }, [$createQuoteNode(text, labels), Go(" ")]); }, Co);
	return applied;
}
```

Quotes serialize to ordinary Markdown blockquotes on send: `@deepseek-ai/dsh-message-quotes/README.md:59` — *"The composer sends selected text as ordinary Markdown blockquotes, with one `> ` prefix per line."* (encoding lives in `dsh-message-quotes/src/client/quote-text.ts`, recognized by the rule at `dsh-message-quotes/lib/client.js:94-119`).

**Getting `inputActions` outside a slot component** (needed by a floating window):
1. The scoped `conversation` service is registered as `"conversation"` and exposes `.input` (`dsh-client-ui-conversation/lib/client.js:4717-4720`):
   ```js
   constructor(ctx, config) { super(ctx, "conversation"); this.input = config.input; ... }
   ```
2. `input.for(sessionScopedCtx)` returns the resident per-session shell (`dsh-client-ui-conversation/lib/client.js:16127-16133`), whose `.actions` is the face above:
   ```js
   for(actx) { ... if (binding === void 0 || binding.session !== session) throw new Error("conversation.input.for requires a retained Session scope"); return this.shellFor(binding); }
   ```
3. The standard-prop wiring proves that `.actions` **is** `inputActions` (`dsh-client-ui-conversation/lib/client.js:22775-22790`):
   ```js
   ctx.uiSession.provide({ hooks: ["conversation","input"], props: ["inputActions"],
   	resolve: (binding) => ({ ... props: { inputActions: shell.actions } }) });
   ```

So: `ctx.conversation.input.for(binding.ctx).actions.insertQuote(text)` / `.insertText(text, span)` (pair with `captureInsertion()`), or `.setDraft(text)` for whole-draft replacement. Fallback if `input.for` proves brittle: mount a hidden Slot contribution into `conversation.input.dock` (a session-scoped slot) and use its `inputActions` prop (`dsh-cost-meter` does exactly this with `conversation.input.dock`, `order:5`).

### 3.3 Clipboard (VERIFIED, plain DOM)

The stats view resolves the browser clipboard directly — `@deepseek-ai/dsh-experimental-client-ui-stats/lib/client.js:4441-4442`:

```js
function clipboardOf() { return navigator.clipboard; }
```

and writes with `clipboard.writeText(clipboardValue).then(...)` (`:4424`). The shell itself guards it: `navigator.clipboard?.writeText` inside try/catch (shell bundle `index-BgUyXZcc.js:196`). Copy = `navigator.clipboard.writeText`; no dsh abstraction needed.

---

## 4. Mounting arbitrary DOM (the floating window)

### 4.1 Slot system (VERIFIED)

`ctx.slots` is a registration registry; the shell declares slot kinds at the root, `@deepseek-ai/dsh-client-ui-layout/lib/client.js:705-736`:

```js
ctx.slots.register({
	name: "root", locale: "common",
	children: {
		"sidebar": { kind: "single", scope: "root" },
		"main": { kind: "keyed", scope: "root" },
		"rightbar": { kind: "single", scope: "root" },
		"shell.bottom": { kind: "single", scope: "root" },
		"shell.overlay": { kind: "list", scope: "root" },
		"shell.leading": { kind: "single", scope: "root" }
	}, store, inject: () => ({...}) }, AppFrame);
```

Plugin contributions: `ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`, e.g. `dsh-message-quotes/lib/client.js:186-190`:

```js
ctx.slots.inject("conversation.user.text.node", () => ctx.slots.register({
	name: "conversation.user.text.node", key: "quote", priority: 100 }, QuotedUserText));
```

Observed option names: `name`, `id` or `key`, `order`, `priority`, `label`, `locale`, `inject`, `children` (from `dsh-message-quotes/lib/client.js:181-190`, `dsh-client-ui-settings-models/lib/client.js:5465-5481`, `dsh-cost-meter/lib/client.js`: `O.register({name:"settings.section",id:"cost-meter",order:30,label:...,inject:F}, ...)`).

### 4.2 The overlay layer (decisive for a floating dock)

`shell.overlay` is a **root-scoped list slot** rendered into a dedicated full-frame layer (`@deepseek-ai/dsh-client-ui-layout/lib/client.js:401-405`):

```js
(0, react_jsx_runtime.jsx)("div", {
	className: AppFrame_module_css_default.overlayLayer,
	"data-shell-overlay": true,
	children: overlays
}),
```

and its CSS (`dsh-client-ui-layout/lib/client.js:74`, single css string):

```css
.mP3x-q_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}
.mP3x-q_overlayLayer>*{pointer-events:auto}
```

→ Mounting into `shell.overlay` gives a layer covering the whole AppFrame at `z-index:20`, click-through except on direct children. This is the correct seat for a draggable floating window: render `position:fixed` (or absolute) inside it, portal fixed descendants via `createPortal` when needed (see 4.3).

Alternative official dock: the right column track, `ctx.layout.openRightbar(track, fullscreen)` / `closeRightbar` (`dsh-client-ui-layout/README.md:65`; real use `dsh-client-ui-sidebar-right/lib/client.js:5645`), and `ctx.layout.selectPanel(id)` for `main` panels (`README.md:36`). The right panel "first opens at 45% of the viewport, then retains the user's pixel preference, capped at 70%" (`README.md:30`) — usable for a *docked* mode, but it is a layout column, not a floating window.

### 4.3 Shadow DOM / CSS scoping / z-index (partly ASSUMED)

VERIFIED: plugin CSS is injected by the bundle itself as a `<style data-plugin-css>` in `<head>`, inside the factory — `dsh-message-quotes/lib/client.js:11-19`:

```js
const css = ".U4oBDW_action{...}";
const tagId = "@deepseek-ai/dsh-message-quotes/QuoteSelection.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@deepseek-ai/dsh-message-quotes";
	tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag);
}
```

No framework support for Shadow DOM exists anywhere in the extracted packages (no `attachShadow` in any `lib/client.js` of the client packages). **ASSUMED plan:** because a plugin owns plain DOM access, create your own host element in a `shell.overlay` contribution's `useEffect` (or append to `document.body`), `host.attachShadow({mode:'open'})`, inject the plugin's `<style>` **inside** the shadow root (copy the css string), and mount React with `require("react-dom/client").createRoot(shadowRoot)`; theme vars inherit across the shadow boundary (custom properties are inherited through shadow DOM), so `--dsw-*` tokens keep working. **Fallback if React-under-shadow misbehaves:** light-DOM overlay inside `shell.overlay` with a unique class prefix (e.g. `.sideask-*`) — this is what every shipped plugin does.
z-index guidance: stay inside `shell.overlay`'s `z-index:20` layer; the frame's other layers are 11 (handles), 15 (`leadingSeat`), 70/71 (drawer/mask) (`dsh-client-ui-layout/lib/client.js:74`). Third-party precedent for a floating surface: `dsh-cost-meter`'s own CSS string (line 2 of the bundle) contains `position:fixed` and `z-index:9999`; it works, but 9999 escapes the overlay layer's stacking discipline — prefer the `shell.overlay` child slot and a lower z-index.

Theme tokens (VERIFIED): `--dsw-*` alias tokens are the styling authority; consume via CSS and read the snapshot through `ctx.theme`: `dsh-client-ui-theme/README.md:28,44`:
> Feature plugins consume the current snapshot through `ctx.theme` and read the `--dsw-*` tokens in CSS
and `dsh-client-ui-layout/lib/client.js:783-788`:
```js
const presenter = new ThemePresenter();
presenter.apply(ctx.theme.getTheme());
const off = ctx.on("theme/change", (snapshot) => { presenter.apply(snapshot); });
```
Useful concrete tokens seen in real plugin CSS: `--dsw-alias-bg-base`, `--dsw-alias-border-l3`, `--dsw-alias-label-primary`, `--dsw-elevation-panel`, `--dsw-elevation-stroke-color`, `--dsw-alias-button-floating-fill`, `--dsw-shadow-lv*`, and layout vars `--dsh-frame-top-clearance`, `--dsh-frame-overlay-top` (`dsh-message-quotes/lib/client.js:11`; `dsh-client-ui-layout/lib/client.js:74`).

### 4.4 i18n (VERIFIED)

Register dictionaries as an owned effect — `dsh-message-quotes/lib/client.js:159-168`:

```js
ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), "message-quotes: dictionaries");
```

Contract: `dsh-client-locale/README.md:40` — *"Call `ctx.locale.register(ns, { zh, en, ja })` ... Consumers translate through `ctx.locale.bind(ns)` or the framework-injected `t` seat."* Both baseline locales `zh` and `en` are **required**. A slot registered with `locale: NS` receives a `t` prop (`dsh-message-quotes/lib/client.js:29,184`). Active locale snapshot: `ctx.locale.getSnapshot().active` (used by `dsh-cost-meter`), change event `ctx.on("locale/change", ...)` (`dsh-cost-meter`: `e.effect(()=>e.on("locale/change",h),...)`).

---

## 5. Registering a hotkey, a settings section, and plugin state

### 5.1 Global hotkey (VERIFIED)

`dsh-client-shortcuts/README.md:30,32`: *"Feature plugins register commands through `ctx.shortcuts` inside `ctx.effect()`"* … *"Feature plugins contribute read-only sequences through `registerFixed()`"*.

Command object, real official registration `@deepseek-ai/dsh-client-ui-layout/lib/client.js:737-771`:

```js
ctx.shortcuts.register({
	id: "sidebar.left.toggle",
	label: () => t("toggle"),
	aliases: ["sidebar", "toggle left sidebar"],
	defaults: {
		"desktop:macos": { code: "KeyB", modifiers: ["primary"] },
		"desktop:windows": { code: "KeyB", modifiers: ["primary"] },
		"desktop:linux": { code: "KeyB", modifiers: ["primary"] },
		"web:macos": { code: "KeyB", modifiers: ["primary","alt"] },
		"web:windows": { code: "KeyB", modifiers: ["primary","alt"] }
	},
	regions: ["page","editable"],
	modals: ["sidebar"],
	resolve: ({ modal }) => modal !== null && modal !== "sidebar" ? { status: "pass" }
		: { status: "handled", run: () => { layout.toggleSidebar(); } }
});
```

Primary modifiers are `primary` → Cmd/Ctrl (`README.md:30`). Read-only/unassignable sequences use `registerFixed({ id, label: () => t(...), keys, bindings: [{code, modifiers}], group })` (`dsh-client-ui-conversation/lib/client.js:22740-22751`). Registration must be inside `ctx.effect` so unload removes it (`README.md:12`: *"Commands disappear when their owning plugin unloads"*). Saved overrides: Web origin-local `dsh.keybindings.v1` (`README.md:34`).

**Hotkey → open side ask:** `ctx.shortcuts.register({ id: "side-ask.toggle", label: () => t("sideAsk.toggle"), defaults: {"web:windows": {code:"KeyK", modifiers:["primary","shift"]}, ...}, regions:["page","editable"], resolve: () => ({status:"handled", run: () => openPanel()}) })`.

### 5.2 Settings section (VERIFIED)

`dsh-client-ui-settings/README.md:45`: *"the shell ... lives in ui-settings-general; feature pages register `settings.section` contributions"*.

Official registration, `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:5465-5481`:

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
	name: "settings.section",
	id: "models",
	order: 10,
	label: () => t("nav"),
	inject: injected,
	children: { "settings.models.provider-card": { kind: "keyed", scope: "root" }, ... }
}, ModelsSection));
```

Icon override: `ctx.slots.inject('settings.section.icon', ...)` with the same `id` (`README.md:47`).

### 5.3 Persistent plugin state (VERIFIED, two options)

1. **Host settings document** (cross-browser, survives reinstall) — `dsh-client-ui-settings/README.md:34`:
   > Feature adapters use `ctx.configForms.get(entryId)` to obtain accepted values and a write queue ... `set` and `unset` submit one operation; `mutate` submits one atomic operation list.
   Requires a Host-side config schema for that entry (the `ui-conversation` `busyEnter` pattern, `dsh-client-ui-conversation/lib/client.js:16326-16336`).
2. **Browser localStorage** (window position memory) — exactly what the official right sidebar does, `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:886-926`:

```js
function readSidebarLayout(sessionId) {
	if (typeof localStorage === "undefined") return void 0;
	try { raw = localStorage.getItem(`${sidebarPersistence}.${sessionId}`); } catch (_) { return; }
	...
	raw = localStorage.getItem(`${sidebarPersistence}.${sessionId}`);
```
```js
function writeSidebarLayout(sessionId, surface) { ... localStorage.setItem(`${sidebarPersistence}.${sessionId}`, JSON.stringify(saved)); ... }
```
Third-party precedent: `dsh-cost-meter` persists UI choices with `window.localStorage?.getItem?.("cm.gw."+id)` / `setItem`. **Recommendation for position/snap/minimize memory:** localStorage, keyed `dsh-sideask.window.v1` (global) or per-session id; no host round-trip, no schema needed.

---

## 6. Capability checklist

| capability | exact API | evidence file:line | VERIFIED/ASSUMED | fallback |
|---|---|---|---|---|
| read transcript | `ctx.sessions.retain(id,{source}).ready` → `binding.eventSource.getSnapshot().entries`; messages = `event.data.content` / `event.data.message.content` blocks with `type:"text"` | `@deepseek-ai/dsh-api-session-controller/lib/client.js:3856,3858,4072,4145-4150,1741-1762,2913-2936`; `@deepseek-ai/dsh-client-ui-chat/lib/client.js:11955-11992,10096,10412` | VERIFIED (shape: binding+feed+messages). Composition `retain→ready→entries` is ASSUMED-but-direct | read assembled nodes: `ctx.uiConversation.binding(b).target("chat").getSnapshot()` (`dsh-client-ui-conversation/lib/client.js:3989-4004`) |
| incremental subscribe | `binding.eventSource.subscribe(fn)`; `change.kind ∈ replace/prepend/append/settle-assistant`; lazy `getSnapshot()` per revision | `dsh-api-session-controller/lib/client.js:1741-1798,3984-3987` | VERIFIED | poll `snapshot.revision` on rAF; or `ctx.uiConversation` target `subscribe` (`:3995-3999`) |
| get selection | `ctx.uiConversation.interactions.register({ id, onInteraction(req) })` → `req.trigger==="selection"`, `req.readText()`, `req.open()`; button Slot `conversation.chat.text-interaction` props `{dismiss, readText, clearSelection, inputActions, useSession, t}` | `dsh-message-quotes/lib/client.js:170-185,29-50`; `dsh-client-ui-conversation/README.md:66` | VERIFIED | `window.getSelection().toString()` on a scoped pointerup listener (DOM, no dsh API) |
| insert into composer (quote) | `inputActions.insertQuote(text)` → boolean; quote node + trailing space, Markdown `> ` on send | `dsh-client-ui-conversation/lib/client.js:15186-15197,15369`; `dsh-message-quotes/README.md:59`; `dsh-client-ui-conversation/README.md:64` | VERIFIED | `inputActions.setDraft(text)` (`:15379`) or `captureInsertion()`+`insertText(text,span)` (`:15370-15378`) |
| get `inputActions` outside a slot | `ctx.conversation.input.for(binding.ctx).actions` (scoped ctx required) | `dsh-client-ui-conversation/lib/client.js:4717-4720,16127-16133,15368-15395,22775-22790` | VERIFIED pieces; call path ASSUMED | hidden contribution in `conversation.input.dock` and use its `inputActions` prop (pattern: `dsh-cost-meter/lib/client.js`) |
| register hotkey | `ctx.shortcuts.register({id,label,defaults:{"web:windows":{code,modifiers}},regions,resolve→{status,run}})` inside `ctx.effect`; or `registerFixed` | `dsh-client-ui-layout/lib/client.js:737-771`; `dsh-client-shortcuts/README.md:30,32`; `dsh-client-ui-conversation/lib/client.js:22740-22751` | VERIFIED | `document.addEventListener("keydown")` filtered to `ctrlKey/metaKey` + region check (no dsh API, no conflict management) |
| mount floating DOM | `ctx.slots.inject("shell.overlay", () => ctx.slots.register({name:"shell.overlay"}, Comp))`; layer CSS `z-index:20;position:absolute;inset:0`, children `pointer-events:auto` | `dsh-client-ui-layout/lib/client.js:346,401-405,705-736,74`; `dsh-client-ui-layout/README.md:38` | VERIFIED | `createPortal(node, document.body)` from `require("react-dom")` for fixed overlays |
| Shadow DOM | none in product; `host.attachShadow() + inject <style> into root + require("react-dom/client").createRoot(shadowRoot)`; `--dsw-*` vars inherit through the boundary | no `attachShadow` in any client bundle; CSS-injection pattern `dsh-message-quotes/lib/client.js:11-19`; platform table `dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196` | ASSUMED | light DOM inside `shell.overlay` with `.sideask-*` prefixed classes (all shipped plugins do this) |
| persist client state | Host: `ctx.configForms.get(entryId)` → `set`/`unset`/`mutate`; Browser: `localStorage.getItem/setItem` | `dsh-client-ui-settings/README.md:34`; `dsh-client-ui-sidebar-right/lib/client.js:886-926`; `dsh-client-shortcuts/README.md:34` | VERIFIED | in-memory only (lost on reload) |
| register settings UI | `ctx.slots.inject("settings.section", () => ctx.slots.register({name:"settings.section",id,order,label:() => t("nav")}, Section))`; icon via `settings.section.icon` same id | `dsh-client-ui-settings-models/lib/client.js:5465-5481`; `dsh-client-ui-settings/README.md:45,47` | VERIFIED | settings live only in the floating window's own panel (localStorage), no Settings entry |
| i18n | `ctx.effect(() => ctx.locale.register(ns, {zh, en, ...}))`; slot `locale: ns` → `t` prop; `ctx.locale.bind(ns)`; `ctx.locale.getSnapshot().active`; `ctx.on("locale/change")` | `dsh-message-quotes/lib/client.js:159-168,29,184`; `dsh-client-locale/README.md:40,44,86` | VERIFIED | hard-coded zh/en strings + `navigator.language` branch |
| theme tokens | CSS `--dsw-*` / `--dsh-*` vars; snapshot via `ctx.theme.getTheme()` + `ctx.on("theme/change")` | `dsh-client-ui-theme/README.md:28,44`; `dsh-client-ui-layout/lib/client.js:783-788`; concrete vars `dsh-message-quotes/lib/client.js:11`, `dsh-client-ui-layout/lib/client.js:74` | VERIFIED | `prefers-color-scheme` media query + own vars |
| clipboard | `navigator.clipboard.writeText(text)` (guard presence) | `dsh-experimental-client-ui-stats/lib/client.js:4424,4441-4442`; shell `index-BgUyXZcc.js:196` | VERIFIED | hidden `<textarea>` + `document.execCommand("copy")` |

---

## 7. Proposed client-plugin skeleton contract

**package.json (minimum loadable form, mirroring `dsh-cost-meter` + `dsh-client-modules/README.md:34`)**

```json
{
  "name": "dsh-sideask",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":      { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web" } }
}
```

Add `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` if the plugin is installed as a bundle that must be enabled in the Host Loader graph (see `dsh-cost-meter`). `dsh.client.external` is only needed for non-baseline module requests — for this plugin, none: React + react-dom + pritmitives + slots + store are all in the seed table.

**lib/client.js (exact top-level shape)**

```js
window.__ModuleLoader__.load({
  id: "dsh-sideask",                       // MUST equal the package name resolved by the Host
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // optional: inject this plugin's CSS as <style data-plugin-css="dsh-sideask/..."> here

    const react = require("react");
    const { jsx } = require("react/jsx-runtime");       // or require("react/jsx-runtime").jsx
    const { createPortal } = require("react-dom");      // if portaling to <body>
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const name = "dsh-sideask";
    const inject = ["slots", "sessions", "uiConversation", "locale", "shortcuts"];

    function apply(ctx) {
      // 1. dictionaries:    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "...")
      // 2. selection:       ctx.effect(() => ctx.uiConversation.interactions.register({ id: "sideask", onInteraction(req) {...} }), "...")
      // 3. overlay window:  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "sideask" }, SideAskWindow))
      // 4. hotkey:          ctx.effect(() => ctx.shortcuts.register({...}), "...")
      // 5. settings:        ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "sideask", order: 40, label: () => t("nav") }, Section))
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  }
});
```

**What `require` can resolve:** only the ten seed entries in §1.3 (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`) plus boot-graph rows and `require.async`/`require.asset`. Everything else must be bundled into `lib/client.js` or vendored as a `client.<name>.js` chunk loaded with `require.async`.

**Bootstrap caution:** the overlay component must subscribe to the session feed itself (create a store via `require("@deepseek-ai/dsh-client-store")`'s `createSnapshotStore` + `useSyncExternalStore` with `binding.eventSource.subscribe`, following the shell's own uSES usage at `dsh-api-session-controller/lib/client.js:2580-2595`), because `useSession`/`inputActions` standard props only exist inside session-scoped slots (`dsh-client-ui-conversation/lib/client.js:22775-22790`), not on the root `shell.overlay` slot.

---

## 8. Open questions / risks for the implementers

1. **`shell.overlay` is root-scoped, the session feed is per-session.** The window must retain the active session itself: `ctx.sessions.list` gives ids/titles (`dsh-api-session-controller/lib/client.js:3815,3830-3835`); the "current" session must be tracked from the Conversation, e.g. by reading `ctx.sessions.list` + the last `binding` — no single documented "current session id" client service was found (**ASSUMED**; fallback: contribute into session-scoped slots such as `conversation.input.dock`/`conversation.chat.turnTail` where `useSession` is injected, and keep the floating window in `shell.overlay` driven by that id).
2. **Quote-mode restriction:** `insertQuote` only works while the composer is in plain mode (`dsh-client-ui-conversation/README.md:64`) and returns `false` otherwise — the UI must surface that failure (or fall back to `setDraft`).
3. **React version**: read from the shell vendor bundle at implementation time; React 19 is needed for reliable Shadow-DOM event delegation. If Shadow DOM is chosen, verify pointer/drag events across the boundary early (this is the one ASSUMED architectural risk).
4. **No `dsh.client.external` need** — keep the bundle dependency-free to avoid graph composition rejections (`dsh-client-modules/README.md:55`).
