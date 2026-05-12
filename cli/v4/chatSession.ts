/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/chatSession.ts — Aiden v4.0.0 (Phase 14c)
 *
 * Interactive chat REPL. Replaces the Phase 1 stub. Drives an `AidenAgent`
 * end-to-end:
 *
 *   1. Boots a (or resumes an existing) `SessionRecord`.
 *   2. Renders the boxed startup card (per AGENTS.md "v4 CLI UX" spec).
 *   3. Reads user input — slash commands route through the registry,
 *      everything else feeds into `AidenAgent.runConversation()`.
 *   4. Persists each turn via `SessionManager.recordTurn()`.
 *   5. Re-renders the status line after every turn.
 *
 */

import type { AidenAgent } from '../../core/v4/aidenAgent';
import type { Display } from './display';
import { summarizeChannelState } from './display';
import type { TelegramAdapter } from '../../core/channels/telegram';
import type {
  CommandRegistry,
  ChatSessionLike,
  SlashCommand,
} from './commandRegistry';
import { uiIconsEnabled, isNoUiMode } from './uiBuild';
import {
  shouldAutoSummarize,
  memoryGrewBetween,
  SESSION_SUMMARY_MIN_TURNS,
} from './sessionSummaryGate';
import aidenPrompt, { type SlashCommandLite } from './aidenPrompt';
import { appendHistory, loadRecent } from './historyStore';
import type { CliCallbacks } from './callbacks';
import type { SessionManager } from '../../core/v4/sessionManager';
import type { ContextCompressor } from '../../core/v4/contextCompressor';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { ApprovalEngine } from '../../moat/approvalEngine';
import type { McpClient } from '../../core/v4/mcpClient';
import type { SkinEngine } from './skinEngine';
import type { ToolRegistry } from '../../core/v4/toolRegistry';
import type { SkillLoader } from '../../core/v4/skillLoader';
import type { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import type { ConfigManager } from '../../core/v4/config';
import type { PersonalityManager } from '../../core/v4/personality';
import type { PluginLoader } from '../../core/v4/plugins/pluginLoader';
import { ModelMetadata } from '../../core/v4/modelMetadata';
import type { Message } from '../../providers/v4/types';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';
import {
  enableBracketedPaste,
  disableBracketedPaste,
  stripPasteMarkers,
  isCompletePaste,
  hasPasteMarkers,
} from './bracketedPaste';
import { compressPaste } from './pasteCompression';
import { installPasteInterceptor, expandPasteLabels } from './pasteIntercept';
import { expand, hasInterpolation, countSpans } from './shellInterpolation';
import { installResizeGuard } from './resizeGuard';

/**
 * Tier-3.1 helper: render a slash-command label honouring the
 * `AIDEN_UI_ICONS` opt-in. Default OFF — emoji icons are gated to
 * keep the dropdown ASCII-clean for terminals without good emoji
 * support. `AIDEN_UI_ICONS=1` recovers the previous icon column.
 */
export function renderCommandLabel(cmd: SlashCommand): string {
  return cmd.icon && uiIconsEnabled()
    ? `${cmd.icon} /${cmd.name}`
    : `/${cmd.name}`;
}

/** Aiden version pulled from package.json at require-time; falls back
 *  to a static literal so TS compiles without a JSON resolution wobble. */
const AIDEN_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../../package.json') as { version?: string }).version ?? '4.0.0';
  } catch {
    return '4.0.0';
  }
})();

/** Lightweight readline / inquirer abstraction so tests can swap in stubs. */
export interface ChatPromptApi {
  /** Reads a free-form line of user input. Returns the raw string. */
  readLine(prompt: string): Promise<string>;
  /** Slash-command dropdown: returns the selected `/name` string,
   *  or `null` to cancel and fall back to free-form input. */
  selectSlashCommand(
    source: (input: string | undefined) => Promise<
      Array<{ name: string; value: string; description?: string }>
    >,
  ): Promise<string | null>;
}

export interface ChatSessionOptions {
  agent: AidenAgent;
  display: Display;
  commandRegistry: CommandRegistry;
  callbacks: CliCallbacks;
  sessionManager: SessionManager;
  compressor?: ContextCompressor;
  auxiliaryClient?: AuxiliaryClient;
  approvalEngine: ApprovalEngine;
  mcpClient?: McpClient;
  skin: SkinEngine;
  toolRegistry: ToolRegistry;
  skillLoader: SkillLoader;
  resolver: RuntimeResolver;
  config: ConfigManager;

  /** Provider/model the session boots with. */
  initialProviderId: string;
  initialModelId: string;

  /** Phase 16b.1: optional FallbackAdapter for /providers diagnostics. */
  fallbackAdapter?: import('../../core/v4/providerFallback').FallbackAdapter | null;

  /** Phase 16b.3: resolved Aiden user-data paths (forwarded to /identity). */
  paths?: import('../../core/v4/paths').AidenPaths;

  /** Phase 16b.4: personality overlay manager (forwarded to /personality + /debug-prompt). */
  personalityManager?: PersonalityManager;

  /** Phase 17 Task 5: forwarded to /plugins commands. */
  pluginLoader?: PluginLoader;

  /** Optional: resume an existing session id. */
  resumeSessionId?: string;
  /** Pre-loaded history when resuming. */
  resumeHistory?: Message[];

  /** YOLO mode override — flips approvalEngine to 'off' at boot. */
  yoloMode?: boolean;

  /** Optional injected prompt API (for tests). */
  promptApi?: ChatPromptApi;

  /** Optional injected metadata helper (for tests). */
  modelMetadata?: ModelMetadata;

  /** Disable SIGINT handler — tests don't want their runner to get killed. */
  installSignalHandler?: boolean;

  /**
   * Optional cap on REPL iterations. Tests pass a small integer so
   * `run()` returns; production omits and the loop is unbounded.
   */
  maxIterations?: number;

  /**
   * Phase 30.2.1 — explore mode. True when the setup wizard returned
   * status 'skipped' (recovery option [4] or wizard cancellation), so
   * the agent's adapter is a `NullAdapter`. Slash commands run normally;
   * any non-slash input is intercepted by `runAgentTurn` and surfaces
   * the friendly "no provider configured" message instead of calling
   * the agent loop.
   *
   * The boot card also keys off this flag — `providerOk` is passed as
   * `false` so the model pill renders "not configured" instead of a
   * stale model id from DEFAULT_CONFIG.
   */
  unconfigured?: boolean;

  /**
   * Phase v4.1-1.1 — live ChannelManager hosted by the CLI process.
   * Threaded through to /channel slash commands so they can list,
   * add, remove, and inspect adapters without HTTP-hopping to a
   * separate API server.
   */
  channelManager?: import('../../core/channels/manager').ChannelManager;
}

const STATUS_BAR_WIDTH = 10;

export class ChatSession implements ChatSessionLike {
  history: Message[] = [];
  private sessionId: string | null = null;
  private currentProviderId: string;
  private currentModelId: string;
  private totalUsage = { inputTokens: 0, outputTokens: 0 };
  private startedAt = Date.now();
  private queuedSystemPrompts: string[] = [];
  private modelMetadata: ModelMetadata;
  /**
   * Phase 22 Task 4: status-bar right-most segment state. `'ready'`
   * when idle; `'generating'` while a turn is in flight (rendered as
   * `⏵ <duration>`). `'exec'` / `'approve'` / `'retry'` are wired up
   * in Group C as /doctor + approval boxing lands; the field is
   * here so the status formatter can render them today.
   */
  private statusState: StatusState = { kind: 'ready' };

  // Phase 23.6 — v3-style turn-footer state.  Tracks the most-recent
  // turn's elapsed ms (rendered in the trailing footer) and the
  // provider used last turn (so a switch surfaces as `groq ──→ together`).
  private lastTurnElapsedMs = 0;
  private lastFooterProvider: string | null = null;

  constructor(private opts: ChatSessionOptions) {
    this.currentProviderId = opts.initialProviderId;
    this.currentModelId = opts.initialModelId;
    this.modelMetadata = opts.modelMetadata ?? new ModelMetadata();
    if (opts.yoloMode) opts.approvalEngine.setMode('off');
    if (opts.resumeHistory) this.history = [...opts.resumeHistory];
  }

  // ── ChatSessionLike API ────────────────────────────────────────────
  setHistory(messages: Message[]): void {
    this.history = messages;
  }
  clearHistory(): void {
    this.history = [];
  }
  getCurrentProvider(): string {
    return this.currentProviderId;
  }
  getCurrentModel(): string {
    return this.currentModelId;
  }
  getSessionId(): string | undefined {
    return this.sessionId ?? undefined;
  }
  getTotalUsage(): { inputTokens: number; outputTokens: number } {
    return this.totalUsage;
  }
  async setProvider(providerId: string, modelId: string): Promise<void> {
    // Phase 21 #5 reopen: forward `paths` so RuntimeResolver can hit the
    // Phase 18 OAuth fast-path (entry.oauth.providerId → tokenStore at
    // <aiden-home>/auth/<id>.json). Without paths the resolver skips the
    // fast-path and falls through to the legacy auth.json credential
    // path, which throws the user-reported "No credentials found for
    // apiMode='codex_responses' at .../auth.json" error even after a
    // successful /auth login.
    const adapter = await this.opts.resolver.resolve({
      providerId,
      modelId,
      paths: this.opts.paths,
    });
    this.opts.agent.setProvider(adapter);
    this.currentProviderId = providerId;
    this.currentModelId = modelId;
  }

  /** Skill slash command activation hook (Phase 14c). */
  queueSystemPrompt(content: string): void {
    if (content && content.trim()) this.queuedSystemPrompts.push(content);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  async run(): Promise<void> {
    // 1. Resolve session id if not preloaded.
    if (this.opts.resumeSessionId) {
      this.sessionId = this.opts.resumeSessionId;
    } else {
      const newSession = this.opts.sessionManager.startSession({
        providerId: this.currentProviderId,
        modelId: this.currentModelId,
      });
      this.sessionId = newSession.id;
    }

    // 2. Boxed startup card.
    await this.renderStartupCard();

    // 3. Optional SIGINT handler.
    let sigintHandler: (() => void) | null = null;
    if (this.opts.installSignalHandler !== false) {
      sigintHandler = () => {
        this.opts.display.write('\n');
        this.opts.display.dim('Goodbye.');
        process.exit(0);
      };
      process.on('SIGINT', sigintHandler);
    }

    // 4. Main loop.
    // Tier-3.1.1: feed the new aidenPrompt with live slash commands +
    // recent history so ghost-text + dropdown work out of the box.
    // The legacy inquirer path runs when `--no-ui` (AIDEN_NO_UI=1) is
    // set or when a caller injects its own `promptApi`.
    const promptApi =
      this.opts.promptApi ??
      createDefaultPromptApi({
        commands:     this.opts.commandRegistry.list(),
        loadHistory:  () => loadRecent(500),
      });
    const max = this.opts.maxIterations ?? Number.POSITIVE_INFINITY;
    let iter = 0;
    // Phase 16: enable bracketed paste for the duration of the REPL when
    // a real TTY is attached. Disabled in `finally` below so the user's
    // shell doesn't inherit the mode after we exit.
    const stdout = process.stdout;
    const pasteEnabled =
      stdout?.isTTY && !this.opts.promptApi
        ? enableBracketedPaste(stdout)
        : false;
    // Tier-3.1a: install stdin pre-tap so bracketed paste payloads are
    // captured and replaced with `[paste #N: …]` labels BEFORE inquirer
    // sees them. Without this, modern @inquirer/prompts treats internal
    // `\n` as Enter and auto-submits the first line of a multi-line paste.
    // Tier-3.1c: install regardless of TTY status. Bracketed-paste
    // sequences can arrive on a piped stdin too (CI harnesses, the
    // runtime smoke), and the interceptor's wrap is a no-op on
    // non-paste data — there's no cost to installing always. The
    // promptApi opt-out remains so callers that supply their own
    // input plumbing aren't surprised.
    const restorePasteInterceptor =
      this.opts.promptApi
        ? (): void => { /* test prompt API: no interceptor */ }
        : installPasteInterceptor(process.stdin);

    // Tier-3-essentials: hard-clear the screen on terminal resize so
    // dropdown re-renders + previous prompt frames don't ghost into
    // the new viewport. No-op on non-TTY / MCP serve mode.
    const restoreResizeGuard = this.opts.promptApi
      ? (): void => { /* test prompt API: skip */ }
      : installResizeGuard();
    try {
      while (iter < max) {
        iter += 1;
        // Phase 26.2.3 — turn boundary rule. The boot card already ends
        // with a rule + blank, so suppress on the very first iteration.
        if (iter > 1) this.opts.display.printTurnSeparator();
        let input: string;
        try {
          input = await this.readUserInput(promptApi);
        } catch (err) {
          const msg = (err as Error)?.message ?? '';
          if (msg.includes('User force closed') || msg.includes('SIGINT')) break;
          this.opts.display.printError(
            msg || 'input error',
            'Try again or run `aiden doctor`.',
          );
          continue;
        }
        if (!input || !input.trim()) continue;

        if (input.trim().startsWith('/')) {
          const result = await this.opts.commandRegistry.execute(input.trim(), {
            display: this.opts.display,
            session: this,
            resolver: this.opts.resolver,
            toolRegistry: this.opts.toolRegistry,
            sessionManager: this.opts.sessionManager,
            skillLoader: this.opts.skillLoader,
            config: this.opts.config,
            compressor: this.opts.compressor,
            approvalEngine: this.opts.approvalEngine,
            skin: this.opts.skin,
            mcpClient: this.opts.mcpClient,
            auxiliaryClient: this.opts.auxiliaryClient,
            fallbackAdapter: this.opts.fallbackAdapter ?? null,
            paths: this.opts.paths,
            personalityManager: this.opts.personalityManager,
            agent: this.opts.agent,
            pluginLoader: this.opts.pluginLoader,
            channelManager: this.opts.channelManager,
            confirm: async (msg: string) => {
              // Phase 17.1: bug — was reading `this.opts.promptApi?` which is
              // undefined when no override is passed; the chain silently
              // resolved to undefined → returned false → "Grant cancelled"
              // before the user could type anything. Use the resolved local
              // promptApi (which falls back to readline-default) instead.
              const r = await promptApi.readLine(msg);
              if (typeof r !== 'string') return false;
              return /^(y|yes)$/i.test(r.trim());
            },
            // Phase 18: raw text prompt for /auth login OAuth code paste.
            prompt: (msg: string) => promptApi.readLine(msg),
          });
          if (result.exit) {
            // Phase v4.1.2 alive-core: auto-trigger session_summary on
            // /quit when the session was substantive (≥3 user turns).
            // SIGINT and crash paths intentionally skip this — they
            // bypass the slash-command handler entirely (signal handler
            // at line 274 calls process.exit(0) directly).
            await this.maybeAutoSummarize();
            break;
          }
          if (result.clearHistory) this.history = [];
          // Phase 23.6 — v3 doesn't print a status footer after slash
          // commands; the footer belongs to agent turns only.
          continue;
        }

        await this.runAgentTurn(input);
      }
    } finally {
      if (sigintHandler) process.off('SIGINT', sigintHandler);
      if (pasteEnabled) disableBracketedPaste(stdout);
      restorePasteInterceptor();
      restoreResizeGuard();
    }
  }

  // ── Inner: a single agent turn ─────────────────────────────────────
  /**
   * Phase v4.1.2 alive-core (refined v4.1.2-followup-2): auto-trigger
   * `session_summary` on /quit when the session was substantive
   * (≥3 user turns). The synthetic prompt forces the model to call
   * the tool — prose-only responses are not acceptable.
   *
   * Every non-success path is logged explicitly so users always know
   * what happened:
   *   - threshold-skip → log: "session too short, skipping summary"
   *   - unconfigured-skip → log: "no provider, skipping summary"
   *   - tool-not-called (model returned prose) → log a clear warning
   *   - tool-errored (throw) → log the error verbatim
   *   - tool-succeeded → log the absolute MEMORY.md path
   *
   * Post-run verification: compare MEMORY.md size+mtime before vs
   * after the synthetic turn. If unchanged, the model didn't actually
   * fire the tool and the user gets a "run /session-summary manually
   * next time" hint.
   *
   * SIGINT and crash paths skip this method entirely because the
   * signal handler does process.exit(0) before this slash-command
   * branch runs.
   */
  private async maybeAutoSummarize(): Promise<void> {
    const userTurns = this.history.filter((m) => m.role === 'user').length;
    const memoryPath = this.opts.paths?.memoryMd;

    const gate = shouldAutoSummarize({
      userTurns,
      unconfigured: !!this.opts.unconfigured,
      memoryPath,
    });
    if (gate.fire === false) {
      switch (gate.reason) {
        case 'short':
          this.opts.display.dim(
            `Skipping session summary — only ${userTurns} user turn(s), need ${SESSION_SUMMARY_MIN_TURNS}+.`,
          );
          return;
        case 'unconfigured':
          this.opts.display.dim(
            'Skipping session summary — no provider configured.',
          );
          return;
        case 'no-paths':
          this.opts.display.dim(
            'Skipping session summary — no aiden paths wired (test mode?).',
          );
          return;
      }
    }

    // Snapshot MEMORY.md state before the synthetic turn so we can
    // detect whether the agent actually wrote anything. Missing file
    // is treated as size=0 / mtime=0; equal-to-before-after after the
    // turn → same outcome (warn the user).
    const before = await this.snapshotMemoryStat(memoryPath);

    this.opts.display.dim(`Saving session summary to ${memoryPath}…`);
    try {
      await this.runAgentTurn(
        'This session is ending. You MUST call the session_summary tool ' +
        'NOW with trigger=\'auto-quit\' and a bullets array of exactly 5 ' +
        'concise items covering what we worked on, decisions made, files ' +
        'changed, problems solved, and open items. Do not respond with ' +
        'prose. Do not explain. Do not ask for confirmation. Call the ' +
        'tool immediately — the user will not see your text, only the ' +
        'tool call matters.',
      );
    } catch (err) {
      this.opts.display.warn(
        `Session summary failed: ${(err as Error).message}`,
      );
      return;
    }

    const after = await this.snapshotMemoryStat(memoryPath);
    const grew = memoryGrewBetween(before, after);
    if (grew) {
      this.opts.display.dim(`Session summary saved to ${memoryPath}`);
    } else {
      this.opts.display.warn(
        'Session summary tool was not called (model responded with prose ' +
        `instead of firing the tool). MEMORY.md unchanged at: ${memoryPath}`,
      );
    }
  }

  /**
   * Read MEMORY.md size + mtime for the pre/post-write comparison in
   * `maybeAutoSummarize`. Missing file is normalised to zeros so the
   * "did MEMORY.md grow" comparison is well-defined even on fresh installs.
   */
  private async snapshotMemoryStat(p: string): Promise<{ size: number; mtime: number }> {
    try {
      const { promises: fsPromises } = await import('node:fs');
      const stat = await fsPromises.stat(p);
      return { size: stat.size, mtime: stat.mtimeMs };
    } catch {
      return { size: 0, mtime: 0 };
    }
  }

  private async runAgentTurn(userInput: string): Promise<void> {
    // Phase 30.2.1 — explore mode: short-circuit BEFORE building the
    // turn-status spinner / agent call. The wizard skipped, so there's
    // no real provider to talk to. Print a friendly redirect to /setup
    // (or the env-var alternative) and return — REPL stays alive, user
    // can run slash commands or hit /quit.
    if (this.opts.unconfigured) {
      void userInput; // silence unused-arg warning when this branch fires
      this.opts.display.write('\n');
      this.opts.display.printError(
        'No AI provider configured yet.',
        'Run /setup to configure a provider, or set an API key environment variable (e.g. GROQ_API_KEY).',
      );
      this.opts.display.write('\n');
      return;
    }

    // Phase 22 Task 4: status bar reflects the live phase. Set on
    // entry, cleared in both success and error paths below.
    this.setStatusState({ kind: 'generating', sinceMs: Date.now() });
    // Tier-3.1a: dim full-width rule between the user input echo and
    // the agent reply for clean visual rhythm.
    this.opts.display.write(`  ${this.opts.display.rule()}\n`);
    // Phase 26.2.3 — blank line between the user-input echo and the
    // spinner / response so the eye sees user → agent as separate
    // beats instead of butting together.
    this.opts.display.write('\n');
    const turnStartedAt = Date.now();
    const userMsg: Message = { role: 'user', content: userInput };

    // Apply any queued system prompts (from skill slash commands) by
    // prepending them as system messages. Cleared after consumption.
    const newHistory: Message[] = [];
    for (const sysContent of this.queuedSystemPrompts) {
      newHistory.push({ role: 'system', content: sysContent });
    }
    this.queuedSystemPrompts = [];

    const turnStart = this.history.length;
    const baseHistory = newHistory.length > 0
      ? [...this.history, ...newHistory, userMsg]
      : [...this.history, userMsg];

    // Phase 16c: streaming gated on display.streaming config (default off).
    // Defensive: tests sometimes pass partial config stubs without the
    // ConfigManager API; treat that as "streaming disabled".
    const streamingEnabled =
      typeof this.opts.config?.getValue === 'function'
        ? this.opts.config.getValue<boolean>('display.streaming', false) === true
        : false;

    // Phase 26.2.6 — random thinking phrase per turn, already wrapped
    // in brand orange by Display.thinkingPhrase().
    const spinner = this.opts.display.startSpinner(this.opts.display.thinkingPhrase());
    let spinnerStopped = false;
    let streamingActive = false;
    const stopSpinnerOnce = (): void => {
      if (spinnerStopped) return;
      spinnerStopped = true;
      spinner.stop();
    };

    // Phase 23.5: stop the "thinking…" spinner the moment the first
    // tool row prints. The event rows are the user-facing indicator
    // from that point on; a spinner painting `\r` over the same line
    // would corrupt our row-overwrite when the row mutates to its
    // final bracket state.
    this.opts.callbacks.setBeforeFirstToolHook?.(stopSpinnerOnce);

    try {
      const result = await this.opts.agent.runConversation(baseHistory, {
        stream: streamingEnabled,
        onFirstDelta: streamingEnabled
          ? () => {
              stopSpinnerOnce();
              streamingActive = true;
            }
          : undefined,
        onDelta: streamingEnabled
          ? (text: string) => {
              this.opts.display.streamPartial(text);
            }
          : undefined,
        onToolCallStart: streamingEnabled
          ? (call) => {
              this.opts.display.streamToolIndicator(call.name);
            }
          : undefined,
      });
      stopSpinnerOnce();
      if (streamingActive) this.opts.display.streamComplete();

      this.history = result.messages;
      this.totalUsage.inputTokens += result.totalUsage.inputTokens;
      this.totalUsage.outputTokens += result.totalUsage.outputTokens;

      // Phase 16d: surface inline confirmations for verified memory writes.
      // We MUST gate on verified=true (the post-write read flag from
      // MemoryGuard) — HonestyEnforcement uses the same flag to catch
      // fabricated "I remembered X" claims, so showing it without the
      // verification would be the exact bug we just shipped a fix for.
      // Unverified writes get a quieter line so the user knows the model
      // tried but the round-trip didn't confirm.
      renderMemoryConfirmations(result.toolCallTrace, this.opts.display);

      // When streaming was active and emitted the final content already,
      // skip the markdown re-render — we'd otherwise duplicate text.
      if (result.finalContent && !streamingActive) {
        this.opts.display.write(this.opts.display.agentTurn(result.finalContent));
      }

      if (this.sessionId) {
        // Only persist the new tail of messages — what got added this turn.
        const newSlice = this.history.slice(turnStart);
        this.opts.sessionManager.recordTurn(
          this.sessionId,
          newSlice,
          result.totalUsage,
        );
      }

      this.setStatusState({ kind: 'ready' });
      this.lastTurnElapsedMs = Date.now() - turnStartedAt;
      // Tier-3.1a: dim full-width rule between the agent reply and the
      // post-turn status footer.
      this.opts.display.write(`  ${this.opts.display.rule()}\n`);
      this.renderStatusLine();
    } catch (err) {
      stopSpinnerOnce();
      if (streamingActive) this.opts.display.streamComplete();
      const msg = (err as Error)?.message ?? String(err);
      this.opts.display.printError(
        msg,
        'Run `/model` to switch providers or `aiden doctor` to diagnose.',
      );
      this.setStatusState({ kind: 'ready' });
      this.lastTurnElapsedMs = Date.now() - turnStartedAt;
    }
  }

  // ── Startup card (Phase 26.2.4: neofetch-style sectioned) ──────────
  // Boot rhythm:
  //
  //     [AIDEN ASCII art in brand orange]
  //       Autonomous AI Engine                            (muted tagline)
  //
  //     ● core online    ● mode auto    ● model X    ● memory active
  //     ────────────────────────────────────────────────────────────
  //
  //     Environment                Capabilities
  //       OS         Windows 11      web         research · extract
  //       shell      PowerShell      browser     navigate · automate
  //       runtime    local-first     files       read · patch · organize
  //       tools      44 loaded       execution   shell · code · workflows
  //       skills     72 loaded       memory      persistent recall
  //
  //     ────────────────────────────────────────────────────────────
  //
  //     [scroll-shaped credits footer with ♥ + GitHub/Web/Contact]
  //
  //     ▲ Type your message · /help for commands · /skills to add more
  //
  // Width-responsive: side-by-side at ≥80 cols, stacked below; scroll
  // collapses to plain 4-line credits below 75 cols.
  async renderStartupCard(): Promise<void> {
    const display = this.opts.display;

    // Tier-3.1a: skip entirely on non-TTY so piped/scripted callers
    // don't get scrollback chatter on stdout.
    if (!process.stdout.isTTY) return;

    // Channel summary — observable, not banner-essential, but kept so
    // status pills aren't the only place a user sees telegram health.
    const cm = this.opts.channelManager;
    if (cm) {
      const adapterStatuses = cm.getStatus().map((s) => {
        const adapter = cm.get(s.name);
        const tg = adapter as (TelegramAdapter & {
          getBotUsername?: () => string | null;
          getState?:       () => 'inactive' | 'connecting' | 'active' | 'degraded' | 'conflict';
        }) | undefined;
        const botHandle =
          typeof tg?.getBotUsername === 'function' ? tg.getBotUsername() : null;
        const state =
          typeof tg?.getState === 'function' ? tg.getState() : undefined;
        return { id: s.name, healthy: s.healthy, botHandle, state };
      });
      void summarizeChannelState({ adapters: adapterStatuses });
    } else {
      void summarizeChannelState(null);
    }

    const cols = display.cols();
    const isNarrow = cols < 60;
    const showEnvCapBlock = cols >= 70;
    const version = AIDEN_VERSION;

    display.write('\n');

    if (isNarrow) {
      // Compact — single-line text logo + one-line capability summary.
      display.write(`  ${display.brand('AIDEN')}  ${display.muted(`v${version}`)}\n`);
      display.write(
        `  ${display.muted('Local AI · controls your computer · never forgets')}\n`,
      );
    } else {
      // Wide — full ASCII art + subtitle. Tier-3.1c: dropped the
      // tagline + sponsor lines from the top section because they
      // duplicate the credits already inside the scrollFooter at
      // the bottom of the boot card. Subtitle stays — it's the only
      // brand anchor between the ASCII art and the pills row.
      display.printBanner(version);
      display.write(`  ${display.muted('Autonomous AI Engine')}\n`);
      display.write('\n');
    }

    // Status pills.
    display.write(
      display.statusPillsRow({
        coreOnline:   true,
        mode:         'auto',
        model:        this.currentModelId,
        memoryActive: true,
        providerOk:   !this.opts.unconfigured,
      }) + '\n',
    );

    // Tier-3.1b: rule + environment/capabilities block + rule + scroll
    // + bottom prompt hint. Skipped at <70 cols to keep the narrow
    // boot card from wrapping into noise.
    display.write(`  ${display.rule()}\n`);

    if (showEnvCapBlock) {
      // Detect environment lazily (cheap on every boot — no caching
      // needed; tools/skills counts are already loaded by this point).
      const toolsCount = this.opts.toolRegistry.list().length;
      let skillsLoaded = 0;
      try {
        skillsLoaded = (await this.opts.skillLoader.list()).length;
      } catch {
        skillsLoaded = 0;
      }

      display.write('\n');
      // Pass sideBySideThreshold=120 so 70-119 cols stack vertically
      // (per the tier3.1b dispatch's width-tier policy) and only
      // ≥120 renders the full side-by-side block.
      display.write(
        display.twoColumnBlock(
          {
            title: 'Environment',
            rows:  [
              { key: 'OS',       value: detectOS() },
              { key: 'shell',    value: detectShell() },
              { key: 'runtime',  value: 'local-first' },
              { key: 'tools',    value: `${toolsCount} loaded` },
              { key: 'skills',   value: `${skillsLoaded} loaded` },
            ],
          },
          {
            title: 'Capabilities',
            rows:  [
              { key: 'web',       value: 'research · extract' },
              { key: 'browser',   value: 'navigate · automate' },
              { key: 'files',     value: 'read · patch · organize' },
              { key: 'execution', value: 'shell · code · workflows' },
              { key: 'memory',    value: 'persistent recall' },
            ],
          },
          // Tier-3.1c: lowered from 120 → 100 so wide-but-not-huge
          // terminals (laptop screens, default Windows Terminal) get
          // the side-by-side block instead of the stacked fallback.
          // Each column at ~38 chars + 4-char separator + 2-char
          // indent fits in 82 chars; 100 leaves 18 chars headroom.
          { sideBySideThreshold: 100 },
        ) + '\n',
      );
      display.write('\n');
      display.write(`  ${display.rule()}\n`);
      display.write('\n');
    }

    // Scroll footer (parchment at ≥80 cols, single-line credits below).
    display.write(display.scrollFooter() + '\n');

    // Bottom prompt hint — final line of the boot card.
    display.write('\n');
    display.write(display.bottomPromptHint() + '\n');
  }

  /** Phase 22 Task 4: state transitions for the right-most segment. */
  setStatusState(state: StatusState): void {
    this.statusState = state;
  }

  // ── Status line (Phase 23.6: v3 visual style port) ──────────────────
  // Render the post-turn footer with provider, model, ctx gauge, and
  // elapsed time.  Optionally precedes the footer with a `prev ──→ next`
  // provider-switch line when the active provider has changed since the
  // last turn (matches v3 cli/aiden.ts:730).
  renderStatusLine(): void {
    const display = this.opts.display;
    const provider = this.currentProviderId;
    const model = this.currentModelId;

    if (
      this.lastFooterProvider !== null &&
      this.lastFooterProvider !== provider
    ) {
      display.write(display.providerSwitchLine(this.lastFooterProvider, provider) + '\n');
    }
    this.lastFooterProvider = provider;

    let limits;
    try {
      limits = this.modelMetadata.getLimits(provider, model);
    } catch {
      limits = this.modelMetadata.getDefaults();
    }
    const usedTokens = this.modelMetadata.estimateMessageTokens(this.history);
    const maxTokens = limits.contextLength;

    display.write(
      display.statusFooter({
        provider,
        model,
        ctxUsed: usedTokens,
        ctxMax: maxTokens,
        elapsedMs: this.lastTurnElapsedMs,
      }) + '\n\n',
    );
  }

  // ── Input ──────────────────────────────────────────────────────────
  private async readUserInput(api: ChatPromptApi): Promise<string> {
    // Phase 23.6 — v3-style ▲ prompt in brand orange.  Inquirer's
    // default `input` prompt prepends a `?` glyph; we override it with
    // our own bare prefix so the result reads `▲ <user input>`.
    const promptText = this.opts.display.promptPrefix();

    let raw = await api.readLine(promptText);
    if (raw == null) return '';

    // Tier-3.1a: stdin pre-tap (pasteIntercept) already converted any
    // bracketed-paste payload into a `[paste #N: …]` label before
    // inquirer saw it. Swap the label back for the original here so
    // the agent receives full content. User-typed labels with unknown
    // ids are left untouched.
    raw = expandPasteLabels(raw);

    // Bracketed paste polish (Phase 16): if the terminal still sent
    // paste markers (interceptor disabled — non-TTY or test promptApi),
    // strip them and accept the entire payload as one message.
    if (hasPasteMarkers(raw)) {
      const stripped = stripPasteMarkers(raw).replace(/\r/g, '');
      if (isCompletePaste(raw)) return await this.maybeCompressVisiblePaste(stripped);
      // Unterminated paste — still return the stripped content so the user
      // doesn't see escape sequences in their prompt.
      raw = stripped;
    }

    raw = raw.replace(/\r/g, '');

    // Multi-line via leading """.
    if (raw.startsWith('"""')) {
      const inline = raw.slice(3);
      // Single-line `"""hello"""` shortcut.
      if (inline.endsWith('"""')) {
        return await this.maybeCompressVisiblePaste(inline.slice(0, -3));
      }
      const buffer: string[] = [inline];
      while (true) {
        const next = await api.readLine('… ');
        if (next == null) break;
        if (next.endsWith('"""')) {
          buffer.push(next.slice(0, -3));
          break;
        }
        buffer.push(next);
      }
      return await this.maybeCompressVisiblePaste(buffer.join('\n').trim());
    }

    // Paste detection: multiple lines arrived in a single chunk. The
    // interceptor + expandPasteLabels path already produced the original
    // text — no extra echo needed since the user saw the `[paste #N: …]`
    // label in the input buffer. Pass the original through unchanged.
    if (raw.includes('\n')) return raw;

    // Slash command: invoke the legacy autocomplete dropdown only
    // when --no-ui (AIDEN_NO_UI=1) is set. The new aidenPrompt
    // handles the dropdown inline as the user types, so re-opening
    // a second prompt here would double-prompt — once in
    // aidenPrompt, once in inq.search. Tier-3.1.1 routes everything
    // through aidenPrompt unless the legacy path is explicitly
    // requested.
    if (isNoUiMode() && raw.startsWith('/')) {
      const matches = this.opts.commandRegistry.filter(raw);
      if (matches.length > 1) {
        try {
          const picked = await api.selectSlashCommand(async (input) => {
            const filterStr = input ?? raw;
            return this.opts.commandRegistry
              .filter(filterStr)
              .map((cmd) => ({
                name: renderCommandLabel(cmd),
                value: `/${cmd.name}`,
                description: cmd.description,
              }));
          });
          if (picked) return picked;
        } catch {
          // search not available or cancelled — fall through to raw.
        }
      }
    }

    // Tier-3-essentials: inline shell interpolation. If the prompt
    // contains `{!cmd}` spans, run each in parallel (5s timeout per
    // span, 500-char output cap) and splice the output back in. The
    // rewritten prompt is what reaches the agent — visible feedback
    // is a single dim line so the user sees that the work happened.
    if (hasInterpolation(raw)) {
      const spans = countSpans(raw);
      this.opts.display.dim(`[shell] running ${spans} interpolation${spans === 1 ? '' : 's'}…`);
      try {
        raw = await expand(raw);
      } catch {
        // expand() never rejects, but defence-in-depth.
      }
    }

    return raw;
  }

  /**
   * Tier-3.1: when a paste is large (>5 lines OR >500 chars), echo a
   * compact `[paste #<id>: …]` label to the user and persist the
   * original to disk so `/show <id>` can recall it later. The agent
   * still receives the full original text — only the visible echo is
   * compressed.
   *
   * MCP serve mode never reaches this path (REPL doesn't run there),
   * so the display.write here is safe.
   */
  private async maybeCompressVisiblePaste(text: string): Promise<string> {
    try {
      const result = await compressPaste(text);
      if (result.compressed && result.label) {
        // Echo the label only — newline-terminated for cleanliness.
        this.opts.display.write(`  ${this.opts.display.muted(result.label)}\n`);
      }
    } catch {
      // Paste compression is a polish feature; if disk write fails we
      // silently fall through to the original text rather than crash
      // the prompt loop.
    }
    return text;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Boot-card "Try:" hint (Phase 22 Task 1). Two concrete first-task
 * examples picked so a fresh user can press Enter on the wizard, see
 * the boot card, and have something specific to type within seconds.
 */
export const BOOT_TRY_HINT = `Try: 'play me a popular song'  or  'list my Downloads'`;

/**
 * Phase 26.2.4 — host OS pretty name for the boot-card Environment
 * block. Best-effort:
 *   - win32 release ≥10.0.22000 → "Windows 11", else "Windows 10"
 *   - darwin major maps to known names (Sequoia/Sonoma/…)
 *   - linux reads /etc/os-release PRETTY_NAME when available
 *
 * Returns the platform string verbatim on unknown systems. Pure (apart
 * from one optional sync read of /etc/os-release on linux); cheap.
 */
export function detectOS(): string {
  const platform = process.platform;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const osMod = require('node:os') as typeof import('node:os');
  if (platform === 'win32') {
    const m = osMod.release().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m && parseInt(m[3], 10) >= 22000) return 'Windows 11';
    return 'Windows 10';
  }
  if (platform === 'darwin') {
    const major = parseInt(osMod.release().split('.')[0] ?? '0', 10);
    const names: Record<number, string> = {
      24: 'Sequoia',
      23: 'Sonoma',
      22: 'Ventura',
      21: 'Monterey',
      20: 'Big Sur',
    };
    return names[major] ? `macOS ${names[major]}` : 'macOS';
  }
  if (platform === 'linux') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fsSync = require('node:fs') as typeof import('node:fs');
      const text = fsSync.readFileSync('/etc/os-release', 'utf8');
      const m = text.match(/^PRETTY_NAME="([^"]+)"/m);
      if (m) return m[1];
    } catch {
      /* ignore — fallback below */
    }
    return 'Linux';
  }
  return platform;
}

/**
 * Phase 26.2.4 — best-effort shell name for the boot-card Environment
 * block. On Windows: "PowerShell + WSL2" when WSL_DISTRO_NAME is set,
 * else "PowerShell" when PSModulePath is present, else "cmd". On POSIX:
 * the basename of $SHELL, or "sh" as a last resort.
 */
export function detectShell(): string {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath) {
      return process.env.WSL_DISTRO_NAME ? 'PowerShell + WSL2' : 'PowerShell';
    }
    return 'cmd';
  }
  const sh = process.env.SHELL ?? '';
  return sh.split('/').pop() || 'sh';
}

/**
 * Phase 22 Task 4 — discriminated union for the status bar's
 * right-most "current state" segment. Tagged so the formatter can
 * pick the glyph + colour without a string-match.
 *
 * - `ready`      idle, awaiting user input
 * - `generating` model is producing tokens; sinceMs starts the elapsed
 * - `exec`       a tool is executing (Group C wires this)
 * - `approve`    awaiting an approval prompt (Group C wires this)
 * - `retry`      rate-limited, retryUntilMs is the absolute deadline
 */
export type StatusState =
  | { kind: 'ready' }
  | { kind: 'generating'; sinceMs: number }
  | { kind: 'exec' }
  | { kind: 'approve' }
  | { kind: 'retry'; retryUntilMs: number };

/**
 * Format the status bar's right-most state segment text + colour kind.
 * Pure — `now` is injectable for tests.
 */
export function formatStatusState(
  state: StatusState,
  now: number = Date.now(),
): { text: string; colour: 'brand' | 'muted' | 'warn' } {
  switch (state.kind) {
    case 'generating': {
      const ms = Math.max(0, now - state.sinceMs);
      return { text: `⏵ ${formatDuration(ms)}`, colour: 'brand' };
    }
    case 'exec':
      return { text: '▶ exec', colour: 'brand' };
    case 'approve':
      return { text: '⊕ approve', colour: 'warn' };
    case 'retry': {
      const remainingMs = Math.max(0, state.retryUntilMs - now);
      const sec = Math.ceil(remainingMs / 1000);
      return { text: `⚠ retry ${sec}s`, colour: 'warn' };
    }
    case 'ready':
    default:
      return { text: 'ready', colour: 'muted' };
  }
}

/**
 * Render a 10-character progress bar coloured per the Phase 22 palette
 * — filled cells in brand orange, empty cells in soft cyan. Returns
 * the bar with surrounding `[` / `]` delimiters in muted.
 */
export function renderColouredProgressBar(
  used: number,
  max: number,
  width: number,
  display: Display,
): string {
  if (max <= 0) return display.muted('[' + '░'.repeat(width) + ']');
  const ratio = Math.max(0, Math.min(1, used / max));
  const filled = Math.round(ratio * width);
  return (
    display.muted('[') +
    display.brand('▓'.repeat(filled)) +
    display.muted('░'.repeat(width - filled)) +
    display.muted(']')
  );
}

export interface StatusLineArgs {
  provider: string;
  model: string;
  usedTokens: number;
  maxTokens: number;
  turn: number;
  maxTurns: number;
  state: StatusState;
  display: Display;
  /** Test seam — defaults to Date.now(). */
  now?: number;
}

/**
 * Phase 22 Task 4 status bar: vertical-bar separators, soft-cyan
 * labels and separator, brand progress fill, semantic state colour.
 *
 *   <provider>:<model> │ ctx U/M [bar] N% │ budget T/MT │ <state>
 */
export function formatStatusLine(args: StatusLineArgs): string {
  const { provider, model, usedTokens, maxTokens, turn, maxTurns, state, display } = args;
  const ctxPercent = maxTokens > 0
    ? Math.min(100, Math.round((usedTokens / maxTokens) * 100))
    : 0;
  const bar = renderColouredProgressBar(usedTokens, maxTokens, STATUS_BAR_WIDTH, display);
  const sep = display.muted(' │ ');
  const ctxSegment =
    display.muted('ctx ') +
    `${formatTokens(usedTokens)}/${formatTokens(maxTokens)} ` +
    bar +
    ` ${ctxPercent}%`;
  const budgetSegment = display.muted('budget ') + `${turn}/${maxTurns}`;
  const stateInfo = formatStatusState(state, args.now);
  const stateSegment = display.paint(stateInfo.text, stateInfo.colour);
  return `${provider}:${model}${sep}${ctxSegment}${sep}${budgetSegment}${sep}${stateSegment}`;
}

export function renderProgressBar(used: number, max: number, width: number): string {
  if (max <= 0) return '[' + '░'.repeat(width) + ']';
  const ratio = Math.max(0, Math.min(1, used / max));
  const filled = Math.round(ratio * width);
  return '[' + '▓'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

interface DefaultPromptOpts {
  commands?:    SlashCommandLite[];
  loadHistory?: () => Promise<string[]>;
}

function createDefaultPromptApi(opts: DefaultPromptOpts = {}): ChatPromptApi {
  // Lazy-load @inquirer/prompts so test harnesses without a TTY don't break.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  // Phase 23.6 — v3 visual style.  Suppress inquirer's default `?` /
  // `✔` glyphs (controlled by theme.prefix) so our brand `▲` prompt
  // shows alone.  We pass per-status entries so the answered echo also
  // stays clean; `loading` is intentionally untouched (spinner state).
  const promptTheme = { prefix: { idle: '', done: '' } };

  // Tier-3.1.1: when `--no-ui` (AIDEN_NO_UI=1) is set, fall back to
  // the legacy inquirer prompt path. Otherwise use the new
  // aidenPrompt component (ghost text + slash dropdown + history nav).
  const useLegacyPrompt = isNoUiMode() || !opts.commands;

  return {
    async readLine(prompt) {
      try {
        if (useLegacyPrompt) {
          return (await inq.input({ message: prompt, theme: promptTheme })) ?? '';
        }
        // Fetch history just-in-time so each read sees the latest
        // (the user's previous turn was just appended).
        const history = opts.loadHistory ? await opts.loadHistory() : [];
        const value = await aidenPrompt({
          message:  prompt,
          commands: opts.commands ?? [],
          history,
          theme:    promptTheme as never,
        });
        const trimmed = (value ?? '').trim();
        // Append to disk history. Awaited so the write flushes before
        // the agent loop progresses — `/quit` exits the process and
        // a fire-and-forget write would race the exit. The latency
        // on a single appended line is negligible (~ms).
        if (trimmed.length > 0) {
          try { await appendHistory(trimmed); } catch { /* best-effort */ }
        }
        return value ?? '';
      } catch (err) {
        // Inquirer wraps Ctrl+C as ExitPromptError. Re-throw as plain Error
        // with a recognisable message so the REPL can break the loop.
        const m = (err as Error)?.message ?? '';
        throw new Error(m.includes('force closed') ? 'User force closed' : m);
      }
    },
    async selectSlashCommand(source) {
      // Tier-3.1.1: aidenPrompt handles the slash dropdown inline so
      // this hook is rarely invoked. The legacy path stays available
      // for `--no-ui` callers + any external promptApi shim that
      // doesn't wrap aidenPrompt directly.
      try {
        return (await inq.search({ message: '/', source, theme: promptTheme })) as string;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Phase 16d: render inline confirmation lines for memory mutations the agent
 * actually executed this turn. Gate strictly on `verified=true` (the post-
 * write read flag from MemoryGuard) so we never fabricate confirmations for
 * unverified or errored writes — the same flag HonestyEnforcement uses to
 * catch fake "I remembered X" claims.
 *
 * Exported for tests; called from the chat loop right after `runConversation`
 * returns.
 */
export function renderMemoryConfirmations(
  trace: HonestyTraceEntry[],
  display: { success(text: string): void; warn(text: string): void },
): void {
  for (const entry of trace) {
    if (
      entry.name !== 'memory_add' &&
      entry.name !== 'memory_replace' &&
      entry.name !== 'memory_remove'
    ) {
      continue;
    }
    const file = extractMemoryFile(entry.result);
    const target = file === 'user' ? 'user profile' : 'memory';
    const action =
      entry.name === 'memory_add'
        ? 'Saved to'
        : entry.name === 'memory_replace'
          ? 'Updated'
          : 'Removed from';
    if (entry.error) {
      display.warn(`memory write failed: ${entry.error}`);
      continue;
    }
    if (entry.verified === true) {
      display.success(`${action} ${target}.`);
    } else {
      // Tool ran without throwing but post-write verification didn't confirm.
      // Be honest: tell the user we tried but couldn't confirm, instead of
      // claiming success.
      display.warn(`${action.toLowerCase()} ${target} attempted but not verified.`);
    }
  }
}

/** Pull the `file` field out of a memory tool result, defaulting to 'memory'. */
function extractMemoryFile(result: unknown): 'memory' | 'user' {
  if (
    result &&
    typeof result === 'object' &&
    'file' in (result as Record<string, unknown>) &&
    (result as Record<string, unknown>).file === 'user'
  ) {
    return 'user';
  }
  return 'memory';
}
