/**
 * Host ↔ model gateway.
 *
 * This is a thin adapter over the host's model-call service. It exists so the
 * rest of the plugin can be tested without a provider, and so every place that
 * touches provider specifics is in one reviewable file.
 *
 * VERIFIED host surface used here (docs/research/host-api.md):
 * - `ctx.llm.stream({ provider, model, messages, signal, temperature, maxTokens })`
 *   is an async iterable of chunks; the protocol is
 *   `block-start | text-delta | reasoning-delta | tool-call-delta | block-end |
 *    usage | finish`, and the stream always ends with exactly one `finish`.
 * - `ctx.llm.listProviders()` → provider metadata in registration order.
 * - `ctx.get('agentDefaultModel').currentSelection()` → `{ provider, model }`.
 *
 * The plugin never creates a session, never writes history, and never calls an
 * agent loop: one question in, one answer out. That is the mechanical reason
 * the side conversation cannot pollute the main one.
 */

import type { SideAskError } from '../shared/contract.js'
import { fromFailure, makeError } from '../shared/errors.js'

/** Minimal structural types for the injected services (no runtime import). */
export interface LlmStreamChunk {
  type: string
  index?: number
  text?: string
  usage?: LlmUsage
  reason?: { kind?: string; failure?: unknown }
}

export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface LlmProviderInfo {
  id?: string
  provider?: string
  [key: string]: unknown
}

export interface LlmService {
  stream(options: Record<string, unknown>): AsyncIterable<LlmStreamChunk>
  listProviders(): LlmProviderInfo[]
}

export interface DefaultModelService {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/** Caller-facing options for one side-ask call. */
export interface CallOptions {
  /** Instruction preamble, sent as its own user-role input. */
  instruction: string
  /** The question plus context body. */
  body: string
  signal: AbortSignal
  maxTokens: number
  temperature: number
}

export interface CallResult {
  text: string
  usage: { promptTokens: number; completionTokens: number }
  /** Set when the provider reported a failure or the answer hit the cap. */
  failure: SideAskError | null
  /** True when the model stopped at max-tokens (partial answer). */
  truncated: boolean
}

export interface RouteInfo {
  provider: string
  model: string
  /** How the route was chosen, for diagnostics. */
  source: 'config' | 'default-model' | 'first-provider'
}

/**
 * Resolve the provider/model pair for a side-ask call.
 *
 * Order: explicit plugin config → host default model selection → first
 * registered provider (with an empty model, which the adapter may reject; the
 * caller then surfaces `NO_ADAPTER`). Empty config is the normal case.
 */
export function resolveRoute(
  config: { provider: string; model: string },
  llm: LlmService | undefined,
  defaultModel: DefaultModelService | undefined,
): RouteInfo | { error: SideAskError } {
  if (llm === undefined) {
    return { error: makeError('NO_ADAPTER', '宿主未提供模型服务（ctx.llm 不可用）') }
  }
  if (config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model, source: 'config' }
  }

  if (defaultModel !== undefined) {
    try {
      const selection = defaultModel.currentSelection()
      if (selection.provider.length > 0 && selection.model.length > 0) {
        return { provider: selection.provider, model: selection.model, source: 'default-model' }
      }
    } catch {
      // Fall through to provider discovery.
    }
  }

  let providers: LlmProviderInfo[] = []
  try {
    providers = llm.listProviders()
  } catch {
    providers = []
  }
  const first = providers[0]
  const providerId = first === undefined ? undefined : (first.id ?? first.provider)
  if (typeof providerId === 'string' && providerId.length > 0 && config.model.length > 0) {
    return { provider: providerId, model: config.model, source: 'first-provider' }
  }
  if (typeof providerId === 'string' && providerId.length > 0 && config.provider.length > 0) {
    return { provider: config.provider, model: config.model, source: 'config' }
  }
  return {
    error: makeError(
      'NO_ADAPTER',
      '没有可用的模型路由：请在插件设置里指定 provider/model，或在宿主中选择默认模型',
    ),
  }
}

/** Provider ids, for diagnostics and the settings hint. */
export function listProviderIds(llm: LlmService | undefined): string[] {
  if (llm === undefined) return []
  try {
    return llm
      .listProviders()
      .map((entry) => entry.id ?? entry.provider)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

/**
 * Run one model call and collect the answer.
 *
 * Cancellation: the host's stream honours `signal`, and we also translate a
 * `finish` chunk with `kind: 'aborted'` into the `ABORTED` error code so the
 * caller has exactly one place to look.
 */
export async function callModel(
  llm: LlmService,
  route: { provider: string; model: string },
  options: CallOptions,
  onDelta: (text: string) => void,
): Promise<CallResult> {
  let text = ''
  let usage: LlmUsage = {}
  let failure: SideAskError | null = null
  let truncated = false

  const messages = [
    { role: 'user', content: [{ type: 'text', text: options.instruction }] },
    { role: 'user', content: [{ type: 'text', text: options.body }] },
  ]

  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      signal: options.signal,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    })
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta': {
          const delta = typeof chunk.text === 'string' ? chunk.text : ''
          if (delta.length > 0) {
            text += delta
            onDelta(delta)
          }
          break
        }
        case 'usage': {
          usage = chunk.usage ?? {}
          break
        }
        case 'finish': {
          const kind = chunk.reason?.kind
          if (kind === 'error') {
            failure = fromFailure(chunk.reason?.failure, 'PROVIDER_ERROR')
          } else if (kind === 'aborted') {
            failure = makeError('ABORTED', '请求已取消')
          } else if (kind === 'max-tokens') {
            truncated = true
          }
          break
        }
        default:
          // reasoning-delta / tool-call-delta / block markers are not part of a
          // side answer: one text block, no tools.
          break
      }
    }
  } catch (error) {
    if (options.signal.aborted) failure = makeError('ABORTED', '请求已取消')
    else failure = fromFailure(error, 'PROVIDER_ERROR')
  }

  return {
    text,
    usage: {
      promptTokens: Number(usage.inputTokens ?? 0),
      completionTokens: Number(usage.outputTokens ?? 0),
    },
    failure,
    truncated,
  }
}
