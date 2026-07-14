// ============================================================
// Behavioral Audit — Category 3: Web Research
// Light verification: response content only
// ============================================================

import { runTest, runWarn, summarize, printResult, C, GroupSummary } from '../utils'
import { callAiden } from '../server-control'

export async function run(): Promise<GroupSummary> {
  const GROUP = 'B3'
  const NAME  = 'WebResearch'
  console.log(`\n${C.bold}[B3] Web Research${C.reset}`)
  const results = []

  // ── B3-01: Weather ────────────────────────────────────────────────────────
  results.push(await runWarn('B3-01', GROUP, 'Mumbai weather — mentions temperature OR honest about failure', async () => {
    const reply = await callAiden(`What is the current weather in Mumbai?`)
    const lower = reply.toLowerCase()
    const hasWeather = /\d+\s*°/.test(reply) || lower.includes('temperature') || lower.includes('celsius') || lower.includes('fahrenheit') || lower.includes('humid') || lower.includes('°c') || lower.includes('°f')
    const honest     = lower.includes("couldn't") || lower.includes('unable') || lower.includes('sorry') || lower.includes("can't") || lower.includes('access') || lower.includes('real-time')
    if (!hasWeather && !honest) return `response neither mentions weather data nor admits limitation: ${reply.slice(0, 150)}`
    if (reply.trim().length < 20) return `suspiciously short response: "${reply}"`
  }))

  // ── B3-02: GitHub repo ────────────────────────────────────────────────────
  results.push(await runWarn('B3-02', GROUP, 'github.com content — response mentions meaningful content', async () => {
    const reply = await callAiden(`What's on github.com right now? What are the top trending repos?`)
    const lower = reply.toLowerCase()
    const hasContent = lower.includes('github') || lower.includes('repo') || lower.includes('star') || lower.includes('trending')
    const honest     = lower.includes("couldn't") || lower.includes('unable') || lower.includes("can't") || lower.includes('access')
    if (!hasContent && !honest) return `no GitHub content or honest failure: ${reply.slice(0, 150)}`
    if (reply.trim().length < 30) return `too short to be meaningful: "${reply}"`
  }))

  // ── B3-03: Web search + summarize ─────────────────────────────────────────
  results.push(await runWarn('B3-03', GROUP, 'Search "Anthropic Claude" — mentions Anthropic AND summarizes ≥ 3 items', async () => {
    const reply = await callAiden(`Search for "Anthropic Claude" and summarize the top 3 results.`)
    const lower = reply.toLowerCase()
    const hasAnthropic = lower.includes('anthropic')
    const hasCompatibleProvider = lower.includes('claude')
    const hasNumbers   = /\b[123]\b|first|second|third|one|two|three/.test(lower)

    if (!hasAnthropic && !hasCompatibleProvider) return `response doesn't mention Anthropic or Claude: ${reply.slice(0, 150)}`
    if (reply.trim().split('\n').length < 2 && reply.length < 100) return `response too thin — not a summary: ${reply.slice(0, 150)}`
  }))

  // ── B3-04: Fetch landing page ─────────────────────────────────────────────
  results.push(await runWarn('B3-04', GROUP, 'Fetches aiden.taracod.com — mentions install or Aiden features', async () => {
    const reply = await callAiden(`Fetch https://aiden.taracod.com and tell me what's on that page.`)
    const lower = reply.toLowerCase()
    const hasAiden   = lower.includes('aiden')
    const hasContent = lower.includes('install') || lower.includes('feature') || lower.includes('download') || lower.includes('ai') || lower.includes('assistant')
    const honest     = lower.includes("couldn't") || lower.includes('unable') || lower.includes("can't") || lower.includes('error')
    if (!hasAiden && !hasContent && !honest) return `no relevant content from aiden.taracod.com: ${reply.slice(0, 150)}`
  }))

  // ── B3-05: Bitcoin price ─────────────────────────────────────────────────
  results.push(await runWarn('B3-05', GROUP, 'Bitcoin price — response has number + currency OR admits limitation', async () => {
    const reply = await callAiden(`What's the price of Bitcoin right now?`)
    const lower = reply.toLowerCase()
    const hasPrice   = /\$[\d,]+|\d[\d,]+\s*(usd|dollar|btc)/.test(lower) || /bitcoin.*\d[\d,]+/.test(lower)
    const hasCurrency = lower.includes('usd') || lower.includes('dollar') || lower.includes('$')
    const honest      = lower.includes("couldn't") || lower.includes('unable') || lower.includes("can't") || lower.includes('real-time') || lower.includes('access')
    if (!hasPrice && !honest) return `no price data or honest failure: ${reply.slice(0, 150)}`
  }))

  results.forEach(printResult)
  return summarize(GROUP, NAME, results)
}
