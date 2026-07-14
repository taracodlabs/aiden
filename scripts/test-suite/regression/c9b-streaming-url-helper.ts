// ============================================================
// C9b Streaming URL Helper Regression Tests
// scripts/test-suite/regression/c9b-streaming-url-helper.ts
//
// Proves C9b fix: resolveStreamingUrl() helper centralises
// URL resolution for all providers. All 3 fetch sites in
// respondWithResults now use the helper — no raw
// COMPATIBLE_API_ENDPOINTS lookups remain.
//
// Zero I/O — pure logic + source-text inspection.
// ============================================================

import 'dotenv/config'
import fs   from 'fs'
import path from 'path'
import { runTest, summarize, printResult, C, GroupSummary } from '../utils'

const CWD = process.cwd()

function req<T = any>(relPath: string): T | null {
  try { return require(path.join(CWD, relPath)) as T } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Group T — Regression: C9b streaming URL helper
// ─────────────────────────────────────────────────────────────────────────────

export async function groupT(): Promise<GroupSummary> {
  console.log(`\n${C.bold}[T] Regression — C9b streaming URL helper${C.reset}`)
  const results = []

  const agentLoop = req<{
    resolveStreamingUrl?: (providerName: string, apiKey: string) => string
  }>('core/agentLoop')

  // ── T-01: resolveStreamingUrl is exported ─────────────────────────────
  results.push(await runTest('T-01', 'T',
    'resolveStreamingUrl exported from core/agentLoop', () => {
      if (!agentLoop) return 'require(core/agentLoop) threw — check compilation'
      if (typeof agentLoop.resolveStreamingUrl !== 'function')
        return 'resolveStreamingUrl is not exported as a function'
    }
  ))

  const resolve = agentLoop?.resolveStreamingUrl
  if (typeof resolve !== 'function') {
    const bail = (id: string, desc: string) =>
      results.push({ id, group: 'T', desc, verdict: 'SKIP' as const, durationMs: 0, detail: 'skipped — export missing' })
    bail('T-02', "known provider 'groq' returns groq endpoint")
    bail('T-03', "known provider 'openrouter' returns openrouter endpoint")
    bail('T-04', "providerName='custom' resolves baseUrl from config")
    bail('T-05', "providerName='custom' falls back to providers.apis")
    bail('T-06', 'unknown provider returns groq fallback')
    bail('T-07', 'respondWithResults has zero raw COMPATIBLE_API_ENDPOINTS[providerName] lookups')
    results.forEach(printResult)
    return summarize('T', 'C9b streaming URL helper', results)
  }

  // ── T-02: groq returns groq endpoint ──────────────────────────────────
  results.push(await runTest('T-02', 'T',
    "known provider 'groq' returns groq endpoint", () => {
      const url = resolve('groq', 'fake-key')
      if (!url.includes('api.groq.com'))
        return `expected groq URL, got: ${url}`
    }
  ))

  // ── T-03: openrouter returns openrouter endpoint ──────────────────────
  results.push(await runTest('T-03', 'T',
    "known provider 'openrouter' returns openrouter endpoint", () => {
      const url = resolve('openrouter', 'fake-key')
      if (!url.includes('openrouter.ai'))
        return `expected openrouter URL, got: ${url}`
    }
  ))

  // ── T-04: custom resolves baseUrl from config ─────────────────────────
  // This test relies on the real config having a custom provider with
  // env:TOGETHER_API_KEY. If the key is set, the resolver should return
  // the Together baseUrl (not groq).
  results.push(await runTest('T-04', 'T',
    "providerName='custom' resolves baseUrl from config", () => {
      const togetherKey = process.env.TOGETHER_API_KEY
      if (!togetherKey) return 'skipped — TOGETHER_API_KEY not set'
      const url = resolve('custom', togetherKey)
      if (url.includes('api.groq.com'))
        return `custom provider resolved to groq URL — helper not working: ${url}`
      if (!url.includes('together'))
        return `expected together URL, got: ${url}`
    }
  ))

  // ── T-05: custom with unknown key falls back to groq ──────────────────
  results.push(await runTest('T-05', 'T',
    "providerName='custom' with unknown key falls back to groq", () => {
      const url = resolve('custom', 'nonexistent-key-12345')
      if (!url.includes('api.groq.com'))
        return `expected groq fallback for unknown custom key, got: ${url}`
    }
  ))

  // ── T-06: unknown provider returns groq fallback ──────────────────────
  results.push(await runTest('T-06', 'T',
    'unknown provider returns groq fallback', () => {
      const url = resolve('totally-unknown-provider', 'fake-key')
      if (!url.includes('api.groq.com'))
        return `expected groq fallback, got: ${url}`
    }
  ))

  // ── T-07: source-text — no raw COMPATIBLE_API_ENDPOINTS[providerName] in respondWithResults ─
  results.push(await runTest('T-07', 'T',
    'respondWithResults has zero raw COMPATIBLE_API_ENDPOINTS[providerName] lookups', () => {
      const src = (() => {
        try { return fs.readFileSync(path.join(CWD, 'core', 'agentLoop.ts'), 'utf-8') } catch { return null }
      })()
      if (!src) return 'Could not read core/agentLoop.ts'

      // Find the respondWithResults function — anchor on its unique log line
      const anchor = src.indexOf('respondWithResults → ollama')
      if (anchor === -1) return 'Could not find respondWithResults function marker'

      // Grab a generous window covering the entire function (~800 lines)
      const fnBody = src.slice(Math.max(0, anchor - 500), anchor + 8000)

      // Check for raw COMPATIBLE_API_ENDPOINTS[providerName] or
      // COMPATIBLE_API_ENDPOINTS[nextCloud.providerName] or
      // COMPATIBLE_API_ENDPOINTS[cloudFallback.providerName]
      // These should all be replaced by resolveStreamingUrl calls.
      // Exclude comment lines (starting with //)
      const codeLines = fnBody.split('\n').filter(l => !l.trim().startsWith('//'))
      const codeOnly  = codeLines.join('\n')

      const rawLookups = codeOnly.match(/COMPATIBLE_API_ENDPOINTS\[\w+\.\w+\]/g) ||
                         codeOnly.match(/COMPATIBLE_API_ENDPOINTS\[providerName\]/g)
      if (rawLookups && rawLookups.length > 0)
        return `Found ${rawLookups.length} raw COMPATIBLE_API_ENDPOINTS lookup(s) in respondWithResults: ${rawLookups.join(', ')}`
    }
  ))

  results.forEach(printResult)
  return summarize('T', 'C9b streaming URL helper', results)
}
