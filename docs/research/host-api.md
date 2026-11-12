# dsh host-side plugin API — verified research (dsh 0.2.2-rc.1)

Scope: what a **host (Node) half of an out-of-tree plugin** can call, for the *side-ask*
floating assistant: read the active conversation read-only → build a token-budgeted
context → call the host's already-configured model in a **separate thread** that never
writes the main session → serve the browser half over an authenticated route.

**Path aliases used in citations**

| Alias | Real path |
|---|---|
| `SDK/` | `E:\workspace\_probe\asar-out\dsh\node_modules\@deepseek-ai\` |
| `WP/` | `E:\workspace\dsh-spend-wallpaper\` |
| `PROFILE/` | `C:\Users\32602\.dsh\profiles\desktop\` |

**Confidence legend**
- **VERIFIED** — read directly in shipped `README.md`/`lib/*.js` (excerpt quoted).
- **ASSUMED** — inferred, not directly proven; a fallback is given.
- Anything not cited must be treated as invented.

**Version facts**: product `dsh 0.2.2-rc.1`; plugin peer deps seen in real plugins are
`@deepseek-ai/cordis ~4.1.0` and `@deepseek-ai/schemastery ~3.19.0`
(`WP/package.json:80-82`); declared host compatibility
`">=0.2.0-rc.1 <0.3.0-0"` (`WP/package.json:37`).

---

## 0. Five decisive facts

1. **Model call** = `ctx.llm.stream(GenerateOptions)` → async iterable of chunks, exactly
   one terminal `finish`; abort via `options.signal`; failures arrive as
   `finish.reason = { kind: 'error'|'aborted', failure: { code, message, ... } }`.
   Service key is `llm` (`SDK/dsh-base/cordis.patch.yml:34-35`).
2. **Route selection** = `ctx.get('agentDefaultModel').currentSelection()` →
   `{ provider, model, reasoningEffort? }`; on this machine the live profile resolves to
   `deepseek-account` / `deepseek-flash` / `high` (`PROFILE/cordis.patch.yml:4-9`).
3. **Browser transport (recommended)** = `ctx.connection.fetch.register({ path: '/api/<x>',
   methods, requestBody, fetch })` — this route is **behind the browser authentication +
   Host/Origin fence**, accepts POST, and streams `Response.body`. The browser calls it with
   a plain document-relative `fetch('api/<x>')` (exactly how the shipped session-log export
   client calls its host route). A generic RPC channel registry also exists
   (`ctx.connection.rpc.handle` / `ctx.connection.rpc.call`).
4. **Transcript** = `ctx.sessions.get(sessionId).deriveMessages()` returns the frozen
   `Message[]` that the model would see; it only reads. Cold/not-live sessions:
   `ctx.sessionQuery.readSurface(id)`. The plugin never calls `session.append`, so it
   cannot pollute the main thread.
5. **Composition** = `package.json.dsh.bundle.patch` → `cordis.patch.yml` `- insert:
   [{ id, name }]` row; profile installs the package (`dsh plugin --profile <p> add
   link:<dir>`) and lists the bundle in `dsh.profile.bundles`; config is a schemastery
   `Config` whose `.volatile()` fields arrive as `{ get() }` refs. No typert codegen is
   needed for any of the above.

---

## (a) `ctx.llm.stream(options)` — exact option fields, chunk protocol, finish reasons

### a.1 The service and its composition

`SDK/dsh-base/cordis.patch.yml:34-35`
```yaml
    - id: llm
      name: '@deepseek-ai/dsh-llm'
```
Adapters are separate rows (`:531-535`): `llm-deepseek` (`dsh-llm-deepseek-api-key`) and
`llm-deepseek-account` (`dsh-llm-deepseek-account`). `ctx.llm` is the only supported path
into a provider: "it is the only supported path into provider adapters"
(`SDK/dsh-llm/README.md:34`), "Any composition that calls a model provider … streams its
requests through this service" (`SDK/dsh-llm/README.md:30`).

### a.2 `GenerateOptions` — canonical interface (VERIFIED type text)

The generated type artifact ships the exact interface
(`SDK/dsh-llm/lib/typert.host.js:359`):
```ts
export interface GenerateOptions<Purpose extends string = LlmRequestPurpose> {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    messages: RequestMessage[];
    system?: string;
    tools?: ToolSchema[];
    toolHistory?: ToolHistory;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    purpose?: Purpose;
}
```
Message/value vocabulary (same file):
- `RequestMessage = Message | RequestUserInput` (`:547`).
- `RequestUserInput` (`:551`):
  ```ts
  export interface RequestUserInput {
      readonly role: 'user';
      readonly content: UserMessage['content'];
      readonly id?: never;
      readonly source?: never;
  }
  ```
- `MessageBase` requires `id`, `content`, `source`; `TextBlock = { type: 'text'; text: string }`
  (`SDK/dsh-llm/lib/typert.host.js`, `MessageBase`, `TextBlock` declarations).
- `TokenUsage`:
  ```ts
  export interface TokenUsage {
      inputTokens: number; outputTokens: number; totalTokens?: number;
      cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
  }
  ```

**Consequence for us**: a one-shot question needs only
`messages: [{ role: 'user', content: [{ type: 'text', text }] }]` — no `id`, no `source`
(the README calls these "request-only inputs", `SDK/dsh-llm/README.md:63`). Multi-turn
history needs durable messages: `createUserMessage({ content, source })` /
`createAssistantMessage({ content, source })` are exported from
`SDK/dsh-llm/lib/types/message.js:53,64` and re-exported at `SDK/dsh-llm/lib/index.js:2433`.

The README's own minimal call (`SDK/dsh-llm/README.md:50-57`):
```ts
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
})) {
  // chunks: block-start, text-delta, ..., usage, finish
}
```

### a.3 Chunk protocol and terminal outcomes (VERIFIED)

`SDK/dsh-llm/lib/typert.host.js:595`:
```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```
`FinishReasonMap` (`SDK/dsh-llm/lib/typert.host.js:355`):
```ts
export interface FinishReasonMap {
    stop: { kind: 'stop'; };
    'tool-calls': { kind: 'tool-calls'; };
    'max-tokens': { kind: 'max-tokens'; };
    aborted: { kind: 'aborted'; failure: LlmFailure; };
    error: { kind: 'error'; failure: LlmFailure; };
}
```
`LlmFailure` (`:411`):
```ts
export interface LlmFailure {
    readonly message: string; readonly code: string; readonly status?: number;
    readonly providerRetryAfterMs?: number; readonly requestId?: ProviderRequestId;
    readonly offloadImages?: number;
}
```
Semantics: "Every stream ends in exactly one terminal `finish` chunk: `{ kind: 'error',
failure }` … `{ kind: 'aborted', failure }` … consumers route on the code, never on message
text" (`SDK/dsh-llm/README.md:95`). Known codes named there: `NO_ADAPTER`,
`MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`,
`ACCOUNT_QUOTA`, `INVALID_CREDENTIAL`. An unregistered provider yields `NO_ADAPTER`
(`SDK/dsh-llm/lib/index.js:2267-2270`):
```js
	registration(provider) {
		const registration = this.adapters.get(provider);
		if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER");
```
Cancellation turns into the terminal chunk, not a throw from the adapter:
`SDK/dsh-llm/lib/index.js:2407-2418`
```js
function adapterFailureChunk(error, signal) {
	const failure = normalizeLlmFailure(error);
	return { type: "finish", reason: signal?.aborted || failure.code === "ABORTED"
		? { kind: "aborted", failure } : { kind: "error", failure } };
}
```
Stream entry point (`SDK/dsh-llm/lib/index.js:2398-2402`):
```js
		stream(options) {
			return this.streamWithRegistration(options);
		}
```

### a.4 Assembling text (VERIFIED)

`BlockAssembler` is the canonical assembler and is a public export
(`SDK/dsh-llm/lib/index.js:2433`). `push(chunk)`, then `blocks()` / `usage` / `finish`
(`SDK/dsh-llm/lib/types/assembler.js`; `finish` getter: "`{kind: 'stop'}` when the stream
ended without one"). The production auxiliary-call example uses exactly this
(`SDK/dsh-session-title-llm/lib/index.js:209-215`):
```js
		const assembler = new BlockAssembler();
		for await (const chunk of call.stream(options)) {
			callDeadline.signal.throwIfAborted();
			assembler.push(chunk);
		}
		callDeadline.signal.throwIfAborted();
		const finish = terminalFinish(assembler.finish);
```

### a.5 Prepared call (optional; used by shipped auxiliary callers)

`ctx.llm.prepareCall(config, signal, configure?)` resolves route + defaults and returns a
one-shot handle whose `stream(options)` re-checks that the controls did not change
(`SDK/dsh-llm/lib/index.js:2225-2266`):
```js
		async prepareCall(config, signal, configure) {
			signal?.throwIfAborted();
			const { provider, model, ...controls } = config;
			...
			return Object.freeze({ config: resolvedConfig, retryPolicy: registration.retryPolicy, ...,
				stream: (options) => { if (dispatched) throw ...; if (!callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL"); ... } });
```
`SDK/dsh-session-title-llm/lib/index.js:181-198` shows the full pattern (prepare → spread
`call.config` into options → stream). **For side-ask, plain `ctx.llm.stream()` is enough**;
`prepareCall` buys adapter-default materialization and exact config recording.

### a.6 Timeouts / cancellation without extra packages (VERIFIED pattern)

The shipped auxiliary caller wraps the passed-in `signal` with `deadline(signal, timeoutMs,
code)` from `@deepseek-ai/dsh-timeout` and calls `throwIfAborted()`
(`SDK/dsh-session-title-llm/lib/index.js:167,179,208,211,214`). For an out-of-tree plugin
that should not depend on that package, an `AbortController` + timer + `AbortSignal.any`
pattern is already used in a shipped route handler
(`SDK/dsh-client-ui-deliverables/lib/index.js:61-89`):
```js
	const lifetime = new AbortController();
	...
	fetch: (request) => { const task = handler(ctx, new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) })); ... }
```

### a.7 Do **not** write the main session

The LLM service itself appends nothing; only the agent loop / caller writes session events
("This service never re-runs a request" `SDK/dsh-llm/README.md:95`; session writes need an
explicit `session.append`, `SDK/dsh-session/README.md:44`). So a side-ask implementation that
only calls `ctx.llm.stream()` and never calls `session.append(...)` cannot change main
history. `sessionId` in `GenerateOptions` is optional and only becomes request metadata — the
deepseek adapter forwards it only when present:
`SDK/dsh-llm-deepseek/lib/index.js:2212,2244` (`...options.sessionId === void 0 ? {} :
{ "x-deepseek-harness-session-id": String(options.sessionId) }`).
**ASSUMED risk**: the package invariant "Callers must keep all model-visible input
reconstructable from the session log" (`SDK/dsh-llm/README.md:12`) describes loop-produced
requests; nothing enforces it for a plugin. Fallback: persist the exact side-thread request
in our own store (`$DSH_HOME/storages/sideask/threads.json`) so the side conversation is
reconstructable from its own log.

---

## (b) `ctx.get('agentDefaultModel').currentSelection()` — route selection

Service is provided by the base row `agent-default-model`
(`SDK/dsh-base/cordis.patch.yml:90-95`). Implementation
(`SDK/dsh-agent-default-model/lib/index.js:21-45`):
```js
	static Config = z.object({
		provider: z.string().required().volatile(),
		model: z.string().required().volatile(),
		reasoningEffort: z.string().volatile()
	});
	constructor(ownerContext, config) { super(ownerContext, "agentDefaultModel"); ... }
	currentSelection() {
		const reasoningEffort = this.config.reasoningEffort.get();
		return selection({ provider: this.config.provider.get(), model: this.config.model.get(),
			...reasoningEffort === void 0 ? {} : { reasoningEffort } });
	}
```
The live desktop profile overrides it (`PROFILE/cordis.patch.yml:4-9`):
```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
```
Route id is the adapter's provider name: the account adapter says "Register authentication …
for `deepseek-account`" (`SDK/dsh-llm-deepseek-account/README.md`, Summary).

Discovery fallback: `ctx.llm.listProviders()` "reports the registered routes in
registration order" (`SDK/dsh-llm/README.md:59`); each entry is
`LlmProviderInfo = { id: string; name: string }` (`SDK/dsh-llm/lib/typert.host.js`, declaration
`LlmProviderInfo`).

**Context window for budgeting** (VERIFIED): `ctx.llm.resolveModelInfo(provider, model)`
returns `LlmResolvedModelInfo` with `context?: { contextWindow: number }` and
`defaultMaxTokens?` (`SDK/dsh-llm/lib/typert.host.js:467`;
implementation `SDK/dsh-llm/lib/index.js:2116`).

**Token estimation** (VERIFIED): `ctx.tokenMeter.estimateMessage(message)` prices one message
and `ctx.tokenMeter.measure(session)` prices a whole live session
(`SDK/dsh-token-meter/README.md:36-40`; service key `tokenMeter` at
`SDK/dsh-token-meter/lib/index.js:800`; methods at `:846` and `:907-909`). Base mounts the row
(`SDK/dsh-base/cordis.patch.yml:352-353`). This is a heuristic ("a fixed heuristic", README),
not a provider tokenizer — good enough for a context budget, not for billing.

---

## (c) `ctx.webServer.register(...)` and the two authenticated transports

### c.1 The raw webserver route API (VERIFIED — and auth-free)

`SDK/dsh-host-webserver/README.md:61`: "`register(route)` adds a named `exact` or `prefix`
HTTP route, `registerUpgrade(route)` adds an upgrade route for an exact pathname, and both
return a disposer that removes the registration." Matching: "exact over the whole table,
then longest prefix, then the fallback".

`SDK/dsh-host-webserver/README.md:63`: "A named route may give `resource(request, peer?)`
instead of `handler`: a function from a Fetch `Request` to a `Response`. Over HTTP only
`GET` and `HEAD` reach it — any other method is answered 405 …". ⇒ **`resource` cannot do
POST**; use `handler(req, res)` for POST.

Real plugin usage (`WP/lib/http.js:144-156`):
```js
export function registerRoutes(ctx, runtime) {
  const server = ctx.webServer
  const disposers = []
  disposers.push(server.register({ kind: 'exact', path: `${ROUTE_PREFIX}/state`, resource: (request) => stateResource(runtime, request) }))
  disposers.push(server.register({ kind: 'prefix', path: `${ROUTE_PREFIX}/scenes`, handler: createScenesHandler(runtime) }))
  ...
  return () => { for (const dispose of disposers) { try { dispose() } catch {} } }
}
```
`ctx.webServer` is obtained as a service and the route registration is wrapped in
`ctx.inject(['webServer'], (child) => child.effect(...))`
(`WP/lib/index.js:583-585`). The plugin hand-rolls Origin/`Sec-Fetch-Site` checks because
this surface is **not** authenticated by the host: "No server-wide authentication or origin
policy — route owners such as dsh-client-connection enforce their own request policy"
(`SDK/dsh-host-webserver/README.md:132`). `WP/lib/http.js:25-43,78-90` is the
minimal same-origin guard to copy if this transport is used.

### c.2 Recommended: authenticated exact Fetch routes on `/api` (VERIFIED end to end)

`dsh-client-connection` provides a route registry **inside** the browser auth fence:
`connection.fetch` — "Exact Fetch-route registry scoped to the Context reading this service"
(`SDK/dsh-client-connection/lib/index.js:731-735`):
```js
	get fetch() { const owner = this.ctx; return { register: (route) => this.registerFetchRoute(owner, route) }; }
```
`registerFetchRoute` (`:840-854`) validates and fiber-owns the registration:
```js
	registerFetchRoute(owner, route) {
		assertFetchRoute(route);
		...
		return owner.effect(() => { if (this.fetchRoutes.has(route.path)) throw new Error(...);
			this.fetchRoutes.set(route.path, registered);
			return () => { this.fetchRoutes.delete(route.path); }; }, `client-connection: ${route.path} Fetch route`);
	}
```
Validation requires the path under `/api/` and a non-empty, duplicate-free method list
(`:973-977`):
```js
function assertFetchRoute(route) {
	if (endpointFromPath("/api", route.path) === void 0) throw new Error(`connection: invalid exact Fetch route ...`);
	if (route.methods.length === 0) throw ...; if (new Set(route.methods).size !== route.methods.length) throw ...;
}
```
Dispatch: the single `/api` prefix route calls `connection.admit(req)` first (403/401) and
then the shared handler (`SDK/dsh-client-connection/lib/index.js:1044-1058`); shared handler
selects a route by pathname and requires the owner principal (`:820-839`). The response body
is streamed chunk-by-chunk (`:95-101`):
```js
	if (response.body === null) { ... } 
	for await (const chunk of response.body) { ... }
```
Therefore: **POST works, auth works, and streamed (SSE) responses work** through `/api`.

Shipped consumers to copy:
- JSON/stream export route (`SDK/dsh-session-log-export/lib/index.js:767-771,798-811`):
  ```js
  const SESSION_LOG_EXPORT_PATH = "/api/session.export";
  ...
  connectionOf(ctx).fetch.register({ path: SESSION_LOG_EXPORT_PATH, methods: ["GET", "HEAD"],
    requestBody: "buffered", fetch: async (request) => { const response = await sessionLogExportResponse(ctx, request, ...); ... } });
  ```
- Route handler composition with a lifetime + `AbortSignal.any`
  (`SDK/dsh-client-ui-deliverables/lib/index.js:48-60,61-98`).
- Streaming request body (`SDK/dsh-client-file-upload/lib/index.js:179-184`):
  ```js
  ctx.effect(() => ctx.connection.fetch.register({ path: FILE_UPLOAD_PATH, methods: ["POST"], requestBody: "streaming", fetch: (request) => handleFileUploadHttp(this, request) }), "file-upload: streaming route");
  ```
Browser call convention (shipped client, `SDK/dsh-session-log-export/lib/client.js:12`):
```js
		const SESSION_LOG_EXPORT_ROUTE = "/api/session.export".slice(1);
```
i.e. a **document-relative** `fetch('api/session.export?...')` with same-origin cookies
(`:33-40` builds an anchor/download; `:54` injects `fetcher = (input, init) => fetch(input, init)`).

### c.3 Alternative: generic unary RPC channel (VERIFIED surface)

Host (`SDK/dsh-client-connection/lib/index.js:723-729,855-872`):
```js
	get rpc() { const owner = this.ctx; return { handle: (channel, handler) => this.register(owner, channel, handler), ... }; }
	register(owner, channel, handler) {
		assertChannel(channel);          // channel must match /^\/[A-Za-z0-9._~-]+$/ and not be "/api"
		const fetchHandler = rpcFetchHandler(channel, handler);
		const route = { kind: "prefix", path: channel, handler: async (req, res) => { const admission = this.admit(req); ... await bridge(req, res, fetchHandler, admission.peer); } };
		return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
	}
```
Handler contract: `handler(endpoint, payload, request.signal, peer)` (`:909-914`), must return
an envelope; success/error envelopes are built at `:932-969` (`{ ok: false, error }` /
`{ ok: true, value }`). Client
(`SDK/dsh-client-connection/lib/client.browser.js:1209-1239`):
```js
	function createWebConnectionRpc(doFetch, openStream) {
		const send = doFetch ?? ((input, init) => globalThis.fetch(input, init));
		return { async call(channel, endpoint, payload, signal) { ... const response = await send(`${channel}/${endpoint}`.slice(1), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message), ... }); ...
			return full.result; } }
```
and `rpc` is exposed on the client `connection` handle (`:1443`), whose result envelope the
client validates as `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`
(`parseConnectionResponse` in the same file). Plugin-facing README line: "The Host half always
provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries"
(`SDK/dsh-client-connection/README.md:34`).
**ASSUMED**: in the Web page the client `rpc` caller is the default fetch-backed one unless
the shell supplies `__DSH_TRANSPORT__.rpc` (the shell was observed reading
`__DSH_TRANSPORT__` only for `loadBundle`/`resolveAsset`,
`SDK/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`). Fallback: use c.2.

### c.4 Not viable here: Typert Remote (`@Remote` + generated artifacts)

The typed Remote path needs generated reflection/codecs produced by the Typert build
pipeline ("Generation turns the method into a wire endpoint",
`SDK/dsh-typert-protocol/README.md`, "Exposing a Host method"; the loader only registers
packages that export a generated `./typert` artifact,
`SDK/dsh-typert-loader/README.md`). A plain JS/TS plugin without the generator cannot
produce `lib/typert.host.js`/`lib/typert.remote-client.js`. Cost-meter shows such artifacts
are possible for third parties (`C:\Users\32602\.dsh\profiles\desktop\node_modules\dsh-cost-meter\lib\typert.host.js`,
exports `"./typert"` in its package.json `exports`), but that is generator output.
**Recommendation: do not use Typert**; use c.2 (or c.3 for a unary method).

**Transport comparison**

| Transport | Auth | POST | Streaming reply | Codegen | Use for side-ask |
|---|---|---|---|---|---|
| `ctx.connection.fetch.register` (`/api/...`) | host browser cookie + Host/Origin fence (VERIFIED `:1044-1058`) | yes | yes (VERIFIED `:95-101`) | none | **primary** |
| `ctx.connection.rpc.handle(channel)` | same `admit()` (VERIFIED `:855-872`) | yes (JSON only) | no (unary) | none | simple request/response |
| `ctx.webServer.register` | none — plugin must hand-roll Origin checks (VERIFIED `WP/lib/http.js:25-43`) | yes (`handler`) | yes | none | fallback / non-browser |
| Typert `@Remote` | gateway access control | yes | streams (`@Remote({mode:'stream'})`) | **required** | no |

---

## (d) Config: schemastery `Config` + volatile getter refs

Real plugin pattern (`WP/lib/index.js:45-72`) — export `name`, `Config`, `apply`:
```js
export const name = 'spend-wallpaper'

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  source: z.union(['auto', 'account', 'api', 'cost-meter', 'manual']).default('auto').volatile(),
  ...
})
```
`.volatile()` is a schemastery feature (`SDK/schemastery/lib/index.mjs:235-237`):
```js
Schema.prototype.volatile = function volatile() { if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped"); return this.extra("volatile", true); };
```
Volatile values are `cosmokit` refs read through `.get()` (`SDK/schemastery/lib/index.mjs:178`
`if (isVolatile(value)) value = value.get();`; cordis: "Schemas may return `Volatile<T>`
references, whose values are read through `.get()`. … Loader commits volatile-only changes
into the running references without restarting" — `SDK/cordis/README.md:105`).

The config passed to `apply(ctx, config)` therefore contains **getter refs for volatile
fields**. Real code unwraps them on every read (`WP/lib/index.js:232-253`):
```js
  readConfig() {
    // Volatile Config fields arrive as getter refs (`{ get() }`); unwrap them on
    // every read so settings changes apply without remounting the plugin.
    const raw = this.config ?? {}
    ...
      if (value !== null && typeof value === 'object' && typeof value.get === 'function' && value.length === undefined) {
        try { snapshot[key] = value.get() } catch { snapshot[key] = undefined }
```
⇒ Side-ask must keep one `readConfig()` that unwraps `{get()}` and clamps, exactly like the
current `src/host/config.ts` scaffold.

Lifecycle/disposal (`WP/lib/index.js:575-586`):
```js
export function apply(ctx, config) {
  const runtime = new WallpaperRuntime(ctx, config)
  ctx.effect(() => runtime.start(), 'spend-wallpaper: sampler')
  try { ctx.provide('wallpaper', runtime) } catch { ... }
  ctx.inject(['webServer'], (child) => { child.effect(() => runtime.registerRoutes(child), 'spend-wallpaper: http routes') })
}
```
Cordis primitives (VERIFIED in `SDK/cordis/lib/index.js`):
`ctx.effect(execute, label)` (`:463`) — runs `execute()` and disposes its return on unload;
`ctx.provide(name, value, check)` (`:1384-1404`) — registers a fiber-owned service, returns a
disposer; `ctx.set(name, value)` (`:1366`) — replace own provided value; `ctx.inject(inject,
callback)` (`:1672-1678`) — starts a child plugin once dependencies exist; `inject: [...]`
declares hard dependencies (`SDK/cordis/README.md:65`). Service-class variant:
`super(ctx, 'agentDefaultModel')` + `static Config` (`SDK/dsh-agent-default-model/lib/index.js:17-33`).

---

## (e) Persistence precedent: `$DSH_HOME/storages/<name>`

Host storage row is mounted with a concrete root
(`SDK/dsh-base/cordis.patch.yml:182-185`):
```yaml
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
```
Domain KV form (`SDK/dsh-storage-domain/README.md:36-52`):
```text
const workspaceSpec = defineDomain({ name: 'workspace', version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) } })
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id) // synchronous, from memory
```
`defineDomain` / `domainTable` are exported from `SDK/dsh-storage-domain/lib/index.js:480`.
Writes are durable before they resolve; reads synchronous; `domain.close()` on shutdown;
failures carry stable `DomainError` codes (`README.md`, "Observable behavior and failures").

**ASSUMED (simpler alternative already in the scaffold)**: the real third-party plugin keeps
its own JSON state file and debounces writes — `WP/lib/index.js:87`
(`this.writer = new DebouncedStateWriter(stateFilePath(), 2000)`) and
`WP/lib/index.js:342-369` (`persist()`), with the path derived from a store module. Direct
`fs` writes under `$DSH_HOME/storages/<plugin>/` are just files; the host does not create or
own them. Fallback if `ctx.storageDomain` is not reachable from a plain plugin: keep the
scaffold's `$DSH_HOME/storages/sideask/threads.json` (works, unversioned).

`DSH_HOME` is an environment fact used by the base patch (`dshHomePath(...)`,
`SDK/dsh-base/cordis.patch.yml:141,146-147`); a plugin can use `process.env.DSH_HOME` or
`os.homedir()/.dsh` (the scaffold already does) — **ASSUMED** (no exported `home-paths`
service was confirmed here; `@deepseek-ai/dsh-home-paths` exists but its API was not read).

---

## (f) How a package + row gets loaded

1. **Package manifest** (`WP/package.json:27-38`):
   ```json
   "dsh": {
     "manifestVersion": 1,
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": { "platform": "web", "immediately": true },
     "compatibility": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" }
   }
   ```
   `bundle.patch` is "one patch file path or an ordered list of them, each relative to the
   package root" (`SDK/dsh-package-manifest/README.md`, `DshBundleManifest` paragraph);
   `dsh.manifestVersion` format id is `1`; `engines.dsh` declares the host range
   (same README field table). Host enforcement: "Installation and profile startup enforce
   the declared `engines.dsh` range" (`SDK/dsh/README.md:39`).
   Client half: "A browser plugin package declares `dsh.client` in its `package.json` with
   `platform: 'web'`, exports a `./client` bundle" (`SDK/dsh-client-modules/README.md:34`),
   served at `/plugins/<package>/client.js`; `immediately` is validated as a boolean and
   carried into the boot row metadata (`SDK/dsh-client-modules/lib/index.js:93,98,800`).
   **ASSUMED**: `immediately: true` means "prefetch in the boot tier" (the shell has
   `prefetchImmediateTier()`, `SDK/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`); since
   side-ask has no launcher UI, `true` is the safe setting for a hotkey-driven floating panel.

2. **Row** (`WP/cordis.patch.yml:1-6`):
   ```yaml
   # dsh-spend-wallpaper bundle patch: one host row over the web/desktop profile.
   - insert:
       - id: spend-wallpaper
         name: dsh-spend-wallpaper
   ```
   Row id is the address other patch layers use; `name` is the Node specifier resolved from
   the profile's `node_modules`.

3. **Profile composition** (`PROFILE/package.json:10-16`):
   ```json
   "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ..., "dsh-spend-wallpaper" ]
   ```
   "The tree composes over an empty root: each bundle's patch in `dsh.profile.bundles` order,
   then the profile's `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`,
   then `--patch` overlays" (`SDK/dsh/README.md:46`-adjacent); bundles resolve "from the dsh
   installation first ..., then from the profile's own `node_modules`, where pnpm installs
   out-of-tree plugins" (`SDK/dsh/README.md:46`).
4. **Install/toggle**: `dsh plugin --profile <name> <pnpm args>`
   (`SDK/dsh/README.md:18`); plugin manager toggles write `disabled` into the profile's
   `cordis.patch.yml` or append/reorder the bundle list
   (`SDK/dsh-plugin-manager/README.md:40`). Live recomposition needs HMR
   (`SDK/dsh-base/cordis.patch.yml:27-32`, row `hmr`); otherwise restart.
5. **Row config override** (`PROFILE/cordis.patch.yml:30-33`):
   ```yaml
   - id: spend-wallpaper
     config:
       surfaceOpacity: 0.45
   ```
   A patch replaces the targeted row's whole `config` rather than merging
   (`SDK/dsh-base/cordis.patch.yml:6-8`).

---

## (g) Authorization / permissions — does a plugin need to declare anything?

- **To call `ctx.llm` / `ctx.webServer` / `ctx.connection`**: no permission declaration and no
  typed access-control at the Cordis level — they are plain services resolved by
  `inject`/`ctx.get`. Evidence: spend-wallpaper calls `ctx.get('credentials')`,
  `ctx.get('deepseekAccount')` (`WP/lib/sources.js:96,115`), `ctx.provide('wallpaper', ...)`,
  `ctx.inject(['webServer'], ...)` (`WP/lib/index.js:579-585`) and its package.json declares
  no host-scope permission for those (`WP/package.json:40-60` declares only
  `permissions.network`).
- **Gateway/Remote access control** is a different layer: "Every Remote endpoint is
  access-controlled" and routes declare resource kinds (`SDK/dsh-api-session-controller/README.md`,
  Summary) — this applies to Typert Remote calls, not to `connection.fetch` routes, which are
  admitted as the browser owner Peer ("a Peer whose principal is not the owner reaches an
  endpoint only when …", same README; and `connection.fetch` dispatch rejects non-owner
  peers: `SDK/dsh-client-connection/lib/index.js:830` `if (peer.principal.kind !== "owner")
  return Promise.resolve(new Response("forbidden", { status: 403 }))`).
- **`dshhub.permissions`** appears in real plugins (`WP/package.json:40-60`,
  `network: ["https://api.deepseek.com"]`; cost-meter lists ~30 network origins) but **no
  extracted SDK `lib/*.js` reads the `dshhub` key at all** (case-insensitive search across
  `SDK/` returned zero code hits). ⇒ **ASSUMED**: `dshhub` is marketplace/catalog metadata
  (display, categories, surfaces, network disclosure), not a runtime capability grant.
  Fallback/guidance: do not invent capability names; mirror what shipped plugins declare
  (`schemaVersion`, `displayName`, `summary`, `categories`, `surfaces`, and
  `permissions.network` when the plugin itself makes direct network calls). Side-ask makes
  none (the LLM adapter owns the request), so `network: []` is appropriate; the scaffold's
  `permissions.host: ["webServer.register", "llm.stream", "storages:read-write"]` is
  **unproven vocabulary** — recommend dropping it or keeping it clearly non-authoritative.
- **Credentials**: a plugin that calls `ctx.llm` must **not** handle keys; the adapter resolves
  them per request ("No key or endpoint is inlined: both resolve per request from the
  `llm-deepseek:` settings section over this entry, with the key coming from the credential
  store below", `SDK/dsh-base/cordis.patch.yml:527-529`). `ctx.credentials` exists
  (`SDK/dsh-credentials/README.md`, Summary) but is not needed by side-ask.
  `dsh-authorization` is for human-guided sign-in flows (`SDK/dsh-authorization/README.md`,
  "Registering a flow") — not needed.

---

## (b2) Reading the main transcript host-side

Live sessions (VERIFIED):
- `ctx.sessions.get(id)` → live `Session` or `undefined`; `ctx.sessions.list()` → all live
  sessions in creation order (`SDK/dsh-session/lib/index.js:1994-2008`; README
  `SDK/dsh-session/README.md:37-38`).
- `session.id` delegates to `this.header.id` (`SDK/dsh-session/lib/index.js:1346-1348`);
  header fields are `version, id, createdAt, cwd?, parentSession?, isSeeded`
  (`SDK/dsh-session/lib/types/index.js:40-56,81-84`).
- **`session.deriveMessages()`** — "projects the log into the `Message[]` the model sees,
  incrementally and cached" (`SDK/dsh-session/README.md:44`); returns a fresh array of shared,
  deep-frozen `Message` objects (`SDK/dsh-session/lib/index.js:1681-1696`:
  `deriveMessages() { ... return [...this.derived] }`). This is the correct transcript read;
  it performs no writes.
- Message shape: `Message = MessageRoleMap[keyof …]`, `MessageBase = { readonly id; readonly
  content: readonly ContentBlock[]; readonly source }`; `MessageRoleMap` has
  `system|developer|user|assistant|tool`; `ContentBlockMap` has
  `text|reasoning|image|file|tool-call|tool-addition|tool-removal`
  (`SDK/dsh-llm/lib/typert.host.js`, declarations `MessageBase`/`MessageRoleMap`/
  `ContentBlockMap`). Text extraction for a context window = keep blocks with
  `type === 'text'` and `role` in `{user, assistant}`, skip `reasoning`/`tool-*`/image bytes
  (images/files are durable references, not bytes: "Durable `FileBlock` references never
  reach any adapter", `SDK/dsh-llm/README.md`, Main flow).

Cold / persisted but not live (VERIFIED):
- `ctx.sessionQuery` is always mounted by the base (`session-query-sqlite` row,
  `SDK/dsh-base/cordis.patch.yml:157-161`; "`openAt: never` keeps `ctx.sessionQuery`
  mounted", `:149-152`).
- `ctx.sessionQuery.listSessions()` → "Every logical session, newest first, with `live` and
  `persisted` availability flags" (`SDK/dsh-session-query/README.md:34`);
  `readSurface(id)` → "the complete current model surface"
  (`SDK/dsh-session-query/README.md:39`). Implementation returns
  `{ session: header, inheritedEventCount, capturedThroughSeq, events }` where `events` are
  the current surface **SessionEvents** (`SDK/dsh-session-query/lib/index.js:1168-1176`,
  `:856-862`); i.e. the caller folds `user/message`/`assistant/message` events itself.
- `readSession(id)` returns the full replay-validated raw log
  (`SDK/dsh-session-query/lib/index.js:1081-1089`).

Incremental subscription (VERIFIED event name): `ctx.on('session/event', (session, event) =>
…)` — shipped consumer at `SDK/dsh-client-file-upload/lib/index.js:185-190`
(plus `'session/disposed'`). Only needed if the side panel re-reads context reactively; a
per-question read is simpler and sufficient.

**Which session is "current"?** There is no host-side "current session" concept: every
controller endpoint is addressed by an explicit `sessionId`/address ("it reads a named
`sessionId` parameter, otherwise the first object argument's `sessionId` or `address`",
`SDK/dsh-api-session-controller/README.md`, access-control paragraph). The browser owns the
selection; the client `sessions` service is provided by the session controller's client half
(`SDK/dsh-api-session-controller/lib/client.js:3856`:
`rootCtx.reflect.provide("sessions", this, void 0)`).
⇒ **Design decision**: the side-ask client sends `{ sessionId }` with each request.
**ASSUMED fallback** when the client cannot determine it: pick
`ctx.sessionQuery.listSessions()[0]` (newest first) or the last live session
`ctx.sessions.list().at(-1)`.

---

## Minimal LLM call recipe (copy-pasteable, no main-session writes)

Dependencies: host `ctx` with `llm` and (optionally) `agentDefaultModel` reached through
`ctx.get(...)`; `BlockAssembler` importable from `@deepseek-ai/dsh-llm` (public export,
`SDK/dsh-llm/lib/index.js:2433`). No provider SDK import.

```js
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

/** Run one side-ask turn. Never appends to any Session. */
export async function callSideModel(ctx, {
  system, history = [], question, maxTokens = 1200, temperature = 0.4,
  timeoutMs = 120_000, signal: external, onDelta,
}) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw Object.assign(new Error('llm service unavailable'), { code: 'NO_ADAPTER' })

  // 1. Route: explicit config wins, else the host's configured default.
  let route = { provider: '', model: '' }
  const cfg = /* readConfig() plain values */ { provider: '', model: '' }
  if (cfg.provider && cfg.model) route = { provider: cfg.provider, model: cfg.model }
  else {
    const def = ctx.get('agentDefaultModel')
    if (def !== undefined) route = def.currentSelection()   // { provider, model, reasoningEffort? }
  }
  if (!route.provider || !route.model) throw Object.assign(new Error('no model route'), { code: 'NO_ADAPTER' })

  // 2. Cancellation: external signal + deadline, both feed one controller.
  const controller = new AbortController()
  const onAbort = () => controller.abort(external.reason)
  external?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('sideask timeout')), timeoutMs)

  try {
    const messages = [
      ...history,                                   // [{role:'user'|'assistant', content:[{type:'text',text}]}]
      { role: 'user', content: [{ type: 'text', text: question }] },
    ]
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      messages,
      ...(system === undefined ? {} : { system }),
      maxTokens,
      temperature,
      signal: controller.signal,
    })) {
      assembler.push(chunk)
      if (chunk.type === 'text-delta' && onDelta) onDelta(chunk.text)
    }

    const finish = assembler.finish                   // always one of: stop | tool-calls | max-tokens | aborted | error
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const failure = finish.failure ?? {}
      throw Object.assign(new Error(failure.message ?? 'model call failed'),
        { code: failure.code ?? (finish.kind === 'aborted' ? 'ABORTED' : 'PROVIDER_ERROR') })
    }
    const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
    return { text, usage: assembler.usage ?? {}, truncated: finish.kind === 'max-tokens', route }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}
```

Notes on this recipe:
- **Importing `BlockAssembler` is optional.** It is a public export, but it creates a
  dependency on `@deepseek-ai/dsh-llm`; a plugin that does not want that peer can simply read
  the stream it already iterates: keep appending `chunk.text` for `type === 'text-delta'`
  and take the single `chunk.type === 'finish'` chunk as the terminal outcome — both are in
  the `StreamChunk` union (`SDK/dsh-llm/lib/typert.host.js:595`) and no assembly is needed
  for a text-only answer. Add `@deepseek-ai/dsh-llm` to `peerDependencies` (as
  `dsh-cost-meter` does for `@deepseek-ai/dsh-credentials` in its package.json) only if the
  assembler or message constructors are imported.
- `messages` entries are valid `RequestUserInput` values (`role:'user'` + text block, no
  `id`/`source`) — `SDK/dsh-llm/lib/typert.host.js:551`.
- For multi-turn history use `createUserMessage({ content, source })` /
  `createAssistantMessage({ content, source })` (`SDK/dsh-llm/lib/types/message.js:53,64`)
  instead of literal objects, because `MessageBase` requires `id` and `source`
  (`SDK/dsh-llm/lib/typert.host.js`, `MessageBase`). **Without that import an assistant turn
  cannot be a request message** (`RequestUserInput` only allows `role:'user'`); the
  import-free fallback is to fold earlier side-thread turns into the single user input, e.g.
  `history.map(m => `${m.role}: ${m.text}`).join('\n') + '\n\n' + question`.
- `finish` from `BlockAssembler` defaults to `{kind:'stop'}` if the stream ends without one
  (`SDK/dsh-llm/lib/types/assembler.js`).
- Streamed deltas can be forwarded to the browser as they arrive — the `/api` bridge writes
  `Response.body` incrementally (`SDK/dsh-client-connection/lib/index.js:95-101`).
- `system` is a top-level field, not a message (`GenerateOptions.system`).
- No `session.append`, no `ctx.sessions.create` in this path ⇒ the main session is untouched.
  Do **not** pass `sessionId` unless deliberate: it only adds a request header
  (`SDK/dsh-llm-deepseek/lib/index.js:2244`).

### Minimal host endpoint recipe

```js
// inside apply(ctx, config), after ctx.inject(['connection'], ...) or directly:
const dispose = ctx.connection.fetch.register({
  path: '/api/sideask.ask',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: async (request) => {
    const { sessionId, question } = await request.json()
    // read transcript (read-only)
    const session = ctx.sessions?.get(sessionId)
    const messages = session === undefined ? [] : session.deriveMessages()
    // build budgeted context, then call the model with request.signal
    const result = await callSideModel(ctx, { system: SYSTEM, history, question, signal: request.signal })
    return Response.json({ ok: true, text: result.text, route: result.route })
  },
})
// dispose() is fiber-owned already: connection.fetch.register returns owner.effect(...)
```
Registered routes are removed automatically with the plugin fiber
(`SDK/dsh-client-connection/lib/index.js:847-853`). If a streaming reply is wanted, return a
`Response` whose body is a `ReadableStream` (SSE) — the bridge forwards chunks.

Browser half: `fetch('api/sideask.ask', { method:'POST', headers:{'content-type':
'application/json'}, credentials:'same-origin', body: JSON.stringify({ sessionId, question }),
signal })` — route is document-relative exactly like `SDK/dsh-session-log-export/lib/client.js:12`.

---

## Capability table

| capability | exact API | evidence (file:line) | VERIFIED/ASSUMED | fallback |
|---|---|---|---|---|
| Model call (stream) | `ctx.llm.stream(GenerateOptions)` → `AsyncIterable<StreamChunk>` | `SDK/dsh-llm/README.md:50-57`; `SDK/dsh-llm/lib/index.js:2398-2402` | VERIFIED | none needed |
| Options fields | `{provider, model, reasoningEffort?, messages, system?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?}` | `SDK/dsh-llm/lib/typert.host.js:359` (GenerateOptions) | VERIFIED | build options from `prepareCall().config` |
| Chunk protocol | `block-start\|text-delta\|reasoning-delta\|tool-call-delta\|block-end\|usage\|finish` | `SDK/dsh-llm/lib/typert.host.js:595` | VERIFIED | none |
| Finish reasons | `stop\|tool-calls\|max-tokens\|aborted{failure}\|error{failure}` | `SDK/dsh-llm/lib/typert.host.js:355` | VERIFIED | — |
| Failure codes | `LlmFailure.code` (`NO_ADAPTER`, `MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `ACCOUNT_QUOTA`, …) | `SDK/dsh-llm/README.md:95`; `SDK/dsh-llm/lib/typert.host.js:411` | VERIFIED | treat unknown code as `PROVIDER_ERROR` |
| Cancellation | pass `signal`; terminal `{kind:'aborted', failure}` | `SDK/dsh-llm/lib/index.js:2407-2418`; `SDK/dsh-llm/lib/typert.host.js:359` | VERIFIED | AbortController + timer (recipe) |
| Text assembly | `new BlockAssembler(); assembler.push(chunk); assembler.blocks()/usage/finish` | `SDK/dsh-llm/lib/types/assembler.js`; usage in `SDK/dsh-session-title-llm/lib/index.js:209-215` | VERIFIED | join `text-delta`s manually |
| Default route | `ctx.get('agentDefaultModel').currentSelection()` → `{provider, model, reasoningEffort?}` | `SDK/dsh-agent-default-model/lib/index.js:38-45`; `PROFILE/cordis.patch.yml:4-9` | VERIFIED | `ctx.llm.listProviders()[0].id` + config model |
| Provider list | `ctx.llm.listProviders()` → `{id,name}[]` | `SDK/dsh-llm/README.md:59`; `LlmProviderInfo` in `SDK/dsh-llm/lib/typert.host.js` | VERIFIED | config pin |
| Context window | `await ctx.llm.resolveModelInfo(provider, model)` → `.context.contextWindow`, `.defaultMaxTokens` | `SDK/dsh-llm/lib/index.js:2116`; `LlmResolvedModelInfo` `SDK/dsh-llm/lib/typert.host.js:467` | VERIFIED | config default budget |
| Token estimate | `ctx.tokenMeter.estimateMessage(message)` / `measure(session)` | `SDK/dsh-token-meter/README.md:36-40`; `SDK/dsh-token-meter/lib/index.js:846,907-909` | VERIFIED | chars/4 heuristic |
| Live transcript | `ctx.sessions.get(id).deriveMessages()` → frozen `Message[]` | `SDK/dsh-session/lib/index.js:1681-1696,1999-2008`; `SDK/dsh-session/README.md:44` | VERIFIED | `sessionQuery.readSurface` |
| Cold transcript | `ctx.sessionQuery.readSurface(id)` → `{session, capturedThroughSeq, events}` (surface events) | `SDK/dsh-session-query/lib/index.js:1168-1176,856-862`; README `:39` | VERIFIED | `readSession(id)` + own fold |
| Session enumeration | `ctx.sessionQuery.listSessions()` newest-first; `ctx.sessions.list()` live only | `SDK/dsh-session-query/README.md:34`; `SDK/dsh-session/lib/index.js:2006-2008` | VERIFIED | — |
| Event subscription | `ctx.on('session/event', (session,event)=>…)` | `SDK/dsh-client-file-upload/lib/index.js:185-190` | VERIFIED | poll per question |
| Current session | client supplies `sessionId` (no host "current" notion) | `SDK/dsh-api-session-controller/README.md` (access-control paragraph) | ASSUMED | `listSessions()[0]` / `sessions.list().at(-1)` |
| Browser API route | `ctx.connection.fetch.register({path:'/api/…', methods, requestBody, fetch})` | `SDK/dsh-client-connection/lib/index.js:731-735,840-854,973-977`; consumer `SDK/dsh-session-log-export/lib/index.js:798-811` | VERIFIED | `connection.rpc.handle` |
| Route auth | host denies unauthenticated/cross-site before dispatch | `SDK/dsh-client-connection/lib/index.js:1044-1058,820-839` | VERIFIED | raw webServer + own origin check |
| Streaming reply | return `Response` with `ReadableStream` body; bridge forwards chunks | `SDK/dsh-client-connection/lib/index.js:95-101` | VERIFIED (transport) / ASSUMED (SSE framing) | buffer full answer |
| Unary RPC channel | `ctx.connection.rpc.handle(channel, (endpoint,payload,signal,peer)=>…)`; client `ctx.connection.rpc.call(...)` | `SDK/dsh-client-connection/lib/index.js:723-729,855-872,909-914`; client `lib/client.browser.js:1209-1239,1443` | VERIFIED | `/api` fetch route |
| Raw HTTP route | `ctx.webServer.register({kind:'exact'|'prefix', path, handler|resource})` → disposer | `SDK/dsh-host-webserver/README.md:61-63`; `WP/lib/http.js:144-156` | VERIFIED | — |
| Route auth (raw) | none; plugin must check Origin/`Sec-Fetch-Site` itself | `SDK/dsh-host-webserver/README.md:132`; `WP/lib/http.js:25-43` | VERIFIED | mount under `/api` instead |
| Typed Remote (Typert) | `@Remote` + generated `./typert` artifacts | `SDK/dsh-typert-protocol/README.md`; `SDK/dsh-typert-loader/README.md` | VERIFIED (requires codegen) | do not use |
| Plugin config schema | `export const Config = z.object({ field: z.…().default(x).volatile() })` | `WP/lib/index.js:47-72`; `SDK/schemastery/lib/index.mjs:235-237` | VERIFIED | plain object without schema (loses UI/validation) |
| Live config values | volatile fields arrive as `{get()}`; unwrap each read | `WP/lib/index.js:232-253`; `SDK/cordis/README.md:105` | VERIFIED | read once (settings need remount) |
| Service provide/consume | `ctx.provide(name,value)` / `ctx.get(name)` / `ctx.inject([...],cb)` / `ctx.effect(fn,label)` | `SDK/cordis/lib/index.js:463,1366,1384-1404,1672-1678`; `WP/lib/index.js:575-586` | VERIFIED | module-level singleton |
| Row registration | `cordis.patch.yml` `- insert: [{id, name}]`; `package.json.dsh.bundle.patch` | `WP/cordis.patch.yml:1-6`; `WP/package.json:27-38`; `SDK/dsh-package-manifest/README.md` | VERIFIED | — |
| Profile install | `dsh plugin --profile <p> add link:<dir>`; bundle listed in `dsh.profile.bundles` | `SDK/dsh/README.md:18,46`; `PROFILE/package.json:10-16` | VERIFIED | hand-edit profile package.json + node_modules |
| Client bundle | `package.json.dsh.client = {platform:'web'}` + `exports["./client"]` | `SDK/dsh-client-modules/README.md:34`; `SDK/dsh-client-modules/lib/index.js:93,98,800` | VERIFIED | none |
| `immediately` semantics | boot-tier prefetch flag; boolean validated | `SDK/dsh-client-modules/lib/index.js:93,800`; shell `prefetchImmediateTier()` in `SDK/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196` | ASSUMED (true = load at boot) | set `true` for a hotkey-only panel |
| KV persistence | `defineDomain` + `ctx.storageDomain.open(spec)` → `domain.table(t).put/get` | `SDK/dsh-storage-domain/README.md:36-52`; `SDK/dsh-storage-domain/lib/index.js:480` | VERIFIED | own JSON file under `$DSH_HOME/storages/<p>/` (precedent `WP/lib/index.js:342-369`) |
| Storage root | base mounts `storage-json` with `root: dshHomePath('storages')` | `SDK/dsh-base/cordis.patch.yml:182-185` | VERIFIED | `process.env.DSH_HOME` |
| Permissions declaration | `dshhub.*` metadata (display/surfaces/`permissions.network`) | `WP/package.json:40-60`; zero `dshhub` reads in `SDK/**/lib/*.js` | ASSUMED (metadata, not a runtime grant) | declare nothing; no host API needs it |
| LLM credential handling | adapter resolves keys per request; plugin never touches keys | `SDK/dsh-base/cordis.patch.yml:527-529`; `SDK/dsh-llm/README.md:95` | VERIFIED | — |
| Host-scope access control | gateway/Remote only; `connection.fetch` runs as owner Peer | `SDK/dsh-api-session-controller/README.md`; `SDK/dsh-client-connection/lib/index.js:830` | VERIFIED | — |
| Disposal | every registration returns a disposer; `ctx.effect` auto-disposes | `SDK/cordis/lib/index.js:463,1384-1404`; `WP/lib/index.js:575-586`; `SDK/dsh-client-connection/lib/index.js:847-853` | VERIFIED | manual dispose in `process.on('exit')` (not recommended) |

---

## 需要宿主提供的能力清单（side-ask 依赖项，逐条）

1. **`ctx.llm` 服务** —— 用 `ctx.llm.stream()` 调用宿主已配置的模型，避免自建 HTTP/密钥；没有它就无法回答。
2. **`ctx.get('agentDefaultModel').currentSelection()`** —— 取用户当前选择的 provider/model/reasoningEffort，保证侧问与主线同模型；无此服务则退回插件 config 或 `listProviders()[0]`。
3. **`ctx.sessions`（`get(id)` / `list()` / `session.deriveMessages()`）** —— 只读拿到主会话模型可见消息，作为上下文来源；这是"读主线"的唯一必要宿主能力。
4. **`ctx.sessionQuery`（`listSessions()` / `readSurface(id)`）** —— 会话未 live 或客户端只给 sessionId 时的冷读兜底；base 已默认挂载。
5. **`ctx.connection.fetch.register`（`/api/...` 路由）** —— 在浏览器鉴权与 Host/Origin 防护之后暴露自定义接口，并支持流式响应；避免自写鉴权与 Origin 校验。
6. **`ctx.connection.rpc.handle`（可选）** —— 仅需一元请求/响应时的更简 RPC 通道；与上一条二选一即可。
7. **`ctx.webServer.register`（兜底）** —— 无 `/api` 组合（例如桌面 file:// 变体）时的原始路由能力；鉴权需插件自理。
8. **`ctx.tokenMeter.estimateMessage/measure`** —— 为"token 预算化上下文"提供统一估算口径；缺失时用字符数/4 近似。
9. **`ctx.llm.resolveModelInfo(provider, model)`** —— 取 `context.contextWindow` / `defaultMaxTokens` 来设定预算与 `maxTokens` 上限；缺失时用插件配置默认值。
10. **`ctx.effect` / `ctx.inject` / `ctx.provide`（cordis 生命周期）** —— 让定时器、路由、监听随插件卸载自动释放，避免热重载泄漏；这是所有注册的清理约定。
11. **`ctx.get('llm')` 不可用时的显式失败通道** —— 插件需把 `NO_ADAPTER`/`MISSING_CREDENTIAL` 等错误码原样带回前端（而不是空回答），宿主已提供稳定错误码。
12. **`$DSH_HOME/storages/`（或 `ctx.storageDomain`）** —— 侧问线程的持久化位置；宿主不强制，但沿用该目录符合产品约定，便于备份/清理。

---

## Remaining ASSUMED items / risks (with fallbacks)

1. **`dshhub.permissions` is not enforced** (no SDK reader found). Keep it descriptive only; the
   scaffold's `permissions.host` names are unproven → drop or mark non-authoritative.
2. **Client `ctx.connection.rpc.call` uses the fetch-backed caller in the Web page.** If the
   shell supplies `__DSH_TRANSPORT__.rpc`, the semantics could differ → prefer the `/api`
   fetch route for the client half.
3. **`dsh.client.immediately`** meaning is inferred from the boot-tier prefetch; for a
   hotkey-driven panel with no launcher UI, set `true` (as spend-wallpaper does).
4. **`ctx.get('llm')` availability at plugin startup**: `llm` row is in the base plane, so it
   should be present; still guard and surface `NO_ADAPTER` rather than crashing activation.
5. **`DSH_HOME` resolution**: no exported home-path service was confirmed; `process.env.DSH_HOME
   ?? path.join(os.homedir(), '.dsh')` matches the base patch's `dshHomePath('storages')`
   convention (`SDK/dsh-base/cordis.patch.yml:141,185`). ASSUMED.
6. **Request-immutability invariant** ("Model-visible ⟺ logged",
   `SDK/dsh-llm/README.md:12`): not enforced for auxiliary callers; keep the side thread's
   exact request in our own store so it stays reconstructable.
7. **`ctx.storageDomain` from a plain plugin**: VERIFIED the facility exists and is mounted by
   base, but the consumer registration path (`defineDomain` in the owning package + `open`)
   presumes a zod schema; the scaffold's plain JSON file is the low-risk path.
