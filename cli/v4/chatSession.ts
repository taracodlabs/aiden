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
 * Hermes reference: cli.py::HermesCLI.run() / .chat() / .process_command().
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
import { ModelMetadata } from '../../core/v4/modelMetadata';
import type { Message } from '../../providers/v4/types';
import {
  enableBracketedPaste,
  disableBracketedPaste,
  stripPasteMarkers,
  isCompletePaste,
  hasPasteMarkers,
} from './bracketedPaste';

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
    const adapter = await this.opts.resolver.resolve({ providerId, modelId });
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

    const spinner = this.opts.display.startSpinner('thinking…');
    try {
      const result = await this.opts.agent.runConversation(baseHistory);
      spinner.stop();

      this.history = result.messages;
      this.totalUsage.inputTokens += result.totalUsage.inputTokens;
      this.totalUsage.outputTokens += result.totalUsage.outputTokens;

      if (result.finalContent) {
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

      this.renderStatusLine();
    } catch (err) {
      spinner.stop();
      const msg = (err as Error)?.message ?? String(err);
      this.opts.display.printError(
        msg,
        'Run `/model` to switch providers or `aiden doctor` to diagnose.',
      );
    }
  }

  // ── Boxed startup card ─────────────────────────────────────────────
  async renderStartupCard(): Promise<void> {
    this.opts.display.printBanner();

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
    lines.push(boxBottom(BOX_WIDTH));

    for (const line of lines) {
      this.opts.display.dim(line);
    }
    this.opts.display.write('\n');
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
    const ctxPercent = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
    const bar = renderProgressBar(usedTokens, maxTokens, STATUS_BAR_WIDTH);

    const turn = this.history.filter((m) => m.role === 'assistant').length;
    const maxTurns = 90;

    const ageMs = Date.now() - this.startedAt;
    const age = formatDuration(ageMs);

    const line =
      `$ ${provider}:${model}  ` +
      `ctx ${formatTokens(usedTokens)}/${formatTokens(maxTokens)} ${bar} ${ctxPercent}%  ` +
      `budget ${turn}/${maxTurns}  ${age}`;
    this.opts.display.dim(line);
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
