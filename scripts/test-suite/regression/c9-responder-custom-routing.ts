// ============================================================
// C9 Responder Custom-Provider Routing Regression Tests
// scripts/test-suite/regression/c9-responder-custom-routing.ts
//
// Proves C9 fix: respondWithResults now has an explicit
// `providerName === 'custom'` branch that resolves baseUrl
// from config instead of falling through to
// COMPATIBLE_API_ENDPOINTS (which has no 'custom' entry,
// causing Together API key to be sent to Groq URL → 401).
//
// Zero I/O — pure source-text inspection (no server, no LLM).
// ============================================================

import fs   from 'fs'
import path from 'path'
import { runTest, summarize, printResult, C, GroupSummary } from '../utils'

const CWD = process.cwd()

// ─────────────────────────────────────────────────────────────────────────────
// Group U — Regression: C9 responder custom-provider routing
// ─────────────────────────────────────────────────────────────────────────────

export async function groupU(): Promise<GroupSummary> {
  console.log(`\n${C.bold}[U] Regression — C9 responder custom-provider routing${C.reset}`)
  const results = []

  const src = (() => {
    try { return fs.readFileSync(path.join(CWD, 'core', 'agentLoop.ts'), 'utf-8') } catch { return null }
  })()

  // Find the respondWithResults provider-branching section.
  // The function is ~400 lines. We anchor on the Ollama streaming block
  // (unique to respondWithResults — callLLM's Ollama block is different)
  // then grab a generous window that covers: ollama → custom → generic else.
  const ollamaAnchor = src?.indexOf("respondWithResults → ollama") ?? -1
  const branchStart  = ollamaAnchor >= 0 ? Math.max(0, ollamaAnchor - 200) : -1
  const fnBody       = branchStart >= 0 ? src!.slice(branchStart, branchStart + 3000) : ''

  // ── U-01: source contains providerName === 'custom' branch ────────────
  results.push(await runTest('U-01', 'U',
    "respondWithResults has providerName === 'custom' branch", () => {
      if (!src) return 'Could not read core/agentLoop.ts'
      if (!fnBody.includes("providerName === 'custom'"))
        return "respondWithResults does not contain providerName === 'custom' branch"
    }
  ))

  // For U-02/U-03: extract just the custom block (from 'custom' to next '} else {')
  // For U-04/U-05: search in full src starting from the respondWithResults Ollama anchor
  const customIdxInSrc = src?.indexOf("respondWithResults → ollama") ?? -1
  const responderSection = customIdxInSrc >= 0 ? src!.slice(customIdxInSrc, customIdxInSrc + 6000) : ''
  const customBranchStart = responderSection.indexOf("providerName === 'custom'")
  const customBlock = customBranchStart >= 0
    ? (() => {
        const after = responderSection.slice(customBranchStart)
        const elseIdx = after.indexOf('} else {')
        return elseIdx > 0 ? after.slice(0, elseIdx) : after.slice(0, 1500)
      })()
    : ''

  // ── U-02: custom branch uses customBaseUrl (not COMPATIBLE_API_ENDPOINTS) ─
  results.push(await runTest('U-02', 'U',
    'custom branch resolves customBaseUrl from config', () => {
      if (!src) return 'Could not read core/agentLoop.ts'
      if (!customBlock) return 'skipped — custom branch not found'
      if (!customBlock.includes('customBaseUrl'))
        return 'custom branch does not use customBaseUrl — may still be using COMPATIBLE_API_ENDPOINTS'
      // Check that COMPATIBLE_API_ENDPOINTS only appears in comments (lines starting with //), not code
      const codeLines = customBlock.split('\n').filter(l => !l.trim().startsWith('//'))
      const codeOnly  = codeLines.join('\n')
      if (codeOnly.includes('COMPATIBLE_API_ENDPOINTS'))
        return 'custom branch code (non-comment) references COMPATIBLE_API_ENDPOINTS — should use customBaseUrl'
    }
  ))

  // ── U-03: custom branch uses stream: true ─────────────────────────────
  results.push(await runTest('U-03', 'U',
    'custom branch uses stream: true (not stream: false like callLLM)', () => {
      if (!src) return 'Could not read core/agentLoop.ts'
      if (!customBlock) return 'skipped — custom branch not found'
      if (!customBlock.includes('stream: true'))
        return 'custom branch does not set stream: true — responder must stream tokens'
      if (customBlock.includes('stream: false'))
        return 'custom branch uses stream: false — should be stream: true for responder'
    }
  ))

  // ── U-04: custom branch is BEFORE the generic else block ──────────────
  results.push(await runTest('U-04', 'U',
    'custom branch is positioned before generic else fallback', () => {
      if (!src) return 'Could not read core/agentLoop.ts'
      if (customBranchStart === -1) return 'skipped — custom branch not found'
      const afterCustom = responderSection.slice(customBranchStart)
      const genericElseIdx = afterCustom.indexOf('COMPATIBLE_API_ENDPOINTS[providerName]')
      if (genericElseIdx === -1)
        return 'Could not find generic COMPATIBLE_API_ENDPOINTS fallback after custom branch'
      if (genericElseIdx < 50)
        return 'COMPATIBLE_API_ENDPOINTS fallback is too close to custom branch — custom may not be a separate block'
      const between = afterCustom.slice(0, genericElseIdx)
      if (!between.includes('} else {'))
        return 'No } else { between custom branch and COMPATIBLE_API_ENDPOINTS — custom not properly separated'
    }
  ))

  // ── U-05: generic else fallback to groq still preserved ───────────────
  results.push(await runTest('U-05', 'U',
    'generic else fallback to COMPATIBLE_API_ENDPOINTS.groq preserved', () => {
      if (!src) return 'Could not read core/agentLoop.ts'
      if (customBranchStart === -1) return 'skipped — custom branch not found'
      const afterCustom = responderSection.slice(customBranchStart)
      if (!afterCustom.includes('COMPATIBLE_API_ENDPOINTS[providerName] || COMPATIBLE_API_ENDPOINTS.groq'))
        return 'generic else no longer has COMPATIBLE_API_ENDPOINTS[providerName] || COMPATIBLE_API_ENDPOINTS.groq fallback'
    }
  ))

  results.forEach(printResult)
  return summarize('U', 'C9 responder custom-provider routing', results)
}
