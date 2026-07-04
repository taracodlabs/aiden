/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/failureClassifier.ts — v4.2 Phase 2: Tool-failure classifier.
 *
 * When Phase 1's verifier classifies a tool result as `!ok` (`failed`,
 * `low_signal`, or `no_progress`), this layer enriches the failure
 * with a structured WHY category. Categories drive Phase 3+'s recovery
 * strategies (retry / surface / install / etc.) — Phase 2 only RECORDS
 * the classification on the trace and TurnState diagnostics; no
 * recovery action fires here.
 *
 * Ten categories, matching the v4.2 spec:
 *
 *   timeout              — connection/read deadline exceeded
 *   auth                 — 401/403, invalid API key, unauthorized
 *   hallucination        — model invented a nonexistent entity (narrow
 *                          Phase 2 scope: file-not-found + verbatim
 *                          path match in args, confidence 0.6)
 *   network              — connection refused, DNS, unreachable
 *   permission           — local ACL ("Access denied"), refusing-to-act
 *   rate_limit           — 429, throttled, "try again in N"
 *   invalid_input        — missing required args, "No path provided",
 *                          "is required", "must be non-empty"
 *   dependency_missing   — binary not in PATH, "command not found",
 *                          "not configured", process registry missing
 *   not_found            — file not found, ENOENT (read tools), no
 *                          such directory
 *   other                — catch-all (renamed from "unknown" to match
 *                          the v4.2 spec exactly)
 *
 * Priority-ordered pipeline (mirrors a layered failure-pattern approach
 * used by a reference system, adapted for Aiden's tool-output domain):
 *
 *   1. Per-tool override (registered by toolName) — runs first; can
 *      short-circuit when a tool has a high-signal failure shape.
 *   2. Outer envelope + verifier reason inspection — substring scan
 *      against priority-ordered pattern tables.
 *   3. Hallucination heuristic (narrow): file-tool not_found AND args
 *      contain the path verbatim → escalate not_found to hallucination.
 *   4. Fallback: `other` at confidence 0.3.
 *
 * Skips entirely when `verification.ok === true` — saves cycles on
 * successful calls.
 *
 * Gated by the same TCE flag as Phase 1 verifier + TurnState (default
 * ON as of v4.2 Phase 6; opt-out via `AIDEN_TCE=0`). When disabled,
 * the classifier is never invoked from the agent loop.
 */

import type { ToolCallResult } from '../../providers/v4/types';
import type { VerificationResult } from './verifier';
import { readAuthRequired } from './mcp/authRequired';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Twelve failure categories.
 *
 * The first ten are v4.2 Phase 2 — generic tool-call failure modes.
 * The last two are v4.3 Phase 5 — browser-specific failure modes
 * that can only be detected when state-aware browser depth is
 * enabled (default ON; opt-out via AIDEN_BROWSER_DEPTH=0) and surfaces
 * `result.browserState.staleRefRetry` / `.blocker` sidecars.
 *
 * Generic categories continue to route via `defaultClassifier` for
 * non-browser tools. Browser categories route via
 * `browserInteractiveClassifier` / `browserNavigateClassifier`
 * (registered for the 4 browser tools where they apply).
 */
export type FailureCategory =
  | 'timeout'
  | 'auth'
  | 'hallucination'
  | 'network'
  | 'permission'
  | 'rate_limit'
  | 'invalid_input'
  | 'dependency_missing'
  | 'not_found'
  | 'stale_ref'              // v4.3 Phase 5 — DOM changed between snapshot+action; Phase 2 already retried unsuccessfully
  | 'manual_blocker'         // v4.3 Phase 5 — login/2FA/captcha/verification/consent (Phase 3); needs human action
  | 'sandbox_violation'      // v4.4 Phase 5 — Phase 2 fs.* policy refusal OR Phase 3 docker-start failure; not retryable, needs env-var override
  | 'trigger_misconfigured'  // v4.5 Phase 5a — trigger spec invalid (prompt template missing vars, payload incomplete)
  | 'trigger_quota'          // v4.5 Phase 5a — per-trigger fire-rate cap exceeded (producer-side anti-thrash)
  | 'trigger_dead_lettered'  // v4.5 Phase 5a — max retries exhausted; trigger event moved to dead_letter queue
  | 'other';

/** Output of `classify(...)`. */
export interface ClassificationResult {
  category:    FailureCategory;
  /** 0.0–1.0 — same scale as VerificationResult.confidence. */
  confidence:  number;
  /** Short human-readable reason (≤ 80 chars). */
  reason?:     string;
  /** Can the agent automatically retry/recover? Drives Phase 3 hints. */
  recoverable: boolean;
  /** Optional structured guidance; Phase 3 wires the actions. */
  recoveryHint?: {
    action: 'retry'
          | 'retry_with_backoff'
          | 'rotate_credential'
          | 'install_dependency'
          | 'request_user_action'
          | 'surface_to_user';
    detail?: string;
  };
  /** Substring/pattern that matched — useful for diagnostics + tests. */
  matchedPattern?: string;
  /**
   * v4.4 Phase 5 — populated by `sandboxViolationClassifier` with
   * the raw envelope fields from the tool result. Used by
   * `buildRecoveryReport` to build `sandboxContext` without
   * re-parsing tool result envelopes. Absent for all other
   * classifications.
   */
  sandboxViolation?: {
    code:          string;
    matchedPolicy: string;
    requestedPath: string;
    resolvedPath:  string;
  };
}

/**
 * Pure function signature. Receives the verifier's classification +
 * the original call args + raw result. Synchronous; no side effects.
 */
export type ClassifierFn = (
  verification: VerificationResult,
  toolName:     string,
  args:         unknown,
  result:       ToolCallResult,
) => ClassificationResult;

/**
 * Per-tool override registry + fallback resolver. Symmetric with
 * Phase 1's VerifierRegistry.
 */
export class FailureClassifier {
  private readonly overrides: Map<string, ClassifierFn> = new Map();
  private readonly fallback:  ClassifierFn;

  constructor(fallback: ClassifierFn = defaultClassifier) {
    this.fallback = fallback;
  }

  register(toolName: string, fn: ClassifierFn): void {
    this.overrides.set(toolName, fn);
  }

  resolve(toolName: string): ClassifierFn {
    return this.overrides.get(toolName) ?? this.fallback;
  }

  hasOverride(toolName: string): boolean {
    return this.overrides.has(toolName);
  }

  /**
   * Entry point used by the agent loop. Returns null for verifier-ok
   * results — zero overhead in the happy path.
   */
  classify(
    verification: VerificationResult,
    toolName:     string,
    args:         unknown,
    result:       ToolCallResult,
  ): ClassificationResult | null {
    if (verification.ok) return null;
    // v4.14 — GLOBAL pre-check: a typed `auth_required` envelope (from ANY tool,
    // e.g. an MCP call whose token died and couldn't refresh) is an auth wall.
    // Classify it as NON-RECOVERABLE auth so recovery never blind-retries it —
    // this is the anti-fake-success guarantee, robust where the substring auth
    // patterns below are not (the old raw "needs re-authorization" string
    // matched none of them and fell through to `other`/recoverable).
    const authEnv = readAuthRequired(result);
    if (authEnv) {
      return {
        category:    'auth',
        confidence:  0.99,
        reason:      `needs reauth for ${authEnv.provider}`,
        recoverable: false,
        recoveryHint: { action: 'request_user_action', detail: authEnv.reauth_hint || `re-authorize ${authEnv.provider}` },
        matchedPattern: 'auth_required',
      };
    }
    return this.resolve(toolName)(verification, toolName, args, result);
  }
}

// ── Pattern tables (priority-ordered) ──────────────────────────────────────

/** Timeout signals — checked first because they're high-confidence. */
const TIMEOUT_PATTERNS: ReadonlyArray<string> = [
  'timeout', 'timed out', 'etimedout',
  'deadline exceeded', 'deadline_exceeded',
  'read timed out', 'connect timeout', 'connection timeout',
];

/** Rate-limit signals — distinct from auth/billing for now. */
const RATE_LIMIT_PATTERNS: ReadonlyArray<string> = [
  'rate limit', 'rate_limit', 'rate-limit',
  'too many requests', '429', 'throttled', 'throttling',
  'try again in', 'please retry after',
  'requests per minute', 'tokens per minute',
  'quota exceeded',
];

/** Auth signals — provider credential failures. */
const AUTH_PATTERNS: ReadonlyArray<string> = [
  '401', '403',
  'unauthorized', 'unauthorised',
  'invalid api key', 'invalid_api_key',
  'authentication failed', 'authentication required',
  'invalid token', 'token expired', 'token revoked',
  'forbidden',
];

/** Network signals — pre-HTTP failures. */
const NETWORK_PATTERNS: ReadonlyArray<string> = [
  'econnrefused', 'enetunreach', 'enotfound', 'eai_again',
  'dns lookup', 'getaddrinfo',
  'connection refused', 'network unreachable',
  'host not found', 'no such host',
];

/** Permission signals — local ACL + refusing-to-act. */
const PERMISSION_PATTERNS: ReadonlyArray<string> = [
  'eacces', 'eperm',
  'access denied', 'permission denied',
  'refusing to', 'protected path',
  'forbidden path', 'restricted path',
];

/** Invalid-input signals — missing/malformed args. */
const INVALID_INPUT_PATTERNS: ReadonlyArray<string> = [
  'no path provided', 'no query provided', 'no command provided',
  'no url provided', 'no id provided', 'no topic provided',
  'is required', 'are required',
  'must be a string', 'must be non-empty',
  'invalid argument', 'malformed',
  'both from and to required', 'empty find string',
];

/** Dependency-missing signals — missing binary / unset env / unconfigured. */
const DEPENDENCY_MISSING_PATTERNS: ReadonlyArray<string> = [
  'command not found',
  'not in path', 'not on path',
  'is not recognized as',           // Windows shell wording
  'no such command',
  'not configured',
  'is not configured',
  'registry not configured',
  'paths not wired',
  'needs aiden',
];

/** Not-found signals (file/resource, distinct from dep-missing). */
const NOT_FOUND_PATTERNS: ReadonlyArray<string> = [
  'enoent',
  'no such file',
  'no such directory',
  'file not found',
  'does not exist',
  'not found',          // general — checked after dep-missing so it doesn't shadow
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a lowercased haystack from all error sources the classifier
 * can inspect. Mirrors the reference's multi-source extraction so
 * patterns embedded in different envelope shapes still match.
 */
function buildHaystack(
  verification: VerificationResult,
  result:       ToolCallResult,
): string {
  const parts: string[] = [];
  if (verification.reason) parts.push(verification.reason);
  if (result.error)        parts.push(result.error);
  const inner = result.result;
  if (typeof inner === 'string') {
    parts.push(inner.slice(0, 500));
  } else if (inner !== null && typeof inner === 'object') {
    const obj = inner as Record<string, unknown>;
    if (typeof obj.error  === 'string') parts.push(obj.error);
    if (typeof obj.stderr === 'string') parts.push(obj.stderr.slice(0, 500));
    if (typeof obj.message === 'string') parts.push(obj.message);
  }
  return parts.join(' ').toLowerCase();
}

/** First pattern in `list` that's contained in `haystack`, else undefined. */
function matchAny(
  haystack: string,
  list:     ReadonlyArray<string>,
): string | undefined {
  for (const p of list) {
    if (haystack.includes(p)) return p;
  }
  return undefined;
}

// ── Default classifier ─────────────────────────────────────────────────────

/**
 * Heuristic default. Priority order:
 *   1. timeout
 *   2. rate_limit
 *   3. auth
 *   4. network
 *   5. permission
 *   6. invalid_input
 *   7. dependency_missing  (BEFORE not_found — "command not found" → dep, not not_found)
 *   8. not_found
 *   9. hallucination (narrow: only when not_found matched AND args contain path verbatim)
 *  10. other (fallback)
 */
export const defaultClassifier: ClassifierFn = (
  verification: VerificationResult,
  toolName:     string,
  args:         unknown,
  result:       ToolCallResult,
): ClassificationResult => {
  const hay = buildHaystack(verification, result);

  // 1. timeout — high signal, often standalone
  const tMatch = matchAny(hay, TIMEOUT_PATTERNS);
  if (tMatch) {
    return {
      category:    'timeout',
      confidence:  0.9,
      reason:      'tool call exceeded its deadline',
      recoverable: true,
      recoveryHint: { action: 'retry_with_backoff' },
      matchedPattern: tMatch,
    };
  }

  // 2. rate_limit
  const rMatch = matchAny(hay, RATE_LIMIT_PATTERNS);
  if (rMatch) {
    return {
      category:    'rate_limit',
      confidence:  0.9,
      reason:      'rate-limited by upstream',
      recoverable: true,
      recoveryHint: { action: 'retry_with_backoff' },
      matchedPattern: rMatch,
    };
  }

  // 3. auth
  const aMatch = matchAny(hay, AUTH_PATTERNS);
  if (aMatch) {
    return {
      category:    'auth',
      confidence:  0.9,
      reason:      'authentication failed or credential missing',
      recoverable: false,
      recoveryHint: { action: 'request_user_action', detail: 'check credentials' },
      matchedPattern: aMatch,
    };
  }

  // 4. network
  const nMatch = matchAny(hay, NETWORK_PATTERNS);
  if (nMatch) {
    return {
      category:    'network',
      confidence:  0.85,
      reason:      'network unreachable or DNS failure',
      recoverable: true,
      recoveryHint: { action: 'retry_with_backoff' },
      matchedPattern: nMatch,
    };
  }

  // 5. permission
  const pMatch = matchAny(hay, PERMISSION_PATTERNS);
  if (pMatch) {
    return {
      category:    'permission',
      confidence:  0.9,
      reason:      'permission denied or refused by safety policy',
      recoverable: false,
      recoveryHint: { action: 'surface_to_user' },
      matchedPattern: pMatch,
    };
  }

  // 6. invalid_input
  const iMatch = matchAny(hay, INVALID_INPUT_PATTERNS);
  if (iMatch) {
    return {
      category:    'invalid_input',
      confidence:  0.8,
      reason:      'tool call arguments missing or malformed',
      recoverable: true,
      recoveryHint: { action: 'retry', detail: 'fix the arguments and try again' },
      matchedPattern: iMatch,
    };
  }

  // 7. dependency_missing (BEFORE not_found — "command not found" is more
  //    specific than a generic "not found")
  const dMatch = matchAny(hay, DEPENDENCY_MISSING_PATTERNS);
  if (dMatch) {
    return {
      category:    'dependency_missing',
      confidence:  0.85,
      reason:      'required binary or runtime resource is missing',
      recoverable: false,
      recoveryHint: { action: 'install_dependency' },
      matchedPattern: dMatch,
    };
  }

  // 8. not_found (and 9. hallucination promotion)
  const nfMatch = matchAny(hay, NOT_FOUND_PATTERNS);
  if (nfMatch) {
    // 9. Hallucination heuristic — narrow per Q-C2(a): only file-read /
    //    file-list family AND the not-found path appears verbatim in
    //    args (model invented a path that doesn't exist).
    if (isFileReadFamily(toolName) && argsContainPathVerbatim(args, hay)) {
      return {
        category:    'hallucination',
        confidence:  0.6,
        reason:      'tool called with a path that does not exist on disk',
        recoverable: true,
        recoveryHint: {
          action: 'retry',
          detail: 'the path the model used does not exist — re-check before retrying',
        },
        matchedPattern: nfMatch,
      };
    }
    return {
      category:    'not_found',
      confidence:  0.85,
      reason:      'target resource was not found',
      recoverable: true,
      recoveryHint: { action: 'retry', detail: 'check the path/name and try again' },
      matchedPattern: nfMatch,
    };
  }

  // 10. fallback
  return {
    category:    'other',
    confidence:  0.3,
    reason:      'unclassified failure',
    recoverable: true,
    recoveryHint: { action: 'retry_with_backoff' },
  };
};

// ── Hallucination heuristic helpers ─────────────────────────────────────────

/** File-read family — tools where a missing path strongly suggests hallucination. */
function isFileReadFamily(toolName: string): boolean {
  return (
    toolName === 'file_read' ||
    toolName === 'file_list' ||
    toolName === 'file_patch'
  );
}

/**
 * Heuristic: does `args` contain a non-trivial path value that's
 * mentioned in the haystack (i.e. the failed-path string the model
 * just used)? Length filter avoids matching common short tokens.
 */
function argsContainPathVerbatim(args: unknown, hay: string): boolean {
  if (args === null || typeof args !== 'object') return false;
  const obj = args as Record<string, unknown>;
  const candidates: string[] = [];
  for (const k of ['path', 'file', 'from', 'to', 'target']) {
    const v = obj[k];
    if (typeof v === 'string' && v.length >= 4) candidates.push(v.toLowerCase());
  }
  for (const c of candidates) {
    if (hay.includes(c)) return true;
  }
  return false;
}

// ── Per-tool classifiers ───────────────────────────────────────────────────

/**
 * `shell_exec` — inspect exitCode + stderr for canonical UNIX
 * convention codes:
 *   - 124 = timeout (GNU coreutils `timeout` command)
 *   - 126 = permission (executable but cannot be invoked)
 *   - 127 = dependency_missing (command not found)
 *   - 130 = SIGINT (treat as recoverable other)
 */
export const shellExecClassifier: ClassifierFn = (verification, toolName, args, result) => {
  const inner = result.result as Record<string, unknown> | null;
  const exitCode = (inner && typeof inner.exitCode === 'number') ? inner.exitCode : undefined;
  const stderr   = (inner && typeof inner.stderr   === 'string') ? inner.stderr   : '';

  // Canonical UNIX exit codes — high confidence when the code is set.
  if (exitCode === 124) {
    return {
      category: 'timeout', confidence: 0.95,
      reason: 'shell command timed out (exit 124)',
      recoverable: true,
      recoveryHint: { action: 'retry_with_backoff', detail: 'consider raising timeoutMs' },
      matchedPattern: 'exit 124',
    };
  }
  if (exitCode === 126) {
    return {
      category: 'permission', confidence: 0.95,
      reason: 'shell command cannot be invoked (exit 126)',
      recoverable: false,
      recoveryHint: { action: 'surface_to_user' },
      matchedPattern: 'exit 126',
    };
  }
  if (exitCode === 127) {
    return {
      category: 'dependency_missing', confidence: 0.95,
      reason: 'shell command not found (exit 127)',
      recoverable: false,
      recoveryHint: { action: 'install_dependency' },
      matchedPattern: 'exit 127',
    };
  }

  // Stderr-aware fallback — same priority pipeline as default but
  // weighted toward stderr substrings rather than verification.reason.
  return defaultClassifier(verification, toolName, args, result);
};

/**
 * `web_search` — same default pipeline but with stronger network
 * priority since search failures cascade from upstream HTTP.
 */
export const webSearchClassifier: ClassifierFn = (verification, toolName, args, result) => {
  return defaultClassifier(verification, toolName, args, result);
};

/** `web_fetch` (+ aliases) — same defaults; behaviour symmetric with web_search. */
export const webFetchClassifier: ClassifierFn = (verification, toolName, args, result) => {
  return defaultClassifier(verification, toolName, args, result);
};

/**
 * `file_read` — verifier already filtered the easy cases; this
 * override exists to RUN the hallucination heuristic on read-family
 * failures with stronger weighting. Default classifier already
 * implements that path; this wrapper exists so callers can intercept
 * file_read classification specifically (e.g. plugin extensions).
 */
export const fileReadClassifier: ClassifierFn = (verification, toolName, args, result) => {
  return defaultClassifier(verification, toolName, args, result);
};

// ── v4.3 Phase 5 — Browser-tool classifiers ────────────────────────────────

/**
 * Minimal structural shape of `result.result.browserState` — mirrors
 * `ActionResult` in `core/v4/browserState.ts`. Declared structurally
 * here to keep this module import-cycle-free (classifier shouldn't
 * depend on browserState, which depends on Phase 5's enum extension).
 *
 * Shape MUST stay in lockstep with `ActionResult` — when fields are
 * added there, update this mirror too.
 */
interface BrowserStateSidecar {
  pre_state:      unknown;
  post_state:     unknown;
  progress_score: number;
  evidence:       string[];
  maybe_noop:     boolean;
  needs_verifier: boolean;
  staleRefRetry?: {
    attempted:   true;
    succeeded:   boolean;
    reason:      string;
    state_delta: string[];
  };
  blocker?: {
    kind:       'captcha' | 'login' | '2fa' | 'verification' | 'consent';
    subtype?:   string;
    url:        string;
    confidence: number;
    evidence:   string[];
    message:    string;
  };
}

/** Extract the v4.3 sidecar from a tool result, defensively. */
function readBrowserStateSidecar(result: ToolCallResult): BrowserStateSidecar | null {
  if (!result.result || typeof result.result !== 'object') return null;
  const r = result.result as { browserState?: BrowserStateSidecar };
  return r.browserState ?? null;
}

/**
 * Classifier for the 3 interactive browser tools (browser_click,
 * browser_type, browser_fill). Priority:
 *
 *   1. blocker present       → manual_blocker (conf 0.95)
 *   2. staleRefRetry failed  → stale_ref      (conf 0.9)
 *   3. needs_verifier + low progress → stale_ref (conf 0.75)
 *   4. fall through to defaultClassifier for generic patterns
 *
 * `manual_blocker` beats `stale_ref` because no retry can fix a
 * login wall — the user has to act. Phase 6+ will surface this via
 * the recovery card already wired by Phase 3.
 */
export const browserInteractiveClassifier: ClassifierFn = (verification, toolName, args, result) => {
  const bs = readBrowserStateSidecar(result);

  // Priority 1 — manual blocker.
  if (bs?.blocker) {
    return {
      category:    'manual_blocker',
      confidence:  0.95,
      reason:      `${bs.blocker.kind}${bs.blocker.subtype ? ` (${bs.blocker.subtype})` : ''} at ${bs.blocker.url}`,
      recoverable: false,
      recoveryHint: { action: 'request_user_action', detail: bs.blocker.message },
      matchedPattern: `browserState.blocker.${bs.blocker.kind}`,
    };
  }

  // Priority 2 — Phase 2 already retried and the retry failed.
  if (bs?.staleRefRetry?.attempted && !bs.staleRefRetry.succeeded) {
    return {
      category:    'stale_ref',
      confidence:  0.9,
      reason:      `stale ref after auto-retry: ${bs.staleRefRetry.reason}`,
      recoverable: true,
      recoveryHint: {
        action: 'retry',
        detail: 'wait for page to settle, then re-select the element',
      },
      matchedPattern: 'browserState.staleRefRetry.failed',
    };
  }

  // Priority 3 — Phase 1 verifier flagged "no UI change despite success".
  // Surface as stale_ref because the recovery shape is the same: the
  // page didn't respond, model should re-read state before trying again.
  if (bs && (bs.maybe_noop || (bs.needs_verifier && bs.progress_score < 0.3))) {
    return {
      category:    'stale_ref',
      confidence:  0.75,
      reason:      `tool returned success but page did not change (progress_score=${bs.progress_score.toFixed(2)})`,
      recoverable: true,
      recoveryHint: {
        action: 'retry',
        detail: 'verify the page state then try a different approach',
      },
      matchedPattern: 'browserState.no_progress',
    };
  }

  // Fall through to default for generic patterns.
  return defaultClassifier(verification, toolName, args, result);
};

/**
 * Classifier for `browser_navigate`. Only checks for `blocker` —
 * Phase 2's stale-ref retry doesn't fire on navigate (excluded from
 * STALE_REF_RETRYABLE), so the stale_ref path is irrelevant here.
 */
export const browserNavigateClassifier: ClassifierFn = (verification, toolName, args, result) => {
  const bs = readBrowserStateSidecar(result);
  if (bs?.blocker) {
    return {
      category:    'manual_blocker',
      confidence:  0.95,
      reason:      `${bs.blocker.kind}${bs.blocker.subtype ? ` (${bs.blocker.subtype})` : ''} at ${bs.blocker.url}`,
      recoverable: false,
      recoveryHint: { action: 'request_user_action', detail: bs.blocker.message },
      matchedPattern: `browserState.blocker.${bs.blocker.kind}`,
    };
  }
  return defaultClassifier(verification, toolName, args, result);
};

// ── v4.4 Phase 5 — sandbox classifier ──────────────────────────────────────

/** Shape of the violation envelope produced by Phase 2 file tools. */
interface SandboxViolationEnvelope {
  code:           string;
  matched_policy: string;
  requested_path: string;
  resolved_path:  string;
  retryable:      false;
  category:       'sandbox_violation';
}

/**
 * Read the `sandbox_violation` envelope from a tool result. Returns
 * null when absent or malformed.
 *
 * Phase 2 file tools attach this on `result.result.sandbox_violation`
 * alongside `success: false`. Phase 3's shell-exec docker-start
 * failure surfaces a different shape — handled separately below.
 */
function readSandboxViolation(result: ToolCallResult): SandboxViolationEnvelope | null {
  const inner = result.result;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  const env = (inner as { sandbox_violation?: unknown }).sandbox_violation;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const e = env as Record<string, unknown>;
  if (e.category !== 'sandbox_violation') return null;
  if (typeof e.code !== 'string') return null;
  return {
    code:           e.code,
    matched_policy: typeof e.matched_policy === 'string' ? e.matched_policy : '',
    requested_path: typeof e.requested_path === 'string' ? e.requested_path : '',
    resolved_path:  typeof e.resolved_path  === 'string' ? e.resolved_path  : '',
    retryable:      false,
    category:       'sandbox_violation',
  };
}

/**
 * Produce a concrete, user-actionable override suggestion from a
 * violation envelope. Code-specific because the action differs: a
 * write-outside-allowlist needs an `AIDEN_SANDBOX_ALLOW=...` extension,
 * a denylist hit cannot be overridden, a symlink-escape needs the
 * real path used directly.
 */
function suggestOverride(env: SandboxViolationEnvelope): string {
  switch (env.code) {
    case 'fs.write_outside_allowlist': {
      // The requested path is the agent-supplied string; the resolved
      // path is the real path. Suggest the directory that contains it
      // — most likely what the user wants to allowlist.
      const target = env.resolved_path || env.requested_path;
      const lastSep = target.lastIndexOf('/') >= 0
        ? target.lastIndexOf('/')
        : target.lastIndexOf('\\');
      const dir = lastSep > 0 ? target.slice(0, lastSep) : target;
      return dir
        ? `Add to allowlist: AIDEN_SANDBOX_ALLOW=${dir}`
        : 'Add the target directory to AIDEN_SANDBOX_ALLOW';
    }
    case 'fs.sensitive_path':
      return `Sandbox refuses ${env.matched_policy || env.resolved_path} for safety. ` +
             'This path is on the denylist and cannot be allowlisted. ' +
             'Use a different path, or set AIDEN_SANDBOX=0 to disable the sandbox entirely (not recommended).';
    case 'fs.symlink_escape':
      return 'The path contains a symlink that resolves outside the sandbox. ' +
             'Use the real path directly, or extend AIDEN_SANDBOX_ALLOW to cover the symlink target.';
    case 'fs.path_traversal':
      return 'Path contains `..` segments that escape the working directory. Use an absolute path.';
    case 'fs.read_denied':
      return `Sandbox refuses read of ${env.matched_policy || env.resolved_path}.`;
    default:
      return env.matched_policy
        ? `Sandbox blocked by policy: ${env.matched_policy}`
        : 'Sandbox blocked this operation.';
  }
}

/**
 * Unified classifier for tools that go through the v4.4 sandbox
 * preflight: 5 write-side file tools + 2 read-side file tools +
 * shell_exec. Detects:
 *   1. The Phase 2 `sandbox_violation` envelope (file tools, all
 *      five fs.* codes)
 *   2. Phase 3 docker-start failure surfaced via shell_exec's
 *      "Sandbox: failed to start container" stderr — categorized as
 *      sandbox_violation with the install_dependency recovery hint
 *
 * Sandbox refusals are NEVER retryable (retryable:false) — the
 * policy will reject the same input next call. The agent should
 * surface the suggested env-var override to the user instead.
 *
 * Falls through to `defaultClassifier` (or a wrapped per-tool
 * classifier) when no sandbox envelope is present — keeping the
 * non-sandboxed path zero-cost.
 */
export const sandboxViolationClassifier: ClassifierFn = (verification, toolName, args, result) => {
  const env = readSandboxViolation(result);
  if (env) {
    return {
      category:    'sandbox_violation',
      confidence:  0.95,
      reason:      `${env.code}${env.matched_policy ? ` matched ${env.matched_policy}` : ''}`,
      recoverable: false,
      recoveryHint: {
        action: 'request_user_action',
        detail: suggestOverride(env),
      },
      matchedPattern: env.code,
      sandboxViolation: {
        code:          env.code,
        matchedPolicy: env.matched_policy,
        requestedPath: env.requested_path,
        resolvedPath:  env.resolved_path,
      },
    };
  }
  // Phase 3 docker-start failure path (shell_exec only).
  if (toolName === 'shell_exec') {
    const r = result.result;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const stderr = (r as { stderr?: unknown }).stderr;
      if (typeof stderr === 'string' && /Sandbox: failed to start container/.test(stderr)) {
        return {
          category:    'sandbox_violation',
          confidence:  0.9,
          reason:      'docker container failed to start',
          recoverable: true,
          recoveryHint: {
            action: 'install_dependency',
            detail: 'Start Docker and retry, or set AIDEN_SANDBOX=0 to disable the sandbox.',
          },
          matchedPattern: 'docker_unavailable',
        };
      }
    }
  }
  return defaultClassifier(verification, toolName, args, result);
};

/**
 * Wraps `shellExecClassifier` so the sandbox envelope check fires
 * BEFORE the existing dangerous-pattern / exit-code logic. Sandbox
 * refusal beats every other shell-exec failure mode — the policy
 * was the proximate cause and the actionable fix.
 */
export const shellExecClassifierWithSandbox: ClassifierFn = (verification, toolName, args, result) => {
  const sb = sandboxViolationClassifier(verification, toolName, args, result);
  if (sb.category === 'sandbox_violation') return sb;
  return shellExecClassifier(verification, toolName, args, result);
};

/**
 * Wraps `fileReadClassifier` so denylist hits on read are categorized
 * as sandbox_violation instead of the generic "not_found / permission"
 * default. file_read is the only read-side tool with an existing
 * override; file_list falls through to the unified classifier.
 */
export const fileReadClassifierWithSandbox: ClassifierFn = (verification, toolName, args, result) => {
  const sb = sandboxViolationClassifier(verification, toolName, args, result);
  if (sb.category === 'sandbox_violation') return sb;
  return fileReadClassifier(verification, toolName, args, result);
};

// ── v4.5 Phase 5a — trigger-dispatcher classifier ──────────────────────────

/**
 * Synthetic "tool name" the daemon dispatcher uses when a turn
 * failed for a daemon-trigger-specific reason (template missing
 * vars, fire-rate cap exceeded, max retries exhausted). The
 * dispatcher constructs a `ToolCallResult` envelope with this
 * name + a reason string in `error`; the classifier inspects the
 * substring tag to pick the right category.
 *
 * Tags are emitted by `core/v4/daemon/dispatcher/dispatcher.ts`
 * and `triggerBus.markFailed` / `deadLetter` flows.
 */
export const DAEMON_DISPATCHER_TOOL_NAME = 'daemon:dispatcher';

const TRIGGER_MISCONFIGURED_TAG = 'trigger_misconfigured';
const TRIGGER_QUOTA_TAG         = 'trigger_quota';
const TRIGGER_DEAD_LETTERED_TAG = 'trigger_dead_lettered';

/**
 * Classifier for the synthetic `daemon:dispatcher` tool. Reads the
 * envelope's `error` / verification reason for one of the three
 * trigger-failure tags and returns the matching category. Falls
 * through to `defaultClassifier` if no tag matched (defensive —
 * the dispatcher always sets one).
 *
 * Recovery hints:
 *   - trigger_misconfigured  → request_user_action (fix spec)
 *   - trigger_quota          → request_user_action (raise cap or fix producer)
 *   - trigger_dead_lettered  → request_user_action (inspect last_error, reset event)
 */
export const triggerDispatcherClassifier: ClassifierFn = (verification, toolName, args, result) => {
  const hay = (
    (verification.reason ?? '') + ' ' +
    (result.error ?? '') + ' ' +
    (typeof result.result === 'string' ? result.result : '')
  ).toLowerCase();

  if (hay.includes(TRIGGER_MISCONFIGURED_TAG)) {
    return {
      category:    'trigger_misconfigured',
      confidence:  0.95,
      reason:      'trigger spec invalid or template variables missing',
      recoverable: false,
      recoveryHint: {
        action: 'request_user_action',
        detail: 'inspect the trigger spec and ensure all template variables are populated by the payload',
      },
      matchedPattern: TRIGGER_MISCONFIGURED_TAG,
    };
  }
  if (hay.includes(TRIGGER_QUOTA_TAG)) {
    return {
      category:    'trigger_quota',
      confidence:  0.95,
      reason:      'per-trigger fire-rate cap exceeded',
      recoverable: false,
      recoveryHint: {
        action: 'request_user_action',
        detail: 'investigate the upstream producer or raise the trigger\'s fire-rate limit',
      },
      matchedPattern: TRIGGER_QUOTA_TAG,
    };
  }
  if (hay.includes(TRIGGER_DEAD_LETTERED_TAG)) {
    return {
      category:    'trigger_dead_lettered',
      confidence:  0.95,
      reason:      'trigger event exhausted max retries and moved to dead letter',
      recoverable: false,
      recoveryHint: {
        action: 'request_user_action',
        detail: 'review the last_error on the dead-lettered trigger event and re-queue if appropriate',
      },
      matchedPattern: TRIGGER_DEAD_LETTERED_TAG,
    };
  }
  return defaultClassifier(verification, toolName, args, result);
};

// ── Factory ────────────────────────────────────────────────────────────────

export function buildDefaultClassifier(): FailureClassifier {
  const reg = new FailureClassifier();
  // v4.4 Phase 5 — sandbox envelope check fires first for shell_exec
  // + the file tools. Falls through to the existing per-tool
  // classifier when no envelope is present (AIDEN_SANDBOX=0 → no
  // envelopes → zero-cost passthrough).
  reg.register('shell_exec', shellExecClassifierWithSandbox);
  reg.register('web_search', webSearchClassifier);
  reg.register('web_fetch',  webFetchClassifier);
  reg.register('fetch_page', webFetchClassifier);
  reg.register('web_page',   webFetchClassifier);
  reg.register('file_read',  fileReadClassifierWithSandbox);
  // v4.4 Phase 5 — sandbox-aware classifiers for the file tools that
  // didn't previously have overrides. Use the unified classifier
  // directly since none of them have prior bespoke logic.
  reg.register('file_list',   sandboxViolationClassifier);
  reg.register('file_write',  sandboxViolationClassifier);
  reg.register('file_patch',  sandboxViolationClassifier);
  reg.register('file_copy',   sandboxViolationClassifier);
  reg.register('file_move',   sandboxViolationClassifier);
  reg.register('file_delete', sandboxViolationClassifier);
  // v4.3 Phase 5 — browser-tool overrides that read the
  // BrowserState sidecars (staleRefRetry from Phase 2, blocker from
  // Phase 3). Fall through to defaultClassifier when sidecars are
  // absent (browser depth opt'd out via AIDEN_BROWSER_DEPTH=0 →
  // no sidecar → generic patterns).
  reg.register('browser_click',    browserInteractiveClassifier);
  reg.register('browser_type',     browserInteractiveClassifier);
  reg.register('browser_fill',     browserInteractiveClassifier);
  reg.register('browser_navigate', browserNavigateClassifier);
  // v4.5 Phase 5a — daemon dispatcher synthetic "tool" routes the
  // three trigger-specific failure categories.
  reg.register(DAEMON_DISPATCHER_TOOL_NAME, triggerDispatcherClassifier);
  return reg;
}
