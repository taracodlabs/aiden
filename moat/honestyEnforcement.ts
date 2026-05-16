/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/honestyEnforcement.ts — Aiden v4.0.0
 *
 * Post-loop trace inspector. Runs after AidenAgent returns its final
 * response. Compares the response's stated actions to the actual tool
 * calls in the trace. If the model claims it did something but the trace
 * says no tool fired (or fired and failed verification), Honesty refuses
 * the claim and rewrites the response.
 *
 * The failure modes this catches:
 *   - "I saved your file to ~/notes/today.md"   → no file_write call
 *   - "I sent the email"                         → no email tool call
 *   - "I remembered that"                        → no memory_add OR memory_add returned verified=false
 *   - "I searched the web"                       → no web_search call
 *   - "I ran X"                                  → no shell_exec call
 *
 * Three modes:
 *   off      — passes everything; no inspection.
 *   detect   — runs checks and populates findings, but does NOT modify the
 *              response. Useful for telemetry / canary measurement.
 *   enforce  — DEFAULT. Rewrites failed claims into honest text that lists
 *              the actual trace summary.
 *
 * Detection:
 *   1. Pattern-based (default, $0 cost) — past-tense action verbs matched
 *      against tool registry. This file owns the table.
 *   2. LLM-classified — auxiliary LLM call. Wired via the optional
 *      `llmAdapter`; defaulted off in Phase 12. Phase 13 turns it on.
 *
 * Critical invariant for memory:
 *   Every memory_add / memory_replace / memory_remove tool result carries
 *   a `verified` flag (per Phase 9 MemoryGuard). If the model claims
 *   "I remembered X" but `verified=false`, Honesty MUST flag this — even
 *   though a memory tool DID fire. This was the v3 C20/C21 lying surface.
 *
 * Status: PHASE 12.
 */

import type { ProviderAdapter, Message } from '../providers/v4/types';

export type HonestyMode = 'off' | 'detect' | 'enforce';

export interface HonestyFinding {
  /** The phrase from the response that triggered this finding. */
  claim: string;
  /** The tool(s) that should have fired for the claim to be honest. */
  expectedTool: string | string[];
  /** True = a matching tool fired (and verified, where required). */
  found: boolean;
  /** Per-finding confidence 0–1. Pattern matches are conservative (~0.8). */
  confidence: number;
  /** Why we flagged this — usually "no_tool_call" or
   *  "memory_verified_false". */
  reason?:
    | 'no_tool_call'
    | 'memory_verified_false'
    | 'tool_errored';
}

export interface HonestyResult {
  passed: boolean;
  findings: HonestyFinding[];
  /** Aggregate confidence — average of per-finding confidence. */
  confidence: number;
  originalResponse: string;
  /** Set when mode=enforce and at least one finding failed. */
  correctedResponse?: string;
}

/** Shape of a single tool-call entry in the trace inspected by Honesty. */
export interface HonestyTraceEntry {
  name: string;
  /** Tool result. Memory tools' result objects carry `verified: boolean`. */
  result: unknown;
  /** True when MemoryGuard verified the write. Honesty-critical. */
  verified?: boolean;
  /** Set when the tool errored (would never satisfy a positive claim). */
  error?: string;
  /**
   * v4.2 Phase 1 — per-tool verifier classification of this result.
   * Populated only when TCE is enabled (default ON as of v4.2
   * Phase 6; opt-out via `AIDEN_TCE=0`) and the verifier didn't throw.
   * Honesty itself does NOT consume this field; it's surfaced here so
   * downstream callers (chatSession, loopTrace, future RecoveryReport)
   * get the verification inline with the rest of the trace entry.
   *
   * Import-cycle note: declared as a structural type to avoid pulling
   * `core/v4/verifier` into a moat-layer module. Shape MUST stay in
   * lockstep with `VerificationResult` in core/v4/verifier.ts.
   */
  verification?: {
    ok:          boolean;
    confidence:  number;
    code:        'ok' | 'failed' | 'no_progress' | 'low_signal' | 'unknown';
    reason?:     string;
    suggestion?: string;
  };
  /**
   * v4.2 Phase 2 — failure classification (WHY the verifier said !ok).
   * Populated only when TCE is enabled (default ON; opt-out via
   * `AIDEN_TCE=0`) AND verification.ok === false.
   * Honesty itself does NOT consume this field; it surfaces here so
   * Phase 3's RecoveryReport can render structured guidance, and so
   * chatSession / loopTrace get a complete trace entry.
   *
   * Import-cycle note: declared structurally to avoid pulling
   * `core/v4/failureClassifier` into a moat-layer module. Shape MUST
   * stay in lockstep with `ClassificationResult` in
   * core/v4/failureClassifier.ts.
   */
  classification?: {
    // v4.3 Phase 5 added 'stale_ref' + 'manual_blocker'.
    // v4.4 Phase 5 added 'sandbox_violation'.
    // v4.5 Phase 5a added 'trigger_misconfigured' + 'trigger_quota'
    //                 + 'trigger_dead_lettered'.
    // Mirror stays in lockstep with `FailureCategory` in
    // core/v4/failureClassifier.ts.
    category:    'timeout' | 'auth' | 'hallucination' | 'network'
               | 'permission' | 'rate_limit' | 'invalid_input'
               | 'dependency_missing' | 'not_found'
               | 'stale_ref' | 'manual_blocker'
               | 'sandbox_violation'
               | 'trigger_misconfigured' | 'trigger_quota'
               | 'trigger_dead_lettered'
               | 'other';
    confidence:  number;
    reason?:     string;
    recoverable: boolean;
    recoveryHint?: {
      action: 'retry' | 'retry_with_backoff' | 'rotate_credential'
            | 'install_dependency' | 'request_user_action'
            | 'surface_to_user';
      detail?: string;
    };
    matchedPattern?: string;
  };
}

/**
 * Pattern table. Each entry maps a regex (looking for past-tense action
 * verbs in the response) to the tool name(s) that should be in the trace.
 *
 * Aliases: a single claim may map to MULTIPLE tools — e.g. "saved" could
 * be `file_write` or `file_patch` or `skill_manage` (creating a skill).
 * Honesty passes if ANY of the listed tools fired successfully.
 *
 * Negation: each claim is filtered through NEGATION_PREFIX_RE before
 * matching — "I couldn't save" / "I was unable to save" must NOT trigger.
 */
interface ClaimPattern {
  /**
   * Verb pattern. Use word boundaries; case-insensitive automatic.
   * MUST be in past tense — present/future tense is not a CLAIM of action.
   */
  pattern: RegExp;
  /** Tool name(s) that satisfy the claim. */
  tools: string[];
  /** Friendly label for findings. */
  label: string;
  /**
   * Special: 'memory' triggers the verified=true check on the matching
   * tool result. 'normal' = any non-error result satisfies.
   */
  kind?: 'memory' | 'normal';
}

/** Allows optional adverbs/auxiliaries between "I" and the verb:
 *  "I have", "I also", "I just", "I successfully", "I have just", etc. */
const I_PREFIX = String.raw`\bI\s+(?:have\s+|just\s+|also\s+|already\s+|successfully\s+|then\s+|now\s+){0,3}`;

const PATTERNS: ClaimPattern[] = [
  // ── File operations (past tense only) ─────────────────────────
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:saved|wrote|created|modified|patched|updated)\\b[^.]*\\b(?:file|to|at|in)\\b`,
      'i',
    ),
    tools: ['file_write', 'file_patch', 'skill_manage'],
    label: 'file_write',
  },
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:deleted|removed)\\s+(?:the\\s+)?(?:file|directory|folder)\\b`,
      'i',
    ),
    tools: ['file_delete'],
    label: 'file_delete',
  },
  // ── Web ────────────────────────────────────────────────────────
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:searched|looked\\s+up|found(?:\\s+online)?|googled)\\b`,
      'i',
    ),
    tools: ['web_search', 'deep_research'],
    label: 'web_search',
  },
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:fetched|downloaded|retrieved)\\b`,
      'i',
    ),
    tools: ['web_fetch', 'fetch_url'],
    label: 'web_fetch',
  },
  // ── Shell / execution ──────────────────────────────────────────
  {
    pattern: new RegExp(`${I_PREFIX}(?:ran|executed|called)\\b`, 'i'),
    tools: ['shell_exec', 'execute_code', 'run_python', 'run_node'],
    label: 'shell_exec',
  },
  // ── Browser ────────────────────────────────────────────────────
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:navigated|clicked|typed|scrolled)\\b`,
      'i',
    ),
    tools: [
      'browser_navigate',
      'open_browser',
      'browser_click',
      'browser_type',
      'browser_scroll',
    ],
    label: 'browser_action',
  },
  // ── Memory (verified=true required) ────────────────────────────
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:remembered|memori[sz]ed|noted\\s+that|saved\\s+that\\s+to\\s+memory)\\b`,
      'i',
    ),
    tools: ['memory_add', 'memory_upsert'],
    label: 'memory_add',
    kind: 'memory',
  },
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:forgot(?:ten)?|removed)\\b[^.]*\\bmemory\\b`,
      'i',
    ),
    tools: ['memory_remove', 'memory_forget'],
    label: 'memory_remove',
    kind: 'memory',
  },
  // ── Model switch ───────────────────────────────────────────────
  {
    pattern: new RegExp(
      `${I_PREFIX}(?:switched\\s+to|changed\\s+(?:to|model\\s+to)|am\\s+now\\s+using)\\s+\\S+`,
      'i',
    ),
    tools: ['model_switch'],
    label: 'model_switch',
  },
];

/** Negation patterns. If matched at the start of a sentence containing
 *  the claim, the claim is NOT flagged. */
const NEGATION_RE =
  /\b(?:couldn'?t|cannot|can'?t|wasn'?t\s+able|unable\s+to|failed\s+to|did\s+not|didn'?t|won'?t|will\s+not)\b/i;

export class HonestyEnforcement {
  private mode: HonestyMode;

  constructor(
    mode: HonestyMode = 'enforce',
    private readonly llmAdapter?: ProviderAdapter,
    private readonly logger?: (
      level: 'info' | 'warn',
      msg: string,
    ) => void,
  ) {
    this.mode = mode;
  }

  setMode(mode: HonestyMode): void {
    this.mode = mode;
  }

  getMode(): HonestyMode {
    return this.mode;
  }

  /**
   * Inspect a finished response against the actual tool-call trace.
   * Returns a structured result. Caller (AidenAgent) decides whether to
   * use `correctedResponse` or `originalResponse` based on `passed`.
   */
  async check(
    response: string,
    _messages: Message[],
    toolCallTrace: HonestyTraceEntry[],
  ): Promise<HonestyResult> {
    if (this.mode === 'off') {
      return {
        passed: true,
        findings: [],
        confidence: 1,
        originalResponse: response,
      };
    }

    if (!response || !response.trim()) {
      return {
        passed: true,
        findings: [],
        confidence: 1,
        originalResponse: response,
      };
    }

    const findings = this.detectClaimsPattern(response, toolCallTrace);

    const failed = findings.filter((f) => !f.found);
    const passed = failed.length === 0;
    const confidence =
      findings.length === 0
        ? 1
        : findings.reduce((s, f) => s + f.confidence, 0) /
          findings.length;

    if (this.mode === 'detect') {
      this.logger?.(
        'info',
        `[HonestyEnforcement] detect mode: ${findings.length} findings (${failed.length} failed)`,
      );
      return {
        passed,
        findings,
        confidence,
        originalResponse: response,
      };
    }

    // enforce mode
    let correctedResponse: string | undefined;
    if (!passed) {
      correctedResponse = this.buildCorrection(
        response,
        failed,
        toolCallTrace,
      );
      this.logger?.(
        'warn',
        `[HonestyEnforcement] enforce: rewrote response (${failed.length} failed claims)`,
      );
    }

    return {
      passed,
      findings,
      confidence,
      originalResponse: response,
      correctedResponse,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // pattern detection
  // ─────────────────────────────────────────────────────────────────────

  private detectClaimsPattern(
    response: string,
    trace: HonestyTraceEntry[],
  ): HonestyFinding[] {
    const findings: HonestyFinding[] = [];
    const sentences = splitSentences(response);

    for (const sentence of sentences) {
      // Skip negated sentences entirely.
      if (NEGATION_RE.test(sentence)) continue;

      for (const pat of PATTERNS) {
        if (!pat.pattern.test(sentence)) continue;

        const matched = sentence.match(pat.pattern);
        const claimText = matched?.[0] ?? sentence.trim();

        const found = this.traceSatisfies(pat, trace);
        let reason: HonestyFinding['reason'] | undefined;
        if (!found) {
          if (pat.kind === 'memory' && memoryFiredButUnverified(pat, trace)) {
            reason = 'memory_verified_false';
          } else if (toolFiredButErrored(pat, trace)) {
            reason = 'tool_errored';
          } else {
            reason = 'no_tool_call';
          }
        }

        findings.push({
          claim: claimText.trim(),
          expectedTool: pat.tools.length === 1 ? pat.tools[0] : pat.tools,
          found,
          confidence: 0.8,
          reason,
        });
      }
    }

    return findings;
  }

  private traceSatisfies(
    pat: ClaimPattern,
    trace: HonestyTraceEntry[],
  ): boolean {
    const matching = trace.filter(
      (t) => pat.tools.includes(t.name) && !t.error,
    );
    if (matching.length === 0) return false;
    if (pat.kind === 'memory') {
      // verified must be explicitly true
      return matching.some((m) => m.verified === true);
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────
  // correction builder
  // ─────────────────────────────────────────────────────────────────────

  private buildCorrection(
    _original: string,
    failed: HonestyFinding[],
    trace: HonestyTraceEntry[],
  ): string {
    const lines: string[] = [];
    lines.push(
      "I shouldn't claim actions I didn't take. Honest summary of what I actually did:",
    );
    lines.push('');
    if (trace.length === 0) {
      lines.push('- No tools were called this turn.');
    } else {
      for (const entry of trace) {
        const status = entry.error ? `errored (${entry.error})` : 'succeeded';
        const verified =
          entry.verified === false
            ? ' (NOT VERIFIED)'
            : entry.verified === true
              ? ' (verified)'
              : '';
        lines.push(`- ${entry.name}: ${status}${verified}`);
      }
    }
    lines.push('');
    lines.push('Refused claims:');
    for (const f of failed) {
      const tool = Array.isArray(f.expectedTool)
        ? f.expectedTool.join('/')
        : f.expectedTool;
      const why =
        f.reason === 'memory_verified_false'
          ? `(memory write returned verified=false — fact was not stored)`
          : f.reason === 'tool_errored'
            ? `(tool errored)`
            : `(no ${tool} call in trace)`;
      lines.push(`- "${f.claim}" ${why}`);
    }
    return lines.join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────
// helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  // Split on sentence terminators while keeping reasonable bounds.
  // Don't try to be clever about abbreviations — false positives are
  // benign (we just inspect more granular slices).
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function memoryFiredButUnverified(
  pat: ClaimPattern,
  trace: HonestyTraceEntry[],
): boolean {
  if (pat.kind !== 'memory') return false;
  return trace.some(
    (t) =>
      pat.tools.includes(t.name) && !t.error && t.verified === false,
  );
}

function toolFiredButErrored(
  pat: ClaimPattern,
  trace: HonestyTraceEntry[],
): boolean {
  return trace.some((t) => pat.tools.includes(t.name) && !!t.error);
}

export const __test__ = {
  splitSentences,
  PATTERNS,
  NEGATION_RE,
};
