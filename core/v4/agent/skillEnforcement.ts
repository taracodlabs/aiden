/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/agent/skillEnforcement.ts — Phase 23.1 (Bug B mechanical fix).
 *
 * Tracks the required-tool sequence declared by `skill_view`'s loaded
 * skill (frontmatter `required_tools: []`) and enforces it at the
 * message-final boundary in the agent loop. When the model emits a
 * final message without firing every required tool, we treat the turn
 * as incomplete and inject a corrective system message — same mechanism
 * Hermes uses for the Codex Harmony-leak case
 * (run_agent.py:12966-13022, finish_reason=incomplete + retry).
 *
 * State is per **user turn**, not per agent-loop iteration. A user turn
 * spans every assistant/tool round-trip until a clean final message
 * lands. We arm/disarm via explicit calls from the loop.
 *
 * AIDEN_DEBUG_SKILL_ENFORCEMENT=1 mirrors the AIDEN_DEBUG_CODEX pattern:
 * stderr logging only when the env var is set to '1'.
 */

/** Hard cap on corrective retries per user turn. See audit doc rationale. */
export const SKILL_ENFORCEMENT_RETRY_CAP = 2;

/** Result of a final-boundary check. */
export type EnforcementVerdict =
  | { kind: 'no-skill-armed' }
  | { kind: 'satisfied'; skillName: string; called: string[] }
  | {
      kind: 'incomplete-can-retry';
      skillName: string;
      missing: string[];
      called: string[];
      attempt: number;
      cap: number;
    }
  | {
      kind: 'incomplete-cap-exceeded';
      skillName: string;
      missing: string[];
      called: string[];
      cap: number;
    };

/** In-memory metrics surfaced to /doctor. Process-scoped, no persistence. */
export interface SkillEnforcementMetrics {
  /** Times a corrective retry produced the missing tool call(s). */
  recovered: number;
  /** Times the cap was exceeded and the turn ended with honest failure. */
  failed: number;
  /** Total times any skill armed enforcement (sanity check). */
  armed: number;
}

function debugEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.AIDEN_DEBUG_SKILL_ENFORCEMENT === '1'
  );
}

function debugLog(msg: string): void {
  if (!debugEnabled()) return;
  // eslint-disable-next-line no-console
  console.warn(`[skill-enforcement] ${msg}`);
}

/**
 * One tracker per user turn. Construct on entry to runConversation,
 * call recordSkillView/recordToolCall as the loop dispatches, and
 * evaluateOnFinal at the message-final boundary.
 */
export class SkillEnforcementTracker {
  private skillName: string | null = null;
  private requiredTools: string[] = [];
  private readonly calledTools: Set<string> = new Set();
  private retries = 0;

  constructor(private readonly metrics: SkillEnforcementMetrics) {}

  /**
   * Called when `skill_view` returns a successful payload that includes
   * a non-empty `requiredTools` array. If multiple skill_views fire in
   * one turn, the most recent armed skill wins — that matches user
   * intent (a fresh skill_view supersedes the prior one).
   */
  recordSkillView(name: string, requiredTools: readonly string[]): void {
    if (!Array.isArray(requiredTools) || requiredTools.length === 0) return;
    const filtered = requiredTools.filter(
      (t) => typeof t === 'string' && t.length > 0,
    );
    if (filtered.length === 0) return;
    this.skillName = name;
    this.requiredTools = filtered;
    // Don't reset calledTools — a tool already called this turn still counts.
    this.metrics.armed += 1;
    debugLog(`arm skill=${name} required=[${filtered.join(', ')}]`);
  }

  /** Called for every tool dispatch (regardless of result). */
  recordToolCall(toolName: string): void {
    if (typeof toolName !== 'string' || !toolName) return;
    this.calledTools.add(toolName);
    if (this.skillName) {
      const remaining = this.computeMissing();
      debugLog(
        `tool-call ${toolName} called=[${[...this.calledTools].join(', ')}] missing=[${remaining.join(', ')}]`,
      );
    }
  }

  /** Internal helper — required tools not yet called. */
  private computeMissing(): string[] {
    return this.requiredTools.filter((t) => !this.calledTools.has(t));
  }

  /** Current retry attempt count (0 before the first injection). */
  attempt(): number {
    return this.retries;
  }

  /** Currently-armed skill name, if any. */
  armedSkill(): string | null {
    return this.skillName;
  }

  /**
   * Build the corrective system message for the next iteration.
   * Caller must invoke incrementRetry() after appending it.
   */
  buildCorrectiveMessage(missing: string[]): string {
    const skill = this.skillName ?? '<unknown>';
    const required = this.requiredTools.join(', ');
    const called = [...this.calledTools].join(', ') || '(none)';
    return (
      `[skill-enforcement] Required tool sequence incomplete. ` +
      `Skill \`${skill}\` requires: [${required}]. ` +
      `You have called: [${called}]. ` +
      `Missing: [${missing.join(', ')}]. ` +
      `Call the missing tools now. Do not claim completion.`
    );
  }

  /** Mark that we just injected a corrective and let the loop continue. */
  incrementRetry(): void {
    this.retries += 1;
  }

  /**
   * Called when the model's response carries no tool calls. Decides
   * whether the loop may finalize, must retry, or must fail.
   */
  evaluateOnFinal(): EnforcementVerdict {
    if (!this.skillName || this.requiredTools.length === 0) {
      return { kind: 'no-skill-armed' };
    }
    const missing = this.computeMissing();
    if (missing.length === 0) {
      this.metrics.recovered += this.retries > 0 ? 1 : 0;
      const called = [...this.calledTools];
      debugLog(
        `satisfied skill=${this.skillName} called=[${called.join(', ')}] retries=${this.retries}`,
      );
      return { kind: 'satisfied', skillName: this.skillName, called };
    }
    if (this.retries < SKILL_ENFORCEMENT_RETRY_CAP) {
      const verdict: EnforcementVerdict = {
        kind: 'incomplete-can-retry',
        skillName: this.skillName,
        missing,
        called: [...this.calledTools],
        attempt: this.retries + 1,
        cap: SKILL_ENFORCEMENT_RETRY_CAP,
      };
      debugLog(
        `inject-retry missing=[${missing.join(', ')}] attempt=${verdict.attempt}/${verdict.cap}`,
      );
      return verdict;
    }
    this.metrics.failed += 1;
    debugLog(
      `failed cap=${SKILL_ENFORCEMENT_RETRY_CAP} skill=${this.skillName} missing=[${missing.join(', ')}]`,
    );
    return {
      kind: 'incomplete-cap-exceeded',
      skillName: this.skillName,
      missing,
      called: [...this.calledTools],
      cap: SKILL_ENFORCEMENT_RETRY_CAP,
    };
  }
}

/**
 * Inspect a tool result returned by the executor. If it's a successful
 * skill_view payload with a non-empty requiredTools list, return the
 * pair so the loop can arm the tracker. Tolerant of all result shapes —
 * never throws, returns null on anything unexpected.
 */
export function extractSkillViewRequiredTools(
  toolName: string,
  resultBody: unknown,
): { skillName: string; requiredTools: string[] } | null {
  if (toolName !== 'skill_view') return null;
  if (!resultBody || typeof resultBody !== 'object') return null;
  const r = resultBody as {
    success?: unknown;
    name?: unknown;
    requiredTools?: unknown;
  };
  if (r.success !== true) return null;
  const skillName = typeof r.name === 'string' ? r.name : null;
  if (!skillName) return null;
  const required = r.requiredTools;
  if (!Array.isArray(required) || required.length === 0) return null;
  const filtered = required.filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  );
  if (filtered.length === 0) return null;
  return { skillName, requiredTools: filtered };
}
