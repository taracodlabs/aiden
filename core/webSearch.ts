// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/webSearch.ts — Reliable web search with 4-method fallback chain
//
// Priority order:
//   1. SearxNG (self-hosted, unlimited, Docker on port 8888)
//   2. Brave Search API (if BRAVE_SEARCH_API_KEY env var set)
//   3. DuckDuckGo Instant Answer API + HTML scrape
//   4. Wikipedia (always available, good for factual queries)
//
// Usage:
//   import { reliableWebSearch, deepResearch } from './webSearch'
//   const result = await reliableWebSearch('query')

// ── Debug logging (v4.1.5 Issue O) ────────────────────────────
//
// All `[webSearch]` / `[deepResearch]` chatter goes through these two
// helpers, both gated on `process.env.AIDEN_DEBUG_WEB === '1'`. The
// v4 REPL ran with these blasting unconditionally to stdout/stderr,
// surfacing 20+ lines of fallback-chain diagnostics between the user
// prompt and Aiden's reply on any web-search turn — overwhelming the
// signal users actually wanted (the tool-trail row).
//
// Power users debugging a flaky search backend export the env var:
//     AIDEN_DEBUG_WEB=1 aiden
// Same pattern as `AIDEN_NO_REFORMAT`, `AIDEN_UI_ICONS`. Default off.
//
// `core/webSearch.ts` is shared with the legacy v3 path which has no
// Display dependency, so we cannot route through `display.dim()` /
// the v4 verbose-mode config. An env var is the lowest-friction
// transport that works in both paths.
function debugLog(...args: unknown[]): void {
  if (process.env.AIDEN_DEBUG_WEB === '1') {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

function debugWarn(...args: unknown[]): void {
  if (process.env.AIDEN_DEBUG_WEB === '1') {
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}

// ── Types ─────────────────────────────────────────────────────

interface SearchResult {
  title:   string
  url:     string
  snippet: string
  source:  string
}

interface SearchResponse {
  success:  boolean
  output:   string
  method:   string
  results?: SearchResult[]
  error?:   string
}

// ── Constants ─────────────────────────────────────────────────

const SEARXNG_URL    = process.env.SEARXNG_URL    || 'http://localhost:8888'
const BRAVE_API_KEY  = process.env.BRAVE_SEARCH_API_KEY || ''

// ── v4.11 perf: 5-min TTL backend-availability cache ──────────
//
// Pre-flight skip-on-unavailable for SearxNG + Brave. The fallback
// chain in `reliableWebSearch` (SearxNG → Brave → DDG → Wikipedia)
// wastes ~10s × N_searches when SearxNG isn't running and Brave has
// no API key (the common case for a fresh install). This cache
// avoids the dead-backend timeout on every call.
//
// TTL chosen at 5min: long enough to amortize the probe across many
// searches in a research session, short enough that if the user
// brings SearxNG up mid-session it'll be picked up on the next
// expiry. Re-probes happen lazily inside `_isBackendAvailable`.
const BACKEND_TTL_MS = 5 * 60 * 1000
interface BackendHealth { available: boolean; checkedAt: number }
const _backendHealth: { searxng: BackendHealth | null; brave: BackendHealth | null } = {
  searxng: null,
  brave:   null,
}

async function _isSearxNGAvailable(): Promise<boolean> {
  const cached = _backendHealth.searxng
  if (cached && Date.now() - cached.checkedAt < BACKEND_TTL_MS) {
    return cached.available
  }
  // checkSearxNG already has a 3s timeout. Cache the result either way.
  const available = await checkSearxNG()
  _backendHealth.searxng = { available, checkedAt: Date.now() }
  return available
}

function _isBraveAvailable(): boolean {
  // Brave is config-driven (API key env var). No network probe needed —
  // if the key isn't set the call returns null instantly. Still cached
  // so the env-var read happens once per TTL window.
  const cached = _backendHealth.brave
  if (cached && Date.now() - cached.checkedAt < BACKEND_TTL_MS) {
    return cached.available
  }
  const available = BRAVE_API_KEY.length > 0
  _backendHealth.brave = { available, checkedAt: Date.now() }
  return available
}

/** Test helper: reset backend-availability cache between tests. */
export function _resetBackendHealthForTests(): void {
  _backendHealth.searxng = null
  _backendHealth.brave   = null
}
const SEARCH_TIMEOUT = 10000

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

// ── METHOD 1: SearxNG ──────────────────────────────────────────

async function searchViaSearxNG(query: string): Promise<SearchResponse | null> {
  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&language=en&categories=general`
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(SEARCH_TIMEOUT),
    })
    if (!res.ok) {
      debugWarn(`[webSearch] SearxNG returned ${res.status}`)
      return null
    }
    const data = await res.json() as any
    const results: SearchResult[] = (data.results || []).slice(0, 10).map((r: any) => ({
      title:   r.title   || '',
      url:     r.url     || '',
      snippet: r.content || '',
      source:  'searxng',
    }))
    if (results.length === 0) return null

    const lines = results.map(r => `**${r.title}**\n${r.snippet}\n${r.url}`)
    const output = `[SearxNG Results for "${query}"]\n\n${lines.join('\n\n')}`
    debugLog(`[webSearch] SearxNG: ${results.length} results`)
    return { success: true, output, method: 'searxng', results }
  } catch (e: any) {
    debugWarn(`[webSearch] SearxNG failed: ${e.message}`)
    return null
  }
}

// ── METHOD 2: Brave Search API ────────────────────────────────

async function searchViaBrave(query: string): Promise<SearchResponse | null> {
  if (!BRAVE_API_KEY) return null
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`
    const res = await fetch(url, {
      headers: {
        'Accept':               'application/json',
        'Accept-Encoding':      'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    })
    if (!res.ok) {
      debugWarn(`[webSearch] Brave API returned ${res.status}`)
      return null
    }
    const data    = await res.json() as any
    const webHits = data?.web?.results || []
    if (webHits.length === 0) return null

    const results: SearchResult[] = (webHits as any[]).map(r => ({
      title:   r.title       || '',
      url:     r.url         || '',
      snippet: r.description || '',
      source:  'brave',
    }))
    const lines  = results.map(r => `**${r.title}**\n${r.snippet}\n${r.url}`)
    const output = `[Brave Search Results for "${query}"]\n\n${lines.join('\n\n')}`
    debugLog(`[webSearch] Brave: ${results.length} results`)
    return { success: true, output, method: 'brave', results }
  } catch (e: any) {
    debugWarn(`[webSearch] Brave failed: ${e.message}`)
    return null
  }
}

// ── METHOD 3: DuckDuckGo (Instant API + HTML scrape) ──────────

async function searchViaDDG(query: string): Promise<SearchResponse | null> {
  const parts: string[] = []

  // DDG Instant Answer API
  try {
    const ddgUrl  = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const ddgRes  = await fetch(ddgUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal:  AbortSignal.timeout(8000),
    })
    const ddgData = await ddgRes.json() as any
    if (ddgData.Answer)       parts.push(`Answer: ${ddgData.Answer}`)
    if (ddgData.Abstract)     parts.push(`Summary: ${ddgData.Abstract}`)
    if (ddgData.AbstractText && !ddgData.Abstract) parts.push(ddgData.AbstractText)
    if (ddgData.RelatedTopics?.length) {
      const topics = (ddgData.RelatedTopics as any[])
        .slice(0, 6)
        .map(t => t.Text || t.Result || '')
        .filter(Boolean)
      if (topics.length) parts.push(`Related: ${topics.join('. ')}`)
    }
  } catch (e: any) {
    debugWarn(`[webSearch] DDG Instant failed: ${e.message}`)
  }

  // DDG HTML scrape — get snippet text + page content
  try {
    const htmlRes = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: { 'User-Agent': USER_AGENT },
        signal:  AbortSignal.timeout(10000),
      },
    )
    const html = await htmlRes.text()

    // Extract snippets
    const snippetMatches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    const snippets = snippetMatches
      .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 30)
      .slice(0, 5)
    if (snippets.length > 0) {
      parts.push(`Search Snippets:\n${snippets.join('\n')}`)
    }

    // Fetch top 2 result pages
    const urlMatches = [...html.matchAll(/uddg=(https?[^&"]+)/g)]
    const urls = urlMatches
      .map(m => decodeURIComponent(m[1]))
      .filter(u => !u.includes('duckduckgo.com') && !u.includes('youtube.com') && u.startsWith('https'))
      .filter((u, i, arr) => arr.indexOf(u) === i)
      .slice(0, 2)

    const pageTexts = await Promise.all(urls.map(async (url) => {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal:  AbortSignal.timeout(7000),
        })
        if (!r.ok) return null
        const text  = await r.text()
        const clean = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (clean.length < 200) return null
        return `[${url}]\n${clean.slice(0, 1500)}`
      } catch { return null }
    }))
    const validPages = pageTexts.filter(Boolean) as string[]
    if (validPages.length > 0) parts.push(...validPages)

  } catch (e: any) {
    debugWarn(`[webSearch] DDG HTML scrape failed: ${e.message}`)
  }

  if (parts.length === 0) return null

  const output = `[DuckDuckGo Results for "${query}"]\n\n${parts.join('\n\n')}`
  debugLog(`[webSearch] DDG: ${parts.length} sections`)
  return { success: true, output, method: 'ddg' }
}

// ── METHOD 4: Wikipedia ───────────────────────────────────────

async function searchViaWikipedia(query: string): Promise<SearchResponse | null> {
  try {
    const searchRes  = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`,
      { signal: AbortSignal.timeout(6000) },
    )
    const searchData = await searchRes.json() as any
    const hits       = searchData?.query?.search || []
    if (hits.length === 0) return null

    const topTitle   = hits[0].title
    const summaryRes = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topTitle)}`,
      { signal: AbortSignal.timeout(6000) },
    )
    if (!summaryRes.ok) return null

    const wiki = await summaryRes.json() as any
    if (!wiki.extract || wiki.extract.length < 50) return null

    const snippets = (hits as any[])
      .slice(1, 4)
      .map(h => h.snippet?.replace(/<[^>]+>/g, '') || '')
      .filter(s => s.length > 20)
    const extra  = snippets.length > 0 ? `\n\nRelated: ${snippets.join(' | ')}` : ''
    const output = `[Wikipedia: ${wiki.title}]\n${wiki.extract.slice(0, 1500)}${extra}`

    debugLog(`[webSearch] Wikipedia: ${wiki.extract.length} chars for "${wiki.title}"`)
    return { success: true, output, method: 'wikipedia' }
  } catch (e: any) {
    debugWarn(`[webSearch] Wikipedia failed: ${e.message}`)
    return null
  }
}

// ── Weather shortcut ──────────────────────────────────────────

async function fetchWeather(query: string): Promise<SearchResponse | null> {
  const city = query
    .replace(/what(?:'s| is) the weather/gi, '')
    .replace(/\b(weather|forecast|today|current|temperature|rain|snow|sunny|cloudy|humidity|wind|in|for)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || 'auto'
  try {
    const wr   = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { signal: AbortSignal.timeout(8000) })
    const data = await wr.json() as any
    const cc   = data.current_condition?.[0]
    const area = data.nearest_area?.[0]
    if (!cc || !area) return null

    const location = [area.areaName?.[0]?.value, area.country?.[0]?.value].filter(Boolean).join(', ')
    const desc     = cc.weatherDesc?.[0]?.value || ''
    let out = `Weather for ${location || city}:\n`
    out    += `Condition: ${desc}\n`
    out    += `Temperature: ${cc.temp_C}°C / ${cc.temp_F}°F (feels like ${cc.FeelsLikeC}°C)\n`
    out    += `Humidity: ${cc.humidity}% | Wind: ${cc.windspeedKmph} km/h ${cc.winddir16Point} | Visibility: ${cc.visibility} km | UV: ${cc.uvIndex}\n`
    const forecasts = (data.weather || []).slice(0, 3) as any[]
    if (forecasts.length) {
      out += '\n3-Day Forecast:\n'
      for (const day of forecasts) {
        const mid = day.hourly?.[4]?.weatherDesc?.[0]?.value || ''
        out += `  ${day.date}: High ${day.maxtempC}°C / Low ${day.mintempC}°C${mid ? ' — ' + mid : ''}\n`
      }
    }
    debugLog(`[webSearch] Weather: retrieved for "${city}"`)
    return { success: true, output: out.trim(), method: 'wttr.in' }
  } catch (e: any) {
    debugWarn(`[webSearch] Weather failed: ${e.message}`)
    return null
  }
}

// ── Main exported function ────────────────────────────────────

export async function reliableWebSearch(query: string): Promise<{ success: boolean; output: string; error?: string }> {
  if (!query?.trim()) return { success: false, output: '', error: 'No query provided' }
  debugLog(`[webSearch] Query: "${query}"`)

  // Weather shortcut
  if (/weather|temperature|forecast|rain|snow|sunny|cloudy|humidity|wind/i.test(query)) {
    const weather = await fetchWeather(query)
    if (weather) return { success: true, output: weather.output }
  }

  // v4.11 perf — skip dead backends. SearxNG probe is async (3s
  // timeout, cached 5min); Brave is a sync env-var read. Both writes
  // populate the cache for subsequent calls in the same session.
  // Method 1 — SearxNG (skip when probe says unavailable)
  if (await _isSearxNGAvailable()) {
    const searxResult = await searchViaSearxNG(query)
    if (searxResult) {
      debugLog(`[webSearch] ✓ SearxNG succeeded`)
      return { success: true, output: searxResult.output.slice(0, 10000) }
    }
  } else {
    debugLog(`[webSearch] SearxNG skipped — not available (cached)`)
  }

  // Method 2 — Brave (skip when API key missing)
  if (_isBraveAvailable()) {
    const braveResult = await searchViaBrave(query)
    if (braveResult) {
      debugLog(`[webSearch] ✓ Brave succeeded`)
      return { success: true, output: braveResult.output.slice(0, 10000) }
    }
  } else {
    debugLog(`[webSearch] Brave skipped — no API key (cached)`)
  }

  // Method 3 — DDG
  const ddgResult = await searchViaDDG(query)
  if (ddgResult) {
    debugLog(`[webSearch] ✓ DDG succeeded`)
    return { success: true, output: ddgResult.output.slice(0, 10000) }
  }

  // Method 4 — Wikipedia
  const wikiResult = await searchViaWikipedia(query)
  if (wikiResult) {
    debugLog(`[webSearch] ✓ Wikipedia fallback`)
    return { success: true, output: wikiResult.output }
  }

  debugWarn(`[webSearch] All methods failed for: "${query}"`)
  return {
    success: false,
    output:  '',
    error:   `Web search failed for "${query}" — all 4 methods exhausted (SearxNG, Brave, DuckDuckGo, Wikipedia). Try starting SearxNG: .\\scripts\\start-searxng.ps1`,
  }
}

// ── Deep research — 3-pass synthesis ─────────────────────────

export async function deepResearch(topic: string): Promise<{ success: boolean; output: string; error?: string }> {
  if (!topic?.trim()) return { success: false, output: '', error: 'No topic provided' }
  debugLog(`[deepResearch] Topic: "${topic}"`)

  const parts: string[] = []

  // Pass 1: Broad
  debugLog(`[deepResearch] Pass 1: broad`)
  const broad = await reliableWebSearch(topic)
  if (broad.success && broad.output.length > 100) {
    parts.push(`=== PASS 1: BROAD RESEARCH ===\n${broad.output}`)
  }

  // Pass 2: Latest 2026
  const latestQ = `${topic} 2026 latest`
  debugLog(`[deepResearch] Pass 2: latest — "${latestQ}"`)
  const latest = await reliableWebSearch(latestQ)
  if (latest.success && latest.output.length > 100) {
    parts.push(`=== PASS 2: LATEST (2026) ===\n${latest.output}`)
  }

  // Pass 3: Comparison / review
  const compareQ = `best top ${topic} comparison review`
  debugLog(`[deepResearch] Pass 3: comparison — "${compareQ}"`)
  const compare = await reliableWebSearch(compareQ)
  if (compare.success && compare.output.length > 100) {
    parts.push(`=== PASS 3: COMPARISON & REVIEWS ===\n${compare.output}`)
  }

  if (parts.length === 0) {
    return { success: false, output: '', error: `No research results found for: ${topic}` }
  }

  const combined = parts.join('\n\n')
  debugLog(`[deepResearch] Complete: ${combined.length} chars across ${parts.length} passes`)
  return { success: true, output: combined.slice(0, 15000) }
}

// ── SearxNG health check ──────────────────────────────────────

export async function checkSearxNG(): Promise<boolean> {
  try {
    const res = await fetch(`${SEARXNG_URL}/search?q=test&format=json`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
