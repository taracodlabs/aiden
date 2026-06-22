// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// providers/router.ts — Smart multi-API routing engine
// Round-robin across available keys, auto-marks 429s, falls back to Ollama

import { loadConfig, saveConfig, APIEntry, CustomProviderEntry } from './index'
import { ollamaProvider } from './ollama'
import { createGroqProvider } from './groq'
import { createOpenRouterProvider } from './openrouter'
import { createRequestyProvider } from './requesty'
import { createGeminiProvider } from './gemini'
import { createCerebrasProvider } from './cerebras'
import { createNvidiaProvider } from './nvidia'
import { createBOAProvider } from './boa'
import { createMistralProvider } from './mistral'
import { createCustomProvider } from './custom'
import { Provider } from './types'
import { discoverLocalModels, DiscoveredModels } from '../core/modelDiscovery'
import { getDefaultModel } from '../core/modelRegistry'

// Per-provider rate-limit windows — tuned to actual reset characteristics.
// Previous flat 1-hour window was far too conservative for fast-reset APIs.
const RATE_LIMIT_WINDOWS: Record<string, number> = {
  groq:       15  * 1000,  // Groq free tier resets in ~10–15 s
  gemini:     90  * 1000,  // Gemini resets in ~60–90 s
  openrouter: 30  * 1000,  // OpenRouter rarely rate-limits; 30 s is safe
  requesty:   30  * 1000,  // Requesty gateway — rarely rate-limits; 30 s is safe
  together:   30  * 1000,
  mistral:    60  * 1000,
  cohere:     60  * 1000,
  deepseek:   60  * 1000,
  openai:     60  * 1000,
  anthropic:  60  * 1000,
  cerebras:   30  * 1000,
  nvidia:     60  * 1000,
  cloudflare: 30  * 1000,
  github:     30  * 1000,
  boa:        30  * 1000,
  custom:     30  * 1000,  // user-defined endpoints — 30 s default
  ollama:     0,           // local — never rate-limited
}
const DEFAULT_RATE_LIMIT_MS = 60 * 1000 // 1 minute fallback

// In-memory response-time tracking (EWMA per provider)
// Separate from the config file so it resets on restart without persisting stale values.
const responseTimesMs = new Map<string, number>()

// In-memory consecutive failure tracking for exponential backoff.
// Resets to 0 on markHealthy; increments on each markRateLimited call.
const consecutiveFailures = new Map<string, number>()

// ── Local model discovery cache ───────────────────────────────
// Populated once at startup via initLocalModels(). Read-only after that.

let localModels: DiscoveredModels = {
  planner: null, responder: null, coder: null, fast: null, all: [],
}

export function getLocalModels(): DiscoveredModels { return localModels }

export async function initLocalModels(): Promise<DiscoveredModels> {
  localModels = await discoverLocalModels()

  if (localModels.all.length > 0) {
    console.log('[ModelDiscovery] Found local models:')
    console.log('  Planner:   ', localModels.planner)
    console.log('  Responder: ', localModels.responder)
    console.log('  Coder:     ', localModels.coder)
    console.log('  Fast:      ', localModels.fast)

    // Persist discovered assignments to config so agentLoop can read them
    const config = loadConfig()
    config.ollama = {
      ...(config.ollama || { fallbackModels: [], baseUrl: 'http://localhost:11434' }),
      model:        localModels.responder || config.ollama?.model || 'gemma4:e4b',
      plannerModel: localModels.planner   || undefined,
      coderModel:   localModels.coder     || undefined,
      fastModel:    localModels.fast      || undefined,
    }
    saveConfig(config)
  } else {
    console.log('[ModelDiscovery] No local models found — cloud only')
  }

  return localModels
}

// ── Per-task Ollama model selector ────────────────────────────

export function getOllamaModelForTask(
  task: 'planner' | 'responder' | 'executor',
): string {
  // Prefer user overrides from config, then discovered models, then safe default
  const config = loadConfig()
  switch (task) {
    case 'planner':
      return config.ollama?.plannerModel  || localModels.planner   || localModels.responder || 'llama3.2'
    case 'executor':
      return config.ollama?.fastModel     || localModels.fast      || localModels.responder || 'llama3.2'
    case 'responder':
      return config.ollama?.model         || localModels.responder || 'llama3.2'
  }
}

// ── Provider factory ──────────────────────────────────────────

function buildProvider(entry: APIEntry): Provider {
  const key = entry.key.startsWith('env:')
    ? process.env[entry.key.replace('env:', '')] || ''
    : entry.key

  switch (entry.provider) {
    case 'groq':       return createGroqProvider(key)
    case 'openrouter': return createOpenRouterProvider(key)
    case 'requesty':   return createRequestyProvider(key)
    case 'gemini':     return createGeminiProvider(key)
    case 'cerebras':   return createCerebrasProvider(key)
    case 'nvidia':     return createNvidiaProvider(key)
    case 'boa':        return createBOAProvider(key)
    case 'mistral':    return createMistralProvider(key)
    case 'custom':     return createCustomProvider(entry.baseUrl || '', key, entry.name)
    default:           return ollamaProvider
  }
}

// ── Convert a CustomProviderEntry to a transient APIEntry ─────
// Lets custom providers flow through the same scoring + routing
// machinery as built-in APIs without modifying that logic.

function customToAPIEntry(cp: CustomProviderEntry): APIEntry {
  return {
    name:        cp.id,
    provider:    'custom',
    key:         cp.apiKey,
    model:       cp.model,
    enabled:     cp.enabled,
    rateLimited: false,
    usageCount:  0,
    baseUrl:     cp.baseUrl,
  }
}

// ── Merge custom providers into an APIEntry pool ──────────────
// Inserts enabled custom providers in tier order before Ollama.
// Skips providers whose baseUrl is empty.

function mergeCustomProviders(base: APIEntry[]): APIEntry[] {
  const config  = loadConfig()
  const customs = (config.customProviders || [])
    .filter(cp => cp.enabled && cp.baseUrl.trim().length > 0)
  // Tier-sort the combined pool: customs use their tier, base entries default to tier 99.
  // JS Array.sort is stable (ES2019+/Node 11+) — insertion order preserved within same tier.
  const ranked = [
    ...base.map(e => ({ entry: e, tier: 99 })),
    ...customs.map(cp => ({ entry: customToAPIEntry(cp), tier: cp.tier ?? 99 })),
  ]
  ranked.sort((a, b) => a.tier - b.tier)
  return ranked.map(r => r.entry)
}

// ── Auto-reset stale rate limits ──────────────────────────────

function autoResetExpiredLimits(): boolean {
  const config  = loadConfig()
  let   changed = false

  config.providers.apis = config.providers.apis.map(api => {
    if (api.rateLimited && api.rateLimitedAt) {
      // Use stored backoff window if available (set by exponential markRateLimited),
      // otherwise fall back to the static per-provider window.
      const window = (api as any).rateLimitWindow
        ?? RATE_LIMIT_WINDOWS[api.provider]
        ?? DEFAULT_RATE_LIMIT_MS
      if (window === 0 || Date.now() - api.rateLimitedAt > window) {
        changed = true
        const { rateLimitedAt, ...rest } = api as any
        return { ...rest, rateLimited: false, rateLimitWindow: undefined }
      }
    }
    return api
  })

  if (changed) saveConfig(config)
  return changed
}

// ── Diagnose WHY the provider pool is empty ─────────────────

export function diagnoseProviderPool(): {
  state: 'ok' | 'unconfigured' | 'rate-limited' | 'mixed'
  noKeyCount: number
  rateLimitedCount: number
  disabledCount: number
  enabledCount: number
  message: string
} {
  const config  = loadConfig()
  const allApis = mergeCustomProviders(config.providers.apis)
  const enabled = allApis.filter(a => a.enabled)
  const disabledCount = allApis.length - enabled.length

  let noKey = 0, rateLimited = 0
  for (const a of enabled) {
    if (a.rateLimited) { rateLimited++; continue }
    if (a.provider === 'custom') continue
    const k = a.key.startsWith('env:') ? (process.env[a.key.replace('env:', '')] || '') : a.key
    if (k.length === 0) noKey++
  }

  const active = enabled.length - noKey - rateLimited
  if (active > 0)
    return { state: 'ok', noKeyCount: noKey, rateLimitedCount: rateLimited, disabledCount: disabledCount, enabledCount: enabled.length, message: '' }

  if (noKey > 0 && rateLimited === 0)
    return { state: 'unconfigured', noKeyCount: noKey, rateLimitedCount: 0, disabledCount: disabledCount, enabledCount: enabled.length,
      message: 'No API keys configured - add keys in Settings > API Keys or set env vars' }

  if (rateLimited > 0 && noKey === 0)
    return { state: 'rate-limited', noKeyCount: 0, rateLimitedCount: rateLimited, disabledCount: disabledCount, enabledCount: enabled.length,
      message: `All ${rateLimited} cloud provider(s) rate-limited - retrying automatically` }

  return { state: 'mixed', noKeyCount: noKey, rateLimitedCount: rateLimited, disabledCount: disabledCount, enabledCount: enabled.length,
    message: `${noKey} provider(s) have no key, ${rateLimited} rate-limited` }
}

// ── Get next available API — scored by response time + failures ──

export function getNextAvailableAPI(): { provider: Provider; model: string; entry: APIEntry } | null {
  autoResetExpiredLimits()
  const config    = loadConfig()
  const allApis   = mergeCustomProviders(config.providers.apis)
  const available = allApis.filter(api => {
    if (!api.enabled || api.rateLimited) return false
    // Custom providers use baseUrl instead of a key — allow empty key for local endpoints
    if (api.provider === 'custom') return (api.baseUrl || '').trim().length > 0
    // Resolve the actual key value — skip if env var is missing or empty
    const resolvedKey = api.key.startsWith('env:')
      ? (process.env[api.key.replace('env:', '')] || '')
      : api.key
    return resolvedKey.length > 0
  })
  if (!available.length) {
    const diag = diagnoseProviderPool()
    if (diag.message) console.log(`[Router] ${diag.message}`)
    return null
  }

  // Score: lower is better — blend usage count, response time, and failure history
  const primary = config.primaryProvider
  const scored = available
    .map(api => {
      const avgMs         = responseTimesMs.get(api.name) ?? 2000  // assume 2s if unknown
      const usageScore    = (api.usageCount || 0) * 0.1
      const timeScore     = avgMs / 1000
      const primaryBoost  = (primary && (api.name === primary || api.provider === primary)) ? -1000 : 0
      return { api, score: usageScore + timeScore + primaryBoost }
    })
    .sort((a, b) => a.score - b.score)

  const entry = scored[0].api
  return { provider: buildProvider(entry), model: entry.model, entry }
}

// ── Mark an API as rate-limited (exponential backoff) ────────

export function markRateLimited(apiName: string): void {
  const config = loadConfig()
  const entry  = config.providers.apis.find(a => a.name === apiName)
  const base   = entry ? (RATE_LIMIT_WINDOWS[entry.provider] ?? DEFAULT_RATE_LIMIT_MS) : DEFAULT_RATE_LIMIT_MS

  // Exponential backoff: base → 2× → 4× → 8× … capped at 5 min
  const failures = (consecutiveFailures.get(apiName) ?? 0) + 1
  consecutiveFailures.set(apiName, failures)
  const backoffMs = Math.min(300_000, base * Math.pow(2, failures - 1))

  config.providers.apis = config.providers.apis.map(api =>
    api.name === apiName
      ? { ...api, rateLimited: true, rateLimitedAt: Date.now(), rateLimitWindow: backoffMs }
      : api
  )

  // Auto-unpin: if the pinned primary provider accumulates 3+ consecutive failures, clear the pin
  // so the router can fall back to the next healthy provider automatically.
  const AUTO_UNPIN_THRESHOLD = 3
  if (failures >= AUTO_UNPIN_THRESHOLD && config.primaryProvider) {
    const pinnedName     = config.primaryProvider
    const pinnedProvider = entry?.provider ?? ''
    if (apiName === pinnedName || pinnedProvider === pinnedName) {
      delete config.primaryProvider
      console.log(`[Router] Auto-unpinned "${pinnedName}" after ${failures} consecutive failures`)
    }
  }

  saveConfig(config)
  console.log(`[Router] ${apiName} rate limited (failure #${failures}) — retry in ${Math.round(backoffMs / 1000)}s`)
}

// ── Mark an API as healthy ────────────────────────────────────

export function markHealthy(apiName: string): void {
  if (apiName === 'ollama') return
  const prev = consecutiveFailures.get(apiName) ?? 0
  if (prev === 0) return // already healthy, skip disk write

  consecutiveFailures.set(apiName, 0)
  const config = loadConfig()
  config.providers.apis = config.providers.apis.map(api =>
    api.name === apiName
      ? { ...api, rateLimited: false, rateLimitedAt: undefined }
      : api
  )
  saveConfig(config)
  console.log(`[Router] ${apiName} marked healthy — backoff cleared`)
}

// ── Record response time (EWMA) ───────────────────────────────
// Call this after each successful LLM response to improve provider selection.

export function recordResponseTime(providerName: string, ms: number): void {
  const prev = responseTimesMs.get(providerName)
  // Exponential moving average — weight recent observations at 20%
  responseTimesMs.set(providerName, prev ? prev * 0.8 + ms * 0.2 : ms)
}

// ── Increment usage count ─────────────────────────────────────

export function incrementUsage(apiName: string): void {
  if (apiName === 'ollama') return // don't track Ollama usage
  const config = loadConfig()
  config.providers.apis = config.providers.apis.map(api =>
    api.name === apiName ? { ...api, usageCount: (api.usageCount || 0) + 1 } : api
  )
  saveConfig(config)
}

// ── Log which providers are active at startup ────────────────

export function logProviderStatus(): void {
  const config  = loadConfig()
  const apis    = mergeCustomProviders(config.providers.apis)
  const isDebug = (process.env.AIDEN_LOG_LEVEL || 'info') === 'debug'

  if (config.primaryProvider) {
    console.log('[Router] Primary provider: ' + config.primaryProvider + ' (user override)')
  } else {
    console.log('[Router] Primary provider: (default ordering)')
  }

  let order  = 1
  let active = 0
  const lines: string[] = []

  for (const api of apis) {
    if (api.provider === 'custom') {
      const hasUrl = (api.baseUrl || '').trim().length > 0
      const status = !api.enabled ? 'disabled' : !hasUrl ? 'SKIPPED (no url)' : '#' + (order++) + ' active'
      if (status.includes('active')) active++
      lines.push('  ' + api.name + ' (custom/' + api.model + ') - [' + (hasUrl ? 'url OK' : 'NO URL') + '] - ' + status)
      continue
    }
    const resolvedKey = api.key.startsWith('env:')
      ? (process.env[api.key.replace('env:', '')] || '')
      : api.key
    const keyStatus = resolvedKey.length > 0 ? '[key OK]' : '[NO KEY]'
    const status    = !api.enabled ? 'disabled' : api.rateLimited ? 'rate-limited' : resolvedKey.length === 0 ? 'SKIPPED (no key)' : '#' + (order++) + ' active'
    if (status.includes('active')) active++
    lines.push('  ' + api.name + ' (' + api.provider + '/' + api.model + ') - ' + keyStatus + ' - ' + status)
  }
  lines.push('  ollama (' + OLLAMA_FALLBACK_MODEL + ') - local - #' + order + ' guaranteed fallback')

  if (isDebug) {
    console.log('[Router] Provider chain:')
    lines.forEach(l => console.log(l))
  } else {
    console.log('[Router] Provider chain: ' + active + ' active + Ollama fallback (AIDEN_LOG_LEVEL=debug for detail)')
  }
}

// ── Complexity scorer ─────────────────────────────────────────
// Returns 0–1 where 0 = trivially simple (local Ollama) and
// 1 = highly complex (needs best cloud model).

export function assessComplexity(message: string): number {
  let score = 0.3

  if (message.length > 500)  score += 0.15
  if (message.length > 1000) score += 0.10

  const complexPatterns = [
    /research|analyze|compare|explain in detail/i,
    /plan|strategy|architecture|design/i,
    /write.*code|build|create|implement/i,
    /debug|fix.*error|troubleshoot/i,
    /multi.*step|comprehensive|deep.research/i,
  ]
  const simplePatterns = [
    /^(hi|hello|hey|thanks|thank you|ok|yes|no|sure)\b/i,
    /what time|what date|who are you|what can you do/i,
    /^.{1,30}$/,
    /^(good morning|good night|bye)\b/i,
  ]

  if (complexPatterns.some(p => p.test(message))) score += 0.30
  if (simplePatterns.some(p => p.test(message)))   score -= 0.30
  if (/open|launch|run|execute|deploy/i.test(message)) score += 0.10
  const qMarks = (message.match(/\?/g) || []).length
  if (qMarks > 2) score += 0.15

  return Math.max(0, Math.min(1, score))
}

// ── Task-type model tiering ───────────────────────────────────
// Returns the best available key+model for a specific task role.
// Planner needs strong reasoning; executor needs speed; responder needs quality.
//
// Full fallback chains:
//   Planner:   groq → gemini → nvidia → openrouter → gemma4:e4b (Ollama)
//   Responder: groq → gemini → nvidia → openrouter → gemma4:e4b (Ollama)
//   Executor:  cerebras → groq → nvidia → gemma4:e4b (Ollama)
//
// IMPORTANT: Cerebras (llama3.1-8b, 8B params) is too small to follow the SOUL
// prompt and hallucinate capabilities. It is ONLY used for Executor (background
// tasks: heartbeat, dream engine, pattern detection). Never for user-facing chat.
//
// Groq is PRIMARY over Gemini: Groq free tier is far more generous (rate limits
// are rare), while Gemini free tier hits 15 RPM limits aggressively.
//
// Aiden ALWAYS works — even with zero internet.
// When message is provided for 'responder', complexity is assessed and simple
// queries are routed to local Ollama (zero API cost).

export type TaskType = 'planner' | 'executor' | 'responder'

const OLLAMA_FALLBACK_MODEL = 'gemma4:e4b'

function resolveKey(api: APIEntry): {
  apiKey: string; model: string; providerName: string; apiName: string
} {
  return {
    apiKey:       api.key.startsWith('env:')
      ? (process.env[api.key.replace('env:', '')] || '')
      : api.key,
    model:        api.model,
    providerName: api.provider,
    apiName:      api.name,
  }
}

const OLLAMA_RESULT = {
  apiKey: '', model: OLLAMA_FALLBACK_MODEL, providerName: 'ollama', apiName: 'ollama',
}

export function getModelForTask(
  task:     TaskType,
  message?: string,
): { apiKey: string; model: string; providerName: string; apiName: string } {

  // ── Complexity gate — responder only ─────────────────────────
  // Ollama is used ONLY when all cloud providers are rate-limited (true fallback).
  // Simple queries still get cloud speed (Groq is fast); Ollama is last resort.
  if (task === 'responder' && message) {
    const complexity = assessComplexity(message)
    console.log(`[Router] Complexity: ${complexity.toFixed(2)} — "${message.substring(0, 40)}"`)
  }

  autoResetExpiredLimits()
  const config    = loadConfig()
  const allApis   = mergeCustomProviders(config.providers.apis)
  const available = allApis.filter(a => {
    if (!a.enabled || a.rateLimited) return false
    if (a.provider === 'custom') return (a.baseUrl || '').trim().length > 0
    const k = a.key.startsWith('env:') ? (process.env[a.key.replace('env:', '')] || '') : a.key
    return k.length > 0
  })

  // Planner + Responder: walk ALL apis in config order (handles multiple slots per provider).
  // Cerebras excluded — 8B models cannot follow complex SOUL-based prompts. NVIDIA promoted to chat chain.
  const CHAT_EXCLUDED = new Set(['cerebras'])
  if (task === 'planner' || task === 'responder') {
    let chatApis = available.filter(a => !CHAT_EXCLUDED.has(a.provider))
    // Primary provider pinning — move primary to front of chain
    const primaryPin = config.primaryProvider
    if (primaryPin && chatApis.length > 1) {
      const idx = chatApis.findIndex(a => a.name === primaryPin || a.provider === primaryPin)
      if (idx > 0) chatApis = [chatApis[idx], ...chatApis.slice(0, idx), ...chatApis.slice(idx + 1)]
    }
    if (chatApis.length > 0) {
      const chosen    = chatApis[0]
      const pinTag    = primaryPin && (chosen.name === primaryPin || chosen.provider === primaryPin) ? ' [primary]' : ''
      console.log(`[Router] ${task}: ${chosen.name} (${chosen.provider}/${chosen.model})${pinTag}`)
      return resolveKey(chosen)
    }
    const model = getOllamaModelForTask(task === 'planner' ? 'planner' : 'responder')
    const diag = diagnoseProviderPool()
    console.log(`[Router] ${task}: ${diag.message || 'all cloud providers unavailable'} - using Ollama ${model}`)
    return { apiKey: '', model, providerName: 'ollama', apiName: 'ollama' }
  }

  // Executor: fastest — cerebras > groq > nvidia → discovered fast model
  if (task === 'executor') {
    for (const p of ['cerebras', 'groq', 'nvidia', 'openai']) {
      const api = available.find(a => a.provider === p)
      if (api) return resolveKey(api)
    }
    const model = getOllamaModelForTask('executor')
    const diag = diagnoseProviderPool()
    console.log(`[Router] Executor: ${diag.message || 'all cloud providers unavailable'} - falling back to Ollama ${model}`)
    return { apiKey: '', model, providerName: 'ollama', apiName: 'ollama' }
  }

  // Generic fallback — any available API, then gemma4:e4b
  if (available.length > 0) return resolveKey(available[0])
  return OLLAMA_RESULT
}

// ── Main entry: get smart provider with full fallback chain ───

export function getSmartProvider(): {
  provider: Provider
  model:    string
  userName: string
  apiName:  string
} {
  const config   = loadConfig()
  const userName = config.user?.name || 'there'

  // MANUAL MODE: use the explicitly selected active provider
  if (config.routing?.mode === 'manual') {
    if (config.model.active === 'ollama') {
      return { provider: ollamaProvider, model: config.model.activeModel || OLLAMA_FALLBACK_MODEL, userName, apiName: 'ollama' }
    }
    const active = config.providers.apis.find(a => a.name === config.model.active)
    if (active && active.enabled && !active.rateLimited) {
      return { provider: buildProvider(active), model: active.model || config.model.activeModel, userName, apiName: active.name }
    }
    // Configured API is unavailable — fall through to auto
  }

  // AUTO MODE: round-robin across available APIs
  const next = getNextAvailableAPI()
  if (next) {
    return { provider: next.provider, model: next.entry.model || getDefaultModel(next.entry.provider) || 'llama-3.3-70b-versatile', userName, apiName: next.entry.name }
  }

  // FALLBACK: best discovered Ollama model
  if (config.routing?.fallbackToOllama !== false) {
    const model = getOllamaModelForTask('responder')
    const diag = diagnoseProviderPool()
    console.log(`[Router] ${diag.message || 'All APIs unavailable'} - falling back to Ollama ${model}`)
    return { provider: ollamaProvider, model, userName, apiName: 'ollama' }
  }

  // Last resort
  const model = getOllamaModelForTask('responder')
  return { provider: ollamaProvider, model, userName, apiName: 'ollama' }
}

// ── Graceful degradation when all providers fail ──────────────

export interface DegradedResponse {
  mode:           'degraded'
  message:        string
  availableTools: string[]
  retryAfter:     number
}

let _degradedMode  = false
let _degradedTimer: ReturnType<typeof setTimeout> | null = null

export function isInDegradedMode(): boolean { return _degradedMode }

export function exitDegradedMode(): void {
  _degradedMode = false
  if (_degradedTimer) { clearTimeout(_degradedTimer); _degradedTimer = null }
}

export function enterDegradedMode(reason: string): DegradedResponse {
  console.log(`[Degraded] All providers unavailable: ${reason}`)
  _degradedMode = true

  // Auto-retry after 60 s — silently check if any provider is back
  if (!_degradedTimer) {
    _degradedTimer = setTimeout(async () => {
      _degradedTimer = null
      autoResetExpiredLimits()
      const next = getNextAvailableAPI()
      if (next) {
        console.log(`[Degraded] Provider recovered: ${next.entry.name}`)
        exitDegradedMode()
        return
      }
      // Check if Ollama came back
      try {
        const ollamaBase = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
        const r = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(3000) })
        if (r.ok) {
          console.log('[Degraded] Provider recovered: ollama')
          exitDegradedMode()
        }
      } catch { /* still down */ }
    }, 60_000)
  }

  return {
    mode:    'degraded',
    message: `I'm temporarily running in limited mode — ` +
      `${diagnoseProviderPool().state === 'unconfigured'
        ? 'no API keys are configured'
        : 'my AI providers are at capacity'}. I can still:\n` +
      `• Search your files and memory\n` +
      `• Run scheduled tasks\n` +
      `• Execute shell commands and scripts\n` +
      `• Open browsers and apps\n\n` +
      `I'll automatically reconnect when providers are available. ` +
      `This usually resolves in a few minutes.`,
    availableTools: ['file_read', 'file_write', 'file_list',
      'shell_exec', 'run_python', 'run_node', 'open_browser',
      'system_info', 'notify'],
    retryAfter: 60_000,
  }
}

// ── In-memory health snapshot (for /api/providers/state) ─────

export function getProviderHealthState(): {
  consecutiveFailures: Record<string, number>
  responseTimesMs:     Record<string, number>
} {
  return {
    consecutiveFailures: Object.fromEntries(consecutiveFailures),
    responseTimesMs:     Object.fromEntries(responseTimesMs),
  }
}
