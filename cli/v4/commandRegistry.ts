/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commandRegistry.ts — Aiden v4.0.0 (Phase 14b)
 *
 * Central slash-command registry. Parses `/foo arg1 arg2` strings, routes
 * them to registered handlers, and exposes both `list()` (for `/help`) and
 * `filter()` (for the autocomplete dropdown landing in 14c).
 *
 *
 * Status: PHASE 14b.
 */

import type { Display } from './display';
import type { SkinEngine } from './skinEngine';
import type { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import type { ToolRegistry } from '../../core/v4/toolRegistry';
import type { SessionManager } from '../../core/v4/sessionManager';
import type { SkillLoader } from '../../core/v4/skillLoader';
import type { ConfigManager } from '../../core/v4/config';
import type { ContextCompressor } from '../../core/v4/contextCompressor';
import type { ApprovalEngine } from '../../moat/approvalEngine';
import type { McpClient } from '../../core/v4/mcpClient';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { SkillsHub } from '../../core/v4/skillsHub';
import type { Message } from '../../providers/v4/types';
import type { PersonalityManager } from '../../core/v4/personality';
import type { AidenPaths } from '../../core/v4/paths';
import type { AidenAgent } from '../../core/v4/aidenAgent';
import type { PluginLoader } from '../../core/v4/plugins/pluginLoader';
import type { ChannelManager } from '../../core/channels/manager';

/**
 * Lightweight session abstraction commands consume. The full chat REPL
 * (Phase 14c) implements this directly; tests provide stubs.
 */
export interface ChatSessionLike {
  history: Message[];
  setHistory(messages: Message[]): void;
  clearHistory(): void;
  getCurrentProvider(): string;
  getCurrentModel(): string;
  setProvider(providerId: string, modelId: string): Promise<void>;
  /** Optional — sessions persisted by SessionManager carry an id. */
  getSessionId?(): string | undefined;
  /** Optional — total token usage across the whole session. */
  getTotalUsage?(): { inputTokens: number; outputTokens: number };
  /**
   * Optional — v4.11 Slice B. Restore the history captured before the
   * most recent turn (in-memory only). Returns false when there is
   * nothing to undo. The persisted session is not reverted.
   */
  undoLastTurn?(): boolean;
  /**
   * Optional — v4.11 Slice C. Revert the last turn (as /undo) AND return
   * that turn's user-prompt text so the caller can re-dispatch it. Returns
   * null when there is no prior turn or the prompt is unrecoverable.
   */
  retryLastTurn?(): string | null;
  // ── v4.12.1 Pillar 4 Slice 2a — type-next-while-busy surface ──────────────
  /** Set what Enter does during a running turn: 'queue' | 'interrupt' | 'redirect'. */
  setBusyMode?(mode: 'queue' | 'interrupt' | 'redirect'): void;
  getBusyMode?(): 'queue' | 'interrupt' | 'redirect';
  /** The pending type-next queue (copy). */
  listQueue?(): string[];
  /** Empty the queue; returns how many were dropped. */
  clearQueue?(): number;
  queueCount?(): number;
}

/**
 * Slash-command execution context. Most fields are optional so unit tests
 * (and 14c's bootstrap path) can wire up only what each command needs.
 */
export interface SlashCommandContext {
  args: string[];
  rawArgs: string;
  display: Display;
  registry: CommandRegistry;
  session?: ChatSessionLike;
  resolver?: RuntimeResolver;
  toolRegistry?: ToolRegistry;
  sessionManager?: SessionManager;
  skillLoader?: SkillLoader;
  config?: ConfigManager;
  compressor?: ContextCompressor;
  approvalEngine?: ApprovalEngine;
  skin?: SkinEngine;
  mcpClient?: McpClient;
  auxiliaryClient?: AuxiliaryClient;
  skillsHub?: SkillsHub;
  personalityManager?: PersonalityManager;
  /** Phase 16b.1: present when a multi-slot fallback chain is wired. */
  fallbackAdapter?: import('../../core/v4/providerFallback').FallbackAdapter | null;
  /** Phase 16b.3: resolved Aiden user-data paths — needed by `/identity` to read SOUL.md. */
  paths?: AidenPaths;
  /**
   * Phase 16b.4: live agent reference. Used by `/debug-prompt` (read system
   * prompt) and by `/personality` (invalidate the prompt cache after a
   * switch so the next turn picks up the new overlay).
   */
  agent?: AidenAgent;
  /**
   * Phase 17: live plugin loader. /plugins commands read its registry,
   * trigger reloads, and (via the install path) write the granted-
   * permissions file before re-discovering.
   */
  pluginLoader?: PluginLoader;
  /**
   * Phase v4.1-1.1: live ChannelManager hosted by the CLI. Used by
   * /channel commands to list, add, remove, and inspect adapter
   * lifecycle without spinning up a separate API server process.
   */
  channelManager?: ChannelManager;
  /**
   * Phase 17: prompt-the-user hook used by /plugins install for the
   * permission summary confirmation. Returns true to grant, false to
   * deny. Tests inject a mock; the chat REPL injects a readline-backed
   * yes/no prompt.
   */
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Phase 18: raw text input hook used by /auth login during the OAuth
   * copy-paste flow (the user pastes the authorization code from the
   * provider's callback page). Returns the raw line; consumer trims as
   * needed. Tests inject a mock; the chat REPL plumbs the same readline
   * the prompt API uses for free-form input.
   */
  prompt?: (question: string) => Promise<string>;
  /**
   * v4.12 — change Aiden's working directory. Wired by the REPL boot
   * (aidenCLI): does `process.chdir()`, patches the live tool-executor
   * `ToolContext.cwd` (snapshotted at boot), and invalidates the sandbox
   * config so the fs allow-list rebuilds against the new cwd. Used by
   * `/home <path>`. Absent in contexts where cwd cannot change (the command
   * degrades honestly rather than pretending).
   */
  setWorkingDir?: (absPath: string) => void;
}

/** Result produced by a command handler. */
export interface SlashCommandResult {
  /** Caller (chat REPL) should exit after the handler returns. */
  exit?: boolean;
  /** Caller should drop conversation history. */
  clearHistory?: boolean;
  /**
   * v4.11 Slice C — re-dispatch this text as a fresh agent turn. Used by
   * /retry: the command reverts the last turn and returns its prompt
   * here; the REPL read loop runs it as a normal turn. Empty/undefined =
   * no rerun.
   */
  rerun?: string;
}

export type SlashCommandHandler = (
  ctx: SlashCommandContext,
) => Promise<SlashCommandResult | void>;

export interface SlashCommand {
  name: string;
  description: string;
  category: 'system' | 'skill';
  /** Glyph rendered next to the name in `/help` and the autocomplete dropdown. */
  icon?: string;
  handler: SlashCommandHandler;
  aliases?: string[];
  /** Hide from the default `list()` and autocomplete (still callable). */
  hidden?: boolean;
}

/** What `parse()` produces. */
export interface ParsedCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export interface ListOptions {
  includeHidden?: boolean;
  categoryFilter?: 'system' | 'skill';
}

/** Strip a leading slash and split on whitespace. */
function splitArgs(rest: string): { rawArgs: string; args: string[] } {
  const rawArgs = rest;
  const trimmed = rest.trim();
  const args = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  return { rawArgs, args };
}

export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly aliasIndex = new Map<string, string>();
  /** Most-recent-first names. Capped to RECENT_LIMIT entries. */
  private readonly recent: string[] = [];
  private static readonly RECENT_LIMIT = 8;

  register(cmd: SlashCommand): void {
    if (!cmd.name || cmd.name.includes(' ')) {
      throw new Error(`Invalid command name: ${JSON.stringify(cmd.name)}`);
    }
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const a of cmd.aliases) {
        this.aliasIndex.set(a, cmd.name);
      }
    }
  }

  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (!cmd) return;
    this.commands.delete(name);
    if (cmd.aliases) {
      for (const a of cmd.aliases) {
        if (this.aliasIndex.get(a) === name) {
          this.aliasIndex.delete(a);
        }
      }
    }
  }

  /** Lookup by canonical name OR by alias. */
  get(name: string): SlashCommand | null {
    const direct = this.commands.get(name);
    if (direct) return direct;
    const aliasTarget = this.aliasIndex.get(name);
    if (aliasTarget) return this.commands.get(aliasTarget) ?? null;
    return null;
  }

  /** All commands, sorted by name, optionally filtered by category. */
  list(opts: ListOptions = {}): SlashCommand[] {
    const { includeHidden = false, categoryFilter } = opts;
    const out: SlashCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (!includeHidden && cmd.hidden) continue;
      if (categoryFilter && cmd.category !== categoryFilter) continue;
      out.push(cmd);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Parse `/foo bar baz` → `{ name: 'foo', args: ['bar', 'baz'], rawArgs: 'bar baz' }`.
   * Returns `null` for empty input or anything not starting with `/`.
   * Aliases are resolved here so handlers always see canonical names.
   */
  parse(input: string): ParsedCommand | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;

    const head = trimmed.slice(1);
    const spaceIdx = head.indexOf(' ');
    let nameToken: string;
    let rest: string;
    if (spaceIdx === -1) {
      nameToken = head;
      rest = '';
    } else {
      nameToken = head.slice(0, spaceIdx);
      rest = head.slice(spaceIdx + 1);
    }
    if (!nameToken) return null;

    // Resolve aliases.
    const canonical =
      this.commands.has(nameToken) ? nameToken : this.aliasIndex.get(nameToken);
    if (!canonical) {
      // Unknown command — still parseable (for /help "unknown command" UX).
      const split = splitArgs(rest);
      return { name: nameToken, args: split.args, rawArgs: split.rawArgs };
    }
    const split = splitArgs(rest);
    return { name: canonical, args: split.args, rawArgs: split.rawArgs };
  }

  /**
   * Parse + dispatch. Returns `{ handled: false }` for non-slash input so
   * the caller can route the line to the LLM instead.
   */
  async execute(
    input: string,
    ctx: Omit<SlashCommandContext, 'args' | 'rawArgs' | 'registry'>,
  ): Promise<{ handled: boolean; exit?: boolean; clearHistory?: boolean; rerun?: string }> {
    const parsed = this.parse(input);
    if (!parsed) return { handled: false };

    const cmd = this.get(parsed.name);
    if (!cmd) {
      ctx.display.printError(
        `Unknown command: /${parsed.name}`,
        'Type /help for a list.',
      );
      return { handled: true };
    }

    const fullCtx: SlashCommandContext = {
      ...ctx,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      registry: this,
    };

    const raw = (await cmd.handler(fullCtx)) as SlashCommandResult | void;
    const result: SlashCommandResult = raw ? raw : {};
    this.recordRecent(cmd.name);
    return { handled: true, exit: result.exit, clearHistory: result.clearHistory, rerun: result.rerun };
  }

  /**
   * Autocomplete data feed. Three-tier matching (Phase 16):
   *   1. name / alias starts with query
   *   2. name contains query (substring)
   *   3. description contains query
   * Each tier is sorted alphabetically. When the prefix is empty, recent
   * commands are surfaced first, then alphabetical order. Hidden commands
   * are always excluded.
   */
  filter(prefix: string): SlashCommand[] {
    let p = (prefix ?? '').trim();
    if (p.startsWith('/')) p = p.slice(1);
    const query = p.toLowerCase();
    const visible = this.list({ includeHidden: false });

    if (!query) {
      // No filter — surface recent first, then the rest alphabetically.
      const recentSet = new Set(this.recent);
      const recentCmds: SlashCommand[] = [];
      for (const name of this.recent) {
        const cmd = this.commands.get(name);
        if (cmd && !cmd.hidden) recentCmds.push(cmd);
      }
      const remainder = visible.filter((c) => !recentSet.has(c.name));
      return [...recentCmds, ...remainder];
    }

    const tier1: SlashCommand[] = [];
    const tier2: SlashCommand[] = [];
    const tier3: SlashCommand[] = [];
    const claimed = new Set<string>();

    for (const cmd of visible) {
      const nameLower = cmd.name.toLowerCase();
      const aliasStarts = cmd.aliases?.some((a) => a.toLowerCase().startsWith(query)) ?? false;
      if (nameLower.startsWith(query) || aliasStarts) {
        tier1.push(cmd);
        claimed.add(cmd.name);
        continue;
      }
      if (nameLower.includes(query)) {
        tier2.push(cmd);
        claimed.add(cmd.name);
        continue;
      }
      if (cmd.description.toLowerCase().includes(query)) {
        tier3.push(cmd);
        claimed.add(cmd.name);
      }
    }
    const sorter = (a: SlashCommand, b: SlashCommand) =>
      a.name.localeCompare(b.name);
    return [
      ...tier1.sort(sorter),
      ...tier2.sort(sorter),
      ...tier3.sort(sorter),
    ];
  }

  /**
   * Track a command invocation. Most-recent-first, deduped, capped to
   * RECENT_LIMIT. Unknown names are ignored. (Phase 16.)
   */
  recordRecent(commandName: string): void {
    if (!this.commands.has(commandName)) return;
    const existing = this.recent.indexOf(commandName);
    if (existing !== -1) this.recent.splice(existing, 1);
    this.recent.unshift(commandName);
    if (this.recent.length > CommandRegistry.RECENT_LIMIT) {
      this.recent.length = CommandRegistry.RECENT_LIMIT;
    }
  }

  /**
   * Snapshot of recent command invocations (most-recent-first). Excludes
   * commands that have been unregistered since they were recorded.
   * (Phase 16.)
   */
  getRecent(limit?: number): SlashCommand[] {
    const cap = limit ?? CommandRegistry.RECENT_LIMIT;
    const out: SlashCommand[] = [];
    for (const name of this.recent) {
      const cmd = this.commands.get(name);
      if (cmd && !cmd.hidden) {
        out.push(cmd);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  /** Replace the recent-commands buffer wholesale. Used by persistence loaders. */
  setRecent(names: string[]): void {
    this.recent.length = 0;
    for (const name of names) {
      if (this.recent.length >= CommandRegistry.RECENT_LIMIT) break;
      if (!this.commands.has(name)) continue;
      if (this.recent.includes(name)) continue;
      this.recent.push(name);
    }
  }

  /** Snapshot of recent-command names (most-recent-first), for persistence. */
  serializeRecent(): string[] {
    return [...this.recent];
  }
}
