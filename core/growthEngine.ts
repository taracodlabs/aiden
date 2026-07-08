// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/growthEngine.ts — Self-improvement through failure analysis.
//
// Appends every failure as a JSONL line to workspace/growth/failure-log.jsonl.
// On analyze(), clusters failures by (capability, error-class) context hash,
// surfaces opportunities with count >= 3, and writes a weekly markdown report.

import fs   from 'fs'
import path from 'path'

// ── Paths ──────────────────────────────────────────────────────

const GROWTH_DIR         = path.join(process.cwd(), 'workspace', 'growth')
const FAILURE_LOG        = path.join(GROWTH_DIR, 'failure-log.jsonl')
const OPPORTUNITIES_PATH = path.join(GROWTH_DIR, 'skill-opportunities.json')
const REPORT_PATH        = path.join(GROWTH_DIR, 'weekly-report.md')

// ── Types ──────────────────────────────────────────────────────

type Failure = {
  timestamp:   number
  task:        string
  error:       string
  capability:  string
  contextHash: string
}

type Opportunity = {
  contextHash:   string
  count:         number
  suggestedSkill: string
  lastSeen:      number
  confidence:    number
}

export interface WeeklyReport {
  learned:   number
  failed:    number
  gaps:      string[]
  proposals: string[]
}

// ── GrowthEngine ───────────────────────────────────────────────

export class GrowthEngine {
  constructor() {
    try { fs.mkdirSync(GROWTH_DIR, { recursive: true }) } catch {}
  }

  // ── Record a failure ──────────────────────────────────────────

  logFailure(task: string, error: string, toolsAttempted: string[]): void {
    const capability   = toolsAttempted[toolsAttempted.length - 1] || 'unknown'
    const contextHash  = this.hashContext(error, capability)
    const entry: Failure = {
      timestamp:  Date.now(),
      task,
      error:      error.slice(0, 200),
      capability,
      contextHash,
    }
    try {
      fs.appendFileSync(FAILURE_LOG, JSON.stringify(entry) + '\n', 'utf-8')
    } catch {}

    console.log(`[GrowthEngine] Failure logged: ${contextHash} — "${task.slice(0, 60)}"`)
  }

  // ── Record a success ──────────────────────────────────────────
  // Tracked for confidence scoring — future use

  logSuccess(_task: string, _tools: string[]): void {
    // No-op — confidence scoring uses the failure ratio
  }

  // ── Analyse failure log and surface opportunities ─────────────

  analyze(): Opportunity[] {
    if (!fs.existsSync(FAILURE_LOG)) return []

    let lines: string[]
    try {
      lines = fs.readFileSync(FAILURE_LOG, 'utf-8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }

    const totalFailures = lines.length
    if (totalFailures === 0) return []

    const map = new Map<string, Opportunity>()

    for (const line of lines) {
      try {
        const f: Failure = JSON.parse(line)
        if (!map.has(f.contextHash)) {
          map.set(f.contextHash, {
            contextHash:   f.contextHash,
            count:         0,
            suggestedSkill: this.inferSkill(f),
            lastSeen:      f.timestamp,
            confidence:    0,
          })
        }
        const entry = map.get(f.contextHash)!
        entry.count++
        entry.lastSeen   = Math.max(entry.lastSeen, f.timestamp)
        entry.confidence = entry.count / totalFailures
      } catch {}
    }

    const opportunities = Array.from(map.values())
      .filter(o => o.count >= 3 && o.confidence > 0.1)
      .sort((a, b) => b.count - a.count)

    try {
      fs.writeFileSync(OPPORTUNITIES_PATH, JSON.stringify(opportunities, null, 2), 'utf-8')
    } catch {}

    return opportunities
  }

  // ── Weekly report ─────────────────────────────────────────────

  getWeeklyReport(): WeeklyReport {
    const opportunities = this.analyze()

    let failedCount = 0
    try {
      if (fs.existsSync(FAILURE_LOG)) {
        failedCount = fs.readFileSync(FAILURE_LOG, 'utf-8')
          .trim().split('\n').filter(Boolean).length
      }
    } catch {}

    const report: WeeklyReport = {
      learned:   0,
      failed:    failedCount,
      gaps:      opportunities.map(o => o.contextHash),
      proposals: opportunities.map(o => o.suggestedSkill),
    }

    // Write markdown report
    try {
      const lines = [
        `# DevOS Weekly Growth Report`,
        ``,
        `**Failed tasks:** ${report.failed}`,
        `**Gaps detected:** ${report.gaps.length}`,
        ``,
        opportunities.length === 0
          ? '_No recurring failure patterns detected._'
          : opportunities
              .map(o =>
                `- \`${o.contextHash}\` → \`${o.suggestedSkill}\` ` +
                `(${o.count} failures, confidence: ${(o.confidence * 100).toFixed(0)}%)`,
              )
              .join('\n'),
      ]
      fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf-8')
    } catch {}

    return report
  }

  // ── Context hash: (capability, error-class) pair ─────────────

  private hashContext(error: string, capability: string): string {
    const lower    = error.toLowerCase()
    const errClass = lower.includes('timeout')                         ? 'timeout'
      : lower.includes('selector')                                     ? 'selector'
      : lower.includes('403') || lower.includes('401')                 ? 'auth'
      : lower.includes('rate') || lower.includes('429')                ? 'ratelimit'
      : lower.includes('not found') || lower.includes('enoent')        ? 'notfound'
      : lower.includes('parse') || lower.includes('json')              ? 'parse'
      : lower.includes('network') || lower.includes('fetch')           ? 'network'
      : 'general'
    return `${capability}_${errClass}`
  }

  // ── Infer a skill name from a failure ─────────────────────────

  private inferSkill(f: Failure): string {
    const lower = f.error.toLowerCase()
    if (lower.includes('selector'))                             return 'web.extractor.robust'
    if (lower.includes('timeout'))                             return 'retry.backoff'
    if (f.capability.includes('file'))                        return 'file.recovery'
    if (lower.includes('rate') || lower.includes('429'))      return 'provider.rotation'
    if (lower.includes('403') || lower.includes('401'))       return 'auth.refresh'
    if (lower.includes('parse') || lower.includes('json'))    return 'output.parser'
    if (lower.includes('network') || lower.includes('fetch')) return 'network.resilience'
    return 'general.improvement'
  }
}

// ── Singleton ─────────────────────────────────────────────────

export const growthEngine = new GrowthEngine()
