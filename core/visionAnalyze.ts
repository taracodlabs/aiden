// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// core/visionAnalyze.ts — Image analysis via vision-capable providers.
//
// Provider chain (first available wins). Free providers first so
// the bot doesn't burn paid budget on every inbound photo:
//
//   1. Gemini       gemini-2.5-flash                 (GEMINI_API_KEY)
//   2. Groq         llama-4-maverick-17b vision      (GROQ_API_KEY)
//   3. OpenRouter   llama-3.2-11b-vision:free        (OPENROUTER_API_KEY)
//   4. Together     Llama-Vision-Free                (TOGETHER_API_KEY)
//   5. Anthropic    claude-3-5-sonnet                (ANTHROPIC_API_KEY)
//   6. OpenAI       gpt-4o                           (OPENAI_API_KEY)
//   7. Ollama       llava                            (local, no key)
//
// Accepts local file paths (→ base64) or HTTP/HTTPS URLs.
//
// Phase v4.1-4 — added optional `Logger` parameter so the channel
// adapter (Telegram, etc.) can route diagnostics through the unified
// `core/v4/logger` contract instead of stdout.
//
// Phase v4.1-4.1 — extended chain to cover the providers Aiden
// already authenticates against, optional httpClient test seam, and
// shared OpenAI-compatible helper for Groq / OpenRouter / Together
// (which all serve the same wire format).

import * as fs   from 'fs'
import * as path from 'path'
import axios     from 'axios'

import { noopLogger, type Logger } from './v4/logger'

export interface VisionResult {
  description: string
  provider:    string
  modelUsed:   string
  durationMs:  number
}

/**
 * Phase v4.1-4.1 — minimal HTTP client surface so smokes can inject
 * a fake without touching axios. We only use POST for vision; GET
 * is for downloading remote URLs into base64 before handing to the
 * Ollama provider.
 */
export interface VisionHttpClient {
  post(url: string, body: unknown, opts?: { headers?: Record<string, string>; timeout?: number }): Promise<{ data: any }>
  get( url: string,                 opts?: { responseType?: 'arraybuffer'; timeout?: number }): Promise<{ data: any }>
}

/** Default client wraps axios so production stays unchanged. */
const defaultHttpClient: VisionHttpClient = {
  post: (url, body, opts) => axios.post(url, body, {
    headers: opts?.headers,
    timeout: opts?.timeout,
  }),
  get:  (url, opts)        => axios.get(url, {
    responseType: opts?.responseType,
    timeout:      opts?.timeout,
  }),
}

// ── Media type resolver ───────────────────────────────────────────────────────

function extToMediaType(ext: string): string {
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', bmp: 'image/bmp',
  }
  return map[ext.toLowerCase().replace(/^\./, '')] ?? 'image/jpeg'
}

// ── Image source resolver — returns { base64, mediaType, isUrl, sourceUrl } ──

interface ResolvedImage {
  isUrl:      boolean
  sourceUrl:  string         // populated when isUrl
  base64:     string         // populated when !isUrl
  mediaType:  string
}

function resolveLocalImage(imageSource: string): ResolvedImage {
  const isUrl = imageSource.startsWith('http://') || imageSource.startsWith('https://')
  if (isUrl) {
    return { isUrl: true, sourceUrl: imageSource, base64: '', mediaType: 'image/jpeg' }
  }
  const absPath = path.isAbsolute(imageSource)
    ? imageSource
    : path.resolve(process.cwd(), imageSource)
  const buf = fs.readFileSync(absPath)
  return {
    isUrl:     false,
    sourceUrl: '',
    base64:    buf.toString('base64'),
    mediaType: extToMediaType(path.extname(absPath)),
  }
}

/** Build a `data:<media>;base64,<...>` URL for OpenAI-compat consumers. */
function asDataUrl(img: ResolvedImage): string {
  if (img.isUrl) return img.sourceUrl
  return `data:${img.mediaType};base64,${img.base64}`
}

/**
 * For URL sources we sometimes need raw bytes (Gemini's inline_data
 * is base64; Ollama's images[] is base64). Download and base64 the
 * remote URL on demand. Returns null on download failure so the caller
 * can fall through to the next provider.
 */
async function ensureBase64(
  img: ResolvedImage,
  http: VisionHttpClient,
  log:  Logger,
): Promise<{ base64: string; mediaType: string } | null> {
  if (!img.isUrl) return { base64: img.base64, mediaType: img.mediaType }
  try {
    const res = await http.get(img.sourceUrl, { responseType: 'arraybuffer', timeout: 15_000 })
    const base64   = Buffer.from(res.data).toString('base64')
    const mediaType = extToMediaType(path.extname(img.sourceUrl)) || 'image/jpeg'
    return { base64, mediaType }
  } catch (e: any) {
    log.warn('failed to download image url for base64-only providers', { url: img.sourceUrl, error: e?.message })
    return null
  }
}

// ── Provider 1: generative-content API ────────────────────────────────────────

const GENERATIVE_VISION_MODEL    = 'gemini-2.5-flash'
const GENERATIVE_VISION_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GENERATIVE_VISION_MODEL}:generateContent`

async function tryGenerativeVisionApi(
  img: ResolvedImage, prompt: string, log: Logger, http: VisionHttpClient,
): Promise<VisionResult | null> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  const t0 = Date.now()
  try {
    const inline = await ensureBase64(img, http, log)
    if (!inline) return null
    const body = {
      contents: [{
        parts: [
          { inline_data: { mime_type: inline.mediaType, data: inline.base64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { maxOutputTokens: 1024 },
    }
    const res = await http.post(`${GENERATIVE_VISION_ENDPOINT}?key=${key}`, body, {
      headers: { 'content-type': 'application/json' },
      timeout: 30_000,
    })
    const description = (res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
    if (!description) return null
    const result: VisionResult = { description, provider: 'gemini', modelUsed: GENERATIVE_VISION_MODEL, durationMs: Date.now() - t0 }
    log.info('image analyzed', { provider: 'gemini', modelUsed: GENERATIVE_VISION_MODEL, durationMs: result.durationMs, descChars: description.length })
    return result
  } catch (e: any) {
    log.warn('generative vision request failed', { error: e?.message ?? String(e) })
    return null
  }
}

// ── Providers 2-4: compatible chat APIs ───────────────────────────────────────

interface CompatibleVisionTarget {
  /** Display name on the result. */
  provider:  string
  /** Base URL (without trailing slash). */
  baseUrl:   string
  /** Model id to send. */
  model:     string
  /** Env var holding the API key. */
  envKey:    string
}

const LOW_LATENCY_TARGET: CompatibleVisionTarget = {
  provider: 'groq',
  baseUrl:  'https://api.groq.com/openai/v1',
  model:    'meta-llama/llama-4-maverick-17b-128e-instruct',
  envKey:   'GROQ_API_KEY',
}

const ROUTED_TARGET: CompatibleVisionTarget = {
  provider: 'openrouter',
  baseUrl:  'https://openrouter.ai/api/v1',
  model:    'meta-llama/llama-3.2-11b-vision-instruct:free',
  envKey:   'OPENROUTER_API_KEY',
}

const HOSTED_TARGET: CompatibleVisionTarget = {
  provider: 'together',
  baseUrl:  'https://api.together.xyz/v1',
  model:    'meta-llama/Llama-Vision-Free',
  envKey:   'TOGETHER_API_KEY',
}

async function tryCompatibleVisionApi(
  target: CompatibleVisionTarget,
  img:    ResolvedImage,
  prompt: string,
  log:    Logger,
  http:   VisionHttpClient,
): Promise<VisionResult | null> {
  const key = process.env[target.envKey]
  if (!key) return null
  const t0 = Date.now()
  try {
    const dataUrl = asDataUrl(img)
    const body = {
      model:      target.model,
      max_tokens: 1024,
      messages:   [{
        role:    'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text',      text: prompt },
        ],
      }],
    }
    const res = await http.post(`${target.baseUrl}/chat/completions`, body, {
      headers: {
        Authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      timeout: 30_000,
    })
    const description = (res.data?.choices?.[0]?.message?.content ?? '').trim()
    if (!description) return null
    const result: VisionResult = {
      description,
      provider:   target.provider,
      modelUsed:  target.model,
      durationMs: Date.now() - t0,
    }
    log.info('image analyzed', {
      provider:   target.provider,
      modelUsed:  target.model,
      durationMs: result.durationMs,
      descChars:  description.length,
    })
    return result
  } catch (e: any) {
    log.warn(`${target.provider} vision failed`, { error: e?.message ?? String(e) })
    return null
  }
}

// ── Provider 5: message API ───────────────────────────────────────────────────

const MESSAGE_VISION_MODEL = 'claude-3-5-sonnet-20241022'

async function tryMessageVisionApi(
  img: ResolvedImage, prompt: string, log: Logger, http: VisionHttpClient,
): Promise<VisionResult | null> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  const t0 = Date.now()
  try {
    const imageBlock: any = img.isUrl
      ? { type: 'image', source: { type: 'url',    url: img.sourceUrl } }
      : { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } }
    const body = {
      model:      MESSAGE_VISION_MODEL,
      max_tokens: 1024,
      messages:   [{ role: 'user', content: [imageBlock, { type: 'text', text: prompt }] }],
    }
    const res = await http.post('https://api.anthropic.com/v1/messages', body, {
      headers: {
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      timeout: 30_000,
    })
    const description = (res.data?.content?.[0]?.text ?? '').trim()
    if (!description) return null
    const result: VisionResult = { description, provider: 'anthropic', modelUsed: MESSAGE_VISION_MODEL, durationMs: Date.now() - t0 }
    log.info('image analyzed', { provider: 'anthropic', modelUsed: MESSAGE_VISION_MODEL, durationMs: result.durationMs, descChars: description.length })
    return result
  } catch (e: any) {
    log.warn('message vision request failed', { error: e?.message ?? String(e) })
    return null
  }
}

// ── Provider 6: response API ──────────────────────────────────────────────────

const RESPONSE_VISION_MODEL = 'gpt-4o'

async function tryResponseVisionApi(
  img: ResolvedImage, prompt: string, log: Logger, http: VisionHttpClient,
): Promise<VisionResult | null> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null
  const t0 = Date.now()
  try {
    const body = {
      model:      RESPONSE_VISION_MODEL,
      max_tokens: 1024,
      messages:   [{
        role:    'user',
        content: [
          { type: 'image_url', image_url: { url: asDataUrl(img) } },
          { type: 'text',      text: prompt },
        ],
      }],
    }
    const res = await http.post('https://api.openai.com/v1/chat/completions', body, {
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      timeout: 30_000,
    })
    const description = (res.data?.choices?.[0]?.message?.content ?? '').trim()
    if (!description) return null
    const result: VisionResult = { description, provider: 'openai', modelUsed: RESPONSE_VISION_MODEL, durationMs: Date.now() - t0 }
    log.info('image analyzed', { provider: 'openai', modelUsed: RESPONSE_VISION_MODEL, durationMs: result.durationMs, descChars: description.length })
    return result
  } catch (e: any) {
    log.warn('response vision request failed', { error: e?.message ?? String(e) })
    return null
  }
}

// ── Provider 7: local vision runtime ──────────────────────────────────────────

async function tryLocalVisionRuntime(
  img: ResolvedImage, prompt: string, log: Logger, http: VisionHttpClient,
): Promise<VisionResult | null> {
  const ollamaBase = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
  const t0 = Date.now()
  try {
    const inline = await ensureBase64(img, http, log)
    if (!inline) return null
    const res = await http.post(
      `${ollamaBase}/api/generate`,
      { model: 'llava', prompt, images: [inline.base64], stream: false },
      { timeout: 60_000 },
    )
    const description = (res.data?.response ?? '').trim()
    if (!description) return null
    const result: VisionResult = { description, provider: 'ollama', modelUsed: 'llava', durationMs: Date.now() - t0 }
    log.info('image analyzed', { provider: 'ollama', modelUsed: 'llava', durationMs: result.durationMs, descChars: description.length })
    return result
  } catch (e: any) {
    log.warn('local vision request failed', { error: e?.message ?? String(e) })
    return null
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Analyze an image using the first available vision-capable provider.
 *
 * @param imageSource  File path (absolute or relative) or HTTP(S) URL.
 * @param prompt       Instruction prompt (default: describe the image).
 * @param logger       Optional Logger from `core/v4/logger`; defaults
 *                     to a noop sink for legacy callers.
 * @param httpClient   Phase v4.1-4.1 — optional HTTP client (test seam).
 *                     Production leaves this unset; smokes inject a fake.
 * @returns            VisionResult with description, provider, model, timing.
 */
export async function analyzeImage(
  imageSource: string,
  prompt       = 'Describe this image in detail.',
  logger:      Logger = noopLogger(),
  httpClient:  VisionHttpClient = defaultHttpClient,
): Promise<VisionResult> {
  const img = resolveLocalImage(imageSource)

  // Phase v4.1-4.1 — provider chain. Free providers first so the
  // bot doesn't burn paid budget on every inbound photo. Each
  // attempt returns null (key missing OR call failed) on which
  // we fall through to the next; the first one that produces a
  // non-empty description wins.
  const providers: Array<(img: ResolvedImage, prompt: string, log: Logger, http: VisionHttpClient) => Promise<VisionResult | null>> = [
    tryGenerativeVisionApi,
    (i, p, l, h) => tryCompatibleVisionApi(LOW_LATENCY_TARGET, i, p, l, h),
    (i, p, l, h) => tryCompatibleVisionApi(ROUTED_TARGET,      i, p, l, h),
    (i, p, l, h) => tryCompatibleVisionApi(HOSTED_TARGET,      i, p, l, h),
    tryMessageVisionApi,
    tryResponseVisionApi,
    tryLocalVisionRuntime,
  ]

  for (const tryProvider of providers) {
    const result = await tryProvider(img, prompt, logger, httpClient)
    if (result) return result
  }

  logger.warn('all vision providers exhausted')
  throw new Error('vision_analyze: all providers exhausted (no API key found, or every provider call failed). Configure GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY / TOGETHER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY, or run a local Ollama with `llava` pulled.')
}
