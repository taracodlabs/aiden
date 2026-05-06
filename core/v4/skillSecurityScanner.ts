/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillSecurityScanner.ts — Aiden v4.0.0
 *
 * Trust-level classifier + content scanner for skills installed
 * from hubs. Runs on every install; bundled and official skills
 * pass through regardless of findings (the trust level overrides),
 * trusted skills warn, community skills are blocked when any
 * `dangerous` finding is present.
 *
 * Pattern set is intentionally narrower than `moat/dangerousPatterns`
 * — skill bodies are markdown with code samples, so we only flag
 * patterns that are dangerous when *executed verbatim* by the agent
 * (the dangerous-patterns catalog covers the same ground at the
 * shell_exec gate, so this is defense in depth, not duplication).
 *
 * Status: PHASE 10.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ParsedSkill, TrustLevel } from './skillSpec';
import type { HubSource } from './skillsHubTypes';

export type FindingCategory =
  | 'shell_command'
  | 'eval_pattern'
  | 'credential_pattern'
  | 'pipe_to_shell'
  | 'base64_payload'
  | 'network_call';

export type FindingSeverity = 'caution' | 'dangerous';

export interface SkillSecurityFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  matchedText: string;
}

interface FindingPattern {
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  regex: RegExp;
}

const PATTERNS: readonly FindingPattern[] = [
  // ── Shell-bypass patterns ────────────────────────────────────
  {
    category: 'pipe_to_shell',
    severity: 'dangerous',
    description: 'Pipe-to-shell pattern (curl|bash, wget|sh)',
    regex: /\b(curl|wget|invoke-webrequest)\b[^|`]*\|\s*(ba)?sh\b/i,
  },
  {
    category: 'shell_command',
    severity: 'dangerous',
    description: 'rm -rf / or recursive root delete',
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\//i,
  },
  {
    category: 'shell_command',
    severity: 'dangerous',
    description: 'Format / wipe filesystem',
    regex: /\b(mkfs|format-volume|clear-disk|diskpart)\b/i,
  },
  // ── Code-eval patterns ────────────────────────────────────────
  {
    category: 'eval_pattern',
    severity: 'caution',
    description: 'JavaScript eval() / Function constructor',
    regex: /\b(eval|new\s+Function)\s*\(/i,
  },
  {
    category: 'eval_pattern',
    severity: 'caution',
    description: 'Node.js vm.runInThisContext',
    regex: /\bvm\.run(InThisContext|InNewContext|InContext)\b/i,
  },
  {
    category: 'eval_pattern',
    severity: 'dangerous',
    description: 'PowerShell Invoke-Expression / iex',
    regex: /\b(iex|Invoke-Expression)\s*\(?/i,
  },
  {
    category: 'eval_pattern',
    severity: 'caution',
    description: 'Python exec() / eval() of variable',
    regex: /\b(exec|eval)\s*\(\s*[a-zA-Z_]/i,
  },
  // ── Credential exfiltration ───────────────────────────────────
  {
    category: 'credential_pattern',
    severity: 'dangerous',
    description: 'AWS access key id literal',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    category: 'credential_pattern',
    severity: 'dangerous',
    description: 'Generic bearer token literal',
    regex: /\bbearer\s+[A-Za-z0-9_\-]{32,}\b/i,
  },
  {
    category: 'credential_pattern',
    severity: 'caution',
    description: 'Hardcoded secret-looking assignment',
    regex: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{16,}["']/i,
  },
  // ── Base64-payload heuristic ─────────────────────────────────
  {
    category: 'base64_payload',
    severity: 'caution',
    description: 'Long base64-like blob — possible obfuscated payload',
    regex: /[A-Za-z0-9+/]{256,}={0,2}/,
  },
  // ── Network calls to suspicious endpoints ────────────────────
  {
    category: 'network_call',
    severity: 'dangerous',
    description: 'Network call to cloud-metadata endpoint',
    regex: /\b169\.254\.169\.254\b|metadata\.(google\.internal|azure\.com|aws\.amazon\.com)/i,
  },
];

export class SkillSecurityScanner {
  /** Map a HubSource (or raw type) to a trust level. */
  trustLevelForSource(source: HubSource | string | undefined): TrustLevel {
    if (!source) return 'community';
    const type = typeof source === 'string' ? source : source.type;
    switch (type) {
      case 'builtin':
        return 'builtin';
      case 'official':
        return 'official';
      case 'agentskills':
      case 'claude-marketplace':
      case 'skills-sh':
        return 'trusted';
      case 'github':
      case 'url':
      case 'well-known':
      case 'clawhub':
      default:
        return 'community';
    }
  }

  scan(skill: ParsedSkill): SkillSecurityFinding[] {
    return scanText(skill.body);
  }

  async scanFull(skillDir: string): Promise<SkillSecurityFinding[]> {
    const findings: SkillSecurityFinding[] = [];
    const stack: string[] = [skillDir];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          const content = await fs.readFile(full, 'utf-8').catch(() => '');
          findings.push(...scanText(content));
        }
      }
    }
    return dedupe(findings);
  }

  /**
   * Decide whether the skill can be installed.
   *
   * - builtin / official: always allowed; findings ignored.
   * - trusted: findings reported as warnings; install allowed.
   * - community: dangerous findings BLOCK; caution allowed with
   *   warning. Caller may set `force` to override caution; dangerous
   *   never overrides except via a non-Phase-10 admin escape hatch.
   */
  decideInstall(
    trustLevel: TrustLevel,
    findings: SkillSecurityFinding[],
  ): { allowed: boolean; reason?: string; warnings?: string[] } {
    if (trustLevel === 'builtin' || trustLevel === 'official') {
      return { allowed: true };
    }
    const dangerous = findings.filter((f) => f.severity === 'dangerous');
    const caution = findings.filter((f) => f.severity === 'caution');
    if (trustLevel === 'trusted') {
      const warnings = [...dangerous, ...caution].map((f) => f.description);
      return { allowed: true, warnings };
    }
    // community
    if (dangerous.length > 0) {
      return {
        allowed: false,
        reason: `Skill contains dangerous patterns: ${dangerous.map((f) => f.description).join(', ')}`,
      };
    }
    if (caution.length > 0) {
      return {
        allowed: true,
        warnings: caution.map((f) => f.description),
      };
    }
    return { allowed: true };
  }
}

function scanText(text: string): SkillSecurityFinding[] {
  const out: SkillSecurityFinding[] = [];
  for (const p of PATTERNS) {
    const m = text.match(p.regex);
    if (m) {
      out.push({
        category: p.category,
        severity: p.severity,
        description: p.description,
        matchedText: m[0].slice(0, 200),
      });
    }
  }
  return out;
}

function dedupe(arr: SkillSecurityFinding[]): SkillSecurityFinding[] {
  const seen = new Set<string>();
  const out: SkillSecurityFinding[] = [];
  for (const f of arr) {
    const key = `${f.category}::${f.matchedText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
