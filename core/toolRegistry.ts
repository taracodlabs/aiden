// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/toolRegistry.ts — Centralized tool registry with real Playwright
// browser automation, file I/O, shell exec, and web utilities.

import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import fs   from 'fs'
import path from 'path'
import os   from 'os'
import { randomUUID } from 'crypto'
import { getUserDataDir } from './paths'
import { executeWithDurableToolCall } from './v4/daemon/jobExecutionContext'

import {
  moveMouse,
  clickMouse,
  typeText,
  pressKey,
  takeScreenshot,
  readScreen,
  openBrowser,
  visionLoop,
} from './computerControl'

import { reliableWebSearch, deepResearch as deepResearchFn } from './webSearch'
import { conversationMemory } from './conversationMemory'
import { minimatch } from 'minimatch'
import { generateBriefing, loadBriefingConfig }              from './morningBriefing'
import { getMarketData }   from './tools/marketDataTool'
import { getCompanyInfo }  from './tools/companyFilingsTool'
import { mcpClient }       from './mcpClient'
import { runInSandbox }         from './codeInterpreter'
import { runInDockerSandbox }   from './sandboxRunner'
import { responseCache }   from './responseCache'
import { permissionSystem } from './permissionSystem'
import { extractYouTubeTranscript } from './youtubeTranscript'
import { knowledgeBase }            from './knowledgeBase'
import { getCalendarEvents }        from './tools/calendarTool'
import { getNowPlaying }            from './tools/nowPlaying'
import { readGmail, sendGmail }     from './tools/gmailTool'
import { loadConfig }               from '../providers/index'
import {
  pwNavigate,
  pwScreenshot,
  pwClick,
  pwClickFirstResult,
  pwType,
  pwScroll,
  pwSnapshot,
  pwGetUrl,
  pwClose,
  getActiveBrowserPage as _getBridgePage,
} from './playwrightBridge'

const execAsync = promisify(exec)

// ── Shared path normalizer ─────────────────────────────────────

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

// ── Protected files — cannot be written by agents ─────────────
// GOALS.md is here to prevent arbitrary file_write overwrites.
// The manage_goals tool writes it directly (bypasses file_write),
// so goal management still works — only uncontrolled writes are blocked.

const PROTECTED_FILES = [
  'config/devos.config.json',
  'workspace/STANDING_ORDERS.md',
  'workspace/SOUL.md',
  'workspace/USER.md',
  'workspace/HEARTBEAT.md',
  'workspace/GOALS.md',
  '.env',
  '.env.local',
  'tsconfig.json',
  'package.json',
  'vitest.config.ts',
  'jest.config.ts',
]

function isProtectedFile(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath).replace(/^\.\//, '')
  // Block test/config file writes (prevents agents from cheating tests)
  if (normalized.endsWith('.test.ts') || normalized.endsWith('.spec.ts')) return true
  if (normalized.endsWith('vitest.config.ts') || normalized.endsWith('jest.config.ts')) return true
  return PROTECTED_FILES.some(f => normalized.endsWith(f) || normalized === f)
}

// ── Path deny rules ───────────────────────────────────────────

const DENIED_PATHS = [
  '**/.ssh/**', '**/.aws/**', '**/.env*', '**/.gnupg/**',
  '**/credentials*', '**/*.pem', '**/*.key',
  '**/id_rsa*', '**/id_ed25519*',
]

function isPathDenied(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath)
  return DENIED_PATHS.some(pattern => minimatch(normalized, pattern, { dot: true }))
}

// ── Command deny rules ────────────────────────────────────────

const DENIED_COMMANDS: RegExp[] = [
  /curl\s+.*\|\s*bash/i,
  /wget\s+.*\|\s*bash/i,
  /rm\s+-rf\s+\//,
  /powershell.*-enc\s/i,
  /powershell.*-encodedcommand/i,
  /iex\s*\(/i,
  /Invoke-Expression/i,
  // ── Sprint 25: extended deny patterns ─────────────────────────
  /Invoke-WebRequest.*\|/i,
  /Start-Process\s/i,
  /\breg\s+(add|delete)/i,
  /\bschtasks\s/i,
  /\bwmic\s+process\s+call/i,
  /\bnet\s+user\b/i,
  /Set-ExecutionPolicy/i,
  /\bNew-Service\b/i,
  // ── C7: path-scoped deny — Remove-Item on critical system / user paths ──────
  // Belt-and-suspenders: Remove-Item is also removed from SHELL_ALLOWLIST so it
  // requires explicit approval. These patterns hard-block attempts to target
  // system-owned directories regardless of approval state.
  /Remove-Item\b.*[Cc]:[/\\][Uu]sers[/\\]/i,
  /Remove-Item\b.*[Cc]:[/\\][Ww]indows[/\\]/i,
  /Remove-Item\b.*[Cc]:[/\\][Pp]rogram/i,
]

export function isCommandDenied(cmd: string): boolean {
  return DENIED_COMMANDS.some(p => p.test(cmd))
}

// ── Sprint 24: active folder-watcher registry ─────────────────
const activeWatchers = new Map<string, fs.FSWatcher>()

// ── CommandGate: dangerous shell command patterns ──────────────
const SHELL_DANGEROUS_PATTERNS = [
  'rm -rf', 'rm -r /', 'del /f /s', 'del /s /q',
  'format c:', 'format c :', 'diskpart',
  'shutdown /s', 'shutdown -s',
  'reg delete', 'reg add hklm',
  'remove-item -recurse -force', 'remove-item -force -recurse',
  'format-volume', 'clear-disk', 'stop-computer', 'restart-computer',
]

function isShellDangerous(cmd: string): boolean {
  const lower = cmd.toLowerCase()
  return SHELL_DANGEROUS_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}

// ── C8: Code-level destructive path guard for run_node / run_python ──────────
// Scans code strings for destructive filesystem operations targeting protected
// system paths. Closes the bypass where the planner re-routes through run_node
// or run_python after shell_exec is denied by DENIED_COMMANDS.
//
// Two-stage check: (1) code contains a destructive fs call, AND (2) code
// references a protected path. Both must match for denial — benign code that
// merely reads protected paths, or destructive code targeting workspace, passes.

const PROTECTED_PATH_PATTERNS: RegExp[] = [
  // {1,2} so we match both real paths (C:\Users\) and string-literal escapes (C:\\Users\\)
  /[Cc]:[/\\]{1,2}[Uu]sers[/\\]{1,2}/,
  /[Cc]:[/\\]{1,2}[Ww]indows[/\\]{1,2}/,
  /[Cc]:[/\\]{1,2}[Pp]rogram\s?[Ff]iles/,
  /[Cc]:[/\\]{1,2}[Ss]ystem/,
  /['"`]\/etc[/'"` ]/,
  /['"`]\/home[/'"` ]/,
  /['"`]\/usr[/'"` ]/,
  /['"`]\/var[/'"` ]/,
]

const CODE_DESTRUCTIVE_NODE: RegExp[] = [
  /\bfs\s*\.\s*rmSync\b/,
  /\bfs\s*\.\s*unlinkSync\b/,
  /\bfs\s*\.\s*rmdirSync\b/,
  /\bfs\.promises\s*\.\s*rm\b/,
  /\bfs\.promises\s*\.\s*unlink\b/,
  /\bfs\.promises\s*\.\s*rmdir\b/,
  /\brimraf\b/,
  /\bfs\s*\.\s*rm\s*\(/,
  /\bdel\s*\(/,          // fs-extra del()
  /\bunlinkSync\s*\(/,   // bare import
]

const CODE_DESTRUCTIVE_PYTHON: RegExp[] = [
  /\bos\s*\.\s*remove\b/,
  /\bos\s*\.\s*unlink\b/,
  /\bos\s*\.\s*rmdir\b/,
  /\bos\s*\.\s*removedirs\b/,
  /\bshutil\s*\.\s*rmtree\b/,
  /\bpathlib\b.*\bunlink\b/,
  /\bsend2trash\b/,
]

export function scanCodeForDestructivePaths(
  code: string,
  lang: 'node' | 'python',
): { denied: boolean; reason: string } {
  const destructivePatterns = lang === 'node' ? CODE_DESTRUCTIVE_NODE : CODE_DESTRUCTIVE_PYTHON
  const matchedOp = destructivePatterns.find(p => p.test(code))
  if (!matchedOp) return { denied: false, reason: '' }

  const matchedPath = PROTECTED_PATH_PATTERNS.find(p => p.test(code))
  if (!matchedPath) return { denied: false, reason: '' }

  const opStr = code.match(matchedOp)?.[0] ?? 'destructive op'
  const pathStr = code.match(matchedPath)?.[0] ?? 'protected path'
  const reason = `[Security] ${lang} code blocked: "${opStr}" targeting "${pathStr}" — destructive operation on protected system path`
  process.stderr.write(reason + '\n')
  return { denied: true, reason }
}

// ── Sprint 25: Shell command allowlist ────────────────────────
// Unknown commands (not in this list) are blocked and require explicit user approval.

const SHELL_ALLOWLIST: RegExp[] = [
  // 1. File system reads
  /^(ls|dir|cat|type|head|tail|more|less|pwd|tree)\b/i,
  // 2. File/dir create, copy, move, shell navigation
  /^(mkdir|md|cp|copy|mv|move|xcopy|robocopy|echo|touch|cd|cls|clear|set|export)\b/i,
  // 3. Git
  /^git\b/i,
  // 4. Node / npm / npx / yarn / pnpm / bun
  /^(node|npm|npx|yarn|pnpm|bun)\b/i,
  // 5. Python / pip
  /^(python|python3|pip|pip3)\b/i,
  // 6. TypeScript compiler, linting, test runners
  /^(tsc|eslint|prettier|ts-node|vitest|jest|mocha)\b/i,
  // 7. Build tools: Cargo, Go, dotnet
  /^(cargo|go|dotnet)\b/i,
  // 8. Text search & manipulation
  /^(grep|rg|find|sed|awk|sort|uniq|wc|cut|tr|jq)\b/i,
  // 9. Network info (read-only; curl/wget pipe-to-bash blocked by denylist above)
  /^(ping|nslookup|tracert|traceroute|curl|wget)\b/i,
  // 10. System info (read-only)
  /^(systeminfo|tasklist|whoami|ipconfig|hostname|ver|uname|df|du|free|ps|top)\b/i,
  // 11. Archive tools
  /^(tar|zip|unzip|7z|gzip|gunzip)\b/i,
  // 12. PowerShell safe cmdlets (read, navigate, item management, output)
  // Note: Remove-Item intentionally absent — falls through to needsApproval:true (C7).
  // Hard-deny for Remove-Item on critical paths is in DENIED_COMMANDS above.
  /^(Get-|Select-|Where-|Sort-|Format-|Out-|Write-Output|Write-Host|ConvertTo-|ConvertFrom-|Measure-|Test-Path|Resolve-Path|Split-Path|Join-Path|Compare-Object|New-Item|Copy-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Clear-Content|Set-Location|Push-Location|Pop-Location)/i,
  // 13. Instant Actions: lock screen (rundll32) and volume one-liners (powershell -c)
  /^rundll32\b/i,
  /^powershell\s+-c\b/i,
  // 14. Process / app control — close named apps by name (user-directed, not destructive)
  /^taskkill\s+\/im\s+\S+/i,           // taskkill /im chrome.exe
  /^taskkill\s+\/f\s+\/im\s+\S+/i,     // taskkill /f /im chrome.exe
  /^Stop-Process\s+-Name\b/i,           // Stop-Process -Name chrome
  /^Stop-Process\s+-Id\b/i,             // Stop-Process -Id 1234
  /^kill\b/i,                           // kill <pid> (Unix/WSL)
  // 15. Volume / brightness / display controls
  /^nircmd\b/i,
  // 16. Windows window management
  /^(start|explorer)\b/i,
]

export function isCommandAllowed(cmd: string): { allowed: boolean; needsApproval: boolean } {
  // Hard-block: denylist and dangerous patterns take priority
  if (isCommandDenied(cmd))   return { allowed: false, needsApproval: false }
  if (isShellDangerous(cmd))  return { allowed: false, needsApproval: false }
  // Allowlist: explicitly permitted command patterns
  const trimmed = cmd.trim()
  if (SHELL_ALLOWLIST.some(p => p.test(trimmed))) return { allowed: true, needsApproval: false }
  // Unknown command pattern — require explicit user approval
  return { allowed: false, needsApproval: true }
}

// ── Browser profile isolation ────────────────────────────────
// Each Aiden session uses a sandboxed Chromium profile — completely
// separate from the user's real Chrome cookies and login state.

const BROWSER_DATA_DIR = path.join(getUserDataDir(), 'browser-profiles')

function getBrowserProfileDir(sessionId?: string): string {
  const id         = sessionId || `session_${Date.now()}`
  const profileDir = path.join(BROWSER_DATA_DIR, id)
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true })
  }
  return profileDir
}

function cleanOldBrowserProfiles(): void {
  if (!fs.existsSync(BROWSER_DATA_DIR)) return
  const cutoff = Date.now() - 24 * 60 * 60 * 1000  // 24 h
  try {
    for (const entry of fs.readdirSync(BROWSER_DATA_DIR)) {
      const fullPath = path.join(BROWSER_DATA_DIR, entry)
      try {
        const stat = fs.statSync(fullPath)
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true })
          console.log(`[Browser] Cleaned old profile: ${entry}`)
        }
      } catch {}
    }
  } catch {}
}

// Clean stale profiles at module load (non-blocking, errors silently ignored)
try { cleanOldBrowserProfiles() } catch {}

// ── Types ─────────────────────────────────────────────────────

// Internal type returned by each TOOLS function
interface RawResult {
  success: boolean
  output:  string
  error?:  string
  [key: string]: any  // allow extra fields (e.g. 'path' from screenshot)
}

// Public type returned by executeTool (enriched with timing/retry info)
export interface ToolResult {
  tool:     string
  input:    Record<string, any>
  success:  boolean
  output:   string
  error?:   string
  duration: number
  retries:  number
}

// ── Singleton Playwright browser context (isolated profile) ──
// LEGACY: Direct Playwright management moved to core/playwrightBridge.ts (N+48).
// Kept here commented for reference — delete after one sprint if bridge is stable.
//
// let browserContext:    any = null
// let activeBrowserPage: any = null
// let browserIdleTimer:  any = null
// function resetBrowserIdleTimer(): void { ... }
// export function getActiveBrowserPage(): any { return activeBrowserPage }
// async function getBrowserContext(): Promise<any> { ... }

/** Returns the currently active Playwright page (delegated to bridge). */
export function getActiveBrowserPage(): any {
  return _getBridgePage()
}

// ── Per-tool timeouts (ms) ────────────────────────────────────

const TOOL_TIMEOUTS: Record<string, number> = {
  web_search:     15000,
  deep_research:  60000,
  fetch_url:      20000,
  fetch_page:     20000,
  run_python:     60000,
  run_node:       60000,
  shell_exec:     30000,
  run_powershell: 30000,
  cmd:            30000,
  ps:             30000,
  wsl:            30000,
  screenshot:     10000,
  vision_loop:   120000,
  open_browser:      15000,
  browser_extract:   10000,
  browser_screenshot: 8000,
  browser_click:     10000,
  browser_scroll:     8000,
  browser_type:      10000,
  browser_get_url:    5000,
  git_push:       60000,
  git_commit:     30000,
  git_status:     15000,
  wait:            6000,
  get_stocks:     20000,
  get_market_data:              15000,
  get_company_info:             15000,
  social_research:              30000,
  code_interpreter_python:      35000,
  code_interpreter_node:        35000,
  clipboard_read:                5000,
  clipboard_write:               5000,
  window_list:                  10000,
  window_focus:                  8000,
  app_launch:                   10000,
  app_close:                     8000,
  system_volume:                 8000,
  watch_folder:                 10000,
  watch_folder_list:             5000,
  clarify:                  300_000,   // up to 5 min for human response
  vision_analyze:            45_000,
  voice_speak:               60_000,
  voice_transcribe:          60_000,
  voice_clone:              120_000,
  voice_design:             120_000,
}

// ── NSE symbol normalizer ─────────────────────────────────────
// Yahoo Finance needs '^NSEI' for NIFTY and '.NS' suffix for NSE stocks.

function normalizeNSESymbol(symbol: string): string {
  const nseMap: Record<string, string> = {
    'NIFTY':      '^NSEI',
    'NIFTY 50':   '^NSEI',
    'NIFTY50':    '^NSEI',
    'BANKNIFTY':  '^NSEBANK',
    'BANK NIFTY': '^NSEBANK',
    'SENSEX':     '^BSESN',
  }
  const upper = symbol.toUpperCase().trim()
  if (nseMap[upper]) return nseMap[upper]
  // Bare Indian ticker (all caps, no dot/caret suffix) → add .NS
  if (/^[A-Z]{2,20}$/.test(upper)) return upper + '.NS'
  return symbol
}

// ── ToolContext ───────────────────────────────────────────────
// Passed from the server into each tool call so tools can stream
// real-time progress back to the SSE connection.

export interface ToolContext {
  emitProgress?: (message: string) => void
}

// Module-level progress emitter — set once per SSE request by server.ts,
// cleared on connection close (same pattern as setStatusEmitter in agentLoop).
let _emitProgress: ((tool: string, message: string) => void) | null = null
export function setProgressEmitter(fn: ((tool: string, message: string) => void) | null): void {
  _emitProgress = fn
}

// ── resolveWritePath ──────────────────────────────────────────
// Pure path resolver for file_write. Exported for unit tests.
// Expands shorthands, resolves to absolute, then enforces the
// allow-list: workspace (cwd), Desktop, Documents.
// Throws with a clear message if the resolved path falls outside.

export function resolveWritePath(
  rawPath: string,
  opts?: { home?: string; cwd?: string },
): string {
  const home = opts?.home ?? os.homedir()
  const cwd  = opts?.cwd  ?? process.cwd()
  const user = process.env.USERNAME || process.env.USER || os.userInfo().username || 'User'

  // Expand shorthands
  let p = rawPath
    .replace(/^~[\/\\]/,             home + path.sep)
    .replace(/^Desktop[\/\\]/i,      path.join(home, 'Desktop')   + path.sep)
    .replace(/^C:\\Users\\Aiden\\/i, `C:\\Users\\${user}\\`)
    .replace(/^C:\/Users\/Aiden\//i, `C:/Users/${user}/`)

  // Resolve relative paths against cwd
  const resolved = /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('/')
    ? p
    : path.join(cwd, p)

  // Allow-list: workspace root, Desktop, Documents
  const allowedRoots = [
    cwd,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
  ]
  const norm = (s: string) => s.toLowerCase().replace(/\//g, '\\').replace(/\\$/, '')
  const nr   = norm(resolved)
  const ok   = allowedRoots.some(root => {
    const r = norm(root)
    return nr === r || nr.startsWith(r + '\\')
  })

  if (!ok) {
    throw new Error(
      `Path '${resolved}' is outside allowed write locations. Allowed: workspace, Desktop, Documents.`
    )
  }
  return resolved
}

// ── C13: Cross-platform app launch aliases ─────────────────────

type LaunchType = 'uri' | 'cmd' | 'app'
interface LaunchEntry { type: LaunchType; value: string }
type PlatformKey = 'win32' | 'darwin' | 'linux'

export const APP_ALIASES: Record<string, Partial<Record<PlatformKey, LaunchEntry>>> = {
  spotify:     { win32: { type: 'uri', value: 'spotify' },       darwin: { type: 'app', value: 'Spotify' },            linux: { type: 'cmd', value: 'spotify' }},
  chrome:      { win32: { type: 'cmd', value: 'chrome' },        darwin: { type: 'app', value: 'Google Chrome' },      linux: { type: 'cmd', value: 'google-chrome' }},
  firefox:     { win32: { type: 'cmd', value: 'firefox' },       darwin: { type: 'app', value: 'Firefox' },            linux: { type: 'cmd', value: 'firefox' }},
  edge:        { win32: { type: 'cmd', value: 'msedge' },        darwin: { type: 'app', value: 'Microsoft Edge' },     linux: { type: 'cmd', value: 'microsoft-edge' }},
  discord:     { win32: { type: 'uri', value: 'discord' },       darwin: { type: 'app', value: 'Discord' },            linux: { type: 'cmd', value: 'discord' }},
  slack:       { win32: { type: 'uri', value: 'slack' },         darwin: { type: 'app', value: 'Slack' },              linux: { type: 'cmd', value: 'slack' }},
  zoom:        { win32: { type: 'uri', value: 'zoommtg' },       darwin: { type: 'app', value: 'zoom.us' },            linux: { type: 'cmd', value: 'zoom' }},
  teams:       { win32: { type: 'uri', value: 'msteams' },       darwin: { type: 'app', value: 'Microsoft Teams' },    linux: { type: 'cmd', value: 'teams' }},
  vscode:      { win32: { type: 'cmd', value: 'code' },          darwin: { type: 'app', value: 'Visual Studio Code' }, linux: { type: 'cmd', value: 'code' }},
  notepad:     { win32: { type: 'cmd', value: 'notepad.exe' },   darwin: { type: 'app', value: 'TextEdit' },           linux: { type: 'cmd', value: 'gedit' }},
  'notepad++': { win32: { type: 'cmd', value: 'notepad++' }},
  calculator:  { win32: { type: 'cmd', value: 'calc' },          darwin: { type: 'app', value: 'Calculator' },         linux: { type: 'cmd', value: 'gnome-calculator' }},
  paint:       { win32: { type: 'cmd', value: 'mspaint' }},
  explorer:    { win32: { type: 'cmd', value: 'explorer' },      darwin: { type: 'cmd', value: 'open ~' },             linux: { type: 'cmd', value: 'nautilus' }},
  terminal:    { win32: { type: 'cmd', value: 'wt' },            darwin: { type: 'app', value: 'Terminal' },           linux: { type: 'cmd', value: 'gnome-terminal' }},
  word:        { win32: { type: 'cmd', value: 'winword' }},
  excel:       { win32: { type: 'cmd', value: 'excel' }},
  powershell:  { win32: { type: 'cmd', value: 'powershell' }},
  cmd:         { win32: { type: 'cmd', value: 'cmd' }},
}

// Display name aliases → canonical key in APP_ALIASES
const DISPLAY_ALIASES: Record<string, string> = {
  'google chrome': 'chrome', 'microsoft edge': 'edge',
  'vs code': 'vscode', 'visual studio code': 'vscode',
  'microsoft teams': 'teams', 'file explorer': 'explorer',
  'windows terminal': 'terminal', 'task manager': 'calculator',
  'calc': 'calculator',
}

/**
 * C13: Resolve the shell command to launch an app on a given platform.
 * Pure function — takes platform arg for testability.
 * @param appName  - user-facing app name (lowercase, trimmed)
 * @param platform - override for process.platform (for testing)
 */
export function resolveLaunchCommand(appName: string, platform?: string): string {
  const plat = (platform ?? process.platform) as PlatformKey
  const canonical = DISPLAY_ALIASES[appName] ?? appName
  const entry = APP_ALIASES[canonical]?.[plat]

  if (entry) {
    switch (entry.type) {
      case 'uri':
        return plat === 'win32'  ? `cmd /c start "" "${entry.value}:"`
             : plat === 'darwin' ? `open "${entry.value}://"`
             :                     `xdg-open "${entry.value}://"`
      case 'app':
        return `open -a "${entry.value}"`
      case 'cmd':
        if (plat === 'win32')  return `cmd /c start "" "${entry.value}"`
        if (plat === 'darwin') return `open -a "${entry.value}"`
        return entry.value
    }
  }

  // Fallback for unknown apps
  if (plat === 'win32')  return `cmd /c start "" "${appName}"`
  if (plat === 'darwin') return `open -a "${appName}"`
  return `xdg-open "${appName}"`
}

// ── Tool implementations ──────────────────────────────────────

export const TOOLS: Record<string, (payload: any, ctx?: ToolContext) => Promise<RawResult>> = {

  // ── respond — direct conversational reply (no external tools needed) ──
  respond: async (p) => {
    const message = p.message || p.text || p.response || ''
    if (!message) return { success: false, output: '', error: 'No message provided' }
    return { success: true, output: message }
  },

  open_browser: async (p) => {
    const url = p.url || p.command || ''
    if (!url) return { success: false, output: '', error: 'No URL provided' }

    // ── Permission system check ────────────────────────────────
    const permBrowser = permissionSystem.checkBrowserDomain(url)
    if (permBrowser.verdict === 'deny') {
      console.warn(`[Permissions] open_browser DENIED: ${url}`)
      return { success: false, output: '', error: permBrowser.reason || 'Blocked by permission system.' }
    }
    if (permBrowser.verdict === 'ask') {
      return { success: false, output: '', error: `PermissionGate: Navigation to this URL requires explicit user approval: ${url}` }
    }

    const r = await pwNavigate(url)
    if (r.ok) {
      // Auto-chain: if we landed on a YouTube search results page, immediately
      // click the first video — so "play X on YouTube" works in a single step
      // even when the planner forgets to emit the browser_click follow-up.
      if (r.url.includes('youtube.com/results')) {
        console.log('[open_browser] YouTube search detected — auto-clicking first result')
        const click = await pwClickFirstResult()
        if (click.ok) {
          return { success: true, output: `Opened YouTube → playing first result → ${click.url ?? r.url}` }
        }
        console.warn(`[open_browser] YouTube auto-click failed: ${click.error}`)
        // Navigation still succeeded; report it and let a browser_click retry handle it
        return { success: true, output: `Opened browser: ${r.url} (auto-click failed: ${click.error})` }
      }
      return { success: true, output: `Opened browser: ${r.url}` }
    }
    // Playwright failed — fall back to system browser open
    // (Legacy path: activeBrowserPage = null; openBrowser(url))
    try {
      const result = await openBrowser(url)
      return { success: true, output: result }
    } catch (e2: any) { return { success: false, output: '', error: r.error ?? e2.message } }
  },

  browser_screenshot: async () => {
    const r = await pwScreenshot()
    if (r.ok) return { success: true, output: `Screenshot saved: ${r.path}` }
    return { success: false, output: '', error: r.error }
  },

  // ── browser_click — routes through playwrightBridge ──────────────────────
  //
  // Semantic target shortcuts (pass target: 'first_result'):
  //   YouTube search  → a#video-title  (waits for JS render)
  //   Google search   → div.g h3 a     (first organic result)
  //   DuckDuckGo      → article[data-testid="result"] h2 a
  //
  // For all other selectors: waits for the element to be visible before clicking.
  browser_click: async (p) => {
    const rawTarget = p.target || p.selector || p.text || p.command || ''
    if (rawTarget === 'first_result') {
      const r = await pwClickFirstResult()
      if (r.ok) return { success: true, output: `Clicked first result → ${r.url ?? ''}` }
      return { success: false, output: '', error: r.error }
    }
    const r = await pwClick(rawTarget)
    if (r.ok) return { success: true, output: `Clicked: ${rawTarget}` }
    return { success: false, output: '', error: r.error }
  },

  browser_scroll: async (p) => {
    const direction = (p.direction as string) || 'down'
    const amount    = typeof p.amount === 'number' ? p.amount : 500
    const selector  = p.selector as string | undefined
    const r = await pwScroll(direction as any, amount, selector)
    if (r.ok) return { success: true, output: selector ? `Scrolled ${direction} ${selector}` : `Scrolled ${direction} by ${amount}px` }
    return { success: false, output: '', error: r.error }
  },

  // ── browser_get_url — return the URL of the current browser page ──────────
  browser_get_url: async () => {
    const r = await pwGetUrl()
    if (r.ok) return { success: true, output: r.url ?? '' }
    return { success: false, output: '', error: r.error }
  },

  // ── LocalSend LAN file transfer ───────────────────────────────
  send_file_local: async (p) => {
    const base = 'http://localhost:53317'

    // Check LocalSend is running
    try {
      await fetch(`${base}/api/v2/info`, { signal: AbortSignal.timeout(2000) })
    } catch {
      return {
        success: false,
        output: '',
        error: 'LocalSend is not running. Start LocalSend and try again.',
        install: 'https://localsend.org',
      }
    }

    if (p.op === 'discover') {
      try {
        const res = await fetch(`${base}/api/v2/devices`)
        const devices = await res.json()
        return { success: true, output: JSON.stringify(devices, null, 2) }
      } catch (e: any) {
        return { success: false, output: '', error: e.message }
      }
    }

    if (p.op === 'send') {
      if (!p.filePath && !p.text) {
        return { success: false, output: '', error: 'filePath or text required for send op' }
      }
      const receiver = p.device ? `--receiver "${p.device}"` : ''
      const cmd = p.filePath
        ? `localsend_cli --file "${p.filePath}" ${receiver}`.trim()
        : `localsend_cli --text "${p.text}" ${receiver}`.trim()
      try {
        const result = await execAsync(cmd, { timeout: 30000 })
        return { success: true, output: result.stdout || 'Sent.' }
      } catch (e: any) {
        return { success: false, output: '', error: e.message }
      }
    }

    return { success: false, output: '', error: `Unknown op "${p.op}". Use discover or send.` }
  },

  receive_file_local: async (p) => {
    const base = 'http://localhost:53317'
    const timeout = ((p.timeout_seconds as number) || 60) * 1000
    const saveTo  = (p.save_to as string) || 'workspace/downloads/'

    // Check LocalSend is running
    try {
      await fetch(`${base}/api/v2/info`, { signal: AbortSignal.timeout(2000) })
    } catch {
      return { success: false, output: '', error: 'LocalSend is not running. Start LocalSend and try again.' }
    }

    // Poll for incoming transfers
    const start = Date.now()
    while (Date.now() - start < timeout) {
      try {
        const res = await fetch(`${base}/api/v2/pending`)
        if (res.ok) {
          const pending = await res.json() as any
          if (pending?.files?.length > 0) {
            await fetch(`${base}/api/v2/accept`, { method: 'POST' })
            return {
              success: true,
              output: `Received ${pending.files.length} file(s) → ${saveTo}`,
              files: pending.files,
              savedTo: saveTo,
            }
          }
        }
      } catch { /* ignore poll errors, keep waiting */ }
      await new Promise(r => setTimeout(r, 2000))
    }

    return { success: false, output: '', error: `Timeout — no transfer received in ${p.timeout_seconds || 60}s` }
  },

  browser_type: async (p) => {
    const selector = p.selector || 'input'
    const text     = p.text || p.command || ''
    const r = await pwType(selector, text)
    if (r.ok) return { success: true, output: `Typed "${text}" into ${selector}` }
    return { success: false, output: '', error: r.error }
  },

  browser_extract: async (_p, ctx?) => {
    ctx?.emitProgress?.('extracting page content...')
    const r = await pwSnapshot()
    if (r.ok) {
      ctx?.emitProgress?.(`extracted ${(r.text ?? '').length.toLocaleString()} chars`)
      return { success: true, output: r.text ?? '' }
    }
    return { success: false, output: '', error: r.error }
  },

  shell_exec: async (p, ctx?) => {
    const cmd = p.command || p.cmd || ''
    if (!cmd) return { success: false, output: '', error: 'No command' }

    // ── Permission system check (workspace/permissions.yaml) ──
    const permCheck = permissionSystem.checkShell(cmd)
    if (permCheck.verdict === 'deny') {
      console.warn(`[Permissions] shell_exec DENIED: ${cmd.slice(0, 120)}`)
      return { success: false, output: '', error: permCheck.reason || 'Blocked by permission system.' }
    }
    if (permCheck.verdict === 'ask') {
      console.warn(`[Permissions] shell_exec ASK — approval required: ${cmd.slice(0, 120)}`)
      return { success: false, output: '', error: `PermissionGate: This command requires explicit user approval: ${cmd.slice(0, 80)}` }
    }
    // verdict === 'allow' skips the hardcoded gate below
    // verdict === 'defer' falls through to the existing SHELL_ALLOWLIST gate

    if (permCheck.verdict !== 'allow') {
      // Existing hardcoded gate (DENIED_COMMANDS + SHELL_DANGEROUS + SHELL_ALLOWLIST)
      const shellGate = isCommandAllowed(cmd)
      if (!shellGate.allowed) {
        if (shellGate.needsApproval) {
          console.warn(`[AllowList] shell_exec UNKNOWN — approval required: ${cmd.slice(0, 120)}`)
          return { success: false, output: '', error: `CommandGate: This command requires explicit user approval before running: ${cmd.slice(0, 80)}` }
        }
        console.warn(`[Security] shell_exec DENIED: ${cmd.slice(0, 120)}`)
        return { success: false, output: '', error: 'Blocked: this command pattern is not allowed. Dangerous operations require explicit user approval.' }
      }
    }
    // ── N+34: Docker sandbox routing ───────────────────────────
    const _sandboxMode = process.env.AIDEN_SANDBOX_MODE || 'off'
    if (_sandboxMode === 'strict' || _sandboxMode === 'auto') {
      try {
        const sr = await runInDockerSandbox({ command: cmd, type: 'shell', timeout: 30000 })
        const out = (sr.stdout + (sr.stderr ? `\nstderr: ${sr.stderr}` : '')).trim() || '(completed)'
        return { success: sr.exitCode === 0, output: out, error: sr.exitCode !== 0 ? `Exit ${sr.exitCode}` : undefined }
      } catch (sandboxErr: any) {
        if (_sandboxMode === 'strict') return { success: false, output: '', error: `[Sandbox] ${sandboxErr.message}` }
        console.warn('[Sandbox] auto-mode fell back to host:', sandboxErr.message)
      }
    }
    // ── Host execution — streaming spawn ───────────────────────
    const showProgress = process.env.AIDEN_SHOW_TOOL_OUTPUT !== 'false'
    return new Promise<RawResult>((resolve) => {
      const proc = spawn('powershell.exe', ['-Command', cmd], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: process.env.PATH } as NodeJS.ProcessEnv,
      })
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString()
        stdout += text
        if (showProgress && ctx?.emitProgress) {
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (trimmed) ctx.emitProgress(trimmed.slice(0, 100))
          }
        }
      })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      const timer = setTimeout(() => {
        proc.kill()
        resolve({ success: false, output: stdout.trim(), error: 'timeout' })
      }, (p.timeout_seconds || 30) * 1000)

      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        const out = (stdout || stderr || '').trim() || '(completed)'
        resolve({
          success: (code ?? 1) === 0,
          output:  out,
          error:   (code ?? 1) !== 0 ? `Exit ${code}` : undefined,
        })
      })
      proc.on('error', (e: Error) => {
        clearTimeout(timer)
        resolve({ success: false, output: '', error: e.message })
      })
    })
  },

  run_powershell: async (p) => {
    const script  = p.script || p.command || ''
    if (!script) return { success: false, output: '', error: 'No script' }

    // ── Permission system check ────────────────────────────────
    const permPs = permissionSystem.checkShell(script)
    if (permPs.verdict === 'deny') {
      console.warn(`[Permissions] run_powershell DENIED: ${script.slice(0, 120)}`)
      return { success: false, output: '', error: permPs.reason || 'Blocked by permission system.' }
    }
    if (permPs.verdict === 'ask') {
      return { success: false, output: '', error: `PermissionGate: This PowerShell command requires explicit user approval: ${script.slice(0, 80)}` }
    }

    if (permPs.verdict !== 'allow') {
      const psGate = isCommandAllowed(script)
      if (!psGate.allowed) {
        if (psGate.needsApproval) {
          console.warn(`[AllowList] run_powershell UNKNOWN — approval required: ${script.slice(0, 120)}`)
          return { success: false, output: '', error: `CommandGate: This PowerShell command requires explicit user approval before running.` }
        }
        console.warn(`[Security] run_powershell DENIED: ${script.slice(0, 120)}`)
        return { success: false, output: '', error: 'Blocked: this command pattern is not allowed. Dangerous operations require explicit user approval.' }
      }
    }
    const tmpFile = path.join(process.cwd(), 'workspace', `tmp_${Date.now()}.ps1`)
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
    fs.writeFileSync(tmpFile, script)
    try {
      const { stdout, stderr } = await execAsync(
        `powershell.exe -ExecutionPolicy Bypass -File "${tmpFile}"`,
        { timeout: 30000 }
      )
      return { success: true, output: (stdout || stderr || '').trim() }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
    finally { try { fs.unlinkSync(tmpFile) } catch {} }
  },

  // ── cmd — Windows cmd.exe shell ────────────────────────────
  cmd: async (p) => {
    const command = p.command || p.cmd || ''
    if (!command) return { success: false, output: '', error: 'No command provided' }
    const gate = isCommandAllowed(command)
    if (!gate.allowed) {
      if (gate.needsApproval) {
        console.warn(`[AllowList] cmd UNKNOWN — approval required: ${command.slice(0, 120)}`)
        return { success: false, output: '', error: `CommandGate: This command requires explicit user approval before running: ${command.slice(0, 80)}` }
      }
      console.warn(`[Security] cmd DENIED: ${command.slice(0, 120)}`)
      return { success: false, output: '', error: 'Blocked: this command pattern is not allowed. Dangerous operations require explicit user approval.' }
    }
    try {
      const { stdout, stderr } = await execAsync(`cmd.exe /c ${command}`, {
        timeout: 30000,
        cwd:     process.cwd(),
        env:     { ...process.env },
      })
      const out = (stdout || stderr || '').trim()
      return { success: true, output: out || '(completed)', exitCode: 0 } as any
    } catch (e: any) {
      return { success: false, output: e.stdout || '', error: e.message, exitCode: e.code ?? 1 } as any
    }
  },

  // ── ps — PowerShell (direct, no temp file) ──────────────────
  ps: async (p) => {
    const command = p.command || p.script || ''
    if (!command) return { success: false, output: '', error: 'No command provided' }
    const gate = isCommandAllowed(command)
    if (!gate.allowed) {
      if (gate.needsApproval) {
        console.warn(`[AllowList] ps UNKNOWN — approval required: ${command.slice(0, 120)}`)
        return { success: false, output: '', error: `CommandGate: This PowerShell command requires explicit user approval before running.` }
      }
      console.warn(`[Security] ps DENIED: ${command.slice(0, 120)}`)
      return { success: false, output: '', error: 'Blocked: this command pattern is not allowed. Dangerous operations require explicit user approval.' }
    }
    try {
      const { stdout, stderr } = await execAsync(
        `powershell.exe -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`,
        { timeout: 30000, cwd: process.cwd() }
      )
      const out = (stdout || stderr || '').trim()
      return { success: true, output: out || '(completed)', exitCode: 0 } as any
    } catch (e: any) {
      return { success: false, output: e.stdout || '', error: e.message, exitCode: e.code ?? 1 } as any
    }
  },

  // ── wsl — Windows Subsystem for Linux ───────────────────────
  wsl: async (p) => {
    const command = p.command || p.cmd || ''
    const distro  = p.distro || ''
    if (!command) return { success: false, output: '', error: 'No command provided' }
    const gate = isCommandAllowed(command)
    if (!gate.allowed) {
      if (gate.needsApproval) {
        console.warn(`[AllowList] wsl UNKNOWN — approval required: ${command.slice(0, 120)}`)
        return { success: false, output: '', error: `CommandGate: This WSL command requires explicit user approval before running.` }
      }
      console.warn(`[Security] wsl DENIED: ${command.slice(0, 120)}`)
      return { success: false, output: '', error: 'Blocked: this command pattern is not allowed. Dangerous operations require explicit user approval.' }
    }
    // Translate Windows paths in the command: C:\foo\bar → /mnt/c/foo/bar
    const translated = command.replace(/([A-Z]):\\([^\s"']*)/gi, (_m: string, drive: string, rest: string) =>
      `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`
    )
    const distroFlag = distro ? `-d ${distro}` : ''
    const wslCmd     = `wsl ${distroFlag} -- bash -c "${translated.replace(/"/g, '\\"')}"`
    try {
      const { stdout, stderr } = await execAsync(wslCmd, {
        timeout: 30000,
        cwd:     process.cwd(),
      })
      const out = (stdout || stderr || '').trim()
      return { success: true, output: out || '(completed)', exitCode: 0 } as any
    } catch (e: any) {
      return { success: false, output: e.stdout || '', error: e.message, exitCode: e.code ?? 1 } as any
    }
  },

  file_write: async (p) => {
    let   filePath = p.path || p.file || ''
    const content  = p.content || ''
    if (!filePath) return { success: false, output: '', error: 'No path' }

    // ── Permission system check ────────────────────────────────
    const permWrite = permissionSystem.checkFileWrite(filePath)
    if (permWrite.verdict === 'deny') {
      console.warn(`[Permissions] file_write DENIED: ${filePath}`)
      return { success: false, output: '', error: permWrite.reason || 'Blocked by permission system.' }
    }

    if (isProtectedFile(filePath)) {
      console.warn(`[Security] file_write BLOCKED (protected): ${filePath}`)
      return { success: false, output: '', error: `Protected file: ${filePath} cannot be modified by agents. Use 'devos config' or edit manually.` }
    }
    if (isPathDenied(filePath)) {
      console.warn(`[Security] file_write DENIED: ${filePath}`)
      return { success: false, output: '', error: 'Access denied: protected path. Aiden cannot write credentials, SSH keys, or env files.' }
    }
    try {
      const resolved = resolveWritePath(filePath)
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
      fs.writeFileSync(resolved, content, 'utf-8')
      const written = fs.existsSync(resolved)
      return {
        success: written,
        output:  written
          ? `Written and verified: ${resolved} (${content.length} chars)`
          : 'Write failed',
      }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  file_read: async (p) => {
    let filePath = p.path || p.file || ''
    if (!filePath) return { success: false, output: '', error: 'No path' }

    // ── Permission system check ────────────────────────────────
    const permRead = permissionSystem.checkFileRead(filePath)
    if (permRead.verdict === 'deny') {
      console.warn(`[Permissions] file_read DENIED: ${filePath}`)
      return { success: false, output: '', error: permRead.reason || 'Blocked by permission system.' }
    }

    if (isPathDenied(filePath)) {
      console.warn(`[Security] file_read DENIED: ${filePath}`)
      return { success: false, output: '', error: 'Access denied: protected path. Aiden cannot read credentials, SSH keys, or env files.' }
    }
    try {
      // Expand ~ and Desktop shorthands, and fix any "Aiden" username to actual system user
      const _user = process.env.USERNAME || process.env.USER || require('os').userInfo().username || 'User'
      const _home = require('os').homedir()
      filePath = filePath
        .replace(/^~[\/\\]/i, _home + path.sep)
        .replace(/^Desktop[\/\\]/i, path.join(_home, 'Desktop') + path.sep)
        .replace(/^C:\\Users\\Aiden\\/i, `C:\\Users\\${_user}\\`)
        .replace(/^C:\/Users\/Aiden\//i, `C:/Users/${_user}/`)
      // Resolve path: absolute paths (Windows C:\ or Unix /) used as-is; relative joined with cwd
      const resolved = filePath.match(/^[A-Z]:/i) || filePath.startsWith('/')
        ? filePath
        : path.join(process.cwd(), filePath)
      if (!fs.existsSync(resolved)) return { success: false, output: '', error: `Not found: ${resolved}` }
      return { success: true, output: fs.readFileSync(resolved, 'utf-8').slice(0, 5000) }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  file_list: async (p) => {
    let dirPath = p.path || p.dir || process.cwd()
    try {
      // Expand ~ and Desktop shorthands, and fix any "Aiden" username to actual system user
      const _user = process.env.USERNAME || process.env.USER || require('os').userInfo().username || 'User'
      const _home = require('os').homedir()
      dirPath = dirPath
        .replace(/^~[\/\\]/i, _home + path.sep)
        .replace(/^Desktop[\/\\]?$/i, path.join(_home, 'Desktop'))
        .replace(/^Desktop[\/\\]/i, path.join(_home, 'Desktop') + path.sep)
        .replace(/^C:\\Users\\Aiden\\/i, `C:\\Users\\${_user}\\`)
        .replace(/^C:\/Users\/Aiden\//i, `C:/Users/${_user}/`)
      const resolved = dirPath.match(/^[A-Z]:/i)
        ? dirPath
        : path.join(process.cwd(), dirPath)
      return { success: true, output: fs.readdirSync(resolved).join('\n') }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  run_python: async (p, ctx?) => {
    const script = p.script || p.code || p.command || ''
    if (!script) return { success: false, output: '', error: 'No script' }

    // ── C8: Destructive path guard ─────────────────────────────────
    const pyGuard = scanCodeForDestructivePaths(script, 'python')
    if (pyGuard.denied) return { success: false, output: '', error: pyGuard.reason }

    // ── N+34: Docker sandbox routing ───────────────────────────
    const _pyMode = process.env.AIDEN_SANDBOX_MODE || 'off'
    if (_pyMode === 'strict' || _pyMode === 'auto') {
      try {
        const sr = await runInDockerSandbox({ command: script, type: 'python', timeout: 60000 })
        const out = (sr.stdout + (sr.stderr ? `\nstderr: ${sr.stderr}` : '')).trim() || 'Script completed with no output'
        return { success: sr.exitCode === 0, output: out, error: sr.exitCode !== 0 ? `Python exit ${sr.exitCode}` : undefined }
      } catch (sandboxErr: any) {
        if (_pyMode === 'strict') return { success: false, output: '', error: `[Sandbox] ${sandboxErr.message}` }
        console.warn('[Sandbox] auto-mode fell back to host:', sandboxErr.message)
      }
    }
    // ── Host execution (sandbox off or auto-fallback) ───────────
    const tmp = path.join(process.cwd(), 'workspace', `py_${Date.now()}.py`)
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    fs.writeFileSync(tmp, script)
    const showProgress = process.env.AIDEN_SHOW_TOOL_OUTPUT !== 'false'
    return new Promise<RawResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      const proc = spawn('python', [tmp], { cwd: process.cwd() })
      const timer = setTimeout(() => { proc.kill(); resolve({ success: false, output: stdout, error: 'Python timeout (60s)' }) }, 60000)
      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString()
        stdout += text
        if (showProgress && ctx?.emitProgress) {
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (trimmed) ctx.emitProgress(trimmed.slice(0, 100))
          }
        }
      })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        clearTimeout(timer)
        try { fs.unlinkSync(tmp) } catch {}
        const output = (stdout || stderr || '').trim() || 'Script completed with no output'
        resolve({ success: code === 0, output, error: code !== 0 ? `Python exit ${code}` : undefined })
      })
    })
  },

  run_node: async (p) => {
    const script = p.script || p.code || p.command || ''
    if (!script) return { success: false, output: '', error: 'No script' }

    // ── C8: Destructive path guard ─────────────────────────────────
    const nodeGuard = scanCodeForDestructivePaths(script, 'node')
    if (nodeGuard.denied) return { success: false, output: '', error: nodeGuard.reason }

    const tmp = path.join(process.cwd(), 'workspace', `js_${Date.now()}.js`)
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    fs.writeFileSync(tmp, script)
    try {
      const { stdout, stderr } = await execAsync(`node "${tmp}"`, {
        timeout: 60000,
        cwd:     process.cwd(),
      })
      return { success: true, output: (stdout || stderr || '').trim() || 'Script completed with no output' }
    } catch (e: any) { return { success: false, output: e.stdout || '', error: `Node error: ${e.message}` } }
    finally { try { fs.unlinkSync(tmp) } catch {} }
  },

  system_info: async () => {
    try {
      const { stdout } = await execAsync(
        `@{ CPU=(Get-CimInstance Win32_Processor).Name; RAM_GB=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1); OS=(Get-CimInstance Win32_OperatingSystem).Caption; FreeGB=[math]::Round((Get-PSDrive C).Free/1GB,1); User=$env:USERNAME } | ConvertTo-Json`,
        { shell: 'powershell.exe', timeout: 15000 }
      )
      return { success: true, output: stdout.trim() }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  now_playing: async () => {
    try {
      const result = await getNowPlaying()
      return { success: true, output: JSON.stringify(result) }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  notify: async (p) => {
    const msg = (p.message || p.command || p.title || p.body || '')
      .replace(/'/g, '').replace(/"/g, '').replace(/`/g, '').replace(/\$/g, '').trim()
    if (!msg) return { success: false, output: '', error: 'No message provided for notification' }
    try {
      // Windows 10/11 Toast notification via WinRT — fires instantly, no Start-Sleep needed.
      // Run fully detached so the child process never inherits the parent terminal stdio.
      const psCmd = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
        '$n = $t.GetElementsByTagName("text")',
        `$n.Item(0).AppendChild($t.CreateTextNode("Aiden")) | Out-Null`,
        `$n.Item(1).AppendChild($t.CreateTextNode("${msg}")) | Out-Null`,
        '$toast = [Windows.UI.Notifications.ToastNotification]::new($t)',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Aiden").Show($toast)',
      ].join('; ')

      const child = spawn('powershell', [
        '-WindowStyle', 'Hidden',
        '-NonInteractive',
        '-Command', psCmd,
      ], {
        detached:    true,
        stdio:       'ignore',
        windowsHide: true,
      })
      child.unref()  // don't keep Node alive waiting for it

      return { success: true, output: `Desktop notification sent: "${msg}".` }
    } catch (e: any) {
      return { success: false, output: '', error: `Notification failed: ${e.message}` }
    }
  },

  web_search: async (p: any) => {
    const query = p.query || p.command || p.topic || ''
    if (!query) return { success: false, output: '', error: 'No query provided' }

    // Date/time fast-path — answer from system clock without network call
    if (/what\s+(year|date|day|time)|current\s+(year|date|day|time)|today'?s?\s+(date|year|day)|what\s+is\s+today/i.test(query)) {
      const now     = new Date()
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      return {
        success: true,
        output:  `Current date: ${dateStr}. Year: ${now.getFullYear()}. Time: ${now.toLocaleTimeString('en-US')}.`,
        method:  'system_clock',
      }
    }

    return reliableWebSearch(query)
  },

  _web_search_legacy_unused: async (p: any) => {
    // Legacy implementation preserved for reference — no longer called
    const query = p.query || ''
    if (!query) return { success: false, output: '', error: 'No query provided' }

    // ── Weather detection ────────────────────────────────────────
    if (/weather|temperature|forecast|rain|snow|sunny|cloudy|humidity|wind/i.test(query)) {
      const city = query
        .replace(/what(?:'s| is) the weather/gi, '')
        .replace(/\bweather\b/gi, '')
        .replace(/\bforecast\b/gi, '')
        .replace(/\btoday\b/gi, '')
        .replace(/\bcurrent\b/gi, '')
        .replace(/\btemperature\b/gi, '')
        .replace(/\brain\b/gi, '')
        .replace(/\bsnow\b/gi, '')
        .replace(/\bsunny\b/gi, '')
        .replace(/\bcloudy\b/gi, '')
        .replace(/\bhumidity\b/gi, '')
        .replace(/\bwind\b/gi, '')
        .replace(/\bin\b/gi, '')
        .replace(/\bfor\b/gi, '')
        .replace(/\bon\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim() || 'auto'
      console.log(`[Weather] city extracted: "${city}"`)

      try {
        const wr   = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { signal: AbortSignal.timeout(8000) })
        const data = await wr.json() as any
        const cc   = data.current_condition?.[0]
        const area = data.nearest_area?.[0]
        if (cc && area) {
          const location = [area.areaName?.[0]?.value, area.country?.[0]?.value].filter(Boolean).join(', ')
          const desc     = cc.weatherDesc?.[0]?.value || ''
          let out = `Weather for ${location || city}:\n`
          out    += `Condition: ${desc}\n`
          out    += `Temperature: ${cc.temp_C}°C / ${cc.temp_F}°F (feels like ${cc.FeelsLikeC}°C)\n`
          out    += `Humidity: ${cc.humidity}% | Wind: ${cc.windspeedKmph} km/h ${cc.winddir16Point}`
          out    += ` | Visibility: ${cc.visibility} km | UV Index: ${cc.uvIndex}\n`
          const forecasts = (data.weather || []).slice(0, 3) as any[]
          if (forecasts.length) {
            out += '\n3-Day Forecast:\n'
            for (const day of forecasts) {
              const midDesc = day.hourly?.[4]?.weatherDesc?.[0]?.value || ''
              out += `  ${day.date}: High ${day.maxtempC}°C / Low ${day.mintempC}°C${midDesc ? ' — ' + midDesc : ''}\n`
            }
          }
          console.log(`[web_search] Weather data retrieved for "${city}"`)
          return { success: true, output: out.trim() }
        }
      } catch (e: any) {
        console.warn(`[web_search] Weather fetch failed: ${e.message}`)
      }
    }

    const results: string[] = []

    // ── METHOD 1: DuckDuckGo Instant Answer API ──────────────────
    try {
      console.log(`[web_search] Method 1: DDG Instant API`)
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
      const ddgRes = await fetch(ddgUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
        signal:  AbortSignal.timeout(8000),
      })
      const ddgData = await ddgRes.json() as any
      const parts: string[] = []
      if (ddgData.Answer)       parts.push(`Answer: ${ddgData.Answer}`)
      if (ddgData.Abstract)     parts.push(`Summary: ${ddgData.Abstract}`)
      if (ddgData.AbstractText) parts.push(ddgData.AbstractText)
      if (ddgData.RelatedTopics?.length) {
        const topics = ddgData.RelatedTopics
          .slice(0, 8)
          .map((t: any) => t.Text || t.Result || '')
          .filter(Boolean)
        if (topics.length) parts.push(`Related: ${topics.join('. ')}`)
      }
      if (parts.length > 0) {
        console.log(`[web_search] DDG Instant: got ${parts.length} parts`)
        results.push(`[DuckDuckGo Instant]\n${parts.join('\n')}`)
      } else {
        console.log(`[web_search] DDG Instant: no usable data`)
      }
    } catch (e: any) {
      console.warn(`[web_search] DDG instant failed: ${e.message}`)
    }

    // ── METHOD 2: Wikipedia Search API + summary ──────────────────
    try {
      console.log(`[web_search] Method 2: Wikipedia Search API`)
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`
      const searchRes  = await fetch(searchUrl, { signal: AbortSignal.timeout(6000) })
      const searchData = await searchRes.json() as any
      const searchHits = searchData?.query?.search || []
      console.log(`[web_search] Wikipedia search: ${searchHits.length} results`)

      if (searchHits.length > 0) {
        const topTitle  = searchHits[0].title
        const summaryRes = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topTitle)}`,
          { signal: AbortSignal.timeout(6000) },
        )
        if (summaryRes.ok) {
          const wiki = await summaryRes.json() as any
          if (wiki.extract && wiki.extract.length > 50) {
            const snippets = searchHits
              .slice(1, 4)
              .map((h: any) => h.snippet?.replace(/<[^>]+>/g, '') || '')
              .filter((s: string) => s.length > 20)
            const extra = snippets.length > 0 ? `\nOther results: ${snippets.join(' | ')}` : ''
            console.log(`[web_search] Wikipedia summary: ${wiki.extract.length} chars for "${wiki.title}"`)
            results.push(`[Wikipedia: ${wiki.title}]\n${wiki.extract.slice(0, 1200)}${extra}`)
          }
        }
      }
    } catch (e: any) {
      console.warn(`[web_search] Wikipedia failed: ${e.message}`)
    }

    // ── METHOD 3: DDG HTML scrape + snippet extraction + fetch top 3 pages ──
    try {
      console.log(`[web_search] Method 3: DDG HTML scrape`)
      const searchRes = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
          signal:  AbortSignal.timeout(10000),
        },
      )
      const html = await searchRes.text()
      console.log(`[web_search] DDG HTML: ${html.length} bytes`)

      // Extract result snippets via result__snippet class
      const snippetMatches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
      const snippets = snippetMatches
        .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(s => s.length > 30)
        .slice(0, 5)
      console.log(`[web_search] DDG HTML snippets: ${snippets.length}`)
      if (snippets.length > 0) {
        results.push(`[Search Snippets for "${query}"]\n${snippets.join('\n\n')}`)
      }

      // Extract destination URLs via uddg= parameter
      const urlMatches = [...html.matchAll(/uddg=(https?[^&"]+)/g)]
      const urls = urlMatches
        .map(m => decodeURIComponent(m[1]))
        .filter(url =>
          !url.includes('duckduckgo.com') &&
          !url.includes('youtube.com') &&
          url.startsWith('https'),
        )
        .filter((url, i, arr) => arr.indexOf(url) === i)
        .slice(0, 3)
      console.log(`[web_search] DDG HTML urls: ${urls.length}`)

      // Fetch top 3 pages for real content
      const pageResults = await Promise.all(urls.map(async (url) => {
        try {
          console.log(`[web_search] Fetching page: ${url}`)
          const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
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
          console.log(`[web_search] Page fetched: ${clean.length} chars from ${url}`)
          return `[${url}]\n${clean.slice(0, 2000)}`
        } catch (e: any) {
          console.warn(`[web_search] Page fetch failed ${url}: ${e.message}`)
          return null
        }
      }))
      results.push(...(pageResults.filter(Boolean) as string[]))

    } catch (e: any) {
      console.warn(`[web_search] HTML scrape failed: ${e.message}`)
    }

    if (results.length === 0) {
      console.warn(`[web_search] All methods failed for: "${query}"`)
      return { success: false, output: '', error: `No results found for: ${query}` }
    }
    console.log(`[web_search] Done: ${results.length} sections`)
    return { success: true, output: results.join('\n\n---\n\n').slice(0, 10000) }
  },

  fetch_url: async (p) => {
    const url = p.url || p.command || ''
    if (!url) return { success: false, output: '', error: 'No URL' }
    try {
      const res  = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0' },
        signal:  AbortSignal.timeout(15000),
      })
      const status = res.status
      const text  = await res.text()
      const clean = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{3,}/g, ' ')
        .trim()
      return { success: true, output: `HTTP ${status} ${res.statusText || 'OK'}\n\n${clean.slice(0, 3000)}` }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  // Dedicated page fetcher — strips all HTML, returns clean readable text
  fetch_page: async (p) => {
    const url = p.url || p.command || ''
    if (!url) return { success: false, output: '', error: 'No URL' }
    try {
      const r    = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000),
      })
      const text  = await r.text()
      const clean = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return { success: true, output: clean.slice(0, 3000) }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  // 3-pass deep research using reliableWebSearch fallback chain
  deep_research: async (p: any) => {
    const topic = p.topic || p.query || p.command || ''
    if (!topic) return { success: false, output: '', error: 'No topic provided' }
    return deepResearchFn(topic)
  },

  _deep_research_legacy_unused: async (p: any) => {
    // Legacy implementation preserved for reference — no longer called
    const topic = p.topic || ''
    if (!topic) return { success: false, output: '', error: 'No topic provided' }

    const results: string[] = []

    if (results.length === 0) {
      return { success: false, output: '', error: `No research results for: ${topic}` }
    }

    const combined = results.join('\n\n')
    // v4.1.5 Issue O — gated behind AIDEN_DEBUG_WEB to match the
    // webSearch.ts debug-helper convention. Default off; power users
    // export the env var to see the research chain.
    if (process.env.AIDEN_DEBUG_WEB === '1') {
      // eslint-disable-next-line no-console
      console.log(`[deep_research] Complete: ${combined.length} chars across ${results.length} passes`)
    }
    return { success: true, output: combined.slice(0, 15000) }
  },

  // Activate a specialist agent persona — actual synthesis happens in respond phase
  run_agent: async (p) => {
    const agentName = (p.agent || 'engineer').toLowerCase()
    const task      = p.task || p.command || ''
    if (!task) return { success: false, output: '', error: 'No task provided' }

    // ── Fork guard: only top-level agents can spawn specialists ──
    // Prevents sub-agents from recursively spawning more agents
    const FORK_CAPABLE_AGENTS = ['ceo', 'engineer']
    const callerAgent = (p._callerAgent || '').toLowerCase()
    if (callerAgent && !FORK_CAPABLE_AGENTS.includes(callerAgent)) {
      console.warn(`[run_agent] ${callerAgent} attempted to fork ${agentName} — blocked (non-fork-capable)`)
      return { success: false, output: '', error: `Agent '${callerAgent}' cannot spawn sub-agents. Only CEO-level agents can delegate.` }
    }

    const agentPersonas: Record<string, string> = {
      engineer:     'Senior TypeScript/JavaScript engineer — writes clean, working code with full error handling.',
      security:     'Security auditor — analyzes for OWASP Top 10, provides specific fixes with code examples.',
      data_analyst: 'Data analyst — provides statistical analysis, patterns, and visualizable insights.',
      designer:     'UI/UX designer — provides design recommendations with color codes, typography, and layout.',
      researcher:   'Research specialist — extracts entities, compares systematically, identifies trends, gives conclusions.',
      debugger:     'Debugger — forms 3 hypotheses, eliminates systematically, provides exact fix with code.',
    }

    const persona = agentPersonas[agentName] || agentPersonas.engineer

    // ── Context inheritance for complex tasks ─────────────────────
    // Complex tasks (long description or explicit context request) get conversation history
    const isComplex = task.length > 100 || p.inheritContext === true
    let contextBlock = ''
    if (isComplex) {
      const memCtx = conversationMemory.buildContext()
      if (memCtx && memCtx.trim()) {
        contextBlock = `\n## Conversation Context\nThe user has been discussing:\n${memCtx.slice(0, 1200)}\n`
        console.log(`[run_agent] Injecting conversation context into ${agentName} task (${memCtx.length} chars)`)
      }
    }

    try {
      const { memoryLayers } = await import('../memory/memoryLayers')
      memoryLayers.write(`Agent ${agentName} task: ${task}`, ['agent', agentName])
    } catch {}

    const fullTask = contextBlock
      ? `${contextBlock}\n## Your Task\n${task}`
      : task

    return {
      success: true,
      output:  `Agent: ${agentName}\nPersona: ${persona}\nTask: ${fullTask}\n\n[This runs inline — synthesize the result directly in your response. Do NOT tell the user results are "being processed", "running in background", or "will be ready soon". The answer must appear in this response turn.]`,
    }
  },

  git_status: async (p) => {
    const cwd = p.path || p.directory || p.cwd || process.cwd()
    try {
      const { stdout, stderr } = await execAsync(
        'git status && git log --oneline -5',
        { shell: 'powershell.exe', timeout: 15000, cwd }
      )
      return { success: true, output: stdout || stderr }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  git_commit: async (p) => {
    const msg = (p.message || p.command || 'DevOS auto-commit').replace(/"/g, "'")
    try {
      const { stdout, stderr } = await execAsync(
        `git add -A && git commit -m "${msg}"`,
        { shell: 'powershell.exe', timeout: 30000, cwd: process.cwd() }
      )
      return { success: true, output: stdout || stderr }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  git_push: async (p) => {
    const remote = p.remote || 'origin'
    const branch = p.branch || 'master'
    try {
      const { stdout, stderr } = await execAsync(
        `git push ${remote} ${branch}`,
        { shell: 'powershell.exe', timeout: 60000, cwd: process.cwd() }
      )
      return { success: true, output: stdout || stderr }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  get_stocks: async (p: any) => {
    const market = p.market || p.exchange || 'NSE'
    const type   = p.type   || 'gainers' // gainers | losers | active

    console.log(`[get_stocks] Fetching ${type} for ${market}`)

    const results: string[] = []

    // Method 1: Yahoo Finance screener API — free, no auth needed
    try {
      const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=10&region=IN&lang=en-IN`
      const r = await fetch(yahooUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept':     'application/json',
        },
        signal: AbortSignal.timeout(10000),
      })
      if (r.ok) {
        const data   = await r.json() as any
        const quotes = data?.finance?.result?.[0]?.quotes || []
        if (quotes.length > 0) {
          const lines = (quotes as any[]).slice(0, 10).map((q: any) =>
            `${q.symbol}: ${q.regularMarketPrice} (${q.regularMarketChangePercent?.toFixed(2)}%) — ${q.shortName || q.longName || ''}`
          )
          results.push(`Top Gainers (Yahoo Finance India):\n${lines.join('\n')}`)
        }
      }
    } catch (e: any) {
      console.warn(`[get_stocks] Yahoo Finance failed: ${e.message}`)
    }

    // Method 2: Finology ticker
    try {
      const finologyUrl = type === 'gainers'
        ? 'https://ticker.finology.in/market/top-gainers'
        : type === 'losers'
        ? 'https://ticker.finology.in/market/top-losers'
        : 'https://ticker.finology.in/market/most-active'

      const r = await fetch(finologyUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept':     'text/html',
        },
        signal: AbortSignal.timeout(10000),
      })
      if (r.ok) {
        const html  = await r.text()
        const rows  = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        const stocks: string[] = []
        for (const row of rows.slice(1, 15)) {
          const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
            .map((c: any) => c[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
          if (cells.length >= 3 && cells[0].length > 1) {
            stocks.push(cells.slice(0, 5).join(' | '))
          }
        }
        if (stocks.length > 0) {
          results.push(`${market} Top ${type} (Finology):\n${stocks.slice(0, 10).join('\n')}`)
        }
      }
    } catch (e: any) {
      console.warn(`[get_stocks] Finology failed: ${e.message}`)
    }

    // Method 3: Economic Times market stats
    try {
      const segment = type === 'gainers' ? 'gainers' : type === 'losers' ? 'losers' : 'active-stocks'
      const etUrl   = `https://economictimes.indiatimes.com/stocks/marketstats/top-${segment}/nse`
      const r = await fetch(etUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(10000),
      })
      if (r.ok) {
        const html  = await r.text()
        const clean = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        const stockPattern = /\b([A-Z]{2,10})\b[\s\S]{0,30}?(\d+\.?\d*)\s*[(%]\s*([+-]?\d+\.?\d*)/g
        const matches      = [...clean.matchAll(stockPattern)].slice(0, 10)
        if (matches.length > 0) {
          const lines = matches.map((m: any) => `${m[1]}: ${m[2]} (${m[3]}%)`)
          results.push(`ET Market Stats:\n${lines.join('\n')}`)
        }
      }
    } catch (e: any) {
      console.warn(`[get_stocks] ET failed: ${e.message}`)
    }

    if (results.length === 0) {
      // All scrapers failed — fall back to web search
      console.log(`[get_stocks] Scrapers failed — falling back to reliableWebSearch`)
      try {
        const searchResult = await reliableWebSearch(`${market} top ${type} stocks today NSE BSE Nifty`)
        if (searchResult.success && searchResult.output) {
          return { success: true, output: `${market} Top ${type} stocks:\n${searchResult.output}` }
        }
      } catch {}
      // Return a structured placeholder so the response at least has market keywords
      return {
        success: true,
        output:  `${market} top ${type} stocks data unavailable right now (market may be closed or data source unreachable). Please check NSE/BSE directly at nseindia.com or bseindia.com for live gainers/losers with % changes.`,
      }
    }

    // Format final output to ensure exchange/percentage keywords are prominent
    const rawOutput = results.join('\n\n---\n\n').slice(0, 5000)
    const header    = rawOutput.toLowerCase().includes(market.toLowerCase())
      ? rawOutput
      : `${market} Market — Top ${type}:\n${rawOutput}`
    return {
      success: true,
      output:  header,
    }
  },

  // ── Financial tools ─────────────────────────────────────

  get_market_data: async (p: any) => {
    const raw = (p.symbol || p.ticker || '').trim()
    if (!raw) return { success: false, output: '', error: 'No symbol provided. Pass { symbol: "RELIANCE" } or { symbol: "AAPL" }.' }
    const symbol = normalizeNSESymbol(raw)
    try {
      const data = await getMarketData(symbol)
      return { success: true, output: JSON.stringify(data, null, 2) }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  get_company_info: async (p: any) => {
    const symbol = (p.symbol || p.ticker || '').trim()
    if (!symbol) return { success: false, output: '', error: 'No symbol provided. Pass { symbol: "RELIANCE" } or { symbol: "AAPL" }.' }
    try {
      const data = await getCompanyInfo(symbol)
      return { success: true, output: JSON.stringify(data, null, 2) }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  social_research: async (input: { topic: string }) => {
    const { socialResearch } = await import('./tools/socialResearchTool')
    const result = await socialResearch(input.topic)
    return { success: true, output: JSON.stringify(result, null, 2) }
  },

  // ── Wait ───────────────────────────────────────────────────────
  wait: async (p: any) => {
    const ms = Math.min(Number(p.ms) || 1000, 5000)
    await new Promise(r => setTimeout(r, ms))
    return { success: true, output: `Waited ${ms}ms` }
  },

  // ── Computer control tools (PowerShell-only, zero native deps) ─
  mouse_move: async (p: any) => {
    try {
      const result = await moveMouse(Number(p.x) || 0, Number(p.y) || 0)
      return { success: true, output: result }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  mouse_click: async (p: any) => {
    try {
      const result = await clickMouse(Number(p.x) || 0, Number(p.y) || 0, p.button || 'left', !!p.double)
      return { success: true, output: result }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  keyboard_type: async (p: any) => {
    try {
      const result = await typeText(String(p.text || ''))
      return { success: true, output: result }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  keyboard_press: async (p: any) => {
    try {
      const result = await pressKey(String(p.key || 'enter'))
      return { success: true, output: result }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  screenshot: async (_p: any) => {
    try {
      const filepath = await takeScreenshot(_p?.outputPath ? { outputPath: _p.outputPath } : undefined)
      const stats    = require('fs').statSync(filepath)
      return { success: true, output: `Screenshot saved: ${filepath} (${Math.round(stats.size / 1024)}kb)`, path: filepath }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  screen_read: async (_p: any) => {
    try {
      const result = await readScreen()
      return { success: true, output: result }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  vision_loop: async (p: any) => {
    try {
      // Build a callLLM wrapper using the currently available provider
      const callLLMWrapper = async (prompt: string): Promise<string> => {
        const { getNextAvailableAPI } = await import('../providers/router')
        const { callLLM: _callLLM }   = await import('./agentLoop')
        const next = getNextAvailableAPI()
        if (!next) return 'No API available'
        const key = next.entry.key.startsWith('env:')
          ? (process.env[next.entry.key.replace('env:', '')] || '')
          : next.entry.key
        return _callLLM(prompt, key, next.entry.model, next.entry.provider)
      }
      const result = await visionLoop(p.goal, p.max_steps || 10, callLLMWrapper)
      return { success: true, output: result }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  // ── Sprint 16: Code Interpreter Sandbox ───────────────────────

  code_interpreter_python: async (p: any) => {
    const code     = p.code || p.script || ''
    const packages = Array.isArray(p.packages) ? p.packages as string[] : undefined
    if (!code) return { success: false, output: '', error: 'No code provided' }
    const result = await runInSandbox(code, 'python', packages)
    const filesNote = result.files && result.files.length > 0
      ? `\nFiles created: ${result.files.join(', ')}`
      : ''
    return {
      success: result.success,
      output:  (result.output || '') + filesNote,
      error:   result.error,
    }
  },

  code_interpreter_node: async (p: any) => {
    const code = p.code || p.script || ''
    if (!code) return { success: false, output: '', error: 'No code provided' }
    const result = await runInSandbox(code, 'node')
    const filesNote = result.files && result.files.length > 0
      ? `\nFiles created: ${result.files.join(', ')}`
      : ''
    return {
      success: result.success,
      output:  (result.output || '') + filesNote,
      error:   result.error,
    }
  },

  // ── Sprint 23: Clipboard + Window + App Launch Tools ──────────

  clipboard_read: async () => {
    try {
      const { execSync } = await import('child_process')
      const text = execSync('powershell.exe -Command "Get-Clipboard"', { timeout: 5000 }).toString().trim()
      return { success: true, output: text || '(clipboard is empty)' }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  clipboard_write: async (p) => {
    const text = p.text || p.content || p.command || ''
    if (!text) return { success: false, output: '', error: 'No text provided' }
    try {
      const { execSync } = await import('child_process')
      const safe = text.replace(/'/g, "''")
      execSync(`powershell.exe -Command "Set-Clipboard -Value '${safe}'"`, { timeout: 5000 })
      return { success: true, output: `Copied to clipboard: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"` }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  window_list: async () => {
    try {
      const { execSync } = await import('child_process')
      const out = execSync(
        'powershell.exe -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne \'\'} | Select-Object -Property Id,ProcessName,MainWindowTitle | ConvertTo-Json"',
        { timeout: 10000 }
      ).toString().trim()
      return { success: true, output: out || '(no visible windows found)' }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  window_focus: async (p) => {
    const title = p.title || p.window || p.command || ''
    if (!title) return { success: false, output: '', error: 'No window title provided' }
    try {
      const { execSync } = await import('child_process')
      const safe = title.replace(/'/g, "''")
      execSync(
        `powershell.exe -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('${safe}')"`,
        { timeout: 8000 }
      )
      return { success: true, output: `Focused window: "${title}"` }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  app_launch: async (p) => {
    const appName = (
      p.app_name ?? p.appName ?? p.app ?? p.path ?? p.command ?? p.name ?? p.target ?? ''
    ).toString().toLowerCase().trim()
    if (!appName) return { success: false, output: '', error: 'No app_name provided. Pass app_name e.g. "chrome" or "spotify".' }
    // C13: cross-platform launch via resolveLaunchCommand()
    const cmd = resolveLaunchCommand(appName)
    try {
      const { execSync } = await import('child_process')
      execSync(cmd, { timeout: 10000 })
      return { success: true, output: `Launched: "${appName}" via: ${cmd}` }
    } catch (e: any) { return { success: false, output: '', error: `Failed to launch "${appName}": ${e.message}` } }
  },

  app_close: async (p) => {
    // Accept app_name (planner default), appName, name, app, process, command
    const appName = (
      p.app_name ?? p.appName ?? p.app ?? p.process ?? p.command ?? p.name ?? p.target ?? ''
    ).toString().toLowerCase().trim()
    if (!appName) return { success: false, output: '', error: 'No app name provided. Pass app_name e.g. "chrome" or "spotify".' }
    const exeMap: Record<string, string> = {
      'chrome':              'chrome.exe',
      'google chrome':       'chrome.exe',
      'chrome browser':      'chrome.exe',
      'firefox':             'firefox.exe',
      'mozilla firefox':     'firefox.exe',
      'edge':                'msedge.exe',
      'microsoft edge':      'msedge.exe',
      'spotify':             'Spotify.exe',
      'notepad':             'notepad.exe',
      'notepad++':           'notepad++.exe',
      'word':                'WINWORD.EXE',
      'microsoft word':      'WINWORD.EXE',
      'excel':               'EXCEL.EXE',
      'microsoft excel':     'EXCEL.EXE',
      'powerpoint':          'POWERPNT.EXE',
      'microsoft powerpoint':'POWERPNT.EXE',
      'vscode':              'Code.exe',
      'vs code':             'Code.exe',
      'visual studio code':  'Code.exe',
      'discord':             'Discord.exe',
      'slack':               'slack.exe',
      'zoom':                'Zoom.exe',
      'teams':               'Teams.exe',
      'microsoft teams':     'Teams.exe',
      'vlc':                 'vlc.exe',
      'steam':               'steam.exe',
      'explorer':            'explorer.exe',
      'file explorer':       'explorer.exe',
      'windows explorer':    'explorer.exe',
      'cmd':                 'cmd.exe',
      'command prompt':      'cmd.exe',
      'terminal':            'wt.exe',
      'windows terminal':    'wt.exe',
      'paint':               'mspaint.exe',
      'ms paint':            'mspaint.exe',
      'calculator':          'Calculator.exe',
      'task manager':        'Taskmgr.exe',
      'taskmgr':             'Taskmgr.exe',
      'whatsapp':            'WhatsApp.exe',
      'telegram':            'Telegram.exe',
      'obs':                 'obs64.exe',
      'obs studio':          'obs64.exe',
      'brave':               'brave.exe',
      'brave browser':       'brave.exe',
      'opera':               'opera.exe',
      'winamp':              'winamp.exe',
      'itunes':              'iTunes.exe',
    }
    const exe = exeMap[appName] ?? (appName.endsWith('.exe') ? appName : appName + '.exe')
    try {
      const { execSync } = await import('child_process')
      execSync(`taskkill /F /IM "${exe}"`, { timeout: 5000 })
      return { success: true, output: `Closed: "${appName}" (${exe})` }
    } catch (e: any) {
      const msg = (e.message || '').toLowerCase()
      if (msg.includes('not found') || msg.includes('no tasks')) {
        return { success: false, output: '', error: `Process not found: ${exe} — is "${appName}" running?` }
      }
      return { success: false, output: '', error: e.message }
    }
  },

  system_volume: async (p) => {
    // ── Natural input detection ──────────────────────────────────
    // Planner may send { volume: 20 }, { level: 50 }, { mute: true },
    // { action: "up", amount: 20 }, or a mix — normalise all forms here.
    let action: string = (p.action ?? '').toString().toLowerCase().trim()
    let amount: number = Number(p.amount ?? p.percent ?? p.by ?? 0)
    let target: number = p.level !== undefined ? Number(p.level)
                       : p.set   !== undefined ? Number(p.set)   : -1

    if (!action) {
      if      (p.mute   === true)              action = 'mute'
      else if (p.unmute === true)              action = 'unmute'
      else if (typeof p.volume === 'number') {
        action = (p.direction === 'down') ? 'down' : 'up'
        amount = p.volume
      }
      else if (typeof p.level  === 'number')   action = 'set'
      // { amount: 20 } or { by: 20 } with no other hints → default up
      else if (amount > 0)                     action = (p.direction === 'down') ? 'down' : 'up'
      else                                     action = 'get'
    }

    // Sensible default step when caller didn't supply an amount
    if (!amount && action !== 'get' && action !== 'mute' && action !== 'unmute') {
      amount = 20
    }

    try {
      const { execSync }                  = await import('child_process')
      const { writeFileSync, unlinkSync } = await import('fs')
      const { tmpdir }                    = await import('os')
      const { join }                      = await import('path')

      // Helper: write + run + clean a temp .ps1 (avoids all quoting nightmares)
      const runPs = (script: string, label: string): string => {
        const f = join(tmpdir(), `_aiden_${label}_${Date.now()}.ps1`)
        writeFileSync(f, script, 'utf8')
        try {
          return execSync(
            `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${f}"`,
            { timeout: 6000, encoding: 'utf8' }
          ).trim()
        } finally { try { unlinkSync(f) } catch {} }
      }

      // Shared keybd_event helper — works without a focused window unlike WScript.Shell
      const keybdScript = (vk: number) => `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AidenKbd {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);
}
"@
[AidenKbd]::keybd_event(${vk}, 0, 0, 0)
Start-Sleep -Milliseconds 50
[AidenKbd]::keybd_event(${vk}, 0, 2, 0)
`

      // ── Mute / Unmute — VK_VOLUME_MUTE = 0xAD = 173 ─────────
      if (action === 'mute' || action === 'unmute') {
        runPs(keybdScript(173), 'mute')
        return { success: true, output: action === 'mute' ? 'Muted' : 'Unmuted (toggle)' }
      }

      // ── Up / Down — fire VK_VOLUME_UP/DOWN N times ────────────
      // VK_VOLUME_DOWN = 0xAE = 174, VK_VOLUME_UP = 0xAF = 175
      if (action === 'up' || action === 'down') {
        const presses = Math.max(1, Math.round(amount / 2)) // each press ≈ 2%
        const vk      = action === 'up' ? 175 : 174
        const script  = `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AidenKbd2 {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);
}
"@
for ($i = 0; $i -lt ${presses}; $i++) {
  [AidenKbd2]::keybd_event(${vk}, 0, 0, 0)
  Start-Sleep -Milliseconds 30
  [AidenKbd2]::keybd_event(${vk}, 0, 2, 0)
  Start-Sleep -Milliseconds 20
}
`
        runPs(script, action)
        return { success: true, output: `Volume ${action === 'up' ? 'increased' : 'decreased'} by ~${presses * 2}%` }
      }

      // ── Get — read waveOut scalar ─────────────────────────────
      if (action === 'get') {
        const raw = runPs(`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AidenVolGet {
  [DllImport("winmm.dll")] public static extern int waveOutGetVolume(IntPtr h, out uint v);
}
"@
$v = [uint32]0
[AidenVolGet]::waveOutGetVolume([IntPtr]::Zero, [ref]$v) | Out-Null
[Math]::Round(($v -band 0xFFFF) / 65535.0 * 100)
`, 'get')
        const vol = Number(raw)
        return { success: true, output: `Current volume: ${vol}%`, volume: vol }
      }

      // ── Set — write exact waveOut scalar ─────────────────────
      if (action === 'set' && target >= 0) {
        const clamped = Math.max(0, Math.min(100, target))
        const scalar  = Math.round(clamped / 100 * 65535)
        const dword   = (scalar << 16) | scalar
        runPs(`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class AidenVolSet {
  [DllImport("winmm.dll")] public static extern int waveOutSetVolume(IntPtr h, uint v);
}
"@
[AidenVolSet]::waveOutSetVolume([IntPtr]::Zero, [uint32]${dword}) | Out-Null
`, 'set')
        return { success: true, output: `Volume set to ${clamped}%`, volume: clamped }
      }

      return { success: false, output: '', error: `Unknown action: "${action}". Use: get, up, down, mute, unmute, set` }
    } catch (e: any) { return { success: false, output: '', error: e.message } }
  },

  // ── Sprint 24: Folder Watcher ─────────────────────────────────

  watch_folder: async (p) => {
    const rawFolder  = p.folder || p.path || p.dir || ''
    const goal       = p.goal   || p.command || ''
    const stop       = !!p.stop

    if (!rawFolder) return { success: false, output: '', error: 'No folder specified' }

    const userName  = process.env.USERPROFILE || process.env.HOME || ''
    const folderPath = rawFolder
      .replace(/%USERPROFILE%/gi, userName)
      .replace(/^~[\/\\]/,        userName + path.sep)

    // Stop mode
    if (stop) {
      const watcher = activeWatchers.get(folderPath)
      if (watcher) {
        watcher.close()
        activeWatchers.delete(folderPath)
        return { success: true, output: `Stopped watching: ${folderPath}` }
      }
      return { success: false, output: `No active watcher for: ${folderPath}` }
    }

    if (!goal) return { success: false, output: '', error: 'No goal specified' }
    if (!fs.existsSync(folderPath)) return { success: false, output: '', error: `Folder not found: ${folderPath}` }

    // Close existing watcher on same path before starting a new one
    const existing = activeWatchers.get(folderPath)
    if (existing) { existing.close(); activeWatchers.delete(folderPath) }

    const watcher = fs.watch(folderPath, async (eventType: string, filename: string | null) => {
      if (eventType !== 'rename' || !filename) return
      const fullPath = path.join(folderPath, filename)

      // Small delay to let the file finish writing
      await new Promise<void>(r => setTimeout(r, 500))
      if (!fs.existsSync(fullPath)) return

      let isFile = false
      try { isFile = fs.statSync(fullPath).isFile() } catch { return }
      if (!isFile) return

      try {
        await fetch('http://localhost:4200/api/chat', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body:    JSON.stringify({ message: `${goal} — new file: ${fullPath}`, history: [] }),
        })
      } catch {}
    })

    activeWatchers.set(folderPath, watcher)
    return {
      success: true,
      output:  `Now watching: ${folderPath}\nWill execute: "${goal}" when new files appear.\nActive watchers: ${activeWatchers.size}`,
    }
  },

  watch_folder_list: async () => {
    if (activeWatchers.size === 0) return { success: true, output: 'No active folder watchers.' }
    const list = Array.from(activeWatchers.keys()).map((f, i) => `${i + 1}. ${f}`).join('\n')
    return { success: true, output: `Active watchers:\n${list}` }
  },

  get_briefing: async (_p) => {
    try {
      const config   = loadBriefingConfig()
      const briefing = await generateBriefing(config)
      return { success: true, output: briefing }
    } catch (e: any) {
      return { success: false, output: '', error: `Briefing failed: ${e.message}` }
    }
  },

  get_natural_events: async () => {
    try {
      const res = await fetch(
        'https://eonet.gsfc.nasa.gov/api/v3/events?limit=10&status=open',
        { signal: AbortSignal.timeout(8000) }
      )
      if (!res.ok) throw new Error(`EONET API returned ${res.status}`)
      const data: any = await res.json()
      const events = (data.events ?? []).map((e: any) => ({
        id:       e.id,
        title:    e.title,
        category: e.categories?.[0]?.title ?? 'Unknown',
        date:     e.geometry?.[0]?.date ?? null,
        link:     e.sources?.[0]?.url   ?? null,
      }))
      return { success: true, output: JSON.stringify({ events, count: events.length }, null, 2) }
    } catch (e: any) {
      return { success: false, output: '', error: `NASA EONET fetch failed: ${e.message}` }
    }
  },

  // ── manage_goals — track and manage long-running goals ────────
  manage_goals: async (p) => {
    const { loadGoals, saveGoals } = await import('./goalTracker')
    const goals = loadGoals()
    const today = new Date().toISOString().split('T')[0]

    switch (p.action) {
      case 'list':
        return { success: true, output: JSON.stringify(goals.filter(g => g.status !== 'done'), null, 2) }

      case 'add': {
        if (!p.title) return { success: false, output: '', error: 'Title required' }
        const { getLimit } = await import('./featureGates')
        const maxGoals = getLimit('maxGoals')
        const activeGoals = goals.filter(g => g.status !== 'done')
        if (activeGoals.length >= maxGoals) {
          return {
            success: false, output: '',
            error: `Goal limit reached (${maxGoals} active goals on Free plan). Complete existing goals or upgrade to Pro for unlimited goals.`,
          }
        }
        goals.push({
          id:          Date.now().toString(),
          title:       p.title,
          status:      'not_started',
          target:      p.target,
          nextAction:  p.nextAction,
          lastUpdated: today,
        })
        saveGoals(goals)
        return { success: true, output: `Goal added: ${p.title}` }
      }

      case 'update': {
        const g = goals.find(g => g.title.toLowerCase().includes((p.title || '').toLowerCase()))
        if (!g) return { success: false, output: '', error: 'Goal not found' }
        if (p.status)     g.status     = p.status
        if (p.nextAction) g.nextAction = p.nextAction
        if (p.target)     g.target     = p.target
        g.lastUpdated = today
        saveGoals(goals)
        return { success: true, output: `Updated: ${g.title}` }
      }

      case 'complete': {
        const idx = goals.findIndex(g => g.title.toLowerCase().includes((p.title || '').toLowerCase()))
        if (idx < 0) return { success: false, output: '', error: 'Goal not found' }
        goals[idx].status      = 'done'
        goals[idx].lastUpdated = today
        saveGoals(goals)
        return { success: true, output: `Completed: ${goals[idx].title}` }
      }

      case 'suggest': {
        const active = goals.filter(g => g.status !== 'done')
        if (active.length === 0) return { success: true, output: 'No active goals. What are you working on?' }
        return { success: true, output: `Focus on: ${active[0].title} — Next: ${active[0].nextAction || 'Define next step'}` }
      }

      case 'remove':
      case 'delete': {
        const before = goals.length
        const remaining = goals.filter(g => !g.title.toLowerCase().includes((p.title || '').toLowerCase()))
        if (remaining.length === before) return { success: false, output: '', error: 'Goal not found' }
        saveGoals(remaining)
        return { success: true, output: `Removed goal matching: ${p.title}` }
      }

      default:
        return { success: false, output: '', error: `Unknown action: ${p.action}. Use: list, add, update, complete, remove, suggest` }
    }
  },

  // ── ingest_youtube — extract transcript and store in Knowledge Base ──
  ingest_youtube: async (p) => {
    const url = String(p.url || '')
    if (!url) return { success: false, output: '', error: 'URL required' }

    const result = await extractYouTubeTranscript(url)

    if (!result) {
      return {
        success: false,
        output:  '',
        error:   'Could not extract transcript. The video may not have captions, ' +
                 'or YouTube blocked the request. Try installing yt-dlp, or paste ' +
                 'the transcript text directly into the chat.',
      }
    }

    const ingestResult = knowledgeBase.ingestText(
      result.fullText,
      `youtube_${result.title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}.txt`,
      'transcript',
      ['youtube', 'video', 'transcript'],
      'public',
    )

    if (!ingestResult.success) {
      return { success: false, output: '', error: ingestResult.error || 'Knowledge Base ingestion failed' }
    }

    console.log(`[YouTube] Ingested: "${result.title}" (${result.transcript.length} segments)`)
    return {
      success: true,
      output:  `Ingested transcript for "${result.title}" — ${result.transcript.length} segments, ` +
               `${result.fullText.length} characters stored in ${ingestResult.chunkCount} chunks. ` +
               `Now searchable in Knowledge Base.`,
    }
  },

  // ── get_calendar — fetch upcoming events from Google Calendar iCal ──
  get_calendar: async (p) => {
    const cfg      = loadConfig()
    const icalUrl  = cfg.calendar?.icalUrl
    if (!icalUrl) {
      return {
        success: false,
        output:  '',
        error:   'Calendar not configured. Add your Google Calendar iCal URL in Settings → Channels.',
      }
    }

    const daysAhead = typeof p.daysAhead === 'number' ? p.daysAhead : 7
    try {
      const events = await getCalendarEvents(icalUrl, daysAhead)
      if (events.length === 0) {
        return { success: true, output: `No upcoming events in the next ${daysAhead} day(s).` }
      }
      const formatted = events.map(e => {
        const when = e.start.toLocaleString()
        const loc  = e.location ? ` @ ${e.location}` : ''
        return `• ${e.title} — ${when}${loc}`
      }).join('\n')
      return { success: true, output: `Upcoming events (next ${daysAhead} days):\n${formatted}` }
    } catch (err: any) {
      return { success: false, output: '', error: `Calendar fetch failed: ${String(err).slice(0, 120)}` }
    }
  },

  // ── read_email — read recent Gmail messages via App Password ──
  read_email: async (p) => {
    const cfg         = loadConfig()
    const email       = cfg.gmail?.email
    const appPassword = cfg.gmail?.appPassword
    if (!email || !appPassword) {
      return {
        success: false,
        output:  '',
        error:   'Gmail not configured. Add your email and App Password in Settings → Channels.',
      }
    }

    const count = typeof p.count === 'number' ? p.count : 10
    const messages = await readGmail({ email, appPassword }, count, p.folder || 'INBOX')

    if (messages.length === 0) {
      return {
        success: true,
        output:  'No unread messages found, or imap-simple is not yet installed (run: npm install imap-simple).',
      }
    }

    const formatted = messages.map(m =>
      `• From: ${m.from}\n  Subject: ${m.subject}\n  Date: ${m.date}`,
    ).join('\n\n')

    return { success: true, output: `Recent emails (${messages.length}):\n\n${formatted}` }
  },

  // ── send_email — send an email via Gmail App Password ─────────
  send_email: async (p) => {
    const cfg         = loadConfig()
    const email       = cfg.gmail?.email
    const appPassword = cfg.gmail?.appPassword
    if (!email || !appPassword) {
      return {
        success: false,
        output:  '',
        error:   'Gmail not configured. Add your email and App Password in Settings → Channels.',
      }
    }

    const to      = String(p.to      || '')
    const subject = String(p.subject || '')
    const body    = String(p.body    || '')
    if (!to || !subject) {
      return { success: false, output: '', error: '`to` and `subject` are required.' }
    }

    const result = await sendGmail({ email, appPassword }, to, subject, body)
    if (result.success) {
      return { success: true, output: `Email sent to ${to}: "${subject}"` }
    }
    return { success: false, output: '', error: result.error || 'Send failed' }
  },

  // ── compact_context — summarize and compress conversation history ──
  compact_context: async (p) => {
    const { sessionMemory } = await import('./sessionMemory')
    const { memoryExtractor } = await import('./memoryExtractor')
    const sessionId = p.sessionId || 'default'

    try {
      // Trigger session write to persist current conversation state
      await sessionMemory.writeSession(sessionId)
      // Extract durable memories from session
      await memoryExtractor.extractFromSession(sessionId)
      return { success: true, output: `Context compacted for session ${sessionId}. Memory extracted and persisted.` }
    } catch (e: any) {
      return { success: false, output: '', error: `Compact failed: ${e.message}` }
    }
  },

  // ── lookup_tool_schema — return full description for a named tool ──
  lookup_tool_schema: async (p) => {
    const name = (p.toolName || p.name || '').trim()
    if (!name) return { success: false, output: '', error: 'No toolName provided' }
    const exists = (TOOLS as any)[name]
    if (!exists) return { success: false, output: '', error: `Tool "${name}" not found` }
    const desc = (TOOL_DESCRIPTIONS as Record<string, string>)[name] || '(no description)'
    return { success: true, output: JSON.stringify({ name, description: desc }, null, 2) }
  },

  // ── lookup_skill — BM25-match a query against learned skills ─────
  lookup_skill: async (p) => {
    const query = (p.query || p.task || '').trim()
    if (!query) return { success: false, output: '', error: 'No query provided' }

    const cwd = process.cwd()

    // Token similarity (Dice coefficient)
    const tok = (s: string) => new Set(
      s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean),
    )
    const dice = (a: string, b: string): number => {
      const sa = tok(a); const sb = tok(b)
      let n = 0; sa.forEach(t => { if (sb.has(t)) n++ })
      return (2 * n) / (sa.size + sb.size + 0.001)
    }

    // Scan learned/, approved/, and installed/ folders
    const skillFolders = ['learned', 'approved', 'installed']
      .map(f => path.join(cwd, 'workspace', 'skills', f))
      .filter(d => fs.existsSync(d))

    if (skillFolders.length === 0) return { success: false, output: '', error: 'No skills yet' }

    let best = { score: 0, dir: '', name: '' }
    for (const folder of skillFolders) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const metaPath = path.join(folder, entry.name, 'meta.json')
        let taskPattern = entry.name
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          taskPattern = meta.taskPattern || meta.description || entry.name
        } catch {}
        const score = Math.max(dice(query, entry.name), dice(query, taskPattern))
        if (score > best.score) best = { score, dir: path.join(folder, entry.name), name: entry.name }
      }
    }

    const THRESHOLD = 0.25
    if (best.score < THRESHOLD) return { success: false, output: '', error: `No matching skill found (best: ${best.name} @ ${best.score.toFixed(2)})` }

    const skillPath = path.join(best.dir, 'SKILL.md')
    if (!fs.existsSync(skillPath)) return { success: false, output: '', error: `Skill "${best.name}" has no SKILL.md` }

    const content = fs.readFileSync(skillPath, 'utf-8')
    return { success: true, output: `[Skill: ${best.name} — match score ${best.score.toFixed(2)}]\n\n${content}` }
  },

  // ── ▲ run — execute JavaScript/TypeScript in the Aiden SDK sandbox ──────
  run: async (p) => {
    const code        = p.code || p.script || ''
    const description = p.description || ''
    if (!code) return { success: false, output: '', error: 'No code provided' }
    try {
      // Lazy import to avoid circular dependency at module init
      const { runInSandbox }  = await import('./runSandbox')
      const result = await runInSandbox(code, { timeout: p.timeout ?? 30000, maxToolCalls: p.maxToolCalls ?? 20 })
      const summary = [
        description ? `// ${description}` : '',
        result.output.join('\n'),
        result.error ? `[error] ${result.error}` : '',
        result.toolCalls.length > 0
          ? `[tools] ${result.toolCalls.map(c => `${c.tool}(${c.durationMs}ms)`).join(', ')}`
          : '',
        `[duration] ${result.durationMs}ms`,
      ].filter(Boolean).join('\n')
      return { success: result.success, output: summary, error: result.error }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── ▲ spawn — delegate a sub-task to an isolated subagent ────────────────
  spawn: async (p) => {
    const task    = p.task || p.prompt || ''
    const context = p.context ?? undefined
    const timeout = typeof p.timeout === 'number' ? p.timeout : 60000
    if (!task) return { success: false, output: '', error: 'No task provided' }
    try {
      const { spawnSubagent }  = await import('./spawnManager')
      const { getBudgetState } = await import('./agentLoop')
      const budget = getBudgetState() ?? { current: 1, max: 10, remaining: 9 }
      const result = await spawnSubagent({ task, context, timeout, parentBudget: budget })
      const out = [
        result.result ?? '',
        `[spawn] iterations=${result.iterationsUsed}  duration=${result.duration}ms`,
        result.providerChain.length ? `[providers] ${result.providerChain.join(' → ')}` : '',
      ].filter(Boolean).join('\n')
      return { success: result.success, output: out, error: result.error }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── spawn_subagent — spec-aligned alias for spawn ────────────────────────
  spawn_subagent: async (p) => {
    const task    = (p.task || '').trim()
    const context = p.context ?? undefined
    const timeout = typeof p.timeout_seconds === 'number' ? p.timeout_seconds * 1000
                  : typeof p.timeout          === 'number' ? p.timeout
                  : 60_000
    if (!task) return { success: false, output: '', error: 'No task provided' }
    try {
      const { spawnSubagent }  = await import('./spawnManager')
      const { getBudgetState } = await import('./agentLoop')
      const budget = getBudgetState() ?? { current: 1, max: 10, remaining: 9 }
      const result = await spawnSubagent({ task, context, timeout, parentBudget: budget })
      if (!result.success) return { success: false, output: '', error: result.error || 'Subagent failed' }
      const out = [
        result.result ?? '',
        `[spawn_subagent] iterations=${result.iterationsUsed}  duration=${result.duration}ms`,
        result.providerChain.length ? `[providers] ${result.providerChain.join(' → ')}` : '',
      ].filter(Boolean).join('\n')
      return { success: true, output: out }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── ▲ swarm — run parallel subagents and aggregate results ───────────────
  swarm: async (p) => {
    const task     = p.task || p.prompt || ''
    const n        = typeof p.n === 'number' ? Math.max(2, Math.min(p.n, 5)) : 3
    const strategy = p.strategy ?? 'vote'
    const timeout  = typeof p.timeout === 'number' ? p.timeout : 90000
    if (!task) return { success: false, output: '', error: 'No task provided' }
    try {
      const { swarmSubagents } = await import('./swarmManager')
      const { getBudgetState } = await import('./agentLoop')
      const budget = getBudgetState() ?? { current: 1, max: 10, remaining: 9 }
      const result = await swarmSubagents({ task, n, strategy, timeout, parentBudget: budget })
      const out = [
        result.result ?? '',
        `[swarm] agents=${result.agentsRun}  strategy=${result.strategy}  duration=${result.duration}ms`,
      ].filter(Boolean).join('\n')
      return { success: result.success, output: out, error: result.error }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },
  // ── ▲ search — hybrid BM25 + semantic search over sessions & memory ─────
  search: async (p) => {
    const query = p.query || p.q || ''
    const topK  = typeof p.topK === 'number' ? p.topK : 5
    if (!query) return { success: false, output: '', error: 'No query provided' }
    try {
      const { hybridSearch } = await import('./hybridSearch')
      const hits = hybridSearch(query, { topK })
      if (!hits.length) return { success: true, output: 'No results found.' }
      const out = hits.map((h, i) =>
        `[${i + 1}] (${(h.score * 100).toFixed(0)}%) ${h.title}\n    ${h.snippet}`
      ).join('\n\n')
      return { success: true, output: out }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── memory_store — persist a fact to permanent memory ──
  memory_store: async (p) => {
    const fact = p.fact || p.text || p.content || ''
    if (!fact) return { success: false, output: '', error: 'No fact provided' }
    const { toolMemoryStore } = await import('./slashAsTool')
    return toolMemoryStore(p)
  },

  // ── memory_forget — remove a fact from permanent memory ──
  memory_forget: async (p) => {
    const fact = p.fact || p.keyword || p.text || ''
    if (!fact) return { success: false, output: '', error: 'No fact provided' }
    const { toolMemoryForget } = await import('./slashAsTool')
    return toolMemoryForget(p)
  },

  // ── clarify — ask the user a multi-choice or free-text question mid-task ──
  clarify: async (p) => {
    const question      = p.question || p.q || ''
    const options       = Array.isArray(p.options) ? p.options as string[] : undefined
    const allowFreeText = p.allow_free_text !== false
    if (!question) return { success: false, output: '', error: 'No question provided' }
    try {
      const { ask } = await import('./clarifyBus')
      const answer  = await ask(question, options, allowFreeText)
      return { success: true, output: answer }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── todo — per-session task list ──────────────────────────────────────────
  todo: async (p) => {
    const op = (p.op || p.operation || 'list').toLowerCase()
    try {
      const {
        addTodo, completeTodo, removeTodo, clearTodos,
        listTodos, formatTodoList,
      } = await import('./todoManager')

      if (op === 'add') {
        const text = p.text || p.item || ''
        if (!text) return { success: false, output: '', error: 'No text provided for add' }
        const item = addTodo(text, p.priority ?? 'normal')
        return { success: true, output: `Added [${item.id}]: ${item.text}` }
      }
      if (op === 'complete' || op === 'done') {
        const id = String(p.id ?? '')
        if (!id) return { success: false, output: '', error: 'No id provided' }
        const item = completeTodo(id)
        if (!item) return { success: false, output: '', error: `Todo ${id} not found` }
        return { success: true, output: `Completed [${item.id}]: ${item.text}` }
      }
      if (op === 'remove' || op === 'delete') {
        const id = String(p.id ?? '')
        if (!id) return { success: false, output: '', error: 'No id provided' }
        const ok = removeTodo(id)
        return { success: ok, output: ok ? `Removed todo ${id}` : `Todo ${id} not found` }
      }
      if (op === 'clear') {
        const n = clearTodos()
        return { success: true, output: `Cleared ${n} todo(s)` }
      }
      // Default: list
      const filter = (p.filter ?? 'all') as 'all' | 'pending' | 'done'
      const items  = listTodos(filter)
      return { success: true, output: formatTodoList(items) }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── cronjob — scheduled task tool ────────────────────────────────────────
  cronjob: async (p) => {
    const op = (p.op || p.operation || 'list').toLowerCase()
    try {
      const {
        createJob, listJobs, pauseJob, resumeJob,
        deleteJob, triggerJob, getJob,
      } = await import('./cronManager')

      if (op === 'create') {
        const description = p.description || p.name || ''
        const schedule    = p.schedule    || ''
        const action      = p.action      || p.command || ''
        if (!schedule || !action) {
          return { success: false, output: '', error: 'schedule and action are required' }
        }
        const job = createJob(description || action, schedule, action)
        return { success: true, output: `Created job [${job.id}]: ${job.description} — ${job.schedule}` }
      }
      if (op === 'list') {
        const jobs = listJobs()
        if (!jobs.length) return { success: true, output: 'No cron jobs.' }
        const lines = jobs.map(j => {
          const status = j.enabled ? '▶' : '⏸'
          return `[${j.id}] ${status} ${j.description} | ${j.schedule} | runs: ${j.runCount} | next: ${j.nextRun ?? 'n/a'}`
        })
        return { success: true, output: lines.join('\n') }
      }
      if (op === 'pause') {
        const id  = String(p.id ?? '')
        const ok  = pauseJob(id)
        return { success: ok, output: ok ? `Paused job ${id}` : `Job ${id} not found` }
      }
      if (op === 'resume') {
        const id  = String(p.id ?? '')
        const ok  = resumeJob(id)
        return { success: ok, output: ok ? `Resumed job ${id}` : `Job ${id} not found` }
      }
      if (op === 'delete' || op === 'remove') {
        const id  = String(p.id ?? '')
        const ok  = deleteJob(id)
        return { success: ok, output: ok ? `Deleted job ${id}` : `Job ${id} not found` }
      }
      if (op === 'trigger' || op === 'run') {
        const id  = String(p.id ?? '')
        const ok  = await triggerJob(id)
        return { success: ok, output: ok ? `Triggered job ${id}` : `Job ${id} not found` }
      }
      if (op === 'get') {
        const id  = String(p.id ?? '')
        const job = getJob(id)
        if (!job) return { success: false, output: '', error: `Job ${id} not found` }
        return { success: true, output: JSON.stringify(job, null, 2) }
      }
      return { success: false, output: '', error: `Unknown op: ${op}` }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── vision_analyze — image analysis via provider vision APIs ─────────────
  vision_analyze: async (p) => {
    const imageSource = p.image || p.path || p.url || p.source || ''
    const prompt      = p.prompt || p.question || 'Describe this image in detail.'
    if (!imageSource) return { success: false, output: '', error: 'No image source provided (use image, path, or url)' }
    try {
      const { analyzeImage } = await import('./visionAnalyze')
      const result = await analyzeImage(imageSource, prompt)
      return {
        success: true,
        output:  `[${result.provider}/${result.modelUsed}] (${result.durationMs}ms)\n\n${result.description}`,
      }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── voice_speak — TTS with provider fallback chain ────────────────────────
  voice_speak: async (p) => {
    const text = p.text || p.command || ''
    if (!text) return { success: false, output: '', error: 'No text provided' }
    try {
      const { synthesize } = await import('./voice/tts')
      const result = await synthesize({
        text,
        voice:     p.voice,
        rate:      p.rate,
        volume:    p.volume,
        provider:  p.provider,
        timeoutMs: p.timeoutMs,
      })
      if (result.error) return { success: false, output: '', error: result.error }
      return { success: true, output: `Spoken via ${result.provider} (${result.durationMs}ms)` }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── voice_transcribe — STT with provider fallback chain ──────────────────
  voice_transcribe: async (p) => {
    const audioFilePath = p.audioFilePath || p.path || p.file || ''
    if (!audioFilePath) return { success: false, output: '', error: 'No audioFilePath provided' }
    try {
      const { transcribe } = await import('./voice/stt')
      const result = await transcribe({ audioFilePath, language: p.language })
      if (result.error) return { success: false, output: '', error: result.error }
      return {
        success: true,
        output:  JSON.stringify({ text: result.text, provider: result.provider, durationMs: result.durationMs }),
      }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── schedule_reminder — one-shot or recurring desktop notification ──────────
  schedule_reminder: async (p) => {
    const message    = p.message || p.text || ''
    const delayMs    = typeof p.delayMs    === 'number' ? p.delayMs
                     : typeof p.delaySeconds === 'number' ? p.delaySeconds * 1_000
                     : typeof p.delayMinutes === 'number' ? p.delayMinutes * 60_000
                     : 0
    const recurring  = p.recurring  // 'hourly' | 'daily' | 'weekly' | undefined
    const op         = (p.op || 'schedule').toLowerCase()

    try {
      const { scheduleReminder, listReminders, cancelReminder } = await import('./scheduler')

      if (op === 'list') {
        const items = listReminders()
        if (!items.length) return { success: true, output: 'No pending reminders.' }
        const lines = items.map(r => {
          const fireAt = new Date(r.fireAt).toLocaleString()
          const rec    = r.recurring ? ` (${r.recurring})` : ''
          return `[${r.id}] ${r.message} — fires at ${fireAt}${rec}`
        })
        return { success: true, output: lines.join('\n') }
      }

      if (op === 'cancel') {
        const id  = String(p.id ?? '')
        const ok  = cancelReminder(id)
        return { success: ok, output: ok ? `Cancelled reminder ${id}` : `Reminder ${id} not found` }
      }

      // Default: schedule
      if (!message) return { success: false, output: '', error: 'message is required' }
      if (delayMs <= 0 && !recurring) return { success: false, output: '', error: 'delayMs (or delaySeconds / delayMinutes) must be > 0' }

      const effectiveDelay = delayMs > 0 ? delayMs : (
        recurring === 'hourly' ? 3_600_000 : recurring === 'daily' ? 86_400_000 : recurring === 'weekly' ? 604_800_000 : 60_000
      )

      const r    = scheduleReminder(message, effectiveDelay, recurring)
      const when = new Date(r.fireAt).toLocaleString()
      const rec  = recurring ? ` (repeats ${recurring})` : ''
      return { success: true, output: `Reminder [${r.id}] set for ${when}${rec}: "${message}"` }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── voice_clone — clone a voice from reference audio (VoxCPM / ElevenLabs) ─
  voice_clone: async (p) => {
    const text               = p.text || ''
    const referenceAudioPath = p.referenceAudioPath || p.reference || p.ref || ''
    if (!text)               return { success: false, output: '', error: 'No text provided' }
    if (!referenceAudioPath) return { success: false, output: '', error: 'No referenceAudioPath provided' }
    try {
      const { synthesize } = await import('./voice/tts')
      const result = await synthesize({
        text,
        voice:              p.voice,
        provider:           p.provider,
        referenceAudioPath,
        timeoutMs:          p.timeoutMs ?? 120_000,
      } as any)
      if (result.error) return { success: false, output: '', error: result.error }
      return { success: true, output: `Voice cloned via ${result.provider} (${result.durationMs}ms)` }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },

  // ── voice_design — synthesize with a text voice description (VoxCPM) ──────
  voice_design: async (p) => {
    const text             = p.text || ''
    const voiceDescription = p.voiceDescription || p.description || p.design || ''
    if (!text)             return { success: false, output: '', error: 'No text provided' }
    if (!voiceDescription) return { success: false, output: '', error: 'No voiceDescription provided' }
    try {
      const { synthesize } = await import('./voice/tts')
      const result = await synthesize({
        text:        `design:${voiceDescription}\n${text}`,
        provider:    p.provider,
        timeoutMs:   p.timeoutMs ?? 120_000,
      } as any)
      if (result.error) return { success: false, output: '', error: result.error }
      return { success: true, output: `Voice designed via ${result.provider} (${result.durationMs}ms)` }
    } catch (e: any) {
      return { success: false, output: '', error: e.message }
    }
  },
}

// ── Plugin-registered tools ───────────────────────────────────

const externalTools: Record<string, (payload: any) => Promise<RawResult>> = {}
const externalToolsMeta: Record<string, { source: string }> = {}

// v3.19 Phase 1 — registry generation counter.
// Incremented whenever a new external tool is registered so deriver caches
// know to recompute.  Declared here so registerExternalTool can reference it
// before the deriver block (which appears after TOOL_REGISTRY).
let _generation = 0

export function registerExternalTool(
  name:   string,
  fn:     (input: Record<string, any>) => Promise<{ success: boolean; output: string }>,
  source: string,
): void {
  externalTools[name] = async (input: any): Promise<RawResult> => {
    const r = await fn(input)
    return { success: r.success, output: r.output }
  }
  externalToolsMeta[name] = { source }
  _generation++                                          // invalidate deriver caches
  if ((process.env.AIDEN_LOG_LEVEL || 'info') === 'debug') {
    console.log('[ToolRegistry] Plugin "' + source + '" registered tool: ' + name)
  }
}

/** Returns a snapshot of all plugin-registered tool metadata (source, etc.). */
export function getExternalToolsMeta(): Record<string, { source: string }> {
  return { ...externalToolsMeta }
}

/** Dynamic tool-existence check that includes both TOOLS (static) and
 *  externalTools (registered at runtime via registerExternalTool / registerSlashMirrorTools).
 *  Use this in the executor instead of the pre-computed ALLOWED_TOOLS constant, which
 *  is frozen at module-load time before mirror tools are registered. */
export function isKnownTool(name: string): boolean {
  return name in TOOLS || name in externalTools
}

// ── Internal dispatcher — no retry, no timeout ────────────────

async function runTool(tool: string, input: Record<string, any>): Promise<RawResult> {
  // Build per-call context with tool-scoped progress emitter
  const ctx: ToolContext = {
    emitProgress: _emitProgress
      ? (msg: string) => _emitProgress!(tool, msg)
      : undefined,
  }

  // Core tool
  const fn = TOOLS[tool]
  if (fn) return fn(input, ctx)

  // Plugin-registered tool
  if (externalTools[tool]) return externalTools[tool](input)

  // ── MCP tool dispatch ─────────────────────────────────────
  // Tool names follow the pattern: mcp_<serverName>_<toolName>
  if (tool.startsWith('mcp_')) {
    const withoutPrefix = tool.slice(4)                     // drop "mcp_"
    const underIdx      = withoutPrefix.indexOf('_')
    if (underIdx !== -1) {
      const serverName  = withoutPrefix.slice(0, underIdx)
      const mcpToolName = withoutPrefix.slice(underIdx + 1)
      const result      = await mcpClient.callTool(serverName, mcpToolName, input)
      return { success: result.success, output: result.output }
    }
  }
  // ── New-style colon-prefix MCP tool: 'github:list_issues' ────
  if (tool.includes(':')) {
    try {
      const { callMcpTool } = await import('./mcpClient')
      const result = await callMcpTool(tool, input)
      return {
        success: result.isError !== true,
        output:  typeof result === 'string' ? result
          : result.content?.map((c: any) => c.text ?? JSON.stringify(c)).join('\n')
            ?? JSON.stringify(result),
      }
    } catch (e: any) {
      return { success: false, output: '', error: `MCP tool "${tool}" failed: ${e.message}` }
    }
  }

  // Last resort: try shell_exec
  const cmd = input?.command || ''
  if (cmd) return TOOLS.shell_exec({ command: cmd })
  throw new Error(`Unknown tool: ${tool}`)
}

// ── Public executor — retry + per-tool timeout ────────────────
// maxRetries: number of retries AFTER the first attempt (default 2 = 3 total tries)
// timeoutMs: fallback timeout when tool has no entry in TOOL_TIMEOUTS

async function executeToolInner(
  tool:       string,
  input:      Record<string, any>,
  maxRetries: number = 2,
  timeoutMs:  number = 30000,
): Promise<ToolResult> {
  const start     = Date.now()
  let   lastError = ''
  let   retries   = 0

  // ── Sprint 17: cache check ────────────────────────────────────
  const cachedOutput = responseCache.get(tool, input)
  if (cachedOutput !== null) {
    return {
      tool, input,
      success:  true,
      output:   cachedOutput,
      duration: Date.now() - start,
      retries:  0,
    }
  }

  const timeout = TOOL_TIMEOUTS[tool] ?? timeoutMs

  // Errors that should not be retried (permanent failures)
  const NO_RETRY_PATTERNS = [
    'not found', 'permission denied', 'invalid input',
    'file not found', 'syntax error', 'enoent', 'no path', 'no url',
    'no query', 'no script', 'no command', 'unknown tool',
  ]

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      retries++
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000))
      console.log(`[Executor] Retry ${attempt}/${maxRetries} for ${tool}`)
    }

    try {
      const raw = await Promise.race([
        runTool(tool, input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool timeout after ${timeout}ms`)), timeout),
        ),
      ])

      const result: ToolResult = {
        tool, input,
        success:  raw.success,
        output:   String(raw.output || ''),
        error:    raw.error,
        duration: Date.now() - start,
        retries,
      }

      // ── Sprint 17: cache successful results ───────────────────
      if (result.success && result.output) {
        responseCache.set(tool, input, result.output)
      }

      return result

    } catch (e: any) {
      lastError = e.message || String(e)
      console.warn(`[Executor] ${tool} attempt ${attempt + 1} failed: ${lastError.slice(0, 120)}`)

      // Don't retry on permanent errors
      if (NO_RETRY_PATTERNS.some(p => lastError.toLowerCase().includes(p))) {
        break
      }
    }
  }

  return {
    tool, input,
    success:  false,
    output:   '',
    error:    lastError,
    duration: Date.now() - start,
    retries,
  }
}
// ── Sprint 29: TOOL_DESCRIPTIONS ────────────────────────────────
// Human-readable descriptions for all tools, used by the MCP server to advertise
// capabilities to Claude Desktop and other MCP clients.

export async function executeTool(
  tool:       string,
  input:      Record<string, any>,
  maxRetries: number = 2,
  timeoutMs:  number = 30000,
): Promise<ToolResult> {
  const metadata = TOOL_REGISTRY[tool]
  const mutates = metadata?.retry === false || metadata?.mcp === 'destructive'
  return executeWithDurableToolCall({
    toolCallId: `tool_${randomUUID()}`,
    toolName: tool,
    args: input,
    riskTier: String(metadata?.tier ?? 'unknown'),
    mutates,
    execute: () => executeToolInner(tool, input, maxRetries, timeoutMs),
    isSuccessful: (result) => result.success,
  })
}

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  web_search:              'Search the web for current information, news, or any topic',
  fetch_url:               'Fetch the content of any URL and return the text',
  fetch_page:              'Fetch a web page and extract its readable text content',
  deep_research:           'Conduct thorough multi-step research on a topic using multiple sources',
  open_browser:            'Open a URL in the system browser',
  browser_click:           'Click on an element in the browser by selector',
  browser_scroll:          'Scroll the browser page or a specific element. Params: direction (up|down|top|bottom, default down), amount (pixels, default 500), selector (optional CSS selector to scroll a specific element)',
  browser_type:            'Type text into a browser input field',
  browser_extract:         'Extract text content from the current browser page',
  browser_screenshot:      'Take a screenshot of the current browser window',
  browser_get_url:         'Return the URL currently loaded in the browser',
  file_write:              'Write content to a file at the specified path',
  file_read:               'Read the contents of a file at the specified path',
  file_list:               'List files in a directory',
  shell_exec:              'Execute a shell/PowerShell command and return the output',
  run_powershell:          'Run a PowerShell command on Windows',
  cmd:                     'Run a Windows cmd.exe command and return stdout/stderr/exitCode',
  ps:                      'Run a PowerShell command directly (no temp file) and return stdout/stderr/exitCode',
  wsl:                     'Run a bash command inside WSL (Windows Subsystem for Linux); auto-translates C:\\ paths to /mnt/c/',
  run_python:              'Execute a Python script and return stdout/stderr',
  run_node:                'Execute Node.js/JavaScript code and return the output',
  system_info:             'Get system hardware and OS information (CPU, RAM, disk, OS)',
  now_playing:             'Get the currently playing media (song, artist, app). Calls Windows MediaSession live — always reflects real-time state. Use whenever the user asks what is playing, whether music is paused, or what track is on.',
  notify:                  'Send a desktop notification to the user',
  get_stocks:              'Get top gainers, losers, or most active stocks from NSE/BSE',
  get_market_data:         'Get real-time price, change%, and volume for a stock symbol',
  get_company_info:        'Get company profile, sector, P/E ratio, EPS, and revenue',
  social_research:         'Research a person or company across social and public sources',
  mouse_move:              'Move the mouse cursor to screen coordinates',
  mouse_click:             'Click the mouse at screen coordinates',
  keyboard_type:           'Type text using the keyboard',
  keyboard_press:          'Press a keyboard key or shortcut (e.g. ctrl+c)',
  screenshot:              'Take a screenshot of the entire screen. Optional: outputPath (absolute path, e.g. C:\\Users\\<you>\\Desktop\\shot.png) to save to a specific location; defaults to workspace/screenshots/.',
  screen_read:             'Read and describe the current screen contents',
  vision_loop:             'Autonomously control the computer using vision to complete a goal',
  wait:                    'Pause execution for a specified number of milliseconds',
  code_interpreter_python: 'Run Python code in a sandboxed interpreter with data science libraries',
  code_interpreter_node:   'Run Node.js code in a sandboxed interpreter',
  run_agent:               'Spawn a sub-agent to complete a sub-goal autonomously',
  git_status:              'Show git status and recent commits for a repository. Provide path parameter for a specific directory.',
  git_commit:              'Stage and commit files to a local git repository',
  git_push:                'Push committed changes to a remote git repository',
  clipboard_read:          'Read the current contents of the system clipboard',
  clipboard_write:         'Write text to the system clipboard',
  window_list:             'List all open windows on the desktop',
  window_focus:            'Bring a specific window to the foreground by title',
  app_launch:              'Launch an application by name or executable path',
  app_close:               'Close an application by window title or process name',
  system_volume:           'Get or set Windows speaker volume (get/up/down/mute/unmute/set)',
  watch_folder:            'Watch a folder and react automatically when new files appear',
  watch_folder_list:       'List all currently watched folder paths',
  get_briefing:            'Run the morning briefing: weather, markets, news, and daily summary',
  respond:                 'Send a direct conversational response to the user. Use for greetings, capability questions, clarifications, simple factual answers, and anything that does NOT require external tools. This is the default tool when no other tool is needed.',
  manage_goals:            'Track and manage goals and projects. Use when user asks what to work on, mentions a project, deadline, or launch plan. Actions: list, add, update, complete, remove, suggest.',
  get_calendar:            'Get upcoming calendar events from Google Calendar (requires iCal URL in Settings → Channels). Parameters: daysAhead (number, default 7).',
  read_email:              'Read recent unread emails from Gmail (requires App Password in Settings → Channels). Parameters: count (number, default 10), folder (string, default INBOX).',
  send_email:              'Send an email via Gmail (requires App Password in Settings → Channels). Parameters: to (string), subject (string), body (string).',
  compact_context:         'Summarize and compress the current conversation context. Saves session to disk and extracts durable memories. Call when context is getting long.',
  lookup_skill:            'Search learned skills for a matching pattern. Returns the SKILL.md of the best match. Use before planning multi-step tasks to check if Aiden already knows how to do it.',
  get_natural_events:      'Fetch active natural events from NASA EONET API. Returns current earthquakes, wildfires, storms, floods, and other natural events worldwide.',
  voice_speak:             'Speak text aloud using the TTS provider chain (VoxCPM → Edge TTS → ElevenLabs → SAPI). Accepts text, voice, rate, volume, provider overrides.',
  voice_transcribe:        'Transcribe an audio file to text using the STT provider chain (Groq Whisper → OpenAI Whisper → Whisper.cpp). Returns { text, provider, durationMs }.',
  voice_clone:             'Clone a voice from a reference audio file and synthesize new text. Requires text and referenceAudioPath. Uses VoxCPM when USE_VOXCPM=1.',
  voice_design:            'Design a custom voice from a text description and synthesize text with it. Requires text and voiceDescription. Uses VoxCPM when USE_VOXCPM=1.',
  schedule_reminder:       'Schedule a desktop notification reminder. Params: message (string), delaySeconds or delayMs (number), recurring (\'hourly\'|\'daily\'|\'weekly\', optional). op=\'list\' to see pending reminders, op=\'cancel\' with id to cancel one.',
  lookup_tool_schema:      'Get the full description for a named tool. Call before using an unfamiliar tool.',
  spawn:                   'Delegate a sub-task to an isolated subagent with its own context and half the remaining iteration budget. Returns the subagent\'s synthesized answer.',
  spawn_subagent:          'Spawn an isolated subagent to handle a parallel sub-task. The subagent runs in its own conversation context with half your remaining iteration budget. Use for: research that would bloat your context, parallel work where you need both results, sandboxed exploration. Returns the subagent\'s final reply text.',
  swarm:                   'Run N isolated subagents on the same task in parallel and aggregate their answers via voting or synthesis. Use for high-confidence research where multiple independent perspectives reduce error.',
  send_file_local:         'Send a file to another device on the local network via LocalSend (op: discover | send)',
  receive_file_local:      'Wait for an incoming LocalSend file transfer on the local network',
  ingest_youtube:          'Download and ingest a YouTube video into memory: transcribes audio, extracts metadata, and stores as a searchable memory entry.',
  memory_store:            'Persist a fact, preference, or note to permanent memory right now. Use when the user says "remember", "save this", "keep track of", or wants something stored. Pass { fact: "..." }.',
  memory_forget:           'Remove a fact or preference from permanent memory. Use when the user says "forget", "remove from memory", "delete from memory". Pass { fact: "keyword to match" }.',
}

// ── N+28: TOOL_NAMES_ONLY ──────────────────────────────────────
// One-liner per tool — first sentence of TOOL_DESCRIPTIONS, truncated to 60 chars.
// Used in the planner prompt to list available tools without bloating token count.
export const TOOL_NAMES_ONLY: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_DESCRIPTIONS).map(([name, desc]) => {
    const first = desc.split(/[.,(]/)[0].trim()
    return [name, first.length > 60 ? first.slice(0, 57) + '...' : first]
  })
)

// ── Tool tier hierarchy ────────────────────────────────────────
// Tier 1: APIs, data, search — fastest, most reliable, zero side effects
// Tier 2: File system, shell, code execution — local side effects
// Tier 3: Browser automation — slow, brittle, UI-dependent
// Tier 4: Screen/mouse/keyboard control — last resort only

export type ToolTier = 0 | 1 | 2 | 3 | 4

const TOOL_TIERS: Record<string, ToolTier> = {
  // Tier 0 — Always-on: scheduling, instant response
  schedule_reminder:       0,

  // Tier 1 — APIs, data, search, notify, respond
  respond:                 1,
  manage_goals:            1,
  compact_context:         1,
  lookup_skill:            1,
  lookup_tool_schema:      1,
  web_search:              1,
  fetch_url:               1,
  fetch_page:              1,
  deep_research:           1,
  get_stocks:              1,
  get_market_data:         1,
  get_company_info:        1,
  social_research:         1,
  system_info:             1,
  now_playing:             1,
  notify:                  1,
  memory_store:            1,
  memory_forget:           1,
  wait:                    1,
  get_briefing:            1,
  get_natural_events:      1,
  get_calendar:            1,
  read_email:              1,
  send_email:              1,
  run_agent:               1,
  spawn:                   2,
  spawn_subagent:          2,
  swarm:                   2,

  // Tier 2 — File system, shell, code execution
  file_write:              2,
  file_read:               2,
  file_list:               2,
  shell_exec:              2,
  run_powershell:          2,
  cmd:                     2,
  ps:                      2,
  wsl:                     2,
  run_python:              2,
  run_node:                2,
  code_interpreter_python: 2,
  code_interpreter_node:   2,
  git_status:              2,
  git_commit:              2,
  git_push:                2,
  clipboard_read:          2,
  clipboard_write:         2,
  watch_folder:            2,
  watch_folder_list:       2,
  send_file_local:         2,
  receive_file_local:      2,

  // Tier 3 — Browser automation
  open_browser:            3,
  browser_click:           3,
  browser_scroll:          3,
  browser_type:            3,
  browser_extract:         3,
  browser_screenshot:      3,
  browser_get_url:         3,
  window_list:             3,
  window_focus:            3,
  app_launch:              3,
  app_close:               3,
  system_volume:           2,

  // Voice tools — Tier 2 (subprocess / local model)
  voice_speak:             2,
  voice_transcribe:        2,
  voice_clone:             2,
  voice_design:            2,

  // Tier 4 — Screen/mouse/keyboard (last resort)
  mouse_move:              4,
  mouse_click:             4,
  keyboard_type:           4,
  keyboard_press:          4,
  screenshot:              4,
  screen_read:             4,
  vision_loop:             4,
}

export function getToolTier(toolName: string): ToolTier {
  if (toolName.startsWith('mcp_')) return 1
  return TOOL_TIERS[toolName] ?? 2
}

// ── Dynamic tool loading — category-based filtering ───────────
// Reduces planner prompt from ~15K tokens to ~3-5K by only showing
// tools relevant to the current task category.

export type ToolCategory =
  | 'core'          // respond, manage_goals, compact_context, run_agent
  | 'web'           // web_search, deep_research, fetch_url/page, social_research
  | 'files'         // file_read, file_write, file_list, watch_folder
  | 'code'          // run_python, run_node, shell_exec, run_powershell, interpreters
  | 'browser'       // open_browser, browser_click/type/extract/screenshot, window ops
  | 'screen'        // screenshot, mouse, keyboard, screen_read, vision_loop
  | 'data'          // market data, stocks, company info, briefing, natural events
  | 'system'        // notify, system_info, clipboard, app_launch/close, wait
  | 'git'           // git_status, git_commit, git_push
  | 'memory'        // memory_store (write), memory_forget (delete), memory_show, search (read)
  | 'media'         // (reserved for future audio/media tools)
  | 'voice'         // voice_speak, voice_transcribe, voice_clone, voice_design
  | 'introspection' // status, analytics, spend, memory_show, lessons, skills_list, tools_list, whoami, channels_status, goals
  | 'delegation'    // spawn, swarm — subagent orchestration
  | 'interaction'   // clarify, todo — user-facing interaction tools

const TOOL_CATEGORIES: Record<string, ToolCategory[]> = {
  respond:                 ['core'],
  manage_goals:            ['core'],
  compact_context:         ['core'],
  run_agent:               ['core'],
  lookup_skill:            ['core'],
  lookup_tool_schema:      ['core'],
  web_search:              ['web', 'data'],
  deep_research:           ['web'],
  fetch_url:               ['web'],
  fetch_page:              ['web'],
  social_research:         ['web', 'data'],
  file_read:               ['files'],
  file_write:              ['files'],
  file_list:               ['files'],
  watch_folder:            ['files', 'system'],
  watch_folder_list:       ['files', 'system'],
  run_python:              ['code'],
  run_node:                ['code'],
  shell_exec:              ['code', 'system'],
  run_powershell:          ['code', 'system'],
  cmd:                     ['code', 'system'],
  ps:                      ['code', 'system'],
  wsl:                     ['code', 'system'],
  code_interpreter_python: ['code'],
  code_interpreter_node:   ['code'],
  open_browser:            ['browser'],
  browser_click:           ['browser'],
  browser_scroll:          ['browser'],
  browser_type:            ['browser'],
  browser_extract:         ['browser'],
  browser_screenshot:      ['browser'],
  browser_get_url:         ['browser'],
  window_list:             ['browser', 'system'],
  window_focus:            ['browser', 'system'],
  app_launch:              ['browser', 'system'],
  app_close:               ['browser', 'system'],
  screenshot:              ['screen'],
  mouse_move:              ['screen'],
  mouse_click:             ['screen'],
  keyboard_type:           ['screen'],
  keyboard_press:          ['screen'],
  screen_read:             ['screen'],
  vision_loop:             ['screen'],
  get_market_data:         ['data'],
  get_company_info:        ['data'],
  get_stocks:              ['data'],
  get_briefing:            ['data'],
  get_natural_events:      ['data'],
  notify:                  ['system'],
  system_info:             ['system'],
  now_playing:             ['system'],
  wait:                    ['system', 'browser', 'screen'],
  clipboard_read:          ['system', 'code'],
  clipboard_write:         ['system', 'code'],
  git_status:              ['git'],
  git_commit:              ['git'],
  git_push:                ['git'],
  ingest_youtube:          ['web', 'memory'],
  get_calendar:            ['data', 'system'],
  read_email:              ['data', 'system'],
  send_email:              ['data', 'system'],
  send_file_local:         ['files', 'system'],
  receive_file_local:      ['files', 'system'],
  // slash-mirror introspection tools
  status:                  ['introspection'],
  analytics:               ['introspection'],
  spend:                   ['introspection'],
  memory_show:             ['introspection', 'memory'],
  memory_store:            ['memory'],
  memory_forget:           ['memory'],
  lessons:                 ['introspection', 'memory'],
  skills_list:             ['introspection'],
  tools_list:              ['introspection'],
  whoami:                  ['introspection'],
  channels_status:         ['introspection'],
  goals:                   ['introspection', 'memory'],
  run:                     ['code'],
  spawn:                   ['delegation'],
  spawn_subagent:          ['delegation'],
  swarm:                   ['delegation'],
  search:                  ['memory', 'introspection'],
  clarify:                 ['interaction', 'core'],
  todo:                    ['interaction', 'core'],
  cronjob:                 ['system', 'core'],
  vision_analyze:          ['screen', 'data'],
  voice_speak:             ['voice'],
  voice_transcribe:        ['voice'],
  voice_clone:             ['voice'],
  voice_design:            ['voice'],
}

// ── v3.19 Phase 1: TOOL_REGISTRY — consolidated metadata source of truth ─────
// All per-tool metadata previously scattered across 13 separate hand-maintained
// lists is consolidated here. Existing lists remain intact; Commit 2 adds deriver
// functions; Commit 7 deletes the old lists once all call sites are switched over.
//
// Cross-file source annotations (parallel / retry / mcp):
//   parallel  — agentLoop.ts:1957 PARALLEL_SAFE / :1965 SEQUENTIAL_ONLY
//   retry     — agentLoop.ts:1881 NO_RETRY_TOOLS (false = no retry; omitted = true)
//   mcp       — api/mcp.ts:25 SAFE_TOOLS / :44 DESTRUCTIVE_TOOLS

export interface ToolRegistryMeta {
  /** One-line description (source: TOOL_DESCRIPTIONS:2772) */
  description?: string
  /** Execution tier 0–4, lower = fewer side effects (source: TOOL_TIERS:2863) */
  tier?: ToolTier
  /** Task categories (source: TOOL_CATEGORIES:2973) */
  category?: ToolCategory[]
  /** Per-tool timeout in ms; undefined = executeTool default 30 s (source: TOOL_TIMEOUTS:275) */
  timeoutMs?: number
  /** Parallel execution class (source: agentLoop.ts:1957,1965) */
  parallel?: 'safe' | 'sequential' | 'never'
  /** Retry on failure — false for state-mutating tools (source: agentLoop.ts:1881) */
  retry?: boolean
  /** MCP exposure: safe=always, destructive=opt-in, excluded=not exposed (source: api/mcp.ts:25,44) */
  mcp?: 'safe' | 'destructive' | 'excluded'
}

export const TOOL_REGISTRY: Record<string, ToolRegistryMeta> = {

  // ── Core / response ──────────────────────────────────────────────────────────
  respond: {
    description: 'Send a direct conversational response to the user. Use for greetings, capability questions, clarifications, simple factual answers, and anything that does NOT require external tools. This is the default tool when no other tool is needed.',
    tier: 1, category: ['core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  manage_goals: {
    description: 'Track and manage goals and projects. Use when user asks what to work on, mentions a project, deadline, or launch plan. Actions: list, add, update, complete, remove, suggest.',
    tier: 1, category: ['core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  compact_context: {
    description: 'Summarize and compress the current conversation context. Saves session to disk and extracts durable memories. Call when context is getting long.',
    tier: 1, category: ['core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  run_agent: {
    description: 'Spawn a sub-agent to complete a sub-goal autonomously',
    tier: 1, category: ['core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  lookup_skill: {
    description: 'Search learned skills for a matching pattern. Returns the SKILL.md of the best match. Use before planning multi-step tasks to check if Aiden already knows how to do it.',
    tier: 1, category: ['core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  lookup_tool_schema: {
    description: 'Get the full description for a named tool. Call before using an unfamiliar tool.',
    tier: 1, category: ['core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },

  // ── Web / research ───────────────────────────────────────────────────────────
  web_search: {
    description: 'Search the web for current information, news, or any topic',
    tier: 1, category: ['web', 'data'], timeoutMs: 15000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  fetch_url: {
    description: 'Fetch the content of any URL and return the text',
    tier: 1, category: ['web'], timeoutMs: 20000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  fetch_page: {
    description: 'Fetch a web page and extract its readable text content',
    tier: 1, category: ['web'], timeoutMs: 20000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  deep_research: {
    description: 'Conduct thorough multi-step research on a topic using multiple sources',
    tier: 1, category: ['web'], timeoutMs: 60000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  social_research: {
    description: 'Research a person or company across social and public sources',
    tier: 1, category: ['web', 'data'], timeoutMs: 30000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  ingest_youtube: {
    description: 'Ingest a YouTube video — downloads transcript or audio and extracts searchable text',
    tier: 1, category: ['web', 'memory'],
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },

  // ── Browser ──────────────────────────────────────────────────────────────────
  open_browser: {
    description: 'Open a URL in the system browser',
    tier: 3, category: ['browser'], timeoutMs: 15000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'safe',             // api/mcp.ts:25
  },
  browser_click: {
    description: 'Click on an element in the browser by selector',
    tier: 3, category: ['browser'], timeoutMs: 10000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  browser_scroll: {
    description: 'Scroll the browser page or a specific element. Params: direction (up|down|top|bottom, default down), amount (pixels, default 500), selector (optional CSS selector to scroll a specific element)',
    tier: 3, category: ['browser'], timeoutMs: 8000,
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    retry: false,        // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',  // api/mcp.ts:44
  },
  browser_type: {
    description: 'Type text into a browser input field',
    tier: 3, category: ['browser'], timeoutMs: 10000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  browser_extract: {
    description: 'Extract text content from the current browser page',
    tier: 3, category: ['browser'], timeoutMs: 10000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'safe',             // api/mcp.ts:25
  },
  browser_screenshot: {
    description: 'Take a screenshot of the current browser window',
    tier: 3, category: ['browser'], timeoutMs: 8000,
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    retry: false,        // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'safe',         // api/mcp.ts:25
  },
  browser_get_url: {
    description: 'Return the URL currently loaded in the browser',
    tier: 3, category: ['browser'], timeoutMs: 5000,
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    retry: false,        // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'safe',         // api/mcp.ts:25
  },

  // ── Files ────────────────────────────────────────────────────────────────────
  file_write: {
    description: 'Write content to a file at the specified path',
    tier: 2, category: ['files'],
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'destructive',      // api/mcp.ts:44
  },
  file_read: {
    description: 'Read the contents of a file at the specified path',
    tier: 2, category: ['files'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  file_list: {
    description: 'List files in a directory',
    tier: 2, category: ['files'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  watch_folder: {
    description: 'Watch a folder and react automatically when new files appear',
    tier: 2, category: ['files', 'system'], timeoutMs: 10000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'destructive',      // api/mcp.ts:44
  },
  watch_folder_list: {
    description: 'List all currently watched folder paths',
    tier: 2, category: ['files', 'system'], timeoutMs: 5000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },

  // ── Shell / code execution ───────────────────────────────────────────────────
  shell_exec: {
    description: 'Execute a shell/PowerShell command and return the output',
    tier: 2, category: ['code', 'system'], timeoutMs: 30000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  run_powershell: {
    description: 'Run a PowerShell command on Windows',
    tier: 2, category: ['code', 'system'], timeoutMs: 30000,
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    mcp: 'destructive',  // api/mcp.ts:44
  },
  cmd: {
    description: 'Run a Windows cmd.exe command and return stdout/stderr/exitCode',
    tier: 2, category: ['code', 'system'], timeoutMs: 30000,
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    mcp: 'destructive',  // api/mcp.ts:44
  },
  ps: {
    description: 'Run a PowerShell command directly (no temp file) and return stdout/stderr/exitCode',
    tier: 2, category: ['code', 'system'], timeoutMs: 30000,
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    mcp: 'destructive',  // api/mcp.ts:44
  },
  wsl: {
    description: 'Run a bash command inside WSL (Windows Subsystem for Linux); auto-translates C:\\ paths to /mnt/c/',
    tier: 2, category: ['code', 'system'], timeoutMs: 30000,
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    mcp: 'destructive',  // api/mcp.ts:44
  },
  run_python: {
    description: 'Execute a Python script and return stdout/stderr',
    tier: 2, category: ['code'], timeoutMs: 60000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  run_node: {
    description: 'Execute Node.js/JavaScript code and return the output',
    tier: 2, category: ['code'], timeoutMs: 60000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  run: {
    description: 'Run a command or script (generic alias for shell_exec)',
    tier: 2, category: ['code'],
    parallel: 'never',   // agentLoop.ts:1965 — not in SEQUENTIAL_ONLY
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  code_interpreter_python: {
    description: 'Run Python code in a sandboxed interpreter with data science libraries',
    tier: 2, category: ['code'], timeoutMs: 35000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  code_interpreter_node: {
    description: 'Run Node.js code in a sandboxed interpreter',
    tier: 2, category: ['code'], timeoutMs: 35000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },

  // ── Screen / vision / input ──────────────────────────────────────────────────
  screenshot: {
    description: 'Take a screenshot of the entire screen. Optional param: outputPath (absolute path, e.g. C:\\Users\\<you>\\Desktop\\shot.png) — if omitted, saves to workspace/screenshots/.',
    tier: 4, category: ['screen'], timeoutMs: 10000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'safe',             // api/mcp.ts:25
  },
  screen_read: {
    description: 'Read and describe the current screen contents',
    tier: 4, category: ['screen'],
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'safe',             // api/mcp.ts:25
  },
  vision_loop: {
    description: 'Autonomously control the computer using vision to complete a goal',
    tier: 4, category: ['screen'], timeoutMs: 120000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'excluded',         // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  vision_analyze: {
    description: 'Analyze an image file using computer vision and return a structured description',
    tier: 4, category: ['screen', 'data'], timeoutMs: 45000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  mouse_move: {
    description: 'Move the mouse cursor to screen coordinates',
    tier: 4, category: ['screen'],
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'destructive',      // api/mcp.ts:44
  },
  mouse_click: {
    description: 'Click the mouse at screen coordinates',
    tier: 4, category: ['screen'],
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  keyboard_type: {
    description: 'Type text using the keyboard',
    tier: 4, category: ['screen'],
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  keyboard_press: {
    description: 'Press a keyboard key or shortcut (e.g. ctrl+c)',
    tier: 4, category: ['screen'],
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },

  // ── Data / market ────────────────────────────────────────────────────────────
  get_stocks: {
    description: 'Get top gainers, losers, or most active stocks from NSE/BSE',
    tier: 1, category: ['data'], timeoutMs: 20000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  get_market_data: {
    description: 'Get real-time price, change%, and volume for a stock symbol',
    tier: 1, category: ['data'], timeoutMs: 15000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  get_company_info: {
    description: 'Get company profile, sector, P/E ratio, EPS, and revenue',
    tier: 1, category: ['data'], timeoutMs: 15000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  get_briefing: {
    description: 'Run the morning briefing: weather, markets, news, and daily summary',
    tier: 1, category: ['data'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  get_natural_events: {
    description: 'Fetch active natural events from NASA EONET API. Returns current earthquakes, wildfires, storms, floods, and other natural events worldwide.',
    tier: 1, category: ['data'],
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },

  // ── System / OS ──────────────────────────────────────────────────────────────
  system_info: {
    description: 'Get system hardware and OS information (CPU, RAM, disk, OS)',
    tier: 1, category: ['system'],
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  now_playing: {
    description: 'Get the currently playing media (song, artist, app). Calls Windows MediaSession live — always reflects real-time state. Use whenever the user asks what is playing, whether music is paused, or what track is on.',
    tier: 1, category: ['system'],
    parallel: 'safe',    // read-only, no side effects
    mcp: 'safe',
    timeoutMs: 5000,
  },
  notify: {
    description: 'Send a desktop notification to the user',
    tier: 1, category: ['system'],
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  wait: {
    description: 'Pause execution for a specified number of milliseconds',
    tier: 1, category: ['system', 'browser', 'screen'], timeoutMs: 6000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'excluded',         // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  clipboard_read: {
    description: 'Read the current contents of the system clipboard',
    tier: 2, category: ['system', 'code'], timeoutMs: 5000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  clipboard_write: {
    description: 'Write text to the system clipboard',
    tier: 2, category: ['system', 'code'], timeoutMs: 5000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'destructive',      // api/mcp.ts:44
  },
  window_list: {
    description: 'List all open windows on the desktop',
    tier: 3, category: ['browser', 'system'], timeoutMs: 10000,
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  window_focus: {
    description: 'Bring a specific window to the foreground by title',
    tier: 3, category: ['browser', 'system'], timeoutMs: 8000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'destructive',      // api/mcp.ts:44
  },
  app_launch: {
    description: 'Launch an application by name or executable path',
    tier: 3, category: ['browser', 'system'], timeoutMs: 10000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  app_close: {
    description: 'Close an application by window title or process name',
    tier: 3, category: ['browser', 'system'], timeoutMs: 8000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    retry: false,            // agentLoop.ts:1881 NO_RETRY_TOOLS
    mcp: 'destructive',      // api/mcp.ts:44
  },
  system_volume: {
    description: 'Get or set Windows speaker volume (get/up/down/mute/unmute/set)',
    tier: 2, category: ['system'], timeoutMs: 8000,
    parallel: 'sequential', // agentLoop.ts:1965 SEQUENTIAL_ONLY
    mcp: 'excluded',         // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  schedule_reminder: {
    description: "Schedule a desktop notification reminder. Params: message (string), delaySeconds or delayMs (number), recurring ('hourly'|'daily'|'weekly', optional). op='list' to see pending reminders, op='cancel' with id to cancel one.",
    tier: 0, category: ['system'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },

  // ── Git ──────────────────────────────────────────────────────────────────────
  git_status: {
    description: 'Show git status and recent commits for a repository. Provide path parameter for a specific directory.',
    tier: 2, category: ['git'], timeoutMs: 15000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  git_commit: {
    description: 'Stage and commit files to a local git repository',
    tier: 2, category: ['git'], timeoutMs: 30000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  git_push: {
    description: 'Push committed changes to a remote git repository',
    tier: 2, category: ['git'], timeoutMs: 60000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },

  // ── Comms / calendar / email ─────────────────────────────────────────────────
  get_calendar: {
    description: 'Get upcoming calendar events from Google Calendar (requires iCal URL in Settings → Channels). Parameters: daysAhead (number, default 7).',
    tier: 1, category: ['data', 'system'],
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  read_email: {
    description: 'Read recent unread emails from Gmail (requires App Password in Settings → Channels). Parameters: count (number, default 10), folder (string, default INBOX).',
    tier: 1, category: ['data', 'system'],
    parallel: 'safe',    // agentLoop.ts:1957 PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  send_email: {
    description: 'Send an email via Gmail (requires App Password in Settings → Channels). Parameters: to (string), subject (string), body (string).',
    tier: 1, category: ['data', 'system'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  send_file_local: {
    description: 'Send a file to another device on the local network via LocalSend (op: discover | send)',
    tier: 2, category: ['files', 'system'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  receive_file_local: {
    description: 'Wait for an incoming LocalSend file transfer on the local network',
    tier: 2, category: ['files', 'system'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },

  // ── Delegation / subagents ───────────────────────────────────────────────────
  spawn: {
    description: "Delegate a sub-task to an isolated subagent with its own context and half the remaining iteration budget. Returns the subagent's synthesized answer.",
    tier: 2, category: ['delegation'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  spawn_subagent: {
    description: "Spawn an isolated subagent to handle a parallel sub-task. The subagent runs in its own conversation context with half your remaining iteration budget. Use for: research that would bloat your context, parallel work where you need both results, sandboxed exploration. Returns the subagent's final reply text.",
    tier: 2, category: ['delegation'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  swarm: {
    description: 'Run N isolated subagents on the same task in parallel and aggregate their answers via voting or synthesis. Use for high-confidence research where multiple independent perspectives reduce error.',
    tier: 2, category: ['delegation'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },

  // ── Voice ────────────────────────────────────────────────────────────────────
  voice_speak: {
    description: 'Speak text aloud using the TTS provider chain (VoxCPM → Edge TTS → ElevenLabs → SAPI). Accepts text, voice, rate, volume, provider overrides.',
    tier: 2, category: ['voice'], timeoutMs: 60000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'destructive',  // api/mcp.ts:44
  },
  voice_transcribe: {
    description: 'Transcribe an audio file to text using the STT provider chain (Groq Whisper → OpenAI Whisper → Whisper.cpp). Returns { text, provider, durationMs }.',
    tier: 2, category: ['voice'], timeoutMs: 60000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'safe',         // api/mcp.ts:25
  },
  voice_clone: {
    description: 'Clone a voice from a reference audio file and synthesize new text. Requires text and referenceAudioPath. Uses VoxCPM when USE_VOXCPM=1.',
    tier: 2, category: ['voice'], timeoutMs: 120000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  voice_design: {
    description: 'Design a custom voice from a text description and synthesize text with it. Requires text and voiceDescription. Uses VoxCPM when USE_VOXCPM=1.',
    tier: 2, category: ['voice'], timeoutMs: 120000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },

  // ── Interaction / UX ─────────────────────────────────────────────────────────
  clarify: {
    description: 'Ask the user a clarifying question and wait for their typed response before proceeding',
    tier: 1, category: ['interaction', 'core'], timeoutMs: 300000,
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  todo: {
    description: 'Manage the current session todo list — add, check off, or display pending tasks',
    tier: 1, category: ['interaction', 'core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  memory_store: {
    description: 'Persist a fact, preference, or observation to permanent memory right now. Use whenever the user says "remember", "save this", "keep track of", or similar. Pass { fact: "the thing to remember" }.',
    tier: 1, category: ['memory'],
    parallel: 'never',
    retry: false,        // write operation — don't double-write on retry
    mcp: 'excluded',
  },
  memory_forget: {
    description: 'Remove a fact or preference from permanent memory. Use when the user says "forget X", "remove X from memory", "delete X from memory". Pass { fact: "keyword to match" }.',
    tier: 1, category: ['memory'],
    parallel: 'never',
    retry: false,        // write operation — don't double-delete on retry
    mcp: 'excluded',
  },
  search: {
    description: 'Search workspace memory, session context, and file system for relevant stored information',
    tier: 1, category: ['memory', 'introspection'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },
  cronjob: {
    description: 'Schedule a recurring task using cron-style timing (alias for schedule_reminder with recurring param)',
    tier: 1, category: ['system', 'core'],
    parallel: 'never',   // agentLoop.ts:1957 — not in PARALLEL_SAFE
    mcp: 'excluded',     // api/mcp.ts — not in SAFE_TOOLS or DESTRUCTIVE_TOOLS
  },

}

// ── v3.19 Phase 1, Commit 2: deriver functions ───────────────────────────────
// Each deriver caches its result and
// recomputes only when _generation changes (i.e. when a new external tool is
// registered via registerExternalTool).  Callers should use these instead of
// reading TOOL_REGISTRY directly — Commits 4-6 will swap every hand-maintained
// list to call the appropriate deriver.

/** Expose the current generation for consumers that manage their own caches. */
export function bumpGeneration(): void { _generation++ }
export function getGeneration():  number { return _generation }

/** Build a zero-argument memoiser that recomputes whenever _generation changes. */
function makeCache<T>(build: () => T): () => T {
  let cached: T | undefined
  let cachedGen = -1
  return (): T => {
    if (cachedGen !== _generation) { cached = build(); cachedGen = _generation }
    return cached!
  }
}

// ── 1. Names ──────────────────────────────────────────────────────────────────

/** All core tool names (TOOL_REGISTRY keys only, excludes slash mirrors).
 *  Replaces TOOL_NAMES_ONLY (toolRegistry.ts). */
export const registryNames: () => string[] =
  makeCache(() => Object.keys(TOOL_REGISTRY))

// ── 2. Descriptions ───────────────────────────────────────────────────────────

/** Map of name → description string.  Falls back to ''.
 *  Replaces TOOL_DESCRIPTIONS (toolRegistry.ts). */
export const registryDescriptions: () => Record<string, string> =
  makeCache(() => Object.fromEntries(
    Object.entries(TOOL_REGISTRY).map(([n, m]) => [n, m.description ?? ''])
  ))

// ── 3. Tiers ──────────────────────────────────────────────────────────────────

/** Map of name → ToolTier.  Falls back to tier 1.
 *  Replaces TOOL_TIERS (toolRegistry.ts). */
export const registryTiers: () => Record<string, ToolTier> =
  makeCache(() => Object.fromEntries(
    Object.entries(TOOL_REGISTRY).map(([n, m]) => [n, m.tier ?? 1])
  ) as Record<string, ToolTier>)

// ── 4. Categories ─────────────────────────────────────────────────────────────

/** Map of name → ToolCategory[].  Falls back to ['core'].
 *  Replaces TOOL_CATEGORIES (toolRegistry.ts). */
export const registryCategories: () => Record<string, ToolCategory[]> =
  makeCache(() => Object.fromEntries(
    Object.entries(TOOL_REGISTRY).map(([n, m]) => [n, m.category ?? ['core']])
  ) as Record<string, ToolCategory[]>)

// ── 5. Timeouts ───────────────────────────────────────────────────────────────

/** Map of name → timeout in ms.  Falls back to 15 000 ms.
 *  Replaces TOOL_TIMEOUTS (toolRegistry.ts). */
export const registryTimeouts: () => Record<string, number> =
  makeCache(() => Object.fromEntries(
    Object.entries(TOOL_REGISTRY).map(([n, m]) => [n, m.timeoutMs ?? 15000])
  ))

// ── 6. Allowed / valid tools ──────────────────────────────────────────────────

/** Complete allowed-tool list: TOOL_REGISTRY keys + registered external tools.
 *  Replaces ALLOWED_TOOLS (agentLoop.ts:808) and VALID_TOOLS (agentLoop.ts:1521). */
export const registryAllowedTools: () => string[] =
  makeCache(() => [
    ...Object.keys(TOOL_REGISTRY),
    ...Object.keys(externalTools),
  ])

// ── 6b. Valid tools ───────────────────────────────────────────────────────────

/** Valid-tool list for agent-loop routing: same data as registryAllowedTools,
 *  kept as a separate deriver for independent traceability per call site.
 *  Replaces VALID_TOOLS (agentLoop.ts:1521). */
export const registryValidTools: () => string[] =
  makeCache(() => [
    ...Object.keys(TOOL_REGISTRY),
    ...Object.keys(externalTools),
  ])

// ── 7. No-retry set ───────────────────────────────────────────────────────────

/** Set of tools that must NOT be retried on failure (retry === false).
 *  Replaces NO_RETRY_TOOLS (agentLoop.ts:1881). */
export const registryNoRetrySet: () => Set<string> =
  makeCache(() => new Set(
    Object.entries(TOOL_REGISTRY)
      .filter(([, m]) => m.retry === false)
      .map(([n]) => n)
  ))

// ── 8. Parallel-safe set ──────────────────────────────────────────────────────

/** Set of tools safe to execute in parallel (parallel === 'safe').
 *  Replaces PARALLEL_SAFE (agentLoop.ts:1957). */
export const registryParallelSafeSet: () => Set<string> =
  makeCache(() => new Set(
    Object.entries(TOOL_REGISTRY)
      .filter(([, m]) => m.parallel === 'safe')
      .map(([n]) => n)
  ))

// ── 9. Sequential-only set ────────────────────────────────────────────────────

/** Set of tools that must always run sequentially (parallel === 'sequential').
 *  Replaces SEQUENTIAL_ONLY (agentLoop.ts:1965). */
export const registrySequentialOnlySet: () => Set<string> =
  makeCache(() => new Set(
    Object.entries(TOOL_REGISTRY)
      .filter(([, m]) => m.parallel === 'sequential')
      .map(([n]) => n)
  ))

// ── 10. MCP safe list ─────────────────────────────────────────────────────────

/** Tools safe to expose via MCP (mcp === 'safe').
 *  Replaces SAFE_TOOLS (api/mcp.ts:25). */
export const registryMcpSafeList: () => string[] =
  makeCache(() =>
    Object.entries(TOOL_REGISTRY)
      .filter(([, m]) => m.mcp === 'safe')
      .map(([n]) => n)
  )

// ── 11. MCP destructive list ──────────────────────────────────────────────────

/** Tools exposed via MCP but flagged destructive (mcp === 'destructive').
 *  Replaces DESTRUCTIVE_TOOLS (api/mcp.ts:44). */
export const registryMcpDestructiveList: () => string[] =
  makeCache(() =>
    Object.entries(TOOL_REGISTRY)
      .filter(([, m]) => m.mcp === 'destructive')
      .map(([n]) => n)
  )

// ─────────────────────────────────────────────────────────────────────────────

export function detectToolCategories(message: string): ToolCategory[] {
  const categories = new Set<ToolCategory>(['core'])
  const msg = message.toLowerCase()

  if (/search|research|find|look up|what is|who is|latest|news|article|google/i.test(msg))
    categories.add('web')
  if (/file|read|write|save|create|folder|directory|pdf|document|\.txt|\.csv|\.json|\.md/i.test(msg))
    categories.add('files')
  if (/code|script|python|node|run|execute|build|deploy|npm|pip|function|class|powershell/i.test(msg))
    categories.add('code')
  if (/open|browse|website|url|http|chrome|click|navigate|youtube|browser|tab/i.test(msg))
    categories.add('browser')
  if (/screen|screenshot|mouse|click on|type in|desktop|window|app\b|vision|control/i.test(msg))
    categories.add('screen')
  if (/stock|nifty|market|price|nse|bse|sensex|reliance|trading|shares|equity|briefing|weather|natural|earthquake/i.test(msg))
    categories.add('data')
  if (/email|inbox|mail|gmail|unread|read_email|send_email|calendar|meetings|events/i.test(msg))
    categories.add('data')
  if (/notify|notification|remind|alert|system info|cpu|ram|disk|hardware|clipboard|launch|close app|now.?playing|what.*playing|what.*song|what.*music|is.*playing|music.*paused|current.*track/i.test(msg))
    categories.add('system')
  if (/voice|speak|say aloud|listen|record audio|tts|text.to.speech|transcribe|speech.to.text|clone.*voice|voice.*design|voice.*clone|design.*voice/i.test(msg))
    categories.add('voice')
  if (/play audio|play music|media file|audio file/i.test(msg))
    categories.add('media')
  if (/\bgit\b|commit|push|pull|branch|merge|git status|diff|repo|repository/i.test(msg))
    categories.add('git')
  if (/remember|memory|forget|knowledge|learn|recall/i.test(msg))
    categories.add('memory')
  if (/status|uptime|analytics|how much.*spent|spending|cost|lessons|skills|what tools|tools (do you|available)|who am i|whoami|channels|providers|my goals|active goals/i.test(msg))
    categories.add('introspection')
  if (/spawn|swarm|subagent|delegate|parallel agent|fork agent/i.test(msg))
    categories.add('delegation')
  if (/todo|task list|add task|complete task|checklist|mark done/i.test(msg))
    categories.add('interaction')
  if (/clarify|ask me|which option|confirm|choose|multiple choice/i.test(msg))
    categories.add('interaction')
  if (/cron|schedule|every \d|daily|hourly|recurring|repeat|interval/i.test(msg))
    categories.add('system')
  if (/analyze image|vision|describe image|what.*image|image.*show|photo|screenshot.*describe/i.test(msg))
    categories.add('screen')
  // Travel queries need web (search), browser (agent-browser navigation), and code (shell_exec
  // to invoke agent-browser CLI commands). Without 'code', shell_exec is absent from plannerTools
  // and the LLM cannot execute agent-browser commands even when a travel skill is surfaced.
  if (/flight|flights|airfare|airline|airport|booking|hotel|hotels|\btravel\b|itinerary|visa|pnr|layover|nonstop|stopover/i.test(msg)) {
    categories.add('web')
    categories.add('browser')
    categories.add('code')
  }

  return Array.from(categories)
}

export function getToolsForCategories(categories: ToolCategory[]): string[] {
  const tools = new Set<string>()
  for (const [toolName, toolCats] of Object.entries(TOOL_CATEGORIES)) {
    if (toolCats.some(c => (categories as string[]).includes(c))) {
      tools.add(toolName)
    }
  }
  return Array.from(tools)
}
