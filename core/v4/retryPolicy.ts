/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/retryPolicy.ts — v4.13 Pillar 1, Gap 2.
 *
 * Failure-class → recovery-action POLICY. The runtime finally consumes
 * the classification it already produces (failureClassifier.ts): on a
 * classified tool failure the agent loop asks this module what to do
 * BEFORE the result returns to the model.
 *
 * Detector / policy separation (same shape as taskVerification.ts):
 * detectors = verifier + failureClassifier (untouched, they report);
 * THIS module decides. Pure — no I/O, no clocks, no env reads inside
 * `decideRecoveryAction` (config is resolved once per turn by the
 * caller via `resolveRetryPolicyConfig`).
 *
 * Design rules (locked):
 *
 *   - Retries are OBSERVABLE. The caller annotates the trace entry and
 *     the model-visible tool message with class + action + attempts —
 *     never silent plumbing.
 *   - A retry happens only when the next attempt would be MATERIALLY
 *     different: transient infra failure + backoff elapsed counts;
 *     repeating an identical attempt "because it might work" does not.
 *     Hence only transient classes (network / timeout / rate_limit)
 *     are runtime-retryable; everything else routes to the model or
 *     the user with an honest directive.
 *   - MUTATING tools are never runtime-retried, even on transient
 *     classes: a timed-out POST may have landed — re-firing it blind
 *     risks a double side effect. The failure surfaces with the class
 *     and the model (which can check state first) decides.
 *   - Permission/sandbox boundaries are never retried around.
 *   - The TurnState repeat ladder stays the OUTER circuit breaker:
 *     policy retries are recorded into its signature counters by the
 *     caller, so combined behavior can't exceed the ladder's stops.
 */

// ── Actions ─────────────────────────────────────────────────────────────

export type PolicyAction =
  | 'retry'               // immediate re-attempt (unused by defaults; kept for config)
  | 'retry_with_backoff'  // runtime re-attempt after backoffMs
  | 'give_up'             // stop attempting this call; structured what-was-tried
  | 'clarify'             // ask the user (once) instead of guessing
  | 'ask_permission'      // user action required; never retry around the boundary
  | 'surface';            // annotated failure back to the model, no runtime retry

export interface RecoveryActionDecision {
  action:     PolicyAction;
  /** Honest, human-readable rationale — annotated on the trace + tool message. */
  reason:     string;
  /** Present when action is retry/retry_with_backoff. */
  backoffMs?: number;
}

// ── Attempt-state view (owned by TurnState) ─────────────────────────────

/** Read-only view of the per-turn attempt state the policy consults. */
export interface RetryAttemptView {
  /** Runtime retries already spent on this failure class this turn. */
  attemptsForClass(category: string): number;
  /** Runtime retries spent across ALL classes this turn. */
  totalRetries(): number;
  /** One-shot repair flag (`<tool>:<category>`) — protocol repair-once. */
  hasRepairAttempted(key: string): boolean;
  /** One-shot clarify directive already issued this turn. */
  clarifyAdvised(): boolean;
}

// ── Config (layered budgets, env-tunable like the breaker) ─────────────

export interface PerClassRetryConfig {
  maxRetries:    number;
  baseBackoffMs: number;
}

export interface RetryPolicyConfig {
  /** Hard per-turn cap across every class — the layered outer budget. */
  maxTotalRetriesPerTurn: number;
  /** Exponential backoff ceiling. */
  backoffCapMs: number;
  perClass: Record<string, PerClassRetryConfig>;
}

/**
 * Defaults are conservative: one turn may spend at most 3 runtime
 * retries total; timeouts get a single expensive re-attempt; rate
 * limits back off hardest. Env overrides mirror the AIDEN_TCE tuning
 * style:
 *   AIDEN_RETRY_MAX_TOTAL   — per-turn total cap
 *   AIDEN_RETRY_NETWORK     — network max retries
 *   AIDEN_RETRY_TIMEOUT     — timeout max retries
 *   AIDEN_RETRY_RATE_LIMIT  — rate-limit max retries
 *   AIDEN_RETRY_OFF=1       — disable runtime retries entirely
 */
export function resolveRetryPolicyConfig(
  env: NodeJS.ProcessEnv = process.env,
): RetryPolicyConfig {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
  };
  const off = env.AIDEN_RETRY_OFF === '1';
  return {
    maxTotalRetriesPerTurn: off ? 0 : num(env.AIDEN_RETRY_MAX_TOTAL, 3),
    backoffCapMs: 8_000,
    perClass: {
      network:    { maxRetries: off ? 0 : num(env.AIDEN_RETRY_NETWORK, 2),    baseBackoffMs: 400 },
      timeout:    { maxRetries: off ? 0 : num(env.AIDEN_RETRY_TIMEOUT, 1),    baseBackoffMs: 1_000 },
      rate_limit: { maxRetries: off ? 0 : num(env.AIDEN_RETRY_RATE_LIMIT, 2), baseBackoffMs: 2_000 },
    },
  };
}

// ── The policy table ────────────────────────────────────────────────────

export interface DecideOpts {
  /** handler.mutates for the failing tool — mutating tools never runtime-retry. */
  toolMutates?: boolean;
}

export function decideRecoveryAction(
  category: string,
  toolName: string,
  state:    RetryAttemptView,
  cfg:      RetryPolicyConfig,
  opts:     DecideOpts = {},
): RecoveryActionDecision {
  switch (category) {
    // ── Transient infra — the only runtime-retryable classes ──────────
    case 'network':
    case 'timeout':
    case 'rate_limit': {
      if (opts.toolMutates === true) {
        return {
          action: 'surface',
          reason: `${category} failure on a MUTATING tool — not auto-retried (the attempt may have partially landed); verify state before re-trying`,
        };
      }
      const pc = cfg.perClass[category];
      if (!pc || pc.maxRetries <= 0) {
        return { action: 'surface', reason: `${category} failure — runtime retry disabled` };
      }
      const spentClass = state.attemptsForClass(category);
      const spentTotal = state.totalRetries();
      if (spentClass >= pc.maxRetries || spentTotal >= cfg.maxTotalRetriesPerTurn) {
        return {
          action: 'give_up',
          reason: `${category} retry budget exhausted (${spentClass}/${pc.maxRetries} class, ${spentTotal}/${cfg.maxTotalRetriesPerTurn} turn) — giving up on this call`,
        };
      }
      const backoffMs = Math.min(
        pc.baseBackoffMs * 2 ** spentClass,
        cfg.backoffCapMs,
      );
      return {
        action: 'retry_with_backoff',
        reason: `transient ${category} failure — retrying (attempt ${spentClass + 2}, backoff ${backoffMs}ms)`,
        backoffMs,
      };
    }

    // ── Protocol / schema — repair once, then stop ─────────────────────
    case 'invalid_input': {
      const key = `${toolName}:invalid_input`;
      if (!state.hasRepairAttempted(key)) {
        return {
          action: 'surface',
          reason: 'invalid input — repair the arguments per the tool schema and try ONCE with corrected args',
        };
      }
      return {
        action: 'give_up',
        reason: 'invalid input twice for this tool — the schema/argument invariant is broken; stop repeating and re-read the tool contract',
      };
    }

    // ── Tool execution — retry only if the next attempt differs ───────
    // The runtime can't change the args, so an identical re-fire is a
    // loop, not a retry. The model owns "different next attempt".
    case 'not_found':
      return { action: 'give_up', reason: 'target not found — an identical retry cannot succeed; check the path/name before any new attempt' };
    case 'dependency_missing':
      return { action: 'give_up', reason: 'dependency missing — install/provide the prerequisite first; retrying without it cannot succeed' };
    case 'hallucination':
      return { action: 'give_up', reason: 'the call referenced something that does not exist — do not repeat it' };

    // ── Permission / sandbox boundaries — NEVER retry around ──────────
    case 'permission':
    case 'sandbox_violation':
      return { action: 'ask_permission', reason: `${category === 'permission' ? 'permission' : 'sandbox policy'} boundary — never retried around; requires explicit permission or a policy change` };
    case 'auth':
      return { action: 'ask_permission', reason: 'credentials invalid or expired — user action required (rotate/re-auth); not retryable' };

    // ── Ambiguous intent / missing authority — clarify once ───────────
    case 'manual_blocker': {
      if (!state.clarifyAdvised()) {
        return { action: 'clarify', reason: 'blocked on a human step (login/2FA/captcha/consent) — ask the user rather than guessing' };
      }
      return { action: 'surface', reason: 'still blocked on a human step after asking — surfacing honestly' };
    }

    // ── Deferred to existing in-tool machinery ─────────────────────────
    case 'stale_ref':
      return { action: 'surface', reason: 'stale element reference — the browser layer already re-resolved and retried; no double-retry' };

    // ── Daemon/trigger config classes — operator problems ─────────────
    case 'trigger_misconfigured':
    case 'trigger_quota':
    case 'trigger_dead_lettered':
      return { action: 'surface', reason: `${category} — trigger configuration/quota issue; fix the trigger, not the call` };

    // ── Unknown — never retry what we can't name ───────────────────────
    case 'other':
    default:
      return { action: 'surface', reason: `unclassified failure (${category}) — not auto-retried` };
  }
}

/** One retry attempt, recorded on the trace entry (observable ledger). */
export interface RetryAttemptNote {
  attempt:   number;
  category:  string;
  reason?:   string;
  backoffMs: number;
}

/**
 * Model-visible annotation for the final tool message. Compact single
 * line; the model sees exactly what the runtime did and why.
 */
export function buildRetryAnnotation(
  notes: RetryAttemptNote[],
  finalDecision: RecoveryActionDecision | null,
  finalOk: boolean,
): string | null {
  if (notes.length === 0 && !finalDecision) return null;
  const parts: string[] = [];
  if (notes.length > 0) {
    const cats = [...new Set(notes.map((n) => n.category))].join(', ');
    parts.push(
      finalOk
        ? `runtime retried ${notes.length}x after ${cats}; succeeded on attempt ${notes.length + 1}`
        : `runtime retried ${notes.length}x after ${cats}; still failing`,
    );
  }
  if (!finalOk && finalDecision) {
    parts.push(`class action: ${finalDecision.action} — ${finalDecision.reason}`);
  }
  return parts.length > 0 ? `[recovery] ${parts.join(' | ')}` : null;
}
