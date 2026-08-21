// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/responseCache.ts — TTL-based response cache for tool results.
// Tools with defined TTLs get their outputs cached and reused within
// the TTL window. Side-effectful tools (file_write, shell_exec, etc.)
// are explicitly excluded via NO_CACHE_TOOLS.

import fs     from 'fs'
import path   from 'path'
import crypto from 'crypto'

import { resolveRuntimeStorageRoot } from './v4/runtimeStorage'

export interface ResponseCacheOptions {
  /** Workspace identity whose cache entries must remain isolated. */
  workspaceRoot?: string
  /** Aiden-owned runtime root. Defaults to AIDEN_USER_DATA/AIDEN_HOME. */
  runtimeRoot?: string
  /** Explicit test/embedding override for the complete cache file path. */
  cachePath?: string
  cleanupIntervalMs?: number
}

function normalizedWorkspaceIdentity(workspaceRoot: string): string {
  const absolute = path.resolve(workspaceRoot)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Cache files are runtime state, never repository content. The workspace digest
 * prevents cache collisions without exposing a source path in the state tree.
 */
export function responseCachePathForWorkspace(
  workspaceRoot = process.cwd(),
  runtimeRoot = resolveRuntimeStorageRoot(),
): string {
  const workspaceId = crypto
    .createHash('sha256')
    .update(normalizedWorkspaceIdentity(workspaceRoot))
    .digest('hex')
    .slice(0, 32)
  return path.join(path.resolve(runtimeRoot), 'cache', 'workspaces', workspaceId, 'response-cache.json')
}

interface CacheEntry {
  key:       string
  output:    string
  tool:      string
  input:     Record<string, any>
  createdAt: number
  expiresAt: number
  hitCount:  number
}

// TTL per tool type (milliseconds)
const TOOL_TTL: Record<string, number> = {
  system_info:     30 * 1000,           // 30 seconds — hardware changes rarely
  get_market_data: 5  * 60 * 1000,      // 5 minutes  — prices update frequently
  get_company_info: 60 * 60 * 1000,     // 1 hour     — fundamentals change slowly
  get_stocks:      5  * 60 * 1000,      // 5 minutes
  social_research: 30 * 60 * 1000,      // 30 minutes
  web_search:      10 * 60 * 1000,      // 10 minutes
  fetch_url:       15 * 60 * 1000,      // 15 minutes
  fetch_page:      15 * 60 * 1000,      // 15 minutes
}

// Tools that should NEVER be cached (side-effectful or time-sensitive)
const NO_CACHE_TOOLS = new Set([
  'file_write', 'file_read', 'shell_exec', 'run_python',
  'run_node', 'screenshot', 'notify', 'open_browser',
  'browser_click', 'browser_type', 'mouse_click', 'keyboard_type',
  'code_interpreter_python', 'code_interpreter_node',
])

export class ResponseCache {
  private cache: Map<string, CacheEntry> = new Map()
  private readonly cachePath: string
  private readonly cleanupTimer: NodeJS.Timeout

  constructor(options: ResponseCacheOptions = {}) {
    this.cachePath = path.resolve(options.cachePath ?? responseCachePathForWorkspace(
      options.workspaceRoot ?? process.cwd(),
      options.runtimeRoot ?? resolveRuntimeStorageRoot(),
    ))
    this.load()
    // Cleanup expired entries every 5 minutes. `.unref()` so this background
    // timer never keeps the event loop alive — otherwise every CLI command has
    // to hard-quit instead of exiting cleanly once its work is done.
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      options.cleanupIntervalMs ?? 5 * 60 * 1000,
    )
    this.cleanupTimer.unref()
  }

  // ── Key hashing ───────────────────────────────────────────────

  private hashKey(tool: string, input: Record<string, any>): string {
    const str = `${tool}:${JSON.stringify(input, Object.keys(input).sort())}`
    return crypto.createHash('md5').update(str).digest('hex')
  }

  // ── Cache read ────────────────────────────────────────────────

  get(tool: string, input: Record<string, any>): string | null {
    if (NO_CACHE_TOOLS.has(tool)) return null
    const key   = this.hashKey(tool, input)
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    entry.hitCount++
    console.log(`[Cache] HIT: ${tool} (hits: ${entry.hitCount})`)
    return entry.output
  }

  // ── Cache write ───────────────────────────────────────────────

  set(tool: string, input: Record<string, any>, output: string): void {
    if (NO_CACHE_TOOLS.has(tool)) return
    const ttl = TOOL_TTL[tool]
    if (!ttl) return  // Only cache tools with a defined TTL
    const key = this.hashKey(tool, input)
    this.cache.set(key, {
      key,
      output,
      tool,
      input,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
      hitCount:  0,
    })
    this.save()
  }

  // ── Stats ─────────────────────────────────────────────────────

  getStats(): { totalEntries: number; totalHits: number; tools: Record<string, number> } {
    const tools: Record<string, number> = {}
    let totalHits = 0
    for (const entry of this.cache.values()) {
      tools[entry.tool] = (tools[entry.tool] || 0) + 1
      totalHits += entry.hitCount
    }
    return { totalEntries: this.cache.size, totalHits, tools }
  }

  // ── Clear all ─────────────────────────────────────────────────

  clear(): void {
    this.cache.clear()
    try { fs.rmSync(this.cachePath, { force: true }) } catch {}
  }

  /** Release the maintenance timer for short-lived embeddings and tests. */
  dispose(): void {
    clearInterval(this.cleanupTimer)
  }

  // ── Expired entry cleanup ─────────────────────────────────────

  private cleanup(): void {
    const now = Date.now()
    let changed = false
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        changed = true
      }
    }
    if (changed) this.save()
  }

  // ── Persistence ───────────────────────────────────────────────

  private load(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return
      const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'))
      this.cache = new Map(Object.entries(data) as [string, CacheEntry][])
      this.cleanup()  // Remove expired entries on load
    } catch {}
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true })
      fs.writeFileSync(
        this.cachePath,
        JSON.stringify(Object.fromEntries(this.cache), null, 2),
        { mode: 0o600 },
      )
    } catch {}
  }
}

export const responseCache = new ResponseCache()
