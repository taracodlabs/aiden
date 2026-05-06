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
import type {
  CommandRegistry,
  ChatSessionLike,
} from './commandRegistry';
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
import { getRandomTip } from './tips';

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
}

const BOX_WIDTH = 67;
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
        this.opts.display.line(60);
        this.opts.display.dim('Goodbye.');
        process.exit(0);
      };
      process.on('SIGINT', sigintHandler);
    }

    // 4. Main loop.
    const promptApi = this.opts.promptApi ?? createDefaultPromptApi();
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
    try {
      while (iter < max) {
        iter += 1;
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
          if (result.exit) break;
          if (result.clearHistory) this.history = [];
          this.renderStatusLine();
          continue;
        }

        await this.runAgentTurn(input);
      }
    } finally {
      if (sigintHandler) process.off('SIGINT', sigintHandler);
      if (pasteEnabled) disableBracketedPaste(stdout);
    }
  }

  // ── Inner: a single agent turn ─────────────────────────────────────
  private async runAgentTurn(userInput: string): Promise<void> {
    // Phase 22 Task 4: status bar reflects the live phase. Set on
    // entry, cleared in both success and error paths below.
    this.setStatusState({ kind: 'generating', sinceMs: Date.now() });
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

    const spinner = this.opts.display.startSpinner('thinking…');
    let spinnerStopped = false;
    let streamingActive = false;
    const stopSpinnerOnce = (): void => {
      if (spinnerStopped) return;
      spinnerStopped = true;
      spinner.stop();
    };

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
    }
  }

  // ── Boxed startup card ─────────────────────────────────────────────
  async renderStartupCard(): Promise<void> {
    // Phase 22 Task 7: rotating tip beneath the banner. One pick per
    // boot; tips.ts caps the pool at ~10 high-signal lines.
    this.opts.display.printBanner(undefined, { tip: getRandomTip() });

    const tools = this.opts.toolRegistry.list();
    let skills: { name: string; category?: string }[] = [];
    try {
      skills = await this.opts.skillLoader.list();
    } catch {
      skills = [];
    }

    // Group tools by toolset.
    const toolsByToolset = new Map<string, string[]>();
    for (const name of tools) {
      const handler = this.opts.toolRegistry.get(name);
      const toolset = handler?.toolset ?? 'misc';
      if (!toolsByToolset.has(toolset)) toolsByToolset.set(toolset, []);
      toolsByToolset.get(toolset)!.push(name);
    }

    // Group skills by category.
    const skillsByCategory = new Map<string, string[]>();
    for (const s of skills) {
      const cat = s.category ?? 'general';
      if (!skillsByCategory.has(cat)) skillsByCategory.set(cat, []);
      skillsByCategory.get(cat)!.push(s.name);
    }

    const lines: string[] = [];
    lines.push(boxTop(BOX_WIDTH));
    lines.push(boxLine(`Aiden v4.0.0 · Taracod`, BOX_WIDTH));
    lines.push(boxLine('', BOX_WIDTH));
    lines.push(boxLine('Available Tools', BOX_WIDTH));
    const toolEntries = [...toolsByToolset.entries()];
    const visibleTools = toolEntries.slice(0, 8);
    for (const [toolset, list] of visibleTools) {
      lines.push(boxLine(`  ${toolset}: ${truncList(list, 50)}`, BOX_WIDTH));
    }
    const hiddenToolsets = toolEntries.length - visibleTools.length;
    if (hiddenToolsets > 0) {
      lines.push(boxLine(`  (and ${hiddenToolsets} more toolsets…)`, BOX_WIDTH));
    }
    lines.push(boxLine('', BOX_WIDTH));
    lines.push(boxLine('Available Skills', BOX_WIDTH));
    const skillEntries = [...skillsByCategory.entries()];
    const visibleSkills = skillEntries.slice(0, 6);
    for (const [cat, list] of visibleSkills) {
      lines.push(boxLine(`  ${cat}: ${truncList(list, 50)}`, BOX_WIDTH));
    }
    const hiddenSkillCats = skillEntries.length - visibleSkills.length;
    if (hiddenSkillCats > 0) {
      lines.push(
        boxLine(
          `  …${skills.length} skills across ${skillEntries.length} categories`,
          BOX_WIDTH,
        ),
      );
    }
    lines.push(boxLine('', BOX_WIDTH));
    lines.push(
      boxLine(`${this.currentProviderId} · ${this.currentModelId}`, BOX_WIDTH),
    );
    lines.push(
      boxLine(`Session: ${(this.sessionId ?? 'new').slice(0, 16)}`, BOX_WIDTH),
    );
    lines.push(boxLine('', BOX_WIDTH));
    lines.push(
      boxLine(
        `${tools.length} tools · ${skills.length} skills · /help for commands`,
        BOX_WIDTH,
      ),
    );
    // Phase 22 Task 1: concrete first-task suggestions inside the box —
    // collapses time-to-first-tool-call by giving the user something to
    // type. Constant content (not the rotating tip below the banner).
    lines.push(boxLine('', BOX_WIDTH));
    lines.push(boxLine(BOOT_TRY_HINT, BOX_WIDTH));
    lines.push(boxBottom(BOX_WIDTH));

    for (const line of lines) {
      this.opts.display.dim(line);
    }
    this.opts.display.write('\n');
  }

  /** Phase 22 Task 4: state transitions for the right-most segment. */
  setStatusState(state: StatusState): void {
    this.statusState = state;
  }

  // ── Status line ────────────────────────────────────────────────────
  renderStatusLine(): void {
    const provider = this.currentProviderId;
    const model = this.currentModelId;

    let limits;
    try {
      limits = this.modelMetadata.getLimits(provider, model);
    } catch {
      limits = this.modelMetadata.getDefaults();
    }
    const usedTokens = this.modelMetadata.estimateMessageTokens(this.history);
    const maxTokens = limits.contextLength;
    const turn = this.history.filter((m) => m.role === 'assistant').length;

    const line = formatStatusLine({
      provider,
      model,
      usedTokens,
      maxTokens,
      turn,
      maxTurns: 90,
      state: this.statusState,
      display: this.opts.display,
    });
    this.opts.display.write(line + '\n');
  }

  // ── Input ──────────────────────────────────────────────────────────
  private async readUserInput(api: ChatPromptApi): Promise<string> {
    const promptText = '$ ';

    let raw = await api.readLine(promptText);
    if (raw == null) return '';

    // Bracketed paste polish (Phase 16): if the terminal sent paste markers,
    // strip them and accept the entire payload as one message. This replaces
    // Phase 15's timing heuristic when the terminal supports CSI 2004; the
    // timing fallback remains for older Console hosts that don't.
    if (hasPasteMarkers(raw)) {
      const stripped = stripPasteMarkers(raw).replace(/\r/g, '');
      if (isCompletePaste(raw)) return stripped;
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
        return inline.slice(0, -3);
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
      return buffer.join('\n').trim();
    }

    // Paste detection: multiple lines arrived in a single chunk. Accept verbatim.
    if (raw.includes('\n')) return raw;

    // Slash command: invoke the autocomplete dropdown if registry has matches.
    if (raw.startsWith('/')) {
      const matches = this.opts.commandRegistry.filter(raw);
      if (matches.length > 1) {
        try {
          const picked = await api.selectSlashCommand(async (input) => {
            const filterStr = input ?? raw;
            return this.opts.commandRegistry
              .filter(filterStr)
              .map((cmd) => ({
                name: cmd.icon ? `${cmd.icon} /${cmd.name}` : `/${cmd.name}`,
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

    return raw;
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

function boxTop(width: number): string {
  return '╭' + '─'.repeat(width) + '╮';
}
function boxBottom(width: number): string {
  return '╰' + '─'.repeat(width) + '╯';
}
function boxLine(content: string, width: number): string {
  const inner = ' ' + content;
  const padded = inner.length >= width
    ? inner.slice(0, width)
    : inner + ' '.repeat(width - inner.length);
  return '│' + padded + '│';
}

function truncList(items: string[], maxLen: number): string {
  if (items.length === 0) return '(none)';
  let out = items.join(', ');
  if (out.length > maxLen) out = out.slice(0, maxLen - 1) + '…';
  return out;
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

function createDefaultPromptApi(): ChatPromptApi {
  // Lazy-load @inquirer/prompts so test harnesses without a TTY don't break.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async readLine(prompt) {
      try {
        return (await inq.input({ message: prompt })) ?? '';
      } catch (err) {
        // Inquirer wraps Ctrl+C as ExitPromptError. Re-throw as plain Error
        // with a recognisable message so the REPL can break the loop.
        const m = (err as Error)?.message ?? '';
        throw new Error(m.includes('force closed') ? 'User force closed' : m);
      }
    },
    async selectSlashCommand(source) {
      try {
        return (await inq.search({ message: '/', source })) as string;
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
