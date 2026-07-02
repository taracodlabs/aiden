// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/voice/stt.ts — Speech-to-Text with three-provider fallback chain.
//
// Priority order (auto-selected at runtime):
//   1. Groq Whisper API   (GROQ_API_KEY)         — fastest, cloud
//   2. OpenAI Whisper API (OPENAI_API_KEY)        — reliable, cloud
//   3. Local Whisper.cpp  (WHISPER_MODEL_PATH)    — offline, no API key
//
// If all providers fail: returns { text: '', provider: 'none', error }
// — never throws; callers check result.text.
//
// Phase v4.1-3 surgical edits:
//   - Cloud providers request `verbose_json` so we receive segment-level
//     `avg_logprob`. The mean is exposed on the result as `confidence`
//     (negative; closer to zero is more confident). Channel adapters
//     (e.g. Telegram voice notes) use this to decide whether to echo
//     a low-confidence transcript back to the user before handing it
//     to the agent.
//   - All `console.*` removed in favour of an injectable `Logger` from
//     `core/v4/logger`. Defaults to a noop logger so callers without a
//     wired logger get silence (REPL-safe). v4.1-1.3a contract.

import fs   from 'fs'
import path from 'path'
import { exec }     from 'child_process'
import { promisify } from 'util'
import axios         from 'axios'

import { noopLogger, type Logger } from '../v4/logger'
import { resolveUserPath } from '../v4/paths'

const execAsync = promisify(exec)

// ── Public types ──────────────────────────────────────────────────────────────

export interface SttOptions {
  /** Path to an audio file (.wav / .mp3 / .webm etc.) */
  audioFilePath?: string
  /** Raw audio bytes (written to a temp file before sending) */
  audioBuffer?:   Buffer
  /** BCP-47 language hint, e.g. 'en', 'fr'. Optional. */
  language?:      string
  /** Per-call timeout in ms (default 30 000). */
  timeoutMs?:     number
  /**
   * Phase v4.1-3 — diagnostics logger. Defaults to noop so legacy
   * callers stay silent. The Telegram channel passes a scoped
   * `bootLogger.child('stt')`.
   */
  logger?:        Logger
}

export interface SttResult {
  text:        string
  provider:    string
  durationMs:  number
  /**
   * Mean of `avg_logprob` across Whisper segments. Negative values
   * (closer to 0 = more confident). Populated by the cloud providers
   * when `response_format=verbose_json` is honoured; absent otherwise.
   */
  confidence?: number
  error?:      string
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const WORKSPACE = path.join(process.cwd(), 'workspace')

function ensureWorkspace(): void {
  if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true })
}

/** Resolves the audio file path, writing buffer to a temp file if needed. */
function resolveAudioPath(opts: SttOptions): string {
  if (opts.audioFilePath) return opts.audioFilePath
  if (opts.audioBuffer) {
    ensureWorkspace()
    const tmp = path.join(WORKSPACE, `stt_input_${Date.now()}.wav`)
    fs.writeFileSync(tmp, opts.audioBuffer)
    return tmp
  }
  throw new Error('SttOptions: provide audioFilePath or audioBuffer')
}

/**
 * Compute mean of `avg_logprob` across Whisper segments — Phase v4.1-3.
 * Returns `undefined` when the field is absent (older response shapes,
 * non-verbose_json fallback, or no segments at all). Callers only use
 * this when the value is finite; preserve that invariant here.
 */
function meanAvgLogprob(payload: unknown): number | undefined {
  const segs = (payload as { segments?: Array<{ avg_logprob?: number }> })?.segments
  if (!Array.isArray(segs) || segs.length === 0) return undefined
  let sum = 0
  let count = 0
  for (const s of segs) {
    const v = s?.avg_logprob
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v
      count += 1
    }
  }
  if (count === 0) return undefined
  return sum / count
}

// ── Provider 1 — Groq Whisper ─────────────────────────────────────────────────

async function transcribeGroq(audioPath: string, opts: SttOptions): Promise<SttResult> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY not set')

  const timeout = opts.timeoutMs ?? 30_000
  const t0      = Date.now()

  const FormData = (await import('form-data')).default
  const form     = new FormData()
  form.append('file',  fs.createReadStream(audioPath), path.basename(audioPath))
  form.append('model', 'whisper-large-v3')
  if (opts.language) form.append('language', opts.language)
  // Phase v4.1-3 — verbose_json gives us segment-level `avg_logprob`
  // for confidence scoring on the channel side. Groq mirrors OpenAI's
  // Whisper response shape here.
  form.append('response_format', 'verbose_json')

  const res = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
      timeout,
    },
  )

  const confidence = meanAvgLogprob(res.data)
  return {
    text:       (res.data.text ?? '').trim(),
    provider:   'groq',
    durationMs: Date.now() - t0,
    ...(typeof confidence === 'number' ? { confidence } : {}),
  }
}

// ── Provider 2 — OpenAI Whisper ───────────────────────────────────────────────

async function transcribeOpenAI(audioPath: string, opts: SttOptions): Promise<SttResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

  const timeout = opts.timeoutMs ?? 30_000
  const t0      = Date.now()

  const FormData = (await import('form-data')).default
  const form     = new FormData()
  form.append('file',  fs.createReadStream(audioPath), path.basename(audioPath))
  form.append('model', 'whisper-1')
  if (opts.language) form.append('language', opts.language)
  // Phase v4.1-3 — same verbose_json switch as Groq for parity.
  form.append('response_format', 'verbose_json')

  const res = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
      timeout,
    },
  )

  const confidence = meanAvgLogprob(res.data)
  return {
    text:       (res.data.text ?? '').trim(),
    provider:   'openai',
    durationMs: Date.now() - t0,
    ...(typeof confidence === 'number' ? { confidence } : {}),
  }
}

// ── Provider 3 — Local Whisper.cpp ────────────────────────────────────────────

async function transcribeLocal(audioPath: string, opts: SttOptions): Promise<SttResult> {
  // v4.12.1 — user-supplied path routed through resolveUserPath
  // (quote-strip, ~ expansion); null behaves like the old undefined.
  const modelPath  = resolveUserPath(process.env.WHISPER_MODEL_PATH)
  const t0         = Date.now()
  const timeout    = opts.timeoutMs ?? 60_000

  // whisper-cli binary: try PATH first, then common install locations
  const binaryName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  const binaryCandidates = [
    binaryName,
    path.join(process.cwd(), 'bin', binaryName),
    path.join(process.cwd(), binaryName),
  ]

  let binary = binaryName
  for (const candidate of binaryCandidates) {
    try {
      await execAsync(`"${candidate}" --version`, { timeout: 3000 })
      binary = candidate
      break
    } catch { /* try next */ }
  }

  const modelArg = modelPath ? `-m "${modelPath}"` : ''
  const langArg  = opts.language ? `-l ${opts.language}` : ''
  const cmd      = `"${binary}" ${modelArg} ${langArg} -f "${audioPath}" --output-txt`.trim()

  await execAsync(cmd, { timeout })

  // whisper-cli writes <audioPath>.txt
  const txtPath = audioPath + '.txt'
  if (!fs.existsSync(txtPath)) throw new Error('whisper-cli produced no output file')

  const text = fs.readFileSync(txtPath, 'utf-8').trim()
  try { fs.unlinkSync(txtPath) } catch { /* ignore */ }

  return { text, provider: 'local', durationMs: Date.now() - t0 }
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Transcribe audio using the first available provider.
 * Never throws — always returns an SttResult; check result.error on failure.
 */
export async function transcribe(options: SttOptions): Promise<SttResult> {
  const t0      = Date.now()
  let   tmpFile = ''
  const errors: string[] = []
  const log     = options.logger ?? noopLogger()

  try {
    const audioPath = resolveAudioPath(options)
    if (!options.audioFilePath && options.audioBuffer) tmpFile = audioPath

    // Provider 1 — Groq
    try {
      const r = await transcribeGroq(audioPath, options)
      log.info(`groq whisper transcribed`, {
        snippet:    r.text.slice(0, 60),
        durationMs: r.durationMs,
        confidence: r.confidence,
      })
      return r
    } catch (e: any) {
      errors.push(`groq: ${e.message}`)
    }

    // Provider 2 — OpenAI
    try {
      const r = await transcribeOpenAI(audioPath, options)
      log.info(`openai whisper transcribed`, {
        snippet:    r.text.slice(0, 60),
        durationMs: r.durationMs,
        confidence: r.confidence,
      })
      return r
    } catch (e: any) {
      errors.push(`openai: ${e.message}`)
    }

    // Provider 3 — Local Whisper.cpp
    try {
      const r = await transcribeLocal(audioPath, options)
      log.info(`local whisper transcribed`, {
        snippet:    r.text.slice(0, 60),
        durationMs: r.durationMs,
      })
      return r
    } catch (e: any) {
      errors.push(`local: ${e.message}`)
    }

    // All failed
    const errorMsg = errors.join(' | ')
    log.warn(`all providers failed`, { errors: errorMsg })
    return { text: '', provider: 'none', durationMs: Date.now() - t0, error: errorMsg }

  } catch (outer: any) {
    return { text: '', provider: 'none', durationMs: Date.now() - t0, error: outer.message }
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile) } catch { /* ignore */ } }
  }
}

/** Returns which STT providers are likely available (env-key check only). */
export function getSttProviders(): Array<{ name: string; available: boolean }> {
  return [
    { name: 'groq',   available: !!process.env.GROQ_API_KEY   },
    { name: 'openai', available: !!process.env.OPENAI_API_KEY },
    { name: 'local',  available: !!process.env.WHISPER_MODEL_PATH },
  ]
}
