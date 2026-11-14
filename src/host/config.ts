/**
 * Plugin configuration: schemastery schema + a normalised reader.
 *
 * Verified host behaviours this file depends on (see docs/research/host-api.md):
 * - a plugin exports `Config` built with `@deepseek-ai/schemastery`;
 * - the loader passes the *raw* config to `apply(ctx, config)`, and fields
 *   declared `.volatile()` arrive as getter refs (`{ get() }`) so a settings
 *   change applies without remounting the plugin.
 *
 * Therefore every read goes through `readConfig()`, which unwraps refs and
 * clamps values. Nothing else in the host half touches the raw config object.
 */

import z from '@deepseek-ai/schemastery'

import type { DockCorner, SideAskSettings } from '../shared/contract.js'

/** Host-side resolved configuration (plain values, no getter refs). */
export interface HostConfig extends SideAskSettings {
  enabled: boolean
  answerMaxTokens: number
  temperature: number
  requireCitations: boolean
  customRedactionPatterns: string[]
  /** Prior side-thread turns embedded in the prompt. */
  historyTurns: number
  maxThreads: number
  maxMessagesPerThread: number
  /** Wall-clock ceiling for one model call. */
  requestTimeoutMs: number
}

export const DEFAULT_HOTKEY = 'Alt+Shift+A'

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  /** Empty provider/model mean "use the host's default model selection". */
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  answerMaxTokens: z.number().min(64).max(8192).default(1200).volatile(),
  temperature: z.number().min(0).max(2).default(0.4).volatile(),
  recentMessageLimit: z.number().min(2).max(80).default(12).volatile(),
  contextBudgetTokens: z.number().min(256).max(64000).default(3000).volatile(),
  autoSummary: z.boolean().default(true).volatile(),
  requireCitations: z.boolean().default(true).volatile(),
  readContext: z.boolean().default(true).volatile(),
  redactSensitive: z.boolean().default(true).volatile(),
  persistHistory: z.boolean().default(true).volatile(),
  defaultCorner: z.union(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right').volatile(),
  hotkey: z.string().default(DEFAULT_HOTKEY).volatile(),
  customRedactionPatterns: z.array(z.string()).default([]).volatile(),
  historyTurns: z.number().min(0).max(40).default(8).volatile(),
  maxThreads: z.number().min(1).max(200).default(30).volatile(),
  maxMessagesPerThread: z.number().min(10).max(1000).default(200).volatile(),
  requestTimeoutMs: z.number().min(5000).max(600000).default(120000).volatile(),
})

const CORNERS: DockCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Unwrap one config field. Volatile fields are `{ get() }` refs; plain fields
 * (defaults from the schema) are values. Both shapes must work.
 */
function unwrap(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    try {
      return (value as { get: () => unknown }).get()
    } catch {
      return undefined
    }
  }
  return value
}

/** Read the raw `apply()` config into a plain, clamped object. */
export function readConfig(raw: unknown): HostConfig {
  const source = (raw ?? {}) as Record<string, unknown>
  const value = (key: string): unknown => unwrap(source[key])

  const corner = str(value('defaultCorner'), 'top-right') as DockCorner
  const hotkey = str(value('hotkey'), DEFAULT_HOTKEY).trim()
  const patterns = value('customRedactionPatterns')

  return {
    enabled: bool(value('enabled'), true),
    provider: str(value('provider'), '').trim(),
    model: str(value('model'), '').trim(),
    answerMaxTokens: Math.trunc(clamp(Number(value('answerMaxTokens')), 64, 8192, 1200)),
    temperature: clamp(Number(value('temperature')), 0, 2, 0.4),
    recentMessageLimit: Math.trunc(clamp(Number(value('recentMessageLimit')), 2, 80, 12)),
    contextBudgetTokens: Math.trunc(clamp(Number(value('contextBudgetTokens')), 256, 64000, 3000)),
    autoSummary: bool(value('autoSummary'), true),
    requireCitations: bool(value('requireCitations'), true),
    readContext: bool(value('readContext'), true),
    redactSensitive: bool(value('redactSensitive'), true),
    persistHistory: bool(value('persistHistory'), true),
    defaultCorner: CORNERS.includes(corner) ? corner : 'top-right',
    hotkey: hotkey.length > 0 && hotkey.length <= 40 ? hotkey : DEFAULT_HOTKEY,
    customRedactionPatterns: Array.isArray(patterns)
      ? patterns.filter((entry): entry is string => typeof entry === 'string').slice(0, 16)
      : [],
    historyTurns: Math.trunc(clamp(Number(value('historyTurns')), 0, 40, 8)),
    maxThreads: Math.trunc(clamp(Number(value('maxThreads')), 1, 200, 30)),
    maxMessagesPerThread: Math.trunc(clamp(Number(value('maxMessagesPerThread')), 10, 1000, 200)),
    requestTimeoutMs: Math.trunc(clamp(Number(value('requestTimeoutMs')), 5000, 600000, 120000)),
  }
}

/**
 * The client-facing projection: everything the browser needs to render and to
 * budget context, and nothing about transports or limits it cannot honour.
 */
export function toSettings(config: HostConfig): SideAskSettings {
  return {
    recentMessageLimit: config.recentMessageLimit,
    autoSummary: config.autoSummary,
    contextBudgetTokens: config.contextBudgetTokens,
    readContext: config.readContext,
    redactSensitive: config.redactSensitive,
    persistHistory: config.persistHistory,
    defaultCorner: config.defaultCorner,
    hotkey: config.hotkey,
    provider: config.provider,
    model: config.model,
  }
}
