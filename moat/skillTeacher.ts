/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/skillTeacher.ts — Aiden v4.0.0
 *
 * Watches the agent's tool-call traces. When it detects a successful
 * multi-step workflow, proposes saving it as a new skill so future
 * conversations can replay it cheaply.
 *
 * Tier model:
 *   off              — observation disabled.
 *   tier_3_propose   — DEFAULT (free tier). Detects + proposes via
 *                      `callbacks.promptUser`. Skill is created only
 *                      when the user accepts.
 *   tier_4_auto      — Pro tier. Auto-creates without prompting once
 *                      the threshold is met.
 *
 * Proposal trigger (ALL must be true):
 *   - 5+ successful tool calls in one conversation turn
 *   - No errors in those tool calls
 *   - Conversation produced a final response (not aborted/budget_exhausted)
 *   - Tools used span 2+ different toolsets
 *   - User did NOT say "don't save this" / "this is a one-off"
 *
 * Naming heuristic (Phase 12 rule-based; Phase 14 LLM-polished):
 *   <toolset-of-most-used-tool>-<3-kebab-words-from-first-user-message>
 *   e.g.  "files-rename-old-screenshots"
 *
 * Quality scoring:
 *   `trackSkillUsage(name, success)` accumulates per-skill stats. After
 *   5+ uses, if success rate < 60%, the skill is `quality_flagged` and
 *   skillLoader.loadAll() filters it out (via the integration shim
 *   AidenAgent calls). Persisted to `paths.skillsDir/.skill-quality.json`.
 *
 * Status: PHASE 12.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  SkillLoader,
} from '../core/v4/skillLoader';
import type { ToolHandler } from '../core/v4/toolRegistry';
import type { ToolCallRequest } from '../providers/v4/types';

export type SkillTeacherTier = 'off' | 'tier_3_propose' | 'tier_4_auto';

export interface SkillProposal {
  proposedName: string;
  description: string;
  toolsUsed: string[];
  exampleSteps: string[];
  trace: Array<{
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  confidence: number;
}

export interface SkillProposalCallbacks {
  /** Optional prompt — Tier 3 returns true to accept. Tier 4 skips. */
  promptUser?: (proposal: SkillProposal) => Promise<boolean>;
}

export interface SkillManageHandler {
  execute(
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<unknown>;
}

export interface SkillQualityRecord {
  successCount: number;
  failureCount: number;
  flagged: boolean;
}

/** Trace shape SkillTeacher inspects. Compatible with AidenAgent's
 *  `toolCallTrace` and ToolCallRequest+Result pairs. */
export interface SkillTeacherTraceEntry {
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  /** Phase 9 mutates flag (if available). */
  toolset?: string;
}

/** Min trace length to even consider proposing a skill. */
const MIN_TRACE_LEN = 5;
/** Min distinct toolsets to qualify a workflow as multi-domain. */
const MIN_TOOLSETS = 2;
/** Phase 16b.2: min distinct tool *types* before proposing. Stops "skills-hey"
 *  from a single-tool greeting trace. */
const MIN_DISTINCT_TOOL_TYPES = 3;
/** Phase 16b.2: min user message length before proposing. Skips greetings. */
const MIN_FIRST_USER_LEN = 20;
/** Successful uses required before quality flagging kicks in. */
const QUALITY_MIN_USES = 5;
/** Below this success rate, the skill gets flagged. */
const QUALITY_THRESHOLD = 0.6;

/** Phrases that mean "do not save this as a skill". */
const OPT_OUT_RE =
  /\b(?:don'?t\s+save|don'?t\s+remember\s+this|this\s+is\s+a?\s*one[-\s]?off|do\s+not\s+save|just\s+this\s+once)\b/i;

/** Common stopwords for kebab-name extraction. */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'in',
  'on',
  'for',
  'of',
  'with',
  'my',
  'your',
  'about',
  'from',
  'please',
  'can',
  'could',
  'would',
  'should',
  'just',
  'really',
  'also',
]);

export class SkillTeacher {
  private tier: SkillTeacherTier;
  /** In-memory quality cache; hydrated from disk on first read. */
  private qualityCache: Record<string, SkillQualityRecord> | null = null;
  /** Last quality file load path (for save). */
  private qualityPath: string;

  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly skillManager: SkillManageHandler,
    tier: SkillTeacherTier = 'tier_3_propose',
    /** Where to persist skill-quality data. Defaults to cwd. */
    qualityFilePath?: string,
    /** Optional handler-resolver to look up toolset metadata for trace
     *  entries that don't carry their own toolset. Used for the 2-toolset
     *  diversity check. */
    private readonly resolveHandler?: (
      name: string,
    ) => ToolHandler | undefined,
  ) {
    this.tier = tier;
    this.qualityPath =
      qualityFilePath ??
      path.join(process.cwd(), '.aiden-skill-quality.json');
  }

  setTier(tier: SkillTeacherTier): void {
    this.tier = tier;
  }

  getTier(): SkillTeacherTier {
    return this.tier;
  }

  // ─────────────────────────────────────────────────────────────────────
  // observation
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Inspect a finished turn. Returns a proposal if the workflow qualifies,
   * otherwise null. Does NOT create the skill (call `handleProposal`).
   *
   * `aborted` should be set true by the caller (AidenAgent) when the
   * conversation finishReason was 'budget_exhausted' or 'error'.
   */
  async observeTurn(
    messages: Array<{ role: string; content?: string }>,
    trace: SkillTeacherTraceEntry[],
    aborted: boolean = false,
  ): Promise<SkillProposal | null> {
    if (this.tier === 'off') return null;
    if (aborted) return null;
    if (trace.length < MIN_TRACE_LEN) return null;
    if (trace.some((t) => t.error)) return null;

    // Phase 16b.2: don't propose during the FIRST user turn of a session.
    // Detected by the message history shape — exactly one user message
    // means this is turn 1 and most workflows haven't been demonstrated
    // long enough to deserve a skill yet.
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length < 2) return null;

    // Phase 16b.2: require workflow diversity by *tool type*, not just
    // toolset. Five calls all to `web_search` shouldn't qualify.
    const distinctToolTypes = new Set(trace.map((t) => t.name)).size;
    if (distinctToolTypes < MIN_DISTINCT_TOOL_TYPES) return null;

    const toolsets = this.collectToolsets(trace);
    if (toolsets.size < MIN_TOOLSETS) return null;

    const firstUser = userMessages[0]?.content ?? '';
    if (!firstUser.trim()) return null;
    // Phase 16b.2: skip short prompts ("hey", "hi", single-word commands).
    if (firstUser.trim().length < MIN_FIRST_USER_LEN) return null;
    if (OPT_OUT_RE.test(firstUser)) return null;
    // Also scan all user messages for opt-out (later turn might say it).
    for (const m of userMessages) {
      if (m.content && OPT_OUT_RE.test(m.content)) return null;
    }

    const toolsUsed = trace.map((t) => t.name);
    const proposedName = this.proposeName(firstUser, toolsUsed, toolsets);
    const description = this.proposeDescription(toolsets, toolsUsed);
    const exampleSteps = trace.slice(0, 8).map((t) => `Call ${t.name}`);

    return {
      proposedName,
      description,
      toolsUsed,
      exampleSteps,
      trace: trace.map((t) => ({
        name: t.name,
        args: t.args ?? {},
        result: t.result,
      })),
      confidence: 0.5,
    };
  }

  /**
   * Decide what to do with a proposal. Tier 3 prompts; Tier 4 auto-creates.
   * Returns whether the skill was created and its name.
   */
  async handleProposal(
    proposal: SkillProposal,
    callbacks: SkillProposalCallbacks = {},
  ): Promise<{ created: boolean; skillName?: string; reason?: string }> {
    if (this.tier === 'off') {
      return { created: false, reason: 'tier_off' };
    }

    if (this.tier === 'tier_3_propose') {
      if (!callbacks.promptUser) {
        return { created: false, reason: 'no_prompt_callback' };
      }
      const accept = await callbacks.promptUser(proposal);
      if (!accept) {
        return { created: false, reason: 'declined' };
      }
    }
    // tier_4_auto: skip prompt entirely.

    const content = this.buildSkillMarkdown(proposal);
    try {
      await this.skillManager.execute(
        {
          action: 'create',
          name: proposal.proposedName,
          content,
        },
        {},
      );
      return { created: true, skillName: proposal.proposedName };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { created: false, reason: `create_failed: ${msg}` };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // quality scoring
  // ─────────────────────────────────────────────────────────────────────

  /** Record one skill execution. Persisted lazily. */
  trackSkillUsage(skillName: string, success: boolean): void {
    const cache = this.ensureQualityCacheSync();
    const rec = cache[skillName] ?? {
      successCount: 0,
      failureCount: 0,
      flagged: false,
    };
    if (success) rec.successCount += 1;
    else rec.failureCount += 1;
    const total = rec.successCount + rec.failureCount;
    if (total >= QUALITY_MIN_USES) {
      const rate = rec.successCount / total;
      rec.flagged = rate < QUALITY_THRESHOLD;
    }
    cache[skillName] = rec;
    // Fire-and-forget save.
    this.saveQuality(cache).catch(() => {});
  }

  getSkillQualityScore(
    skillName: string,
  ): { successRate: number; usageCount: number; flagged: boolean } {
    const cache = this.ensureQualityCacheSync();
    const rec = cache[skillName] ?? {
      successCount: 0,
      failureCount: 0,
      flagged: false,
    };
    const total = rec.successCount + rec.failureCount;
    const rate = total === 0 ? 1 : rec.successCount / total;
    return { successRate: rate, usageCount: total, flagged: rec.flagged };
  }

  /** Returns the names of all flagged skills. SkillLoader filters
   *  these from `loadAll()` results via the AidenAgent integration. */
  flaggedSkillNames(): string[] {
    const cache = this.ensureQualityCacheSync();
    return Object.entries(cache)
      .filter(([, v]) => v.flagged)
      .map(([k]) => k);
  }

  // ─────────────────────────────────────────────────────────────────────
  // helpers
  // ─────────────────────────────────────────────────────────────────────

  private collectToolsets(trace: SkillTeacherTraceEntry[]): Set<string> {
    const out = new Set<string>();
    for (const entry of trace) {
      if (entry.toolset) {
        out.add(entry.toolset);
        continue;
      }
      const handler = this.resolveHandler?.(entry.name);
      if (handler?.toolset) out.add(handler.toolset);
    }
    return out;
  }

  private proposeName(
    firstUser: string,
    toolsUsed: string[],
    toolsets: Set<string>,
  ): string {
    // Find the most-used tool's toolset for the prefix.
    const counts = new Map<string, number>();
    for (const t of toolsUsed) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let mostUsed = toolsUsed[0];
    let maxCount = 0;
    for (const [name, c] of counts) {
      if (c > maxCount) {
        maxCount = c;
        mostUsed = name;
      }
    }
    let prefix =
      this.resolveHandler?.(mostUsed)?.toolset ??
      [...toolsets][0] ??
      'workflow';

    const slug = kebabFromText(firstUser, 3);
    if (!slug) return `${prefix}-task`;
    return `${prefix}-${slug}`;
  }

  private proposeDescription(
    toolsets: Set<string>,
    toolsUsed: string[],
  ): string {
    const toolsetList = [...toolsets].join('+');
    return `${verbForToolset([...toolsets][0])} using ${toolsetList} (${toolsUsed.length} steps)`;
  }

  private buildSkillMarkdown(proposal: SkillProposal): string {
    const tags = [...new Set(proposal.toolsUsed)].slice(0, 6).join(', ');
    return `---
name: ${proposal.proposedName}
description: ${proposal.description}
version: 1.0.0
category: learned
tags: [${tags}]
metadata:
  aiden:
    confidence: low
    learned_at: ${new Date().toISOString()}
---

# ${proposal.proposedName}

Auto-generated skill from a successful tool-call workflow.

## Steps

${proposal.exampleSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Tools used

${[...new Set(proposal.toolsUsed)].map((t) => `- ${t}`).join('\n')}
`;
  }

  // ── quality persistence ──────────────────────────────────────

  private ensureQualityCacheSync(): Record<string, SkillQualityRecord> {
    if (this.qualityCache !== null) return this.qualityCache;
    // Synchronous bootstrap (rare hot path; quality is ms-scale).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsSync = require('node:fs') as typeof import('node:fs');
      if (fsSync.existsSync(this.qualityPath)) {
        const raw = fsSync.readFileSync(this.qualityPath, 'utf-8');
        this.qualityCache = JSON.parse(raw);
        return this.qualityCache!;
      }
    } catch {
      // ignore — corrupt file is replaced on next save.
    }
    this.qualityCache = {};
    return this.qualityCache;
  }

  private async saveQuality(
    cache: Record<string, SkillQualityRecord>,
  ): Promise<void> {
    try {
      await fs.writeFile(
        this.qualityPath,
        JSON.stringify(cache, null, 2),
        'utf-8',
      );
    } catch {
      // ignore disk failures — quality data is best-effort.
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────

export function kebabFromText(text: string, maxWords = 3): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, maxWords);
  return cleaned.join('-');
}

function verbForToolset(toolset?: string): string {
  switch (toolset) {
    case 'files':
      return 'Manage files';
    case 'web':
      return 'Search the web';
    case 'browser':
      return 'Drive a browser';
    case 'memory':
      return 'Manage memory';
    case 'execute':
    case 'terminal':
      return 'Execute code';
    case 'sessions':
      return 'Search sessions';
    default:
      return 'Run a workflow';
  }
}

/** Helper exported for AidenAgent's skill-listing integration: hide
 *  flagged skills from `skills_list` results. */
export function filterFlaggedSkills<T extends { name: string }>(
  skills: T[],
  flagged: Iterable<string>,
): T[] {
  const flag = new Set(flagged);
  return skills.filter((s) => !flag.has(s.name));
}

/** Convert AidenAgent's loop-time tool calls into the SkillTeacher
 *  trace entry shape. Lossless. */
export function toTeacherTrace(
  calls: Array<{
    request: ToolCallRequest;
    result: unknown;
    error?: string;
  }>,
  resolveHandler?: (name: string) => ToolHandler | undefined,
): SkillTeacherTraceEntry[] {
  return calls.map((c) => ({
    name: c.request.name,
    args: c.request.arguments,
    result: c.result,
    error: c.error,
    toolset: resolveHandler?.(c.request.name)?.toolset,
  }));
}

export const __test__ = { OPT_OUT_RE, kebabFromText };
