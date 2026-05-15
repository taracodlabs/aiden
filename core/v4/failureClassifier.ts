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

// ── Public types ────────────────────────────────────────────────────────────

/** Ten failure categories — must match the v4.2 spec exactly. */
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

// ── Factory ────────────────────────────────────────────────────────────────

export function buildDefaultClassifier(): FailureClassifier {
  const reg = new FailureClassifier();
  reg.register('shell_exec', shellExecClassifier);
  reg.register('web_search', webSearchClassifier);
  reg.register('web_fetch',  webFetchClassifier);
  reg.register('fetch_page', webFetchClassifier);
  reg.register('web_page',   webFetchClassifier);
  reg.register('file_read',  fileReadClassifier);
  return reg;
}
