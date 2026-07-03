/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/approvalEngine.ts — Aiden v4.0.0
 *
 * The central gate every write/execute tool passes through. Three modes:
 *
 *   manual (default) — every mutating call prompts the user via
 *                      `callbacks.promptUser`. Read tools never gate.
 *   smart            — calls auxiliary `callbacks.riskAssess` for
 *                      flagged commands. safe → auto-allow,
 *                      dangerous → auto-deny, caution → prompt.
 *   off              — YOLO. Everything auto-allows. Decision is
 *                      still logged via `callbacks.onDecision`.
 *
 * Allowlist scoping:
 *   - `allowForSession(tool, sig)`        — cleared on `resetSession()`.
 *   - `allowAlways(tool, sig)`            — fired through the optional
 *                                            `callbacks.persistAllow`
 *                                            sink (Phase 6 ConfigManager
 *                                            wires this up; for Phase 9
 *                                            the in-memory entry is the
 *                                            same as the session list).
 *
 * heartbeat/HTTP approval surface yet; that lands in Phase 14-15 TUI).
 *
 * Status: PHASE 9.
 *
 * v4.12.1 Pillar 2 — the autonomy dial layers ON TOP of these modes: when a
 * resolved `AutonomyPolicy` is installed, the mutating-path decision routes
 * through `decideAutonomy` (the generalised tier-gate) instead of the raw
 * mode logic. A universal `matchesHardBlock` floor runs BEFORE the mode/yolo
 * short-circuit — catastrophic ops are denied even at --yolo.
 */

// Type-only back-edge (ApprovalRequest/RiskTier) is erased at runtime, so
// this value import creates no runtime cycle.
import {
  matchesHardBlock,
  decideAutonomy,
  levelRank,
  type AutonomyPolicy,
} from './autonomy';

export type ApprovalMode = 'manual' | 'smart' | 'off';
export type ApprovalDecision =
  | 'allow'
  | 'deny'
  | 'allow_session'
  | 'allow_always';
export type RiskTier = 'safe' | 'caution' | 'dangerous';
export type ToolCategory =
  | 'read'
  | 'write'
  | 'execute'
  | 'network'
  | 'browser';

/**
 * v4.10 Slice 10.6 — fine-grained effects declaration. Layered ON
 * TOP of the existing 3-axis taxonomy (`category × riskTier × mutates`);
 * effects describe WHAT the tool touches, while category/riskTier
 * describe HOW DANGEROUS the action is. The renderer surfaces these
 * in the approval box so the user knows WHY a tool is gated, not
 * just THAT it is.
 *
 * Slice 10.6 ships the schema field and the render path. Tagging the
 * 67+ existing tools is deferred to Slice 10.6b (a per-tool refinement
 * pass). Tools that don't declare effects show no "Effects:" line —
 * the prompt UX degrades gracefully.
 */
export interface ToolEffects {
  /** Reads files from disk. file_read, file_list, read_pdf. */
  readsFiles?:    boolean;
  /** Writes/mutates files on disk. file_write, mkdir, file_delete. */
  writesFiles?:   boolean;
  /** Hits external networks (HTTP, websockets, MCP). */
  network?:       boolean;
  /** May incur billable cost on a third-party service. */
  externalSpend?: boolean;
  /**
   * Action cannot be cheaply undone: `rm -rf`, force-pushes,
   * irrevocable API calls, file overwrites without backup.
   * Hint for the renderer to escalate visual weight.
   */
  irreversible?:  boolean;
}

export interface ApprovalRequest {
  toolName: string;
  category: ToolCategory;
  args: Record<string, unknown>;
  /** Pre-flagged risk tier from the dangerous-patterns catalog. */
  riskTier?: RiskTier;
  /** Why was this flagged? (description from the matching pattern) */
  reason?: string;
  /**
   * v4.10 Slice 10.6 — fine-grained effects metadata for the
   * specific tool being gated. Comes from the ToolHandler.effects
   * field threaded through the dispatch checkApproval call.
   * Undefined when the tool's author didn't declare effects yet;
   * renderer hides the "Effects:" line in that case.
   */
  effects?: ToolEffects;
  /**
   * v4.4 Phase 4 — dangerous-tier auto-preview. When the executor
   * computed a `buildPreview` for this call (only for dangerous-tier
   * tools with the method defined), the result is forwarded here so
   * the `promptUser` callback can render "this is what would
   * happen" alongside the y/n choices. Opaque structurally to keep
   * the moat → core direction one-way; consumers cast to the
   * imported `WouldExecute` type when they need to read it.
   */
  preview?: unknown;
}

/**
 * v4.10 Slice 10.6 — persisted allowlist entry shape with audit
 * metadata. The pre-10.6 shape was just `{ tool, signature }` with
 * no timestamps. New shape preserves backward-compat: missing
 * `createdAt` / `lastUsedAt` defaults to `Date.now()` on load
 * (one-time migration); next save rewrites the file with full
 * timestamps. `scope` distinguishes global (~/.aiden) from project
 * (<cwd>/.aiden) entries so listing surfaces can group by origin.
 */
export interface AllowlistEntry {
  tool:        string;
  signature:   string;
  /** Epoch ms — when the user first granted this permission. */
  createdAt:   number;
  /** Epoch ms — last time this entry short-circuited a prompt.
   *  Updates on every match so stale entries surface in listings. */
  lastUsedAt:  number;
  /** Which file this entry was loaded from. Drives the listing
   *  display and dictates the write path for refresh updates. */
  scope:       'global' | 'project';
}

export interface ApprovalCallbacks {
  /** Called when the user must decide. CLI implements this with a prompt. */
  promptUser?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Smart-mode auxiliary risk assessment (auxiliary LLM). */
  riskAssess?: (req: ApprovalRequest) => Promise<{
    tier: RiskTier;
    rationale: string;
  }>;
  /** Logging hook — fired AFTER every decision (allow or deny). */
  onDecision?: (req: ApprovalRequest, decision: ApprovalDecision) => void;
  /**
   * v4.9.0 Slice 12b — fired BEFORE the engine decides. Observer-only;
   * the engine ignores the return value. Wiring path: `aiden hooks`
   * subsystem fires `approval.requested` so registered hooks can
   * observe (but not preempt) tool-approval gates.
   */
  onRequested?: (req: ApprovalRequest) => void;
  /** Permanent-allowlist sink. Phase 6 ConfigManager wires this up. */
  persistAllow?: (toolName: string, argSignature: string) => void;
  /**
   * v4.8.0 Phase 2.5 — semantic ui_* event sink. The engine fires
   * `ui_approval_request` immediately before `promptUser` so the
   * display layer can paint a structured row alongside the existing
   * y/n prompt. Additive only — the y/n flow is unchanged.
   */
  onUiEvent?: (name: string, args: Record<string, unknown>) => void;
}

/**
 * Phase 16f: built-in low-risk tool list — never prompts, never gated by
 * smart-mode classifier. These are read-only or read-mostly tools whose
 * worst case is "exposes information already visible to the user." A
 * read-category short-circuit, but explicit about which tools fall
 * under it.
 *
 * Adding to this list is a deliberate trust call. Don't add anything
 * that mutates filesystem, runs shell, or hits arbitrary URLs.
 */
export const BUILTIN_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'file_read',
  'file_list',
  'fetch_url',
  'web_search',
  'session_search',
  'memory_add',
  'memory_replace',
  'memory_remove',
  'memory_list',
  'system_info',
  'now_playing',
  'browser_screenshot',
  'browser_get_url',
  'open_url', // shell launch to user's default browser — same trust as a link click.
]);

/**
 * Phase 16f: domain allowlist for `browser_navigate`. URLs to these
 * hostnames auto-approve in smart mode; non-allowlisted domains prompt.
 * Mirrors the built-in tool list philosophy — common dev / docs /
 * reference sites the user almost certainly trusts at click level.
 */
export const BUILTIN_SAFE_DOMAINS: ReadonlySet<string> = new Set([
  'google.com',
  'www.google.com',
  'duckduckgo.com',
  'wikipedia.org',
  'en.wikipedia.org',
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'serverfault.com',
  'superuser.com',
  'npmjs.com',
  'www.npmjs.com',
  'pypi.org',
  'crates.io',
  'docs.rs',
  'developer.mozilla.org',
  'taracod.com',
  'www.taracod.com',
]);

/** Extract a hostname from a URL for safe-domain matching. Lowercased. */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Stable signature for an approval request (for allowlist matching). */
export function argSignature(
  toolName: string,
  args: Record<string, unknown>,
): string {
  // Extract the primary mutating argument so we don't bloat the
  // signature with timeouts / cwd / etc. that don't change risk.
  const primary =
    (args.command as string) ??
    (args.path as string) ??
    (args.url as string) ??
    (args.code as string) ??
    '';
  return `${toolName}::${(primary || JSON.stringify(args)).slice(0, 200)}`;
}

/**
 * Phase 20: Pro feature gate that ApprovalEngine consults before batching
 * consecutive same-signature tool calls into a single prompt. Free tier
 * sees one prompt per call (current Phase 16f behaviour); Pro tier can
 * batch via the upcoming N+50 batch-prompt UI. The engine exposes the
 * gate so the prompt UI can decide which mode to render.
 *
 * Kept as an opaque async predicate so the License subsystem owns the
 * cache lookup — ApprovalEngine never imports `core/v4/license` directly,
 * preserving the moat → core dependency direction.
 */
export interface BatchApprovalGate {
  /** True when the user has Pro and the multi_tool_approval feature is on. */
  canBatch(): Promise<boolean>;
}

export class ApprovalEngine {
  private sessionAllow = new Set<string>();
  private permanentAllow = new Set<string>();
  /**
   * v4.10 Slice 10.6 — parallel metadata map keyed by `tool::signature`.
   * Lookups + matching still go through the cheap Set above; this
   * map only carries audit data (createdAt/lastUsedAt/scope) for
   * listing surfaces and refresh-on-reuse semantics.
   */
  private permanentAllowMeta = new Map<string, AllowlistEntry>();
  /**
   * v4.10 Slice 10.6 — refresh callback. When a permanent-allow
   * entry short-circuits a prompt, we bump its lastUsedAt and let
   * the host (aidenCLI) persist the refreshed entry back to disk.
   * Optional; tests can leave it undefined and rely on the in-memory
   * map.
   */
  private refreshSink?: (entry: AllowlistEntry) => void;
  private batchGate?: BatchApprovalGate;
  /**
   * ★ v4.12 SH.1 — frozen-approval property: frozen at boot so in-process code
   * can NOT flip approvals mid-session. After boot the host calls `freeze()`.
   * From then on `setMode()` is a no-op UNLESS the caller passes
   * `{ userInitiated: true }` — the controlled path used by `/yolo` and
   * `--yolo`. This prevents a held ApprovalEngine ref (a tool, a plugin, a
   * compromised code path) from silently disabling approvals.
   */
  private frozen = false;
  /**
   * v4.12.1 Pillar 2 — the installed autonomy policy. When set, the
   * mutating-path decision routes through `decideAutonomy`. Opt-in: when
   * undefined, the legacy mode logic (smart/manual/off) is unchanged.
   */
  private autonomyPolicy?: AutonomyPolicy;
  /**
   * v4.12.1 Pillar 2 — true for a subagent's engine. A child cannot prompt,
   * so an `ask` outcome ESCALATES to the parent (via promptUser, which the
   * child wires to record+deny) rather than a silent deny.
   */
  private subagent = false;

  constructor(
    private mode: ApprovalMode = 'manual',
    private callbacks: ApprovalCallbacks = {},
  ) {}

  /**
   * ★ SH.1 — lock the mode against in-process flips. Idempotent. Called by the
   * host once boot-time mode setup (config default + `--yolo`) is complete.
   */
  freeze(): void {
    this.frozen = true;
  }

  /** Whether the mode is locked against non-user-initiated flips. */
  isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Phase 20 wiring: late-binding installer for the Pro batch-approval
   * gate. Called by `aidenCLI` after the LicenseClient has loaded its
   * cache. ApprovalEngine itself never gates on this — UI consumers ask
   * `getBatchGate()?.canBatch()` and choose batched-vs-per-call rendering.
   */
  setBatchGate(gate: BatchApprovalGate | undefined): void {
    this.batchGate = gate;
  }

  /** Gate accessor for the prompt UI. May be undefined when not wired. */
  getBatchGate(): BatchApprovalGate | undefined {
    return this.batchGate;
  }

  /**
   * ★ SH.1 — after `freeze()`, only a user-initiated call (`{ userInitiated:
   * true }`, from `/yolo` or `--yolo`) may change the mode. Any other
   * post-freeze call is a silent no-op — in-process code can NOT flip approvals.
   * Pre-freeze (boot) calls apply normally.
   */
  setMode(mode: ApprovalMode, opts?: { userInitiated?: boolean }): void {
    if (this.frozen && !opts?.userInitiated) return;
    this.mode = mode;
  }

  getMode(): ApprovalMode {
    return this.mode;
  }

  /**
   * v4.12.1 Pillar 2 — install the resolved autonomy policy. Mirrors SH.1's
   * frozen-approval discipline: after `freeze()`, a change is honoured only
   * when `userInitiated` (the `/autonomy` command), OR when it TIGHTENS the
   * level (lower rank) — in-process / prompt-injected code can never RAISE
   * autonomy. Returns whether the policy was applied.
   */
  setAutonomyPolicy(policy: AutonomyPolicy, opts?: { userInitiated?: boolean }): boolean {
    if (this.frozen && !opts?.userInitiated) {
      const current = this.autonomyPolicy;
      // Non-user callers may only tighten (never raise the level).
      if (current && levelRank(policy.level) > levelRank(current.level)) return false;
    }
    this.autonomyPolicy = policy;
    return true;
  }

  getAutonomyPolicy(): AutonomyPolicy | undefined {
    return this.autonomyPolicy;
  }

  /** Mark this engine as a subagent's — `ask` becomes escalate-to-parent. */
  markSubagent(): void {
    this.subagent = true;
  }

  isSubagentEngine(): boolean {
    return this.subagent;
  }

  allowForSession(toolName: string, signature: string): void {
    this.sessionAllow.add(`${toolName}::${signature}`);
  }

  allowAlways(toolName: string, signature: string): void {
    const key = `${toolName}::${signature}`;
    this.permanentAllow.add(key);
    this.sessionAllow.add(key); // permanent ⊂ session
    // v4.10 Slice 10.6 — seed audit metadata for the new entry. The
    // host (aidenCLI persistAllow callback) writes the timestamped
    // shape to disk; we mirror it in-memory so subsequent
    // listAllowlistEntries() sees a consistent view without a re-read.
    const now = Date.now();
    if (!this.permanentAllowMeta.has(key)) {
      this.permanentAllowMeta.set(key, {
        tool:       toolName,
        signature,
        createdAt:  now,
        lastUsedAt: now,
        scope:      'global',
      });
    } else {
      // Already-known entry got re-granted (rare). Refresh lastUsedAt.
      const existing = this.permanentAllowMeta.get(key)!;
      existing.lastUsedAt = now;
    }
    this.callbacks.persistAllow?.(toolName, signature);
  }

  resetSession(): void {
    this.sessionAllow = new Set(this.permanentAllow);
  }

  /**
   * Phase 16f / v4.10 Slice 10.6: pre-load permanent allowlist
   * entries from a persisted file.
   *
   * Accepts BOTH the pre-10.6 shape `{tool, signature}` and the
   * richer `AllowlistEntry` shape with `createdAt` / `lastUsedAt` /
   * `scope`. Legacy entries lacking timestamps get `Date.now()` as a
   * default — the next persistAllow write will bake the timestamp in.
   * Backward-compat by construction: aidenCLI calls this once at
   * boot with the disk contents; no data migration step required.
   */
  loadPersistentAllowlist(
    entries: ReadonlyArray<{
      tool:        string;
      signature:   string;
      createdAt?:  number;
      lastUsedAt?: number;
      scope?:      'global' | 'project';
    }>,
  ): void {
    const now = Date.now();
    for (const e of entries) {
      const key = `${e.tool}::${e.signature}`;
      this.permanentAllow.add(key);
      this.sessionAllow.add(key);
      // Project entries win on re-load (last-write-wins by load
      // order); aidenCLI loads global FIRST, then project, so the
      // project entry overrides if the same signature exists in both.
      this.permanentAllowMeta.set(key, {
        tool:       e.tool,
        signature:  e.signature,
        createdAt:  e.createdAt  ?? now,
        lastUsedAt: e.lastUsedAt ?? now,
        scope:      e.scope      ?? 'global',
      });
    }
  }

  /**
   * v4.10 Slice 10.6 — install a callback that fires whenever a
   * permanent-allow entry short-circuits a prompt. The host
   * (aidenCLI) wires this to write the refreshed `lastUsedAt` back
   * to disk so the on-disk file stays an accurate audit trail of
   * "what permissions actually got used."
   *
   * Optional. Tests + headless callers leave it unset and only
   * exercise the in-memory map.
   */
  setRefreshSink(sink: (entry: AllowlistEntry) => void): void {
    this.refreshSink = sink;
  }

  /**
   * v4.10 Slice 10.6 — listing surface for the (future) `aiden
   * approvals list` CLI. Returns a snapshot of the in-memory
   * metadata; ordering is the Map's insertion order, which roughly
   * mirrors load order (global, then project). Returned entries are
   * COPIES — mutating them does not affect the engine.
   */
  listAllowlistEntries(): AllowlistEntry[] {
    return [...this.permanentAllowMeta.values()].map((e) => ({ ...e }));
  }

  /**
   * Phase 16f: built-in policy short-circuit — auto-allow when the tool
   * name is in `BUILTIN_SAFE_TOOLS` OR when it's a `browser_navigate`
   * to a `BUILTIN_SAFE_DOMAINS` hostname. Returns true if the call
   * should auto-allow without prompting. Smart mode only.
   */
  private matchesBuiltinSafePolicy(req: ApprovalRequest): boolean {
    if (BUILTIN_SAFE_TOOLS.has(req.toolName)) return true;
    if (req.toolName === 'browser_navigate') {
      const url = (req.args.url as string | undefined) ?? '';
      const host = hostnameOf(url);
      if (host && BUILTIN_SAFE_DOMAINS.has(host)) return true;
    }
    return false;
  }

  /**
   * Main entry. Returns `true` to allow, `false` to deny. Read-only
   * categories are always allowed without consulting any callback.
   */
  async checkApproval(req: ApprovalRequest): Promise<boolean> {
    // v4.9.0 Slice 12b — fire `approval.requested` for any gated call.
    // Read-category short-circuits below; we still fire so observers
    // see ALL approval requests (not just the ones that prompt).
    this.callbacks.onRequested?.(req);

    // ★ v4.12.1 Pillar 2 — HARD-BLOCK FLOOR. Catastrophic, no-recovery ops
    // (wipe root/home, mkfs, dd-to-device, fork bomb, shutdown, kill-all,
    // sudo-password-pipe) AND any attempt to rewrite Aiden's own autonomy
    // policy file are denied at EVERY level — before the read/off/allowlist
    // short-circuits, so NOT even --yolo or a recorded allowlist entry can
    // bypass them.
    const hb = matchesHardBlock(req);
    if (hb.blocked) {
      this.callbacks.onDecision?.({ ...req, reason: hb.reason }, 'deny');
      return false;
    }

    if (req.category === 'read') {
      this.callbacks.onDecision?.(req, 'allow');
      return true;
    }

    // YOLO mode: auto-allow but log. (Hard-block already caught catastrophes.)
    if (this.mode === 'off') {
      this.callbacks.onDecision?.(req, 'allow');
      return true;
    }

    // Allowlist short-circuit (user-recorded).
    const sig = argSignature(req.toolName, req.args);
    const key = `${req.toolName}::${sig}`;
    if (this.sessionAllow.has(key)) {
      // v4.10 Slice 10.6 — refresh the audit timestamp for any
      // PERMANENT-tier match (session-only matches stay in memory
      // and are gone on /quit, so no disk refresh is meaningful).
      // The `permanentAllow` Set is the true source for "is this
      // backed by a persisted entry"; sessionAllow ⊇ permanentAllow
      // by construction (every allow_always entry also lands in
      // sessionAllow).
      if (this.permanentAllow.has(key)) {
        const meta = this.permanentAllowMeta.get(key);
        if (meta) {
          meta.lastUsedAt = Date.now();
          this.refreshSink?.(meta);
        }
      }
      this.callbacks.onDecision?.(req, 'allow_session');
      return true;
    }

    // Phase 16f / v4.12.1: built-in safe policy short-circuit — reads,
    // memory, known-safe fetches auto-allow (applies under smart mode AND
    // when an autonomy policy is installed; both treat these as safe).
    if ((this.mode === 'smart' || this.autonomyPolicy) && this.matchesBuiltinSafePolicy(req)) {
      this.callbacks.onDecision?.(req, 'allow');
      return true;
    }

    // ★ v4.12.1 Pillar 2 — autonomy dial. When a policy is installed it is
    // the authority for the mutating decision (the generalised tier-gate).
    // allow → run; deny → block; ask → fall through to the shared prompt path
    // below (which for a subagent's engine is wired to escalate to the parent).
    if (this.autonomyPolicy) {
      const decision = decideAutonomy(this.autonomyPolicy, req);
      if (decision === 'allow') {
        this.callbacks.onDecision?.(req, 'allow');
        return true;
      }
      if (decision === 'deny') {
        this.callbacks.onDecision?.(req, 'deny');
        return false;
      }
      // 'ask' → normalise the tier and fall through to the shared prompt path.
      req = { ...req, riskTier: req.riskTier ?? 'caution' };
    }

    // Legacy smart-mode tier logic — skipped entirely when a dial policy is
    // installed (the policy is the authority above).
    if (!this.autonomyPolicy && this.mode === 'smart') {
      // Smart mode: trust the pre-flagged tier, otherwise ask the LLM.
      // Phase 16f: when neither a pre-flagged tier nor a riskAssess callback
      // is available, the call did NOT match BUILTIN_SAFE_TOOLS or the
      // user's recorded allowlist (those short-circuited above). Default
      // to 'caution' so the user gets a prompt — auto-allowing unflagged
      // calls under smart mode was the bug that made approvals feel like
      // they did nothing in 16e (every shell_exec / file_write
      // auto-approved).
      let tier: RiskTier = req.riskTier ?? 'caution';
      let rationale: string | undefined;
      if (!req.riskTier && this.callbacks.riskAssess) {
        const assessed = await this.callbacks.riskAssess(req);
        tier = assessed.tier;
        rationale = assessed.rationale;
      }
      // v4.10 Slice 10.6c — reassign req.riskTier to the
      // gate's actual decided tier BEFORE firing onDecision on the
      // safe/dangerous auto-paths. Pre-10.6c, req.riskTier was only
      // mutated on the caution fallthrough (line just below), so the
      // approval.decided audit row in run_events reported the
      // pre-classification value (typically the 'caution' default
      // because file_write doesn't pre-classify). That made
      // /trace recent understate the gate's actual reasoning —
      // "decision=allow, riskTier=caution" looked like a user picked
      // Once on a caution prompt, when in fact the aux LLM had
      // rated it safe and auto-allowed.
      if (tier === 'safe') {
        this.callbacks.onDecision?.({ ...req, riskTier: tier, reason: rationale ?? req.reason }, 'allow');
        return true;
      }
      if (tier === 'dangerous') {
        this.callbacks.onDecision?.(
          { ...req, riskTier: tier, reason: rationale ?? req.reason },
          'deny',
        );
        return false;
      }
      // 'caution' falls through to user prompt.
      req = { ...req, riskTier: tier, reason: rationale ?? req.reason };
    }

    // manual or smart-caution → prompt user.
    if (!this.callbacks.promptUser) {
      // No prompter wired (e.g. tests with no UI). Fail-closed.
      this.callbacks.onDecision?.(req, 'deny');
      return false;
    }
    // v4.8.0 Phase 2.5 — emit a structured ui_approval_request event
    // BEFORE the y/n prompt fires. Additive: the display layer paints
    // the gutter-integrated row, then the existing promptUser flow
    // runs unchanged. Moat-tier (safe/caution/dangerous) maps to the
    // ui schema's 4-tier scale; 'critical' is reserved for future
    // wiring and unreachable from this path.
    const uiTier: 'low' | 'medium' | 'high' =
      req.riskTier === 'safe'      ? 'low'  :
      req.riskTier === 'dangerous' ? 'high' : 'medium';
    const argsPreview = JSON.stringify(req.args).slice(0, 80);
    this.callbacks.onUiEvent?.('ui_approval_request', {
      prompt:    `${req.toolName} ${argsPreview}`,
      risk_tier: uiTier,
      reason:    req.reason,
    });
    const decision = await this.callbacks.promptUser(req);
    this.callbacks.onDecision?.(req, decision);

    if (decision === 'deny') return false;
    if (decision === 'allow') return true;
    if (decision === 'allow_session') {
      this.allowForSession(req.toolName, sig);
      return true;
    }
    if (decision === 'allow_always') {
      this.allowAlways(req.toolName, sig);
      return true;
    }
    return false;
  }
}
