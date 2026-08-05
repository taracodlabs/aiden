#!/usr/bin/env node
// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// cli/aiden.ts — Production Terminal UI for Aiden
// Connects to the API server at http://localhost:4200

import readline from 'readline'
import fs       from 'fs'
import path     from 'path'
import { paint, fg, RST, COLORS, MARKS, BOLD as THM_BOLD } from '../core/theme'
import { renderStatusBar }                                   from '../core/statusBar'
import { table, panel }                                      from '../core/panel'
import type { ColDef }                                       from '../core/panel'
import { SPINNER_FRAMES_RAW }                               from '../core/spinner'
import { checkForUpdate, formatUpdateLine }                  from '../core/updateCheck'
import { VERSION }                                           from '../core/version'
import { COMMANDS, COMMAND_DETAIL, getCatalog }             from './commandCatalog'
import type { CmdDetail }                                    from './commandCatalog'
import * as commandCatalog                                   from './commandCatalog'
import { TOOL_DESCRIPTIONS }                                 from '../core/toolRegistry'
import { resolveDesktopApiClientLocalCommand }                from './desktopApiClientArgs'

// ── Constants ────────────────────────────────────────────────────────────────────

const API_BASE      = process.env.AIDEN_API || 'http://localhost:4200'
let   SESSION_ID    = `session_${Date.now()}`
let   _activeRL: readline.Interface | null = null   // module-scope ref for dropdown refresh
const SESSION_START = Date.now()
let   RESUMED_FROM: string | null = null
const CONFIG_PATH   = path.join(__dirname, '..', 'config', 'devos.config.json')
const MAX_TURNS     = 15

// ── Theme ─────────────────────────────────────────────────────────────────────────

type ThemeName = 'default' | 'mono' | 'slate' | 'ember'

interface Theme {
  primary: string; accent: string; dim: string
  success: string; error: string;  warning: string
  bold: string;    reset: string;  white: string
  ok: string
}

const THEMES: Record<ThemeName, Theme> = {
  default: {
    primary: '\x1b[38;5;208m', accent : '\x1b[36m',         dim    : '\x1b[2m',
    success: '\x1b[32m',       error  : '\x1b[31m',         warning: '\x1b[33m',
    bold   : '\x1b[1m',        reset  : '\x1b[0m',          white  : '\x1b[97m',
    ok     : '\x1b[32m',
  },
  mono: {
    primary: '\x1b[97m',       accent : '\x1b[90m',         dim    : '\x1b[2m',
    success: '\x1b[97m',       error  : '\x1b[31m',         warning: '\x1b[97m',
    bold   : '\x1b[1m',        reset  : '\x1b[0m',          white  : '\x1b[97m',
    ok     : '\x1b[97m',
  },
  slate: {
    primary: '\x1b[38;5;111m', accent : '\x1b[38;5;147m',  dim    : '\x1b[2m',
    success: '\x1b[32m',       error  : '\x1b[31m',         warning: '\x1b[33m',
    bold   : '\x1b[1m',        reset  : '\x1b[0m',          white  : '\x1b[97m',
    ok     : '\x1b[32m',
  },
  ember: {
    primary: '\x1b[38;5;160m', accent : '\x1b[38;5;214m',  dim    : '\x1b[2m',
    success: '\x1b[32m',       error  : '\x1b[31m',         warning: '\x1b[33m',
    bold   : '\x1b[1m',        reset  : '\x1b[0m',          white  : '\x1b[97m',
    ok     : '\x1b[32m',
  },
}

let T: Theme = THEMES.default

function applyTheme(name: ThemeName): void {
  T = THEMES[name] ?? THEMES.default
}

// ── Config helpers ────────────────────────────────────────────────────────────────

function loadCfg(): any {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

function saveCfg(cfg: any): void {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n') } catch {}
}

// Load saved theme on startup
;(() => {
  const cfg  = loadCfg()
  const name = (cfg?.cli?.theme || 'default') as ThemeName
  if (THEMES[name]) applyTheme(name)
})()

// ── State ─────────────────────────────────────────────────────────────────────────

interface HistoryEntry { role: 'user' | 'assistant'; content: string }

const state = {
  history     : [] as HistoryEntry[],
  turnCount   : 0,
  ctxPercent  : 0,
  lastProvider: 'aiden',
  lastModel   : '',
  lastTurnMs  : 0,
  inputHistory: [] as string[],
  streaming   : false,
  abortCtrl   : null as AbortController | null,
  detailLevel : 'tools'  as 'off' | 'tools' | 'verbose',
  depthLevel  : 'medium' as 'low' | 'medium' | 'high',
  persona     : 'default',
  themeName   : 'default' as ThemeName,
  privateMode : false,
  focusMode   : false,
  yoloMode    : false,
  attachments : [] as string[],
  sessionName : '',
  redoStack   : [] as HistoryEntry[][],
  voiceMode          : false,
  voiceDesign        : undefined as string | undefined,
  voiceReferencePath : undefined as string | undefined,
  lastTimingData     : null as null | { first_token_ms: number; total_ms: number; completion_tokens: number },
}

// ── Module-level rl reference for pause/resume during streaming ───────────────────
let _rl: import('readline').Interface | null = null

// ── Skill Store pager state (active while /skills list is in pager mode) ──────────
let pagerActive = false
let pagerState: { skills: any[]; pageIndex: number; pageSize: number } | null = null

// ── Terminal helpers ──────────────────────────────────────────────────────────────

const cols = (): number => Math.min(process.stdout.columns || 80, 100)
const hr   = (): string => '─'.repeat(cols() - 2)

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function num(n: number): string { return n.toLocaleString() }

/** Colored source badge for skill tables.
 *  Spec: aiden=orange  community=cyan  local/other=dim gray
 */
function sourceBadgeStr(source: string): string {
  const s = (source || '').toLowerCase()
  if (s === 'aiden' || s === 'builtin' || s === 'built-in')
    return `${fg(COLORS.orange)}${source || 'aiden'}${RST}`
  if (s === 'community')
    return `${fg(COLORS.cyan)}community${RST}`
  // local, npm, unknown → dim gray
  return `${T.dim}${source || 'local'}${T.reset}`
}

/** Trust stars: ★★★☆☆ (score clamped to 0-5). */
function trustStars(score: number): string {
  const n = Math.max(0, Math.min(5, Math.round(score)))
  return `${fg(COLORS.orange)}${'★'.repeat(n)}${RST}${T.dim}${'☆'.repeat(5 - n)}${T.reset}`
}

/** Render one page of the Skill Store table. Used by /skills list and the pager. */
function renderSkillsPage(skills: any[], pageIndex: number, pageSize: number): void {
  const start = pageIndex * pageSize
  const slice = skills.slice(start, start + pageSize)
  const total = skills.length
  const pages = Math.ceil(Math.max(total, 1) / pageSize)

  const installed = skills.filter((s: any) => s.installed || s.enabled).length
  const pro       = skills.filter((s: any) => s.tier === 'pro').length

  const colDefs: ColDef[] = [
    { header: '#',           width: 4,  align: 'right', color: COLORS.dim },
    { header: 'Skill',       width: 20, align: 'left'  },
    { header: 'Description'                             },
    { header: 'Source',      width: 10, align: 'left'  },
    { header: 'Trust',       width: 7,  align: 'left'  },
  ]
  const rows = slice.map((s: any, i: number) => [
    String(start + i + 1),
    (s.name || '').substring(0, 20),
    (s.description || '').substring(0, 55),
    sourceBadgeStr(s.origin || s.source || s.type || ''),
    trustStars(s.trust ?? 3),
  ])
  const footerStats = `${total} skills · ${installed} installed${pro > 0 ? ` · ${pro} pro` : ''} · page ${pageIndex + 1}/${pages}`
  const footerNav   = pages > 1
    ? `${MARKS.TRI} /skills install <name>   n → next   p → prev   q → quit`
    : `${MARKS.TRI} /skills install <name>   /skills inspect <n|name>`
  console.log()
  console.log(panel({
    title: `${MARKS.TRI} Skill Store`,
    lines: ['', ...slice.length === 0 ? [`  ${T.dim}No skills loaded.${T.reset}`] : []],
  }))
  console.log(table(colDefs, rows))
  console.log()
  console.log(`  ${T.dim}${footerStats}${T.reset}`)
  console.log(`  ${T.dim}${footerNav}${T.reset}`)
  console.log()
}

function ctxColor(pct: number): string {
  if (pct < 50) return T.success
  if (pct < 80) return T.warning
  if (pct < 95) return T.primary
  return T.error
}

function ctxBar(pct: number): string {
  const filled = Math.round(pct / 10)
  const bar    = '▰'.repeat(filled) + '▱'.repeat(10 - filled)
  return `[${bar}] ${pct}%`
}

// ── Spinner frames ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = SPINNER_FRAMES_RAW

// ── API helpers ───────────────────────────────────────────────────────────────────

async function apiFetch<R>(p: string, fallback: R): Promise<R> {
  try {
    const res = await fetch(`${API_BASE}${p}`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return fallback
    return await res.json() as R
  } catch { return fallback }
}

async function apiPost(p: string, body: any = {}): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${p}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
    })
    return await res.json().catch(() => null)
  } catch { return null }
}

async function apiDelete(p: string): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${p}`, { method: 'DELETE' })
    return res.ok ? (await res.json().catch(() => null)) : null
  } catch { return null }
}

// ── ASCII banner ──────────────────────────────────────────────────────────────────

const ASCII_BANNER = [
  '█████╗ ██╗██████╗ ███████╗███╗   ██╗',
  '██╔══██╗██║██╔══██╗██╔════╝████╗  ██║',
  '███████║██║██║  ██║█████╗  ██╔██╗ ██║',
  '██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║',
  '██║  ██║██║██████╔╝███████╗██║ ╚████║',
  '╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝',
]

const TAGLINES = [
  'Your personal AI OS.',
  'Runs on your machine.',
  'Zero telemetry.',
  'The brain in your terminal.',
  'Built in India. Runs anywhere.',
]

async function printBanner(): Promise<void> {
  const [health, memData, provData, skillsData, toolsData] = await Promise.all([
    apiFetch<any>('/api/health',    {}),
    apiFetch<any>('/api/memories',  {}),
    apiFetch<any>('/api/providers', { apis: [] }),
    apiFetch<any[]>('/api/skills',  []),
    apiFetch<any[]>('/api/tools',   []),
  ])

  const version   = VERSION || health.version || '3.7.0'
  const cfg       = loadCfg()
  const apis      = Array.isArray(provData.apis) ? provData.apis : []
  const active    = apis.filter((a: any) => {
    if (!a.enabled) return false
    const k = a.key || ''
    return k.startsWith('env:') ? !!(process.env[k.replace('env:', '')]) : k.length > 0
  })
  const provName  = cfg?.model?.active       || active[0]?.name  || 'local'
  const modelName = cfg?.model?.activeModel  || active[0]?.model || 'unknown'
  const skillArr  = Array.isArray(skillsData) ? skillsData : []
  const enabled   = skillArr.filter((s: any) => s.enabled)
  const recipes   = skillArr.filter((s: any) => s.type === 'recipe' || s.isRecipe).length
  const toolCount = Array.isArray(toolsData) ? toolsData.length : 0
  const memSem    = memData?.semantic ?? (Array.isArray(memData) ? memData.length : memData?.total ?? 0)
  const memEnt    = memData?.entities ?? 0

  if (active.length > 0) {
    state.lastProvider = provName
    state.lastModel    = modelName
  }

  // Kick off update check in background (non-blocking)
  const updatePromise = checkForUpdate(version)

  // ── Wordmark ──
  console.log()
  for (const line of ASCII_BANNER) {
    console.log(`  ${fg(COLORS.orange)}${line}${RST}`)
  }
  console.log()

  // ── Capability flex ──
  const sep = `${T.dim} · ${T.reset}`
  const provDot  = active.length > 0 ? `${T.success}●${T.reset}` : `${T.error}●${T.reset}`
  const memDot   = (memSem + memEnt) > 0 ? `${T.success}●${T.reset}` : `${T.dim}○${T.reset}`
  const skillDot = enabled.length > 0 ? `${T.success}●${T.reset}` : `${T.dim}○${T.reset}`

  console.log(
    `  ${provDot} ${fg(COLORS.orange)}${provName}${RST} ${T.dim}${modelName}${T.reset}` +
    sep +
    `${skillDot} ${T.dim}${enabled.length}/${skillArr.length} skills${T.reset}` +
    sep +
    `${T.dim}${toolCount} tools${T.reset}` +
    sep +
    `${memDot} ${T.dim}${num(memSem)} mem${T.reset}`
  )

  // ── Session ──
  console.log(`  ${T.dim}${hr()}${T.reset}`)
  console.log(`  ${T.dim}session  ${T.reset}${T.dim}${SESSION_ID}${T.reset}`)
  console.log(`  ${T.dim}v${version}${T.reset}`)

  // ── Update-available line (await with 0-ms fallback so banner isn't blocked) ──
  const updateInfo = await Promise.race([
    updatePromise,
    new Promise<null>(r => setTimeout(() => r(null), 0)),
  ])
  const updateLine = formatUpdateLine(updateInfo)
  if (updateLine) console.log(updateLine)

  // ── Dashboard link + Ready prompt ──
  const port = (API_BASE.split(':')[2] || '4200').replace(/\D.*/, '')
  console.log(`  ${T.dim}dashboard${T.reset} ${fg(COLORS.orange)}http://localhost:${port}/ui${RST}`)
  console.log(`  ${T.dim}${hr()}${T.reset}`)
  console.log(`  ${fg(COLORS.orange)}ready ${MARKS.ARROW}${RST}  ${T.dim}/help for commands${T.reset}`)
  console.log()
}

// ── Goal complete card ────────────────────────────────────────────────────────────

function showGoalComplete(name: string): void {
  const orange  = '\x1b[38;5;208m'
  const w       = cols() - 6
  const side    = Math.floor((w - name.length - 16) / 2)
  const dashes  = '─'.repeat(Math.max(4, side))
  console.log()
  console.log(`  ${orange}◆ ${dashes} ◆${T.reset}`)
  console.log(`  ${orange}Goal complete: ${name}${T.reset}`)
  console.log(`  ${orange}◆ ${dashes} ◆${T.reset}`)
  console.log()
}

// ── Session summary ───────────────────────────────────────────────────────────────

function printSessionSummary(): void {
  const ms        = Date.now() - SESSION_START
  const userMsgs  = state.history.filter(h => h.role === 'user').length
  const totChars  = state.history.reduce((n, h) => n + h.content.length, 0)
  const approxTok = Math.round(totChars / 4)
  const cost      = (approxTok / 1_000_000 * 0.10).toFixed(4)
  const div       = `  ${T.dim}${'─'.repeat(cols() - 4)}${T.reset}`
  console.log()
  console.log(`  Session ended`)
  console.log(div)
  console.log(`  ${'Duration'.padEnd(14)}${fmtDuration(ms)}`)
  console.log(`  ${'Messages'.padEnd(14)}${state.history.length} (${userMsgs} user, ${state.turnCount} turns)`)
  console.log(`  ${'Tokens'.padEnd(14)}~${num(approxTok)}`)
  console.log(`  ${'Cost'.padEnd(14)}~$${cost}`)
  console.log(`  ${'Session'.padEnd(14)}${T.dim}${SESSION_ID}${T.reset}`)
  console.log(div)
  console.log(`  ${T.dim}Resume: npm run cli -- --resume ${SESSION_ID}${T.reset}`)
  console.log()
}

// ── Stream chat ───────────────────────────────────────────────────────────────────

async function streamChat(message: string): Promise<void> {
  if (_rl) _rl.pause()  // prevent readline from fighting with unbuffered stdout writes
  state.streaming    = true
  state.abortCtrl    = new AbortController()
  const startedAt    = Date.now()
  const prevProvider = state.lastProvider
  let fullReply      = ''
  let provider       = ''
  let boxOpen        = false
  let linePos        = 0
  let streamDone     = false

  // ── Render area (ephemeral spinner + animated tool cards) ─────────────────────

  let globalFrame     = 0
  let lastRenderLines = 0
  let spinMsg         = 'understanding'
  let renderTimer: ReturnType<typeof setInterval> | null = null
  const pendingTools  = new Map<string, { startTime: number; frame: number }>()

  function clearRenderArea(): void {
    if (lastRenderLines <= 0) return
    if (lastRenderLines > 1) process.stdout.write(`\x1b[${lastRenderLines - 1}A\r`)
    else process.stdout.write('\r')
    for (let i = 0; i < lastRenderLines; i++) {
      process.stdout.write('\x1b[2K')
      if (i < lastRenderLines - 1) process.stdout.write('\n')
    }
    if (lastRenderLines > 1) process.stdout.write(`\x1b[${lastRenderLines - 1}A\r`)
    else process.stdout.write('\r')
    lastRenderLines = 0
  }

  function renderActivity(): void {
    clearRenderArea()
    const lines: string[] = []
    for (const [name, tool] of pendingTools) {
      const frame = SPINNER_FRAMES[tool.frame % SPINNER_FRAMES.length]
      tool.frame++
      lines.push(`  ${T.accent}▸${T.reset} ${name}  ${T.dim}${frame}${T.reset}\x1b[K`)
    }
    const gFrame      = SPINNER_FRAMES[globalFrame % SPINNER_FRAMES.length]
    globalFrame++
    const elapsedSec  = ((Date.now() - startedAt) / 1000).toFixed(1)
    lines.push(`  ${T.dim}${gFrame} ${spinMsg}...  ${elapsedSec}s\x1b[K${T.reset}`)
    for (let i = 0; i < lines.length; i++) {
      process.stdout.write(lines[i])
      if (i < lines.length - 1) process.stdout.write('\n')
    }
    lastRenderLines = lines.length
  }

  function startActivityRender(): void {
    if (renderTimer) return
    renderActivity()
    renderTimer = setInterval(renderActivity, 100)
  }

  function stopActivityRender(): void {
    if (renderTimer) { clearInterval(renderTimer); renderTimer = null }
    clearRenderArea()
    pendingTools.clear()
    lastRenderLines = 0
  }

  function renderSpinner(msg: string): void {
    process.stdout.write(`\r\x1b[K▲ ${msg}`)
  }

  function onToolStart(name: string): void {
    pendingTools.set(name, { startTime: Date.now(), frame: 0 })
    // Next renderActivity tick will pick up the new entry automatically
  }

  function onToolEnd(name: string, success: boolean): void {
    const tool = pendingTools.get(name)
    if (!tool) return
    const elapsed = fmtMs(Date.now() - tool.startTime)
    if (renderTimer) { clearInterval(renderTimer); renderTimer = null }
    clearRenderArea()
    const mark = success ? `${T.success}✓` : `${T.error}✗`
    process.stdout.write(`  ${T.accent}▸${T.reset} ${name}  ${mark} ${T.dim}${elapsed}${T.reset}\n`)
    pendingTools.delete(name)
    lastRenderLines = 0
    if (!boxOpen) {
      renderActivity()
      renderTimer = setInterval(renderActivity, 100)
    }
  }

  // ── Flat response panel ───────────────────────────────────────────────────────

  const AVAIL = (): number => cols() - 5

  function openResponseBox(): void {
    process.stdout.write(`\n  ${T.primary}${T.bold}Aiden${T.reset}\n`)
    process.stdout.write(`  ${T.dim}${'─'.repeat(cols() - 4)}${T.reset}\n`)
    process.stdout.write('  ')
    boxOpen = true
    linePos = 0
  }

  function closeResponseBox(): void {
    if (!boxOpen) return
    process.stdout.write(`\n  ${T.dim}${'─'.repeat(cols() - 4)}${T.reset}\n`)
    boxOpen = false
  }

  function writeToken(token: string): void {
    if (!boxOpen) openResponseBox()
    for (const ch of token) {
      if (ch === '\n') {
        process.stdout.write('\n  ')
        linePos = 0
      } else {
        if (linePos >= AVAIL()) {
          process.stdout.write('\n  ')
          linePos = 0
        }
        process.stdout.write(ch)
        linePos++
      }
    }
  }

  const histPayload = state.history.slice(-20).map(h => ({ role: h.role, content: h.content }))

  try {
    startActivityRender()

    const res = await fetch(`${API_BASE}/api/chat`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body   : JSON.stringify({ message, mode: 'auto', history: histPayload, sessionId: SESSION_ID }),
      signal : state.abortCtrl.signal,
    })

    if (!res.ok) {
      stopActivityRender()
      let errText = res.statusText
      try {
        const errBody = await res.json() as any
        if (errBody?.error) errText = errBody.error
      } catch {}
      process.stdout.write(`\n  ${T.error}✗ ${res.status} ${errText}${T.reset}\n\n`)
      return
    }

    const isSSE = (res.headers.get('content-type') || '').includes('text/event-stream')

    // ── JSON fast-path (non-SSE response) ──────────────────────────────────────
    if (!isSSE) {
      stopActivityRender()
      const data  = await res.json() as any
      const reply = (data.reply || data.message || data.content || data.response || '') as string
      openResponseBox()
      for (const ch of reply) {
        if (ch === '\n') {
          process.stdout.write('\n  ')
          linePos = 0
        } else {
          if (linePos >= AVAIL()) {
            process.stdout.write('\n  ')
            linePos = 0
          }
          process.stdout.write(ch)
          linePos++
        }
      }
      fullReply = reply
      if (data.provider) provider = data.provider as string
      closeResponseBox()
    }

    // ── SSE streaming ───────────────────────────────────────────────────────────
    if (isSSE) {
      const reader  = (res.body as any).getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''

      while (!streamDone) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { streamDone = true; break }

          let evt: any
          try { evt = JSON.parse(raw) } catch { continue }

          // ── Status action line ──
          if (evt.event === 'status' && !boxOpen) {
            const display = evt.display ?? evt.verb ?? evt.action
            spinMsg = `${display}${evt.detail && !evt.display ? ` · ${evt.detail}` : ''}`
            renderSpinner(spinMsg)
            if (renderTimer) clearInterval(renderTimer)
            renderTimer = setInterval(() => renderSpinner(spinMsg), 200)
          }

          // ── Thinking phase — update spinner message ──
          if (!boxOpen && (evt.thinking || evt.event === 'thinking_start' || evt.event === 'planning_start' || evt.event === 'memory_read')) {
            const msg = evt.thinking?.message || evt.message || evt.data?.message
            if (msg) spinMsg = (msg as string).replace(/\.+$/, '').trim().toLowerCase()
          }

          // ── Tool start ──
          if (evt.event === 'tool_start' && !boxOpen && state.detailLevel !== 'off') {
            const tool = evt.tool || evt.data?.tool || '?'
            onToolStart(tool)
          }

          // ── Tool end ──
          if (evt.event === 'tool_end' && !boxOpen && state.detailLevel !== 'off') {
            const tool    = evt.tool || evt.data?.tool || '?'
            const success = evt.success !== false
            onToolEnd(tool, success)
          }

          // ── Tool progress (live stdout lines) ──
          if (evt.event === 'progress' && !boxOpen && process.env.AIDEN_SHOW_TOOL_OUTPUT !== 'false') {
            const line = `  ↳ ${evt.tool}: ${evt.message}`
            process.stdout.write(`\r\x1b[K${line}\n`)
            if (spinMsg) renderSpinner(spinMsg)
          }

          // ── Activity events (verbose) ──
          if (evt.activity && !boxOpen && state.detailLevel === 'verbose') {
            const act = evt.activity
            if (!act.done) {
              if (renderTimer) { clearInterval(renderTimer); renderTimer = null }
              clearRenderArea()
              process.stdout.write(`  ${T.accent}▸${T.reset} ${act.agent || ''}  ${T.dim}${act.message || 'running...'}${T.reset}\n`)
              lastRenderLines = 0
              renderActivity()
              renderTimer = setInterval(renderActivity, 100)
            }
          }

          // ── Delegation (verbose) ──
          if ((evt.delegation || (evt.from && evt.to)) && !boxOpen && state.detailLevel === 'verbose') {
            const from = evt.from || evt.delegation?.from || '?'
            const to   = evt.to   || evt.delegation?.to   || '?'
            const task = (evt.task || evt.delegation?.task || '').substring(0, 60)
            if (renderTimer) { clearInterval(renderTimer); renderTimer = null }
            clearRenderArea()
            process.stdout.write(`  ${T.dim}${from} → ${to}: ${task}${T.reset}\n`)
            lastRenderLines = 0
            renderActivity()
            renderTimer = setInterval(renderActivity, 100)
          }

          // ── Goal complete ──
          if (evt.event === 'goal_complete' || evt.goalComplete) {
            const name = evt.goal || evt.goalComplete?.name || evt.name || 'goal'
            if (!boxOpen) stopActivityRender()
            showGoalComplete(name)
          }

          // ── Async task complete ──
          if (evt.event === 'async_complete' || evt.asyncComplete) {
            const taskId  = evt.taskId || evt.asyncComplete?.taskId || '?'
            const elapsed = evt.elapsed ? fmtDuration(evt.elapsed) : ''
            const suffix  = elapsed ? ` (${elapsed})` : ''
            if (!boxOpen) {
              if (renderTimer) { clearInterval(renderTimer); renderTimer = null }
              clearRenderArea()
              process.stdout.write(`\n  ${T.accent}◆${T.reset} async #${taskId} complete${suffix} ${T.dim}· /async view ${taskId}${T.reset}\n\n`)
              lastRenderLines = 0
              renderActivity()
              renderTimer = setInterval(renderActivity, 100)
            }
          }

          // ── Meta event — update status bar state before first token ──
          if (evt.event === 'meta') {
            if (evt.provider) { state.lastProvider = evt.provider as string; provider = evt.provider as string }
            if (evt.model)    state.lastModel    = evt.model    as string
          }

          // ── Text token — stop spinner, open response panel ──
          if (evt.token !== undefined) {
            if (!boxOpen) {
              if (renderTimer) { clearInterval(renderTimer); renderTimer = null; process.stdout.write('\r\x1b[K') }
              stopActivityRender()
            }
            writeToken(evt.token)
            fullReply += evt.token
            if (evt.provider) provider = evt.provider
          }

          // ── Done ──
          if (evt.done === true) {
            if (evt.provider) provider = evt.provider
            if (evt.timing) state.lastTimingData = evt.timing as typeof state.lastTimingData
            streamDone = true
            break
          }
        }
      }

      if (!boxOpen) stopActivityRender()
      closeResponseBox()
    }

    // ── Finalise state ──
    state.lastTurnMs = Date.now() - startedAt
    if (provider) state.lastProvider = provider
    state.turnCount++

    const totChars   = state.history.reduce((n, h) => n + h.content.length, 0) + message.length + fullReply.length
    state.ctxPercent = Math.min(99, Math.round(totChars / 160_000 * 100))

    if (fullReply.trim()) {
      state.history.push({ role: 'user',      content: message   })
      state.history.push({ role: 'assistant', content: fullReply })
    }

    // ── Voice mode: speak AI reply ──
    if (state.voiceMode && fullReply.trim()) {
      const { synthesize } = await import('../core/voice/tts')
      synthesize({
        text:               fullReply,
        referenceAudioPath: state.voiceReferencePath,
        voiceDesignPrompt:  state.voiceDesign,
      }).catch((e: Error) =>
        console.warn(`  ${T.dim}[TTS] ${e.message}${T.reset}`),
      )
    }

    // ── Provider switch indicator ──
    if (provider && provider !== prevProvider && prevProvider !== 'aiden') {
      process.stdout.write(`  ${T.dim}${prevProvider} ──→ ${provider}${T.reset}\n`)
    }

    // ── Status bar ──
    process.stdout.write(renderStatusBar({
      provider   : state.lastProvider,
      model      : state.lastModel || 'unknown',
      ctxUsed    : totChars,
      ctxMax     : 160_000,
      ctxPercent : state.ctxPercent,
      elapsedMs  : Date.now() - startedAt,
      asyncCount : 0,
      privateMode: state.privateMode,
    }) + '\n\n')

  } catch (err: any) {
    stopActivityRender()
    if (err?.name === 'AbortError') {
      process.stdout.write(`\n  ${T.warning}Interrupted.${T.reset}\n\n`)
    } else {
      process.stdout.write(`\n  ${T.error}✗ ${err?.message || err}${T.reset}\n`)
      process.stdout.write(`  ${T.dim}Is Aiden running? Start the desktop app first.${T.reset}\n\n`)
    }
  } finally {
    stopActivityRender()
    state.streaming = false
    state.abortCtrl = null
    if (_rl) _rl.resume()  // re-enable readline after streaming completes
  }
}

// ── Commands / Command Detail Registry ───────────────────────────────────────
// NOTE: COMMANDS and COMMAND_DETAIL are now imported from ./commandCatalog
// (see top-of-file import). This keeps the palette, Tab completer, and /help
// handler in sync from a single source of truth.

/** Fuzzy-match: all chars of `needle` appear in order in `haystack`. */
function fuzzyCmd(needle: string, haystack: string): boolean {
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  let i = 0
  for (const c of h) { if (c === n[i]) i++; if (i === n.length) return true }
  return false
}

function getPrompt(): string {
  const privTag = state.privateMode ? ` ${T.warning}[private]${T.reset}` : ''
  return `  ${fg(COLORS.orange)}${MARKS.TRI}${RST}${privTag} `
}

function registerCoreCommands(rl: readline.Interface): void {

  commandCatalog.register('/help', { ...COMMAND_DETAIL['/help'], origin: 'core', handler: async (args) => {
    const O  = fg(COLORS.orange)
    const D  = T.dim
    const R  = T.reset
    const B  = T.bold

    function helpRow(cmd: string, desc: string): string {
      return `  ${O}${cmd.padEnd(26)}${RST}${D}${desc}${R}`
    }
    function helpSection(title: string): string {
      return `\n  ${B}${MARKS.TRI} ${title}${R}\n  ${D}${hr()}${R}`
    }

    const sub = args[0]?.toLowerCase()
    if (sub === 'search' || (sub && !sub.startsWith('/'))) {
      const q = (sub === 'search' ? args.slice(1) : args).join(' ').toLowerCase()
      if (!q) {
        console.log(`  ${D}Usage: /help search <query>${R}\n`); return
      }
      const matches = Object.entries(COMMAND_DETAIL).filter(([cmd, d]) => {
        return cmd.includes(q) ||
          d.desc.toLowerCase().includes(q) ||
          (d.subs ?? []).some(s => s.toLowerCase().includes(q)) ||
          (d.section ?? '').toLowerCase().includes(q)
      })
      console.log()
      if (matches.length === 0) {
        console.log(`  ${D}No commands matching "${q}".${R}\n`); return
      }
      const rows = matches.map(([cmd, d]) => helpRow(cmd, d.desc))
      console.log(panel({
        title: `${MARKS.TRI} /help search "${q}"  (${matches.length} result${matches.length !== 1 ? 's' : ''})`,
        lines: ['', ...rows, ''],
        accent: COLORS.orange,
      }))
      console.log()
      return
    }

    if (sub?.startsWith('/')) {
      const d = COMMAND_DETAIL[sub]
      if (!d) {
        console.log(`  ${D}Unknown command: ${sub}  (try /help search <keyword>)${R}\n`); return
      }
      const lines: string[] = [
        '',
        `  ${B}${sub}${R}  ${D}(${d.section ?? ''})${R}`,
        `  ${d.desc}`,
        '',
      ]
      if (d.usage) {
        lines.push(`  ${D}Usage:${R}`)
        lines.push(`    ${O}${d.usage}${RST}`)
        lines.push('')
      }
      if (d.subs && d.subs.length > 0) {
        lines.push(`  ${D}Subcommands:${R}`)
        for (const s of d.subs) lines.push(`    ${O}${sub} ${s}${RST}`)
        lines.push('')
      }
      if (d.examples && d.examples.length > 0) {
        lines.push(`  ${D}Examples:${R}`)
        for (const ex of d.examples) lines.push(`    ${D}${ex}${R}`)
        lines.push('')
      }
      console.log()
      console.log(panel({ title: `${MARKS.TRI} /help ${sub}`, lines, accent: COLORS.orange }))
      console.log()
      return
    }

    const lines: string[] = [
      helpSection('Session'),
      helpRow('/new  /reset',       'Start fresh session'),
      helpRow('/clear',             'Clear screen'),
      helpRow('/history',           'Conversation history'),
      helpRow('/stop',              'Interrupt execution'),
      helpRow('/export md|json',    'Export conversation'),
      helpRow('/fork <name>',       'Fork current session'),
      helpRow('/checkpoint',        'Save state snapshot'),
      helpSection('Info'),
      helpRow('/timing',             'Last response timing breakdown'),
      helpRow('/version',            'Current version + update check'),
      helpRow('/status',            'Health + uptime'),
      helpRow('/tools',             'All registered tools  (grouped by category)'),
      helpRow('/kit',               'Toolkit categories — enable / disable'),
      helpRow('/providers',         'Provider chain + rate limits'),
      helpRow('/models',            'Model assignments'),
      helpRow('/memory',            'Memory stats'),
      helpRow('/memsearch',         'Search memories by keyword  — Layer 1 progressive disclosure'),
      helpRow('/memtimeline',       'Chronological context around a memory ID  — Layer 2'),
      helpRow('/memget',            'Full detail for specific memory IDs  — Layer 3'),
      helpRow('/goals',             'Active goals'),
      helpRow('/skills',            'Skill lifecycle  (search / registry / install / list / check / update / audit / remove / publish / export / import / stats)'),
      helpRow('/plugins',           'Plugin manager  (list / reload)'),
      helpRow('/permissions',       'Permission system  (status / reload / audit / edit)'),
      helpRow('/uninstall',         'Uninstall Aiden from this system'),
      helpRow('/install <name>',    'Install a skill from the public registry  (skills.taracod.com)'),
      helpRow('/publish <name>',    'Publish a skill to the public registry  (Pro — requires license)'),
      helpRow('/profile',             'View / edit / clear the structured user profile (Honcho model)'),
      helpRow('/failed [reason]',    'Signal last exchange failed — triggers failure trace analysis + lesson'),
      helpRow('/sandbox [sub]',      'Manage Docker sandbox mode  (status|off|auto|strict|build)'),
      helpRow('/lessons',           'Browse permanent failure rules  (search / <category>)'),
      helpRow('/teach',             'Add a manual rule to LESSONS.md'),
      helpRow('/focus',             'Toggle zen mode — suppress tool traces and status output'),
      helpRow('/explore',           'Capability browser  (tools / skills / providers)'),
      helpRow('/pulse',             'Live system dashboard — uptime, RAM, providers, async tasks'),
      helpRow('/rewind',            'Time-travel undo  (mark / undo / <n>)'),
      helpRow('/pin',               'Protect exchange from compaction  (list / unpin <idx>)'),
      helpRow('/diff',              'Filesystem changes since last commit  (git status)'),
      helpRow('/trust',             'Per-tool approval levels  (list / set <tool> <0-3> / reset <tool>)'),
      helpRow('/timeline',          'Session history tree'),
      helpRow('/garden',            'Memory layer explorer  (semantic / entities / learning / facts / hot / cold)'),
      helpRow('/decision',          'Per-turn reasoning trace  (last / clear)'),
      helpSection('Core'),
      helpRow('/log [N] [level]',   'Recent log buffer entries'),
      helpRow('/save [file]',       'Save conversation to workspace/exports/'),
      helpRow('/rerun',             'Re-send the last user message'),
      helpRow('/name <label>',      'Give the current session a name'),
      helpRow('/stack',             'Active plan steps + async tasks'),
      helpRow('/halt',              'Hard-stop all execution + LLM calls'),
      helpRow('/yolo',              'Toggle auto-approve all tool calls'),
      helpRow('/attach <path>',     'Attach file as context for next message'),
      helpRow('/changelog [N]',     'Recent git commits / workspace changes'),
      helpRow('/recipes',           `YAML recipes  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/sessions',          `Recent sessions  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/analytics',         `Usage over time  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/budget',            `Token cost estimate  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/workspace',         `Current workspace  ${T.dim}(v3.6)${T.reset}`),
      helpSection('Config'),
      helpRow('/model <name>',      'Switch model'),
      helpRow('/provider',          'List / add / remove / test providers'),
      helpRow('/primary <name>',    'Pin provider to front of chain  (reset to clear)'),
      helpRow('/theme <name>',      'Change theme  (default mono slate ember)'),
      helpRow('/persona <name>',    'Change persona  (default concise technical)'),
      helpRow('/detail',            'Cycle detail level  (off → tools → verbose)'),
      helpRow('/depth',             'Cycle reasoning depth  (low → med → high)'),
      helpRow('/config',            'Show current configuration'),
      helpSection('Power'),
      helpRow('/run <code|file>',   'Execute JS in sandbox with injected aiden SDK'),
      helpRow('/spawn <task>',      'Isolated subagent with inherited provider chain'),
      helpRow('/swarm <task>',      'Parallel subagents — vote / merge / best strategy'),
      helpRow('/search <query>',    'Hybrid BM25 + semantic session + memory search'),
      helpRow('/quick <q>',         'Quick side question  (no history, no tools)'),
      helpRow('/compact',           'Manual context compression'),
      helpRow('/async <task>',      'Run task in background'),
      helpRow('/security',          'AgentShield scan'),
      helpRow('/debug',             'Recent logs'),
      helpRow('/private',           'Toggle private mode  (suppresses memory writes)'),
      helpRow('/mcp <sub>',         'MCP server management  (list / tools / connect / disconnect / call)'),
      helpRow('/cmd <command>',     'Run a Windows cmd.exe command'),
      helpRow('/ps <command>',      'Run a PowerShell command directly'),
      helpRow('/wsl <command>',     'Run a bash command inside WSL'),
      helpRow('/refresh',            'Check for updates + reload config'),
      helpRow('/channels',           'Channel adapter status (Discord, Slack, Webhook)'),
      helpRow('/voice [on|off]',     'Toggle voice mode — TTS reads AI replies aloud'),
      helpRow('/speak <text>',       'Speak text immediately via TTS'),
      helpRow('/listen [secs]',      'Record mic → STT → send as message'),
      helpRow('/todo <op>',          'Per-session task list  (add / done / remove / list / clear)'),
      helpRow('/cron <op>',          'Schedule recurring commands  (add / list / pause / resume / delete / run)'),
      helpRow('/vision <img>',       'Analyze image with AI vision (file path or URL)'),
      helpSection('Exit'),
      helpRow('/quit  /exit  /q',   ''),
      '',
      `  ${T.dim}/help search <q>  ·  /help <command> for detail${T.reset}`,
      '',
    ]

    console.log()
    console.log(panel({
      title: `${MARKS.TRI} ▲IDEN Commands`,
      lines,
      accent: COLORS.orange,
    }))
    console.log()
  }})

  const _newResetHandler = async (_args: string[]) => {
    state.history    = []
    state.turnCount  = 0
    state.ctxPercent = 0
    ;(globalThis as any).__pinnedExchanges = []
    console.log(`\n  ${T.dim}Session cleared.${T.reset}\n`)
  }
  commandCatalog.register('/new',   { ...COMMAND_DETAIL['/new'],   origin: 'core', handler: _newResetHandler })
  commandCatalog.register('/reset', { ...COMMAND_DETAIL['/reset'], origin: 'core', handler: _newResetHandler })

  commandCatalog.register('/clear', { ...COMMAND_DETAIL['/clear'], origin: 'core', handler: async (_args) => {
    console.clear()
    await printBanner()
  }})

  commandCatalog.register('/history', { ...COMMAND_DETAIL['/history'], origin: 'core', handler: async (_args) => {
    if (state.history.length === 0) {
      console.log(`\n  ${T.dim}No history yet.${T.reset}\n`); return
    }
    console.log()
    for (const m of state.history) {
      const tag = m.role === 'user' ? `${fg(COLORS.orange)}you${T.reset}` : `${T.dim}ai${T.reset}`
      const text = m.content
      console.log(`  ${tag}  ${text.slice(0, 120)}`)
    }
    console.log()
  }})

  commandCatalog.register('/stop', { ...COMMAND_DETAIL['/stop'], origin: 'core', handler: async (_args) => {
    if (typeof (globalThis as any).__abortController?.abort === 'function') {
      ;(globalThis as any).__abortController.abort()
      console.log(`\n  ${T.dim}Abort signal sent.${T.reset}\n`)
    } else {
      console.log(`\n  ${T.dim}Nothing running.${T.reset}\n`)
    }
  }})

  commandCatalog.register('/export', { ...COMMAND_DETAIL['/export'], origin: 'core', handler: async (args) => {
    const fmt = args[0]?.toLowerCase() ?? 'md'
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outDir  = path.join(process.cwd(), 'workspace', 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const outFile = path.join(outDir, `session-${timestamp}.${fmt === 'json' ? 'json' : 'md'}`)
    if (fmt === 'json') {
      fs.writeFileSync(outFile, JSON.stringify(state.history, null, 2), 'utf8')
    } else {
      const md = state.history.map(m => {
        const role = m.role === 'user' ? '**You**' : '**Aiden**'
        const text = m.content
        return `### ${role}\n\n${text}`
      }).join('\n\n---\n\n')
      fs.writeFileSync(outFile, md, 'utf8')
    }
    console.log(`\n  ${T.dim}Exported to ${outFile}${T.reset}\n`)
  }})

  commandCatalog.register('/fork', { ...COMMAND_DETAIL['/fork'], origin: 'core', handler: async (args) => {
    const label = args.join(' ').trim() || `fork-${Date.now()}`
    const result = await apiFetch<any>('/api/session/fork', { label })
    if (result?.sessionId) {
      console.log(`\n  ${T.dim}Forked → session ${result.sessionId} (${label})${T.reset}\n`)
    } else {
      console.log(`\n  ${T.dim}Fork unavailable (server offline?).${T.reset}\n`)
    }
  }})

  commandCatalog.register('/checkpoint', { ...COMMAND_DETAIL['/checkpoint'], origin: 'core', handler: async (_args) => {
    const result = await apiFetch<any>('/api/session/checkpoint', {})
    if (result?.ok) {
      console.log(`\n  ${T.dim}Checkpoint saved.${T.reset}\n`)
    } else {
      console.log(`\n  ${T.dim}Checkpoint unavailable (server offline?).${T.reset}\n`)
    }
  }})

  commandCatalog.register('/status', { ...COMMAND_DETAIL['/status'], origin: 'core', handler: async (_args) => {
    const h     = await apiFetch<any>('/api/debug/health', {})
    const ok    = h.status === 'ok'
    const upMin = Math.floor((h.uptime || 0) / 60)
    const ramMB = Math.round((h.memory?.heapUsed || 0) / 1024 / 1024)
    const ctxC  = ctxColor(state.ctxPercent)
    console.log()
    console.log(`  ${ok ? T.success + '✓' : T.error + '✗'}${T.reset} Aiden ${ok ? 'Online' : 'Offline'}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Uptime'.padEnd(14)}${upMin}m`)
    console.log(`  ${'RAM'.padEnd(14)}${ramMB} MB`)
    console.log(`  ${'Ollama'.padEnd(14)}${h.ollama || 'unknown'}`)
    console.log(`  ${'Sessions'.padEnd(14)}${h.workspace?.sessions || 0}`)
    console.log(`  ${'Memories'.padEnd(14)}${h.workspace?.memories || 0}`)
    console.log(`  ${'Context'.padEnd(14)}${ctxC}${ctxBar(state.ctxPercent)}${T.reset}`)
    console.log(`  ${'Turns'.padEnd(14)}${state.turnCount}/${MAX_TURNS}`)
    console.log()
  }})

  commandCatalog.register('/tools', { ...COMMAND_DETAIL['/tools'], origin: 'core', handler: async (_args) => {
    const tools = await apiFetch<any[]>('/api/tools', [])

    // Group by category (falling back to source, then 'other')
    const groups = new Map<string, any[]>()
    for (const t of tools) {
      const cat = (t.category || t.source || 'other').toLowerCase()
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(t)
    }

    // Print directly — bypasses panel() box-drawing so all tools are always visible
    console.log()
    console.log(`  ${fg(COLORS.orange)}${MARKS.TRI} Tools${RST}  ${T.dim}${tools.length} total${T.reset}`)
    console.log()
    for (const [cat, catTools] of groups) {
      // Category header
      console.log(
        `  ${fg(COLORS.orange)}${T.bold}${cat.toUpperCase()}${T.reset}` +
        `  ${T.dim}${catTools.length} tool${catTools.length !== 1 ? 's' : ''}${T.reset}`
      )
      // Each tool on its own line — name left-padded, description dimmed
      for (const t of catTools) {
        const name = (t.name || '').padEnd(24)
        const desc = (t.description || '').substring(0, 55)
        console.log(`    ${T.dim}${name}${T.reset}${T.dim}${desc}${T.reset}`)
      }
      console.log()
    }
    console.log(`  ${T.dim}/tools enable <cat>  |  /tools disable <cat>${T.reset}`)
    console.log()
  }})

  commandCatalog.register('/kit', { ...COMMAND_DETAIL['/kit'], origin: 'core', handler: async (_args) => {
    // Fetch tools and toolsets; fall back gracefully if toolsets endpoint absent
    const [tools, kitData] = await Promise.all([
      apiFetch<any[]>('/api/tools',    []),
      apiFetch<any>  ('/api/toolsets', null),
    ])

    // Build category summary from live tool list
    const catMap = new Map<string, { count: number; active: boolean }>()
    for (const t of tools) {
      const cat = (t.category || t.source || 'other').toLowerCase()
      const cur = catMap.get(cat)
      if (cur) { cur.count++ } else { catMap.set(cat, { count: 1, active: true }) }
    }

    // Merge with declared toolsets if available
    const declared: any[] = Array.isArray(kitData)
      ? kitData
      : Array.isArray(kitData?.toolsets)
        ? kitData.toolsets
        : []

    const CAT_ICONS: Record<string, string> = {
      browser: '◈', file: '▤', terminal: '▣', web: '◉',
      memory: '⬢', delegation: '◆', code: '⬡', windows: '▲',
      mcp: '◎', voice: '◐', schedule: '⬟', vision: '◪',
      'slash-mirror': '△', core: '▸',
    }

    const colDefs: ColDef[] = [
      { header: 'Kit',    width: 18, align: 'left' },
      { header: 'Tools',  width: 6,  align: 'right', color: COLORS.dim },
      { header: 'Status', width: 8,  align: 'left' },
      { header: 'Description' }, // flex
    ]

    // Merge declared + inferred
    const allCats = new Set<string>([
      ...catMap.keys(),
      ...declared.map((d: any) => (d.id || d.name || '').toLowerCase()),
    ])

    const rows: string[][] = []
    for (const cat of allCats) {
      const dec     = declared.find((d: any) => (d.id || d.name || '').toLowerCase() === cat)
      const inferred = catMap.get(cat)
      const count   = dec?.toolCount ?? inferred?.count ?? 0
      const active  = dec?.enabled   ?? inferred?.active ?? true
      const icon    = CAT_ICONS[cat] || MARKS.DOT
      const status  = active
        ? `${fg(COLORS.success)}[active]${RST}`
        : `${T.dim}[off]${T.reset}`
      const desc    = (dec?.description || '').substring(0, 40)
      const label   = `${fg(COLORS.orange)}${icon}${RST} ${cat}`
      rows.push([label, String(count), status, desc])
    }

    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Kit`,
      lines: ['', ...['Kit categories — toggle with /kit enable <name>'].map(l => `  ${T.dim}${l}${T.reset}`), ''],
    }))
    console.log(table(colDefs, rows))
    console.log(`\n  ${T.dim}${tools.length} tools · ${allCats.size} categories${T.reset}\n`)
  }})

  commandCatalog.register('/providers', { ...COMMAND_DETAIL['/providers'], origin: 'core', handler: async (_args) => {
    const [data, customData] = await Promise.all([
      apiFetch<any>('/api/providers', { apis: [], routing: {} }),
      apiFetch<any>('/api/providers/custom', { customProviders: [] }),
    ])
    const apis    = Array.isArray(data.apis) ? data.apis : []
    const customs = Array.isArray(customData.customProviders) ? customData.customProviders : []
    console.log(`\n  ${T.bold}Providers${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    for (const a of apis) {
      const rawKey  = a.key || ''
      const hasKey  = rawKey.startsWith('env:') ? !!(process.env[rawKey.replace('env:', '')]) : rawKey.length > 0
      const dot     = a.enabled && hasKey ? `${T.success}●` : `${T.dim}○`
      const rl      = a.rateLimited ? ` ${T.warning}[rate-limited]${T.reset}` : ''
      console.log(`  ${dot}${T.reset} ${(a.name || '').padEnd(18)}${T.dim}${a.model || ''}${T.reset}${rl}`)
    }
    if (customs.length > 0) {
      console.log(`\n  ${T.dim}Custom (OpenAI-compat)${T.reset}`)
      for (const cp of customs) {
        const dot = cp.enabled ? `${T.success}●` : `${T.dim}○`
        console.log(`  ${dot}${T.reset} ${(cp.id || '').padEnd(18)}${T.dim}${cp.displayName} · ${cp.model || ''}${T.reset}`)
      }
    }
    if (data.routing?.mode) console.log(`\n  ${T.dim}Routing: ${data.routing.mode}${T.reset}`)
    console.log()
  }})

  commandCatalog.register('/models', { ...COMMAND_DETAIL['/models'], origin: 'core', handler: async (_args) => {
    const m   = await apiFetch<any>('/api/debug/models', {})
    const cfg = loadCfg()
    const { MODEL_REGISTRY } = await import('../core/modelRegistry')

    const activeProvider = cfg?.model?.active || m.activeProvider || 'unknown'
    const activeModel    = cfg?.model?.activeModel || m.activeModel || 'unknown'

    console.log()
    console.log(`  ${T.bold}Models${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Active'.padEnd(16)}${T.accent}${activeModel}${T.reset}  ${T.dim}← ${activeProvider}${T.reset}`)
    console.log()

    // Per-provider table
    const apiEntries: any[] = cfg?.providers?.apis ?? []
    const cloudEntries = apiEntries.filter((a: any) => a.enabled && a.provider !== 'ollama')

    if (cloudEntries.length > 0) {
      console.log(`  ${T.bold}Cloud providers${T.reset}`)
      console.log(`  ${T.dim}${'NAME'.padEnd(16)}${'MODEL'.padEnd(46)}${'TIER'.padEnd(8)}STATUS${T.reset}`)
      for (const entry of cloudEntries) {
        const regModels = MODEL_REGISTRY[entry.provider] ?? []
        const regEntry  = regModels.find((rm: any) => rm.id === entry.model)
        const badge     = regEntry?.pricing === 'free' ? `${T.success}FREE${T.reset}` : `${T.dim}PAID${T.reset}`
        const status    = entry.rateLimited
          ? `${T.warning}rate-limited${T.reset}`
          : `${T.success}ready${T.reset}`
        const modelStr  = (entry.model || '—').padEnd(44)
        console.log(`  ${entry.name.padEnd(16)}${T.dim}${modelStr}${T.reset}  ${badge.padEnd(8)}  ${status}`)
      }
      console.log()
    }

    // Ollama section
    const ollamaModels: string[] = m.ollamaModels ?? []
    if (ollamaModels.length > 0) {
      console.log(`  ${T.bold}Local (Ollama)${T.reset}`)
      for (const om of ollamaModels) {
        const isActive = om === (cfg?.ollama?.model ?? '')
        console.log(`  ${isActive ? T.accent : T.dim}${om}${T.reset}${isActive ? '  ← active' : ''}`)
      }
      console.log()
    }
  }})

  commandCatalog.register('/model', { ...COMMAND_DETAIL['/model'], origin: 'core', handler: async (args) => {
    if (args.length > 0) {
      const modelName = args.join(' ')
      const res = await apiPost('/api/models/active', { model: modelName })
      if (res && !res.error) {
        state.lastModel = modelName
        console.log(`  ${T.success}✓ Model: ${modelName}${T.reset}\n`)
      } else {
        const cfg = loadCfg()
        if (!cfg.model) cfg.model = {}
        cfg.model.activeModel = modelName
        saveCfg(cfg)
        state.lastModel = modelName
        console.log(`  ${T.success}✓ Model: ${modelName} ${T.dim}(saved to config)${T.reset}\n`)
      }
    } else {
      const m   = await apiFetch<any>('/api/debug/models', {})
      const cfg = loadCfg()
      const { MODEL_REGISTRY } = await import('../core/modelRegistry')

      const activeProvider = cfg?.model?.active || m.activeProvider || 'unknown'
      const activeModel    = cfg?.model?.activeModel || m.activeModel || 'unknown'

      console.log()
      console.log(`  ${T.bold}Models${T.reset}`)
      console.log(`  ${T.dim}${hr()}${T.reset}`)
      console.log(`  ${'Active'.padEnd(16)}${T.accent}${activeModel}${T.reset}  ${T.dim}← ${activeProvider}${T.reset}`)
      console.log()

      const apiEntries: any[] = cfg?.providers?.apis ?? []
      const cloudEntries = apiEntries.filter((a: any) => a.enabled && a.provider !== 'ollama')

      if (cloudEntries.length > 0) {
        console.log(`  ${T.bold}Cloud providers${T.reset}`)
        console.log(`  ${T.dim}${'NAME'.padEnd(16)}${'MODEL'.padEnd(46)}${'TIER'.padEnd(8)}STATUS${T.reset}`)
        for (const entry of cloudEntries) {
          const regModels = MODEL_REGISTRY[entry.provider] ?? []
          const regEntry  = regModels.find((rm: any) => rm.id === entry.model)
          const badge     = regEntry?.pricing === 'free' ? `${T.success}FREE${T.reset}` : `${T.dim}PAID${T.reset}`
          const status    = entry.rateLimited
            ? `${T.warning}rate-limited${T.reset}`
            : `${T.success}ready${T.reset}`
          const modelStr  = (entry.model || '—').padEnd(44)
          console.log(`  ${entry.name.padEnd(16)}${T.dim}${modelStr}${T.reset}  ${badge.padEnd(8)}  ${status}`)
        }
        console.log()
      }

      const ollamaModels: string[] = m.ollamaModels ?? []
      if (ollamaModels.length > 0) {
        console.log(`  ${T.bold}Local (Ollama)${T.reset}`)
        for (const om of ollamaModels) {
          const isActive = om === (cfg?.ollama?.model ?? '')
          console.log(`  ${isActive ? T.accent : T.dim}${om}${T.reset}${isActive ? '  ← active' : ''}`)
        }
        console.log()
      }
    }
  }})

  commandCatalog.register('/memory', { ...COMMAND_DETAIL['/memory'], origin: 'core', handler: async (_args) => {
    const m     = await apiFetch<any>('/api/memories', {})
    const total = Array.isArray(m) ? m.length : (m.total || m.count || 0)
    const sem   = m.semantic ?? 0
    const ent   = m.entities ?? 0
    console.log()
    console.log(`  ${T.bold}Memory${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Total'.padEnd(16)}${num(total)}`)
    if (sem || ent) {
      console.log(`  ${'Semantic'.padEnd(16)}${num(sem)}`)
      console.log(`  ${'Entities'.padEnd(16)}${num(ent)}`)
    }
    console.log()
  }})

  commandCatalog.register('/memsearch', { ...COMMAND_DETAIL['/memsearch'], origin: 'core', handler: async (args) => {
    const query = args.join(' ').trim()
    if (!query) {
      console.log(`  ${T.dim}Usage: /memsearch <query>   e.g. /memsearch archon provider${T.reset}\n`)
      return
    }
    const data = await apiFetch<any>(`/api/memory/search?q=${encodeURIComponent(query)}&limit=10`, null)
    const hits: Array<{ id: string; summary: string; type: string; date: string; score: number }> =
      data?.hits ?? []
    console.log()
    if (hits.length === 0) {
      console.log(`  ${T.dim}No memories matching "${query}"${T.reset}\n`)
      return
    }
    const colDefs: ColDef[] = [
      { header: 'ID',       width: 12, align: 'left',  color: COLORS.cyan  },
      { header: 'Summary',  width: 52, align: 'left'                        },
      { header: 'Type',     width: 12, align: 'left',  color: COLORS.dim   },
      { header: 'Date',     width: 12, align: 'left',  color: COLORS.dim   },
      { header: 'Score',    width: 6,  align: 'right', color: COLORS.dim   },
    ]
    const rows = hits.map(h => [
      h.id,
      h.summary.slice(0, 52),
      h.type,
      h.date,
      String(Math.round(h.score * 100)) + '%',
    ])
    console.log(panel({ title: `${MARKS.TRI} Memory Search — "${query}"  (${hits.length} hit${hits.length !== 1 ? 's' : ''})`, lines: [''] }))
    console.log(table(colDefs, rows))
    if (data?.approxTokens != null) {
      console.log(`  ${T.dim}~${data.approxTokens} tokens  ·  /memtimeline <id>  /memget <id1,id2>${T.reset}\n`)
    } else {
      console.log(`  ${T.dim}/memtimeline <id>  /memget <id1,id2>${T.reset}\n`)
    }
  }})

  commandCatalog.register('/memtimeline', { ...COMMAND_DETAIL['/memtimeline'], origin: 'core', handler: async (args) => {
    const id = args[0]?.trim()
    if (!id) {
      console.log(`  ${T.dim}Usage: /memtimeline <mem_id>   e.g. /memtimeline mem_000001${T.reset}\n`)
      return
    }
    const data = await apiFetch<any>(`/api/memory/timeline/${encodeURIComponent(id)}`, null)
    if (!data || data.error) {
      console.log(`  ${T.error}Memory "${id}" not found.${T.reset}\n`)
      return
    }
    const { center, before, after } = data
    const relDate = (ts: string) => {
      const diffMs = Date.now() - new Date(ts).getTime()
      const days = Math.floor(diffMs / 86400000)
      if (days === 0) return 'today'
      if (days === 1) return 'yesterday'
      if (days < 7)  return `${days}d ago`
      return ts.slice(0, 10)
    }
    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Timeline — ${id}  [${center.type}]`,
      lines: [
        '',
        `  ${T.dim}${relDate(center.timestamp)}  ·  ${center.type}${T.reset}`,
        `  ${T.bold}${center.summary.slice(0, 90)}${T.reset}`,
        '',
        ...before.length === 0 ? [] : [`  ${T.dim}── Before ─────────────────────────────${T.reset}`],
        ...before.map((b: any) => `  ${fg(COLORS.dim)}${b.id}${RST}  ${T.dim}${relDate(b.timestamp)}${T.reset}  ${b.summary.slice(0, 60)}`),
        ...after.length === 0 ? [] : [`  ${T.dim}── After ──────────────────────────────${T.reset}`],
        ...after.map((a: any) => `  ${fg(COLORS.dim)}${a.id}${RST}  ${T.dim}${relDate(a.timestamp)}${T.reset}  ${a.summary.slice(0, 60)}`),
        '',
        `  ${T.dim}/memget ${id}  to see full content${T.reset}`,
        '',
      ],
    }))
    console.log()
  }})

  commandCatalog.register('/memget', { ...COMMAND_DETAIL['/memget'], origin: 'core', handler: async (args) => {
    const ids = args.join(' ').replace(/\s+/g, ',').replace(/,+/g, ',').trim()
    if (!ids) {
      console.log(`  ${T.dim}Usage: /memget <id1,id2,...>   e.g. /memget mem_000001,mem_000002${T.reset}\n`)
      return
    }
    const data = await apiFetch<any>(`/api/memory/get?ids=${encodeURIComponent(ids)}`, null)
    const results: Array<{ id: string; record: any; found: boolean }> = data?.results ?? []
    console.log()
    for (const r of results) {
      if (!r.found || !r.record) {
        console.log(`  ${T.error}${r.id} — not found${T.reset}\n`)
        continue
      }
      const rec = r.record
      const relDate = (ts: string) => {
        const diffMs = Date.now() - new Date(ts).getTime()
        const days = Math.floor(diffMs / 86400000)
        if (days < 7) return days === 0 ? 'today' : `${days}d ago`
        return ts.slice(0, 10)
      }
      const bodyLines = (rec.content ?? '').split('\n').slice(0, 40)
        .map((l: string) => `  ${T.dim}${l}${T.reset}`)
      console.log(panel({
        title: `${MARKS.TRI} ${rec.id}  [${rec.type}]`,
        lines: [
          '',
          `  ${T.dim}${relDate(rec.timestamp)}  ·  ${rec.type}${rec.sessionId ? `  ·  session ${rec.sessionId.slice(0, 16)}` : ''}${T.reset}`,
          `  ${T.bold}${rec.summary.slice(0, 90)}${T.reset}`,
          '',
          ...bodyLines,
          '',
          ...(rec.tags?.length ? [`  ${T.dim}tags: ${rec.tags.join(', ')}${T.reset}`] : []),
          '',
        ],
      }))
    }
    console.log()
  }})

  commandCatalog.register('/goals', { ...COMMAND_DETAIL['/goals'], origin: 'core', handler: async (_args) => {
    const g     = await apiFetch<any>('/api/goals', { goals: [] })
    const goals = Array.isArray(g) ? g : (g.goals || [])
    if (goals.length === 0) {
      console.log(`  ${T.dim}No active goals.${T.reset}\n`)
    } else {
      console.log(`\n  ${T.bold}Goals${T.reset}`)
      console.log(`  ${T.dim}${hr()}${T.reset}`)
      for (const goal of goals) {
        const dot = goal.status === 'active' ? `${T.success}●` : `${T.dim}○`
        console.log(`  ${dot}${T.reset} ${goal.title || goal.id}`)
      }
      console.log()
    }
  }})

}

async function handleCommand(cmd: string, rl: readline.Interface): Promise<boolean> {
  const parts   = cmd.trim().split(/\s+/)
  const command = parts[0].toLowerCase()
  const args    = parts.slice(1)

  // ── /help ─────────────────────────────────────────────────────────────────────
  if (command === '/help') {
    const O  = fg(COLORS.orange)
    const D  = T.dim
    const R  = T.reset
    const B  = T.bold

    function helpRow(cmd: string, desc: string): string {
      return `  ${O}${cmd.padEnd(26)}${RST}${D}${desc}${R}`
    }
    function helpSection(title: string): string {
      return `\n  ${B}${MARKS.TRI} ${title}${R}\n  ${D}${hr()}${R}`
    }

    // ── /help search <q> ───────────────────────────────────────────────────────
    const sub = parts[1]?.toLowerCase()
    if (sub === 'search' || (sub && !sub.startsWith('/'))) {
      const q = (sub === 'search' ? parts.slice(2) : parts.slice(1)).join(' ').toLowerCase()
      if (!q) {
        console.log(`  ${D}Usage: /help search <query>${R}\n`); return true
      }
      const matches = Object.entries(COMMAND_DETAIL).filter(([cmd, d]) => {
        return cmd.includes(q) ||
          d.desc.toLowerCase().includes(q) ||
          (d.subs ?? []).some(s => s.toLowerCase().includes(q)) ||
          (d.section ?? '').toLowerCase().includes(q)
      })
      console.log()
      if (matches.length === 0) {
        console.log(`  ${D}No commands matching "${q}".${R}\n`); return true
      }
      const rows = matches.map(([cmd, d]) => helpRow(cmd, d.desc))
      console.log(panel({
        title: `${MARKS.TRI} /help search "${q}"  (${matches.length} result${matches.length !== 1 ? 's' : ''})`,
        lines: ['', ...rows, ''],
        accent: COLORS.orange,
      }))
      console.log()
      return true
    }

    // ── /help <command> ────────────────────────────────────────────────────────
    if (sub?.startsWith('/')) {
      const d = COMMAND_DETAIL[sub]
      if (!d) {
        console.log(`  ${D}Unknown command: ${sub}  (try /help search <keyword>)${R}\n`); return true
      }
      const lines: string[] = [
        '',
        `  ${B}${sub}${R}  ${D}(${d.section ?? ''})${R}`,
        `  ${d.desc}`,
        '',
      ]
      if (d.usage) {
        lines.push(`  ${D}Usage:${R}`)
        lines.push(`    ${O}${d.usage}${RST}`)
        lines.push('')
      }
      if (d.subs && d.subs.length > 0) {
        lines.push(`  ${D}Subcommands:${R}`)
        for (const s of d.subs) lines.push(`    ${O}${sub} ${s}${RST}`)
        lines.push('')
      }
      if (d.examples && d.examples.length > 0) {
        lines.push(`  ${D}Examples:${R}`)
        for (const ex of d.examples) lines.push(`    ${D}${ex}${R}`)
        lines.push('')
      }
      console.log()
      console.log(panel({ title: `${MARKS.TRI} /help ${sub}`, lines, accent: COLORS.orange }))
      console.log()
      return true
    }

    const lines: string[] = [
      helpSection('Session'),
      helpRow('/new  /reset',       'Start fresh session'),
      helpRow('/clear',             'Clear screen'),
      helpRow('/history',           'Conversation history'),
      helpRow('/stop',              'Interrupt execution'),
      helpRow('/export md|json',    'Export conversation'),
      helpRow('/fork <name>',       'Fork current session'),
      helpRow('/checkpoint',        'Save state snapshot'),
      helpSection('Info'),
      helpRow('/timing',             'Last response timing breakdown'),
      helpRow('/version',            'Current version + update check'),
      helpRow('/status',            'Health + uptime'),
      helpRow('/tools',             'All registered tools  (grouped by category)'),
      helpRow('/kit',               'Toolkit categories — enable / disable'),
      helpRow('/providers',         'Provider chain + rate limits'),
      helpRow('/models',            'Model assignments'),
      helpRow('/memory',            'Memory stats'),
      helpRow('/memsearch',         'Search memories by keyword  — Layer 1 progressive disclosure'),
      helpRow('/memtimeline',       'Chronological context around a memory ID  — Layer 2'),
      helpRow('/memget',            'Full detail for specific memory IDs  — Layer 3'),
      helpRow('/goals',             'Active goals'),
      helpRow('/skills',            'Skill lifecycle  (search / registry / install / list / check / update / audit / remove / publish / export / import / stats)'),
      helpRow('/plugins',           'Plugin manager  (list / reload)'),
      helpRow('/permissions',       'Permission system  (status / reload / audit / edit)'),
      helpRow('/uninstall',         'Uninstall Aiden from this system'),
      helpRow('/install <name>',    'Install a skill from the public registry  (skills.taracod.com)'),
      helpRow('/publish <name>',    'Publish a skill to the public registry  (Pro — requires license)'),
      helpRow('/profile',             'View / edit / clear the structured user profile (Honcho model)'),
      helpRow('/failed [reason]',    'Signal last exchange failed — triggers failure trace analysis + lesson'),
      helpRow('/sandbox [sub]',      'Manage Docker sandbox mode  (status|off|auto|strict|build)'),
      helpRow('/lessons',           'Browse permanent failure rules  (search / <category>)'),
      helpRow('/teach',             'Add a manual rule to LESSONS.md'),
      helpRow('/focus',             'Toggle zen mode — suppress tool traces and status output'),
      helpRow('/explore',           'Capability browser  (tools / skills / providers)'),
      helpRow('/pulse',             'Live system dashboard — uptime, RAM, providers, async tasks'),
      helpRow('/rewind',            'Time-travel undo  (mark / undo / <n>)'),
      helpRow('/pin',               'Protect exchange from compaction  (list / unpin <idx>)'),
      helpRow('/diff',              'Filesystem changes since last commit  (git status)'),
      helpRow('/trust',             'Per-tool approval levels  (list / set <tool> <0-3> / reset <tool>)'),
      helpRow('/timeline',          'Session history tree'),
      helpRow('/garden',            'Memory layer explorer  (semantic / entities / learning / facts / hot / cold)'),
      helpRow('/decision',          'Per-turn reasoning trace  (last / clear)'),
      helpSection('Core'),
      helpRow('/log [N] [level]',   'Recent log buffer entries'),
      helpRow('/save [file]',       'Save conversation to workspace/exports/'),
      helpRow('/rerun',             'Re-send the last user message'),
      helpRow('/name <label>',      'Give the current session a name'),
      helpRow('/stack',             'Active plan steps + async tasks'),
      helpRow('/halt',              'Hard-stop all execution + LLM calls'),
      helpRow('/yolo',              'Toggle auto-approve all tool calls'),
      helpRow('/attach <path>',     'Attach file as context for next message'),
      helpRow('/changelog [N]',     'Recent git commits / workspace changes'),
      helpRow('/recipes',           `YAML recipes  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/sessions',          `Recent sessions  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/analytics',         `Usage over time  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/budget',            `Token cost estimate  ${T.dim}(v3.6)${T.reset}`),
      helpRow('/workspace',         `Current workspace  ${T.dim}(v3.6)${T.reset}`),
      helpSection('Config'),
      helpRow('/model <name>',      'Switch model'),
      helpRow('/provider',          'List / add / remove / test providers'),
      helpRow('/primary <name>',    'Pin provider to front of chain  (reset to clear)'),
      helpRow('/theme <name>',      'Change theme  (default mono slate ember)'),
      helpRow('/persona <name>',    'Change persona  (default concise technical)'),
      helpRow('/detail',            'Cycle detail level  (off → tools → verbose)'),
      helpRow('/depth',             'Cycle reasoning depth  (low → med → high)'),
      helpRow('/config',            'Show current configuration'),
      helpSection('Power'),
      helpRow('/run <code|file>',   'Execute JS in sandbox with injected aiden SDK'),
      helpRow('/spawn <task>',      'Isolated subagent with inherited provider chain'),
      helpRow('/swarm <task>',      'Parallel subagents — vote / merge / best strategy'),
      helpRow('/search <query>',    'Hybrid BM25 + semantic session + memory search'),
      helpRow('/quick <q>',         'Quick side question  (no history, no tools)'),
      helpRow('/compact',           'Manual context compression'),
      helpRow('/async <task>',      'Run task in background'),
      helpRow('/security',          'AgentShield scan'),
      helpRow('/debug',             'Recent logs'),
      helpRow('/private',           'Toggle private mode  (suppresses memory writes)'),
      helpRow('/mcp <sub>',         'MCP server management  (list / tools / connect / disconnect / call)'),
      helpRow('/cmd <command>',     'Run a Windows cmd.exe command'),
      helpRow('/ps <command>',      'Run a PowerShell command directly'),
      helpRow('/wsl <command>',     'Run a bash command inside WSL'),
      helpRow('/refresh',            'Check for updates + reload config'),
      helpRow('/channels',           'Channel adapter status (Discord, Slack, Webhook)'),
      helpRow('/voice [on|off]',     'Toggle voice mode — TTS reads AI replies aloud'),
      helpRow('/speak <text>',       'Speak text immediately via TTS'),
      helpRow('/listen [secs]',      'Record mic → STT → send as message'),
      helpRow('/todo <op>',          'Per-session task list  (add / done / remove / list / clear)'),
      helpRow('/cron <op>',          'Schedule recurring commands  (add / list / pause / resume / delete / run)'),
      helpRow('/vision <img>',       'Analyze image with AI vision (file path or URL)'),
      helpSection('Exit'),
      helpRow('/quit  /exit  /q',   ''),
      '',
      `  ${T.dim}/help search <q>  ·  /help <command> for detail${T.reset}`,
      '',
    ]

    console.log()
    console.log(panel({
      title: `${MARKS.TRI} ▲IDEN Commands`,
      lines,
      accent: COLORS.orange,
    }))
    console.log()
    return true
  }

  // ── /new / /reset ──────────────────────────────────────────────────────────────
  if (command === '/new' || command === '/reset') {
    state.history    = []
    state.turnCount  = 0
    state.ctxPercent = 0
    console.log(`  ${T.success}✓ New session started.${T.reset}\n`)
    return true
  }

  // ── /clear ─────────────────────────────────────────────────────────────────────
  if (command === '/clear') {
    console.clear()
    await printBanner()
    return true
  }

  // ── /history ───────────────────────────────────────────────────────────────────
  if (command === '/history') {
    if (state.history.length === 0) { console.log(`  ${T.dim}No history.${T.reset}\n`); return true }
    console.log()
    for (const h of state.history) {
      const label   = h.role === 'user' ? `${T.dim}you${T.reset}` : `${T.primary}Aiden${T.reset}`
      const preview = h.content.substring(0, 120).replace(/\n/g, ' ')
      console.log(`  ${label}  ${T.dim}${preview}${T.reset}`)
    }
    console.log()
    return true
  }

  // ── /stop ──────────────────────────────────────────────────────────────────────
  if (command === '/stop') {
    if (state.abortCtrl) {
      state.abortCtrl.abort()
      console.log(`  ${T.warning}Interrupted.${T.reset}\n`)
    } else {
      await apiPost('/api/stop')
      console.log(`  ${T.dim}No active generation.${T.reset}\n`)
    }
    return true
  }

  // ── /export md|json ────────────────────────────────────────────────────────────
  if (command === '/export') {
    const fmt = (parts[1] || 'json').toLowerCase()
    const ts  = Date.now()
    if (fmt === 'md' || fmt === 'markdown') {
      let md = `# Aiden Session\n\nSession: ${SESSION_ID}\nExported: ${new Date().toISOString()}\n\n---\n\n`
      for (const h of state.history) {
        md += h.role === 'user' ? `**You**\n\n${h.content}\n\n` : `**Aiden**\n\n${h.content}\n\n---\n\n`
      }
      const fname = `aiden-${ts}.md`
      fs.writeFileSync(fname, md)
      console.log(`  ${T.success}✓ Exported to ${fname}${T.reset}\n`)
    } else {
      const fname = `aiden-${ts}.json`
      fs.writeFileSync(fname, JSON.stringify({ session: SESSION_ID, exported: new Date().toISOString(), history: state.history }, null, 2))
      console.log(`  ${T.success}✓ Exported to ${fname}${T.reset}\n`)
    }
    return true
  }

  // ── /fork <name> ───────────────────────────────────────────────────────────────
  if (command === '/fork') {
    const name = parts.slice(1).join(' ') || `fork-${Date.now()}`
    const res  = await apiPost('/api/sessions/fork', { name, sessionId: SESSION_ID })
    if (res && !res.error) {
      console.log(`  ${T.success}✓ Forked as "${name}"${T.reset}\n`)
    } else {
      const fname = `aiden-fork-${name.replace(/\s+/g, '-')}-${Date.now()}.json`
      fs.writeFileSync(fname, JSON.stringify({ name, parent: SESSION_ID, history: state.history, created: new Date().toISOString() }, null, 2))
      console.log(`  ${T.success}✓ Fork saved: ${fname}${T.reset}\n`)
    }
    return true
  }

  // ── /checkpoint ────────────────────────────────────────────────────────────────
  if (command === '/checkpoint') {
    const fname = `aiden-checkpoint-${Date.now()}.json`
    fs.writeFileSync(fname, JSON.stringify({ sessionId: SESSION_ID, history: state.history, turnCount: state.turnCount, timestamp: new Date().toISOString() }, null, 2))
    console.log(`  ${T.success}✓ Checkpoint saved: ${fname}${T.reset}\n`)
    return true
  }

  // ── /status ────────────────────────────────────────────────────────────────────
  if (command === '/status') {
    const h     = await apiFetch<any>('/api/debug/health', {})
    const ok    = h.status === 'ok'
    const upMin = Math.floor((h.uptime || 0) / 60)
    const ramMB = Math.round((h.memory?.heapUsed || 0) / 1024 / 1024)
    const ctxC  = ctxColor(state.ctxPercent)
    console.log()
    console.log(`  ${ok ? T.success + '✓' : T.error + '✗'}${T.reset} Aiden ${ok ? 'Online' : 'Offline'}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Uptime'.padEnd(14)}${upMin}m`)
    console.log(`  ${'RAM'.padEnd(14)}${ramMB} MB`)
    console.log(`  ${'Ollama'.padEnd(14)}${h.ollama || 'unknown'}`)
    console.log(`  ${'Sessions'.padEnd(14)}${h.workspace?.sessions || 0}`)
    console.log(`  ${'Memories'.padEnd(14)}${h.workspace?.memories || 0}`)
    console.log(`  ${'Context'.padEnd(14)}${ctxC}${ctxBar(state.ctxPercent)}${T.reset}`)
    console.log(`  ${'Turns'.padEnd(14)}${state.turnCount}/${MAX_TURNS}`)
    console.log()
    return true
  }

  // ── /tools ─────────────────────────────────────────────────────────────────────
  if (command === '/tools') {
    const tools = await apiFetch<any[]>('/api/tools', [])

    // Group by category (falling back to source, then 'other')
    const groups = new Map<string, any[]>()
    for (const t of tools) {
      const cat = (t.category || t.source || 'other').toLowerCase()
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(t)
    }

    // Print directly — bypasses panel() box-drawing so all tools are always visible
    console.log()
    console.log(`  ${fg(COLORS.orange)}${MARKS.TRI} Tools${RST}  ${T.dim}${tools.length} total${T.reset}`)
    console.log()
    for (const [cat, catTools] of groups) {
      // Category header
      console.log(
        `  ${fg(COLORS.orange)}${T.bold}${cat.toUpperCase()}${T.reset}` +
        `  ${T.dim}${catTools.length} tool${catTools.length !== 1 ? 's' : ''}${T.reset}`
      )
      // Each tool on its own line — name left-padded, description dimmed
      for (const t of catTools) {
        const name = (t.name || '').padEnd(24)
        const desc = (t.description || '').substring(0, 55)
        console.log(`    ${T.dim}${name}${T.reset}${T.dim}${desc}${T.reset}`)
      }
      console.log()
    }
    console.log(`  ${T.dim}/tools enable <cat>  |  /tools disable <cat>${T.reset}`)
    console.log()
    return true
  }

  // ── /kit ───────────────────────────────────────────────────────────────────────
  if (command === '/kit') {
    // Fetch tools and toolsets; fall back gracefully if toolsets endpoint absent
    const [tools, kitData] = await Promise.all([
      apiFetch<any[]>('/api/tools',    []),
      apiFetch<any>  ('/api/toolsets', null),
    ])

    // Build category summary from live tool list
    const catMap = new Map<string, { count: number; active: boolean }>()
    for (const t of tools) {
      const cat = (t.category || t.source || 'other').toLowerCase()
      const cur = catMap.get(cat)
      if (cur) { cur.count++ } else { catMap.set(cat, { count: 1, active: true }) }
    }

    // Merge with declared toolsets if available
    const declared: any[] = Array.isArray(kitData)
      ? kitData
      : Array.isArray(kitData?.toolsets)
        ? kitData.toolsets
        : []

    const CAT_ICONS: Record<string, string> = {
      browser: '◈', file: '▤', terminal: '▣', web: '◉',
      memory: '⬢', delegation: '◆', code: '⬡', windows: '▲',
      mcp: '◎', voice: '◐', schedule: '⬟', vision: '◪',
      'slash-mirror': '△', core: '▸',
    }

    const colDefs: ColDef[] = [
      { header: 'Kit',    width: 18, align: 'left' },
      { header: 'Tools',  width: 6,  align: 'right', color: COLORS.dim },
      { header: 'Status', width: 8,  align: 'left' },
      { header: 'Description' }, // flex
    ]

    // Merge declared + inferred
    const allCats = new Set<string>([
      ...catMap.keys(),
      ...declared.map((d: any) => (d.id || d.name || '').toLowerCase()),
    ])

    const rows: string[][] = []
    for (const cat of allCats) {
      const dec     = declared.find((d: any) => (d.id || d.name || '').toLowerCase() === cat)
      const inferred = catMap.get(cat)
      const count   = dec?.toolCount ?? inferred?.count ?? 0
      const active  = dec?.enabled   ?? inferred?.active ?? true
      const icon    = CAT_ICONS[cat] || MARKS.DOT
      const status  = active
        ? `${fg(COLORS.success)}[active]${RST}`
        : `${T.dim}[off]${T.reset}`
      const desc    = (dec?.description || '').substring(0, 40)
      const label   = `${fg(COLORS.orange)}${icon}${RST} ${cat}`
      rows.push([label, String(count), status, desc])
    }

    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Kit`,
      lines: ['', ...['Kit categories — toggle with /kit enable <name>'].map(l => `  ${T.dim}${l}${T.reset}`), ''],
    }))
    console.log(table(colDefs, rows))
    console.log(`\n  ${T.dim}${tools.length} tools · ${allCats.size} categories${T.reset}\n`)
    return true
  }

  // ── /providers ─────────────────────────────────────────────────────────────────
  if (command === '/providers') {
    const [data, customData] = await Promise.all([
      apiFetch<any>('/api/providers', { apis: [], routing: {} }),
      apiFetch<any>('/api/providers/custom', { customProviders: [] }),
    ])
    const apis    = Array.isArray(data.apis) ? data.apis : []
    const customs = Array.isArray(customData.customProviders) ? customData.customProviders : []
    console.log(`\n  ${T.bold}Providers${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    for (const a of apis) {
      const rawKey  = a.key || ''
      const hasKey  = rawKey.startsWith('env:') ? !!(process.env[rawKey.replace('env:', '')]) : rawKey.length > 0
      const dot     = a.enabled && hasKey ? `${T.success}●` : `${T.dim}○`
      const rl      = a.rateLimited ? ` ${T.warning}[rate-limited]${T.reset}` : ''
      console.log(`  ${dot}${T.reset} ${(a.name || '').padEnd(18)}${T.dim}${a.model || ''}${T.reset}${rl}`)
    }
    if (customs.length > 0) {
      console.log(`\n  ${T.dim}Custom (OpenAI-compat)${T.reset}`)
      for (const cp of customs) {
        const dot = cp.enabled ? `${T.success}●` : `${T.dim}○`
        console.log(`  ${dot}${T.reset} ${(cp.id || '').padEnd(18)}${T.dim}${cp.displayName} · ${cp.model || ''}${T.reset}`)
      }
    }
    if (data.routing?.mode) console.log(`\n  ${T.dim}Routing: ${data.routing.mode}${T.reset}`)
    console.log()
    return true
  }

  // ── /models  (or /model with no args) ─────────────────────────────────────────
  if (command === '/models' || (command === '/model' && parts.length === 1)) {
    const m   = await apiFetch<any>('/api/debug/models', {})
    const cfg = loadCfg()
    const { MODEL_REGISTRY } = await import('../core/modelRegistry')

    const activeProvider = cfg?.model?.active || m.activeProvider || 'unknown'
    const activeModel    = cfg?.model?.activeModel || m.activeModel || 'unknown'

    console.log()
    console.log(`  ${T.bold}Models${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Active'.padEnd(16)}${T.accent}${activeModel}${T.reset}  ${T.dim}← ${activeProvider}${T.reset}`)
    console.log()

    // Per-provider table
    const apiEntries: any[] = cfg?.providers?.apis ?? []
    const cloudEntries = apiEntries.filter((a: any) => a.enabled && a.provider !== 'ollama')

    if (cloudEntries.length > 0) {
      console.log(`  ${T.bold}Cloud providers${T.reset}`)
      console.log(`  ${T.dim}${'NAME'.padEnd(16)}${'MODEL'.padEnd(46)}${'TIER'.padEnd(8)}STATUS${T.reset}`)
      for (const entry of cloudEntries) {
        const regModels = MODEL_REGISTRY[entry.provider] ?? []
        const regEntry  = regModels.find((rm: any) => rm.id === entry.model)
        const badge     = regEntry?.pricing === 'free' ? `${T.success}FREE${T.reset}` : `${T.dim}PAID${T.reset}`
        const status    = entry.rateLimited
          ? `${T.warning}rate-limited${T.reset}`
          : `${T.success}ready${T.reset}`
        const modelStr  = (entry.model || '—').padEnd(44)
        console.log(`  ${entry.name.padEnd(16)}${T.dim}${modelStr}${T.reset}  ${badge.padEnd(8)}  ${status}`)
      }
      console.log()
    }

    // Ollama section
    const ollamaModels: string[] = m.ollamaModels ?? []
    if (ollamaModels.length > 0) {
      console.log(`  ${T.bold}Local (Ollama)${T.reset}`)
      for (const om of ollamaModels) {
        const isActive = om === (cfg?.ollama?.model ?? '')
        console.log(`  ${isActive ? T.accent : T.dim}${om}${T.reset}${isActive ? '  ← active' : ''}`)
      }
      console.log()
    }

    return true
  }

  // ── /model <name> — switch ─────────────────────────────────────────────────────
  if (command === '/model' && parts.length > 1) {
    const modelName = parts.slice(1).join(' ')
    const res = await apiPost('/api/models/active', { model: modelName })
    if (res && !res.error) {
      state.lastModel = modelName
      console.log(`  ${T.success}✓ Model: ${modelName}${T.reset}\n`)
    } else {
      const cfg = loadCfg()
      if (!cfg.model) cfg.model = {}
      cfg.model.activeModel = modelName
      saveCfg(cfg)
      state.lastModel = modelName
      console.log(`  ${T.success}✓ Model: ${modelName} ${T.dim}(saved to config)${T.reset}\n`)
    }
    return true
  }

  // ── /memory ────────────────────────────────────────────────────────────────────
  if (command === '/memory') {
    const m     = await apiFetch<any>('/api/memories', {})
    const total = Array.isArray(m) ? m.length : (m.total || m.count || 0)
    const sem   = m.semantic ?? 0
    const ent   = m.entities ?? 0
    console.log()
    console.log(`  ${T.bold}Memory${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Total'.padEnd(16)}${num(total)}`)
    if (sem || ent) {
      console.log(`  ${'Semantic'.padEnd(16)}${num(sem)}`)
      console.log(`  ${'Entities'.padEnd(16)}${num(ent)}`)
    }
    console.log()
    return true
  }

  // ── /memsearch ─────────────────────────────────────────────────────────────────
  if (command === '/memsearch') {
    const query = args.join(' ').trim()
    if (!query) {
      console.log(`  ${T.dim}Usage: /memsearch <query>   e.g. /memsearch archon provider${T.reset}\n`)
      return true
    }
    const data = await apiFetch<any>(`/api/memory/search?q=${encodeURIComponent(query)}&limit=10`, null)
    const hits: Array<{ id: string; summary: string; type: string; date: string; score: number }> =
      data?.hits ?? []
    console.log()
    if (hits.length === 0) {
      console.log(`  ${T.dim}No memories matching "${query}"${T.reset}\n`)
      return true
    }
    const colDefs: ColDef[] = [
      { header: 'ID',       width: 12, align: 'left',  color: COLORS.cyan  },
      { header: 'Summary',  width: 52, align: 'left'                        },
      { header: 'Type',     width: 12, align: 'left',  color: COLORS.dim   },
      { header: 'Date',     width: 12, align: 'left',  color: COLORS.dim   },
      { header: 'Score',    width: 6,  align: 'right', color: COLORS.dim   },
    ]
    const rows = hits.map(h => [
      h.id,
      h.summary.slice(0, 52),
      h.type,
      h.date,
      String(Math.round(h.score * 100)) + '%',
    ])
    console.log(panel({ title: `${MARKS.TRI} Memory Search — "${query}"  (${hits.length} hit${hits.length !== 1 ? 's' : ''})`, lines: [''] }))
    console.log(table(colDefs, rows))
    if (data?.approxTokens != null) {
      console.log(`  ${T.dim}~${data.approxTokens} tokens  ·  /memtimeline <id>  /memget <id1,id2>${T.reset}\n`)
    } else {
      console.log(`  ${T.dim}/memtimeline <id>  /memget <id1,id2>${T.reset}\n`)
    }
    return true
  }

  // ── /memtimeline ───────────────────────────────────────────────────────────────
  if (command === '/memtimeline') {
    const id = args[0]?.trim()
    if (!id) {
      console.log(`  ${T.dim}Usage: /memtimeline <mem_id>   e.g. /memtimeline mem_000001${T.reset}\n`)
      return true
    }
    const data = await apiFetch<any>(`/api/memory/timeline/${encodeURIComponent(id)}`, null)
    if (!data || data.error) {
      console.log(`  ${T.error}Memory "${id}" not found.${T.reset}\n`)
      return true
    }
    const { center, before, after } = data
    const relDate = (ts: string) => {
      const diffMs = Date.now() - new Date(ts).getTime()
      const days = Math.floor(diffMs / 86400000)
      if (days === 0) return 'today'
      if (days === 1) return 'yesterday'
      if (days < 7)  return `${days}d ago`
      return ts.slice(0, 10)
    }
    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Timeline — ${id}  [${center.type}]`,
      lines: [
        '',
        `  ${T.dim}${relDate(center.timestamp)}  ·  ${center.type}${T.reset}`,
        `  ${T.bold}${center.summary.slice(0, 90)}${T.reset}`,
        '',
        ...before.length === 0 ? [] : [`  ${T.dim}── Before ─────────────────────────────${T.reset}`],
        ...before.map((b: any) => `  ${fg(COLORS.dim)}${b.id}${RST}  ${T.dim}${relDate(b.timestamp)}${T.reset}  ${b.summary.slice(0, 60)}`),
        ...after.length === 0 ? [] : [`  ${T.dim}── After ──────────────────────────────${T.reset}`],
        ...after.map((a: any) => `  ${fg(COLORS.dim)}${a.id}${RST}  ${T.dim}${relDate(a.timestamp)}${T.reset}  ${a.summary.slice(0, 60)}`),
        '',
        `  ${T.dim}/memget ${id}  to see full content${T.reset}`,
        '',
      ],
    }))
    console.log()
    return true
  }

  // ── /memget ────────────────────────────────────────────────────────────────────
  if (command === '/memget') {
    const ids = args.join(' ').replace(/\s+/g, ',').replace(/,+/g, ',').trim()
    if (!ids) {
      console.log(`  ${T.dim}Usage: /memget <id1,id2,...>   e.g. /memget mem_000001,mem_000002${T.reset}\n`)
      return true
    }
    const data = await apiFetch<any>(`/api/memory/get?ids=${encodeURIComponent(ids)}`, null)
    const results: Array<{ id: string; record: any; found: boolean }> = data?.results ?? []
    console.log()
    for (const r of results) {
      if (!r.found || !r.record) {
        console.log(`  ${T.error}${r.id} — not found${T.reset}\n`)
        continue
      }
      const rec = r.record
      const relDate = (ts: string) => {
        const diffMs = Date.now() - new Date(ts).getTime()
        const days = Math.floor(diffMs / 86400000)
        if (days < 7) return days === 0 ? 'today' : `${days}d ago`
        return ts.slice(0, 10)
      }
      const bodyLines = (rec.content ?? '').split('\n').slice(0, 40)
        .map((l: string) => `  ${T.dim}${l}${T.reset}`)
      console.log(panel({
        title: `${MARKS.TRI} ${rec.id}  [${rec.type}]`,
        lines: [
          '',
          `  ${T.dim}${relDate(rec.timestamp)}  ·  ${rec.type}${rec.sessionId ? `  ·  session ${rec.sessionId.slice(0, 16)}` : ''}${T.reset}`,
          `  ${T.bold}${rec.summary.slice(0, 90)}${T.reset}`,
          '',
          ...bodyLines,
          '',
          ...(rec.tags?.length ? [`  ${T.dim}tags: ${rec.tags.join(', ')}${T.reset}`] : []),
          '',
        ],
      }))
    }
    console.log()
    return true
  }

  // ── /goals ─────────────────────────────────────────────────────────────────────
  if (command === '/goals') {
    const g     = await apiFetch<any>('/api/goals', { goals: [] })
    const goals = Array.isArray(g) ? g : (g.goals || [])
    if (goals.length === 0) {
      console.log(`  ${T.dim}No active goals.${T.reset}\n`)
    } else {
      console.log(`\n  ${T.bold}Goals${T.reset}`)
      console.log(`  ${T.dim}${hr()}${T.reset}`)
      for (const goal of goals) {
        const dot = goal.status === 'active' ? `${T.success}●` : `${T.dim}○`
        console.log(`  ${dot}${T.reset} ${goal.title || goal.id}`)
      }
      console.log()
    }
    return true
  }

  // ── /skills ────────────────────────────────────────────────────────────────────
  if (command === '/skills' || (command === '/skills' && parts[1])) {
    const sub = parts[1]?.toLowerCase()
    const arg = parts.slice(2).join(' ')

    // ── /skills search <query> ──────────────────────────────────────────────────
    if (sub === 'search') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills search <query>${T.reset}\n`); return true }
      const results = await apiFetch<any[]>(`/api/skills/relevant?q=${encodeURIComponent(arg)}`, [])
      const colDefs: ColDef[] = [
        { header: '#',           width: 4,  align: 'right', color: COLORS.dim },
        { header: 'Skill',       width: 24, align: 'left'  },
        { header: 'Description'                             },
        { header: 'Tags',        width: 22, align: 'left'  },
      ]
      const rows = results.map((s: any, i: number) => [
        String(i + 1),
        (s.name || '').substring(0, 22),
        (s.description || '').substring(0, 50),
        (s.tags || []).join(', ').substring(0, 20),
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Search — "${arg}"`, lines: [''] }))
      if (rows.length === 0) {
        console.log(`  ${T.dim}No skills matched.${T.reset}\n`)
      } else {
        console.log(table(colDefs, rows))
        console.log(`\n  ${T.dim}${results.length} result(s) · /skills inspect <name>${T.reset}\n`)
      }
      return true
    }

    // ── /skills registry <query> ——— public registry search ───────────────────
    if (sub === 'registry') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills registry <query>${T.reset}\n`); return true }
      console.log(`  ${T.dim}Searching skills.taracod.com for "${arg}"…${T.reset}`)
      try {
        const { searchRegistry } = await import('../core/skillRegistry')
        const results = await searchRegistry(arg)
        if (!results.length) {
          console.log(`  ${T.dim}No registry skills found for "${arg}".${T.reset}\n`); return true
        }
        const colDefs: ColDef[] = [
          { header: 'Skill',     width: 22, align: 'left' },
          { header: 'Author',    width: 14, align: 'left', color: COLORS.dim },
          { header: 'Ver',       width: 8,  align: 'left', color: COLORS.dim },
          { header: 'DLs',       width: 8,  align: 'right', color: COLORS.dim },
          { header: 'Description' },
        ]
        const rows = results.map((s: any) => [
          (s.name        || '').substring(0, 20),
          (s.author      || '').substring(0, 12),
          (s.version     || '?').substring(0, 6),
          String(s.downloads || 0),
          (s.description || '').substring(0, 48),
        ])
        console.log()
        console.log(table(colDefs, rows))
        console.log(`\n  ${T.dim}${results.length} result(s) · /install <name> to install${T.reset}\n`)
      } catch (e: any) {
        console.log(`  ${T.error}✗ Registry search failed: ${e?.message}${T.reset}\n`)
      }
      return true
    }

    // ── /skills explore <topic> ——— library search ─────────────────────────────
    if (sub === 'explore') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills explore <topic>${T.reset}\n`); return true }
      console.log(`  ${T.dim}Searching library for "${arg}"…${T.reset}`)
      const libData = await apiFetch<any>(`/api/skills/library?q=${encodeURIComponent(arg)}&limit=10`, null)
      if (!libData) { console.log(`  ${T.error}Library fetch failed.${T.reset}\n`); return true }
      const libResults = libData.results ?? []
      if (libResults.length === 0) {
        console.log(`  ${T.dim}No library skills matched "${arg}".${T.reset}\n`); return true
      }
      const libCols: ColDef[] = [
        { header: '#',        width: 4,  align: 'right', color: COLORS.dim },
        { header: 'ID',       width: 28, align: 'left'  },
        { header: 'Description'                          },
        { header: 'Platform', width: 10, align: 'left', color: COLORS.dim },
      ]
      const libRows = libResults.map((s: any, i: number) => [
        String(i + 1), (s.id || s.name || '').substring(0, 26),
        (s.description || '').substring(0, 50), (s.platform || 'any').substring(0, 8),
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Library — "${arg}"  (${libResults.length} match${libResults.length !== 1 ? 'es' : ''})`, lines: [''] }))
      console.log(table(libCols, libRows))
      console.log(`\n  ${T.dim}Install with: /skills install --library <id>${T.reset}\n`)
      return true
    }

    // ── /skills install --library <id...> ——— from taracodlabs/aiden-skills ───
    if (sub === 'install' && (parts[2] === '--library' || parts[2] === '--lib')) {
      const ids = parts.slice(3)
      if (ids.length === 0) {
        console.log(`  ${T.dim}Usage: /skills install --library <id> [id2 ...]${T.reset}\n`); return true
      }
      for (const id of ids) {
        process.stdout.write(`  ${T.dim}Installing "${id}"…${T.reset} `)
        const libInst = await apiPost('/api/skills/library/install', { id })
        if (!libInst?.success) {
          process.stdout.write(`${T.error}✗ ${libInst?.error || 'failed'}${T.reset}\n`)
        } else {
          process.stdout.write(`${fg(COLORS.success)}✓ installed  ${T.dim}(disabled — /skills enable ${libInst.id} to activate)${T.reset}\n`)
        }
      }
      console.log()
      return true
    }

    // ── /skills enable <id> ─────────────────────────────────────────────────────
    if (sub === 'enable') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills enable <id>${T.reset}\n`); return true }
      const enRes = await apiPost('/api/skills/enable', { id: arg })
      if (!enRes?.success) {
        console.log(`  ${T.error}Enable failed: ${enRes?.error || 'not found'}${T.reset}\n`); return true
      }
      console.log(`  ${fg(COLORS.success)}${MARKS.DOT}${RST} Enabled: ${fg(COLORS.orange)}${arg}${RST}\n`)
      return true
    }

    // ── /skills disable <id> ────────────────────────────────────────────────────
    if (sub === 'disable') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills disable <id>${T.reset}\n`); return true }
      const disRes = await apiPost('/api/skills/disable', { id: arg })
      if (!disRes?.success) {
        console.log(`  ${T.error}Disable failed: ${disRes?.error || 'not found'}${T.reset}\n`); return true
      }
      console.log(`  ${T.dim}${MARKS.DOT_O} Disabled: ${arg}${T.reset}\n`)
      return true
    }

    // ── /skills review [id] ─────────────────────────────────────────────────────
    if (sub === 'review') {
      if (arg) {
        const revData = await apiFetch<any>(`/api/skills/review/${encodeURIComponent(arg)}`, null)
        if (!revData?.content) {
          console.log(`  ${T.error}Skill "${arg}" not found.${T.reset}\n`); return true
        }
        console.log()
        console.log(panel({
          title: `${MARKS.TRI} Review — ${arg}  [${revData.status}]`,
          lines: [
            '',
            ...revData.content.split('\n').slice(0, 30).map((l: string) => `  ${T.dim}${l}${T.reset}`),
            '',
            `  ${T.dim}Approve: /skills approve ${arg}   Reject: /skills reject ${arg}${T.reset}`,
            '',
          ],
        }))
        console.log()
      } else {
        const pendList = await apiFetch<any[]>('/api/skills/pending', [])
        if (pendList.length === 0) {
          console.log(`  ${T.dim}No pending skill drafts.${T.reset}\n`); return true
        }
        const pendCols: ColDef[] = [
          { header: 'ID',      width: 28, align: 'left' },
          { header: 'Name',    width: 22, align: 'left' },
          { header: 'Source',  width: 16, align: 'left', color: COLORS.dim },
          { header: 'Created', width: 20, align: 'left', color: COLORS.dim },
        ]
        const pendRows = pendList.map((p: any) => [
          (p.id || '').substring(0, 26), (p.name || '').substring(0, 20),
          (p.source || '').substring(0, 14), (p.createdAt || '').substring(0, 18),
        ])
        console.log()
        console.log(panel({ title: `${MARKS.TRI} Pending Skill Drafts  (${pendList.length})`, lines: [''] }))
        console.log(table(pendCols, pendRows))
        console.log(`\n  ${T.dim}/skills review <id>  /skills approve <id>  /skills reject <id>${T.reset}\n`)
      }
      return true
    }

    // ── /skills approve <id> ────────────────────────────────────────────────────
    if (sub === 'approve') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills approve <id>${T.reset}\n`); return true }
      const appRes = await apiPost('/api/skills/approve', { id: arg })
      if (!appRes?.success) {
        console.log(`  ${T.error}Approve failed: ${appRes?.error || 'error'}${T.reset}\n`); return true
      }
      console.log(`  ${fg(COLORS.success)}${MARKS.TRI}${RST} Approved and enabled: ${fg(COLORS.orange)}${arg}${RST}\n`)
      return true
    }

    // ── /skills reject <id> ─────────────────────────────────────────────────────
    if (sub === 'reject') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills reject <id>${T.reset}\n`); return true }
      const rejRes = await apiPost('/api/skills/reject', { id: arg })
      if (!rejRes?.success) {
        console.log(`  ${T.error}Reject failed: ${rejRes?.error || 'error'}${T.reset}\n`); return true
      }
      console.log(`  ${T.dim}${MARKS.DOT_O} Rejected and removed: ${arg}${T.reset}\n`)
      return true
    }

    // ── /skills install <name> ──────────────────────────────────────────────────
    if (sub === 'install') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills install <name>${T.reset}\n`); return true }
      const result = await apiPost('/api/skills/install', { name: arg })
      if (!result || result.error) {
        const msg = result?.error || 'unknown error'
        console.log(`  ${T.error}Install failed for "${arg}": ${msg}${T.reset}\n`); return true
      }
      if (result.alreadyInstalled) {
        console.log(`  ${T.dim}${MARKS.DOT} "${arg}" is already installed.${T.reset}\n`); return true
      }
      console.log(`  ${fg(COLORS.success)}${MARKS.TRI}${RST} installed ${fg(COLORS.orange)}${arg}${RST}\n`)
      return true
    }

    // ── /skills remove <name> ───────────────────────────────────────────────────
    if (sub === 'remove') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills remove <name>${T.reset}\n`); return true }
      const result = await apiDelete(`/api/skills/${encodeURIComponent(arg)}`)
      if (!result?.success) {
        const msg = result?.error || 'unknown error'
        console.log(`  ${T.error}Remove failed: ${msg}${T.reset}\n`); return true
      }
      console.log(`  ${T.dim}${MARKS.DOT} removed "${arg}".${T.reset}\n`)
      return true
    }

    // ── /skills update ──────────────────────────────────────────────────────────
    if (sub === 'update') {
      const result = await apiPost('/api/skills/refresh')
      if (!result || result.error) {
        const msg = result?.error || 'unknown error'
        console.log(`  ${T.error}Refresh failed: ${msg}${T.reset}\n`); return true
      }
      console.log(`  ${fg(COLORS.success)}${MARKS.TRI}${RST} reloaded ${fg(COLORS.orange)}${result.count}${RST} skill(s)\n`)
      return true
    }

    // ── /skills check [name] ────────────────────────────────────────────────────
    if (sub === 'check') {
      const skills = await apiFetch<any[]>('/api/skills', [])
      const target = arg ? skills.filter((s: any) => s.name === arg) : skills
      if (arg && target.length === 0) {
        console.log(`  ${T.error}Skill "${arg}" not found.${T.reset}\n`); return true
      }
      const colDefs: ColDef[] = [
        { header: 'Skill',   width: 24, align: 'left'  },
        { header: 'Status',  width: 14, align: 'left'  },
        { header: 'Version', width: 10, align: 'left', color: COLORS.dim },
        { header: 'Tags'                                },
      ]
      const rows = target.map((s: any) => [
        (s.name || '').substring(0, 22),
        s.enabled !== false
          ? `${fg(COLORS.success)}● enabled${RST}`
          : `${T.dim}○ disabled${T.reset}`,
        (s.version || '?').substring(0, 8),
        (s.tags || []).join(', ').substring(0, 30),
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Skill Check`, lines: [''] }))
      console.log(table(colDefs, rows))
      console.log(`\n  ${T.dim}${target.length} skill(s) checked${T.reset}\n`)
      return true
    }

    // ── /skills audit ───────────────────────────────────────────────────────────
    if (sub === 'audit') {
      const data     = await apiFetch<any>('/api/skills/audit', { blocked: [], disabled: [] })
      const blocked  = (data?.blocked  || []) as Array<{ ts: string; name: string; reason: string }>
      const disabled = (data?.disabled || []) as string[]
      const lines: string[] = ['']
      if (blocked.length === 0 && disabled.length === 0) {
        lines.push(`  ${T.dim}No blocked or disabled skills.${T.reset}`)
      }
      if (blocked.length > 0) {
        lines.push(`  ${T.dim}BLOCKED (${blocked.length})${T.reset}`)
        for (const b of blocked.slice(0, 8)) {
          lines.push(`  ${fg(COLORS.error)}${MARKS.DOT}${RST} ${b.name}  ${T.dim}${b.reason}${T.reset}`)
        }
        lines.push('')
      }
      if (disabled.length > 0) {
        lines.push(`  ${T.dim}DISABLED (${disabled.length})${T.reset}`)
        for (const d of disabled) lines.push(`  ${T.dim}${MARKS.DOT_O} ${d}${T.reset}`)
      }
      lines.push('')
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Skill Audit`, lines }))
      console.log()
      return true
    }

    // ── /skills stats ───────────────────────────────────────────────────────────
    if (sub === 'stats') {
      const data = await apiFetch<any>('/api/skills/stats', null)
      if (!data) { console.log(`  ${T.error}Stats unavailable.${T.reset}\n`); return true }
      const bySource = data.bySource || {}
      const topTags  = (data.topTags  || []) as Array<{ tag: string; count: number }>
      const field    = (k: string, v: string) => `  ${T.dim}${k.padEnd(14)}${T.reset}${v}`
      const lines: string[] = [
        '',
        field('Total',    `${fg(COLORS.orange)}${data.total}${RST}`),
        field('Enabled',  `${fg(COLORS.success)}${data.enabled}${RST}`),
        field('Disabled', `${T.dim}${data.disabled}${T.reset}`),
        '',
      ]
      if (Object.keys(bySource).length > 0) {
        lines.push(`  ${T.dim}By Source${T.reset}`)
        for (const [src, cnt] of Object.entries(bySource)) {
          lines.push(`  ${T.dim}${src.padEnd(12)}${T.reset}${cnt}`)
        }
        lines.push('')
      }
      if (topTags.length > 0) {
        lines.push(`  ${T.dim}Top Tags${T.reset}`)
        lines.push('  ' + topTags.map(t => `${t.tag}(${t.count})`).join('  '))
        lines.push('')
      }
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Skill Stats`, lines }))
      console.log()
      return true
    }

    // ── /skills source <name> ───────────────────────────────────────────────────
    if (sub === 'source') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills source <name>${T.reset}\n`); return true }
      const skills = await apiFetch<any[]>('/api/skills', [])
      const s = skills.find((x: any) => x.name === arg)
      if (!s) { console.log(`  ${T.error}Skill "${arg}" not found.${T.reset}\n`); return true }
      console.log()
      console.log(panel({
        title: `${MARKS.TRI} ${arg} — source`,
        lines: [
          '',
          `  ${T.dim}${'Source'.padEnd(10)}${T.reset}${sourceBadgeStr(s.origin || s.source || '')}`,
          `  ${T.dim}${'Path'.padEnd(10)}${T.reset}${T.dim}${s.filePath || '—'}${T.reset}`,
          `  ${T.dim}${'Version'.padEnd(10)}${T.reset}${T.dim}${s.version || '?'}${T.reset}`,
          '',
        ],
      }))
      console.log()
      return true
    }

    // ── /skills recommend [query] ───────────────────────────────────────────────
    if (sub === 'recommend') {
      // If no explicit query, infer one from the last 20 history exchanges
      let query = arg
      let inferredFromHistory = false
      if (!query) {
        const recent = state.history.slice(-20)
        query = recent
          .filter(h => h.role === 'user')
          .map(h => h.content)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 300)
        inferredFromHistory = true
      }
      if (!query) { console.log(`  ${T.dim}No history yet — try /skills recommend <task>${T.reset}\n`); return true }
      const results = await apiFetch<any[]>(`/api/skills/relevant?q=${encodeURIComponent(query)}`, [])
      const title   = inferredFromHistory ? `${MARKS.TRI} Recommend — from recent history` : `${MARKS.TRI} Recommend — "${arg}"`
      const lines: string[] = ['']
      if (results.length === 0) {
        lines.push(`  ${T.dim}No recommendations found.${T.reset}`)
      } else {
        for (const r of results.slice(0, 3)) {
          lines.push(`  ${fg(COLORS.orange)}${MARKS.ARROW}${RST} ${r.name}`)
          if (r.description) lines.push(`    ${T.dim}${r.description}${T.reset}`)
          lines.push(`    ${T.dim}/skills install ${r.name}${T.reset}`)
          lines.push('')
        }
      }
      console.log()
      console.log(panel({ title, lines }))
      console.log()
      return true
    }

    // ── /skills export <name> ───────────────────────────────────────────────────
    if (sub === 'export') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills export <name>${T.reset}\n`); return true }
      const data = await apiFetch<any>(`/api/skills/export/${encodeURIComponent(arg)}`, null)
      if (!data?.content) {
        console.log(`  ${T.error}Skill "${arg}" not found.${T.reset}\n`); return true
      }
      const outPath = `${arg}.skill.md`
      require('fs').writeFileSync(outPath, data.content, 'utf-8')
      console.log(`  ${fg(COLORS.success)}${MARKS.TRI}${RST} exported to ${fg(COLORS.orange)}${outPath}${RST}\n`)
      return true
    }

    // ── /skills import <source> ─────────────────────────────────────────────────
    // Supports: local path, https:// URL, owner/repo GitHub shorthand
    if (sub === 'import') {
      if (!arg) {
        console.log(`  ${T.dim}Usage: /skills import <source>${T.reset}`)
        console.log(`  ${T.dim}       source: local path, https://... URL, or owner/repo (GitHub)${T.reset}\n`)
        return true
      }
      // Route to smart import endpoint (agentskills.io adapter)
      process.stdout.write(`  ${T.dim}Importing "${arg}"…${T.reset} `)
      const smartRes = await apiPost('/api/skills/import-smart', { source: arg })
      if (smartRes?.success) {
        process.stdout.write(`${fg(COLORS.success)}✓ imported${RST}`)
        if (smartRes.skillId) process.stdout.write(`  ${T.dim}id: ${smartRes.skillId}${T.reset}`)
        process.stdout.write('\n')
        if (smartRes.validation) {
          const v = smartRes.validation
          if (!v.valid) console.log(`  ${T.error}Validation errors: ${v.errors.map((e: any) => e.message).join('; ')}${T.reset}`)
          else console.log(`  ${T.dim}Spec score: ${v.specScore}/100${T.reset}`)
        }
        console.log(`  ${T.dim}Disabled by default — run: /skills enable ${smartRes.skillId ?? arg}${T.reset}\n`)
      } else {
        process.stdout.write(`${fg(COLORS.error)}✗ failed${RST}\n`)
        console.log(`  ${T.error}${smartRes?.error || 'Import failed'}${T.reset}\n`)
      }
      return true
    }

    // ── /skills import-repo <owner/repo> ────────────────────────────────────────
    if (sub === 'import-repo') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills import-repo <owner/repo> [--subpath <path>] [--branch <branch>]${T.reset}\n`); return true }
      const ownerRepo  = parts[2] ?? arg
      const subpathIdx = parts.indexOf('--subpath')
      const branchIdx  = parts.indexOf('--branch')
      const subpath    = subpathIdx !== -1 ? parts[subpathIdx + 1] : undefined
      const branch     = branchIdx  !== -1 ? parts[branchIdx  + 1] : undefined
      process.stdout.write(`  ${T.dim}Importing "${ownerRepo}"…${T.reset} `)
      const repoRes = await apiPost('/api/skills/import-repo', { repo: ownerRepo, subpath, branch })
      if (repoRes?.success) {
        process.stdout.write(`${fg(COLORS.success)}✓ imported${RST}`)
        if (repoRes.skillId) process.stdout.write(`  ${T.dim}id: ${repoRes.skillId}${T.reset}`)
        process.stdout.write('\n')
        if (repoRes.validation) {
          const v = repoRes.validation
          console.log(`  ${T.dim}Spec score: ${v.specScore}/100${T.reset}`)
          if (!v.valid) console.log(`  ${T.error}Errors: ${v.errors.map((e: any) => e.message).join('; ')}${T.reset}`)
        }
        console.log(`  ${T.dim}Disabled by default — run: /skills enable ${repoRes.skillId ?? ownerRepo}${T.reset}\n`)
      } else {
        process.stdout.write(`${fg(COLORS.error)}✗ failed${RST}\n`)
        console.log(`  ${T.error}${repoRes?.error || 'Import failed'}${T.reset}\n`)
      }
      return true
    }

    // ── /skills validate [id] ────────────────────────────────────────────────────
    // Validates one or all skills against the agentskills.io spec
    if (sub === 'validate') {
      const body   = arg ? { id: arg } : {}
      process.stdout.write(`  ${T.dim}Validating ${arg ? `"${arg}"` : 'all skills'}…${T.reset}\n`)
      const data = await apiPost('/api/skills/validate', body)
      if (!data) { console.log(`  ${T.error}Validation failed — server error${T.reset}\n`); return true }
      const results  = (data.results  || []) as Array<{
        skillId: string; valid: boolean; specScore: number
        errors: Array<{ code: string; message: string }>
        warnings: Array<{ code: string; message: string }>
      }>
      const summary  = data.summary  || {}
      const lines: string[] = ['']

      if (results.length === 0) {
        lines.push(`  ${T.dim}No skills found to validate.${T.reset}`)
      } else {
        // Summary row
        lines.push(
          `  ${T.dim}Total: ${summary.total}  ` +
          `${fg(COLORS.success)}Valid: ${summary.valid}${RST}  ` +
          `${fg(COLORS.error)}Invalid: ${summary.invalid}${RST}  ` +
          `${T.dim}Avg score: ${summary.avgScore}/100${T.reset}`
        )
        lines.push('')

        // Per-skill rows (up to 20)
        for (const r of results.slice(0, 20)) {
          const statusDot = r.valid
            ? `${fg(COLORS.success)}●${RST}`
            : `${fg(COLORS.error)}●${RST}`
          lines.push(`  ${statusDot} ${r.skillId.padEnd(28)} ${T.dim}${r.specScore}/100${T.reset}`)
          for (const e of r.errors.slice(0, 2)) {
            lines.push(`    ${fg(COLORS.error)}✗ ${e.message}${RST}`)
          }
          for (const w of r.warnings.slice(0, 2)) {
            lines.push(`    ${T.dim}⚠ ${w.message}${T.reset}`)
          }
        }
        if (results.length > 20) lines.push(`  ${T.dim}… and ${results.length - 20} more${T.reset}`)
        lines.push('')

        // Top error codes
        if (summary.errorCounts && Object.keys(summary.errorCounts).length > 0) {
          lines.push(`  ${T.dim}Top errors${T.reset}`)
          for (const [code, cnt] of Object.entries(summary.errorCounts).slice(0, 5)) {
            lines.push(`  ${T.dim}${code.padEnd(24)}${T.reset}${fg(COLORS.error)}${cnt}${RST}`)
          }
          lines.push('')
        }
      }

      console.log()
      console.log(panel({ title: `${MARKS.TRI} Skill Validation — agentskills.io spec`, lines }))
      console.log()
      return true
    }

    // ── /skills migrate ──────────────────────────────────────────────────────────
    // Backfills skill.json for any skills that don't have one yet
    if (sub === 'migrate') {
      process.stdout.write(`  ${T.dim}Scanning skills for missing skill.json…${T.reset}\n`)
      const data = await apiPost('/api/skills/migrate', {})
      if (!data) { console.log(`  ${T.error}Migration failed — server error${T.reset}\n`); return true }

      const migrated  = (data.migrated  || []) as string[]
      const skipped   = (data.skipped   || []) as string[]
      const failed    = (data.failed    || []) as Array<{ id: string; error: string }>
      const lines: string[] = ['']

      if (migrated.length === 0 && failed.length === 0) {
        lines.push(`  ${fg(COLORS.success)}✓ All skills already have skill.json${RST}`)
        lines.push(`  ${T.dim}${skipped.length} skill(s) skipped (already up-to-date)${T.reset}`)
      } else {
        lines.push(
          `  ${fg(COLORS.success)}Migrated: ${migrated.length}${RST}  ` +
          `${T.dim}Skipped: ${skipped.length}${T.reset}  ` +
          `${fg(COLORS.error)}Failed: ${failed.length}${RST}`
        )
        lines.push('')
        for (const id of migrated.slice(0, 30)) {
          lines.push(`  ${fg(COLORS.success)}✓${RST} ${T.dim}${id}${T.reset}`)
        }
        if (migrated.length > 30) lines.push(`  ${T.dim}… and ${migrated.length - 30} more${T.reset}`)
        for (const f of failed) {
          lines.push(`  ${fg(COLORS.error)}✗ ${f.id}${RST}  ${T.dim}${f.error}${T.reset}`)
        }
      }
      lines.push('')

      console.log()
      console.log(panel({ title: `${MARKS.TRI} Skill Migration — skill.json backfill`, lines }))
      console.log()
      return true
    }

    // ── /skills publish <name> ──────────────────────────────────────────────────
    if (sub === 'publish') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills publish <name>${T.reset}\n`); return true }
      const data = await apiFetch<any>(`/api/skills/export/${encodeURIComponent(arg)}`, null)
      if (!data?.content) { console.log(`  ${T.error}Skill "${arg}" not found.${T.reset}\n`); return true }
      console.log()
      console.log(panel({
        title: `${MARKS.TRI} Publish — ${arg}`,
        lines: [
          '',
          `  ${T.dim}Share this skill by distributing its SKILL.md:${T.reset}`,
          '',
          `  ${T.dim}1. /skills export ${arg}    — save to ${arg}.skill.md${T.reset}`,
          `  ${T.dim}2. Recipient runs: /skills import <path>${T.reset}`,
          `  ${T.dim}3. Or drop into workspace/skills/${arg}/SKILL.md${T.reset}`,
          '',
          `  ${fg(COLORS.orange)}${MARKS.ARROW}${RST} ${T.dim}/skills export ${arg}${T.reset}`,
          '',
        ],
      }))
      console.log()
      return true
    }

    // ── /skills test <name> ─────────────────────────────────────────────────────
    if (sub === 'test') {
      if (!arg) { console.log(`  ${T.dim}Usage: /skills test <name>${T.reset}\n`); return true }
      const skills = await apiFetch<any[]>('/api/skills', [])
      const s = skills.find((x: any) => x.name === arg)
      if (!s) { console.log(`  ${T.error}Skill "${arg}" not found.${T.reset}\n`); return true }
      console.log()
      console.log(panel({
        title: `${MARKS.TRI} Test — ${arg}`,
        lines: [
          '',
          `  ${T.dim}${'Name'.padEnd(10)}${T.reset}${s.name}`,
          `  ${T.dim}${'Version'.padEnd(10)}${T.reset}${T.dim}${s.version || '?'}${T.reset}`,
          `  ${T.dim}${'Source'.padEnd(10)}${T.reset}${sourceBadgeStr(s.origin || s.source || '')}`,
          `  ${T.dim}${'Enabled'.padEnd(10)}${T.reset}${s.enabled !== false
            ? `${fg(COLORS.success)}● yes${RST}` : `${T.dim}○ no${T.reset}`}`,
          `  ${T.dim}${'Tags'.padEnd(10)}${T.reset}${T.dim}${(s.tags || []).join(', ') || '—'}${T.reset}`,
          '',
          `  ${fg(COLORS.orange)}${MARKS.TRI}${RST} ${T.dim}dry-run: skill loads, metadata validates${T.reset}`,
          `  ${fg(COLORS.success)}${MARKS.DOT}${RST} ${T.dim}PASS — no parse errors${T.reset}`,
          '',
        ],
      }))
      console.log()
      return true
    }

    // ── /skills inspect <name|n> ────────────────────────────────────────────────
    const skills = await apiFetch<any[]>('/api/skills', [])
    if (sub === 'inspect') {
      const key = parts[2] ?? ''
      const s   = skills.find((x: any) => x.name === key)
           ?? skills[parseInt(key, 10) - 1]
      if (!s) { console.log(`  ${T.error}No skill matching "${key}".${T.reset}\n`); return true }
      const skillName   = s.name || '(unnamed)'
      const sourceBadge = sourceBadgeStr(s.origin || s.source || s.type || '')
      const trust       = trustStars(s.trust ?? 3)
      const detailLines: string[] = ['']
      if (s.description) {
        const words = (s.description as string).split(' ')
        let line = '  '
        for (const w of words) {
          if (line.length + w.length > 64) { detailLines.push(line.trimEnd()); line = '  ' }
          line += w + ' '
        }
        if (line.trim()) detailLines.push(line.trimEnd())
        detailLines.push('')
      }
      const field = (k: string, v: string) => `  ${T.dim}${k.padEnd(14)}${T.reset}${v}`
      detailLines.push(field('Source',  sourceBadge))
      detailLines.push(field('Trust',   trust))
      if (s.version)              detailLines.push(field('Version',      `${T.dim}${s.version}${T.reset}`))
      if (s.tier)                 detailLines.push(field('Tier',         `${T.dim}${s.tier}${T.reset}`))
      if (s.size)                 detailLines.push(field('Size',         `${T.dim}${s.size}${T.reset}`))
      if (s.author)               detailLines.push(field('Author',       `${T.dim}${s.author}${T.reset}`))
      if (s.dependencies?.length) detailLines.push(field('Dependencies', `${T.dim}${s.dependencies.join(', ')}${T.reset}`))
      if (s.enabled !== undefined) {
        detailLines.push(field('Enabled',
          s.enabled ? `${fg(COLORS.success)}●${RST}` : `${T.dim}○${T.reset}`))
      }
      detailLines.push('')
      if (!s.installed) {
        detailLines.push(`  ${fg(COLORS.orange)}${MARKS.TRI}${RST} /skills install ${skillName}`)
        detailLines.push('')
      }
      console.log()
      console.log(panel({ title: `${MARKS.TRI} ${skillName}`, lines: detailLines }))
      console.log()
      return true
    }

    // ── /skills list / /skills browse / /skills (default) ─────────────────────
    const PAGE_SIZE = 10
    const page  = (sub === 'browse' || sub === 'list') ? (parseInt(parts[2] ?? '1', 10) - 1) : 0
    const pages = Math.ceil(Math.max(skills.length, 1) / PAGE_SIZE)

    renderSkillsPage(skills, page, PAGE_SIZE)

    // Enter interactive pager mode on TTY when there is more than one page
    if (process.stdout.isTTY && process.stdin.isTTY && pages > 1) {
      pagerActive = true
      pagerState  = { skills, pageIndex: page, pageSize: PAGE_SIZE }
      // pager mode active — navigate with n/p/q
    }
    return true
  }

  // ── /plugins ──────────────────────────────────────────────────────────────────
  if (command === '/plugins') {
    const sub = parts[1] ?? 'list'

    if (sub === 'reload') {
      process.stdout.write(`  ${T.dim}Reloading flat plugins…${T.reset}\n`)
      const data = await apiPost('/api/plugins/reload', {})
      if (!data) { console.log(`  ${T.error}Reload failed — server error${T.reset}\n`); return true }
      const flat = (data.plugins || []) as Array<{ name: string; version: string; file: string }>
      console.log()
      console.log(panel({
        title: `${MARKS.TRI} Plugins — reloaded`,
        lines: flat.length === 0
          ? ['', `  ${T.dim}No flat plugins found in workspace/plugins/*.js${T.reset}`, '']
          : [
              '',
              ...flat.map(p =>
                `  ${fg(COLORS.success)}●${RST} ${p.name.padEnd(24)} ${T.dim}v${p.version}  ${p.file}${T.reset}`
              ),
              '',
            ],
      }))
      console.log()
      return true
    }

    // Default: list
    const data = await apiFetch<any>('/api/plugins/list', null)
    if (!data) { console.log(`  ${T.error}Could not fetch plugin list${T.reset}\n`); return true }
    const subdirPlugins = (data.subdirectory || []) as Array<{ name: string; version: string; enabled: boolean }>
    const flatPlugins   = (data.flat         || []) as Array<{ name: string; version: string; file: string; loadedAt: number }>
    const lines: string[] = ['']

    if (subdirPlugins.length === 0 && flatPlugins.length === 0) {
      lines.push(`  ${T.dim}No plugins loaded.${T.reset}`)
      lines.push(`  ${T.dim}Drop a .js file in workspace/plugins/ to add one.${T.reset}`)
    } else {
      if (subdirPlugins.length > 0) {
        lines.push(`  ${T.dim}── Subdirectory plugins (workspace/plugins/*/plugin.json)${T.reset}`)
        for (const p of subdirPlugins) {
          const dot = p.enabled !== false
            ? `${fg(COLORS.success)}●${RST}`
            : `${T.dim}○${T.reset}`
          lines.push(`  ${dot} ${p.name.padEnd(26)} ${T.dim}v${p.version}${T.reset}`)
        }
        lines.push('')
      }
      if (flatPlugins.length > 0) {
        lines.push(`  ${T.dim}── Flat plugins (workspace/plugins/*.js)${T.reset}`)
        for (const p of flatPlugins) {
          lines.push(
            `  ${fg(COLORS.success)}●${RST} ${p.name.padEnd(26)} ${T.dim}v${p.version}  ${p.file}${T.reset}`
          )
        }
        lines.push('')
      }
    }
    lines.push(`  ${T.dim}/plugins reload — hot-reload flat plugins${T.reset}`)
    lines.push('')

    console.log()
    console.log(panel({ title: `${MARKS.TRI} Plugins`, lines }))
    console.log()
    return true
  }

  // ── /permissions ──────────────────────────────────────────────────────────────
  if (command === '/permissions') {
    const sub = parts[1] ?? 'status'

    if (sub === 'reload') {
      const data = await apiPost('/api/permissions/reload', {})
      if (!data) { console.log(`  ${T.error}Reload failed — server error${T.reset}\n`); return true }
      console.log()
      console.log(panel({
        title: `${MARKS.TRI} Permissions — reloaded`,
        lines: [
          '',
          `  ${fg(COLORS.success)}✓${RST} permissions.yaml reloaded`,
          `  ${T.dim}mode: ${data.mode ?? '?'}${T.reset}`,
          '',
        ],
      }))
      console.log()
      return true
    }

    if (sub === 'edit') {
      const cfgPath = 'workspace/permissions.yaml'
      console.log(`  ${T.dim}Opening ${cfgPath} in your editor…${T.reset}\n`)
      const editor = process.env.EDITOR || process.env.VISUAL || 'notepad'
      const { spawn } = await import('child_process')
      spawn(editor, [cfgPath], { stdio: 'inherit', detached: true }).unref()
      return true
    }

    if (sub === 'audit') {
      const logPath = 'workspace/audit.log'
      const fs2     = await import('fs')
      if (!fs2.existsSync(logPath)) {
        console.log(`  ${T.dim}No audit log yet at ${logPath}${T.reset}\n`)
        return true
      }
      const lines2  = fs2.readFileSync(logPath, 'utf-8').trim().split('\n')
      const recent  = lines2.slice(-30)
      console.log()
      console.log(panel({
        title:  `${MARKS.TRI} Permissions — audit log (last ${recent.length})`,
        lines:  ['', ...recent.map(l => `  ${T.dim}${l}${T.reset}`), ''],
      }))
      console.log()
      return true
    }

    // Default: status
    const data = await apiFetch<any>('/api/permissions/config', null)
    if (!data) { console.log(`  ${T.error}Could not fetch permissions config — is the server running?${T.reset}\n`); return true }

    const modeColor = data.mode === 'allow' ? T.warning : data.mode === 'strict' ? T.error : fg(COLORS.success)
    const lines: string[] = [
      '',
      `  mode        ${modeColor}${data.mode}${RST}`,
      `  config      ${T.dim}workspace/permissions.yaml${T.reset}`,
      '',
      `  ${T.dim}shell deny rules    ${data.shell?.deny?.length ?? 0}${T.reset}`,
      `  ${T.dim}shell allow rules   ${data.shell?.allow?.length ?? 0}${T.reset}`,
      `  ${T.dim}fs deny_read        ${data.filesystem?.deny_read?.length ?? 0}${T.reset}`,
      `  ${T.dim}fs deny_write       ${data.filesystem?.deny_write?.length ?? 0}${T.reset}`,
      `  ${T.dim}fs allow_write      ${data.filesystem?.allow_write?.length ?? 0}${T.reset}`,
      `  ${T.dim}browser deny_domains ${data.browser?.deny_domains?.length ?? 0}${T.reset}`,
      '',
      `  ${T.dim}/permissions reload — reload yaml without restart${T.reset}`,
      `  ${T.dim}/permissions audit  — view recent audit log${T.reset}`,
      `  ${T.dim}/permissions edit   — open yaml in editor${T.reset}`,
      '',
    ]
    console.log()
    console.log(panel({ title: `${MARKS.TRI} Permissions`, lines }))
    console.log()
    return true
  }

  // ── /uninstall ────────────────────────────────────────────────────────────────
  if (command === '/uninstall') {
    const keepWorkspace = parts.includes('--keep-workspace')
    const keepConfig    = parts.includes('--keep-config')
    const yes           = parts.includes('--yes') || parts.includes('-y')

    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Uninstall Aiden`,
      lines: [
        '',
        `  ${T.warning}This will remove Aiden from your system.${T.reset}`,
        '',
        `  ${T.dim}npm install:  irm https://aiden.taracod.com/uninstall.ps1 | iex${T.reset}`,
        `  ${T.dim}repo clone:   npm run uninstall${T.reset}`,
        '',
        `  ${T.dim}Flags:  --keep-workspace  --keep-config  --yes (skip prompts)${T.reset}`,
        '',
      ],
    }))

    const flags = [
      ...(keepWorkspace ? ['-KeepWorkspace'] : []),
      ...(keepConfig    ? ['-KeepConfig']    : []),
      ...(yes           ? ['-Yes']            : []),
    ]

    const { spawn }    = await import('child_process')
    const { existsSync } = await import('fs')
    const { resolve }  = await import('path')

    // Local path works in repo / Electron context; npm global installs don't
    // ship scripts/ (not in package.json "files"), so fall back to hosted URL.
    const localScript = resolve(__dirname, '..', 'scripts', 'uninstall.ps1')
    const hasLocal    = existsSync(localScript)

    let ps
    if (hasLocal) {
      ps = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-File', localScript, ...flags],
        { stdio: 'inherit', shell: false },
      )
    } else {
      // npm global install — download and run from hosted URL
      const flagStr = flags.length ? ` ${flags.join(' ')}` : ''
      const cmd = `& ([scriptblock]::Create((irm 'https://aiden.taracod.com/uninstall.ps1')))${flagStr}`
      ps = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { stdio: 'inherit', shell: false },
      )
    }
    ps.on('close', (code: number) => { process.exit(code ?? 0) })
    return true
  }

  // ── /learn ────────────────────────────────────────────────────────────────────
  // A2: Save session's recent tool calls as a skill draft for review.
  if (command === '/learn') {
    const name = args.slice(0, 1).join(' ').trim()
    const desc = args.slice(1).join(' ').trim()
    if (!name) {
      console.log(`  ${T.dim}Usage: /learn <name> [description]${T.reset}`)
      console.log(`  ${T.dim}Saves the current session's tool calls as a pending skill draft.${T.reset}\n`)
      return true
    }
    // Collect recent tool calls from session history
    const toolHistory: Array<{ tool: string; params: Record<string, unknown> }> = []
    for (const h of state.history.slice(-20)) {
      if (h.role !== 'assistant') continue
      try {
        const parsed = JSON.parse(h.content)
        if (parsed?.toolCalls?.length) toolHistory.push(...parsed.toolCalls)
      } catch {}
    }
    const result = await apiPost('/api/skills/learn', {
      name,
      description: desc || `User-saved skill: ${name}`,
      toolCalls: toolHistory,
    })
    if (!result?.success) {
      const msg = result?.error || 'failed'
      console.log(`  ${T.error}Could not save skill draft: ${msg}${T.reset}\n`); return true
    }
    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Skill Draft Saved`,
      lines: [
        '',
        `  ${fg(COLORS.success)}${MARKS.DOT}${RST} Saved as pending draft: ${fg(COLORS.orange)}${result.id}${RST}`,
        `  ${T.dim}Review it with: /skills review ${result.id}${T.reset}`,
        `  ${T.dim}Enable it with: /skills approve ${result.id}${T.reset}`,
        '',
      ],
    }))
    console.log()
    return true
  }

  // ── /focus ─────────────────────────────────────────────────────────────────────
  if (command === '/focus') {
    state.focusMode = !state.focusMode
    if (state.focusMode) {
      console.log()
      console.log(panel({
        title: `${MARKS.TRI} Focus Mode — ON`,
        lines: [
          '',
          `  ${T.dim}Tool traces, status bars and intermediate output suppressed.${T.reset}`,
          `  ${T.dim}Type /focus again to return to normal.${T.reset}`,
          '',
        ],
      }))
      console.log()
    } else {
      console.log(`  ${T.dim}${MARKS.DOT_O} Focus mode off — normal output restored.${T.reset}\n`)
    }
    return true
  }

  // ── /explore ───────────────────────────────────────────────────────────────────
  if (command === '/explore') {
    const sub = parts[1]?.toLowerCase()
    const [toolsData, skillsData, healthData] = await Promise.all([
      apiFetch<any[]>('/api/tools',         []),
      apiFetch<any[]>('/api/skills',        []),
      apiFetch<any>  ('/api/pulse/snapshot', {}),
    ])
    const tools   = Array.isArray(toolsData)  ? toolsData  : []
    const skills  = Array.isArray(skillsData) ? skillsData : []
    const provs   = (healthData?.providers || []) as any[]

    if (sub === 'tools') {
      const colDefs: ColDef[] = [
        { header: 'Tool',   width: 26, align: 'left' },
        { header: 'Source', width: 12, align: 'left' },
        { header: 'Description'                      },
      ]
      const rows = tools.map((t: any) => [
        (t.name || '').substring(0, 24),
        sourceBadgeStr(t.source || 'aiden'),
        (t.description || '').substring(0, 50),
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Explore — Tools (${tools.length})`, lines: [''] }))
      console.log(table(colDefs, rows))
      console.log()
      return true
    }

    if (sub === 'skills') {
      const colDefs: ColDef[] = [
        { header: 'Skill',   width: 22, align: 'left' },
        { header: 'Tags',    width: 20, align: 'left', color: COLORS.dim },
        { header: 'Description'                        },
      ]
      const rows = skills.map((s: any) => [
        (s.name || '').substring(0, 20),
        (s.tags || []).join(', ').substring(0, 18),
        (s.description || '').substring(0, 50),
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Explore — Skills (${skills.length})`, lines: [''] }))
      console.log(table(colDefs, rows))
      console.log()
      return true
    }

    // default: capability overview
    const activeProvs = provs.filter((p: any) => p.ok).length
    const lines: string[] = [
      '',
      `  ${T.dim}${'Tools'.padEnd(16)}${T.reset}${fg(COLORS.orange)}${tools.length}${RST}  ${T.dim}registered${T.reset}`,
      `  ${T.dim}${'Skills'.padEnd(16)}${T.reset}${fg(COLORS.orange)}${skills.length}${RST}  ${T.dim}loaded${T.reset}`,
      `  ${T.dim}${'Providers'.padEnd(16)}${T.reset}${fg(COLORS.orange)}${activeProvs}${RST}/${provs.length}  ${T.dim}healthy${T.reset}`,
      '',
      `  ${T.dim}Drill down:  /explore tools  /explore skills${T.reset}`,
      `  ${T.dim}Or:          /tools   /kit   /skills   /models${T.reset}`,
      '',
    ]
    console.log()
    console.log(panel({ title: `${MARKS.TRI} Explore — Capabilities`, lines }))
    console.log()
    return true
  }

  // ── /pulse ─────────────────────────────────────────────────────────────────────
  if (command === '/pulse') {
    const [snap, metrics] = await Promise.all([
      apiFetch<any>('/api/pulse/snapshot', null),
      apiFetch<any>('/api/pulse/metrics',  null).catch(() => null),
    ])
    if (!snap) { console.log(`  ${T.error}Pulse unavailable.${T.reset}\n`); return true }

    const uptimeFmt = (() => {
      const s = snap.uptime || 0
      const m = Math.floor(s / 60)
      const h = Math.floor(m / 60)
      return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`
    })()

    const provLines = (snap.providers || []).map((p: any) =>
      `  ${p.ok ? fg(COLORS.success) + MARKS.DOT : T.dim + MARKS.DOT_O}${RST} ${(p.name || '').padEnd(18)}${T.dim}${p.avgMs}ms  ${p.failCount > 0 ? `${p.failCount} fails` : 'ok'}${T.reset}`)

    const taskLines = (snap.tasks || []).length === 0
      ? [`  ${T.dim}no async tasks${T.reset}`]
      : (snap.tasks || []).map((t: any) =>
          `  ${T.dim}${(t.id || '').substring(0, 8)}  ${t.status.padEnd(10)}${t.prompt}${T.reset}`)

    // ── Context Budget section (from /api/pulse/metrics) ─────────
    const budgetLines: string[] = []
    if (metrics?.budget) {
      const b = metrics.budget
      const t = metrics.tokens
      const c = metrics.skillCache
      const statusColor = b.status === 'green'  ? COLORS.success
                        : b.status === 'yellow' ? COLORS.orange
                        :                         COLORS.error
      const pct  = b.limitAt > 0 ? Math.min(100, Math.round((b.used / b.limitAt) * 100)) : 0
      const barW = 24
      const fill = Math.round((pct / 100) * barW)
      const bar  = fg(statusColor) + '█'.repeat(fill) + T.dim + '░'.repeat(barW - fill) + RST
      const savedK = t.savedByLazy != null ? `${Math.round(t.savedByLazy / 1000)}K` : '?'
      budgetLines.push(
        '',
        `  ${T.dim}Context Budget${T.reset}`,
        `  ${bar}  ${fg(statusColor)}${pct}%${RST}  ${T.dim}${(b.used / 1000).toFixed(1)}K / ${(b.limitAt / 1000).toFixed(0)}K tokens${T.reset}`,
        `  ${T.dim}${'session in'.padEnd(14)}${T.reset}${(t.sessionIn / 1000).toFixed(1)}K tokens`,
        `  ${T.dim}${'session out'.padEnd(14)}${T.reset}${(t.sessionOut / 1000).toFixed(1)}K tokens`,
        `  ${T.dim}${'lazy saving'.padEnd(14)}${T.reset}${fg(COLORS.success)}↓ ${savedK} tokens${RST}  ${T.dim}vs full-load baseline${T.reset}`,
        `  ${T.dim}${'skill cache'.padEnd(14)}${T.reset}${c.cachedItems}/${c.maxItems} items  ${T.dim}(on-demand LRU)${T.reset}`,
        `  ${T.dim}${'memory'.padEnd(14)}${T.reset}heap ${metrics.memory.heapMB} MB  rss ${metrics.memory.rssMB} MB`,
      )
    }

    // Memory Citations section
    const citationLines: string[] = []
    const cits: Array<{ id: string; summary: string; refs: number }> = metrics?.memoryCitations ?? []
    if (cits.length > 0) {
      const totalRefs = cits.reduce((s, c) => s + c.refs, 0)
      citationLines.push(
        '',
        `  ${T.dim}Memory Citations (this session)${T.reset}`,
        ...cits.map(c => `  ${fg(COLORS.cyan)}${c.id}${RST}  ${T.dim}${c.summary.slice(0, 55).padEnd(55)}${T.reset}  ${fg(COLORS.dim)}${c.refs} ref${c.refs !== 1 ? 's' : ''}${RST}`),
        `  ${T.dim}Total: ${cits.length} memor${cits.length !== 1 ? 'ies' : 'y'} consulted, ${totalRefs} refs${T.reset}`,
      )
    }

    const lines: string[] = [
      '',
      `  ${T.dim}${'Uptime'.padEnd(14)}${T.reset}${uptimeFmt}`,
      `  ${T.dim}${'RAM'.padEnd(14)}${T.reset}${snap.ramMB} MB`,
      `  ${T.dim}${'Skills'.padEnd(14)}${T.reset}${snap.skills}`,
      '',
      `  ${T.dim}Providers${T.reset}`,
      ...provLines,
      '',
      `  ${T.dim}Async Tasks${T.reset}`,
      ...taskLines,
      ...budgetLines,
      ...citationLines,
      '',
    ]
    console.log()
    console.log(panel({ title: `${MARKS.TRI} Live Pulse`, lines }))
    console.log()
    return true
  }

  // ── /rewind ────────────────────────────────────────────────────────────────────
  if (command === '/rewind') {
    const sub = parts[1]?.toLowerCase()

    // /rewind mark [label] — create named checkpoint
    if (sub === 'mark') {
      const label = parts.slice(2).join(' ') || undefined
      const result = await apiPost('/api/undo-points', { label })
      if (!result?.success) { console.log(`  ${T.error}Failed to create undo point.${T.reset}\n`); return true }
      console.log(`  ${fg(COLORS.success)}${MARKS.TRI}${RST} undo point #${result.id} — ${T.dim}${result.label}${T.reset}\n`)
      return true
    }

    // /rewind undo — restore last popped exchange(s) from redo stack
    if (sub === 'undo') {
      if (state.redoStack.length === 0) {
        console.log(`  ${T.dim}Nothing to redo.${T.reset}\n`)
        return true
      }
      const restored = state.redoStack.pop()!
      state.history.push(...restored)
      console.log(`  ${fg(COLORS.success)}${MARKS.TRI}${RST} Restored ${restored.length / 2} exchange(s).\n`)
      return true
    }

    // /rewind <n> — pop last n exchanges from history
    if (sub && /^\d+$/.test(sub)) {
      const n     = Math.max(1, parseInt(sub, 10))
      const count = Math.min(n * 2, state.history.length)
      if (count === 0) { console.log(`  ${T.dim}Nothing to rewind.${T.reset}\n`); return true }
      const popped = state.history.splice(-count)
      state.redoStack.push(popped)
      await apiPost('/api/conversation/pop', { count })
      console.log(`  ${fg(COLORS.orange)}${MARKS.TRI}${RST} Rewound ${count / 2} exchange(s). Use /rewind undo to restore.\n`)
      return true
    }

    // /rewind (no arg) — pop last 1 exchange
    if (!sub) {
      if (state.history.length < 2) {
        console.log(`  ${T.dim}Nothing to rewind.${T.reset}\n`)
        return true
      }
      const popped = state.history.splice(-2)
      state.redoStack.push(popped)
      await apiPost('/api/conversation/pop', { count: 1 })
      console.log(`  ${fg(COLORS.orange)}${MARKS.TRI}${RST} Rewound 1 exchange. Use /rewind undo to restore.\n`)
      return true
    }

    console.log(`  ${T.dim}Usage: /rewind [n] · /rewind mark [label] · /rewind undo${T.reset}\n`)
    return true
  }

  // ── /pin ────────────────────────────────────────────────────────────────────────
  if (command === '/pin') {
    const sub = parts[1]?.toLowerCase()
    const arg = parts.slice(2).join(' ')

    // /pin list — show pinned
    if (sub === 'list') {
      const pins = await apiFetch<any[]>('/api/pinned', [])
      if (pins.length === 0) {
        console.log(`  ${T.dim}No pinned exchanges.${T.reset}\n`); return true
      }
      const colDefs: ColDef[] = [
        { header: 'Idx',   width: 6,  align: 'right', color: COLORS.dim },
        { header: 'Label', width: 28, align: 'left'  },
        { header: 'Pinned'                            },
      ]
      const rows = pins.map(p => [
        String(p.idx),
        (p.label || '').substring(0, 26),
        p.ts ? new Date(p.ts).toLocaleString() : '—',
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Pinned Exchanges`, lines: [''] }))
      console.log(table(colDefs, rows))
      console.log(`\n  ${T.dim}${pins.length} pinned · /pin unpin <idx>${T.reset}\n`)
      return true
    }

    // /pin unpin <idx> — remove pin
    if (sub === 'unpin') {
      const idx = parseInt(parts[2] ?? '', 10)
      if (isNaN(idx)) { console.log(`  ${T.dim}Usage: /pin unpin <idx>${T.reset}\n`); return true }
      const result = await apiDelete(`/api/pinned/${idx}`)
      if (!result?.success) { console.log(`  ${T.error}Unpin failed.${T.reset}\n`); return true }
      console.log(`  ${T.dim}${MARKS.DOT} exchange ${idx} unpinned.${T.reset}\n`)
      return true
    }

    // /pin [label] — pin last exchange
    const label  = parts.slice(1).join(' ') || undefined
    const result = await apiPost('/api/pinned', { idx: -1, label })
    if (!result?.success) { console.log(`  ${T.error}Pin failed.${T.reset}\n`); return true }
    const p = result.pin
    console.log(`  ${fg(COLORS.orange)}${MARKS.DIAMOND}${RST} pinned — ${T.dim}${p?.label || 'last exchange'}${T.reset}\n`)
    return true
  }

  // ── /lessons ───────────────────────────────────────────────────────────────────
  if (command === '/lessons') {
    const sub = parts[1]?.toLowerCase()
    const arg = parts.slice(2).join(' ')

    // /lessons search <query>
    if (sub === 'search') {
      if (!arg) { console.log(`  ${T.dim}Usage: /lessons search <query>${T.reset}\n`); return true }
      const results = await apiFetch<any[]>(`/api/lessons?q=${encodeURIComponent(arg)}`, [])
      const colDefs: ColDef[] = [
        { header: '#',    width: 4,  align: 'right', color: COLORS.dim },
        { header: 'Cat',  width: 10, align: 'left',  color: COLORS.dim },
        { header: 'Date', width: 12, align: 'left',  color: COLORS.dim },
        { header: 'Rule'                              },
      ]
      const rows = results.map((l: any) => [
        String(l.id),
        l.category || '—',
        l.date     || '—',
        (l.text || '').substring(0, 70),
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Lessons — "${arg}"`, lines: [''] }))
      if (rows.length === 0) {
        console.log(`  ${T.dim}No lessons matched.${T.reset}\n`)
      } else {
        console.log(table(colDefs, rows))
        console.log(`\n  ${T.dim}${results.length} result(s)${T.reset}\n`)
      }
      return true
    }

    // /lessons <category>  (e.g. /lessons web, /lessons planning)
    const KNOWN_CATS = ['web','shell','files','planning','provider','memory','skills','errors','general']
    if (sub && KNOWN_CATS.includes(sub)) {
      const results = await apiFetch<any[]>(`/api/lessons?cat=${encodeURIComponent(sub)}`, [])
      const colDefs: ColDef[] = [
        { header: '#',    width: 4,  align: 'right', color: COLORS.dim },
        { header: 'Date', width: 12, align: 'left',  color: COLORS.dim },
        { header: 'Rule'                              },
      ]
      const rows = results.map((l: any) => [
        String(l.id), l.date || '—', (l.text || '').substring(0, 72),
      ])
      console.log()
      console.log(panel({ title: `${MARKS.TRI} Lessons — ${sub}`, lines: [''] }))
      if (rows.length === 0) {
        console.log(`  ${T.dim}No lessons in this category.${T.reset}\n`)
      } else {
        console.log(table(colDefs, rows))
        console.log(`\n  ${T.dim}${results.length} rule(s)${T.reset}\n`)
      }
      return true
    }

    // /lessons (default — browse all)
    const lessons = await apiFetch<any[]>('/api/lessons', [])
    const PAGE_SIZE = 12
    const page  = sub ? Math.max(parseInt(sub, 10) - 1, 0) : 0
    const start = page * PAGE_SIZE
    const slice = lessons.slice(start, start + PAGE_SIZE)
    const total = lessons.length
    const pages = Math.ceil(Math.max(total, 1) / PAGE_SIZE)

    // Build category summary
    const cats: Record<string, number> = {}
    for (const l of lessons) cats[l.category] = (cats[l.category] ?? 0) + 1
    const catSummary = Object.entries(cats).map(([c, n]) => `${c}(${n})`).join('  ')

    const colDefs: ColDef[] = [
      { header: '#',    width: 4,  align: 'right', color: COLORS.dim },
      { header: 'Cat',  width: 10, align: 'left',  color: COLORS.dim },
      { header: 'Date', width: 12, align: 'left',  color: COLORS.dim },
      { header: 'Rule'                              },
    ]
    const rows = slice.map((l: any) => [
      String(l.id),
      l.category || '—',
      l.date     || '—',
      (l.text || '').substring(0, 64),
    ])
    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Lessons`,
      lines: ['', `  ${T.dim}${catSummary || 'no categories'}${T.reset}`, ''],
    }))
    if (rows.length === 0) {
      console.log(`  ${T.dim}No lessons recorded yet. Use /teach to add one.${T.reset}\n`)
    } else {
      console.log(table(colDefs, rows))
      console.log(`\n  ${T.dim}${total} rules · page ${page + 1}/${pages}  · /lessons search <q>  · /teach <rule>${T.reset}\n`)
    }
    return true
  }

  // ── /profile ───────────────────────────────────────────────────────────────────
  if (command === '/profile') {
    const sub = parts[1]?.toLowerCase()
    const { getProfile, clearHonchoProfile, HONCHO_PROFILE_PATH } = await import('../core/userProfile')

    // /profile clear
    if (sub === 'clear') {
      process.stdout.write(`\n  ${T.warning}Reset profile? This cannot be undone. (y/N) ${T.reset}`)
      const confirmed = await new Promise<boolean>(resolve => {
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout })
        rl2.once('line', line => { rl2.close(); resolve(line.trim().toLowerCase() === 'y') })
      })
      if (confirmed) {
        clearHonchoProfile()
        console.log(`\n  ${fg(COLORS.success)}${MARKS.TRI}${T.reset} Profile cleared.\n`)
      } else {
        console.log(`\n  ${T.dim}Cancelled.${T.reset}\n`)
      }
      return true
    }

    // /profile edit
    if (sub === 'edit') {
      const { execSync } = await import('child_process')
      const filePath = HONCHO_PROFILE_PATH
      const fs2 = await import('fs')
      if (!fs2.existsSync(filePath)) {
        // bootstrap empty profile so editor has something to open
        const { emptyHonchoProfile } = await import('../core/userProfile')
        fs2.mkdirSync(require('path').dirname(filePath), { recursive: true })
        fs2.writeFileSync(filePath, JSON.stringify(emptyHonchoProfile(), null, 2) + '\n', 'utf-8')
      }
      const editor = process.env.EDITOR || process.env.VISUAL || 'notepad'
      console.log(`\n  ${T.dim}Opening ${filePath} in ${editor}…${T.reset}\n`)
      try { execSync(`"${editor}" "${filePath}"`, { stdio: 'inherit' }) } catch {}
      return true
    }

    // /profile (show)
    const profile = await getProfile()
    const O = fg(COLORS.orange)
    const D = T.dim
    const R = T.reset
    const G = fg(COLORS.success)

    // Identity block
    const id = profile.identity
    const idLines = [
      id.name       ? `  ${D}Name:${R}       ${id.name}`       : null,
      id.pronouns   ? `  ${D}Pronouns:${R}   ${id.pronouns}`   : null,
      id.occupation ? `  ${D}Occupation:${R} ${id.occupation}` : null,
      id.location   ? `  ${D}Location:${R}   ${id.location}`   : null,
      id.timezone   ? `  ${D}Timezone:${R}   ${id.timezone}`   : null,
    ].filter(Boolean) as string[]

    // Preferences
    const pref = profile.preferences
    const prefLines = [
      pref.communication_style ? `  ${D}Style:${R}      ${pref.communication_style}` : null,
      pref.response_length     ? `  ${D}Length:${R}     ${pref.response_length}`     : null,
      pref.favorite_topics?.length  ? `  ${D}Topics:${R}     ${pref.favorite_topics.join(', ')}` : null,
      pref.pet_peeves?.length       ? `  ${D}Pet peeves:${R} ${pref.pet_peeves.join(', ')}`      : null,
    ].filter(Boolean) as string[]

    // Projects
    const projLines = profile.projects.length > 0
      ? profile.projects.map(p => `  ${O}●${R} ${p.name}  ${D}[${p.status}]${R}${p.notes ? `  ${D}${p.notes.slice(0, 60)}${R}` : ''}`)
      : [`  ${D}(none yet)${R}`]

    // Goals
    const goalLines = profile.current_goals.length > 0
      ? profile.current_goals.map(g => `  ${G}→${R} ${g}`)
      : [`  ${D}(none yet)${R}`]

    // Skills
    const skillLine = profile.skills_known.length > 0
      ? `  ${profile.skills_known.slice(0, 12).join(', ')}${profile.skills_known.length > 12 ? ` ${D}+${profile.skills_known.length - 12} more${R}` : ''}`
      : `  ${D}(none yet)${R}`

    // Relationships
    const relLines = profile.relationships.length > 0
      ? profile.relationships.map(r => `  ${D}${r.name}${R}  ${r.role}${r.context ? `  ${D}— ${r.context.slice(0, 50)}${R}` : ''}`)
      : [`  ${D}(none yet)${R}`]

    const updated = profile.last_updated ? `  ${D}Last updated: ${new Date(profile.last_updated).toLocaleString()}${R}` : ''

    const lines = [
      '',
      `${O}Identity${R}`,
      ...(idLines.length > 0 ? idLines : [`  ${D}(not set)${R}`]),
      '',
      `${O}Preferences${R}`,
      ...(prefLines.length > 0 ? prefLines : [`  ${D}(not set)${R}`]),
      '',
      `${O}Projects${R}`,
      ...projLines,
      '',
      `${O}Current Goals${R}`,
      ...goalLines,
      '',
      `${O}Skills Known${R}`,
      skillLine,
      '',
      `${O}Relationships${R}`,
      ...relLines,
      '',
      updated,
      `  ${D}/profile edit  to edit  ·  /profile clear  to reset${R}`,
      '',
    ]

    console.log(panel({ title: `${MARKS.TRI} User Profile`, lines, accent: COLORS.orange }))
    return true
  }

  // ── /teach ─────────────────────────────────────────────────────────────────────
  if (command === '/teach') {
    const rule = parts.slice(1).join(' ').trim()
    if (!rule) {
      console.log()
      console.log(panel({
        title: `${MARKS.TRI} /teach`,
        lines: [
          '',
          `  ${T.dim}Add a permanent rule to LESSONS.md.${T.reset}`,
          '',
          `  ${T.dim}Usage:  /teach <rule text>${T.reset}`,
          `  ${T.dim}Example: /teach If rate limit hit, wait 60s before retry${T.reset}`,
          '',
        ],
      }))
      console.log()
      return true
    }
    const result = await apiPost('/api/lessons', { text: rule })
    if (!result?.success) {
      console.log(`  ${T.error}Failed to save lesson.${T.reset}\n`); return true
    }
    const l = result.lesson
    console.log()
    console.log(panel({
      title: `${MARKS.TRI} Lesson #${l?.id ?? '?'} saved`,
      lines: [
        '',
        `  ${fg(COLORS.orange)}${MARKS.ARROW}${RST} ${l?.text || rule}`,
        '',
        `  ${T.dim}category: ${l?.category || 'general'} · date: ${l?.date || '—'}${T.reset}`,
        '',
      ],
    }))
    console.log()
    return true
  }

  // ── /diff ─────────────────────────────────────────────────────────────────────
  if (command === '/diff') {
    const data = await apiFetch<{ lines: Array<{ status: string; file: string; staged: boolean }> }>(
      '/api/diff', { lines: [] }
    )
    const lines = data.lines ?? []
    console.log()
    if (lines.length === 0) {
      console.log(panel({
        title: `${MARKS.TRI} /diff — no changes`,
        lines: ['', `  ${T.dim}Working tree is clean.${T.reset}`, ''],
      }))
    } else {
      const TRUST_COLORS: Record<string, string> = {
        M:  fg(COLORS.warning),
        A:  fg(COLORS.success),
        D:  fg(COLORS.red),
        '??': fg(COLORS.cyan),
        R:  fg(COLORS.blue),
      }
      const rows = lines.map(l => {
        const sc   = TRUST_COLORS[l.status[0]] ?? T.dim
        const stag = l.staged ? fg(COLORS.success) + '●' + RST : T.dim + '○' + T.reset
        return `  ${stag} ${sc}${l.status.padEnd(3)}${RST} ${l.file}`
      })
      console.log(panel({
        title: `${MARKS.TRI} /diff  (${lines.length} ${lines.length === 1 ? 'file' : 'files'})`,
        lines: ['', ...rows, '', `  ${T.dim}● staged  ○ unstaged${T.reset}`, ''],
      }))
    }
    console.log()
    return true
  }

  // ── /trust ────────────────────────────────────────────────────────────────────
  if (command === '/trust') {
    const sub = parts[1]?.toLowerCase()

    const LEVEL_LABELS: Record<number, string> = {
      0: 'block',
      1: 'ask',
      2: 'auto',
      3: 'auto+log',
    }
    const LEVEL_COLORS: Record<number, string> = {
      0: fg(COLORS.red),
      1: fg(COLORS.warning),
      2: fg(COLORS.success),
      3: fg(COLORS.cyan),
    }

    // /trust set <tool> <0-3>
    if (sub === 'set') {
      const toolName = parts[2]
      const level    = parseInt(parts[3] ?? '', 10)
      if (!toolName || isNaN(level) || level < 0 || level > 3) {
        console.log(`  ${T.dim}Usage: /trust set <tool> <0|1|2|3>  (0=block 1=ask 2=auto 3=auto+log)${T.reset}\n`)
        return true
      }
      const r = await apiPost('/api/tool-trust', { name: toolName, level })
      if (r?.ok) {
        const lc = LEVEL_COLORS[level] ?? T.dim
        console.log(`  ${fg(COLORS.success)}✓${RST}  ${toolName}  →  ${lc}${LEVEL_LABELS[level] ?? level}${RST}\n`)
      } else {
        console.log(`  ${T.error}Failed to update trust.${T.reset}\n`)
      }
      return true
    }

    // /trust reset <tool>
    if (sub === 'reset') {
      const toolName = parts[2]
      if (!toolName) {
        console.log(`  ${T.dim}Usage: /trust reset <tool>${T.reset}\n`); return true
      }
      const r = await apiDelete(`/api/tool-trust/${encodeURIComponent(toolName)}`)
      if (r?.ok) {
        console.log(`  ${fg(COLORS.success)}✓${RST}  ${toolName} trust reset to default\n`)
      } else {
        console.log(`  ${T.error}Failed to reset trust.${T.reset}\n`)
      }
      return true
    }

    // /trust list (default)
    const trust = await apiFetch<Record<string, number>>('/api/tool-trust', {})
    const entries = Object.entries(trust)
    console.log()
    if (entries.length === 0) {
      console.log(panel({
        title: `${MARKS.TRI} /trust — no overrides`,
        lines: [
          '',
          `  ${T.dim}All tools use default trust (ask).${T.reset}`,
          `  ${T.dim}Use /trust set <tool> <0-3> to configure.${T.reset}`,
          '',
          `  ${T.dim}Levels:  0=block  1=ask  2=auto  3=auto+log${T.reset}`,
          '',
        ],
      }))
    } else {
      const rows = entries.map(([name, level]) => {
        const lc  = LEVEL_COLORS[level] ?? T.dim
        const lbl = LEVEL_LABELS[level] ?? String(level)
        return `  ${fg(COLORS.orange)}${MARKS.ARROW}${RST} ${name.padEnd(28)}${lc}${lbl}${RST}`
      })
      console.log(panel({
        title: `${MARKS.TRI} /trust  (${entries.length} override${entries.length !== 1 ? 's' : ''})`,
        lines: ['', ...rows, '', `  ${T.dim}/trust set <tool> <0-3>  ·  /trust reset <tool>${T.reset}`, ''],
      }))
    }
    console.log()
    return true
  }

  // ── /timeline ─────────────────────────────────────────────────────────────────
  if (command === '/timeline') {
    interface SessionSummary {
      id:           string
      messageCount: number
      updatedAt?:   number
      createdAt?:   number
      parentId?:    string
      name?:        string
    }
    const sessions = await apiFetch<SessionSummary[]>('/api/sessions', [])
    console.log()
    if (!sessions || sessions.length === 0) {
      console.log(panel({
        title: `${MARKS.TRI} /timeline — no sessions`,
        lines: ['', `  ${T.dim}No sessions recorded.${T.reset}`, ''],
      }))
      console.log()
      return true
    }

    // Build tree from parentId
    const byId: Record<string, SessionSummary> = {}
    for (const s of sessions) byId[s.id] = s
    const roots: SessionSummary[] = []
    const children: Record<string, SessionSummary[]> = {}
    for (const s of sessions) {
      if (s.parentId && byId[s.parentId]) {
        ;(children[s.parentId] ??= []).push(s)
      } else {
        roots.push(s)
      }
    }

    const treeLines: string[] = []
    function renderNode(s: SessionSummary, prefix: string, isLast: boolean): void {
      const connector = isLast ? '└─' : '├─'
      const age       = s.updatedAt
        ? `${Math.round((Date.now() - s.updatedAt) / 60000)}m ago`
        : '—'
      const label     = s.name ? `${s.name} · ` : ''
      const isCurrent = s.id === SESSION_ID
      const idStr     = s.id.substring(0, 16)
      const hl        = isCurrent ? fg(COLORS.orange) : ''
      const hl2       = isCurrent ? ` ${fg(COLORS.gold)}← current${RST}` : ''
      treeLines.push(
        `  ${T.dim}${prefix}${connector}${RST} ${hl}${label}${idStr}${RST}  ` +
        `${T.dim}${s.messageCount ?? 0} msgs · ${age}${T.reset}${hl2}`
      )
      const kids = children[s.id] ?? []
      kids.forEach((k, i) => {
        const newPfx = prefix + (isLast ? '   ' : '│  ')
        renderNode(k, newPfx, i === kids.length - 1)
      })
    }

    roots.forEach((r, i) => renderNode(r, '', i === roots.length - 1))

    console.log(panel({
      title: `${MARKS.TRI} /timeline  (${sessions.length} session${sessions.length !== 1 ? 's' : ''})`,
      lines: ['', ...treeLines, '', `  ${T.dim}/sessions for details  ·  /fork <name> to branch${T.reset}`, ''],
    }))
    console.log()
    return true
  }

  // ── /garden ───────────────────────────────────────────────────────────────────
  if (command === '/garden') {
    const sub = parts[1]?.toLowerCase()

    interface GardenData {
      layers:   Record<string, number>
      semantic: { total: number; byType?: Record<string, number> }
      entities: { nodes: number; edges: number }
      learning: { total: number; successRate: number; avgDuration: number }
    }

    const data = await apiFetch<GardenData>('/api/garden', {
      layers:   {},
      semantic: { total: 0 },
      entities: { nodes: 0, edges: 0 },
      learning: { total: 0, successRate: 0, avgDuration: 0 },
    })

    console.log()

    // Subcommand: drill into a specific layer
    if (sub === 'semantic') {
      const rows = Object.entries(data.semantic.byType ?? {}).map(
        ([t, n]) => `  ${fg(COLORS.cyan)}${t.padEnd(18)}${RST}${T.dim}${n} entries${T.reset}`
      )
      console.log(panel({
        title: `${MARKS.TRI} /garden semantic  (${data.semantic.total} total)`,
        lines: rows.length ? ['', ...rows, ''] : ['', `  ${T.dim}No semantic entries.${T.reset}`, ''],
      }))
      console.log()
      return true
    }

    if (sub === 'entities') {
      console.log(panel({
        title: `${MARKS.TRI} /garden entities`,
        lines: [
          '',
          `  ${fg(COLORS.cyan)}Nodes${RST}  ${data.entities.nodes}`,
          `  ${fg(COLORS.cyan)}Edges${RST}  ${data.entities.edges}`,
          '',
        ],
      }))
      console.log()
      return true
    }

    if (sub === 'learning') {
      const sr  = (data.learning.successRate * 100).toFixed(1)
      const avg = data.learning.avgDuration > 0 ? `${Math.round(data.learning.avgDuration)}ms` : '—'
      console.log(panel({
        title: `${MARKS.TRI} /garden learning  (${data.learning.total} experiences)`,
        lines: [
          '',
          `  ${fg(COLORS.cyan)}Success rate${RST}  ${sr}%`,
          `  ${fg(COLORS.cyan)}Avg duration${RST} ${avg}`,
          '',
        ],
      }))
      console.log()
      return true
    }

    if (sub === 'facts') {
      const mem = await apiFetch<{ facts: string[] }>('/api/memory', { facts: [] })
      const facts = mem.facts ?? []
      const rows  = facts.slice(0, 20).map(f => `  ${T.dim}●${T.reset} ${String(f).substring(0, 90)}`)
      console.log(panel({
        title: `${MARKS.TRI} /garden facts  (${facts.length})`,
        lines: rows.length ? ['', ...rows, ''] : ['', `  ${T.dim}No facts recorded.${T.reset}`, ''],
      }))
      console.log()
      return true
    }

    // Default: overview of all layers
    const L = data.layers
    const BAR_W  = 18
    function miniBar(n: number, max: number): string {
      const filled = max > 0 ? Math.round((n / max) * BAR_W) : 0
      return fg(COLORS.orange) + '█'.repeat(filled) + T.dim + '░'.repeat(BAR_W - filled) + RST
    }
    const vals = Object.values(L).filter(v => typeof v === 'number') as number[]
    const maxV = vals.length ? Math.max(...vals, 1) : 1

    const rows = [
      ['HOT cache',    L.hot      ?? 0],
      ['WARM cache',   L.warm     ?? 0],
      ['COLD store',   L.cold     ?? 0],
      ['Semantic',     L.semantic ?? 0],
      ['Entities',     L.entities ?? 0],
      ['Graph edges',  L.edges    ?? 0],
      ['Learning',     L.learning ?? 0],
      ['Facts',        L.facts    ?? 0],
      ['History',      L.history  ?? 0],
    ] as [string, number][]

    const lines = rows.map(([label, n]) =>
      `  ${label.padEnd(14)}${miniBar(n, maxV)}  ${T.dim}${n}${T.reset}`
    )
    console.log(panel({
      title: `${MARKS.TRI} /garden — memory overview`,
      lines: ['', ...lines, '', `  ${T.dim}Drill: /garden semantic · entities · learning · facts${T.reset}`, ''],
    }))
    console.log()
    return true
  }

  // ── /decision ─────────────────────────────────────────────────────────────────
  if (command === '/decision') {
    const sub = parts[1]?.toLowerCase()

    interface DecisionEntry {
      ts:        number
      sessionId: string
      action:    string
      reasoning: string
      outcome:   string
    }

    // /decision clear — wipe the log
    if (sub === 'clear') {
      const r = await apiDelete('/api/decisions')
      if (r?.ok) {
        console.log(`  ${fg(COLORS.success)}✓${RST}  Decision log cleared.\n`)
      } else {
        console.log(`  ${T.error}Failed to clear log.${T.reset}\n`)
      }
      return true
    }

    // /decision last — show only the most recent
    const limit = sub === 'last' ? 1 : parseInt(parts[1] ?? '', 10) || 10
    const data  = await apiFetch<{ decisions: DecisionEntry[] }>(`/api/decisions?limit=${limit}`, { decisions: [] })
    const list  = data.decisions ?? []

    console.log()
    if (list.length === 0) {
      console.log(panel({
        title: `${MARKS.TRI} /decision — no trace`,
        lines: [
          '',
          `  ${T.dim}No reasoning steps logged yet.${T.reset}`,
          `  ${T.dim}Steps are recorded when Aiden uses tools.${T.reset}`,
          '',
        ],
      }))
      console.log()
      return true
    }

    const lines: string[] = ['']
    for (const d of list) {
      const ago = `${Math.round((Date.now() - d.ts) / 60000)}m ago`
      lines.push(`  ${fg(COLORS.orange)}${MARKS.ARROW}${RST} ${T.bold}${d.action}${T.reset}  ${T.dim}${ago}${T.reset}`)
      if (d.reasoning) {
        const trimmed = d.reasoning.substring(0, 100)
        lines.push(`    ${T.dim}${trimmed}${d.reasoning.length > 100 ? '…' : ''}${T.reset}`)
      }
      if (d.outcome) {
        lines.push(`    ${fg(COLORS.success)}→${RST} ${T.dim}${d.outcome.substring(0, 80)}${T.reset}`)
      }
      lines.push('')
    }
    lines.push(`  ${T.dim}/decision <N> for more  ·  /decision clear to wipe${T.reset}`)
    lines.push('')

    console.log(panel({
      title: `${MARKS.TRI} /decision  (${list.length} step${list.length !== 1 ? 's' : ''})`,
      lines,
    }))
    console.log()
    return true
  }

  // ── /log ─────────────────────────────────────────────────────────────────────
  if (command === '/log') {
    interface LogEntry { timestamp: string; level: string; source: string; message: string }
    // parse args: /log [N] [level]
    let n     = 30
    let lvl   = ''
    for (const arg of parts.slice(1)) {
      const num = parseInt(arg, 10)
      if (!isNaN(num)) n = Math.min(num, 200)
      else lvl = arg.toLowerCase()
    }
    const entries = await apiFetch<LogEntry[]>(`/api/debug/logs?n=${n}`, [])
    const filtered = lvl
      ? entries.filter(e => e.level === lvl || e.source.toLowerCase().includes(lvl))
      : entries
    const LEVEL_C: Record<string, string> = {
      error: fg(COLORS.red),
      warn:  fg(COLORS.warning),
      info:  fg(COLORS.white),
      debug: T.dim,
    }
    console.log()
    if (filtered.length === 0) {
      console.log(`  ${T.dim}No log entries${lvl ? ` matching "${lvl}"` : ''}.${T.reset}\n`)
      return true
    }
    const lines = filtered.slice(-n).map(e => {
      const lc  = LEVEL_C[e.level] ?? T.dim
      const ts  = e.timestamp.slice(11, 19)
      return `  ${T.dim}${ts}${T.reset} ${lc}${e.level.padEnd(5)}${RST} ${fg(COLORS.cyan)}${e.source.padEnd(10)}${RST} ${e.message.substring(0, 100)}`
    })
    console.log(panel({
      title: `${MARKS.TRI} /log  (${filtered.length} entries${lvl ? ` · ${lvl}` : ''})`,
      lines: ['', ...lines, ''],
    }))
    console.log()
    return true
  }

  // ── /save ─────────────────────────────────────────────────────────────────────
  if (command === '/save') {
    const filename = parts[1]
      ? parts.slice(1).join('_').replace(/[^a-zA-Z0-9._-]/g, '_')
      : `session_${SESSION_ID.slice(0, 12)}_${new Date().toISOString().slice(0, 10)}.md`
    const exportsDir = path.join(__dirname, '..', 'workspace', 'exports')
    try {
      fs.mkdirSync(exportsDir, { recursive: true })
      const outPath = path.join(exportsDir, filename.endsWith('.md') ? filename : filename + '.md')
      const label   = state.sessionName ? `**Session:** ${state.sessionName}\n` : ''
      const header  = `# Aiden Conversation Export\n${label}**ID:** ${SESSION_ID}\n**Date:** ${new Date().toISOString().slice(0, 10)}\n\n---\n\n`
      const body    = state.history.map(h =>
        `**${h.role === 'user' ? 'You' : 'Aiden'}:** ${h.content}\n`
      ).join('\n')
      fs.writeFileSync(outPath, header + body, 'utf-8')
      console.log(`  ${fg(COLORS.success)}✓${RST}  Saved to ${T.dim}workspace/exports/${path.basename(outPath)}${T.reset}\n`)
    } catch (e: any) {
      console.log(`  ${T.error}Save failed: ${e.message}${T.reset}\n`)
    }
    return true
  }

  // ── /rerun ────────────────────────────────────────────────────────────────────
  if (command === '/rerun') {
    const lastUser = [...state.history].reverse().find(h => h.role === 'user')
    if (!lastUser) {
      console.log(`  ${T.dim}Nothing to rerun — no previous user message.${T.reset}\n`)
      return true
    }
    console.log(`  ${T.dim}Rerunning: ${lastUser.content.substring(0, 80)}…${T.reset}\n`)
    await streamChat(lastUser.content)
    return true
  }

  // ── /name ─────────────────────────────────────────────────────────────────────
  if (command === '/name') {
    const label = parts.slice(1).join(' ').trim()
    if (!label) {
      const current = state.sessionName || T.dim + '(unnamed)' + T.reset
      console.log(`  ${T.dim}Current name:${T.reset} ${current}\n  ${T.dim}Usage: /name <label>${T.reset}\n`)
      return true
    }
    const r = await apiPost(`/api/sessions/${SESSION_ID}/name`, { name: label })
    if (r?.ok) {
      state.sessionName = label
      console.log(`  ${fg(COLORS.success)}✓${RST}  Session named: ${fg(COLORS.orange)}${label}${RST}\n`)
    } else {
      // Store locally even if server is unavailable
      state.sessionName = label
      console.log(`  ${fg(COLORS.gold)}~${RST}  Stored locally: ${fg(COLORS.orange)}${label}${RST}\n`)
    }
    return true
  }

  // ── /stack ────────────────────────────────────────────────────────────────────
  if (command === '/stack') {
    interface AsyncTask { id: string; prompt: string; status: string; createdAt?: number }
    const tasks = await apiFetch<AsyncTask[]>('/api/async', [])
    console.log()
    if (!tasks || tasks.length === 0) {
      console.log(panel({
        title: `${MARKS.TRI} /stack — idle`,
        lines: ['', `  ${T.dim}No active async tasks.${T.reset}`, ''],
      }))
      console.log()
      return true
    }
    const STATUS_C: Record<string, string> = {
      running:  fg(COLORS.orange),
      done:     fg(COLORS.success),
      error:    fg(COLORS.red),
      pending:  T.dim,
    }
    const rows = tasks.map(t => {
      const sc    = STATUS_C[t.status] ?? T.dim
      const label = (t.prompt || '').substring(0, 55)
      const age   = t.createdAt ? `${Math.round((Date.now() - t.createdAt) / 1000)}s` : '—'
      return `  ${sc}${t.status.padEnd(10)}${RST}${T.dim}${t.id.slice(0, 8)}${T.reset}  ${label}  ${T.dim}${age}${T.reset}`
    })
    console.log(panel({
      title: `${MARKS.TRI} /stack  (${tasks.length} task${tasks.length !== 1 ? 's' : ''})`,
      lines: ['', ...rows, ''],
    }))
    console.log()
    return true
  }

  // ── /halt ─────────────────────────────────────────────────────────────────────
  if (command === '/halt') {
    if (state.streaming) {
      state.abortCtrl?.abort()
      state.streaming = false
    }
    await apiPost('/api/stop', {})
    console.log(`  ${fg(COLORS.red)}⏹${RST}  All execution halted.\n`)
    return true
  }

  // ── /yolo ─────────────────────────────────────────────────────────────────────
  if (command === '/yolo') {
    state.yoloMode = !state.yoloMode
    const icon  = state.yoloMode ? fg(COLORS.gold) + '⚡' + RST : fg(COLORS.success) + '✓' + RST
    const label = state.yoloMode
      ? `${fg(COLORS.gold)}YOLO mode ON${RST}  — all tool calls auto-approved`
      : `${fg(COLORS.success)}YOLO mode OFF${RST} — tool trust levels restored`
    console.log(`  ${icon}  ${label}\n`)
    return true
  }

  // ── /attach ───────────────────────────────────────────────────────────────────
  if (command === '/attach') {
    const sub = parts[1]?.toLowerCase()

    // /attach clear — remove all pending attachments
    if (sub === 'clear' || sub === 'none') {
      state.attachments = []
      console.log(`  ${fg(COLORS.success)}✓${RST}  Attachments cleared.\n`)
      return true
    }

    // /attach list — show pending attachments
    if (sub === 'list' || !parts[1]) {
      if (state.attachments.length === 0) {
        console.log(`  ${T.dim}No pending attachments. Use /attach <path>${T.reset}\n`)
      } else {
        const rows = state.attachments.map(p => `  ${fg(COLORS.orange)}${MARKS.ARROW}${RST} ${p}`)
        console.log(panel({
          title: `${MARKS.TRI} /attach  (${state.attachments.length} pending)`,
          lines: ['', ...rows, '', `  ${T.dim}/attach clear to remove all${T.reset}`, ''],
        }))
        console.log()
      }
      return true
    }

    // /attach <path> — add file
    const filePath = parts.slice(1).join(' ')
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath)
    if (!fs.existsSync(resolved)) {
      console.log(`  ${T.error}File not found: ${resolved}${T.reset}\n`); return true
    }
    state.attachments.push(resolved)
    const stat = fs.statSync(resolved)
    const kb   = Math.round(stat.size / 1024)
    console.log(`  ${fg(COLORS.success)}✓${RST}  Attached ${T.dim}${path.basename(resolved)}${T.reset} ${T.dim}(${kb}KB · ${state.attachments.length} pending)${T.reset}\n`)
    return true
  }

  // ── /changelog ────────────────────────────────────────────────────────────────
  if (command === '/changelog') {
    const n = parseInt(parts[1] ?? '', 10) || 20
    interface ChangelogEntry { hash: string; msg: string; date: string }
    const data = await apiFetch<{ entries: ChangelogEntry[] }>(`/api/changelog?n=${n}`, { entries: [] })
    const entries = data.entries ?? []
    console.log()
    if (entries.length === 0) {
      console.log(panel({
        title: `${MARKS.TRI} /changelog — none`,
        lines: ['', `  ${T.dim}No commits found.${T.reset}`, ''],
      }))
    } else {
      const rows = entries.map(e =>
        `  ${fg(COLORS.gold)}${e.hash.padEnd(9)}${RST}${T.dim}${e.date}${T.reset}  ${e.msg.substring(0, 70)}`
      )
      console.log(panel({
        title: `${MARKS.TRI} /changelog  (${entries.length} entries)`,
        lines: ['', ...rows, ''],
      }))
    }
    console.log()
    return true
  }

  // ── /recipes ───────────────────────────────────────────────────────────────────
  if (command === '/recipes') {
    const r       = await apiFetch<any>('/api/recipes', [])
    const recipes = Array.isArray(r) ? r : (r.recipes || [])
    if (recipes.length === 0) {
      console.log(`  ${T.dim}No recipes.${T.reset}\n`)
    } else {
      console.log(`\n  ${T.bold}Recipes${T.reset}`)
      console.log(`  ${T.dim}${hr()}${T.reset}`)
      for (const rec of recipes) {
        console.log(`  ${T.accent}▸${T.reset} ${rec.name || rec.id}  ${T.dim}${(rec.description || '').substring(0, 60)}${T.reset}`)
      }
      console.log()
    }
    return true
  }

  // ── /sessions ──────────────────────────────────────────────────────────────────
  if (command === '/sessions') {
    const sessions = await apiFetch<any[]>('/api/sessions', [])
    console.log(`\n  ${T.bold}Sessions (${sessions.length})${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    for (const s of sessions.slice(0, 10)) {
      const ts  = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—'
      const pre = (s.preview || s.title || s.id || '').substring(0, 50)
      console.log(`  ${T.dim}${ts}${T.reset}  ${pre}`)
    }
    if (sessions.length > 10) console.log(`  ${T.dim}…and ${sessions.length - 10} more${T.reset}`)
    console.log()
    return true
  }

  // ── /analytics ─────────────────────────────────────────────────────────────────
  if (command === '/analytics') {
    const [usage, sessions, mem] = await Promise.all([
      apiFetch<any>('/api/usage',     {}),
      apiFetch<any[]>('/api/sessions', []),
      apiFetch<any>('/api/memories',  {}),
    ])

    const totalSessions = sessions.length       || usage.sessions      || 0
    const totalMessages = usage.messages        || usage.totalMessages  || 0
    const toolCalls     = usage.toolCalls       || 0
    const userMsgs      = usage.userMessages    || Math.round(totalMessages / 2) || 0
    const inTok         = usage.inputTokens     || 0
    const outTok        = usage.outputTokens    || 0
    const totTok        = inTok + outTok        || usage.totalTokens   || 0
    const cost          = usage.cost            || usage.totalCost     || (totTok / 1_000_000 * 0.10)
    const activeTime    = usage.activeTimeMs    ? fmtDuration(usage.activeTimeMs)  : '—'
    const avgSession    = usage.avgSessionMs    ? fmtDuration(usage.avgSessionMs)  : '—'
    const models: any[] = usage.models          || usage.modelBreakdown || []
    const tools: any[]  = usage.tools           || usage.topTools       || []
    const activity: any = usage.activity        || usage.daily          || {}
    const ctxC          = ctxColor(state.ctxPercent)

    const LINE = `  ${T.dim}${hr()}${T.reset}`

    console.log()
    console.log(`  ${T.bold}Aiden Analytics · Last 30 days${T.reset}`)
    console.log(LINE)
    console.log()
    console.log(`  ${T.bold}Overview${T.reset}`)
    console.log(LINE)

    const row = (a: string, av: string, b: string, bv: string): void => {
      console.log(`  ${a.padEnd(18)}${av.padEnd(16)}${b.padEnd(18)}${bv}`)
    }
    row('Sessions',      String(totalSessions), 'Messages',      String(totalMessages))
    row('Tool calls',    String(toolCalls),      'User msgs',     String(userMsgs))
    row('Input tokens',  num(inTok),             'Output tokens', num(outTok))
    row('Total tokens',  num(totTok),            'Est. cost',     `$${typeof cost === 'number' ? cost.toFixed(2) : cost}`)
    row('Active time',   activeTime,             'Avg session',   avgSession)

    console.log()
    console.log(`  ${T.bold}This Session${T.reset}`)
    console.log(LINE)
    console.log(`  ${'Context'.padEnd(18)}${ctxC}${ctxBar(state.ctxPercent)}${T.reset}`)
    console.log(`  ${'Turns'.padEnd(18)}${state.turnCount}/${MAX_TURNS}`)

    if (models.length > 0) {
      console.log()
      console.log(`  ${T.bold}Models Used${T.reset}`)
      console.log(LINE)
      console.log(`  ${'Model'.padEnd(28)}${'Sessions'.padEnd(12)}${'Tokens'.padEnd(14)}Cost`)
      for (const m of models) {
        const mname = (m.model || m.name || '').padEnd(28)
        const msess = String(m.sessions || 0).padEnd(12)
        const mtok  = num(m.tokens || 0).padEnd(14)
        const mcost = `$${(m.cost || 0).toFixed(2)}`
        console.log(`  ${T.dim}${mname}${msess}${mtok}${mcost}${T.reset}`)
      }
    }

    if (tools.length > 0) {
      console.log()
      console.log(`  ${T.bold}Top Tools${T.reset}`)
      console.log(LINE)
      console.log(`  ${'Tool'.padEnd(24)}${'Calls'.padEnd(10)}%`)
      for (const t of tools.slice(0, 10)) {
        const pct    = toolCalls > 0 ? Math.round((t.calls || 0) / toolCalls * 100) : (t.pct || 0)
        const tname  = (t.name || t.tool || '').padEnd(24)
        const tcalls = String(t.calls || 0).padEnd(10)
        console.log(`  ${T.dim}${tname}${tcalls}${pct}%${T.reset}`)
      }
    }

    // Activity bar chart
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const dayData: Record<string, number> = {}
    if (typeof activity === 'object' && !Array.isArray(activity)) {
      for (const [k, v] of Object.entries(activity)) {
        dayData[k] = Number(v) || 0
      }
    }

    if (Object.keys(dayData).length > 0) {
      console.log()
      console.log(`  ${T.bold}Activity${T.reset}`)
      console.log(LINE)
      const maxVal = Math.max(...days.map(d => dayData[d.toLowerCase()] || dayData[d] || 0), 1)
      for (const day of days) {
        const val  = dayData[day.toLowerCase()] || dayData[day] || 0
        const bars = Math.round((val / maxVal) * 10)
        const bar  = '▮'.repeat(bars)
        console.log(`  ${T.dim}${day}  ${T.reset}${T.accent}${bar.padEnd(10)}${T.reset}  ${T.dim}${val}${T.reset}`)
      }
    }

    if (mem && typeof mem === 'object') {
      const total = Array.isArray(mem) ? mem.length : (mem.total || 0)
      if (total > 0) console.log(`\n  ${T.dim}Memory: ${num(total)} total · ${num(mem.semantic || 0)} semantic · ${num(mem.entities || 0)} entities${T.reset}`)
    }

    console.log()
    return true
  }

  // ── /budget ────────────────────────────────────────────────────────────────────
  if (command === '/budget') {
    const totChars  = state.history.reduce((n, h) => n + h.content.length, 0)
    const approxTok = Math.round(totChars / 4)
    const ctxC      = ctxColor(state.ctxPercent)
    console.log()
    console.log(`  ${T.bold}Token Budget (session estimate)${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Context used'.padEnd(18)}~${num(approxTok)} tokens`)
    console.log(`  ${'Context bar'.padEnd(18)}${ctxC}${ctxBar(state.ctxPercent)}${T.reset}`)
    console.log(`  ${'Turns'.padEnd(18)}${state.turnCount}/${MAX_TURNS}`)
    console.log(`  ${'Session'.padEnd(18)}${T.dim}${SESSION_ID}${T.reset}`)
    console.log()
    return true
  }

  // ── /workspace ─────────────────────────────────────────────────────────────────
  if (command === '/workspace') {
    const ws   = await apiFetch<any>('/api/workspaces', {})
    const list = Array.isArray(ws) ? ws : (ws.workspaces || [])
    if (list.length === 0) {
      console.log(`  ${T.dim}No workspaces.${T.reset}\n`)
    } else {
      console.log(`\n  ${T.bold}Workspaces${T.reset}`)
      console.log(`  ${T.dim}${hr()}${T.reset}`)
      for (const w2 of list) {
        const active = w2.active ? ` ${T.primary}[active]${T.reset}` : ''
        console.log(`  ${T.accent}▸${T.reset} ${w2.name || w2.id}${active}  ${T.dim}${w2.path || ''}${T.reset}`)
      }
      console.log()
    }
    return true
  }

  // ── /quick <question> ─────────────────────────────────────────────────────────
  if (command === '/quick') {
    const question = parts.slice(1).join(' ')
    if (!question) { console.log(`  ${T.dim}Usage: /quick <question>${T.reset}\n`); return true }
    process.stdout.write(`  ${T.dim}◆${T.reset}  `)
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body   : JSON.stringify({ message: question, mode: 'auto', history: [] }),
        signal : AbortSignal.timeout(30000),
      })
      if (!res.ok) { console.log(`\n  ${T.error}✗ ${res.status}${T.reset}\n`); return true }
      const isSSE = (res.headers.get('content-type') || '').includes('text/event-stream')
      if (!isSSE) {
        const data = await res.json() as any
        process.stdout.write((data.reply || data.message || data.content || '') + '\n\n')
      } else {
        const reader  = (res.body as any).getReader()
        const decoder = new TextDecoder()
        let   buf     = ''
        let   done2   = false
        while (!done2) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n'); buf = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') { done2 = true; break }
            let evt: any; try { evt = JSON.parse(raw) } catch { continue }
            if (evt.token) process.stdout.write(evt.token)
            if (evt.done)  { done2 = true; break }
          }
        }
        process.stdout.write('\n\n')
      }
    } catch (err: any) {
      console.log(`\n  ${T.error}✗ ${err?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /compact ───────────────────────────────────────────────────────────────────
  if (command === '/compact') {
    console.log(`  ${T.dim}Compressing context…${T.reset}`)
    const res = await apiPost('/api/context/compact', { sessionId: SESSION_ID })
    if (res && !res.error) {
      console.log(`  ${T.success}✓ Context compressed${T.reset}\n`)
    } else if (state.history.length > 10) {
      state.history = state.history.slice(-10)
      console.log(`  ${T.success}✓ Trimmed to last 5 turns${T.reset}\n`)
    } else {
      console.log(`  ${T.dim}Nothing to compact.${T.reset}\n`)
    }
    return true
  }

  // ── /async [list | view <id> | <task prompt>] ─────────────────────────────────
  if (command === '/async') {
    const sub  = parts[1]
    const divW = cols() - 4

    // /async list — show all background tasks
    if (sub === 'list') {
      const tasks = await apiFetch<any[]>('/api/async', [])
      if (!tasks || tasks.length === 0) {
        console.log(`  ${T.dim}No async tasks yet.${T.reset}\n`)
      } else {
        console.log()
        for (const t of tasks) {
          const dot = t.status === 'complete' ? `${T.success}●${T.reset}` :
                      t.status === 'failed'   ? `${T.error}●${T.reset}`   :
                                                `${T.accent}◌${T.reset}`
          const elapsed = t.elapsed ? ` ${T.dim}(${fmtDuration(t.elapsed)})${T.reset}` : ''
          console.log(`  ${dot} ${t.id}${elapsed}  ${T.dim}${(t.prompt || '').slice(0, 50)}${T.reset}`)
        }
        console.log()
      }
      return true
    }

    // /async view <id> — fetch and display full result
    if (sub === 'view') {
      const taskId = parts[2]
      if (!taskId) { console.log(`  ${T.dim}Usage: /async view <id>${T.reset}\n`); return true }
      const t = await apiFetch<any>(`/api/async/${taskId}`, {})
      if (!t || t.error === 'Task not found') {
        console.log(`  ${T.error}✗ Task not found: ${taskId}${T.reset}\n`); return true
      }
      const elapsed  = t.elapsed ? ` (${fmtDuration(t.elapsed)})` : ''
      const statusDot = t.status === 'complete' ? `${T.success}●${T.reset}` :
                        t.status === 'failed'   ? `${T.error}●${T.reset}`   :
                                                  `${T.accent}◌${T.reset}`
      console.log()
      console.log(`  ${T.dim}${'─'.repeat(divW)}${T.reset}`)
      console.log(`  ${statusDot} async ${taskId}${T.dim}${elapsed}${T.reset}`)
      console.log(`  ${T.dim}${'─'.repeat(divW)}${T.reset}`)
      if (t.status === 'running') {
        console.log(`  ${T.dim}Still running…${T.reset}`)
      } else if (t.status === 'failed') {
        console.log(`  ${T.error}✗ ${t.error || 'Unknown error'}${T.reset}`)
      } else {
        const reply = (t.result || '').trim()
        process.stdout.write('  ')
        let linePos = 0
        const avail = cols() - 5
        for (const ch of reply) {
          if (ch === '\n') { process.stdout.write('\n  '); linePos = 0 }
          else {
            if (linePos >= avail) { process.stdout.write('\n  '); linePos = 0 }
            process.stdout.write(ch); linePos++
          }
        }
        process.stdout.write('\n')
      }
      console.log(`  ${T.dim}${'─'.repeat(divW)}${T.reset}`)
      console.log()
      return true
    }

    // /async <task prompt> — spawn a new background task
    const task = parts.slice(1).join(' ')
    if (!task) {
      console.log(`  ${T.dim}Usage: /async <task>  |  /async list  |  /async view <id>${T.reset}\n`)
      return true
    }
    const res    = await apiPost('/api/async', { prompt: task })
    const taskId = res?.taskId || res?.id || String(Date.now()).slice(-4)
    console.log()
    console.log(`  ${T.dim}${'─'.repeat(divW)}${T.reset}`)
    console.log(`  ${T.accent}◆${T.reset} async #${taskId}  ${T.dim}${task.substring(0, divW - String(taskId).length - 16)}${T.reset}`)
    console.log(`  ${T.dim}${'─'.repeat(divW)}${T.reset}`)
    console.log(`  ${T.dim}Running in background · /async view ${taskId}${T.reset}`)
    console.log()
    return true
  }

  // ── /security ──────────────────────────────────────────────────────────────────
  if (command === '/security') {
    console.log(`  ${T.dim}Running security scan…${T.reset}`)
    const scan    = await apiFetch<any>('/api/security/scan', {})
    const threats = scan.threats || scan.issues || []
    if (threats.length === 0) {
      console.log(`  ${T.success}✓ No threats detected${T.reset}\n`)
    } else {
      console.log(`  ${T.error}✗ ${threats.length} issue(s) found:${T.reset}`)
      for (const t of threats) console.log(`    ${T.warning}◆${T.reset} ${t.message || JSON.stringify(t)}`)
      console.log()
    }
    return true
  }

  // ── /debug ─────────────────────────────────────────────────────────────────────
  if (command === '/debug') {
    const logs  = await apiFetch<any>('/api/debug/logs', { logs: [] })
    const lines = Array.isArray(logs) ? logs : (logs.logs || [])
    console.log(`\n  ${T.bold}Debug logs (last 20)${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    for (const l of lines.slice(-20)) console.log(`  ${T.dim}${l}${T.reset}`)
    console.log()
    return true
  }

  // ── /private ───────────────────────────────────────────────────────────────────
  if (command === '/private') {
    try {
      const result = await apiPost('/api/private', { sessionId: SESSION_ID })
      state.privateMode = result.private === true
      if (state.privateMode) {
        console.log(`\n  ${T.warning}🔒 Private mode ON${T.reset} — memory writes suppressed for this session.\n`)
      } else {
        console.log(`\n  ${T.success}🔓 Private mode OFF${T.reset} — memory writes resumed.\n`)
      }
      rl.setPrompt(getPrompt())
    } catch {
      console.log(`  ${T.error}Could not toggle private mode — server unavailable.${T.reset}\n`)
    }
    return true
  }

  // ── /config ────────────────────────────────────────────────────────────────────
  if (command === '/config') {
    const cfg = loadCfg()
    const h   = await apiFetch<any>('/api/health', {})
    console.log()
    console.log(`  ${T.bold}Aiden Configuration${T.reset}`)
    console.log(`  ${T.dim}${hr()}${T.reset}`)
    console.log(`  ${'Model'.padEnd(16)}${T.accent}${cfg?.model?.activeModel || 'unknown'}${T.reset}`)
    console.log(`  ${'Provider'.padEnd(16)}${cfg?.model?.active || 'unknown'}`)
    console.log(`  ${'Workspace'.padEnd(16)}${T.dim}${cfg?.workspace?.path || process.cwd()}${T.reset}`)
    console.log(`  ${'Theme'.padEnd(16)}${state.themeName}`)
    console.log(`  ${'Persona'.padEnd(16)}${state.persona}`)
    console.log(`  ${'Detail'.padEnd(16)}${state.detailLevel}`)
    console.log(`  ${'Depth'.padEnd(16)}${state.depthLevel}`)
    console.log(`  ${'Session'.padEnd(16)}${T.dim}${SESSION_ID}${T.reset}`)
    console.log(`  ${'Started'.padEnd(16)}${T.dim}${new Date(SESSION_START).toLocaleString()}${T.reset}`)
    console.log(`  ${'Config file'.padEnd(16)}${T.dim}${CONFIG_PATH}${T.reset}`)
    if (h.version) console.log(`  ${'Version'.padEnd(16)}${h.version}`)
    console.log()
    return true
  }

  // ── /theme <name> ──────────────────────────────────────────────────────────────
  if (command === '/theme') {
    const name = (parts[1] || '') as ThemeName
    if (!name || !THEMES[name]) {
      console.log(`  ${T.dim}Usage: /theme <default|mono|slate|ember>${T.reset}\n`)
      return true
    }
    applyTheme(name)
    state.themeName = name
    rl.setPrompt(getPrompt())
    const cfg = loadCfg()
    if (!cfg.cli) cfg.cli = {}
    cfg.cli.theme = name
    saveCfg(cfg)
    console.log(`  ${T.success}✓ Theme: ${name}${T.reset}\n`)
    return true
  }

  // ── /persona <name> ────────────────────────────────────────────────────────────
  if (command === '/persona') {
    const name = parts[1] || 'default'
    state.persona = name
    console.log(`  ${T.success}✓ Persona: ${name}${T.reset}\n`)
    return true
  }

  // ── /detail ────────────────────────────────────────────────────────────────────
  if (command === '/detail') {
    const levels: Array<'off' | 'tools' | 'verbose'> = ['off', 'tools', 'verbose']
    state.detailLevel = levels[(levels.indexOf(state.detailLevel) + 1) % levels.length]
    console.log(`  ${T.success}✓ Detail: ${state.detailLevel}${T.reset}\n`)
    return true
  }

  // ── /depth ─────────────────────────────────────────────────────────────────────
  if (command === '/depth') {
    const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high']
    state.depthLevel = levels[(levels.indexOf(state.depthLevel) + 1) % levels.length]
    console.log(`  ${T.success}✓ Depth: ${state.depthLevel}${T.reset}\n`)
    return true
  }

  // ── /provider [sub] ────────────────────────────────────────────────────────────
  if (command === '/provider') {
    const sub = parts[1]

    // Known named-provider registry (type → default model + base URL for tests)
    const PROVIDER_INFO: Record<string, { defaultModel: string; baseUrl: string }> = {
      groq:       { defaultModel: 'llama-3.3-70b-versatile',                        baseUrl: 'https://api.groq.com/openai/v1' },
      gemini:     { defaultModel: 'gemini-2.0-flash',                               baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      openrouter: { defaultModel: 'openrouter/free',                                baseUrl: 'https://openrouter.ai/api/v1' },
      boa:        { defaultModel: 'gpt-4o-mini',                                    baseUrl: 'https://api.bayofassets.com/v1' },
      cerebras:   { defaultModel: 'llama3.1-8b',                                    baseUrl: 'https://api.cerebras.ai/v1' },
      mistral:    { defaultModel: 'mistral-large-latest',                           baseUrl: 'https://api.mistral.ai/v1' },
      openai:     { defaultModel: 'gpt-4o-mini',                                    baseUrl: 'https://api.openai.com/v1' },
      together:   { defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',   baseUrl: 'https://api.together.xyz/v1' },
      deepseek:   { defaultModel: 'deepseek-chat',                                  baseUrl: 'https://api.deepseek.com/v1' },
      nvidia:     { defaultModel: 'meta/llama-3.3-70b-instruct',                   baseUrl: 'https://integrate.api.nvidia.com/v1' },
      anthropic:  { defaultModel: 'claude-3-5-haiku-20241022',                     baseUrl: 'https://api.anthropic.com/v1' },
    }

    // ── /provider  /  /provider list ───────────────────────────────────────────
    if (!sub || sub === 'list') {
      const cfg    = loadCfg()
      const active = cfg?.model?.active || ''
      const apis   = (cfg?.providers?.apis || []) as any[]
      const custom = (cfg?.customProviders   || []) as any[]
      console.log()
      console.log(`  ${T.bold}Providers${T.reset}`)
      console.log(`  ${T.dim}${hr()}${T.reset}`)
      for (const a of apis) {
        const rawKey  = a.key || ''
        const hasKey  = rawKey.startsWith('env:')
          ? !!(process.env[rawKey.replace('env:', '')])
          : rawKey.length > 0
        const isActive = a.name === active
        const dot  = isActive ? `${T.success}●` : (a.enabled && hasKey ? `${T.reset}○` : `${T.error}○`)
        const rl   = a.rateLimited ? ` ${T.warning}[rl]${T.reset}` : ''
        const tag  = isActive    ? ` ${T.success}✓ active${T.reset}`
                   : hasKey      ? ` ${T.dim}✓ configured${T.reset}`
                   :               ` ${T.error}✗ no key${T.reset}`
        console.log(`  ${dot}${T.reset} ${(a.name || '').padEnd(18)}${T.dim}${(a.model || '').padEnd(30)}${T.reset}${tag}${rl}`)
      }
      if (custom.length > 0) {
        console.log(`\n  ${T.dim}Custom (OpenAI-compatible)${T.reset}`)
        for (const cp of custom) {
          const isActive = cp.id === active
          const dot = isActive ? `${T.success}●` : `${T.reset}○`
          const tag = isActive ? ` ${T.success}✓ active${T.reset}` : ` ${T.dim}✓ configured${T.reset}`
          console.log(`  ${dot}${T.reset} ${(cp.id || '').padEnd(18)}${T.dim}${(cp.displayName || cp.id).padEnd(30)}${T.reset}${tag}`)
        }
      }
      console.log(`\n  ${T.dim}Active: ${active || 'none'}  ·  /provider add <type> <key>  ·  /provider test <id>${T.reset}`)
      console.log()
      return true
    }

    // ── /provider add <type> <key> — inline non-interactive add ────────────────
    if (sub === 'add' && parts.length >= 4) {
      const provType = parts[2].toLowerCase()
      const apiKey   = parts[3]
      if (!PROVIDER_INFO[provType]) {
        const known = Object.keys(PROVIDER_INFO).join(', ')
        console.log(`  ${T.error}✗ Unknown provider type "${provType}".${T.reset}`)
        console.log(`  ${T.dim}Known types: ${known}${T.reset}`)
        console.log(`  ${T.dim}For a custom URL: /provider add-custom <name> <baseUrl> <key>${T.reset}\n`)
        return true
      }
      const cfg = loadCfg()
      if (!cfg.providers)      cfg.providers      = { ollama: { enabled: true, models: [] }, apis: [] }
      if (!cfg.providers.apis) cfg.providers.apis = []
      const existing = (cfg.providers.apis as any[]).filter((a: any) => a.provider === provType)
      const slotNum  = existing.length + 1
      const slotName = `${provType}-${slotNum}`
      if ((cfg.providers.apis as any[]).find((a: any) => a.name === slotName)) {
        console.log(`  ${T.error}✗ ${slotName} already exists. Use /provider remove ${slotName} first.${T.reset}\n`)
        return true
      }
      ;(cfg.providers.apis as any[]).push({
        name:        slotName,
        provider:    provType,
        key:         apiKey,
        model:       PROVIDER_INFO[provType].defaultModel,
        enabled:     true,
        rateLimited: false,
        usageCount:  0,
      })
      saveCfg(cfg)
      console.log(`  ${T.success}✓ Added ${slotName} (${provType}). /switch ${slotName} to activate.${T.reset}\n`)
      return true
    }

    // ── /provider add-custom <name> <baseUrl> [key] ────────────────────────────
    if (sub === 'add-custom') {
      const cName   = parts[2]
      const baseUrl = parts[3]
      const apiKey  = parts[4] || ''
      if (!cName || !baseUrl) {
        console.log(`  ${T.dim}Usage: /provider add-custom <name> <baseUrl> [key]${T.reset}\n`)
        return true
      }
      // Validate by calling /models on the endpoint
      process.stdout.write(`  ${T.dim}Validating ${baseUrl}/models...${T.reset}`)
      let modelCount = 0
      try {
        const hdrs: Record<string, string> = {}
        if (apiKey) hdrs['Authorization'] = `Bearer ${apiKey}`
        const r = await fetch(`${baseUrl}/models`, { headers: hdrs })
        if (r.ok) {
          const d = await r.json() as any
          modelCount = ((d.data || d.models || []) as any[]).length
        }
      } catch { /* validation is best-effort */ }
      process.stdout.write('\r\x1b[K')
      const cfg = loadCfg()
      if (!cfg.customProviders) cfg.customProviders = []
      if ((cfg.customProviders as any[]).find((c: any) => c.id === cName)) {
        console.log(`  ${T.error}✗ "${cName}" already exists. Use /provider remove ${cName} first.${T.reset}\n`)
        return true
      }
      ;(cfg.customProviders as any[]).push({
        id: cName, displayName: cName, baseUrl, apiKey,
        model: 'gpt-4o-mini', enabled: true, tier: 3,
      })
      saveCfg(cfg)
      const modStr = modelCount > 0 ? ` (${modelCount} models)` : ''
      console.log(`  ${T.success}✓ Added ${cName} (custom)${modStr}. /switch ${cName} to activate.${T.reset}\n`)
      return true
    }

    // ── /provider add — interactive wizard (no inline args) ────────────────────
    if (sub === 'add') {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout })
      const ask = (q: string) => new Promise<string>(res => rl2.question(`  ${T.dim}${q}${T.reset} `, res))
      try {
        const known = Object.keys(PROVIDER_INFO).join(' | ')
        console.log(`\n  ${T.bold}Add Provider${T.reset}`)
        console.log(`  ${T.dim}Named: ${known}${T.reset}`)
        console.log(`  ${T.dim}Custom: any OpenAI-compatible endpoint${T.reset}\n`)
        const provType = (await ask('Provider type (or "custom"):')).toLowerCase().trim()
        if (PROVIDER_INFO[provType]) {
          const apiKey = (await ask('API key:')).trim()
          rl2.close()
          if (!apiKey) { console.log(`  ${T.error}✗ API key is required.${T.reset}\n`); return true }
          const cfg      = loadCfg()
          if (!cfg.providers?.apis) { cfg.providers = cfg.providers || { ollama: { enabled: true, models: [] }, apis: [] } }
          const existing = (cfg.providers.apis as any[]).filter((a: any) => a.provider === provType)
          const slotName = `${provType}-${existing.length + 1}`
          ;(cfg.providers.apis as any[]).push({
            name: slotName, provider: provType, key: apiKey,
            model: PROVIDER_INFO[provType].defaultModel, enabled: true, rateLimited: false, usageCount: 0,
          })
          saveCfg(cfg)
          console.log(`  ${T.success}✓ Added ${slotName}. /switch ${slotName} to activate.${T.reset}\n`)
        } else {
          const baseUrl = (await ask('Base URL (e.g. https://api.example.com/v1):')).trim()
          const apiKey  = (await ask('API key (enter to skip):')).trim()
          const model   = (await ask('Default model:')).trim()
          rl2.close()
          if (!provType || !baseUrl || !model) {
            console.log(`  ${T.error}✗ Name, URL and model are required.${T.reset}\n`); return true
          }
          const cfg = loadCfg()
          if (!cfg.customProviders) cfg.customProviders = []
          if ((cfg.customProviders as any[]).find((c: any) => c.id === provType)) {
            console.log(`  ${T.error}✗ "${provType}" already exists.${T.reset}\n`); return true
          }
          ;(cfg.customProviders as any[]).push({
            id: provType, displayName: provType, baseUrl, apiKey, model, enabled: true, tier: 3,
          })
          saveCfg(cfg)
          console.log(`  ${T.success}✓ Added custom provider ${provType}. /switch ${provType} to activate.${T.reset}\n`)
        }
      } catch {
        rl2.close()
        console.log(`  ${T.error}✗ Aborted.${T.reset}\n`)
      }
      return true
    }

    // ── /provider remove <id> ───────────────────────────────────────────────────
    if (sub === 'remove') {
      const id = parts[2]
      if (!id) { console.log(`  ${T.dim}Usage: /provider remove <id>${T.reset}\n`); return true }
      const cfg    = loadCfg()
      const active = cfg?.model?.active
      if (active === id) {
        console.log(`  ${T.error}✗ Cannot remove the active provider. /switch to another first.${T.reset}\n`)
        return true
      }
      let removed = false
      if (cfg.providers?.apis) {
        const before = (cfg.providers.apis as any[]).length
        cfg.providers.apis = (cfg.providers.apis as any[]).filter((a: any) => a.name !== id)
        if ((cfg.providers.apis as any[]).length < before) removed = true
      }
      if (!removed && cfg.customProviders) {
        const before = (cfg.customProviders as any[]).length
        cfg.customProviders = (cfg.customProviders as any[]).filter((c: any) => c.id !== id)
        if ((cfg.customProviders as any[]).length < before) removed = true
      }
      if (removed) { saveCfg(cfg); console.log(`  ${T.success}✓ Removed: ${id}${T.reset}\n`) }
      else         { console.log(`  ${T.error}✗ Provider "${id}" not found.${T.reset}\n`) }
      return true
    }

    // ── /provider test <id> ─────────────────────────────────────────────────────
    if (sub === 'test') {
      const id = parts[2]
      if (!id) { console.log(`  ${T.dim}Usage: /provider test <id>${T.reset}\n`); return true }
      process.stdout.write(`  ${T.dim}Testing ${id}...${T.reset}`)
      const cfg         = loadCfg()
      const apiEntry    = ((cfg?.providers?.apis    || []) as any[]).find((a: any) => a.name === id)
      const customEntry = ((cfg?.customProviders    || []) as any[]).find((c: any) => c.id   === id)
      try {
        if (apiEntry) {
          const rawKey = apiEntry.key || ''
          const key    = rawKey.startsWith('env:') ? (process.env[rawKey.replace('env:', '')] || '') : rawKey
          if (!key) {
            process.stdout.write('\r\x1b[K')
            console.log(`  ${T.error}✗ ${id}: no API key configured${T.reset}\n`)
            return true
          }
          let ok = false; let detail = ''
          if (apiEntry.provider === 'gemini') {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`)
            ok = r.ok
            detail = ok ? `${((await r.json() as any).models || []).length} models` : `HTTP ${r.status}`
          } else {
            const info    = PROVIDER_INFO[apiEntry.provider]
            const baseUrl = info?.baseUrl || 'https://api.groq.com/openai/v1'
            const r = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } })
            ok = r.ok
            detail = ok ? `${((await r.json() as any).data || []).length} models` : `HTTP ${r.status}`
          }
          process.stdout.write('\r\x1b[K')
          if (ok) console.log(`  ${T.success}✓ ${id}: valid, ${detail}${T.reset}\n`)
          else    console.log(`  ${T.error}✗ ${id}: ${detail}${T.reset}\n`)
        } else if (customEntry) {
          const hdrs: Record<string, string> = {}
          if (customEntry.apiKey) hdrs['Authorization'] = `Bearer ${customEntry.apiKey}`
          const r = await fetch(`${customEntry.baseUrl}/models`, { headers: hdrs })
          const d = await r.json() as any
          process.stdout.write('\r\x1b[K')
          const cnt = ((d.data || d.models || []) as any[]).length
          if (r.ok) console.log(`  ${T.success}✓ ${id}: valid, ${cnt} models${T.reset}\n`)
          else      console.log(`  ${T.error}✗ ${id}: HTTP ${r.status}${T.reset}\n`)
        } else {
          process.stdout.write('\r\x1b[K')
          console.log(`  ${T.error}✗ "${id}" not found in config.${T.reset}\n`)
        }
      } catch (e: any) {
        process.stdout.write('\r\x1b[K')
        console.log(`  ${T.error}✗ ${id}: ${e.message}${T.reset}\n`)
      }
      return true
    }

    // ── /provider <name> — switch active provider (legacy) ──────────────────────
    const providerName = sub
    if (!providerName) {
      console.log(`  ${T.dim}Usage: /provider list  |  /provider add <type> <key>  |  /provider add-custom <n> <url> <k>  |  /provider remove <id>  |  /provider test <id>${T.reset}\n`)
      return true
    }
    const res = await apiPost('/api/providers/active', { provider: providerName })
    if (res && !res.error) {
      state.lastProvider = providerName
      console.log(`  ${T.success}✓ Provider: ${providerName}${T.reset}\n`)
    } else {
      console.log(`  ${T.error}✗ Could not switch to "${providerName}".${T.reset}\n`)
    }
    return true
  }

  // ── /quit / /exit / /q ─────────────────────────────────────────────────────────
  if (command === '/quit' || command === '/exit' || command === '/q') {
    printSessionSummary()
    process.stdout.write('  Saving session memory...\n')
    try {
      await Promise.race([
        apiPost('/api/sessions/distill', { sessionId: SESSION_ID }),
        new Promise(r => setTimeout(r, 10_000)),
      ])
    } catch {}
    process.exit(0)
  }

  // ── /primary [list|name|reset] (also /switch) ───────────────────────────────
  if (command === '/primary' || command === '/switch') {
    const arg = parts[1]
    try {
      if (!arg) {
        // Show current primary
        const data = await apiFetch<any>('/api/config/primary', {})
        const pin = data?.primaryProvider
        if (pin) console.log(`\n  ${T.success}Primary provider: ${pin}${T.reset}\n`)
        else     console.log(`\n  ${T.dim}No primary provider set (default ordering)${T.reset}\n`)
      } else if (arg === 'list') {
        // Show all providers with readiness status
        const data = await apiFetch<any>('/api/providers/state', { primary: null, providers: [], currentChain: [] })
        const pin  = data.primary
        console.log(`\n  ${T.bold}Providers${T.reset}`)
        console.log(`  ${T.dim}${hr()}${T.reset}`)
        for (const p of (data.providers || [])) {
          const ready = p.enabled && !p.rateLimited
          const dot   = ready ? `${T.success}●` : `${T.dim}○`
          const star  = p.isPrimary ? ` ${fg(COLORS.orange)}★${T.reset}` : ''
          const rl    = p.rateLimited ? ` ${T.warning}[rate-limited]${T.reset}` : ''
          const noKey = p.enabled && !ready && !p.rateLimited ? ` ${T.dim}[no key]${T.reset}` : ''
          console.log(`  ${dot}${T.reset} ${(p.name || '').padEnd(18)}${T.dim}${p.model || ''}${T.reset}${star}${rl}${noKey}`)
        }
        if (pin) console.log(`\n  ${T.dim}Pinned: ${T.reset}${T.success}${pin}${T.reset}  ${T.dim}(use /primary reset to clear)${T.reset}`)
        else     console.log(`\n  ${T.dim}No pin — default ordering. Use /primary <name> to pin.${T.reset}`)
        console.log()
      } else if (arg === 'reset') {
        const r = await fetch('http://localhost:4200/api/config/primary', { method: 'DELETE' })
        if (r.ok) console.log(`\n  ${T.success}✓ Primary provider cleared — default ordering restored${T.reset}\n`)
        else      console.log(`\n  ${T.error}✗ Failed to clear primary provider${T.reset}\n`)
      } else {
        // Validate provider exists before pinning
        const state_ = await apiFetch<any>('/api/providers/state', { primary: null, providers: [] })
        const known  = (state_.providers || []) as any[]
        const match  = known.find((p: any) => p.name === arg || p.provider === arg)
        if (!match) {
          const names = known.map((p: any) => p.name).join(', ')
          console.log(`\n  ${T.error}✗ Unknown provider "${arg}"${T.reset}`)
          console.log(`  ${T.dim}Available: ${names}${T.reset}\n`)
        } else {
          const r = await fetch('http://localhost:4200/api/config/primary', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: arg }),
          })
          if (r.ok) {
            console.log(`\n  ${T.success}✓ Primary provider pinned: ${arg}${T.reset}\n`)
          } else {
            console.log(`\n  ${T.error}✗ Failed to set primary provider${T.reset}\n`)
          }
        }
      }
    } catch {
      console.log(`\n  ${T.error}✗ Could not reach server.${T.reset}\n`)
    }
    return true
  }

  // ── /timing ──────────────────────────────────────────────────────────────────
  if (command === '/timing') {
    const t = state.lastTimingData
    if (!t) {
      console.log(`\n  ${T.dim}No timing data yet — send a message first.${T.reset}\n`)
      return true
    }
    const fmt = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
    console.log()
    console.log(`  ${T.bold}Response Timing${T.reset}`)
    console.log(`  ${T.dim}${'─'.repeat(38)}${T.reset}`)
    console.log(`  ${T.dim}first token   ${T.reset}${fmt(t.first_token_ms).padStart(8)}`)
    console.log(`  ${T.dim}total time    ${T.reset}${fmt(t.total_ms).padStart(8)}`)
    console.log(`  ${T.dim}output tokens ${T.reset}${String(t.completion_tokens).padStart(8)}`)
    console.log()
    return true
  }

  // ── /version ─────────────────────────────────────────────────────────────────
  if (command === '/version') {
    console.log(`\n  ${T.bold}Aiden${T.reset}  ${T.dim}v${VERSION}${T.reset}`)
    console.log(`  ${T.dim}Checking for updates...${T.reset}`)
    try {
      const { checkForUpdate } = await import('../core/updateCheck')
      const info = await checkForUpdate(VERSION, 5000)
      if (!info) {
        console.log(`  ${T.dim}Update check unavailable (offline or rate-limited).${T.reset}\n`)
      } else if (info.updateAvailable) {
        console.log(`  ${fg(COLORS.orange)}↑ Update available: v${info.latestVersion}${T.reset}`)
        console.log(`  ${T.dim}${info.releaseUrl}${T.reset}\n`)
      } else {
        console.log(`  ${T.success}✓ Already on latest (v${VERSION}).${T.reset}\n`)
      }
    } catch (e: any) {
      console.log(`  ${T.error}✗ Update check failed: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /run [<file>|'-'|examples|help [ns]] ─────────────────────────────────────
  if (command === '/run') {
    const sub  = parts[1]
    const D    = T.dim
    const R    = T.reset
    const O    = fg(COLORS.orange)
    const G    = T.success

    // ── /run help [<namespace>] ──────────────────────────────────────────────
    if (sub === 'help') {
      const ns = parts[2]?.toLowerCase()
      try {
        const { getSdkMethods, getSdkNamespaces, buildSdkSurface } = await import('../core/aidenSdk')
        if (!ns) {
          // Full SDK surface
          const surface = buildSdkSurface()
          console.log(panel({
            title: `${MARKS.TRI} /run SDK reference`,
            lines: ['', ...surface.split('\n').map(l => `  ${l}`), ''],
            accent: COLORS.orange,
          }))
        } else {
          // Namespace detail
          const methods = getSdkMethods().filter(m => (m.namespace || '_top') === ns)
          if (!methods.length) {
            const namespaces = getSdkNamespaces().join(', ')
            console.log(`\n  ${D}Unknown namespace "${ns}". Available: ${namespaces}${R}\n`)
          } else {
            const lines: string[] = ['']
            for (const m of methods) {
              lines.push(`  ${O}aiden.${ns}.${m.method}${R}`)
              lines.push(`  ${D}${m.signature}${R}`)
              lines.push(`  ${m.description}`)
              lines.push('')
            }
            console.log(panel({ title: `${MARKS.TRI} aiden.${ns} — SDK detail`, lines, accent: COLORS.orange }))
          }
        }
      } catch (e: any) {
        console.log(`\n  ${T.error}✗ Could not load SDK: ${e?.message}${R}\n`)
      }
      return true
    }

    // ── /run examples ───────────────────────────────────────────────────────
    if (sub === 'examples') {
      const scriptDir = path.join(__dirname, '..', 'scripts')
      const lines: string[] = ['']
      try {
        const files = fs.readdirSync(scriptDir).filter(f => f.endsWith('.js') || f.endsWith('.ts'))
        if (!files.length) {
          lines.push(`  ${D}No scripts found in scripts/${R}`)
        } else {
          for (const f of files) {
            const firstLine = fs.readFileSync(path.join(scriptDir, f), 'utf8')
              .split('\n').find(l => l.startsWith('//'))?.replace(/^\/\/\s*/, '') ?? ''
            lines.push(`  ${O}${f.padEnd(32)}${R}${D}${firstLine}${R}`)
          }
          lines.push('')
          lines.push(`  ${D}Run with: /run scripts/<file>.js${R}`)
        }
      } catch {
        lines.push(`  ${D}scripts/ directory not found${R}`)
      }
      lines.push('')
      console.log(panel({ title: `${MARKS.TRI} /run example scripts`, lines, accent: COLORS.orange }))
      return true
    }

    // ── /run - [description] (stdin) ────────────────────────────────────────
    if (sub === '-') {
      const desc = parts.slice(2).join(' ')
      console.log(`\n  ${D}Paste JavaScript (end with empty line):${R}`)
      const codeLines: string[] = []
      const rl2 = readline.createInterface({ input: process.stdin, terminal: false })
      await new Promise<void>(resolve => {
        rl2.on('line', ln => {
          if (ln === '') { rl2.close(); resolve() }
          else codeLines.push(ln)
        })
        rl2.on('close', resolve)
      })
      const code = codeLines.join('\n')
      if (!code.trim()) { console.log(`\n  ${D}No code entered.${R}\n`); return true }
      await _executeRunCode(code, desc, O, G, R, D)
      return true
    }

    // ── /run <file> ──────────────────────────────────────────────────────────
    if (sub) {
      const filePath = path.isAbsolute(sub) ? sub : path.resolve(process.cwd(), sub)
      try {
        const code = fs.readFileSync(filePath, 'utf8')
        const desc = parts.slice(2).join(' ') || path.basename(filePath)
        await _executeRunCode(code, desc, O, G, R, D)
      } catch (e: any) {
        console.log(`\n  ${T.error}✗ Cannot read file: ${filePath}\n  ${e?.message}${R}\n`)
      }
      return true
    }

    // ── /run (no args) ───────────────────────────────────────────────────────
    console.log(panel({
      title: `${MARKS.TRI} /run — Aiden VM sandbox`,
      lines: [
        '',
        `  ${D}Execute JavaScript with full Aiden SDK access.${R}`,
        '',
        `  ${O}Usage:${R}`,
        `    ${D}/run <file.js>          ${R}Execute a script file`,
        `    ${D}/run -                  ${R}Paste code from stdin (empty line = run)`,
        `    ${D}/run examples           ${R}Browse example scripts in scripts/`,
        `    ${D}/run help               ${R}Full SDK surface reference`,
        `    ${D}/run help <namespace>   ${R}Detail for one namespace (web, file, shell…)`,
        '',
        `  ${O}SDK namespaces:${R}`,
        `    ${D}aiden.web   aiden.file   aiden.shell   aiden.browser   aiden.screen${R}`,
        `    ${D}aiden.memory   aiden.system   aiden.git   aiden.data${R}`,
        '',
      ],
      accent: COLORS.orange,
    }))
    return true
  }

  /** Internal helper — POST code to /api/run and render result. */
  async function _executeRunCode(
    code: string,
    description: string,
    O: string, G: string, R: string, D: string,
  ) {
    console.log(`\n  ${D}▲ Running…${R}`)
    const t0  = Date.now()
    const res = await apiPost('/api/run', { code, description })
    const ms  = Date.now() - t0

    if (!res || res.error) {
      const serverMsg = res?.error ? ` (${res.error})` : ''
      console.log(`\n  ${T.error}✗ Could not reach server. Is Aiden running?${serverMsg}${R}\n`)
      return
    }

    const lines: string[] = ['']
    if (res.output?.length) {
      for (const l of res.output) lines.push(`  ${l}`)
      lines.push('')
    }
    if (res.toolCalls?.length) {
      lines.push(`  ${D}Tool calls (${res.toolCalls.length}):${R}`)
      for (const tc of res.toolCalls) {
        lines.push(`    ${D}${tc.tool.padEnd(20)} ${tc.durationMs}ms${R}`)
      }
      lines.push('')
    }
    const status = res.success
      ? `${G}✓ success${R}  ${D}${ms}ms${R}`
      : `${T.error}✗ error — ${res.error ?? 'unknown'}${R}`
    lines.push(`  ${status}`)
    lines.push('')

    console.log(panel({
      title: `${MARKS.TRI} /run${description ? ` — ${description}` : ''}`,
      lines,
      accent: res.success ? COLORS.success : COLORS.error,
    }))
  }

  // ── /spawn [<task>|list|kill <id>] ──────────────────────────────────────────
  if (command === '/spawn') {
    const sub = parts[1]
    const O   = fg(COLORS.orange)
    const D   = T.dim
    const R   = T.reset
    const G   = T.success

    // /spawn list
    if (sub === 'list') {
      try {
        const { getActiveSpawns } = await import('../core/spawnManager')
        const spawns = getActiveSpawns()
        if (!spawns.length) {
          console.log(`\n  ${D}No active or recent spawns.${R}\n`)
          return true
        }
        const lines: string[] = ['']
        for (const s of spawns) {
          const age    = Math.round((Date.now() - s.startedAt) / 1000)
          const status = s.status === 'running'  ? `${O}running${R}`
                       : s.status === 'done'     ? `${G}done${R}`
                       : s.status === 'aborted'  ? `${T.error}aborted${R}`
                       : `${D}pending${R}`
          lines.push(`  ${D}${s.id}${R}`)
          lines.push(`    ${status}  ${D}${age}s ago${R}  ${s.task}`)
          lines.push('')
        }
        console.log(panel({ title: `${MARKS.TRI} /spawn list`, lines, accent: COLORS.orange }))
      } catch (e: any) {
        console.log(`\n  ${T.error}✗ ${e?.message}${R}\n`)
      }
      return true
    }

    // /spawn kill <id>
    if (sub === 'kill') {
      const id = parts[2]
      if (!id) { console.log(`\n  ${D}Usage: /spawn kill <id>${R}\n`); return true }
      try {
        const { killSpawn } = await import('../core/spawnManager')
        const killed = killSpawn(id)
        if (killed) console.log(`\n  ${G}✓ Spawn ${id} aborted.${R}\n`)
        else        console.log(`\n  ${T.error}✗ No running spawn with id: ${id}${R}\n`)
      } catch (e: any) {
        console.log(`\n  ${T.error}✗ ${e?.message}${R}\n`)
      }
      return true
    }

    // /spawn <task>
    if (sub) {
      const task = parts.slice(1).join(' ')
      console.log(`\n  ${D}▲ Spawning subagent…${R}`)
      try {
        const { spawnSubagent }  = await import('../core/spawnManager')
        const { getBudgetState } = await import('../core/agentLoop')
        const budget = getBudgetState() ?? { current: 1, max: 20, remaining: 19 }
        const t0     = Date.now()
        const result = await spawnSubagent({ task, timeout: 120000, parentBudget: budget })
        const ms     = Date.now() - t0
        const lines: string[] = ['']
        if (result.result) {
          for (const l of result.result.split('\n')) lines.push(`  ${l}`)
          lines.push('')
        }
        lines.push(`  ${D}iterations=${result.iterationsUsed}  duration=${ms}ms${R}`)
        if (result.providerChain.length)
          lines.push(`  ${D}providers: ${result.providerChain.join(' → ')}${R}`)
        lines.push('')
        const accent = result.success ? COLORS.success : COLORS.error
        if (result.error) lines.splice(1, 0, `  ${T.error}✗ ${result.error}${R}`, '')
        console.log(panel({ title: `${MARKS.TRI} /spawn — ${task.slice(0, 50)}`, lines, accent }))
      } catch (e: any) {
        console.log(`\n  ${T.error}✗ Spawn failed: ${e?.message}${R}\n`)
      }
      return true
    }

    // /spawn (no args)
    console.log(panel({
      title: `${MARKS.TRI} /spawn — subagent delegation`,
      lines: [
        '',
        `  ${D}Delegate a sub-task to an isolated subagent with context isolation.${R}`,
        '',
        `  ${O}Usage:${R}`,
        `    ${D}/spawn <task>          ${R}Delegate task to subagent`,
        `    ${D}/spawn list            ${R}Show active / recent spawns`,
        `    ${D}/spawn kill <id>       ${R}Abort a running spawn`,
        '',
      ],
      accent: COLORS.orange,
    }))
    return true
  }

  // ── /swarm [<task>] [--n=N] [--strategy=vote|merge|best] ────────────────────
  if (command === '/swarm') {
    const O   = fg(COLORS.orange)
    const D   = T.dim
    const R   = T.reset

    // Parse flags from args
    const rawArgs  = parts.slice(1)
    const flagN    = rawArgs.find(a => a.startsWith('--n='))
    const flagS    = rawArgs.find(a => a.startsWith('--strategy='))
    const n        = flagN    ? parseInt(flagN.replace('--n=', ''),        10) : 3
    const strategy = flagS    ? flagS.replace('--strategy=', '')               : 'vote'
    const taskParts = rawArgs.filter(a => !a.startsWith('--'))
    const task      = taskParts.join(' ')

    if (!task) {
      console.log(panel({
        title: `${MARKS.TRI} /swarm — parallel subagents`,
        lines: [
          '',
          `  ${D}Run N subagents in parallel and aggregate their answers.${R}`,
          '',
          `  ${O}Usage:${R}`,
          `    ${D}/swarm <task>                          ${R}3 agents, vote strategy`,
          `    ${D}/swarm <task> --n=5                    ${R}5 agents`,
          `    ${D}/swarm <task> --strategy=merge         ${R}Synthesise all answers`,
          `    ${D}/swarm <task> --strategy=best          ${R}Ranked list of all answers`,
          '',
          `  ${O}Strategies:${R}`,
          `    ${D}vote   ${R}LLM judge picks the best single answer (default)`,
          `    ${D}merge  ${R}Synthesise all successful answers into one`,
          `    ${D}best   ${R}Return all answers ranked by completeness`,
          '',
        ],
        accent: COLORS.orange,
      }))
      return true
    }

    const safeN       = Math.max(2, Math.min(isNaN(n) ? 3 : n, 5))
    const safeStrat   = ['vote', 'merge', 'best'].includes(strategy) ? strategy as 'vote' | 'merge' | 'best' : 'vote'

    console.log(`\n  ${D}▲ Swarming ${safeN} agents (strategy: ${safeStrat})…${R}`)
    try {
      const { swarmSubagents } = await import('../core/swarmManager')
      const { getBudgetState } = await import('../core/agentLoop')
      const budget = getBudgetState() ?? { current: 1, max: 20, remaining: 19 }
      const t0     = Date.now()
      const result = await swarmSubagents({ task, n: safeN, strategy: safeStrat, timeout: 120000, parentBudget: budget })
      const ms     = Date.now() - t0
      const lines: string[] = ['']
      if (result.result) {
        for (const l of result.result.split('\n')) lines.push(`  ${l}`)
        lines.push('')
      }
      lines.push(`  ${D}agents=${result.agentsRun}  strategy=${result.strategy}  duration=${ms}ms${R}`)
      lines.push('')
      if (result.error) lines.splice(1, 0, `  ${T.error}✗ ${result.error}${R}`, '')
      const accent = result.success ? COLORS.success : COLORS.error
      console.log(panel({ title: `${MARKS.TRI} /swarm — ${task.slice(0, 50)}`, lines, accent }))
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ Swarm failed: ${e?.message}${R}\n`)
    }
    return true
  }

  // ── /search <query> [--top=N] ────────────────────────────────────────────────
  if (command === '/search') {
    const O   = fg(COLORS.orange)
    const D   = T.dim
    const R   = T.reset
    const G   = T.success

    const rawArgs  = parts.slice(1)
    const flagTop  = rawArgs.find(a => a.startsWith('--top='))
    const topK     = flagTop ? parseInt(flagTop.replace('--top=', ''), 10) : 5
    const query    = rawArgs.filter(a => !a.startsWith('--')).join(' ')

    if (!query) {
      console.log(panel({
        title: `${MARKS.TRI} /search — session & memory search`,
        lines: [
          '',
          `  ${D}Hybrid BM25 + semantic search over sessions and memory files.${R}`,
          '',
          `  ${O}Usage:${R}`,
          `    ${D}/search <query>           ${R}Top-5 results`,
          `    ${D}/search <query> --top=N   ${R}Top-N results`,
          '',
        ],
        accent: COLORS.orange,
      }))
      return true
    }

    try {
      const { hybridSearch } = await import('../core/hybridSearch')
      const { getIndexSize } = await import('../core/sessionSearch')
      const safeTop = isNaN(topK) ? 5 : Math.max(1, Math.min(topK, 20))
      const hits    = hybridSearch(query, { topK: safeTop })
      const size    = getIndexSize()

      if (!hits.length) {
        console.log(`\n  ${D}No results for "${query}" (${size} docs indexed).${R}\n`)
        return true
      }

      const lines: string[] = ['']
      for (const h of hits) {
        const pct = (h.score * 100).toFixed(0).padStart(3)
        const src = h.source === 'both' ? 'sem+fts' : h.source === 'semantic' ? 'sem' : 'fts'
        lines.push(`  ${O}${pct}%${R}  ${h.title}  ${D}[${src}]${R}`)
        lines.push(`  ${D}${h.snippet}${R}`)
        lines.push('')
      }
      lines.push(`  ${D}${hits.length} result(s)  ·  ${size} docs indexed${R}`)
      lines.push('')
      console.log(panel({ title: `${MARKS.TRI} /search — ${query}`, lines, accent: COLORS.orange }))
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ Search failed: ${e?.message}${R}\n`)
    }
    return true
  }

  // ── /install <skill_name> ————— install from public registry ─────────────────
  if (command === '/install') {
    const skillName = parts.slice(1).join(' ').trim()
    if (!skillName) {
      console.log(panel({
        title: `${MARKS.TRI} /install`,
        lines: [
          '',
          `  ${T.dim}Install a skill from the public Aiden registry.${T.reset}`,
          '',
          `  ${fg(COLORS.orange)}Usage:${T.reset}`,
          `    ${T.dim}/install <skill_name>${T.reset}`,
          '',
          `  ${T.dim}Browse: /skills registry <query>${T.reset}`,
          '',
        ],
        accent: COLORS.orange,
      }))
      return true
    }
    console.log(`  ${T.dim}Fetching "${skillName}" from skills.taracod.com…${T.reset}`)
    try {
      const { installSkill } = await import('../core/skillRegistry')
      const { path: skillPath } = await installSkill(skillName)
      console.log(`\n  ${fg(COLORS.success)}${MARKS.TRI}${T.reset} installed ${fg(COLORS.orange)}${skillName}${T.reset}`)
      console.log(`  ${T.dim}→ ${skillPath}${T.reset}\n`)
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ Install failed: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /publish <skill_name> [--key=<license>] ———— publish to registry ──────
  if (command === '/publish') {
    const flagKey  = parts.find(a => a.startsWith('--key='))
    const license  = flagKey ? flagKey.replace('--key=', '') : (process.env.AIDEN_LICENSE ?? '')
    const skillName = parts.filter(a => !a.startsWith('--')).slice(1).join(' ').trim()
    if (!skillName) {
      console.log(panel({
        title: `${MARKS.TRI} /publish`,
        lines: [
          '',
          `  ${T.dim}Publish a learned or approved skill to the public registry (Pro).${T.reset}`,
          '',
          `  ${fg(COLORS.orange)}Usage:${T.reset}`,
          `    ${T.dim}/publish <skill_name> [--key=<license_key>]${T.reset}`,
          '',
          `  ${T.dim}Or set AIDEN_LICENSE env var to skip --key each time.${T.reset}`,
          '',
        ],
        accent: COLORS.orange,
      }))
      return true
    }
    if (!license) {
      console.log(`\n  ${T.error}✗ License key required. Use --key=<key> or set AIDEN_LICENSE.${T.reset}\n`)
      return true
    }
    console.log(`  ${T.dim}Publishing "${skillName}" to skills.taracod.com…${T.reset}`)
    try {
      const { publishSkill } = await import('../core/skillRegistry')
      const { url } = await publishSkill(skillName, license)
      console.log(`\n  ${fg(COLORS.success)}${MARKS.TRI}${T.reset} published ${fg(COLORS.orange)}${skillName}${T.reset}`)
      console.log(`  ${T.dim}→ ${url}${T.reset}\n`)
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ Publish failed: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /mcp ─────────────────────────────────────────────────────────────────────
  // ── /failed [reason] ─────────────────────────────────────────────────────────
  // Manually signals that the last exchange failed and triggers failure trace analysis.
  if (command === '/failed') {
    const manualReason = parts.slice(1).join(' ').trim()
    try {
      const { analyzeFailureTrace } = await import('../core/failureAnalyzer')
      const { sessionMemory }       = await import('../core/sessionMemory')
      const sidFailed               = SESSION_ID

      // Retrieve the last exchange from sessionMemory
      const sessions: any[] = []  // getSessions not yet implemented; falls back to manualReason
      const thisSess = sessions.find((s: any) => s.id === sidFailed)
      const exchanges = thisSess?.exchanges ?? []
      const last = exchanges[exchanges.length - 1]

      const userMsg  = last?.userMessage ?? manualReason ?? '(unknown)'
      const aiReply  = last?.aiReply     ?? ''
      const tools    = last?.toolsUsed   ?? []

      await analyzeFailureTrace({
        userMessage: userMsg,
        aiReply,
        toolsUsed:   tools,
        errors:      manualReason ? [manualReason] : [],
        signal:      'manual',
        sessionId:   sidFailed,
      })

      console.log(`\n  ${fg(COLORS.success)}${MARKS.TRI}${T.reset} Lesson recorded. Check ${T.dim}workspace/LESSONS.md${T.reset} for details.\n`)
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ Analysis failed: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /sandbox ─────────────────────────────────────────────────────────────────
  // Manage the opt-in Docker sandbox backend for shell_exec / run_python.
  //   /sandbox status          — show current mode + Docker availability
  //   /sandbox off             — disable sandbox (host execution)
  //   /sandbox auto            — try Docker, fall back to host if unavailable
  //   /sandbox strict          — require Docker, error if unavailable
  //   /sandbox build           — pre-build the aiden-sandbox Docker image now
  if (command === '/sandbox') {
    const sub = parts[1]?.toLowerCase()
    const { checkDockerAvailable, buildSandboxImage, getSandboxStatus, resetDockerCache } =
      await import('../core/sandboxRunner')

    // /sandbox status (default with no subcommand)
    if (!sub || sub === 'status') {
      const status = await getSandboxStatus()
      const modeColor = status.mode === 'off'    ? T.dim
                      : status.mode === 'auto'   ? fg(COLORS.orange)
                      : fg(COLORS.success)
      const dockerIcon = status.dockerAvailable ? `${T.success}●${T.reset}` : `${T.error}●${T.reset}`
      const imageIcon  = status.imageCached     ? `${T.success}✓${T.reset}` : `${T.dim}–${T.reset}`
      console.log(`
  ${fg(COLORS.blue)}╔══ Sandbox Status ═══════════════════════════════╗${T.reset}
  ${fg(COLORS.blue)}║${T.reset}  Mode:    ${modeColor}${status.mode.toUpperCase()}${T.reset}
  ${fg(COLORS.blue)}║${T.reset}  Docker:  ${dockerIcon} ${status.dockerAvailable ? 'available' : 'not found'}
  ${fg(COLORS.blue)}║${T.reset}  Image:   ${imageIcon} ${status.imageTag}${status.imageCached ? ' (cached)' : ' (not built)'}
  ${fg(COLORS.blue)}╚══════════════════════════════════════════════════╝${T.reset}

  ${T.dim}Set AIDEN_SANDBOX_MODE in .env  |  /sandbox auto|strict|off|build${T.reset}
`)
      return true
    }

    if (sub === 'off' || sub === 'auto' || sub === 'strict') {
      process.env.AIDEN_SANDBOX_MODE = sub
      // Persist to .env (workspace/.sandbox_mode ephemeral override)
      const _fs   = await import('fs')
      const _path = await import('path')
      const overridePath = _path.join(process.cwd(), 'workspace', '.sandbox_mode')
      _fs.mkdirSync(_path.dirname(overridePath), { recursive: true })
      _fs.writeFileSync(overridePath, sub, 'utf-8')
      resetDockerCache()
      const color = sub === 'off' ? T.dim : sub === 'auto' ? fg(COLORS.orange) : fg(COLORS.success)
      console.log(`\n  ${fg(COLORS.success)}${MARKS.TRI}${T.reset} Sandbox mode set to ${color}${sub.toUpperCase()}${T.reset}\n`)
      if (sub === 'auto' || sub === 'strict') {
        const available = await checkDockerAvailable()
        if (!available) {
          console.log(`  ${T.error}⚠ Docker not detected.${T.reset} Install Docker Desktop: https://www.docker.com/products/docker-desktop/\n`)
        } else {
          console.log(`  ${T.dim}Docker detected. Run ${T.reset}/sandbox build${T.dim} to pre-build the image.${T.reset}\n`)
        }
      }
      return true
    }

    if (sub === 'build') {
      const available = await checkDockerAvailable()
      if (!available) {
        console.log(`\n  ${T.error}✗ Docker is not available.${T.reset} Install Docker Desktop first.\n`)
        return true
      }
      console.log(`\n  ${T.dim}Building aiden-sandbox image… (this may take 30–60s on first run)${T.reset}\n`)
      try {
        await buildSandboxImage()
        const status = await getSandboxStatus()
        const icon = status.imageCached ? `${T.success}✓${T.reset}` : `${T.error}✗${T.reset}`
        console.log(`  ${icon} Image ${status.imageTag} ${status.imageCached ? 'ready' : 'build may have failed — check Docker logs'}\n`)
      } catch (e: any) {
        console.log(`\n  ${T.error}✗ Build failed: ${e?.message}${T.reset}\n`)
      }
      return true
    }

    console.log(`\n  ${T.dim}Usage: /sandbox [status|off|auto|strict|build]${T.reset}\n`)
    return true
  }

  if (command === '/mcp') {
    const O = fg(COLORS.orange)
    const D = T.dim
    const R = T.reset
    const G = T.success
    const sub = parts[1]?.toLowerCase()

    try {
      const mcp = await import('../core/mcpClient')

      if (!sub || sub === 'list') {
        const servers = mcp.listMcpServers()
        if (servers.length === 0) {
          console.log(panel({
            title: `${MARKS.TRI} /mcp — no servers connected`,
            lines: ['', `  ${D}Add servers to workspace/config/mcp.json and restart, or use:${R}`, `  ${O}/mcp connect <name> <command> [args...]${R}`, ''],
            accent: COLORS.orange,
          }))
        } else {
          const lines = ['', ...servers.map(s => `  ${G}●${R}  ${s}`), '']
          console.log(panel({ title: `${MARKS.TRI} /mcp list  (${servers.length} connected)`, lines, accent: COLORS.orange }))
        }
        return true
      }

      if (sub === 'tools') {
        const filterServer = parts[2]?.toLowerCase()
        let tools = mcp.listMcpTools()
        if (filterServer) tools = tools.filter(t => t.serverName.toLowerCase() === filterServer)
        if (tools.length === 0) {
          console.log(`\n  ${D}No MCP tools${filterServer ? ` for server "${filterServer}"` : ''}.${R}\n`)
        } else {
          const lines = ['', ...tools.map(t => `  ${O}${t.name}${R}  ${D}${t.description ?? ''}${R}`), '']
          console.log(panel({ title: `${MARKS.TRI} /mcp tools  (${tools.length})`, lines, accent: COLORS.orange }))
        }
        return true
      }

      if (sub === 'connect') {
        const name    = parts[2]
        const cmdArg  = parts[3]
        if (!name || !cmdArg) {
          console.log(`\n  ${D}Usage: /mcp connect <name> <command> [args...]${R}\n`)
          return true
        }
        const extraArgs = parts.slice(4)
        await mcp.connectMcpServer({ name, transport: 'stdio', command: cmdArg, args: extraArgs })
        console.log(`\n  ${G}✓${R} Connected MCP server "${name}"\n`)
        return true
      }

      if (sub === 'disconnect') {
        const name = parts[2]
        if (!name) { console.log(`\n  ${D}Usage: /mcp disconnect <name>${R}\n`); return true }
        await mcp.disconnectMcpServer(name)
        console.log(`\n  ${G}✓${R} Disconnected "${name}"\n`)
        return true
      }

      if (sub === 'call') {
        const toolName = parts[2]
        const jsonArg  = parts.slice(3).join(' ').trim()
        if (!toolName) { console.log(`\n  ${D}Usage: /mcp call <server:tool> [json-args]${R}\n`); return true }
        let args: any = {}
        if (jsonArg) { try { args = JSON.parse(jsonArg) } catch { args = { input: jsonArg } } }
        const result = await mcp.callMcpTool(toolName, args)
        const out = typeof result === 'string' ? result
          : result?.content?.map((c: any) => c.text ?? JSON.stringify(c)).join('\n')
            ?? JSON.stringify(result, null, 2)
        console.log(panel({
          title: `${MARKS.TRI} /mcp call ${toolName}`,
          lines: ['', ...out.split('\n').map((l: string) => `  ${l}`), ''],
          accent: COLORS.orange,
        }))
        return true
      }

      console.log(`\n  ${D}Unknown /mcp subcommand. Try: list | tools | connect | disconnect | call${R}\n`)
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ MCP error: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /cmd ─────────────────────────────────────────────────────────────────────
  if (command === '/cmd') {
    const O = fg(COLORS.orange)
    const D = T.dim
    const R = T.reset
    const shellCmd = parts.slice(1).join(' ').trim()
    if (!shellCmd) {
      console.log(`\n  ${D}Usage: /cmd <windows-command>   e.g. /cmd dir${R}\n`)
      return true
    }
    try {
      const { executeTool } = await import('../core/toolRegistry')
      const result = await executeTool('cmd', { command: shellCmd }, 0, 30000)
      const out    = result.output.slice(0, 2000)
      const extra  = result.output.length > 2000 ? `\n  ${D}… (truncated — see workspace/logs for full output)${R}` : ''
      const exitOk = (result as any).exitCode === 0 || result.success
      const lines  = ['', ...out.split('\n').map(l => `  ${l}`), extra, '']
      console.log(panel({
        title: `${MARKS.TRI} /cmd  ${exitOk ? `${T.success}✓ exit 0` : `${T.error}✗ exit ${(result as any).exitCode ?? '?'}`}${R}`,
        lines,
        accent: exitOk ? COLORS.orange : COLORS.red ?? COLORS.orange,
      }))
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ cmd failed: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /ps ──────────────────────────────────────────────────────────────────────
  if (command === '/ps') {
    const O = fg(COLORS.orange)
    const D = T.dim
    const R = T.reset
    const psCmd = parts.slice(1).join(' ').trim()
    if (!psCmd) {
      console.log(`\n  ${D}Usage: /ps <powershell-command>   e.g. /ps Get-Process${R}\n`)
      return true
    }
    try {
      const { executeTool } = await import('../core/toolRegistry')
      const result = await executeTool('ps', { command: psCmd }, 0, 30000)
      const out    = result.output.slice(0, 2000)
      const extra  = result.output.length > 2000 ? `\n  ${D}… (truncated — see workspace/logs for full output)${R}` : ''
      const exitOk = result.success
      const lines  = ['', ...out.split('\n').map(l => `  ${l}`), extra, '']
      console.log(panel({
        title: `${MARKS.TRI} /ps  ${exitOk ? `${T.success}✓` : `${T.error}✗`}${R}`,
        lines,
        accent: COLORS.orange,
      }))
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ ps failed: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /wsl ─────────────────────────────────────────────────────────────────────
  if (command === '/wsl') {
    const O = fg(COLORS.orange)
    const D = T.dim
    const R = T.reset
    const rawArgs   = parts.slice(1)
    const distroIdx = rawArgs.findIndex(a => a.startsWith('--distro='))
    const distro    = distroIdx !== -1 ? rawArgs[distroIdx].replace('--distro=', '') : ''
    const cleanArgs = rawArgs.filter(a => !a.startsWith('--distro='))
    const wslCmd    = cleanArgs.join(' ').trim()
    if (!wslCmd) {
      console.log(`\n  ${D}Usage: /wsl <bash-command> [--distro=<name>]   e.g. /wsl uname -a${R}\n`)
      return true
    }
    try {
      const { executeTool } = await import('../core/toolRegistry')
      const result = await executeTool('wsl', { command: wslCmd, distro }, 0, 30000)
      const out    = result.output.slice(0, 2000)
      const extra  = result.output.length > 2000 ? `\n  ${D}… (truncated — see workspace/logs for full output)${R}` : ''
      const exitOk = result.success
      const lines  = ['', ...out.split('\n').map(l => `  ${l}`), extra, '']
      console.log(panel({
        title: `${MARKS.TRI} /wsl  ${exitOk ? `${T.success}✓` : `${T.error}✗`}${R}`,
        lines,
        accent: COLORS.orange,
      }))
    } catch (e: any) {
      console.log(`\n  ${T.error}✗ wsl failed: ${e?.message}${T.reset}\n`)
    }
    return true
  }

  // ── /refresh ────────────────────────────────────────────────────────────────
  if (command === '/refresh') {
    console.log(`\n  ${T.dim}Checking for updates...${T.reset}`)
    try {
      const info = await checkForUpdate(VERSION)
      if (!info) {
        console.log(`  ${T.dim}Update check unavailable (offline or rate-limited).${T.reset}\n`)
      } else if (info.updateAvailable) {
        console.log(`  ${T.accent}↑ Update available: v${info.latestVersion}${T.reset}`)
        console.log(`  ${T.dim}${info.releaseUrl}${T.reset}`)
        console.log(`  ${T.dim}Download in progress via auto-updater...${T.reset}`)
        // In Electron renderer context: window.aidenUpdater.checkNow()
        // In packaged app the background autoUpdater (main process) handles download.
        if (typeof (globalThis as any).aidenUpdater?.checkNow === 'function') {
          await (globalThis as any).aidenUpdater.checkNow()
        }
      } else {
        console.log(`  ${T.ok}✓ Already on latest version (v${VERSION}).${T.reset}`)
      }
    } catch (e: any) {
      console.log(`  ${T.error}✗ Update check failed: ${e?.message}${T.reset}`)
    }
    return true
  }

  // ── /channels ────────────────────────────────────────────────────────────────
  if (command === '/channels') {
    const [sub, name] = args

    if (sub === 'restart' && name) {
      console.log(`\n  ${T.dim}Restarting channel: ${name}...${T.reset}`)
      const result = await apiFetch<any>(`/api/channels/restart/${name}`, null)
      if (result) {
        const icon = result.status === 'started' ? T.ok : result.status === 'disabled' ? T.dim : T.error
        console.log(`  ${icon}${result.name}: ${result.status}${T.reset}\n`)
      } else {
        console.log(`  ${T.error}✗ Server offline or channel not found.${T.reset}\n`)
      }
      return true
    }

    if (sub === 'test' && name) {
      console.log(`\n  ${T.dim}Sending test message to channel: ${name}...${T.reset}`)
      const result = await apiFetch<any>(`/api/channels/test/${name}`, null)
      if (result?.ok) {
        console.log(`  ${T.ok}✓ Test message delivered via ${name}.${T.reset}\n`)
      } else {
        console.log(`  ${T.error}✗ Test failed — ${result?.error ?? 'server offline'}.${T.reset}\n`)
      }
      return true
    }

    // Default: show status panel
    const statuses = await apiFetch<Array<{ name: string; healthy: boolean; lastActivity?: number }>>('/api/channels/status', null)
    if (!statuses) {
      console.log(`\n  ${T.dim}Server offline — cannot fetch channel status.${T.reset}\n`)
      return true
    }

    const lines: string[] = statuses.map(ch => {
      const icon    = ch.healthy ? `${T.ok}●${T.reset}` : `${T.dim}○${T.reset}`
      const label   = ch.healthy ? `${T.ok}connected${T.reset}` : `${T.dim}disabled${T.reset}`
      const ago     = ch.lastActivity
        ? `  ${T.dim}last active ${Math.round((Date.now() - ch.lastActivity) / 1000)}s ago${T.reset}`
        : ''
      return `  ${icon}  ${ch.name.padEnd(10)}${label}${ago}`
    })
    if (lines.length === 0) lines.push(`  ${T.dim}No channel adapters registered.${T.reset}`)
    console.log(panel({ title: `${MARKS.TRI} Channels`, lines }))
    return true
  }

  // ── /voice ────────────────────────────────────────────────────────────────
  if (command === '/voice') {
    const sub = args[0]?.toLowerCase()
    const { getTtsProviders } = await import('../core/voice/tts')

    if (sub === 'on') {
      state.voiceMode = true
      console.log(`\n  ${T.ok}● Voice mode ON${T.reset} — AI replies will be spoken aloud.\n`)
      return true
    }
    if (sub === 'off') {
      state.voiceMode = false
      console.log(`\n  ${T.dim}○ Voice mode OFF${T.reset}\n`)
      return true
    }
    if (sub === 'providers') {
      const providers = getTtsProviders()
      console.log()
      for (const p of providers) {
        const icon  = p.available ? `${T.ok}●${T.reset}` : `${T.dim}○${T.reset}`
        const label = p.available ? `${T.ok}available${T.reset}` : `${T.dim}unavailable${T.reset}`
        console.log(`  ${icon}  ${p.name.padEnd(12)}${label}`)
      }
      console.log()
      return true
    }

    if (sub === 'design') {
      const desc = args.slice(1).join(' ').trim().replace(/^["']|["']$/g, '')
      if (!desc) {
        console.log(`\n  ${T.dim}Usage: /voice design <description>${T.reset}`)
        console.log(`  ${T.dim}Example: /voice design "calm, deep male voice with British accent"${T.reset}\n`)
        return true
      }
      state.voiceDesign        = desc
      state.voiceReferencePath = undefined
      console.log(`\n  ${T.ok}✓ Voice design set:${T.reset} "${desc}"`)
      console.log(`  ${T.dim}Next TTS output will use this voice design (requires USE_VOXCPM=1).${T.reset}\n`)
      return true
    }

    if (sub === 'clone') {
      const refPath = args[1]?.trim()
      if (!refPath) {
        console.log(`\n  ${T.dim}Usage: /voice clone <path-to-reference-audio.wav>${T.reset}\n`)
        return true
      }
      const fs = require('fs')
      if (!fs.existsSync(refPath)) {
        console.log(`\n  ${T.error}✗ Reference audio file not found: ${refPath}${T.reset}\n`)
        return true
      }
      state.voiceReferencePath = refPath
      state.voiceDesign        = undefined
      console.log(`\n  ${T.ok}✓ Voice clone reference set:${T.reset} ${refPath}`)
      console.log(`  ${T.dim}Next TTS output will clone this voice (requires USE_VOXCPM=1).${T.reset}\n`)
      return true
    }

    if (sub === 'reset') {
      state.voiceDesign        = undefined
      state.voiceReferencePath = undefined
      console.log(`\n  ${T.ok}✓ Voice design/clone reset${T.reset} — standard provider chain will be used.\n`)
      return true
    }

    if (sub === 'status') {
      const voxEnabled = process.env.USE_VOXCPM === '1'
      console.log(`\n  ${T.accent}Voice status${T.reset}`)
      console.log(`  Mode:      ${state.voiceMode ? T.ok + 'ON' : T.dim + 'OFF'}${T.reset}`)
      console.log(`  VoxCPM:    ${voxEnabled ? T.ok + 'enabled (USE_VOXCPM=1)' : T.dim + 'disabled'}${T.reset}`)
      console.log(`  Design:    ${state.voiceDesign ? T.ok + '"' + state.voiceDesign + '"' : T.dim + 'none'}${T.reset}`)
      console.log(`  Clone ref: ${state.voiceReferencePath ? T.ok + state.voiceReferencePath : T.dim + 'none'}${T.reset}`)
      console.log()
      return true
    }

    // Default: toggle
    state.voiceMode = !state.voiceMode
    const onOff = state.voiceMode ? `${T.ok}ON${T.reset}` : `${T.dim}OFF${T.reset}`
    console.log(`\n  ${state.voiceMode ? T.ok + '●' : T.dim + '○'}${T.reset} Voice mode ${onOff}\n`)
    return true
  }

  // ── /speak ────────────────────────────────────────────────────────────────
  if (command === '/speak') {
    const text = args.join(' ').trim()
    if (!text) {
      console.log(`\n  ${T.dim}Usage: /speak <text>${T.reset}\n`)
      return true
    }
    const { synthesize } = await import('../core/voice/tts')
    console.log(`\n  ${T.dim}Speaking...${T.reset}`)
    const result = await synthesize({ text })
    if (result.error) {
      console.log(`  ${T.error}✗ TTS failed: ${result.error}${T.reset}\n`)
    } else {
      console.log(`  ${T.ok}✓ Spoken via ${result.provider} (${result.durationMs}ms)${T.reset}\n`)
    }
    return true
  }

  // ── /listen ───────────────────────────────────────────────────────────────
  if (command === '/listen') {
    const seconds = parseInt(args[0] ?? '5', 10)
    const duration = isNaN(seconds) || seconds < 1 ? 5 : Math.min(seconds, 60)
    const { recordAudio }  = await import('../core/voice/audio')
    const { transcribe }   = await import('../core/voice/stt')

    console.log(`\n  ${T.dim}🎤 Recording for ${duration}s... (speak now)${T.reset}`)
    let audioPath = ''
    try {
      audioPath = await recordAudio(duration)
    } catch (e: any) {
      console.log(`  ${T.error}✗ Recording failed: ${e.message}${T.reset}\n`)
      return true
    }

    console.log(`  ${T.dim}Transcribing...${T.reset}`)
    const result = await transcribe({ audioFilePath: audioPath })
    try { require('fs').unlinkSync(audioPath) } catch { /* ignore */ }

    if (!result.text) {
      const reason = result.error ?? 'No speech detected'
      console.log(`  ${T.error}✗ Transcription failed: ${reason}${T.reset}\n`)
      return true
    }

    console.log(`  ${T.ok}✓ Heard:${T.reset} ${result.text}`)
    console.log(`  ${T.dim}Provider: ${result.provider} | ${result.durationMs}ms${T.reset}\n`)

    // Submit the transcribed text as a chat message
    await streamChat(result.text)
    return true
  }

  // ── /todo ─────────────────────────────────────────────────────────────────
  if (command === '/todo') {
    const { executeTool } = await import('../core/toolRegistry')
    const sub = args[0]?.toLowerCase() ?? 'list'

    if (sub === 'add') {
      const text = args.slice(1).join(' ')
      if (!text) { console.log(`  ${T.error}✗ Usage: /todo add <text>${T.reset}\n`); return true }
      const r = await executeTool('todo', { op: 'add', text })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else if (sub === 'done' || sub === 'complete') {
      const id = args[1] ?? ''
      if (!id) { console.log(`  ${T.error}✗ Usage: /todo done <id>${T.reset}\n`); return true }
      const r = await executeTool('todo', { op: 'complete', id })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else if (sub === 'remove' || sub === 'delete') {
      const id = args[1] ?? ''
      if (!id) { console.log(`  ${T.error}✗ Usage: /todo remove <id>${T.reset}\n`); return true }
      const r = await executeTool('todo', { op: 'remove', id })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else if (sub === 'clear') {
      const r = await executeTool('todo', { op: 'clear' })
      console.log(`  ${T.ok}${r.output}${T.reset}\n`)
    } else {
      // list (default) — sub may be a filter
      const filter = ['pending', 'done'].includes(sub) ? sub : 'all'
      const r = await executeTool('todo', { op: 'list', filter })
      console.log(`\n  ${T.accent}Todo list${T.reset}`)
      console.log(`  ${T.dim}${'─'.repeat(40)}${T.reset}`)
      for (const line of (r.output || 'No items.').split('\n')) {
        console.log(`  ${T.dim}${line}${T.reset}`)
      }
      console.log()
    }
    return true
  }

  // ── /cron ─────────────────────────────────────────────────────────────────
  if (command === '/cron') {
    const { executeTool } = await import('../core/toolRegistry')
    const sub = args[0]?.toLowerCase() ?? 'list'

    if (sub === 'add') {
      // /cron add every 5 minutes -- echo heartbeat
      const rawRest = args.slice(1).join(' ')
      const sepIdx  = rawRest.indexOf(' -- ')
      if (sepIdx === -1) {
        console.log(`  ${T.error}✗ Usage: /cron add <schedule> -- <command>${T.reset}\n`)
        console.log(`  ${T.dim}Example: /cron add every 5 minutes -- echo heartbeat${T.reset}\n`)
        return true
      }
      const schedule = rawRest.slice(0, sepIdx).trim()
      const action   = rawRest.slice(sepIdx + 4).trim()
      const r = await executeTool('cronjob', { op: 'create', description: action, schedule, action })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else if (sub === 'list') {
      const r = await executeTool('cronjob', { op: 'list' })
      console.log(`\n  ${T.accent}Cron jobs${T.reset}`)
      console.log(`  ${T.dim}${'─'.repeat(50)}${T.reset}`)
      for (const line of (r.output || 'No cron jobs.').split('\n')) {
        console.log(`  ${T.dim}${line}${T.reset}`)
      }
      console.log()
    } else if (sub === 'pause') {
      const id = args[1] ?? ''
      if (!id) { console.log(`  ${T.error}✗ Usage: /cron pause <id>${T.reset}\n`); return true }
      const r = await executeTool('cronjob', { op: 'pause', id })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else if (sub === 'resume') {
      const id = args[1] ?? ''
      if (!id) { console.log(`  ${T.error}✗ Usage: /cron resume <id>${T.reset}\n`); return true }
      const r = await executeTool('cronjob', { op: 'resume', id })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else if (sub === 'delete' || sub === 'remove') {
      const id = args[1] ?? ''
      if (!id) { console.log(`  ${T.error}✗ Usage: /cron delete <id>${T.reset}\n`); return true }
      const r = await executeTool('cronjob', { op: 'delete', id })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else if (sub === 'run' || sub === 'trigger') {
      const id = args[1] ?? ''
      if (!id) { console.log(`  ${T.error}✗ Usage: /cron run <id>${T.reset}\n`); return true }
      const r = await executeTool('cronjob', { op: 'trigger', id })
      console.log(`  ${r.success ? T.ok : T.error}${r.output || r.error}${T.reset}\n`)
    } else {
      console.log(`  ${T.dim}Subcommands: add | list | pause | resume | delete | run${T.reset}\n`)
    }
    return true
  }

  // ── /vision ───────────────────────────────────────────────────────────────
  if (command === '/vision') {
    if (!args[0]) {
      console.log(`  ${T.error}✗ Usage: /vision <path|url> [prompt]${T.reset}\n`)
      return true
    }
    const imageSource = args[0]
    const prompt      = args.slice(1).join(' ') || 'Describe this image in detail.'
    const { executeTool } = await import('../core/toolRegistry')
    console.log(`\n  ${T.dim}Analyzing image...${T.reset}`)
    const r = await executeTool('vision_analyze', { image: imageSource, prompt }, 0, 45_000)
    if (!r.success) {
      console.log(`  ${T.error}✗ ${r.error || r.output}${T.reset}\n`)
    } else {
      console.log()
      const lines = r.output.split('\n')
      for (const line of lines) console.log(`  ${line}`)
      console.log()
    }
    return true
  }

  console.log(`  ${T.dim}Unknown command. /help for list.${T.reset}\n`)
  return true
}

// ── Tab completer (prefix-first, fuzzy fallback) ──────────────────────────────────

// ── v3.19 Phase 1 Commit 5: derived from TOOL_DESCRIPTIONS — literal deleted ──
// TOOL_DESCRIPTIONS is a plain object imported synchronously; no dynamic import needed.
const TOOL_NAMES: string[] = Object.keys(TOOL_DESCRIPTIONS)

// ── Live dropdown for / and @ triggers ───────────────────────────────────────
// Renders a filtered menu below the input line; arrow-key navigable.
// Completely independent of the opt-in PALETTE_ON command palette.

interface DropdownItem {
  label:       string
  description: string
  category?:   string
}

interface DropdownState {
  visible:       boolean
  items:         DropdownItem[]
  filtered:      DropdownItem[]
  selectedIndex: number
  triggerChar:   '/' | '@' | null
  query:         string
  lineCount:     number   // how many lines were drawn (for clean erasure)
  currentLine:   string   // last real input line (restored when readline hijacks ↑↓)
}

const DD_ORANGE = '\x1b[38;2;255;107;53m'
const DD_DIM    = '\x1b[2m'
const DD_RESET  = '\x1b[0m'
const DD_BOLD   = '\x1b[1m'

const dropdown: DropdownState = {
  visible: false, items: [], filtered: [], selectedIndex: 0,
  triggerChar: null, query: '', lineCount: 0, currentLine: '',
}

/** Generation-cached slash-command dropdown.
 *  Re-builds only when commandCatalog.generation() changes (register/unregister).
 *  Safe to call on every keystroke — O(1) when catalog is stable. */
let _slashGen   = -1
let _slashCache: DropdownItem[] = []

function buildSlashCommands(): DropdownItem[] {
  const gen = commandCatalog.generation()
  if (gen === _slashGen) return _slashCache
  _slashGen   = gen
  _slashCache = commandCatalog.list().map(([cmd, detail]) => ({
    label:       cmd,
    description: detail.desc,
    category:    detail.section,
  }))
  return _slashCache
}

/** Build dropdown items for all registered tool names. */
function buildToolList(): DropdownItem[] {
  return [
    { label: '@web_search',              description: 'Search the web',                    category: 'Web'     },
    { label: '@fetch_page',              description: 'Fetch a URL as text',               category: 'Web'     },
    { label: '@fetch_url',               description: 'Fetch raw URL content',             category: 'Web'     },
    { label: '@open_browser',            description: 'Open URL in browser',               category: 'Browser' },
    { label: '@browser_click',           description: 'Click element on page',             category: 'Browser' },
    { label: '@browser_type',            description: 'Type text into a field',            category: 'Browser' },
    { label: '@browser_extract',         description: 'Extract page content',              category: 'Browser' },
    { label: '@browser_screenshot',      description: 'Screenshot the active tab',         category: 'Browser' },
    { label: '@browser_scroll',          description: 'Scroll the page',                   category: 'Browser' },
    { label: '@browser_get_url',         description: 'Get current browser URL',           category: 'Browser' },
    { label: '@file_read',               description: 'Read a file',                       category: 'Files'   },
    { label: '@file_write',              description: 'Write to a file',                   category: 'Files'   },
    { label: '@file_list',               description: 'List directory contents',           category: 'Files'   },
    { label: '@shell_exec',              description: 'Run shell command',                 category: 'System'  },
    { label: '@run_python',              description: 'Execute Python code',               category: 'Code'    },
    { label: '@run_node',                description: 'Execute Node.js code',              category: 'Code'    },
    { label: '@code_interpreter_python', description: 'Python interpreter sandbox',       category: 'Code'    },
    { label: '@code_interpreter_node',   description: 'Node.js interpreter sandbox',      category: 'Code'    },
    { label: '@system_info',             description: 'OS / hardware info',               category: 'System'  },
    { label: '@notify',                  description: 'Send desktop notification',         category: 'System'  },
    { label: '@deep_research',           description: 'Multi-step web research',           category: 'Web'     },
    { label: '@get_stocks',              description: 'NSE/BSE stock data',               category: 'Finance' },
    { label: '@get_market_data',         description: 'Market data feed',                 category: 'Finance' },
    { label: '@get_company_info',        description: 'Company fundamentals',             category: 'Finance' },
    { label: '@social_research',         description: 'Social media insights',            category: 'Finance' },
    { label: '@mouse_move',              description: 'Move mouse cursor',                category: 'Vision'  },
    { label: '@mouse_click',             description: 'Click at screen coordinates',      category: 'Vision'  },
    { label: '@keyboard_type',           description: 'Type text via keyboard',           category: 'Vision'  },
    { label: '@keyboard_press',          description: 'Press a key combo',               category: 'Vision'  },
    { label: '@screenshot',              description: 'Capture full screen',              category: 'Vision'  },
    { label: '@screen_read',             description: 'OCR + describe screen',            category: 'Vision'  },
    { label: '@vision_loop',             description: 'Repeated screen observation',      category: 'Vision'  },
    { label: '@vision_analyze',          description: 'Analyze an image with AI',         category: 'Vision'  },
    { label: '@wait',                    description: 'Pause execution',                  category: 'System'  },
    { label: '@clipboard_read',          description: 'Read clipboard contents',          category: 'System'  },
    { label: '@clipboard_write',         description: 'Write to clipboard',               category: 'System'  },
    { label: '@window_list',             description: 'List open windows',                category: 'System'  },
    { label: '@window_focus',            description: 'Focus a window',                   category: 'System'  },
    { label: '@app_launch',              description: 'Launch an application',            category: 'System'  },
    { label: '@app_close',               description: 'Close an application',             category: 'System'  },
    { label: '@watch_folder',            description: 'Watch directory for changes',       category: 'Files'   },
    { label: '@watch_folder_list',       description: 'List active folder watches',       category: 'Files'   },
    { label: '@send_file_local',         description: 'Send file to local agent',         category: 'Agent'   },
    { label: '@receive_file_local',      description: 'Receive file from local agent',    category: 'Agent'   },
    { label: '@get_briefing',            description: 'Morning briefing summary',         category: 'Agent'   },
    { label: '@respond',                 description: 'Send response to user',            category: 'Agent'   },
    { label: '@clarify',                 description: 'Ask clarifying question',          category: 'Agent'   },
    { label: '@todo',                    description: 'Manage task list',                 category: 'Agent'   },
    { label: '@cronjob',                 description: 'Schedule recurring task',          category: 'System'  },
    { label: '@voice_speak',             description: 'Speak text via TTS',              category: 'Voice'   },
    { label: '@voice_transcribe',        description: 'Transcribe audio file',            category: 'Voice'   },
    { label: '@voice_clone',             description: 'Clone a voice',                    category: 'Voice'   },
    { label: '@voice_design',            description: 'Design a custom voice',            category: 'Voice'   },
    { label: '@lookup_skill',            description: 'Look up an installed skill',       category: 'Skills'  },
    { label: '@lookup_tool_schema',      description: 'Get tool JSON schema',             category: 'Agent'   },
    { label: '@spawn',                   description: 'Spawn subagent (shorthand)',       category: 'Agent'   },
    { label: '@spawn_subagent',          description: 'Run isolated subagent',            category: 'Agent'   },
    { label: '@swarm',                   description: 'Parallel subagent swarm',          category: 'Agent'   },
    { label: '@ingest_youtube',          description: 'Download & transcribe YouTube',    category: 'Web'     },
    { label: '@run_agent',               description: 'Run a named agent definition',     category: 'Agent'   },
  ]
}

/**
 * Erase the drawn dropdown lines from the terminal.
 * Preserves all state (filtered/items/query) so re-render works after navigation.
 */
function eraseDropdown(): void {
  if (dropdown.lineCount === 0) return
  const n = dropdown.lineCount
  // Move down one row at a time (cursor-down never scrolls), clear each line,
  // then jump back up — all relative moves so terminal scroll can't invalidate them.
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[1B\r\x1b[2K')  // cursor-down 1 + carriage-return + erase line
  }
  process.stdout.write(`\x1b[${n}A`)           // cursor-up n lines — back on the input row
  dropdown.lineCount = 0
}

/**
 * Draw the filtered dropdown below the current input line.
 * Call eraseDropdown() first when re-rendering after navigation.
 */
function renderDropdown(): void {
  // Always erase any existing render first so we never stack dropdowns.
  eraseDropdown()

  if (dropdown.filtered.length === 0) return

  const MAX_ITEMS = 6
  const items     = dropdown.filtered.slice(0, MAX_ITEMS)
  const longest   = Math.max(...items.map(i => i.label.length))
  let   lineCount = 0

  items.forEach((item, idx) => {
    const isSelected = idx === dropdown.selectedIndex
    const bullet     = isSelected ? `${DD_ORANGE}>${DD_RESET}` : ' '
    const labelStyle = isSelected ? `${DD_ORANGE}${DD_BOLD}` : ''
    const pad        = ' '.repeat(longest - item.label.length + 2)
    // cursor-down (no scroll) → overwrite line → increment count
    process.stdout.write(
      `\x1b[1B\r\x1b[2K${bullet} ${labelStyle}${item.label}${DD_RESET}${pad}${DD_DIM}${item.description}${DD_RESET}`
    )
    lineCount++
  })

  // Footer hint line
  if (dropdown.filtered.length > MAX_ITEMS) {
    process.stdout.write(
      `\x1b[1B\r\x1b[2K${DD_DIM}  v ${dropdown.filtered.length - MAX_ITEMS} more  up/dn navigate  Tab select${DD_RESET}`
    )
  } else {
    process.stdout.write(
      `\x1b[1B\r\x1b[2K${DD_DIM}  up/dn navigate  Tab/Enter select  Esc close${DD_RESET}`
    )
  }
  lineCount++

  dropdown.lineCount = lineCount
  dropdown.visible   = true

  // Return to input row (relative-up, immune to scroll), go to col 0, erase line,
  // then re-emit prompt + input.  Do NOT call _refreshLine() — it emits \x1b[0J
  // (erase to end of screen) which would wipe the dropdown we just drew.
  process.stdout.write(`\x1b[${lineCount}A\r\x1b[K`)
  process.stdout.write(getPrompt() + dropdown.currentLine)

  // Keep readline's internal state in sync for the next keystroke
  if (_activeRL) {
    ;(_activeRL as any).line   = dropdown.currentLine
    ;(_activeRL as any).cursor = dropdown.currentLine.length
  }
}

/** Erase visual + full state reset (dismiss). */
function clearDropdown(): void {
  eraseDropdown()
  dropdown.visible       = false
  dropdown.filtered      = []
  dropdown.items         = []
  dropdown.selectedIndex = 0
  dropdown.query         = ''
  dropdown.triggerChar   = null
  dropdown.currentLine   = ''
}

function completer(line: string): [string[], string] {
  // Suppress readline's own Tab completion while our dropdown is handling it
  if (dropdown.visible) return [[], line]

  // ── Slash-command completion (/history, /skills, …) ───────────────────────
  if (line.startsWith('/')) {
    const prefix = COMMANDS.filter(c => c.startsWith(line))
    if (prefix.length > 0) return [prefix, line]
    // Fuzzy fallback: all chars of line (minus /) appear in order in command
    const needle = line.slice(1)
    const fuzzy  = COMMANDS.filter(c => fuzzyCmd(needle, c.slice(1)))
    return [fuzzy.length ? fuzzy : [], line]
  }

  // ── Tool-name completion (@web → @web_search, @open_browser, …) ──────────
  if (line.startsWith('@')) {
    const needle  = line.slice(1).toLowerCase()
    const matches = TOOL_NAMES
      .filter(t => t.startsWith(needle))
      .map(t => `@${t}`)
    if (matches.length > 0) return [matches, line]
    // Fuzzy fallback
    const fuzzy = TOOL_NAMES
      .filter(t => fuzzyCmd(needle, t))
      .map(t => `@${t}`)
    return [fuzzy.length ? fuzzy : [], line]
  }

  return [[], line]
}

// ── Session resume helpers ─────────────────────────────────────────────────────────

async function loadSession(id: string): Promise<void> {
  const session = await apiFetch<any>(`/api/sessions/${id}`, null)
  if (!session || !Array.isArray(session.exchanges)) {
    console.log(`\n  ${T.error}✗ Session "${id}" not found.${T.reset}`)
    console.log(`  ${T.dim}Use --list to see available sessions.${T.reset}\n`)
    process.exit(1)
  }

  // Reuse the old session ID so the server loads the right memory context
  SESSION_ID   = session.id || id
  RESUMED_FROM = SESSION_ID

  // Populate local history so streamChat includes prior context in histPayload
  for (const ex of session.exchanges as any[]) {
    if (ex.userMessage?.trim()) state.history.push({ role: 'user',      content: ex.userMessage })
    if (ex.aiReply?.trim())     state.history.push({ role: 'assistant', content: ex.aiReply     })
  }
  // Cap at 20 to avoid context bloat
  if (state.history.length > 20) state.history = state.history.slice(-20)

  // Print recap
  const ago      = session.updatedAt ? fmtDuration(Date.now() - session.updatedAt) : 'unknown'
  const msgCount = session.messageCount ?? (session.exchanges as any[]).length
  const lastUser = (session.exchanges as any[]).filter((e: any) => e.userMessage?.trim()).slice(-1)[0]
  const lastMsg  = lastUser?.userMessage || ''
  const preview  = lastMsg
    ? `"${lastMsg.slice(0, 55).replace(/\n/g, ' ')}${lastMsg.length > 55 ? '...' : ''}"`
    : ''
  const div = `  ${T.dim}${'─'.repeat(cols() - 4)}${T.reset}`

  console.log()
  console.log(`  ${T.accent}◆${T.reset} Resumed session`)
  console.log(div)
  console.log(`  ${'ID'.padEnd(12)}${T.dim}${SESSION_ID}${T.reset}`)
  console.log(`  ${'Last active'.padEnd(12)}${T.dim}${ago} ago${T.reset}`)
  console.log(`  ${'Messages'.padEnd(12)}${T.dim}${msgCount}${T.reset}`)
  if (preview) console.log(`  ${'Last msg'.padEnd(12)}${T.dim}${preview}${T.reset}`)
  console.log(div)
  console.log()
}

async function resolveSessionArgs(): Promise<void> {
  const args = process.argv.slice(2)

  // ── --list / -l ──────────────────────────────────────────────────────────────
  if (args.includes('--list') || args.includes('-l')) {
    const sessions = await apiFetch<any[]>('/api/sessions', [])
    if (!sessions || sessions.length === 0) {
      console.log(`\n  ${T.dim}No sessions found.${T.reset}\n`)
    } else {
      console.log()
      console.log(`  Recent Sessions`)
      console.log(`  ${T.dim}${'─'.repeat(cols() - 4)}${T.reset}`)
      for (const s of sessions.slice(0, 15)) {
        const ago   = fmtDuration(Date.now() - s.timestamp)
        const msgs  = `${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}`
        const idStr = s.id.length > 22 ? `...${s.id.slice(-18)}` : s.id
        const prev  = (s.preview || '').slice(0, 40)
        console.log(`  ${T.accent}${idStr}${T.reset}  ${T.dim}${ago.padEnd(10)} · ${msgs.padEnd(8)}${T.reset}  ${prev}`)
      }
      console.log()
      console.log(`  ${T.dim}Resume: npm run cli -- --resume <id>${T.reset}`)
      console.log()
    }
    process.exit(0)
  }

  // ── --continue / -c ──────────────────────────────────────────────────────────
  if (args.includes('--continue') || args.includes('-c')) {
    const sessions = await apiFetch<any[]>('/api/sessions', [])
    const last     = sessions?.[0]
    if (!last) {
      console.log(`\n  ${T.dim}No previous session found.${T.reset}\n`)
      return
    }
    await loadSession(last.id)
    return
  }

  // ── --resume <id> / -r <id> ───────────────────────────────────────────────────
  const rIdx = Math.max(args.indexOf('--resume'), args.indexOf('-r'))
  if (rIdx >= 0) {
    const id = args[rIdx + 1]
    if (!id || id.startsWith('-')) {
      console.log(`\n  ${T.error}✗ --resume requires a session ID.${T.reset}`)
      console.log(`  ${T.dim}Example: npm run cli -- --resume session_1744899123456${T.reset}`)
      console.log(`  ${T.dim}List sessions: npm run cli -- --list${T.reset}\n`)
      process.exit(1)
    }
    await loadSession(id)
    return
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const localCommand = resolveDesktopApiClientLocalCommand(process.argv.slice(2), VERSION)
  if (localCommand !== null) {
    process.stdout.write(localCommand)
    return
  }
  // ── Windows VT / ANSI init ──────────────────────────────────────────────────
  if (process.platform === 'win32') {
    try {
      // Spawning any shell command activates the ConPTY VT pipeline on older hosts
      const { execSync } = require('child_process')
      execSync('', { shell: true, stdio: 'ignore' })
      // UTF-8 codepage — ensures Unicode chars render correctly in Windows terminals
      execSync('chcp 65001', { shell: true, stdio: 'ignore' })
    } catch { /* ignore */ }
    if (process.stdout.isTTY) {
      process.env.FORCE_COLOR = '3'
      if (!process.env.TERM) process.env.TERM = 'xterm-256color'
    }
  }

  const health = await apiFetch<any>('/api/health', null)
  if (!health || health.status !== 'ok') {
    console.log(`\n  ${T.error}✗ Cannot connect to Aiden at ${API_BASE}${T.reset}`)
    if (process.env.AIDEN_CLI_MODE === '1') {
      const logFile = process.env.AIDEN_LOG_FILE || '(unknown log path)'
      console.log(`  ${T.dim}[CLI] API server did not start. Check logs at ${logFile}${T.reset}\n`)
    } else {
      console.log(`  ${T.dim}Start the Aiden desktop app first, or set AIDEN_API env var.${T.reset}\n`)
    }
    process.exit(1)
  }

  await resolveSessionArgs()

  await printBanner()

  const rl = readline.createInterface({
    input    : process.stdin,
    output   : process.stdout,
    prompt   : getPrompt(),
    completer,
    terminal : true,
  })
  _activeRL = rl

  _rl = rl  // expose to streamChat for pause/resume during streaming

  rl.prompt()

  // ── Register clarify bus handler ─────────────────────────────────────────
  // When the agent calls the `clarify` tool mid-task, this intercepts the
  // question, renders it to the terminal, and waits for user input.
  ;(async () => {
    const { registerClarifyHandler, answer: clarifyAnswer } = await import('../core/clarifyBus')
    registerClarifyHandler(req => {
      process.stdout.write('\n')
      console.log(`  ${T.accent}? Clarify:${T.reset} ${req.question}`)
      if (req.options?.length) {
        req.options.forEach((opt, i) => {
          console.log(`  ${T.dim}  [${i + 1}] ${opt}${T.reset}`)
        })
        const hint = req.allowFreeText ? '  (type a number or your own answer)' : '  (type a number)'
        console.log(`  ${T.dim}${hint}${T.reset}`)
      }
      rl.question(`  ${T.accent}›${T.reset} `, (input: string) => {
        const trimmed = input.trim()
        let resolved  = trimmed
        // If options were shown and user typed a number, map to the option text
        if (req.options?.length && /^\d+$/.test(trimmed)) {
          const idx = parseInt(trimmed, 10) - 1
          if (idx >= 0 && idx < req.options.length) resolved = req.options[idx]
        }
        clarifyAnswer(req.id, resolved || req.options?.[0] || '')
        rl.prompt()
      })
    })
  })()

  let histIdx      = -1
  let lastCtrlC    = 0
  let paletteActive = false

  // Command palette is opt-in only (set AIDEN_PALETTE=true to enable beta)
  const PALETTE_ON = process.env.AIDEN_PALETTE === 'true'
                  && process.stdout.isTTY
                  && process.stdin.isTTY

  // readline.createInterface({ terminal: true }) internally calls
  // readline.emitKeypressEvents(process.stdin) and setRawMode(true), so
  // keypress events are emitted on process.stdin — NOT on the rl Interface.
  // We must register here, not on rl.
  process.stdin.on('keypress', (_ch: any, key: any) => {
    if (!key) return

    // ── Skill Store pager navigation ──────────────────────────────────────────
    // Active only while /skills list is showing a multi-page table.
    if (pagerActive && pagerState) {
      // Erase whatever readline echoed before our handler fired
      ;(rl as any).line   = ''
      ;(rl as any).cursor = 0
      readline.clearLine(process.stdout, 0)
      readline.cursorTo(process.stdout, 0)

      const { skills, pageIndex, pageSize } = pagerState
      const totalPages = Math.ceil(Math.max(skills.length, 1) / pageSize)

      // EXIT — q / Esc / Ctrl+C
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        pagerActive = false
        pagerState  = null
        process.stdout.write('\n')
        rl.prompt()
        return
      }

      // NEXT PAGE — n / ↓ / → / Space / Enter
      if (
        key.name === 'n' ||
        key.name === 'down' ||
        key.name === 'right' ||
        key.name === 'space' ||
        key.name === 'return'
      ) {
        if (pageIndex < totalPages - 1) {
          pagerState.pageIndex = pageIndex + 1
          console.clear()
          renderSkillsPage(skills, pagerState.pageIndex, pageSize)
        }
        return
      }

      // PREV PAGE — p / ↑ / ←
      if (key.name === 'p' || key.name === 'up' || key.name === 'left') {
        if (pageIndex > 0) {
          pagerState.pageIndex = pageIndex - 1
          console.clear()
          renderSkillsPage(skills, pagerState.pageIndex, pageSize)
        }
        return
      }

      // Absorb all other keys while pager is active
      return
    }

    // ── Command palette triggers (opt-in beta: AIDEN_PALETTE=true) ────────────
    if (PALETTE_ON && !paletteActive) {
      const currentLine: string = (rl as any).line || ''

      // Trigger 1: '/' typed on an empty buffer  →  full palette
      if (key.sequence === '/' && currentLine === '/') {
        paletteActive = true
        rl.pause()
        readline.clearLine(process.stdout, 0)
        readline.cursorTo(process.stdout, 0)
        ;(rl as any).line   = ''
        ;(rl as any).cursor = 0
        ;(async () => {
          try {
            const { showPalette } = await import('./commandPalette')
            const chosen = await showPalette('', getCatalog())
            if (chosen !== null) {
              paletteActive = false
              rl.resume()
              await handleCommand(chosen, rl)
            }
          } catch { /* ExitPromptError — fall through */ }
          finally {
            paletteActive = false
            rl.setPrompt(getPrompt())
            rl.resume()
            rl.prompt()
          }
        })()
        return
      }

      // Trigger 2: Tab on a partial '/cmd'  →  palette pre-filtered to prefix
      if (key.name === 'tab' && currentLine.startsWith('/') && currentLine.length > 1) {
        paletteActive = true
        const partial = currentLine
        rl.pause()
        readline.clearLine(process.stdout, 0)
        readline.cursorTo(process.stdout, 0)
        ;(rl as any).line   = ''
        ;(rl as any).cursor = 0
        ;(async () => {
          try {
            const { showPalette } = await import('./commandPalette')
            const chosen = await showPalette(partial, getCatalog())
            if (chosen !== null) {
              paletteActive = false
              rl.resume()
              await handleCommand(chosen, rl)
            } else {
              ;(rl as any).line   = partial
              ;(rl as any).cursor = partial.length
              ;(rl as any)._refreshLine?.()
            }
          } catch { /* ExitPromptError — fall through */ }
          finally {
            paletteActive = false
            rl.setPrompt(getPrompt())
            rl.resume()
            rl.prompt()
          }
        })()
        return
      }
    }

    // ── Dropdown key handling (intercepts ↑↓ Tab Esc when visible) ──────────
    // Must run BEFORE history navigation so the arrow keys are claimed by the
    // dropdown instead of scrolling through history.
    // We also restore (rl as any).line to dropdown.currentLine because readline
    // processes ↑/↓ for its own history BEFORE our keypress handler fires.
    if (dropdown.visible) {
      if (key.name === 'up') {
        dropdown.selectedIndex = Math.max(0, dropdown.selectedIndex - 1)
        renderDropdown()
        return
      }
      if (key.name === 'down') {
        dropdown.selectedIndex = Math.min(dropdown.filtered.length - 1, dropdown.selectedIndex + 1)
        renderDropdown()
        return
      }
      if (key.name === 'escape') {
        clearDropdown()
        ;(rl as any).line   = dropdown.currentLine
        ;(rl as any).cursor = dropdown.currentLine.length
        ;(rl as any)._refreshLine?.()
        return
      }
      if (key.name === 'tab') {
        const selected = dropdown.filtered[dropdown.selectedIndex]
        if (selected) {
          clearDropdown()
          const insert = selected.label + ' '
          ;(rl as any).line   = insert
          ;(rl as any).cursor = insert.length
          ;(rl as any)._refreshLine?.()
        }
        return
      }
    }

    // ── History navigation (↑/↓) ─────────────────────────────────────────────
    if (key.name === 'up') {
      if (histIdx < state.inputHistory.length - 1) {
        histIdx++
        const entry = state.inputHistory[state.inputHistory.length - 1 - histIdx] || ''
        ;(rl as any).line   = entry
        ;(rl as any).cursor = entry.length
        ;(rl as any)._refreshLine?.()
      }
    } else if (key.name === 'down') {
      if (histIdx > 0) {
        histIdx--
        const entry = state.inputHistory[state.inputHistory.length - 1 - histIdx] || ''
        ;(rl as any).line   = entry
        ;(rl as any).cursor = entry.length
        ;(rl as any)._refreshLine?.()
      } else {
        histIdx             = -1
        ;(rl as any).line   = ''
        ;(rl as any).cursor = 0
        ;(rl as any)._refreshLine?.()
      }
    }

    // ── Dropdown trigger detection ────────────────────────────────────────────
    // setTimeout(0) ensures we read (rl as any).line AFTER readline has updated
    // it for this keypress.  All early-return paths above (pager, palette,
    // dropdown nav, history nav) skip this block — it only fires during
    // normal character typing.
    setTimeout(() => {
      const line: string = (rl as any).line ?? ''

      if (line.startsWith('/')) {
        const query    = line.slice(1).toLowerCase()
        const allItems = buildSlashCommands()
        let filtered: typeof allItems
        if (query === '') {
          filtered = allItems
        } else {
          // Prefix-first: /s → /skills /status /save … NOT /reset
          const prefix = allItems.filter(i => i.label.toLowerCase().slice(1).startsWith(query))
          const substr = allItems.filter(i =>
            !i.label.toLowerCase().slice(1).startsWith(query) &&
            i.label.toLowerCase().includes(query)
          )
          filtered = [...prefix, ...substr]
        }
        dropdown.triggerChar   = '/'
        dropdown.items         = allItems
        dropdown.filtered      = filtered
        dropdown.query         = query
        dropdown.selectedIndex = 0
        dropdown.currentLine   = line
        if (filtered.length > 0) renderDropdown()
        else clearDropdown()

      } else if (line.includes('@')) {
        const lastAt  = line.lastIndexOf('@')
        const partial = line.slice(lastAt + 1).toLowerCase()
        if (!partial.includes(' ')) {
          const allItems = buildToolList()
          const filtered = partial === ''
            ? allItems
            : allItems.filter(item => item.label.toLowerCase().slice(1).startsWith(partial))
          dropdown.triggerChar   = '@'
          dropdown.items         = allItems
          dropdown.filtered      = filtered
          dropdown.query         = partial
          dropdown.selectedIndex = 0
          dropdown.currentLine   = line
          if (filtered.length > 0) renderDropdown()
          else clearDropdown()
        } else {
          // Space after @word means the tool name is complete — close
          if (dropdown.visible && dropdown.triggerChar === '@') clearDropdown()
        }

      } else {
        if (dropdown.visible) clearDropdown()
      }
    }, 0)
  })

  rl.on('SIGINT', async () => {
    if (state.streaming) {
      state.abortCtrl?.abort()
      void apiPost('/api/stop')
      return
    }
    const now = Date.now()
    if (now - lastCtrlC < 2000) {
      printSessionSummary()
      apiPost('/api/sessions/distill', { sessionId: SESSION_ID }).catch(() => {})
      setTimeout(() => process.exit(0), 5_000)
      return
    }
    lastCtrlC = now
    process.stdout.write(`\n  ${T.dim}Press Ctrl+C again to exit.${T.reset}\n`)
    rl.prompt()
  })

  rl.on('line', async (line: string) => {
    histIdx = -1
    if (dropdown.visible) clearDropdown()
    // Defensive: if Enter was pressed while pager was active, exit pager cleanly
    if (pagerActive) { pagerActive = false; pagerState = null }
    const input = line.trim()
    if (!input) { rl.prompt(); return }

    if (state.inputHistory[state.inputHistory.length - 1] !== input) {
      state.inputHistory.push(input)
      if (state.inputHistory.length > 200) state.inputHistory.shift()
    }

    if (input.startsWith('/')) {
      await handleCommand(input, rl)
      rl.prompt()
      return
    }

    // Prepend any pending attachments as context
    let finalMsg = input
    if (state.attachments.length > 0) {
      const parts: string[] = []
      for (const p of state.attachments) {
        try {
          const content = fs.readFileSync(p, 'utf-8').slice(0, 8000)
          parts.push(`<attachment path="${p}">\n${content}\n</attachment>`)
        } catch {
          parts.push(`<attachment path="${p}" error="could not read" />`)
        }
      }
      parts.push(input)
      finalMsg = parts.join('\n\n')
      state.attachments = []
      console.log(`  ${T.dim}Attached ${parts.length - 1} file(s) — cleared after send.${T.reset}`)
    }

    await streamChat(finalMsg)
    rl.prompt()
  })

  rl.on('close', () => {
    printSessionSummary()
    process.exit(0)
  })
}

/** Programmatic entry point — connect to an already-running API server and start the REPL. */
export async function run(): Promise<void> { return main() }

// Guard against auto-running when required as a module (packages/aiden-os in-process launch).
if (require.main === module) {
  // ── Subcommand dispatch ───────────────────────────────────────
  if (process.argv[2] === 'uninstall') {
    // aiden uninstall [--keep-workspace] [--keep-config] [--yes]
    const { spawnSync } = require('child_process')
    const { existsSync } = require('fs')
    const { resolve }    = require('path')
    const flags: string[] = []
    if (process.argv.includes('--keep-workspace')) flags.push('-KeepWorkspace')
    if (process.argv.includes('--keep-config'))    flags.push('-KeepConfig')
    if (process.argv.includes('--yes') || process.argv.includes('-y')) flags.push('-Yes')

    const localScript = resolve(__dirname, '..', 'scripts', 'uninstall.ps1')
    const hasLocal    = existsSync(localScript)
    let result
    if (hasLocal) {
      result = spawnSync(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-File', localScript, ...flags],
        { stdio: 'inherit', shell: false },
      )
    } else {
      const flagStr = flags.length ? ` ${flags.join(' ')}` : ''
      const cmd = `& ([scriptblock]::Create((irm 'https://aiden.taracod.com/uninstall.ps1')))${flagStr}`
      result = spawnSync(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { stdio: 'inherit', shell: false },
      )
    }
    process.exit(result.status ?? 0)
  } else if (process.argv[2] === 'mcp') {
    if (process.argv[3] === 'inspect') {
      // aiden mcp inspect — list exposed tools as JSON (debug helper)
      // Deferred import avoids loading API server in stdio MCP mode
      const { SAFE_TOOLS, DESTRUCTIVE_TOOLS, getExposedTools } = require('../api/mcp')
      const exposed = getExposedTools()
      process.stdout.write(JSON.stringify({
        total:              exposed.length,
        safeTools:          SAFE_TOOLS.length,
        destructiveTools:   DESTRUCTIVE_TOOLS.length,
        destructiveEnabled: process.env.MCP_ALLOW_DESTRUCTIVE === 'true',
        tools:              exposed,
      }, null, 2) + '\n')
      process.exit(0)
    } else {
      // aiden mcp — start stdio MCP server
      const { startMCPServer } = require('../api/mcp')
      startMCPServer().catch((err: Error) => {
        process.stderr.write(`[mcp] Fatal: ${err.message}\n`)
        process.exit(1)
      })
      // Process stays alive; MCP server runs until stdin closes
    }
  } else {
    // ── Normal CLI mode ──────────────────────────────────────────
    main().catch((e: Error) => { console.error('[CLI] Fatal:', e.message); process.exit(1) })
  }
}
