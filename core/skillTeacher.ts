// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/skillTeacher.ts — Self-learning skill generation.
// After every successful plan execution, records the tool sequence,
// generates a SKILL.md using the LLM, and promotes to "approved"
// after PROMOTE_THRESHOLD successes.

import fs   from 'fs'
import path from 'path'

// ── Types ──────────────────────────────────────────────────────

export interface LearnedSkillMeta {
  name:         string
  taskPattern:  string       // normalized task description
  toolSequence: string[]     // tools used in order
  successCount: number
  failCount:    number
  confidence:   number       // 0–1, increases with successes
  promoted:     boolean      // moved to approved/
  createdAt:    number
  lastUsed:     number
  avgDuration:  number
}

// ── Paths ──────────────────────────────────────────────────────

const LEARNED_DIR       = path.join(process.cwd(), 'workspace', 'skills', 'learned')
const APPROVED_DIR      = path.join(process.cwd(), 'workspace', 'skills', 'approved')
const BUNDLED_SKILLS_DIR = path.join(process.cwd(), 'skills')
const PROMOTE_THRESHOLD = 3   // successes needed to promote to approved/
const SESSION_SKILL_LIMIT = 2  // max NEW skills generated per process session

// ── Session-scoped new-skill counter (reset on process restart) ─
let _sessionSkillsCreated = 0

// ── C18: Session-scoped rejection cache — skip re-evaluating names
// that already failed quality gates this session ─────────────────
const _rejectedNames: Set<string> = new Set()

// ── LLM caller type — matches callLLM signature ───────────────

type LLMCaller = (prompt: string, apiKey: string, model: string, provider: string) => Promise<string>

// ── Skill name extractor ───────────────────────────────────────
// "research the top AI agents of 2025" → "research_ai_agents"

function extractSkillName(task: string, tools: string[]): string {
  // Use tool sequence to name the skill when pattern is recognisable
  if (tools.includes('deep_research') && tools.includes('file_write')) return 'research_and_save'
  if (tools.includes('web_search')    && tools.includes('file_write')) return 'search_and_save'
  if (tools.includes('get_stocks'))                                     return 'stock_research'
  if (tools.includes('run_python'))                                     return 'python_execution'
  if (tools.includes('run_node'))                                       return 'node_execution'
  if (tools.includes('shell_exec')    && tools.includes('file_write')) return 'shell_and_save'

  // Extract key nouns from task — first 3 meaningful words
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on',
    'for', 'of', 'with', 'my', 'your', 'about', 'from',
    'save', 'get', 'find', 'make', 'show', 'tell',
  ])
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 3)

  return words.join('_') || 'general_task'
}

// ── C12: Skill pollution prevention — exported for testing ──────

const QUESTION_WORD_RE = /^(what|where|why|when|who|how|can|could|would|should|is|are)_/
const PRONOUN_RE       = /^(its|im|youre|whats|theyre|were)_/
const PERSONAL_ID_RE   = /(^|_)(users|admin|desktop|appdata)(_|$)/

/**
 * Validate a candidate skill name. Returns null if valid,
 * or a rejection reason string.
 */
export function validateSkillName(name: string): string | null {
  const words = name.split('_')
  if (words.length > 4)            return `name has >4 underscore-separated words (${words.length})`
  if (QUESTION_WORD_RE.test(name)) return 'name starts with question word'
  if (PRONOUN_RE.test(name))       return 'name starts with pronoun pattern'
  if (PERSONAL_ID_RE.test(name))   return 'name contains personal identifier'
  return null
}

/**
 * Validate a candidate skill task description. Returns null if valid,
 * or a rejection reason string.
 * @param task        - The skill's task description
 * @param userMessage - Original user message (for verbatim check)
 */
export function validateSkillTask(task: string, userMessage?: string): string | null {
  const norm = task.toLowerCase().trim()
  if (norm.length < 30)   return `task too short (${norm.length} chars, min 30)`
  if (norm.endsWith('?')) return 'task is a question'
  if (userMessage) {
    const msgNorm = userMessage.toLowerCase().trim()
    if (norm === msgNorm)  return 'task is verbatim copy of user message'
  }
  return null
}

// ── SKILL.md generator ─────────────────────────────────────────

async function generateSkillContent(
  skillName: string,
  task:      string,
  tools:     string[],
  duration:  number,
  llmCaller: LLMCaller,
  apiKey:    string,
  model:     string,
  provider:  string,
): Promise<string> {
  const prompt = `Generate a SKILL.md file for DevOS based on this successful task execution.

Task: "${task}"
Tools used in order: ${tools.join(' → ')}
Duration: ${Math.round(duration / 1000)}s

Write a SKILL.md with this EXACT format:
---
name: ${skillName}
description: [one line description of what this skill does]
version: 1.0.0
origin: local
confidence: low
tags: [comma separated tags relevant to this task]
---

# [Skill Title in Title Case]

[2-5 bullet points of key instructions for doing this type of task well]
[Include specific tips learned from this execution]
[Keep it concise — under 200 words total]

Output ONLY the SKILL.md content. No explanation.`

  try {
    const content = await llmCaller(prompt, apiKey, model, provider)
    // Validate it has valid frontmatter
    if (content.includes('---') && content.includes('name:')) {
      return content.trim()
    }
    // Fallback — minimal valid SKILL.md
    return buildFallbackSkill(skillName, task, tools, duration)
  } catch {
    return buildFallbackSkill(skillName, task, tools, duration)
  }
}

function buildFallbackSkill(
  skillName: string,
  task:      string,
  tools:     string[],
  duration:  number,
): string {
  const title = skillName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return `---
name: ${skillName}
description: ${task.slice(0, 80)}
version: 1.0.0
origin: local
confidence: low
tags: ${tools.join(', ')}
---

# ${title}

When performing this type of task:
1. Use tools in this order: ${tools.join(' → ')}
2. Task completed in ~${Math.round(duration / 1000)}s
3. Verify each step output before proceeding to the next
`
}

// ── SkillTeacher ───────────────────────────────────────────────

export class SkillTeacher {
  private static instance: SkillTeacher

  private constructor() {
    try { fs.mkdirSync(LEARNED_DIR,  { recursive: true }) } catch {}
    try { fs.mkdirSync(APPROVED_DIR, { recursive: true }) } catch {}
  }

  static getInstance(): SkillTeacher {
    if (!SkillTeacher.instance) {
      SkillTeacher.instance = new SkillTeacher()
    }
    return SkillTeacher.instance
  }

  /** C18: Allow call sites to skip recordSuccess entirely when session is full */
  static hasCapacity(): boolean {
    return _sessionSkillsCreated < SESSION_SKILL_LIMIT
  }

  // ── Check if a matching skill already exists ──────────────

  hasMatchingSkill(task: string, tools: string[]): boolean {
    const skillName = extractSkillName(task, tools)

    const dirsToCheck = [
      path.join(process.cwd(), 'skills'),
      LEARNED_DIR,
      APPROVED_DIR,
    ]

    for (const dir of dirsToCheck) {
      try {
        if (fs.existsSync(dir) && fs.existsSync(path.join(dir, skillName))) return true
      } catch {}
    }
    return false
  }

  // ── Record a successful task ───────────────────────────────

  async recordSuccess(
    task:      string,
    tools:     string[],
    duration:  number,
    llmCaller: LLMCaller,
    apiKey:    string,
    model:     string,
    provider:  string,
  ): Promise<void> {
    if (tools.length === 0) return

    const skillName = extractSkillName(task, tools)

    // ── C18: Skip names already rejected this session ────────────
    if (_rejectedNames.has(skillName)) return

    // ── C18: Session rate limit (moved up — avoids running all
    //    quality gates when limit is already exhausted) ────────────
    if (_sessionSkillsCreated >= SESSION_SKILL_LIMIT) return

    const metaPath  = path.join(LEARNED_DIR, skillName, 'meta.json')
    const skillPath = path.join(LEARNED_DIR, skillName, 'SKILL.md')

    // ── If skill exists — update usage count ─────────────────
    if (fs.existsSync(metaPath)) {
      try {
        const meta: LearnedSkillMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        meta.successCount++
        meta.lastUsed    = Date.now()
        meta.avgDuration = Math.round((meta.avgDuration + duration) / 2)
        meta.confidence  = Math.min(meta.successCount / PROMOTE_THRESHOLD, 1)

        if (meta.successCount >= PROMOTE_THRESHOLD && !meta.promoted) {
          this.promoteSkill(skillName)
          meta.promoted = true
          console.log(`[SkillTeacher] Promoted "${skillName}" → approved/ (${meta.successCount} successes)`)
        }

        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
        console.log(`[SkillTeacher] Updated "${skillName}" — ${meta.successCount} successes, confidence: ${(meta.confidence * 100).toFixed(0)}%`)
      } catch (e: any) {
        console.warn(`[SkillTeacher] Meta update failed for "${skillName}": ${e.message}`)
      }
      return
    }

    // ── Quality gate — reject low-signal skill names ──────────
    const isLowQuality = (
      skillName.length < 5 ||
      skillName.split('_').length < 2 ||
      task.split(/\s+/).length < 3
    )
    if (isLowQuality) {
      console.log(`[SkillTeacher] Rejected low-quality skill: "${skillName}"`)
      _rejectedNames.add(skillName)
      return
    }

    // ── C7: Destructive-skill prevention ──────────────────────
    // Reject any skill that pairs shell_exec with a destructive task description.
    // Prevents poisoned skills like "delete_users_<name>" that accidentally learned
    // from test-triggered or misrouted Delete/Remove operations.
    const DESTRUCTIVE_TASK_RE = /\b(delete|remove|rm\s|del\s|wipe|purge|erase|format|uninstall|drop\s+table|truncate)\b/i
    const usesShellExec        = tools.some(t => t === 'shell_exec')
    if (DESTRUCTIVE_TASK_RE.test(task) && usesShellExec) {
      process.stderr.write(
        `[SkillTeacher] Rejected destructive skill: "${skillName}" (task="${task.slice(0, 60)}")\n`
      )
      _rejectedNames.add(skillName)
      return
    }

    // ── C12: Name pollution prevention ──────────────────────────
    const nameRejection = validateSkillName(skillName)
    if (nameRejection) {
      process.stderr.write(`[SkillTeacher] Rejected "${skillName}": ${nameRejection}\n`)
      _rejectedNames.add(skillName)
      return
    }

    // ── C12: Task content validation ────────────────────────────
    const taskRejection = validateSkillTask(task)
    if (taskRejection) {
      process.stderr.write(`[SkillTeacher] Rejected "${skillName}": ${taskRejection}\n`)
      _rejectedNames.add(skillName)
      return
    }

    // ── Deduplication — reject names already in bundled skills/, approved/, or learned/ ─
    const dirsToDedup = [BUNDLED_SKILLS_DIR, APPROVED_DIR, LEARNED_DIR]
    for (const dir of dirsToDedup) {
      if (fs.existsSync(path.join(dir, skillName))) {
        console.log(`[SkillTeacher] Skipping duplicate (exists in ${path.basename(dir)}/): "${skillName}"`)
        return
      }
    }

    // ── New skill — generate SKILL.md and write meta ──────────
    console.log(`[SkillTeacher] Learning new skill: "${skillName}" from task: "${task.slice(0, 60)}"`)

    try {
      const content = await generateSkillContent(
        skillName, task, tools, duration,
        llmCaller, apiKey, model, provider,
      )

      // ── Size validation — reject suspiciously small or large content ──
      const byteLen = Buffer.byteLength(content, 'utf-8')
      if (byteLen < 200) {
        console.warn(`[SkillTeacher] Rejected "${skillName}": content too small (${byteLen} bytes, min 200)`)
        return
      }
      if (byteLen > 10240) {
        console.warn(`[SkillTeacher] Rejected "${skillName}": content too large (${byteLen} bytes > 10KB)`)
        return
      }

      // ── Structural validation — must have frontmatter + heading + body ──
      const hasFrontmatter = (content.match(/---/g) || []).length >= 2
      const hasNameField   = /^name:\s*\S/m.test(content)
      const hasDescField   = /^description:\s*\S/m.test(content)
      const hasHeading     = /^#\s+\S/m.test(content)
      const hasBody        = content.split('\n').filter(l => l.trim().length > 0).length >= 8
      if (!hasFrontmatter || !hasNameField || !hasDescField || !hasHeading || !hasBody) {
        console.warn(`[SkillTeacher] Rejected "${skillName}": failed structural validation (frontmatter=${hasFrontmatter}, name=${hasNameField}, desc=${hasDescField}, heading=${hasHeading}, body=${hasBody})`)
        return
      }

      fs.mkdirSync(path.join(LEARNED_DIR, skillName), { recursive: true })
      fs.writeFileSync(skillPath, content, 'utf-8')

      const meta: LearnedSkillMeta = {
        name:         skillName,
        taskPattern:  task.slice(0, 100),
        toolSequence: tools,
        successCount: 1,
        failCount:    0,
        confidence:   1 / PROMOTE_THRESHOLD,
        promoted:     false,
        createdAt:    Date.now(),
        lastUsed:     Date.now(),
        avgDuration:  duration,
      }

      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
      _sessionSkillsCreated++
      console.log(`[SkillTeacher] Saved new skill: "${skillName}" (session total: ${_sessionSkillsCreated}/${SESSION_SKILL_LIMIT})`)

      // Invalidate skillLoader cache so new skill is picked up immediately
      try {
        const { skillLoader } = await import('./skillLoader')
        skillLoader.refresh()
      } catch {}

    } catch (e: any) {
      console.warn(`[SkillTeacher] Failed to generate skill "${skillName}": ${e.message}`)
    }
  }

  // ── Record a failed task ───────────────────────────────────

  recordFailure(task: string, tools: string[]): void {
    if (tools.length === 0) return
    const skillName = extractSkillName(task, tools)
    const metaPath  = path.join(LEARNED_DIR, skillName, 'meta.json')
    if (!fs.existsSync(metaPath)) return
    try {
      const meta: LearnedSkillMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      meta.failCount++
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    } catch {}
  }

  // ── Promote skill from learned/ to approved/ ───────────────

  private promoteSkill(skillName: string): void {
    const src  = path.join(LEARNED_DIR,  skillName)
    const dest = path.join(APPROVED_DIR, skillName)
    try {
      fs.mkdirSync(dest, { recursive: true })
      for (const file of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, file), path.join(dest, file))
      }
      // Invalidate cache after promotion
      import('./skillLoader').then(m => m.skillLoader.refresh()).catch(() => {})
    } catch (e: any) {
      console.warn(`[SkillTeacher] Promotion failed for "${skillName}": ${e.message}`)
    }
  }

  // ── List helpers ───────────────────────────────────────────

  private readDir(dir: string): LearnedSkillMeta[] {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter(d => {
        try { return fs.statSync(path.join(dir, d)).isDirectory() } catch { return false }
      })
      .map(name => {
        try {
          const metaPath = path.join(dir, name, 'meta.json')
          if (fs.existsSync(metaPath)) {
            return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as LearnedSkillMeta
          }
          return { name, successCount: 0, failCount: 0, confidence: 0 } as LearnedSkillMeta
        } catch {
          return { name, successCount: 0, failCount: 0, confidence: 0 } as LearnedSkillMeta
        }
      })
  }

  listLearned(): LearnedSkillMeta[] {
    return this.readDir(LEARNED_DIR)
  }

  listApproved(): LearnedSkillMeta[] {
    return this.readDir(APPROVED_DIR)
  }

  getStats(): { learned: number; approved: number; totalSuccesses: number } {
    const learned         = this.listLearned()
    const approved        = this.listApproved()
    const totalSuccesses  = learned.reduce((s, m) => s + (m.successCount || 0), 0)
    return { learned: learned.length, approved: approved.length, totalSuccesses }
  }
}

export const skillTeacher = SkillTeacher.getInstance()
