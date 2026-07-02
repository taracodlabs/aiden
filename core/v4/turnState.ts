/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/turnState.ts — v4.1.6 spike: Task Completion Engine (TCE)
 * loop detection + recovery controller.
 *
 * One TurnState instance lives per `runConversation` call. **Default
 * ON** as of v4.2 Phase 6 — set `AIDEN_TCE=0` to disable. Zero
 * behavioral change vs v4.1.6 when disabled.
 *
 * Concept: per-turn state object that the agent loop consults after
 * each tool dispatch. Tracks how often the model is repeating itself
 * — both at the precise-call level (same tool name + identical args)
 * AND at the same-tool-name level (any args). Returns a typed
 * recovery decision so the agent loop can act on it.
 *
 * Two counters by design (the layered-budget pattern):
 *
 *   - `consecSignature`: same name + same args-hash run length.
 *     Resets when EITHER name or args change. Catches precise loops
 *     where the model literally repeats the identical call.
 *
 *   - `consecName`: same tool name run length (any args).
 *     Resets only when the tool name changes. Catches broader
 *     "fishing" patterns where the model probes a tool with
 *     different args repeatedly without making progress.
 *
 * Hint stage uses signature counting (precise — fires only on
 * genuine identical-call loops; not on legitimate skill exploration
 * via `skill_view` with different names). Cooldown + surface use
 * name counting (broader — catches the reported 30-skill_view
 * failure mode regardless of args).
 *
 * Three escalating recovery stages, monotonic (once hinted, can
 * escalate to cooldown then surface; never re-fires the same stage):
 *
 *   Stage 1 — HINT (signature ≥ 5): inject `role: 'system'` message
 *     into the conversation suggesting the model reconsider.
 *
 *   Stage 2 — COOLDOWN (name ≥ 8): mark the tool cooled-down for N
 *     iterations. Agent filters the tool out of the schemas passed
 *     to the provider, so the model literally cannot call it.
 *
 *   Stage 3 — SURFACE (name ≥ 11): return a structured-failure card.
 *     Agent ends the turn cleanly via `finishReason = 'tool_loop'`;
 *     chatSession renders a capability-card-style failure surface.
 *
 * Thresholds are tunable via constructor options. Pure module — no
 * Display dependency, no event-emitter side effects. Safe to import
 * from anywhere in the codebase.
 */

import crypto from 'node:crypto';

import type { Message } from '../../providers/v4/types';
import type { VerificationResult } from './verifier';
import type { ClassificationResult } from './failureClassifier';
import type {
  Checkpoint,
  TurnStateInternalSnapshot,
} from './checkpoint';

// ── Public types ────────────────────────────────────────────────────────────

/** A single recorded tool call within the current turn. */
export interface CapturedCall {
  name:        string;
  argsHash:    string;          // sha256(canonical args), first 12 hex
  ts:          number;          // Date.now()
}

/**
 * Where the recovery state machine currently sits. Monotonic:
 *   none → hinted → cooldown → surfaced
 * Once a stage advances, it never regresses for the rest of the turn.
 */
export type RecoveryStage = 'none' | 'hinted' | 'cooldown' | 'surfaced';

/**
 * The action the agent loop should take after a tool call.
 *
 * v4.2 Phase 4 added `cooldown_with_rollback` — same intent as
 * `cooldown` (the looping tool is being pulled from the schema),
 * but with an attached checkpoint that the agent loop should
 * restore from. Fires only when the most-recent restorable
 * checkpoint exists and contains no mutating tool calls (HARD
 * BLOCK enforcement of the never-undo-side-effects rule).
 */
export type RecoveryKind =
  | 'allow'
  | 'hint'
  | 'cooldown'
  | 'cooldown_with_rollback'
  | 'surface';

/** Returned from `recordToolCall`. Agent inspects `kind` and acts. */
export interface RecoveryDecision {
  kind:        RecoveryKind;
  toolName?:   string;
  /** Consec-same count that triggered the decision (signature OR name). */
  consecutive: number;
  /** For `hint` kind only — the system-message content to inject. */
  hintMessage?: string;
  /** For `cooldown` kind only — system-message announcing the cooldown. */
  cooldownMessage?: string;
  /**
   * For `surface` kind only — structured-failure payload the chat
   * layer renders as a capability-card-style surface.
   */
  surfaceCard?: {
    title:       string;
    canStill:    string[];
    cannotReliably: string[];
    fix:         string;
  };
  /**
   * v4.2 Phase 4 — present on `cooldown_with_rollback` only. The
   * agent loop should:
   *   1. Truncate its messages array to `checkpoint.messages.length`
   *   2. Call `turnState.restoreInternalsFrom(checkpoint)`
   *   3. Push a corrective system message (built via
   *      `buildRollbackMessage` in core/v4/checkpoint.ts)
   *   4. Break out of the current tool-dispatch batch
   * `blockedBy` is always empty in Phase 4 (hard block means we
   * never roll back when mutating tools ran); kept on the type so
   * a Phase 5+ soft-rollback variant can populate it without a
   * type change.
   */
  rollback?: {
    checkpoint:  Checkpoint;
    blockedBy:   ReadonlyArray<string>;
  };
}

/**
 * Append-only log of recovery actions fired this turn. Useful for
 * tests (assert sequence) and for the future loopTrace integration
 * (surface what TCE did in the diagnostic file).
 */
export interface RecoveryEvent {
  stage:    Exclude<RecoveryStage, 'none'>;
  toolName: string;
  count:    number;
  ts:       number;
}

/**
 * Snapshot of internal state for tests + diagnostic surfacing. Pure
 * read; safe to call at any point. Built from day one to avoid the
 * retrofitting cost of a debug snapshot added later.
 */
export interface TurnStateDiagnosticSnapshot {
  enabled:           boolean;
  stage:             RecoveryStage;
  consecName:        { name: string | null; count: number };
  consecSignature:   { signature: string | null; count: number };
  /**
   * v4.2 Phase 1 — name-keyed consecutive-failure counter, driven by
   * verifier classifications. Resets on tool-name change OR on a
   * verified-ok call. Fires the HINT stage faster than `consecName`
   * when calls are demonstrably failing.
   */
  consecFailed:      { name: string | null; count: number };
  cooledDownTools:   Array<{ name: string; iterationsRemaining: number }>;
  toolCalls:         ReadonlyArray<CapturedCall>;
  successfulTools:   ReadonlyArray<string>;  // distinct names that ran without surfacing
  recoveryEvents:    ReadonlyArray<RecoveryEvent>;
  /**
   * v4.2 Phase 1 — per-call verifier outcomes. Parallel to `toolCalls`
   * (same length, same order) but only populated for calls where a
   * verification was passed to `recordToolCall`.
   */
  verifications:     ReadonlyArray<{ name: string; verification: VerificationResult; ts: number }>;
  /**
   * v4.2 Phase 2 — per-call WHY-classification of failures. Only
   * populated for calls where a classification was passed to
   * `recordToolCall` (i.e. verifier said `!ok` AND classifier ran).
   * Phase 2 records-only; Phase 3+ acts on these to build a
   * RecoveryReport.
   */
  classifications:   ReadonlyArray<{ name: string; classification: ClassificationResult; ts: number }>;
  thresholds: {
    hintConsec:      number;
    cooldownConsec:  number;
    surfaceConsec:   number;
    cooldownIters:   number;
    /** v4.2 Phase 1 — verifier-driven fast-fail threshold. Default 3. */
    failedConsec:    number;
  };
}

/** Constructor options. All optional; defaults match the v4.1.6 spike spec. */
export interface TurnStateOptions {
  /**
   * Override the env-var gate. Default: read `process.env.AIDEN_TCE`
   * at construct time; **TCE is ON by default** as of v4.2 Phase 6.
   * Set `AIDEN_TCE=0` to disable. Any other value (unset, `'1'`,
   * `''`, junk) enables TCE — the strict-`'0'` opt-out semantic
   * keeps the contract unambiguous.
   */
  enabled?:                  boolean;
  /** Signature-streak threshold for HINT stage. Default 5. */
  hintConsecThreshold?:      number;
  /**
   * LOOP-LIKE threshold for COOLDOWN stage. Default 8.
   *
   * v4.13 — "loop-like" replaced raw name-streak counting: the count is
   * max(identical-signature streak, consecutive-failure streak). A
   * same-tool streak with MATERIALLY DIFFERENT args that keeps
   * SUCCEEDING (bulk file moves, skill exploration) no longer trips
   * cooldown/surface — the live-demo false positive where 11 legitimate
   * varied file_move calls got the "stuck" banner. Identical repeats
   * and varied-args FAILURE streaks still count fully.
   */
  cooldownConsecThreshold?:  number;
  /** Loop-like threshold for SURFACE stage. Default 11. See cooldown note. */
  surfaceConsecThreshold?:   number;
  /**
   * v4.13 — soft ceiling for a varied-args SUCCESSFUL name streak: at N
   * consecutive same-tool calls (any args, all verifying ok) emit ONE
   * informational hint (never cooldown/surface — bulk work is legal).
   * Default 25; env-tunable via AIDEN_TCE_VARIED_HINT.
   */
  variedNameHintThreshold?:  number;
  /** Iterations a cooled-down tool stays excluded. Default 3. */
  cooldownIterations?:       number;
  /**
   * v4.2 Phase 1 — verifier-driven HINT threshold. When ≥ N consecutive
   * calls of the same tool name verify as `!ok`, fire a HINT regardless
   * of where `consecSignature` sits. Default 3 (one flaky failure plus
   * a retry plus a third confirmation that it's not flakiness).
   */
  failedConsecThreshold?:    number;
  /**
   * v4.2 Phase 4 — checkpoint ring-buffer depth. Bounded number of
   * per-iteration checkpoints held in memory. Default 3. The agent
   * loop calls `captureCheckpoint(...)` at iteration entry; the ring
   * buffer rolls over once depth is exceeded.
   *
   * Phase 4 only USES last-1 today (cooldown rolls back to the most
   * recent restorable checkpoint); holding 3 prepares Phase 5+ where
   * the task graph may want deeper rewinds for sub-step failures.
   */
  checkpointDepth?:          number;
}

// ── Implementation ──────────────────────────────────────────────────────────

export class TurnState {
  private readonly enabled:           boolean;
  private readonly hintConsec:        number;
  private readonly cooldownConsec:    number;
  private readonly surfaceConsec:     number;
  private readonly cooldownIters:     number;
  private readonly failedConsec:      number;
  private readonly checkpointDepth:   number;
  private readonly variedHintConsec:  number;

  private stage:                      RecoveryStage = 'none';
  private toolCalls:                  CapturedCall[] = [];
  private successfulTools:            Set<string> = new Set();

  // Layered streak tracking — see module docstring for rationale.
  private consecName:                 { name: string | null; count: number } =
    { name: null, count: 0 };
  private consecSignature:            { signature: string | null; count: number } =
    { signature: null, count: 0 };
  /**
   * v4.2 Phase 1 — verifier-driven failure streak. Resets on tool
   * name change OR on a verified-ok call. Independent of the other
   * two streaks because a failing tool isn't necessarily called with
   * identical args (model often varies args between retries).
   */
  private consecFailed:               { name: string | null; count: number } =
    { name: null, count: 0 };

  private cooledDownTools:            Map<string, number> = new Map();
  private recoveryEvents:             RecoveryEvent[] = [];
  /**
   * v4.2 Phase 1 — append-only verifier log, parallel to `toolCalls`.
   * Only entries whose `recordToolCall(...)` was given a verification
   * argument land here; this keeps the array semantically clean for
   * downstream callers (no `undefined` placeholders).
   */
  private verifications:              Array<{
    name: string; verification: VerificationResult; ts: number;
  }> = [];
  /**
   * v4.2 Phase 2 — append-only classification log. Only populated
   * when a classifier was supplied to `recordToolCall(...)` AND the
   * verifier marked the call as `!ok`. Semantically clean — no
   * `undefined` placeholders for ok calls.
   */
  private classifications:            Array<{
    name: string; classification: ClassificationResult; ts: number;
  }> = [];
  /**
   * v4.2 Phase 4 — ring buffer of per-iteration checkpoints. Newest
   * at the tail. Length is bounded by `checkpointDepth`; older
   * entries are dropped from the head when capacity is exceeded.
   * The "live" checkpoint (the one capturing the current iteration's
   * mutation flag) is always `checkpoints[checkpoints.length - 1]`.
   */
  private checkpoints:                Checkpoint[] = [];

  // ── v4.13 Gap 2 — per-turn retry-policy attempt state ──────────────
  //
  // Owned here (not in the policy module) so the repeat ladder above
  // and the retry policy share ONE per-turn state object and can't
  // fight: policy retries are recorded into the ladder's signature
  // counters by the agent loop, and the policy consults these budgets.
  /** Runtime retries spent per failure class this turn. */
  private policyRetriesByClass:       Map<string, number> = new Map();
  /** Runtime retries spent across all classes this turn. */
  private policyRetriesTotal          = 0;
  /** One-shot repair flags (`<tool>:<category>`) — protocol repair-once. */
  private repairAttempted:            Set<string> = new Set();
  /** One-shot clarify directive issued this turn. */
  private clarifyAdvisedFlag          = false;

  constructor(opts: TurnStateOptions = {}) {
    // v4.2 Phase 6 — TCE is ON by default. Strict `'0'` opt-out
    // semantic: env var must be literally the string `'0'` to
    // disable; everything else (unset, `'1'`, empty string, junk)
    // enables. The opts.enabled override still wins when explicitly
    // passed by callers (test fixtures, embedded usage).
    // v4.5 Phase 8a — route through the runtimeToggles singleton so
    // /tce slash-command flips and config.yaml overrides take effect
    // on the next constructed TurnState. The explicit opts.enabled
    // override still wins for test fixtures + embedded usage.
    if (typeof opts.enabled === 'boolean') {
      this.enabled = opts.enabled;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const rt = require('./runtimeToggles') as typeof import('./runtimeToggles');
        this.enabled = rt.getRuntimeToggles().isEnabled('tce');
      } catch {
        // runtimeToggles unavailable (rare — circular import or test
        // harness without core/v4 wired). Fall back to direct env read.
        this.enabled = process.env.AIDEN_TCE !== '0';
      }
    }
    this.hintConsec      = opts.hintConsecThreshold     ?? 5;
    this.cooldownConsec  = opts.cooldownConsecThreshold ?? 8;
    this.surfaceConsec   = opts.surfaceConsecThreshold  ?? 11;
    this.cooldownIters   = opts.cooldownIterations      ?? 3;
    this.failedConsec    = opts.failedConsecThreshold   ?? 3;
    // v4.13 — env-tunable like the retry knobs (AIDEN_RETRY_*).
    const variedEnv = Number(process.env.AIDEN_TCE_VARIED_HINT);
    this.variedHintConsec = opts.variedNameHintThreshold
      ?? (Number.isFinite(variedEnv) && variedEnv > 0 ? Math.floor(variedEnv) : 25);
    // checkpointDepth = 0 disables the buffer entirely (useful for
    // tests that want Phase 1-3 behavior with TCE enabled). Otherwise
    // default 3 per Q-CP2 approval.
    this.checkpointDepth = Math.max(0, opts.checkpointDepth ?? 3);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── v4.13 Gap 2 — retry-policy attempt-state surface ────────────────

  /** Record one spent runtime retry for a failure class. */
  recordPolicyRetry(category: string): void {
    this.policyRetriesByClass.set(
      category,
      (this.policyRetriesByClass.get(category) ?? 0) + 1,
    );
    this.policyRetriesTotal += 1;
  }

  markRepairAttempted(key: string): void { this.repairAttempted.add(key); }
  markClarifyAdvised(): void { this.clarifyAdvisedFlag = true; }

  /**
   * Read-only view the retry policy consults (RetryAttemptView shape,
   * declared structurally in retryPolicy.ts to avoid an import cycle).
   */
  retryView(): {
    attemptsForClass(category: string): number;
    totalRetries(): number;
    hasRepairAttempted(key: string): boolean;
    clarifyAdvised(): boolean;
  } {
    return {
      attemptsForClass: (category) => this.policyRetriesByClass.get(category) ?? 0,
      totalRetries:     () => this.policyRetriesTotal,
      hasRepairAttempted: (key) => this.repairAttempted.has(key),
      clarifyAdvised:   () => this.clarifyAdvisedFlag,
    };
  }

  /**
   * Called after each tool's executor resolves. Updates the streak
   * counters, decides which recovery action (if any) applies, and
   * returns the decision for the agent loop to act on.
   *
   * When `enabled === false`, returns `{kind: 'allow'}` immediately
   * without any state mutation — guarantees zero behavioral change
   * when TCE is opted out via `AIDEN_TCE=0`.
   *
   * v4.2 Phase 1 — optional `verification` argument lets the verifier
   * layer feed its classification into the controller. When provided
   * and `!verification.ok`, the `consecFailed` counter increments;
   * when `verification.ok`, it resets. Callers that don't pass a
   * verification get the original v4.1.6 behavior unchanged.
   *
   * v4.2 Phase 2 — optional `classification` argument records WHY a
   * call failed. Phase 2 only logs it (for Phase 3's RecoveryReport
   * to consume); no counter or recovery action fires off classification.
   */
  recordToolCall(
    name: string,
    args: unknown,
    verification?: VerificationResult,
    classification?: ClassificationResult | null,
  ): RecoveryDecision {
    if (!this.enabled) {
      return { kind: 'allow', consecutive: 0 };
    }

    const argsHash  = canonicalArgsHash(args);
    const signature = `${name}::${argsHash}`;
    const ts = Date.now();

    this.toolCalls.push({ name, argsHash, ts });

    // Update name streak: resets only on tool-name change.
    if (this.consecName.name === name) {
      this.consecName.count += 1;
    } else {
      this.consecName = { name, count: 1 };
    }

    // Update signature streak: resets on EITHER name or args change.
    if (this.consecSignature.signature === signature) {
      this.consecSignature.count += 1;
    } else {
      this.consecSignature = { signature, count: 1 };
    }

    // v4.2 Phase 1 — update verifier-driven failure streak. Reset on
    // name change OR on a verified-ok call; increment on verified-fail.
    // Calls without a verification leave the counter untouched (so a
    // mid-turn migration from un-verified to verified callers doesn't
    // produce spurious resets).
    if (verification) {
      this.verifications.push({ name, verification, ts });
      if (verification.ok) {
        this.consecFailed = { name, count: 0 };
      } else {
        if (this.consecFailed.name === name) {
          this.consecFailed.count += 1;
        } else {
          this.consecFailed = { name, count: 1 };
        }
      }
    } else if (this.consecFailed.name !== name) {
      // Name change with no verification — reset the failed counter
      // to keep it semantically aligned with `consecName`.
      this.consecFailed = { name: null, count: 0 };
    }

    // v4.2 Phase 2 — record-only. Classifier output lands here for
    // Phase 3 to consume; no recovery action fires off this in Phase 2.
    if (classification) {
      this.classifications.push({ name, classification, ts });
    }

    // Track which distinct tools have run in this turn (for surface
    // card's `canStill` list — tools the model used productively
    // before getting stuck).
    if (this.stage === 'none' || this.stage === 'hinted') {
      this.successfulTools.add(name);
    }

    // ── Stage transition gate (monotonic) ────────────────────────────
    //
    // v4.13 — the DETECTOR reports two streak flavours; the POLICY here
    // gates cooldown/surface on the LOOP-LIKE count only:
    //
    //   loopLike = max(identical-signature streak, consecutive-failure
    //              streak for this tool)
    //
    // A varied-args streak that keeps verifying OK (bulk file moves,
    // wide skill exploration) is legitimate work, not a loop — it gets
    // at most one informational hint at the (much higher) varied
    // ceiling below. Identical repeats ARE loops even when succeeding;
    // varied-args FAILURE streaks are still a problem worth surfacing.
    const failedForName = this.consecFailed.name === name ? this.consecFailed.count : 0;
    const loopLike = Math.max(this.consecSignature.count, failedForName);

    // Surface (highest priority): loop-like crosses the surface
    // threshold AND we haven't already surfaced.
    if (this.stage !== 'surfaced' && loopLike >= this.surfaceConsec) {
      this.stage = 'surfaced';
      const decision: RecoveryDecision = {
        kind:        'surface',
        toolName:    name,
        consecutive: loopLike,
        surfaceCard: this.buildSurfaceCard(name, loopLike),
      };
      this.recoveryEvents.push({ stage: 'surfaced', toolName: name, count: loopLike, ts });
      return decision;
    }

    // Cooldown: loop-like crosses cooldown threshold AND tool not
    // already cooled-down AND we haven't escalated past cooldown.
    if (
      this.stage !== 'surfaced' &&
      loopLike >= this.cooldownConsec &&
      !this.cooledDownTools.has(name)
    ) {
      this.stage = 'cooldown';
      this.cooledDownTools.set(name, this.cooldownIters);

      // v4.2 Phase 4 — look for a restorable checkpoint. The cooldown
      // stage benefits from rolling back to a clean baseline before
      // the looping tool started failing, but ONLY when no mutating
      // tools ran in the target iteration's window (HARD BLOCK per
      // Q-CP3). Falls back gracefully to plain cooldown when no
      // restorable checkpoint exists.
      const restorable = this.findRestorableCheckpoint();
      const baseDecision: RecoveryDecision = {
        kind:        'cooldown',
        toolName:    name,
        consecutive: loopLike,
        cooldownMessage: buildCooldownMessage(name, this.cooldownIters),
      };
      this.recoveryEvents.push({ stage: 'cooldown', toolName: name, count: loopLike, ts });
      if (restorable) {
        return {
          ...baseDecision,
          kind: 'cooldown_with_rollback',
          rollback: {
            checkpoint: restorable,
            blockedBy:  [],   // hard block means we only return checkpoints with zero mutations
          },
        };
      }
      return baseDecision;
    }

    // v4.2 Phase 1 — verifier-driven HINT. Fires faster than the
    // signature-based hint when the verifier flags consecutive
    // failures. Distinct hint message so the model sees a different
    // corrective signal ("you're failing" vs "you're repeating").
    if (
      this.stage === 'none' &&
      this.consecFailed.name === name &&
      this.consecFailed.count >= this.failedConsec
    ) {
      this.stage = 'hinted';
      const decision: RecoveryDecision = {
        kind:        'hint',
        toolName:    name,
        consecutive: this.consecFailed.count,
        hintMessage: buildFailedHintMessage(name, this.consecFailed.count, verification),
      };
      this.recoveryEvents.push({ stage: 'hinted', toolName: name, count: this.consecFailed.count, ts });
      return decision;
    }

    // Hint: signature-streak (precise) crosses hint threshold AND
    // we're still in the `none` stage. Use signature here to avoid
    // false-positives on legitimate skill exploration (different
    // skill names through `skill_view` shouldn't trigger).
    if (this.stage === 'none' && this.consecSignature.count >= this.hintConsec) {
      this.stage = 'hinted';
      const decision: RecoveryDecision = {
        kind:        'hint',
        toolName:    name,
        consecutive: this.consecSignature.count,
        hintMessage: buildHintMessage(name, this.consecSignature.count),
      };
      this.recoveryEvents.push({ stage: 'hinted', toolName: name, count: this.consecSignature.count, ts });
      return decision;
    }

    // v4.13 — varied-args SUCCESSFUL streak soft ceiling: ONE
    // informational hint at the (high) varied threshold. Bulk work is
    // legal; this only nudges the model to sanity-check its progress.
    if (this.stage === 'none' && this.consecName.count >= this.variedHintConsec) {
      this.stage = 'hinted';
      const decision: RecoveryDecision = {
        kind:        'hint',
        toolName:    name,
        consecutive: this.consecName.count,
        hintMessage:
          `[note] You have called ${name} ${this.consecName.count} times in a row with varying arguments. ` +
          `If this is intentional bulk work, continue — otherwise pause and verify progress against the goal.`,
      };
      this.recoveryEvents.push({ stage: 'hinted', toolName: name, count: this.consecName.count, ts });
      return decision;
    }

    return { kind: 'allow', consecutive: this.consecName.count };
  }

  /**
   * Tools currently cooled-down. Agent filters these out of the
   * tool schemas passed to the next provider call so the model
   * literally cannot request them.
   */
  getCooledDownTools(): string[] {
    if (!this.enabled) return [];
    return [...this.cooledDownTools.keys()];
  }

  /**
   * Called once per agent loop iteration. Decrements each cooled-
   * down tool's remaining-iteration counter; drops tools that have
   * served their cooldown. No-op when disabled.
   */
  advanceIteration(): void {
    if (!this.enabled) return;
    for (const [name, remaining] of this.cooledDownTools.entries()) {
      if (remaining <= 1) {
        this.cooledDownTools.delete(name);
      } else {
        this.cooledDownTools.set(name, remaining - 1);
      }
    }
  }

  // ── Phase 4 — checkpoint / restore API ─────────────────────────────────

  /**
   * Capture the state going INTO an iteration's tool dispatch. Called
   * by the agent loop after the assistant message is pushed but
   * before the for-each-tool dispatch loop begins. The captured
   * `messages` argument is shallow-cloned (item references shared;
   * the array reference is new — items are treated as immutable
   * Message objects downstream).
   *
   * No-op when TCE is disabled (opt-out via `AIDEN_TCE=0`) OR when
   * `checkpointDepth === 0`.
   * Ring-buffer rolls over once depth is exceeded.
   */
  captureCheckpoint(messages: ReadonlyArray<Message>, iteration: number): void {
    if (!this.enabled || this.checkpointDepth === 0) return;
    const checkpoint: Checkpoint = {
      iteration,
      ts: Date.now(),
      messages: [...messages],
      turnStateSnapshot: this.captureInternalSnapshot(),
      containedMutations: false,
      mutatingToolsSinceCheckpoint: [],
    };
    this.checkpoints.push(checkpoint);
    while (this.checkpoints.length > this.checkpointDepth) {
      this.checkpoints.shift();
    }
  }

  /**
   * Flag the LIVE checkpoint (the most recently captured one) as
   * having seen a mutating tool dispatch. Called by the agent loop
   * just before dispatching any tool with `ToolHandler.mutates ===
   * true`. Sets `containedMutations` on the live checkpoint AND on
   * every older checkpoint that's still in the ring buffer — those
   * older checkpoints would otherwise be eligible for rollback even
   * though the iterations between them contained mutating tools.
   *
   * No-op when disabled or when the ring buffer is empty.
   */
  markMutationOnLiveCheckpoint(toolName: string): void {
    if (!this.enabled || this.checkpoints.length === 0) return;
    // Mark every checkpoint currently in the buffer — rolling back to
    // ANY of them would require un-doing this mutation.
    for (const cp of this.checkpoints) {
      if (!cp.containedMutations) {
        // Re-assign with mutated copy; Checkpoint fields are typed
        // readonly on the public type but we own them internally.
        (cp as { containedMutations: boolean }).containedMutations = true;
      }
      const mutating = cp.mutatingToolsSinceCheckpoint as string[];
      if (!mutating.includes(toolName)) {
        mutating.push(toolName);
      }
    }
  }

  /**
   * Find the most recent checkpoint that's safe to roll back to. A
   * checkpoint is safe when `containedMutations === false` — no
   * mutating tool has run since it was captured. Returns null when
   * no such checkpoint exists (caller falls back to plain cooldown
   * per Q-CP3 hard block).
   *
   * Walks the ring buffer from newest to oldest; the first restorable
   * checkpoint is returned. Disabled / empty buffer → null.
   */
  findRestorableCheckpoint(): Checkpoint | null {
    if (!this.enabled || this.checkpoints.length === 0) return null;
    for (let i = this.checkpoints.length - 1; i >= 0; i -= 1) {
      const cp = this.checkpoints[i];
      if (!cp.containedMutations) return cp;
    }
    return null;
  }

  /**
   * Restore TurnState internals from a previously-captured checkpoint.
   * The caller is responsible for truncating the messages array to
   * `checkpoint.messages.length`. After restore, the ring buffer is
   * trimmed to remove the checkpoint AND every newer entry — those
   * captures correspond to iterations that no longer happened from
   * the controller's perspective.
   *
   * No-op when disabled. Safe to call with a checkpoint that's no
   * longer in the buffer (e.g. dropped by the ring rollover) — the
   * snapshot data is still valid; only the buffer-trimming step is
   * skipped.
   */
  restoreInternalsFrom(checkpoint: Checkpoint): void {
    if (!this.enabled) return;
    const snap = checkpoint.turnStateSnapshot;
    this.stage           = snap.stage;
    this.consecName      = { ...snap.consecName };
    this.consecSignature = { ...snap.consecSignature };
    this.consecFailed    = { ...snap.consecFailed };
    this.cooledDownTools = new Map(snap.cooledDownTools.map(([k, v]) => [k, v]));
    this.toolCalls       = [...snap.toolCalls];
    this.successfulTools = new Set(snap.successfulTools);
    this.recoveryEvents  = [...snap.recoveryEvents];
    this.verifications   = [...snap.verifications];
    this.classifications = [...snap.classifications];
    // Trim the ring buffer to remove `checkpoint` and everything newer.
    const idx = this.checkpoints.indexOf(checkpoint);
    if (idx >= 0) {
      this.checkpoints = this.checkpoints.slice(0, idx);
    }
  }

  /**
   * Read-only view of the live ring buffer. Public for tests + future
   * diagnostic surfaces. Returns a fresh array; mutation is harmless.
   */
  getCheckpoints(): ReadonlyArray<Checkpoint> {
    return [...this.checkpoints];
  }

  /**
   * v4.2 Phase 4 — re-apply a cooldown after a rollback. Called by
   * the agent loop AFTER `restoreInternalsFrom`, because restore
   * replaces `cooledDownTools` with the checkpoint's snapshot (which
   * was captured BEFORE the cooldown decision was emitted).
   *
   * Without this re-apply, the cooldown intent of the recovery
   * decision would be silently dropped post-rollback. We want the
   * NEXT iteration to see the constrained tool schema, which is the
   * whole point of cooldown_with_rollback.
   *
   * Also re-promotes the stage to 'cooldown' so subsequent calls
   * within the same turn don't re-trigger the same recovery
   * (monotonic stage discipline preserved).
   *
   * No-op when disabled.
   */
  reapplyCooldown(toolName: string): void {
    if (!this.enabled) return;
    this.cooledDownTools.set(toolName, this.cooldownIters);
    if (this.stage === 'none' || this.stage === 'hinted') {
      this.stage = 'cooldown';
    }
  }

  /**
   * Internal: capture the current mutable state into an immutable
   * snapshot suitable for embedding in a Checkpoint. Deep-clones
   * Maps + Sets; arrays are shallow-cloned because the items are
   * treated as immutable downstream.
   */
  private captureInternalSnapshot(): TurnStateInternalSnapshot {
    return {
      stage:           this.stage,
      consecName:      { ...this.consecName },
      consecSignature: { ...this.consecSignature },
      consecFailed:    { ...this.consecFailed },
      cooledDownTools: [...this.cooledDownTools.entries()].map(
        ([k, v]) => [k, v] as const,
      ),
      toolCalls:       [...this.toolCalls],
      successfulTools: [...this.successfulTools],
      recoveryEvents:  [...this.recoveryEvents],
      verifications:   [...this.verifications],
      classifications: [...this.classifications],
    };
  }

  // ── Diagnostic snapshot ────────────────────────────────────────────────

  /** Diagnostic snapshot for tests + future debug surfacing. Pure read. */
  getDiagnosticSnapshot(): TurnStateDiagnosticSnapshot {
    return {
      enabled:         this.enabled,
      stage:           this.stage,
      consecName:      { ...this.consecName },
      consecSignature: { ...this.consecSignature },
      consecFailed:    { ...this.consecFailed },
      cooledDownTools: [...this.cooledDownTools.entries()].map(
        ([name, iterationsRemaining]) => ({ name, iterationsRemaining }),
      ),
      toolCalls:       [...this.toolCalls],
      successfulTools: [...this.successfulTools],
      recoveryEvents:  [...this.recoveryEvents],
      verifications:   [...this.verifications],
      classifications: [...this.classifications],
      thresholds: {
        hintConsec:      this.hintConsec,
        cooldownConsec:  this.cooldownConsec,
        surfaceConsec:   this.surfaceConsec,
        cooldownIters:   this.cooldownIters,
        failedConsec:    this.failedConsec,
      },
    };
  }

  /** Build the structured-failure surface card for the chat layer. */
  private buildSurfaceCard(
    loopingTool: string,
    count: number,
  ): NonNullable<RecoveryDecision['surfaceCard']> {
    const canStillItems: string[] = [];
    for (const t of this.successfulTools) {
      if (t === loopingTool) continue;
      canStillItems.push(`Reuse \`${t}\` (called earlier this turn)`);
    }
    if (canStillItems.length === 0) {
      canStillItems.push('Try a different approach without this tool');
    }

    return {
      title:    `Stuck on repeated tool calls`,
      canStill: canStillItems,
      cannotReliably: [
        `Call \`${loopingTool}\` again this turn — fired ${count}× consecutively without making progress`,
      ],
      fix:
        `Rephrase the request to be more specific about which tool/result you want, ` +
        `or try a different angle (e.g. ask for a concrete output rather than discovery).`,
    };
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Stable, canonical hash of tool arguments. Sorts object keys
 * recursively so `{a:1, b:2}` and `{b:2, a:1}` hash identically.
 * sha256 truncated to 12 hex chars — enough collision resistance
 * for the per-turn windows we operate over (~30 calls max).
 *
 * Throws-safe: any serialization failure (circular refs, BigInt
 * values, etc.) falls back to `String(args)`. The trace stays
 * informative even when the args shape is weird.
 */
function canonicalArgsHash(args: unknown): string {
  let serialized: string;
  try {
    serialized = canonicalStringify(args);
  } catch {
    serialized = String(args);
  }
  return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 12);
}

function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

function buildHintMessage(toolName: string, count: number): string {
  return (
    `[tce] You've called \`${toolName}\` ${count} times in a row with the same arguments. ` +
    `This looks like a loop. Reconsider your approach — try a different tool, change the arguments, ` +
    `or answer with what you know if no tool will make progress.`
  );
}

/**
 * v4.2 Phase 1 — verifier-driven hint. Different framing from the
 * signature-based hint: this one says "your call is failing" rather
 * than "your call is repeating", which is the more accurate diagnosis
 * when the failure streak triggers.
 */
function buildFailedHintMessage(
  toolName: string,
  count: number,
  verification?: VerificationResult,
): string {
  const reason = verification?.reason ? ` Latest reason: "${verification.reason}".` : '';
  const suggestion = verification?.suggestion ? ` ${verification.suggestion}` : '';
  return (
    `[tce] \`${toolName}\` has failed ${count} times in a row.${reason} ` +
    `Stop retrying it unchanged — change the arguments, switch to a different tool, ` +
    `or answer with what you have if no tool can make progress.${suggestion}`
  );
}

function buildCooldownMessage(toolName: string, cooldownIters: number): string {
  return (
    `[tce] \`${toolName}\` is now disabled for the next ${cooldownIters} iteration(s) because it's been ` +
    `called repeatedly without making progress. Use a different tool or answer with what you have.`
  );
}
