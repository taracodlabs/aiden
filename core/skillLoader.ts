// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/skillLoader.ts — Loads SKILL.md files and injects relevant
// skill context into the planner and responder prompts.

import fs   from 'fs'
import path from 'path'

// ── LRU cache for on-demand skill content loading ─────────────
// lru-cache v10 (CommonJS). max = maximum number of items.
// Full SKILL.md is loaded lazily on first access and evicted when
// the 50-entry limit is reached (LRU eviction).
const { LRUCache: _LRUClass } = require('lru-cache') as { LRUCache: { new(opts: { max: number }): { get(k: string): string | undefined; set(k: string, v: string): void; size: number } } }
const _contentCache = new _LRUClass({ max: 50 })

/**
 * Load full SKILL.md content on demand (LRU-cached, max 50 entries).
 * Returns null if the file cannot be read.
 */
export function getSkillContent(filePath: string): string | null {
  const hit = _contentCache.get(filePath)
  if (hit !== undefined) return hit
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    _contentCache.set(filePath, raw)
    return raw
  } catch {
    return null
  }
}

export function getSkillCacheStats(): { size: number; max: number } {
  return { size: _contentCache.size, max: 50 }
}

// ── Skill injection guard ─────────────────────────────────────

const SKILL_INJECTION_PATTERNS: RegExp[] = [
  // ── Prompt hijacking ───────────────────────────────────────
  /ignore\s+(all\s+)?(previous|above|prior)/i,
  /disregard\s+(all\s+)?(previous|above)/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions\s*:/i,
  /override\s+(your\s+)?(system|instructions|rules)/i,
  /curl\s+[^\n]*\|\s*(bash|sh)\b/i,
  /ANTHROPIC_BASE_URL/i,
  /\]\s*\(\s*javascript:/i,

  // ── Role hijacking ─────────────────────────────────────────
  /pretend\s+(to\s+be|you\s+are)/i,
  /roleplay\s+as/i,
  /you\s+must\s+obey/i,
  /your\s+new\s+(role|instruction|directive)/i,

  // ── Model-control tokens (LLM prompt format injection) ─────
  /\[INST\]/i,
  /<\|im_start\|>/i,
  /<\|system\|>/i,
  /<<\s*SYS\s*>>/i,

  // ── Obfuscated payloads ────────────────────────────────────
  /\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i,   // hex sequences (2+ consecutive)
]

function sanitizeSkill(content: string, filename: string): string | null {
  for (const pattern of SKILL_INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      console.warn(`[Security] BLOCKED skill "${filename}": contains injection pattern`)
      return null
    }
  }
  return content
}

function validateSkillStructure(content: string): { valid: boolean; reason?: string } {
  // Must have at least one markdown header if the file is substantial
  if (!content.includes('#') && content.length > 500) {
    return { valid: false, reason: 'No markdown headers — suspicious format' }
  }

  // Suspiciously long single paragraph (likely injection payload)
  const lines       = content.split('\n')
  const longLines   = lines.filter(l => l.length > 500)
  if (longLines.length > 3) {
    return { valid: false, reason: 'Multiple very long lines — possible injection' }
  }

  // Too much code relative to documentation
  const codeBlocks = (content.match(/```/g) || []).length / 2
  const totalLines = lines.length
  if (codeBlocks > 0 && codeBlocks * 10 > totalLines) {
    return { valid: false, reason: 'More code than documentation — suspicious skill' }
  }

  // Must be under 50 KB (agentskills.io skills legitimately run 10-30KB; injection
  // patterns are caught above; blanket 10KB was too tight for real-world skills)
  if (content.length > 51200) {
    return { valid: false, reason: 'Skill too large (>50KB) — possible payload' }
  }

  return { valid: true }
}

const BLOCKED_LOG = path.join(process.cwd(), 'workspace', 'blocked-skills.log')

function logBlockedSkill(filename: string, reason: string): void {
  try {
    fs.mkdirSync(path.dirname(BLOCKED_LOG), { recursive: true })
    fs.appendFileSync(
      BLOCKED_LOG,
      `${new Date().toISOString()} | BLOCKED: ${filename} | ${reason}\n`,
    )
  } catch {}
}

// ── Types ──────────────────────────────────────────────────────

export interface Skill {
  name:        string
  description: string
  version:     string
  category?:   string   // parsed from frontmatter "category:" field
  platform?:   string   // optional: "windows" | "linux" | "macos" | "any"
  tags:        string[]
  /** First 500 chars of the skill body — used for prompt injection (sync, always available). */
  preview:     string
  /** @deprecated Use getSkillContent(skill.filePath) for full content. Kept for compat. */
  content?:    string
  filePath:    string
  origin:      'aiden' | 'community' | 'local'
  enabled?:    boolean  // false = skip during normal load (auto-generated/installed)

  // ── agentskills.io spec fields ────────────────────────────────
  license?:        string            // SPDX license identifier, e.g. "Apache-2.0"
  compatibility?:  string[]          // runtime/platform compat strings
  metadata?:       Record<string, string>  // arbitrary key-value pairs from frontmatter
  allowedTools?:   string[]          // allowed-tools: list from spec
  hasScripts?:     boolean           // scripts/ subdir detected
  hasReferences?:  boolean           // references/ subdir detected
  hasAssets?:      boolean           // assets/ subdir detected
  source?:         string            // import source URL or "local" or "library"
  importedFrom?:   string            // original GitHub owner/repo or URL
}

/** Skill with full body loaded — returned by getSkillContent() consumers. */
export interface SkillWithContent extends Skill {
  content: string
}

// Maps frontmatter platform values → Node.js process.platform strings
const PLATFORM_MAP: Record<string, string> = {
  windows: 'win32',
  linux:   'linux',
  macos:   'darwin',
  darwin:  'darwin',
  any:     'any',
}

// ── Step 0 values — real categories found via:
//   grep -h "^category:" skills/*/SKILL.md | sort -u
//
// category: agent-bridge
// category: creative
// category: developer
// category: gaming
// category: india
// category: media
// category: productivity
// category: research
// category: smart-home
// category: social
// category: windows
//
// Keyword buckets map trigger words → those actual category strings.
// A bucket with no matching category was dropped (no invented names).

const CATEGORY_KEYWORD_MAP: Record<string, string[]> = {
  'productivity':  ['obsidian', 'notion', 'outlook', 'calendar', 'email', 'linear', 'todo', 'onenote', 'drive', 'sheets', 'docs'],
  'developer':     ['git', 'github', 'docker', 'jupyter', 'code', 'debug', 'test', 'pr', 'repo', 'npm', 'node', 'python', 'typescript', 'deploy', 'vercel', 'ssh'],
  'india':         ['nse', 'nifty', 'zerodha', 'upstox', 'sensex', 'bse', 'trading', 'trade', 'stock', 'fii', 'dii', 'portfolio', 'reliance', 'infy', 'options', 'derivatives', 'tax', 'itr'],
  'research':      ['research', 'arxiv', 'paper', 'academic', 'pdf', 'ocr', 'rss', 'feed'],
  'windows':       ['powershell', 'registry', 'services', 'wsl', 'windows', 'cpu', 'disk', 'network', 'process', 'clipboard', 'scheduler'],
  'creative':      ['image', 'stable diffusion', 'generative', 'p5js', 'ascii', 'banner', 'art', 'draw'],
  'media':         ['youtube', 'gif', 'audio', 'music', 'video', 'transcript', 'tenor', 'giphy'],
  'social':        ['twitter', 'tweet', 'linkedin', 'social media'],
  'smart-home':    ['hue', 'philips', 'smart home', 'iot', 'lights'],
  'agent-bridge':  ['claude code', 'openai', 'codex', 'opencode'],
  'gaming':        ['minecraft', 'pokemon', 'gameboy', 'emulator'],
  'travel':        ['flight', 'flights', 'airfare', 'airline', 'airport', 'booking', 'hotel', 'hotels', 'travel', 'trip', 'itinerary', 'visa', 'pnr', 'layover', 'nonstop', 'stopover'],
}

// ── isSimpleMessage ────────────────────────────────────────────
// Returns true for short conversational messages that need minimal context:
// < 15 words, no tool keywords, no URLs/paths, no past-context references.

export function isSimpleMessage(msg: string): boolean {
  const words = msg.trim().split(/\s+/).length
  if (words > 15) return false

  const toolKeywords = [
    'file', 'search', 'browse', 'run', 'execute', 'install',
    'download', 'create', 'delete', 'open', 'screenshot',
    'scan', 'analyze', 'deploy', 'commit', 'push', 'build',
    'docker', 'git', 'npm', 'python', 'shell', 'terminal',
    'outlook', 'email', 'calendar', 'notion', 'obsidian',
    'trade', 'stock', 'nse', 'portfolio', 'backtest',
    'remember', 'forgot', 'last time', 'we discussed',
    'clone', 'voice', 'speak', 'listen', 'transcribe',
    // Travel domain — must reach skill injection pipeline
    'flight', 'flights', 'airfare', 'airline', 'airport',
    'booking', 'hotel', 'hotels', 'travel', 'trip',
    'itinerary', 'visa', 'pnr',
  ]
  const lower = msg.toLowerCase()
  if (toolKeywords.some(kw => lower.includes(kw))) return false
  if (/https?:\/\/|\.\w{2,4}(\s|$)|[\\\/]/.test(msg)) return false

  return true
}

// ── needsMemory ────────────────────────────────────────────────
// Returns true only when the message explicitly references past context.
// Prevents dumping all memories into every prompt.

export function needsMemory(msg: string): boolean {
  const memoryKeywords = [
    'remember', 'forgot', 'last time', 'we discussed',
    'earlier', 'before', 'previous', 'you said', 'i told you',
    'my name', 'my project', 'our', 'we were',
  ]
  return memoryKeywords.some(kw => msg.toLowerCase().includes(kw))
}

// ── SkillLoader ────────────────────────────────────────────────

export class SkillLoader {
  private skillsDirs: string[]
  private cache: Skill[] | null = null

  constructor() {
    // Check built-in skills, workspace skills, and self-learned/promoted skills.
    // NOTE: skills/learned/pending/ is intentionally excluded — pending skills
    // are never auto-loaded; they require explicit /skills approve first.
    // C22: Use AIDEN_USER_DATA (set by npx launcher) so SkillLoader reads
    // from the same workspace root that initWorkspaceDefaults() writes to.
    const root = process.env.AIDEN_USER_DATA || process.cwd()
    // C24: Do NOT filter by existsSync here — the singleton is created at
    // import time, before initWorkspaceDefaults() copies templates. loadAll()
    // wraps readdirSync in try/catch, so non-existent dirs are safe.
    this.skillsDirs = [
      path.join(root, 'skills'),
      path.join(root, 'workspace', 'skills'),
      path.join(root, 'workspace', 'skills', 'learned'),
      path.join(root, 'workspace', 'skills', 'approved'),
      // Workspace-level installed skills (written by skillRegistry.ts)
      path.join(root, 'workspace', 'skills', 'installed'),
      // A2/A3 approved drafts
      path.join(root, 'skills', 'learned', 'approved'),
      // A4 library-installed skills
      path.join(root, 'skills', 'installed'),
    ]
  }

  // loadAllRaw — bypasses the disabled-skills filter
  // Used by GET /api/skills so the UI can show disabled skills too
  loadAllRaw(): Skill[] {
    return this.loadAll(/* includeDisabled */ true)
  }

  loadAll(includeDisabled = false): Skill[] {
    if (!includeDisabled && this.cache) return this.cache

    const skills: Skill[] = []

    for (const dir of this.skillsDirs) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const skillPath = path.join(dir, entry.name, 'SKILL.md')
          if (!fs.existsSync(skillPath)) continue
          try {
            const fileContent = fs.readFileSync(skillPath, 'utf-8')
            const sanitized   = sanitizeSkill(fileContent, entry.name)
            if (!sanitized) {
              logBlockedSkill(entry.name, 'injection pattern detected')
              continue
            }
            const structure = validateSkillStructure(sanitized)
            if (!structure.valid) {
              console.log(`[Skills] BLOCKED (structure): ${entry.name} — ${structure.reason}`)
              logBlockedSkill(entry.name, structure.reason ?? 'structure check failed')
              continue
            }
            const parsed = this.parse(sanitized, skillPath)
            if (!parsed) continue

            // Enabled gate — skip skills with enabled: false unless caller wants all
            if (!includeDisabled && parsed.enabled === false) {
              console.debug(`[SkillLoader] Skipping "${parsed.name}" (disabled via frontmatter)`)
              continue
            }

            // Platform gate — skip skills that require a different OS
            if (parsed.platform && parsed.platform !== 'any') {
              const required = PLATFORM_MAP[parsed.platform.toLowerCase()] ?? parsed.platform
              if (required !== process.platform) {
                console.debug(`[SkillLoader] Skipping "${parsed.name}" (platform: ${parsed.platform}, current: ${process.platform})`)
                continue
              }
            }

            skills.push(parsed)
          } catch {}
        }
      } catch {}
    }

    // Deduplicate by name — later directories (approved > learned) take precedence.
    // skillsDirs order: built-in → workspace → learned → approved.
    // Since we iterate in that order, the last entry for a given name wins (approved beats learned).
    const seen = new Map<string, Skill>()
    for (const skill of skills) {
      seen.set(skill.name, skill)
    }
    const deduped = Array.from(seen.values())

    if (deduped.length < skills.length) {
      console.log(`[SkillLoader] Deduplicated ${skills.length} → ${deduped.length} skills (removed ${skills.length - deduped.length} duplicates)`)
    }

    // Filter out disabled skills (unless caller wants all)
    const DISABLED_PATH = path.join(process.cwd(), 'workspace', 'disabled-skills.json')
    let disabled: Set<string> = new Set()
    if (!includeDisabled) {
      try {
        const raw = fs.readFileSync(DISABLED_PATH, 'utf-8')
        disabled  = new Set(JSON.parse(raw) as string[])
      } catch {}
    }

    const filtered = includeDisabled ? deduped : deduped.filter(s => !disabled.has(s.name))

    if (!includeDisabled) {
      this.cache = filtered
      if (filtered.length > 0) {
        const platformSkipped = deduped.length - filtered.length - disabled.size
        const skippedMsg = platformSkipped > 0 ? `, ${platformSkipped} platform-skipped` : ''
        console.log(`[SkillLoader] Loaded ${filtered.length} skills${skippedMsg}: ${filtered.map(s => s.name).join(', ')}`)
      }
    }

    return filtered
  }

  private parse(raw: string, filePath: string): Skill | null {
    try {
      const match = raw.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/)

      const normalizedPath = filePath.replace(/\\/g, '/')
      const origin: 'aiden' | 'community' | 'local' =
        normalizedPath.includes('/workspace/') ? 'local' : 'aiden'

      if (!match) {
        // No frontmatter — use directory name as skill name
        const name    = path.basename(path.dirname(filePath))
        const preview = raw.trim().slice(0, 500)
        return { name, description: name, version: '1.0.0', tags: [name], preview, filePath, origin }
      }

      const frontmatter = match[1]
      const body        = match[2].trim()
      const preview     = body.slice(0, 1500)

      const get = (key: string): string => {
        const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
        return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
      }

      const tagsRaw = get('tags')
      const tags    = tagsRaw
        ? tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
        : []

      const name     = get('name') || path.basename(path.dirname(filePath))
      const category = get('category') || undefined
      const platform = get('platform') || undefined

      // Parse enabled — absent means enabled (legacy skills have no field)
      const enabledRaw = get('enabled')
      const enabled    = enabledRaw === '' ? undefined : enabledRaw === 'false' ? false : true

      // ── agentskills.io spec fields ────────────────────────────
      const license      = get('license') || undefined
      const source       = get('source') || undefined
      const importedFrom = get('imported-from') || undefined

      // compatibility: "compatibility: node18, linux" → string[]
      const compatRaw = get('compatibility')
      const compatibility = compatRaw
        ? compatRaw.split(',').map(c => c.trim()).filter(Boolean)
        : undefined

      // allowed-tools: "allowed-tools: shell, browser" → string[]
      const allowedToolsRaw = get('allowed-tools')
      const allowedTools = allowedToolsRaw
        ? allowedToolsRaw.split(',').map(t => t.trim()).filter(Boolean)
        : undefined

      // metadata: key: value pairs not captured by known fields
      const KNOWN_FIELDS = new Set([
        'name', 'description', 'version', 'category', 'platform', 'tags',
        'origin', 'enabled', 'license', 'source', 'imported-from',
        'compatibility', 'allowed-tools',
      ])
      const metadata: Record<string, string> = {}
      for (const line of frontmatter.split('\n')) {
        const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/)
        if (kv && !KNOWN_FIELDS.has(kv[1].toLowerCase())) {
          metadata[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '')
        }
      }

      // Detect optional subdirectories relative to the skill dir
      const skillDir     = path.dirname(filePath)
      const hasScripts   = fs.existsSync(path.join(skillDir, 'scripts'))
      const hasReferences = fs.existsSync(path.join(skillDir, 'references'))
      const hasAssets    = fs.existsSync(path.join(skillDir, 'assets'))

      return {
        name,
        description: get('description'),
        version:     get('version') || '1.0.0',
        category,
        platform,
        tags,
        preview,
        filePath,
        origin,
        enabled,
        license,
        compatibility:  compatibility?.length   ? compatibility  : undefined,
        metadata:       Object.keys(metadata).length ? metadata : undefined,
        // Note: allowedTools is currently informational metadata. Actual tool access is
        // controlled by the agent's plannerTools list in agentLoop.ts (detectToolCategories).
        // Skill authors using Claude Code-style 'Bash(cmd:*)' declarations should ensure the
        // underlying tool (e.g. shell_exec) is reachable via detectToolCategories() for the
        // skill's intended query patterns.
        allowedTools:   allowedTools?.length    ? allowedTools   : undefined,
        hasScripts:     hasScripts   || undefined,
        hasReferences:  hasReferences || undefined,
        hasAssets:      hasAssets    || undefined,
        source,
        importedFrom,
      }
    } catch { return null }
  }

  findRelevant(message: string, maxSkills = 3): Skill[] {
    if (isSimpleMessage(message)) return []  // no skills for short conversational messages

    const skills = this.loadAll()
    if (skills.length === 0) return []

    const lower = message.toLowerCase()
    const words = lower.split(/\s+/)

    // Detect matching categories from message text using real category strings
    const matchedCategories = new Set<string>()
    for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORD_MAP)) {
      if (keywords.some(kw => lower.includes(kw))) {
        matchedCategories.add(cat)
      }
    }

    // Score each skill by relevance
    const scored = skills.map(skill => {
      let score = 0

      // Exact name match in message
      if (lower.includes(skill.name.toLowerCase())) score += 10

      // Description word overlap
      const descWords = skill.description.toLowerCase().split(/\s+/)
      words.forEach(w => { if (w.length > 3 && descWords.includes(w)) score += 3 })

      // Category field match (direct — highest priority)
      if (skill.category && matchedCategories.has(skill.category)) score += 8

      // Direct tag match against message text
      skill.tags.forEach(tag => {
        if (lower.includes(tag)) score += 5
      })

      // Tag matches a detected category name
      skill.tags.forEach(tag => {
        if (matchedCategories.has(tag)) score += 4
      })

      // Installed skills (origin: 'aiden') get a priority bonus over auto-generated
      // learned/approved workspace skills. This prevents self-taught skills from
      // outcompeting curated installed skills on the same domain.
      if (skill.origin === 'aiden') score += 15

      return { skill, score }
    })

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSkills)
      .map(s => s.skill)
  }

  formatForPrompt(skills: Skill[]): string {
    if (skills.length === 0) return ''

    const formatted = skills.map(s =>
      `[SKILL: ${s.name}]\nDescription: ${s.description}\n${s.preview}`,
    ).join('\n\n---\n\n')

    return `\n\nRELEVANT SKILLS FOR THIS TASK — follow their workflows:\n${formatted}\n\nMANDATORY: Use the tool workflow defined in the skill above. For browser-based skills (agent-browser), use shell_exec — do NOT substitute web_search.\n`
  }

  // Invalidate cache — call after new skills are added at runtime
  refresh(): void {
    this.cache = null
  }
}

export const skillLoader = new SkillLoader()
