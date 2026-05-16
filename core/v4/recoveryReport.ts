/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/recoveryReport.ts — v4.2 Phase 3: Evidence Output +
 * RecoveryReport.
 *
 * Pure synthesis. Consumes a TurnStateDiagnosticSnapshot (populated by
 * Phase 1's verifier + Phase 2's classifier records) and produces a
 * structured RecoveryReport that captures what the agent tried, what
 * failed, why, what was recovered, and what's next.
 *
 * Surfaced ONLY when the TurnState recovery controller reaches the
 * `surfaced` stage — quiet by design on hint/cooldown turns where the
 * model self-corrects without user intervention. The report enriches
 * the existing v4.1.6 tool_loop capability card by attaching summary
 * lines (whatHappened) and a category breakdown (failuresByCategory).
 *
 * Reference notes: a comparable reference system's failure surface is
 * text-only metadata (flat dict + appended guidance strings). Aiden's
 * structured report is genuinely new — no patterns to port, but the
 * single-source-of-truth synthesis approach mirrors the reference's
 * `to_metadata()` style.
 *
 * Phase 3 stays consume-only: no changes to TurnState, verifier, or
 * failureClassifier. Imports flow downstream (recoveryReport depends
 * on TurnState's snapshot type and failureClassifier's category enum).
 *
 * Pure module — no I/O, no async, no side effects. Easy to unit test
 * with synthetic snapshots.
 */

import type { TurnStateDiagnosticSnapshot } from './turnState';
import type { FailureCategory } from './failureClassifier';
import type { CapabilityCardData, Message } from '../../providers/v4/types';

// ── Public types ────────────────────────────────────────────────────────────

/** How the turn ended. Mirrors the agent loop's `finishReason` variants. */
export type RecoveryExitReason =
  | 'stop'
  | 'tool_loop'
  | 'budget_exhausted'
  | 'error';

/**
 * Structured "what happened this turn" report. Surfaced only when the
 * recovery controller's `surface` stage fires (tool_loop). Built per-
 * turn; not persisted across turns.
 */
export interface RecoveryReport {
  /** First user message in the turn, truncated to 140 chars + ellipsis. */
  goal:            string;
  /** How the turn ended. */
  exitReason:      RecoveryExitReason;
  /** Wallclock duration of the turn in milliseconds. */
  durationMs:      number;
  /** Tool-call counters. */
  attempts: {
    total:     number;
    succeeded: number;     // verification.ok === true
    failed:    number;     // verification.ok === false
  };
  /** Non-zero category counts only — sparse for readability. */
  failureBreakdown: Partial<Record<FailureCategory, number>>;
  /** Latest failure per tool name — at-a-glance "these didn't work and why". */
  failedTools: Array<{
    name:       string;
    category:   FailureCategory;
    reason?:    string;
    confidence: number;
  }>;
  /** Tools that produced verified-ok results this turn. */
  successfulTools: string[];
  /** Recovery stages that fired this turn, in order. */
  recoveryStages: Array<{
    stage:    'hinted' | 'cooldown' | 'surfaced';
    toolName: string;
    count:    number;
  }>;
  /** One-sentence next-step guidance, derived from dominant failure category. */
  guidance: string;
  /**
   * v4.3 Phase 5 — browser-specific context populated when the
   * BrowserState observer has tab data (i.e. state-aware browser
   * depth is enabled — default ON — AND at least one browser tool
   * fired this turn). Absent otherwise.
   *
   * Surfaced into the recovery card as a muted "Browser:" line right
   * below the whatHappened summary so the user sees what the browser
   * is in when recovery fires.
   */
  browserContext?: {
    /** URL of the currently-active tab. */
    activeTabUrl?:   string;
    /** Title of the active tab. */
    activeTabTitle?: string;
    /** Coarse kind of the active tab's most-recent blocker (if any). */
    activeBlocker?:  'captcha' | 'login' | '2fa' | 'verification' | 'consent';
    /** Count of OTHER tabs (excludes active). */
    otherTabCount:   number;
    /** Stale-ref retry attempts that fired during the turn. */
    staleRefRetries: number;
  };
  /**
   * v4.4 Phase 5 — sandbox-specific context populated when any
   * classification this turn has category `sandbox_violation`.
   * Surfaces violation counts, the most-recent matched policy, and
   * an auto-derived env-var override suggestion so the user can
   * widen the allowlist (or disable the sandbox) with one copy-paste.
   *
   * Absent when no sandbox violation fired this turn — keeping the
   * common path clean. Mirrors `browserContext` shape and lifecycle.
   */
  sandboxContext?: {
    /** Total `sandbox_violation` classifications this turn. */
    violationCount:  number;
    /** Filesystem violations (codes starting with `fs.`). */
    fsViolations:    number;
    /** Shell violations (e.g. `docker_unavailable`). */
    shellViolations: number;
    /** Most recent violation code. */
    lastCode:        string;
    /** Most recent matched policy (allowlist/denylist entry or ''). */
    lastMatched:     string;
    /** Most recent requested path (file violations only). */
    lastRequested?:  string;
    /** Auto-derived env-var override suggestion. */
    suggestedEnv?:   string;
  };
}

/**
 * v4.3 Phase 5 — minimal structural interface for the BrowserState
 * observer's tab-state surface. Used by `buildRecoveryReport` to
 * populate `browserContext` without taking a hard import dependency
 * on the browserState module (keeps import direction clean: lower-
 * layer recoveryReport doesn't depend on browser-domain modules).
 */
export interface BrowserStateLike {
  getActiveTab(): {
    url?: string;
    title?: string;
    last_blocker?: { kind: 'captcha' | 'login' | '2fa' | 'verification' | 'consent' };
  } | null;
  getTabs(): Array<{ is_active: boolean }>;
}

// ── Goal extraction ────────────────────────────────────────────────────────

const MAX_GOAL_CHARS = 140;

/**
 * Pull the first user message from the conversation as the turn's
 * goal. Handles three shapes:
 *   - string content (the common path)
 *   - ContentBlock[] content (Anthropic structured shape) — concatenates
 *     text blocks; ignores tool_use / image blocks
 *   - missing user message — returns empty string
 *
 * Result truncated to MAX_GOAL_CHARS with ellipsis to keep the report
 * line bounded.
 */
export function extractGoal(messages: ReadonlyArray<Message>): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '';
  const raw = stringifyContent(firstUser.content);
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_GOAL_CHARS) return trimmed;
  return trimmed.slice(0, MAX_GOAL_CHARS - 3) + '...';
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text);
        else if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

// ── Guidance map ───────────────────────────────────────────────────────────

const GUIDANCE_BY_CATEGORY: Record<FailureCategory, string> = {
  permission:
    'Adjust permissions or surface this to the user — the tool refused, so retrying without changes will not help.',
  auth:
    'Provide credentials before retrying — the tool needs auth that has not been supplied.',
  timeout:
    'Network or tool deadline exceeded. Retry with a longer budget or check connectivity.',
  dependency_missing:
    'A required binary or service is not available. Install it or use a different approach.',
  rate_limit:
    'Upstream rate-limited the call. Wait a moment and retry, or rotate to a different credential.',
  network:
    'Network unreachable or DNS failure. Check the connection and retry once it is stable.',
  invalid_input:
    'The tool arguments were rejected. Re-read the tool schema and fix the arguments before retrying.',
  hallucination:
    'The model used a path or name that does not exist. Re-read the surrounding state before retrying.',
  not_found:
    'The target resource was not found. Verify the path or name and try again with a corrected value.',
  stale_ref:
    'The page changed between snapshot and action. The observer already attempted resnapshot+retry once — re-read the visible state and try a different selector or approach.',
  manual_blocker:
    'The site requires a human action (login, 2FA, captcha, or verification). Surface this to the user and wait — do not retry automatically.',
  sandbox_violation:
    'Aiden\'s execution sandbox refused this operation. Surface the matched policy to the user and either widen the allowlist via AIDEN_SANDBOX_ALLOW=path1:path2 or disable the sandbox with AIDEN_SANDBOX=0 (not recommended). Denylist matches cannot be overridden — they signal sensitive paths the user explicitly wants protected.',
  other:
    'The tool failed for an unclassified reason. Inspect the trace for details before retrying.',
};

/** Public for tests + plugin extensions. */
export function guidanceFor(category: FailureCategory): string {
  return GUIDANCE_BY_CATEGORY[category] ?? GUIDANCE_BY_CATEGORY.other;
}

// ── Generator ──────────────────────────────────────────────────────────────

export interface BuildRecoveryReportInput {
  snapshot:    TurnStateDiagnosticSnapshot;
  goal:        string;
  exitReason:  RecoveryExitReason;
  durationMs:  number;
  /**
   * v4.3 Phase 5 — optional BrowserState for browser-context
   * enrichment. When provided AND it reports any tabs, the report
   * gets a `browserContext` field populated with active tab info +
   * blocker + other-tab count. Absent when not passed, or when the
   * observer has no tabs (opt-out via AIDEN_BROWSER_DEPTH=0).
   */
  browserState?: BrowserStateLike;
}

/**
 * Pure function. Given the per-turn diagnostic snapshot plus three
 * scalar inputs, produces a deterministic RecoveryReport. No I/O,
 * no async, no Date.now() — all timestamps come from the snapshot
 * or are passed explicitly.
 */
export function buildRecoveryReport(
  input: BuildRecoveryReportInput,
): RecoveryReport {
  const { snapshot, goal, exitReason, durationMs } = input;

  // ── Attempts ────────────────────────────────────────────────────────────
  // Total = every recorded tool call (toolCalls array).
  // Succeeded = verifications with ok=true.
  // Failed   = verifications with ok=false.
  //
  // Note: total may exceed succeeded+failed when callers run without
  // a verification (verifier disabled or threw). The arithmetic
  // tolerates that — the counters report exactly what's recorded.
  const total     = snapshot.toolCalls.length;
  const succeeded = snapshot.verifications.filter((v) => v.verification.ok).length;
  const failed    = snapshot.verifications.filter((v) => !v.verification.ok).length;

  // ── Failure breakdown ───────────────────────────────────────────────────
  const breakdown: Partial<Record<FailureCategory, number>> = {};
  for (const entry of snapshot.classifications) {
    const cat = entry.classification.category;
    breakdown[cat] = (breakdown[cat] ?? 0) + 1;
  }

  // ── Failed tools (latest classification per tool name) ──────────────────
  // Iterate forward; later entries overwrite earlier ones, so the
  // resulting map holds the most recent classification per name.
  const latestByName: Map<
    string,
    { name: string; category: FailureCategory; reason?: string; confidence: number }
  > = new Map();
  for (const entry of snapshot.classifications) {
    latestByName.set(entry.name, {
      name:       entry.name,
      category:   entry.classification.category,
      reason:     entry.classification.reason,
      confidence: entry.classification.confidence,
    });
  }
  const failedTools = [...latestByName.values()];

  // ── Recovery stages (passthrough — already ordered by recordToolCall) ──
  const recoveryStages = snapshot.recoveryEvents.map((e) => ({
    stage:    e.stage,
    toolName: e.toolName,
    count:    e.count,
  }));

  // ── Guidance — dominant failure category ────────────────────────────────
  const guidance = synthesizeGuidance(breakdown);

  // ── v4.3 Phase 5 — browserContext enrichment ────────────────────────────
  // Populated when an optional BrowserStateLike is provided AND it
  // reports at least one tab. Counts stale-ref retries from the
  // recoveryStages signal indirectly — Phase 2's auto-retry fires
  // via the HOC, not TurnState's recovery state machine, so we look
  // for retried classifications in the snapshot instead.
  const browserContext = buildBrowserContext(
    input.browserState,
    snapshot,
  );

  // ── v4.4 Phase 5 — sandboxContext enrichment ────────────────────────────
  // Populated when any classification this turn has category
  // `sandbox_violation`. The classifier (Phase 5) attaches the raw
  // envelope to ClassificationResult.sandboxViolation, so we don't
  // re-parse tool results here.
  const sandboxContext = buildSandboxContext(snapshot);

  return {
    goal,
    exitReason,
    durationMs,
    attempts: { total, succeeded, failed },
    failureBreakdown: breakdown,
    failedTools,
    successfulTools: [...snapshot.successfulTools],
    recoveryStages,
    guidance,
    ...(browserContext ? { browserContext } : {}),
    ...(sandboxContext ? { sandboxContext } : {}),
  };
}

/**
 * v4.4 Phase 5 — build the `sandboxContext` sidecar from the turn's
 * classifications. Returns null when no `sandbox_violation` fired
 * (the common path).
 *
 * Aggregates FS vs shell violation counts (FS = code starts with
 * `fs.`; shell = anything else under the sandbox_violation category)
 * and surfaces the most recent envelope's matched policy +
 * auto-derived override suggestion.
 */
function buildSandboxContext(
  snapshot: TurnStateDiagnosticSnapshot,
): NonNullable<RecoveryReport['sandboxContext']> | null {
  const violations = snapshot.classifications.filter(
    (c) => c.classification.category === 'sandbox_violation',
  );
  if (violations.length === 0) return null;
  const last = violations[violations.length - 1].classification;
  const lastCode = last.matchedPattern ?? last.sandboxViolation?.code ?? '';
  let fsViolations    = 0;
  let shellViolations = 0;
  for (const v of violations) {
    const code = v.classification.matchedPattern
      ?? v.classification.sandboxViolation?.code
      ?? '';
    if (code.startsWith('fs.')) fsViolations += 1;
    else                        shellViolations += 1;
  }
  const ctx: NonNullable<RecoveryReport['sandboxContext']> = {
    violationCount: violations.length,
    fsViolations,
    shellViolations,
    lastCode,
    lastMatched:    last.sandboxViolation?.matchedPolicy ?? '',
  };
  if (last.sandboxViolation?.requestedPath) {
    ctx.lastRequested = last.sandboxViolation.requestedPath;
  }
  if (last.recoveryHint?.detail) {
    ctx.suggestedEnv = last.recoveryHint.detail;
  }
  return ctx;
}

/**
 * v4.3 Phase 5 — build the `browserContext` sidecar from an optional
 * BrowserStateLike + diagnostic snapshot. Returns null when no tabs
 * exist (opt-out via AIDEN_BROWSER_DEPTH=0 or no browser action
 * this turn) so
 * the caller can decide whether to include the field.
 *
 * Stale-ref retry count derives from classifications with category
 * `stale_ref` — Phase 5's classifier produces those when Phase 2's
 * HOC-level retry attempted but failed. Successful retries don't
 * appear in classifications (their final result has `success:true`).
 */
function buildBrowserContext(
  browserState: BrowserStateLike | undefined,
  snapshot:    TurnStateDiagnosticSnapshot,
): NonNullable<RecoveryReport['browserContext']> | null {
  if (!browserState) return null;
  const tabs = browserState.getTabs();
  if (tabs.length === 0) return null;
  const active = browserState.getActiveTab();
  const otherTabCount = active
    ? tabs.filter((t) => !t.is_active).length
    : tabs.length;
  // Count stale_ref classifications recorded by Phase 5's browser
  // classifier in the turn's classifications log.
  const staleRefRetries = snapshot.classifications.filter(
    (c) => c.classification.category === 'stale_ref',
  ).length;
  const ctx: NonNullable<RecoveryReport['browserContext']> = {
    otherTabCount,
    staleRefRetries,
  };
  if (active?.url)          ctx.activeTabUrl   = active.url;
  if (active?.title)        ctx.activeTabTitle = active.title;
  if (active?.last_blocker) ctx.activeBlocker  = active.last_blocker.kind;
  return ctx;
}

/**
 * Pick the most-frequent failure category and return its guidance
 * string. Ties broken by category priority (more recoverable first):
 * timeout > rate_limit > network > invalid_input > not_found >
 * hallucination > dependency_missing > permission > auth > other.
 *
 * No failures recorded → returns the generic `other` guidance.
 */
function synthesizeGuidance(
  breakdown: Partial<Record<FailureCategory, number>>,
): string {
  const entries = Object.entries(breakdown) as Array<[FailureCategory, number]>;
  if (entries.length === 0) return GUIDANCE_BY_CATEGORY.other;

  const PRIORITY: ReadonlyArray<FailureCategory> = [
    'timeout', 'rate_limit', 'network', 'invalid_input',
    'not_found',
    'stale_ref',          // v4.3 Phase 5 — auto-recoverable via wait+retry
    'hallucination', 'dependency_missing',
    'manual_blocker',     // v4.3 Phase 5 — requires human action; semi-blocking
    'sandbox_violation',  // v4.4 Phase 5 — env-var override is the specific user action
    'permission', 'auth', 'other',
  ];
  const rank = (c: FailureCategory): number => {
    const i = PRIORITY.indexOf(c);
    return i === -1 ? PRIORITY.length : i;
  };

  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];     // desc by count
    return rank(a[0]) - rank(b[0]);             // tie → priority rank asc
  });
  return GUIDANCE_BY_CATEGORY[entries[0][0]];
}

// ── Card enrichment ────────────────────────────────────────────────────────

/**
 * Take a base CapabilityCardData (typically from TurnState's surface
 * card) and overlay the RecoveryReport's summary lines. Returns a new
 * card object — the base is not mutated. When report is undefined,
 * returns the base unchanged.
 *
 * Three additions:
 *   - whatHappened: one-line summary string with attempt counts +
 *     duration (rendered above canStill section).
 *   - failuresByCategory: inline pill row of non-zero category counts,
 *     ordered by descending count then priority.
 *   - fix: replaced with the report's guidance text (one sentence,
 *     dominant-category aware).
 *
 * The base card's title / canStill / cannotReliably pass through.
 */
export function enrichCardWithReport(
  base:   CapabilityCardData,
  report: RecoveryReport,
): CapabilityCardData {
  const whatHappened = buildWhatHappenedLine(report);
  const failuresByCategory = buildFailuresPills(report.failureBreakdown);
  // v4.3 Phase 5 — browser-context inline row. Only present when the
  // report carries browserContext (which requires an active BrowserState
  // with tabs). Renderer treats this as a single-line muted addition
  // below whatHappened.
  const browserContext = report.browserContext
    ? buildBrowserContextLine(report.browserContext)
    : undefined;
  // v4.4 Phase 5 — sandbox-context inline row. Present when the
  // report carries sandboxContext (any sandbox_violation this turn).
  // Renderer surfaces this as another muted line right below
  // browserContext (or whatHappened when no browser activity).
  const sandboxContext = report.sandboxContext
    ? buildSandboxContextLine(report.sandboxContext)
    : undefined;
  return {
    title:           base.title,
    canStill:        base.canStill,
    cannotReliably:  base.cannotReliably,
    fix:             report.guidance,
    whatHappened,
    failuresByCategory,
    ...(browserContext ? { browserContext } : {}),
    ...(sandboxContext ? { sandboxContext } : {}),
  };
}

/**
 * v4.3 Phase 5 — format the browserContext fields into a compact
 * single-line summary for the recovery card. Returns empty string
 * when no signal worth surfacing.
 */
function buildBrowserContextLine(
  ctx: NonNullable<RecoveryReport['browserContext']>,
): string {
  const parts: string[] = [];
  if (ctx.activeTabUrl) {
    try {
      parts.push(`active=${new URL(ctx.activeTabUrl).hostname || ctx.activeTabUrl}`);
    } catch {
      parts.push(`active=${ctx.activeTabUrl}`);
    }
  }
  if (ctx.activeBlocker) parts.push(`${ctx.activeBlocker} blocker`);
  if (ctx.otherTabCount > 0) {
    parts.push(`${ctx.otherTabCount} other tab${ctx.otherTabCount === 1 ? '' : 's'}`);
  }
  if (ctx.staleRefRetries > 0) {
    parts.push(`${ctx.staleRefRetries} stale-ref retr${ctx.staleRefRetries === 1 ? 'y' : 'ies'}`);
  }
  return parts.length > 0 ? `Browser: ${parts.join(' · ')}` : '';
}

/**
 * v4.4 Phase 5 — format the sandboxContext fields into a compact
 * single-line summary for the recovery card. Mirrors
 * `buildBrowserContextLine` shape. Returns empty string when no
 * signal worth surfacing.
 */
function buildSandboxContextLine(
  ctx: NonNullable<RecoveryReport['sandboxContext']>,
): string {
  const parts: string[] = [];
  parts.push(`${ctx.violationCount} blocked`);
  if (ctx.fsViolations > 0 && ctx.shellViolations > 0) {
    parts.push(`${ctx.fsViolations} fs · ${ctx.shellViolations} shell`);
  } else if (ctx.shellViolations > 0) {
    parts.push(`${ctx.shellViolations} shell`);
  }
  if (ctx.lastCode) parts.push(`last: ${ctx.lastCode}`);
  if (ctx.suggestedEnv) parts.push(`try: ${ctx.suggestedEnv}`);
  return parts.length > 0 ? `Sandbox: ${parts.join(' · ')}` : '';
}

function buildWhatHappenedLine(report: RecoveryReport): string {
  const { attempts, durationMs } = report;
  const dur = (durationMs / 1000).toFixed(1);
  return (
    `Tried ${attempts.total} tool ${plural(attempts.total, 'call')} · ` +
    `${attempts.succeeded} succeeded · ${attempts.failed} failed · ${dur}s`
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function buildFailuresPills(
  breakdown: Partial<Record<FailureCategory, number>>,
): Array<{ category: string; count: number }> {
  const entries = Object.entries(breakdown) as Array<[FailureCategory, number]>;
  // Same ordering rule as guidance synthesis: count desc, priority asc.
  const PRIORITY: ReadonlyArray<FailureCategory> = [
    'timeout', 'rate_limit', 'network', 'invalid_input',
    'not_found',
    'stale_ref',          // v4.3 Phase 5 — auto-recoverable via wait+retry
    'hallucination', 'dependency_missing',
    'manual_blocker',     // v4.3 Phase 5 — requires human action; semi-blocking
    'sandbox_violation',  // v4.4 Phase 5 — env-var override is the specific user action
    'permission', 'auth', 'other',
  ];
  const rank = (c: FailureCategory): number => {
    const i = PRIORITY.indexOf(c);
    return i === -1 ? PRIORITY.length : i;
  };
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return rank(a[0]) - rank(b[0]);
  });
  return entries.map(([category, count]) => ({ category, count }));
}
