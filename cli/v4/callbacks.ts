/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/callbacks.ts — Aiden v4.0.0 (Phase 14b)
 *
 * CLI-side implementations of the moat callback contracts. Wired up in
 * Phase 14c when AidenAgent is constructed; each callback is otherwise
 * self-contained so unit tests don't need a chat REPL.
 *
 * prompt callbacks. Aiden v4 trims the scope to what Phase 14b needs:
 * approval prompts, smart-mode risk assessment, skill-teacher proposals,
 * planner-guard / compression / budget notices. Clarify + sudo arrive in
 * v4.1 alongside the multi-pane TUI.
 */

import type { Display, ToolRowHandle } from './display';
import { boxBottom, boxLine, boxTopTitled } from './box';
import type {
  ApprovalRequest,
  ApprovalDecision,
  RiskTier,
} from '../../moat/approvalEngine';
import type { SkillProposal } from '../../moat/skillTeacher';
import type { PlannerGuardDecision } from '../../moat/plannerGuard';
import type { CompressionResult } from '../../core/v4/contextCompressor';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { ToolCallRequest, ToolCallResult, CapabilityCardData } from '../../providers/v4/types';
// v4.3 Phase 3 — manual-blocker surface. The BlockerSurface type
// lives in tools/v4/browser/browserBlocker.ts; we import the type
// here for the renderer + the structural mapping helper below.
import type { BlockerKind, BlockerSurface } from '../../tools/v4/browser/browserBlocker';
// v4.8.0 Slice 5 — verbose-mode gate for internal-telemetry dim lines.
import { isVerbose, glyphs } from './design/tokens';
import type { ColorKind } from './skinEngine';
/* Phase 23.6 rollback — Ink controller bridge stashed to
 * docs/sprint/_internal/v4.1-ink-stash/.  Re-introduce when v4.1 picks
 * up the Ink rebuild. */

export type VerboseMode = 'compact' | 'normal' | 'verbose';

export interface CliCallbacksOptions {
  display: Display;
  auxiliaryClient?: AuxiliaryClient;
  verboseMode?: VerboseMode;
  /** Injectable inquirer module for tests. */
  promptModule?: PromptApi;
  /**
   * v4.1.6 Polish 2 — optional SkillTeacher reference so the
   * `handleSkillProposal` callback can finalize an accepted
   * proposal (build markdown + persist via skillManager). When
   * absent, `handleSkillProposal` returns `{created: false}` —
   * the proposal is announced via dim notice only, no save path.
   *
   * AidenCLI wires this; test harnesses that don't construct a
   * real SkillTeacher can omit it.
   */
  skillTeacher?: import('../../moat/skillTeacher').SkillTeacher;
}

export interface PromptApi {
  select(opts: {
    message: string;
    choices: { name: string; value: string }[];
  }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

async function defaultPrompts(): Promise<PromptApi> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async select(opts) {
      return inq.select(opts);
    },
    async confirm(opts) {
      return inq.confirm(opts);
    },
  };
}

// Tier-3-essentials: terse 4-state ladder labels per dispatch.
// Once / Session / Always / Deny — same underlying ApprovalDecision
// values, friendlier wording. Persistence to <aidenHome>/approvals.json
// is wired in aidenCLI.ts via approvalEngine.callbacks.persistAllow
// (Phase 16f); session-scope cache in approvalEngine.allowForSession.
/**
 * v4.10 Slice 10.6c — dynamic qualifier for Session/Always labels.
 *
 * Pre-10.6c the picker offered bare `Session` and `Always`, which
 * users read as TEMPORAL scopes ("for this conversation") but the
 * engine treats as SIGNATURE scopes (this exact tool::primary-arg).
 * A Session grant for `file_write test3.txt` does NOT cover
 * `file_write test4.txt`, which surprised the smoke tester.
 *
 * Fix: surface what the scope actually covers. The qualifier
 * mirrors `argSignature()`'s primary-arg extractor in
 * `moat/approvalEngine.ts`, in priority order — `command` >
 * `path` > `url` > `code`. Fallback "this call" covers tools that
 * don't expose any of those as their primary arg.
 *
 * Behaviour change: zero. Same four decision verbs; only the
 * picker labels differ. Users still get a Once / Session / Always
 * / Deny choice; the qualifier just makes the scope concrete.
 */
function primaryArgKindFor(args: Record<string, unknown>): string {
  // Order matches argSignature()'s priority chain.
  if (typeof args.command === 'string') return 'this command';
  if (typeof args.path    === 'string') return 'this path';
  if (typeof args.url     === 'string') return 'this url';
  if (typeof args.code    === 'string') return 'this code';
  return 'this call';
}

function decisionChoicesFor(args: Record<string, unknown>): { name: string; value: ApprovalDecision }[] {
  const kind = primaryArgKindFor(args);
  return [
    { name: 'Once',                     value: 'allow' },
    { name: `Session (${kind})`,        value: 'allow_session' },
    { name: `Always (${kind})`,         value: 'allow_always' },
    { name: 'Deny',                     value: 'deny' },
  ];
}

const KNOWN_TIERS: ReadonlySet<RiskTier> = new Set(['safe', 'caution', 'dangerous']);

// ── v4.3 Phase 3 — manual-blocker card mapping ────────────────────────────

/** Best-effort hostname extraction; falls back to the raw URL. */
function blockerHostname(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * Map a BlockerSurface to the existing CapabilityCardData chrome.
 * Pure helper — same shape per `BlockerKind`, parameterised by the
 * blocker's URL + optional subtype for the body text. The renderer
 * (`display.capabilityCard`) handles all rendering chrome; this
 * function only fills the slots semantically.
 *
 * Public for unit tests; chatSession + callbacks consume via the
 * `renderBlockerCardIfPresent` method below.
 */
export function mapBlockerToCard(blocker: BlockerSurface): CapabilityCardData {
  const host = blockerHostname(blocker.url);
  const labels: Record<BlockerKind, {
    title:    string;
    canStill: string[];
    cannot:   string[];
    fix:      string;
  }> = {
    captcha: {
      title:    `CAPTCHA challenge at ${host}`,
      canStill: ['Solve the challenge in the browser tab', 'Cancel this task'],
      cannot:   ['Continue automatically without your action'],
      fix:      `I'll wait — solve the ${blocker.subtype ?? 'CAPTCHA'} challenge and tell me when ready.`,
    },
    login: {
      title:    `Sign-in required at ${host}`,
      canStill: ['Sign in via the browser tab', 'Cancel this task'],
      cannot:   ['Continue without authentication'],
      fix:      `I'll wait — sign in and let me know when done.`,
    },
    '2fa': {
      title:    `Two-factor code required at ${host}`,
      canStill: ['Enter the 2FA code in the browser tab', 'Cancel this task'],
      cannot:   ['Continue without the verification code'],
      fix:      `I'll wait — enter your code and tell me when complete.`,
    },
    verification: {
      title:    `Identity verification at ${host}`,
      canStill: ['Complete the verification in the browser', 'Cancel this task'],
      cannot:   ['Continue without verification'],
      fix:      `I'll wait — finish the verification and tell me when done.`,
    },
    consent: {
      title:    `Consent banner at ${host}`,
      canStill: ['Dismiss the banner in the browser', 'Continue if banner is dismissable'],
      cannot:   ['Reliably interact with content while the banner blocks it'],
      fix:      `Dismiss the cookie or privacy banner and I'll retry.`,
    },
  };
  const t = labels[blocker.kind];
  return {
    title:          `🛑 ${t.title}`,
    canStill:       t.canStill,
    cannotReliably: t.cannot,
    fix:            t.fix,
  };
}

function parseRiskTier(content: string): RiskTier {
  const head = content.trim().toLowerCase().split(/\s+/)[0] ?? '';
  // Strip punctuation that might bleed in from JSON: "safe.", "caution,"...
  const cleaned = head.replace(/[^a-z]/g, '');
  if (KNOWN_TIERS.has(cleaned as RiskTier)) return cleaned as RiskTier;
  return 'caution';
}

export class CliCallbacks {
  private readonly display: Display;
  private readonly auxiliaryClient?: AuxiliaryClient;
  private verboseMode: VerboseMode;
  private promptsPromise: Promise<PromptApi>;

  // Phase 23.5 — tool event row state.
  // `toolRows` and `toolStartTimes` are keyed by ToolCallRequest.id so
  // sequential before/after pairs find each other. Cleared per-call.
  // `beforeFirstToolHook` lets chatSession stop the "thinking…" spinner
  // the moment the first row prints — registered fresh each turn.
  private toolRows = new Map<string, ToolRowHandle>();
  private toolStartTimes = new Map<string, number>();
  private beforeFirstToolHook?: () => void;
  private firstToolFiredThisTurn = false;

  // v4.1.4 reply-quality polish — Part 1.6 activity indicator hooks.
  //
  // chatSession registers a pair of hooks per turn so the indicator
  // pauses while a tool row owns the screen and resumes (with a fresh
  // verb derived from the just-completed tool) in the gap that
  // follows. Both are optional — non-streaming non-indicator callers
  // get the v4.1.3 behaviour unchanged.
  private beforeToolHook?:    () => void;
  private afterEachToolHook?: (toolName: string) => void;

  // v4.1.5 Issue K — phase-verb hook. AidenCLI's `onMemoryRefreshStart`,
  // `onPromptBuilt`, `onProviderRequestStart` agent-option callbacks
  // route to `firePhaseVerb(verb)` here; chatSession registers a fn
  // that calls `indicator.setVerb(verb)` on the per-turn indicator.
  // Single setter (one fn) rather than three because the indicator
  // only cares about the current phase verb — older phases are no
  // longer meaningful once a newer one fires.
  private phaseVerbHook?: (verb: string) => void;

  // v4.1.5+ Path A — tool-trace hooks for the loop-trace logger.
  // Fire alongside the existing tool-row + indicator-pause machinery
  // but capture the full call id + args (the indicator hooks only see
  // the tool name). Hidden tools (TRAIL_HIDE_TOOLS) DO fire through
  // here — the trace must see them even when the visible trail
  // doesn't, since `lookup_tool_schema` is exactly the kind of tool
  // that participates in loop patterns.
  private toolTraceBeforeHook?: (id: string, name: string) => void;
  private toolTraceAfterHook?:  (id: string, name: string, args: unknown) => void;

  // v4.1.6 Polish 2 — optional SkillTeacher reference for the
  // post-render `handleSkillProposal` flow (see method below).
  // NOT readonly: aidenCLI sets it post-construction via
  // `setSkillTeacher(...)` because the teacher is built AFTER the
  // CliCallbacks instance during boot.
  private skillTeacher?: import('../../moat/skillTeacher').SkillTeacher;

  constructor(opts: CliCallbacksOptions) {
    this.display = opts.display;
    this.auxiliaryClient = opts.auxiliaryClient;
    this.verboseMode = opts.verboseMode ?? 'normal';
    this.promptsPromise = opts.promptModule
      ? Promise.resolve(opts.promptModule)
      : defaultPrompts();
    this.skillTeacher = opts.skillTeacher;
  }

  /**
   * v4.1.6 Polish 2 — late-wire the SkillTeacher reference. aidenCLI
   * constructs CliCallbacks early (the approval engine needs it
   * stitched in), but SkillTeacher is built later in the boot
   * sequence after skillLoader / skillManager are ready. Call this
   * once after both exist so `handleSkillProposal` can persist
   * accepted proposals.
   */
  setSkillTeacher(teacher: import('../../moat/skillTeacher').SkillTeacher): void {
    this.skillTeacher = teacher;
  }

  /** Update verbose mode at runtime (wired to /verbose). */
  setVerboseMode(mode: VerboseMode): void {
    this.verboseMode = mode;
  }

  /**
   * Phase 23.5 — chatSession registers a one-shot hook here at the top
   * of each turn (typically `() => spinner.stop()`). Fires once just
   * before the first tool row of the turn prints. Cleared internally
   * after firing; chatSession re-registers next turn.
   */
  setBeforeFirstToolHook(fn?: () => void): void {
    this.beforeFirstToolHook = fn;
    this.firstToolFiredThisTurn = false;
  }

  /**
   * v4.1.4 reply-quality polish — Part 1.6.
   *
   * Register paired hooks so chatSession can pause the activity
   * indicator while a tool row writes, and resume it (with a fresh
   * verb derived from the just-completed tool) in the gap before the
   * next tool fires or the final reply arrives.
   *
   * Both fire for EVERY tool, not just the first. Either can be
   * omitted independently. Cleared between turns by passing `undefined`.
   */
  setActivityIndicatorHooks(opts: {
    beforeTool?:    () => void;
    afterEachTool?: (toolName: string) => void;
  }): void {
    this.beforeToolHook    = opts.beforeTool;
    this.afterEachToolHook = opts.afterEachTool;
  }

  /**
   * v4.1.5 Issue K — set/clear the phase-verb sink. chatSession
   * registers a closure that captures the per-turn indicator handle
   * and forwards calls to `indicator.setVerb(verb)`. Cleared between
   * turns by passing `undefined`. Optional — non-indicator callers
   * (test harnesses with stub displays) get no-op behaviour.
   */
  setPhaseVerbHook(fn?: (verb: string) => void): void {
    this.phaseVerbHook = fn;
  }

  /**
   * v4.1.5+ Path A — register a per-turn tool-trace sink for the
   * loop-trace logger. `before` fires with the call's id+name BEFORE
   * the row writes; `after` fires post-execution with the same id +
   * the call's args (for skill-name extraction in trace context).
   * Cleared between turns by passing `undefined`.
   *
   * Separate from `setActivityIndicatorHooks` because the activity
   * hook is name-only and fires for visible-trail purposes; this
   * one captures FULL call data including hidden tools (which the
   * trail suppresses via TRAIL_HIDE_TOOLS but the trace must see).
   */
  setToolTraceHook(opts: {
    before?: (id: string, name: string) => void;
    after?:  (id: string, name: string, args: unknown) => void;
  }): void {
    this.toolTraceBeforeHook = opts.before;
    this.toolTraceAfterHook  = opts.after;
  }

  // v4.1.5 Issue K — `firePhaseVerb` is the public entry point for the
  // AidenCLI bridge. AidenAgent fires `onMemoryRefreshStart` etc.,
  // aidenCLI's adapter calls into one of these `onPhase…` shims, each
  // mapping a lifecycle event to a verb string. Defensive try/catch so
  // a misbehaving display sink can't unwind the agent loop.
  onMemoryRefreshStart = (): void => {
    try { this.phaseVerbHook?.('refreshing memory'); } catch { /* defensive */ }
  };
  onPromptBuilt = (_info: { tools: number; skills: number; memoryFacts: number }): void => {
    try { this.phaseVerbHook?.('preparing prompt'); } catch { /* defensive */ }
  };
  onProviderRequestStart = (_providerId: string): void => {
    try { this.phaseVerbHook?.('calling provider'); } catch { /* defensive */ }
  };

  /**
   * Phase 23.5 — bound to AidenAgent.onToolCall. Emits one event row
   * per tool call: prints `[running]` on `before`, mutates the bracket
   * to `[ok N ms]` / `[fail N ms]` / `[blocked]` on `after`. Recognises
   * the URL-provenance gate's terminal error and surfaces it as the
   * Aiden-specific `[blocked]` cluster instead of a generic fail.
   */
  onToolCall = (
    call: ToolCallRequest,
    phase: 'before' | 'after',
    result?: ToolCallResult,
  ): void => {
    if (phase === 'before') {
      if (!this.firstToolFiredThisTurn) {
        this.firstToolFiredThisTurn = true;
        try {
          this.beforeFirstToolHook?.();
        } catch {
          /* hook errors must not block tool dispatch */
        }
        this.beforeFirstToolHook = undefined;
      }
      // v4.1.4 reply-quality polish — Part 1.6. Pause activity
      // indicator BEFORE the tool row writes so the indicator's line
      // is clean when the row lands. Fires for every tool, not just
      // the first. Defensive try/catch — a misbehaving hook must not
      // block tool dispatch.
      try { this.beforeToolHook?.(); } catch { /* defensive */ }
      // v4.1.5+ Path A — fire the loop-trace sink BEFORE row writes.
      // Captures every tool's call.id + name (including hidden ones
      // suppressed from the visible trail) so the trace covers the
      // full agent loop, not just user-visible work.
      try { this.toolTraceBeforeHook?.(call.id, call.name); } catch { /* defensive */ }
      const handle = this.display.toolRow(call.name, call.arguments);
      this.toolRows.set(call.id, handle);
      this.toolStartTimes.set(call.id, Date.now());
      return;
    }
    // 'after'
    const handle = this.toolRows.get(call.id);
    const startedAt = this.toolStartTimes.get(call.id);
    this.toolRows.delete(call.id);
    this.toolStartTimes.delete(call.id);
    if (!handle || startedAt === undefined) {
      // Even if we lost the handle, the indicator may still need to
      // be re-armed so the next gap shows activity. Tool-name-aware
      // verb selection happens in the hook itself.
      try { this.afterEachToolHook?.(call.name); } catch { /* defensive */ }
      // v4.1.5+ Path A — loop-trace sink fires even when handle was
      // lost (rare; happens if before/after pairing slipped) so the
      // trace never under-counts tool calls.
      try {
        this.toolTraceAfterHook?.(call.id, call.name, call.arguments);
      } catch { /* defensive */ }
      return;
    }
    const ms = Date.now() - startedAt;
    const err = result?.error;
    if (typeof err === 'string' && err.includes('URL provenance gate')) {
      handle.blocked();
      // v4.1.5+ Path A — blocked path still needs the trace sink so
      // the URL-provenance failure mode shows up in loop diagnostics.
      try {
        this.toolTraceAfterHook?.(call.id, call.name, call.arguments);
      } catch { /* defensive */ }
      return;
    }
    // v4.3 Phase 3 — render a structured "agent needs human help"
    // card when the browser observer detected a manual blocker
    // (CAPTCHA / login / 2FA / verification / consent). Renders for
    // ALL trail-row outcomes below — the blocker is independent of
    // the tool's own success/fail signal. Inline placement gives
    // the user immediate awareness; the model's next reply will
    // explain in prose. Defensive: missing fields silently skip.
    try { this.renderBlockerCardIfPresent(result); } catch { /* defensive */ }
    // v4.1.4 reply-quality polish — Part 1.6. Helper used by ALL
    // outcome branches below so the activity indicator gets re-armed
    // for the gap that follows this tool (next tool, or final reply).
    // Tool-name-aware verb selection happens in the hook (chatSession
    // wires it through `verbForActivity`).
    const fireAfter = (): void => {
      try { this.afterEachToolHook?.(call.name); } catch { /* defensive */ }
      // v4.1.5+ Path A — also fire the loop-trace `after` sink so the
      // tracer can compute duration + capture args (hidden-from-trail
      // tools still flow through here, by design — the trace must see
      // them to detect lookup_tool_schema / skill_view loops).
      try {
        this.toolTraceAfterHook?.(call.id, call.name, call.arguments);
      } catch { /* defensive */ }
    };

    if (typeof err === 'string' && err.includes('URL provenance gate')) {
      handle.blocked();
      fireAfter();
      return;
    }
    if (err) {
      handle.fail(ms);
      // v4.1.3-essentials: when the tool's failure payload includes a
      // structured capability card (auth missing, platform unsupported),
      // render the card immediately after the fail row. The card sits
      // on its own multi-line block — the fail row is still useful as
      // the action timeline anchor; the card adds the state assessment
      // the user actually needs. No card → plain failure surface.
      if (result?.capabilityCard) {
        this.display.capabilityCard(result.capabilityCard);
      }
      fireAfter();
      return;
    }
    // v4.1.3-repl-polish: degraded outcome — tool completed but with a
    // partial / best-effort result. Show in trail yellow instead of silent.
    if (result?.degraded) {
      handle.degraded(ms, result.degradedReason);
      fireAfter();
      return;
    }
    handle.ok(ms);
    fireAfter();
  };

  /**
   * v4.3 Phase 3 — render a manual-blocker card when the browser
   * observer detected a CAPTCHA / login / 2FA / verification /
   * consent surface on the page. Reuses the existing capabilityCard
   * chrome via a `mapBlockerToCard` semantic mapping — no new layout
   * code, no new dedicated card component.
   *
   * Defensive: silently skips when the field shape doesn't match
   * (no browserState, no blocker, unrecognised kind). Never throws
   * — caller wraps in try/catch defensively.
   *
   * The blocker info is structural data emitted by the observer
   * HOC (`tools/v4/browser/_observer.ts`); the renderer reads it
   * from `result.result.browserState.blocker` after every browser
   * tool call. Inline placement gives users immediate awareness
   * before the model's next reply lands.
   */
  private renderBlockerCardIfPresent(result?: ToolCallResult): void {
    const inner = (result?.result ?? null) as
      | { browserState?: { blocker?: BlockerSurface } }
      | null;
    const blocker = inner?.browserState?.blocker;
    if (!blocker) return;
    this.display.capabilityCard(mapBlockerToCard(blocker));
  }

  /** ApprovalEngine.callbacks.promptUser */
  promptApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    // Phase 22 Task 5B: yellow-bordered rounded box for emphasis.
    // Yellow distinguishes the awaiting-attention state from the
    // brand-orange (informational) frames used by setup-complete and
    // /doctor.
    this.display.write(renderApprovalBox(req, this.display) + '\n');

    const prompts = await this.promptsPromise;
    let choice: string;
    try {
      // v4.10 Slice 10.6c — labels carry an arg-kind qualifier so
      // users understand the scope is signature-bound, not temporal.
      // Computed per-call from req.args (same priority order as
      // argSignature's primary-arg extractor).
      choice = await prompts.select({
        message: 'Decision',
        choices: decisionChoicesFor(req.args),
      });
    } catch {
      // User hit Ctrl+C or otherwise cancelled — fail closed.
      return 'deny';
    }
    return choice as ApprovalDecision;
  };

  /** ApprovalEngine.callbacks.riskAssess */
  riskAssess = async (
    req: ApprovalRequest,
  ): Promise<{ tier: RiskTier; rationale: string }> => {
    if (!this.auxiliaryClient) {
      return { tier: 'caution', rationale: 'no auxiliary client wired' };
    }
    const prompt = `Classify this tool call into one of: safe, caution, dangerous.
Tool: ${req.toolName}
Category: ${req.category}
Args: ${JSON.stringify(req.args).slice(0, 400)}

Reply with ONE word: safe, caution, or dangerous.`;
    const result = await this.auxiliaryClient.call({
      purpose: 'risk_assess',
      prompt,
      maxTokens: 8,
    });
    if (!result.content) {
      return { tier: 'caution', rationale: 'empty auxiliary response' };
    }
    const tier = parseRiskTier(result.content);
    return { tier, rationale: result.content.trim() };
  };

  /** SkillTeacher.callbacks.promptUser */
  promptSkillProposal = async (proposal: SkillProposal): Promise<boolean> => {
    // Phase 23.5: dividers removed — blank lines carry the boundary.
    this.display.write('\n');
    this.display.info(`Skill suggestion: ${proposal.proposedName}`);
    this.display.dim(`  ${proposal.description}`);
    if (proposal.toolsUsed.length > 0) {
      this.display.dim(`  tools: ${proposal.toolsUsed.join(', ')}`);
    }
    this.display.dim(`  confidence: ${proposal.confidence.toFixed(2)}`);
    this.display.write('\n');

    const prompts = await this.promptsPromise;
    try {
      return await prompts.confirm({
        message: 'Save this as a reusable skill?',
        default: false,
      });
    } catch {
      return false;
    }
  };

  /**
   * PlannerGuard sink. v4.1.4 Phase 3b' (Q-Planner): moved to
   * verbose-only. The default `normal` mode previously emitted
   * `[planner] kept N tools (reason)` mid-execution, which collided
   * visually with the activity indicator's single-line paint and
   * with streamed deltas. Users running with the default verbose
   * level should see a clean execution surface — planner-guard
   * decisions are useful for debugging but noise during normal use.
   *
   * `verbose` mode keeps the full breakdown for debugging. `compact`
   * stays silent (unchanged).
   */
  onPlannerGuardDecision = (decision: PlannerGuardDecision): void => {
    if (this.verboseMode === 'compact') return;
    if (this.verboseMode !== 'verbose') return;
    if (decision.reason === 'no_filter') return;
    const conf =
      decision.confidence !== undefined
        ? ` (conf ${decision.confidence.toFixed(2)})`
        : '';
    this.display.dim(
      `[planner] ${decision.reason}${conf}: kept ${decision.selectedTools.length} / dropped ${decision.excludedTools.length}`,
    );
  };

  /**
   * Phase v4.1-skill-mining — post-turn cue when the miner has
   * staged a candidate for `/skills review`. Single dim line, no
   * modal. Pulls the skill name + confidence from the candidate's
   * own SKILL.md (best-effort parse; falls back to id slice).
   */
  onSkillCandidate = (candidate: {
    id:                  string;
    candidateConfidence: number;
    skillContent:        string;
  }): void => {
    // v4.8.0 Slice 5 — internal-telemetry cue; user already discovers
    // candidates via /skills review. Surface only in verbose mode.
    if (!isVerbose()) return;
    let name = candidate.id.slice(0, 8);
    try {
      const m = /\bname\s*:\s*([^\n]+)/.exec(candidate.skillContent);
      if (m) name = m[1].trim();
    } catch { /* fall through */ }
    const conf = candidate.candidateConfidence.toFixed(2);
    this.display.dim(
      `[skill] candidate '${name}' queued (conf ${conf}) — run /skills review`,
    );
  };

  /** ContextCompressor sink — always shows. */
  onCompression = (result: CompressionResult): void => {
    if (result.refused) {
      this.display.dim('[compress] refused — conversation too short');
      return;
    }
    if (result.error) {
      this.display.warn('[compress] auxiliary call failed; history unchanged');
      return;
    }
    // v4.8.0 Slice 5 — successful auto-compress is technical telemetry
    // (refused / failed variants stay visible since they explain action
    // outcomes; success is just bookkeeping).
    if (!isVerbose()) return;
    this.display.dim(
      `[compress] removed ${result.removedMessageCount} msgs, kept ${result.preservedRecentCount} recent (~${result.summaryTokens} tok)`,
    );
  };

  /** Budget warning sink. Caution = dim line, warning = visible warn. */
  onBudgetWarning = (
    level: 'caution' | 'warning',
    turn: number,
    max: number,
  ): void => {
    const msg = `Turn ${turn}/${max}`;
    if (level === 'warning') {
      this.display.warn(`Budget: ${msg} — approaching the cap.`);
    } else if (isVerbose()) {
      // v4.8.0 Slice 5 — caution-level per-turn dim line is verbose-only;
      // the actionable 'warning' tier above continues to fire unchanged.
      this.display.dim(`[budget] ${msg}`);
    }
  };

  /**
   * Phase 16d: memory refresh sink. Fires once per turn after the agent
   * rebuilds the system prompt against fresh MEMORY.md / USER.md content.
   * The "✓ Saved" confirmation that the user sees is rendered separately
   * by the chat loop right after `memory_add` returns `verified=true` —
   * this hook is the diagnostic counterpart for verbose mode.
   */
  onMemoryRefresh = (files: ReadonlyArray<'memory' | 'user' | 'soul'>): void => {
    // Phase v4.1.2: argument switched from single-string-or-'both' to
    // the full sorted set of dirty files (SOUL.md joined the rotation).
    // v4.8.0 Slice 5 — internal cache refresh; the user's "✓ Saved"
    // confirmation lands separately when memory_add returns verified=true.
    if (!isVerbose()) return;
    const label = files.length > 0 ? files.join(', ') : 'none';
    this.display.dim(`[memory] refreshed system prompt (${label})`);
  };

  /**
   * v4.1.6 Polish 2 — post-turn skill-proposal handler.
   *
   * chatSession calls this AFTER `agentTurn` has rendered the agent's
   * reply on screen. Internally:
   *   1. Reuses `promptSkillProposal` (the existing inquirer modal)
   *      to ask the user "Save this as a reusable skill? Yes/No".
   *   2. If accepted AND a SkillTeacher reference is wired, calls
   *      `skillTeacher.handleProposal({...skipPrompt})` to build
   *      the markdown + persist via skillManager.
   *   3. Returns the result so chatSession can surface a confirmation
   *      line if needed.
   *
   * Decoupled from the agent's `runConversation` so the inquirer no
   * longer fires mid-turn (the v4.1.5 visual-smoke regression).
   *
   * Defensive — exceptions in any step return `{created: false,
   * reason: 'error'}` so a misbehaving prompt or save can't break
   * the chat loop. The inquirer modal itself catches input-stream
   * exceptions via the existing try/catch in promptSkillProposal.
   */
  handleSkillProposal = async (
    proposal: SkillProposal,
  ): Promise<{ created: boolean; skillName?: string; reason?: string }> => {
    // Step 1: ask the user (reuses existing modal).
    let accept: boolean;
    try {
      accept = await this.promptSkillProposal(proposal);
    } catch {
      return { created: false, reason: 'prompt_error' };
    }
    if (!accept) {
      return { created: false, reason: 'declined' };
    }
    // Step 2: persist via SkillTeacher when available. Test harnesses
    // that don't wire a teacher just get the prompt without the save.
    if (!this.skillTeacher) {
      return { created: false, reason: 'no_skill_teacher_wired' };
    }
    try {
      // Pass `promptUser: undefined` to bypass the modal in
      // `handleProposal` (we already showed it above). The teacher
      // sees tier === 'tier_3_propose' WITHOUT a prompt callback,
      // which it interprets as `no_prompt_callback` and skips the
      // save — so we need to call the create branch directly.
      //
      // SkillTeacher's tier-4 (auto) branch creates without
      // prompting; we reuse that path by passing a stub that always
      // returns true (user already accepted above).
      const result = await this.skillTeacher.handleProposal(proposal, {
        promptUser: async () => true,
      });
      return result;
    } catch (err) {
      return {
        created: false,
        reason:  `create_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

// Tier-3.1 (v4.1-tier3.1): replaced 🟢/🟡/🔴 emoji badges with
// text-state badges. Each badge is 7 visible chars (pad-aligned) so
// approval-prompt rows align across tiers. Plain ANSI SGR colour to
// keep this file dependency-free.
const ANSI_GREEN  = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED    = '\x1b[31m';
const ANSI_RESET  = '\x1b[0m';

function badgeForTier(tier?: RiskTier): string {
  switch (tier) {
    case 'safe':
      return `${ANSI_GREEN}[ALLOW]${ANSI_RESET} safe`;
    case 'caution':
      return `${ANSI_YELLOW}[WARN] ${ANSI_RESET} caution`;
    case 'dangerous':
      return `${ANSI_RED}[DENY] ${ANSI_RESET} dangerous`;
    default:
      return '';
  }
}

// ─── Phase 22 Task 5B — boxed approval prompt ─────────────────────────

const APPROVAL_BOX_WIDTH = 64;
// Args limit kept under the visible content width (BOX_WIDTH minus the
// 1-char gutter on each side and the ` Args: ` label) so the explicit
// ellipsis we append surfaces inside the box. Setting this above the
// visible budget would let `boxLine`'s hard truncation eat the ellipsis
// and the user wouldn't see they were viewing a partial value.
const APPROVAL_ARGS_LIMIT = 50;

/**
 * Render an approval request with the Aiden-native framed-panel chrome
 * (Slice 6) — orange left bar, no closing corners, footer hint always
 * present. Token-sourced from cli/v4/design/tokens.ts. Returns the
 * multi-line string; caller writes it. Args are truncated to
 * APPROVAL_ARGS_LIMIT chars for display only; the full args stay with
 * the tool call. Colour discipline: brand (bar + title + key glyphs),
 * tier-semantic (badge), muted (everything else) — ≤3 distinct colours.
 */
export function renderApprovalBox(req: ApprovalRequest, display: Display): string {
  // v4.8.0 Slice 6 hotfix:
  //   - Drop panel title + tier badge (Phase 2.5 ui_approval_request event
  //     row above already announces the headline + tier-by-colour).
  //   - Lead with structured key/value rows; unify inner-padding so keys
  //     and dividers share the same left edge.
  //   - Footer hint matches the actual inquirer select() mechanic
  //     (arrow-key navigation), not fictional y/a/n keystrokes.
  //   - Leading + trailing blank lines for vertical breathing room
  //     between the event row above and the inquirer picker below.
  const indent = '  ';
  const innerW = APPROVAL_BOX_WIDTH;
  const bar = display.applyColors(glyphs.panel.bar, 'brand');
  const line = (content: string): string => `${indent}${bar}  ${content}`;
  const divider = display.muted(glyphs.chrome.hLine.repeat(innerW - 2));

  let argsPreview = '';
  try { argsPreview = JSON.stringify(req.args); }
  catch { argsPreview = String(req.args); }
  if (argsPreview.length > APPROVAL_ARGS_LIMIT) {
    argsPreview = argsPreview.slice(0, APPROVAL_ARGS_LIMIT - 1) + '…';
  }

  // Key-value rows. Key column padded to 12 cells for vertical alignment.
  const KEY_W = 12;
  const kv = (k: string, v: string): string =>
    `${display.muted(k.padEnd(KEY_W))}${v}`;

  const lines: string[] = [
    line(kv('tool', req.toolName)),
  ];
  if (req.reason) lines.push(line(kv('reason', req.reason)));
  lines.push(line(kv('args', argsPreview)));
  // v4.10 Slice 10.6 — surface fine-grained effects when the tool
  // declared them. Renders as a comma-separated list of flag names
  // (only the truthy ones). Tools without effects keep the pre-10.6
  // four-row layout — no visual regression for un-tagged tools.
  if (req.effects) {
    const e = req.effects;
    const flags: string[] = [];
    if (e.readsFiles)    flags.push('reads-files');
    if (e.writesFiles)   flags.push('writes-files');
    if (e.network)       flags.push('network');
    if (e.externalSpend) flags.push('external-spend');
    if (e.irreversible)  flags.push('irreversible');
    if (flags.length > 0) {
      lines.push(line(kv('effects', flags.join(', '))));
    }
  }
  lines.push(line(divider));
  lines.push(line(display.muted('↑↓ navigate · enter select · esc cancel')));

  // Leading + trailing blank lines: caller already adds one trailing
  // newline, so producing '\n<panel>\n' yields one blank above + one
  // blank below once the caller's own '\n' lands.
  return '\n' + lines.join('\n') + '\n';
}
