#!/usr/bin/env node
/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/aidenCLI.ts — Aiden v4.0.0 (Phase 14c)
 *
 * Main CLI entry point. Built on `commander` (already in `node_modules`).
 *
 * Responsibilities:
 *   - `aiden`              → interactive chat REPL (default action).
 *   - `aiden setup`        → re-run the setup wizard (Phase 14a).
 *   - `aiden model [spec]` → run the model picker (Phase 14b).
 *   - `aiden config`       → view config.
 *   - `aiden doctor`       → run diagnostics (Phase 14a).
 *   - `aiden sessions <…>` → list / search persisted sessions.
 *   - `aiden skills <…>`   → list / view installed skills.
 *   - `aiden mcp <…>`      → manage MCP servers (Phase 11 stub).
 *   - `aiden batch | gateway | cron | pairing | tui | update` → v4.1 stubs.
 *
 * `argparse` subparsers. We use `commander` instead but the surface
 * chat-first invocation flow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Command } from 'commander';
import { promises as fs, watch as fsWatch } from 'node:fs';
import path from 'node:path';

import { ChatSession } from './chatSession';
import { runTuiMode } from './aidenTUI';
import { Display } from './display';
import { SkinEngine } from './skinEngine';
import { CommandRegistry } from './commandRegistry';
import { CliCallbacks } from './callbacks';
// Tier-3.1 (v4.1-tier3.1) — re-export the build fingerprint so the
// runtime smoke can find it in the bundled artifact.
import { AIDEN_UI_BUILD } from './uiBuild';
export { AIDEN_UI_BUILD };
import { runSetupWizard, isFreshInstall } from './setupWizard';
import { runDoctorCli } from './doctor';
import { runModelPicker } from './commands/modelPicker';
import { allCommands } from './commands';
// v4.12 /commands slice — inline /activity roll-up + /home cwd invalidation + history source.
import { makeActivityCommand } from './commands/activity';
import { loadRecent, HISTORY_MAX_ENTRIES } from './historyStore';
import { invalidateSandboxConfig } from '../../core/v4/sandboxConfig';
// v4.12 PM.1 — background-process registry, wired into the REPL + daemon executor.
import { ProcessRegistry } from '../../core/v4/processRegistry';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
  type AidenPaths,
} from '../../core/v4/paths';
import { ensureSoulMdSeeded } from '../../core/v4/soulSeed';
import { setVisionProvider } from '../../core/v4/visionClient';
import { ConfigManager, resolveConfiguredAutonomyLevel } from '../../core/v4/config';
import { resolveAutonomyPolicy, type AutonomyLevel } from '../../moat/autonomy';
import { SessionStore } from '../../core/v4/sessionStore';
import { SessionManager } from '../../core/v4/sessionManager';
import { ToolRegistry } from '../../core/v4/toolRegistry';
import { SkillLoader } from '../../core/v4/skillLoader';
import { makeSubagentFanoutTool } from '../../tools/v4/index';
import type { ProviderOption } from '../../core/v4/subagent/providerRotation';
// v4.6 Phase 1 — spawn_sub_agent: always-on runStore + LLM-callable tool.
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { daemonDbPath } from '../../core/v4/daemon/daemonConfig';
import { openDaemonDb } from '../../core/v4/daemon/db/connection';
import { createRunStore } from '../../core/v4/daemon/runStore';
// v4.10 Slice 10.2b — shared event taxonomy. Tool name → (category, kind).
import { categorizeEvent } from '../../core/v4/daemon/eventCategories';
import { makeSpawnSubAgentTool } from '../../tools/v4/subagent/spawnSubAgentTool';
import { SubagentCoordinator } from '../../core/v4/subagent/coordinator';
// v4.10 Slice 10.2 — trace_query tool (REPL-only). Factory pattern
// matches spawn_sub_agent: dependencies injected at registration.
import { makeTraceQueryTool } from '../../tools/v4/trace/traceQuery';
import type { Message as ProviderMessage } from '../../providers/v4/types';
import { SkillCommands } from '../../core/v4/skillCommands';
import { AidenAgent } from '../../core/v4/aidenAgent';
import { PromptBuilder, narrowSkillDesc } from '../../core/v4/promptBuilder';
import { PersonalityManager } from '../../core/v4/personality';
import { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
// v4.11 preflight compression — wire the dormant Phase 13 compressor
// into production. Both modules existed pre-v4.11 but ContextCompressor
// was never constructed at boot, so the `if (this.contextCompressor)`
// branch at aidenAgent.ts:754 stayed dead at runtime and `/compress`
// reported "Compressor or session not wired."
import { ContextCompressor } from '../../core/v4/contextCompressor';
import { ModelMetadata } from '../../core/v4/modelMetadata';
import { applyToolDeferral } from '../../core/v4/toolDeferral';
import { MemoryManager } from '../../core/v4/memoryManager';
// v4.10 Slice 10.1b — boot-time project-root detection so the REPL's
// MemoryManager can route memory_add file=project to the cwd's
// project root. Without this wire, the tool always saw projectRoot=null
// and threw via namespaceRegistry.resolve (bug found in smoke).
import { findProjectRoot } from '../../core/v4/memory/projectRoot';

import { ApprovalEngine } from '../../moat/approvalEngine';
import {
  PlannerGuard,
  type PlannerGuardMode,
} from '../../moat/plannerGuard';
import {
  HonestyEnforcement,
  type HonestyMode,
} from '../../moat/honestyEnforcement';
import {
  SkillTeacher,
  type SkillTeacherTier,
} from '../../moat/skillTeacher';
import { SkillMiner } from '../../core/v4/skillMining/skillMiner';
import type { MinedCandidate } from '../../core/v4/skillMining/candidateStore';
import {
  createSubsystemHealthRegistry,
  SubsystemHealthTracker,
} from '../../core/v4/subsystemHealth';
import { SkillOutcomeTracker } from '../../core/v4/skillOutcomeTracker';
import { resolveBootProvider } from './providerBootSelector';
import { enumerateConfiguredProviders, pickProbeModel } from './doctorLiveness';
import { PROVIDER_REGISTRY } from '../../providers/v4/registry';
import { isMcpServeMode } from './uiBuild';
import { MemoryGuard } from '../../moat/memoryGuard';
import { SSRFProtection } from '../../moat/ssrfProtection';
import { TirithScanner } from '../../moat/tirithScanner';

import { CredentialResolver } from '../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import { ChatCompletionsAdapter } from '../../providers/v4/chatCompletionsAdapter';
import { findModel } from '../../providers/v4/modelCatalog';
import {
  FallbackAdapter,
  buildDefaultSlots,
  type ProviderSlot,
} from '../../core/v4/providerFallback';
import {
  restoreBundledSkillsIfNeeded,
  syncBundledSkillsIfStale,
} from '../../core/v4/skillBundledRestore';
import {
  detectAvailableProviders,
  summarizeDetection,
  shouldRunWizard,
} from '../../core/v4/firstRun/providerDetection';
import { createFileLogger } from '../../core/v4/aidenLogger';
import {
  PluginLoader,
  evaluatePermissionState,
  resolveBundledPluginsDir,
  formatPluginBootCard,
} from '../../core/v4/plugins';
import { OAuthProviderRegistry } from '../../core/v4/auth/providerAuth';

// Phase v4.1-1.1 — CLI-side ChannelManager. The same singleton lives in
// the API server process; in a CLI-only session we host it here so
// /channel commands operate without a separate server. When `aiden serve`
// runs in the SAME process tree on the same machine, polling-based
// adapters (Telegram) must only be started in one of the two — we
// gate startup on a heuristic below to avoid 409 polling-conflict.
import { ChannelManager } from '../../core/channels/manager';
import { TelegramAdapter } from '../../core/channels/telegram';
import { registerEnvChannels } from './channelBoot';
import { gateway } from '../../core/gateway';
import { createBootLogger } from '../../core/v4/logger';

import { registerAllTools } from '../../tools/v4';
import { setupMcpFromConfig } from '../../tools/v4/mcpSetup';
// v4.11 toolset grouping — boot-time profile resolution. Picks
// `minimal`/`standard`/`full`/`custom` from env or config and feeds
// the resulting toolset list to `toolRegistry.getSchemas` so the
// agent ships a deterministic, cache-stable tool catalog.
import {
  resolveBootProfile,
  type ResolvedProfile,
} from '../../core/v4/toolProfiles';
import { isWeakModel } from '../../core/v4/modelCapability';

import { createSkillCommandHandler } from './commands/skillCommandHandler';

/** Valid PlannerGuard mode values for CLI/config validation. */
const PLANNER_GUARD_MODES: readonly PlannerGuardMode[] = [
  'off',
  'rule_based',
  'llm_classified',
];
/** Valid HonestyEnforcement mode values. */
const HONESTY_MODES: readonly HonestyMode[] = ['off', 'detect', 'enforce'];
/** Valid SkillTeacher tier values. */
const SKILL_TEACHER_TIERS: readonly SkillTeacherTier[] = [
  'off',
  'tier_3_propose',
  'tier_4_auto',
];

/**
 * Coerce a config-or-CLI string into a known mode value. Falls back to the
 * default and emits a warning when the input is recognised-but-invalid. The
 * `warn` sink is injectable so tests don't see noise.
 */
function coerceMode<T extends string>(
  raw: unknown,
  valid: readonly T[],
  fallback: T,
  label: string,
  warn: (msg: string) => void,
): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  if ((valid as readonly string[]).includes(raw)) return raw as T;
  warn(
    `Invalid ${label} '${raw}' — falling back to '${fallback}' (valid: ${valid.join(', ')})`,
  );
  return fallback;
}

// Post-v4.1.1 cleanup: read VERSION from the auto-generated source-of-
// truth (scripts/inject-version.js writes it from package.json on every
// prebuild hook). Previous hardcoded '4.0.0' string had been stale since
// v4.0.1 and made `aiden --version` lie.
import { VERSION } from '../../core/version';

// Phase 16c.2: env-source tracking lives in `cli/v4/envSources.ts` so
// `commands/providers.ts` can import getEnvSource without circular deps.
import { loadAidenEnvFile, getEnvSource } from './envSources';
export { loadAidenEnvFile, getEnvSource };

/**
 * Build slots for the runtime FallbackAdapter, putting the user's
 * configured (providerId, modelId) at the head so it stays primary
 * even when GROQ_API_KEY etc. happen to be set in the environment.
 */
function buildAgentFallbackSlots(
  primaryAdapter: import('../../providers/v4/types').ProviderAdapter,
  primaryProviderId: string,
  primaryModelId: string,
): ProviderSlot[] {
  const defaults = buildDefaultSlots({
    adapterFactory: (cfg) =>
      new ChatCompletionsAdapter({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        providerName: cfg.providerName,
      }),
  });
  // Synthesise a primary slot that wraps the already-resolved adapter
  // (so it picks up config.yaml / auth.json overrides the env-var slots
  // would miss). It always builds — primary credentials were validated
  // by the resolver already.
  const primarySlot: ProviderSlot = {
    id: 'primary',
    providerId: primaryProviderId,
    modelId: primaryModelId,
    keyPresent: true,
    keyTail: null,
    build: () => primaryAdapter,
  };
  // Filter out env-var slots whose providerId matches the primary AND
  // whose env-var-derived key would shadow it (avoids double-trying the
  // same Groq account at slots 0 and 1).
  return [primarySlot, ...defaults];
}

export interface MainOptions {
  /** Override for test injection — bypasses real subsystem boot. */
  runChatHook?: (opts: any) => Promise<void>;
  /** Override for test injection — bypasses interactive setup. */
  runSetupHook?: () => Promise<void>;
  runModelHook?: (spec: string | undefined) => Promise<void>;
  runDoctorHook?: () => Promise<void>;
  runSessionsHook?: (action: string, arg?: string) => Promise<void>;
  runSkillsHook?: (action: string, arg?: string) => Promise<void>;
  runConfigHook?: (action?: string, key?: string, value?: string) => Promise<void>;
  runMcpHook?: (action: string) => Promise<void>;
  /** Override for test injection — headless one-shot (`aiden -q`). Returns exit code. */
  runQueryHook?: (opts: any) => Promise<number>;
  /** Path override for tests. */
  pathsOverride?: AidenPaths;
  /** Stub stdout writer (defaults to process.stdout.write). */
  writeOut?: (text: string) => void;
  /**
   * v4.9.5 Slice 1.6 — when true, `buildAgentRuntime` treats
   * `wizardNeeded` as true regardless of detection AND passes
   * `force: true` to the inner `runSetupWizard` call. Set by
   * `runSetupSubcommand` so `aiden setup` re-runs the full
   * disclaimer → loading → wizard flow even on a configured install,
   * then drops into the REPL (via the existing handoff inside
   * `runInteractiveChat`). Default undefined → no behaviour change
   * for any other entry point.
   */
  forceSetup?: boolean;
}

/**
 * Commander 5.x option-value collector. Use with `.option('--flag <v>',
 * '...', collectArray, [])` so repeated `--flag a --flag b` produces
 * `['a','b']` instead of `'b'`. Commander 5 does NOT support the
 * `<x...>` variadic syntax on options (only positional args).
 */
function collectArray(value: string, previous: string[] | undefined): string[] {
  if (!Array.isArray(previous)) return [value];
  return previous.concat([value]);
}

export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  // v4.5 Phase 1 — daemon foundation bootstrap is deferred until the
  // REPL action handler fires (see the default `.action()` below).
  // Subcommands like `trigger add`, `trigger list`, `config get`,
  // `--version`, `--help`, `doctor`, etc. do NOT need the daemon
  // foundation. Booting it for every CLI invocation:
  //   1. Wastes work (HTTP server up + tear down for a one-shot
  //      DB-write subcommand).
  //   2. Creates phantom "crash recovery" warnings: the daemon-
  //      foundation install/teardown cycle for each subcommand
  //      doesn't shut down gracefully (process.exit happens after
  //      the action), so the NEXT invocation's evaluateBootState
  //      sees a stale daemon_instances row with a missed heartbeat
  //      and writes a crash_reports row.
  //   3. Adds latency on cold paths (CLI feels slow when AIDEN_DAEMON=1).
  // The interactive REPL action calls `bootstrapDaemon()` explicitly,
  // which is the only entry point that genuinely benefits from the
  // foundation (long-running session = useful daemon).
  const program = new Command();

  program
    .name('aiden')
    .description('Aiden — local-first AI agent')
    .version(VERSION, '-v, --version')
    .option('--tui', 'Launch full-screen TUI renderer', false)
    .option('-c, --continue', 'Resume the most recent session')
    .option('-r, --resume <title>', 'Resume a session by id-prefix or partial title')
    .option('--yolo', 'Skip approval prompts (YOLO mode)')
    .option('-q, --query <prompt>', 'Run ONE non-interactive turn on <prompt>, print the answer, and exit (headless; read-only tools run, mutating tools auto-denied unless --yolo)')
    .option('--provider <id>', 'Override provider id')
    .option('--model <id>', 'Override model id')
    .option(
      '--planner-guard <mode>',
      'PlannerGuard mode: off | rule_based | llm_classified',
    )
    .option(
      '--honesty <mode>',
      'HonestyEnforcement mode: off | detect | enforce',
    )
    .option(
      '--skill-teacher <tier>',
      'SkillTeacher tier: off | tier_3_propose | tier_4_auto',
    )
    .option(
      '--no-ui',
      'Disable Tier-3 UI polish (autosuggest ghost text, inline status line); fall back to legacy rendering',
    )
    .action(async () => {
      // Tier-3.1: argv discipline. If positional args were passed but
      // no subcommand matched, error to stderr and exit non-zero
      // rather than silently booting the REPL — a typo'd subcommand
      // otherwise produces a hung foreground.
      const leftover = program.args ?? [];
      if (leftover.length > 0) {
        process.stderr.write(`error: unknown command "${leftover[0]}"\n`);
        process.stderr.write(`Run 'aiden --help' for available commands.\n`);
        process.exit(2);
      }

      // v4.12.1 — headless one-shot. `aiden -q "<prompt>"` runs a single turn
      // and exits; it must NOT boot the daemon foundation, the REPL, or any
      // long-lived machinery. Handle it BEFORE the daemon bootstrap below.
      const qOpts = program.opts() as { query?: string };
      if (qOpts.query != null) {
        if (opts.runQueryHook) {
          process.exit(await opts.runQueryHook(program.opts()));
        }
        process.exit(await runQuery(qOpts.query, program.opts(), opts));
      }

      // v4.5 Phase 1 — daemon foundation bootstrap. Lazy-imported so
      // the daemon module's side-effect cost stays at zero when
      // AIDEN_DAEMON is off (better-sqlite3 native binding, chokidar,
      // express, etc. all stay unloaded). Only fires for the REPL
      // path — subcommands (trigger add/list/show/remove/enable/
      // disable/test, config, --version, --help, doctor, …) do NOT
      // touch the daemon foundation.
      // v4.5 Phase 7c — two-phase bootstrap. The daemon FOUNDATION
      // (file watchers, webhook routes, email triggers, cron
      // emitter, dispatcher with placeholder runner, HTTP server)
      // comes up HERE — before buildAgentRuntime, before the setup
      // wizard. This restores the pre-7b guarantee that daemon
      // foundation boots regardless of REPL configuration state
      // (matters for systemd/launchd units booted on fresh machines
      // and for any environment without a provider configured yet).
      //
      // The REAL agent runner gets installed later inside
      // runInteractiveChat() once buildAgentRuntime returns — see
      // `installDaemonAgentBuilder` call there.
      try {
        if (process.env.AIDEN_DAEMON === '1') {
          const { bootstrapDaemonFoundation } = await import('../../core/v4/daemon/bootstrap');
          bootstrapDaemonFoundation();
        }
      } catch (e) {
        // Fail-loud but non-fatal — daemon foundation init failure
        // must not block the user from opening a REPL.
        console.error('[daemon] foundation bootstrap failed: ' + (e instanceof Error ? e.message : String(e)));
      }

      // Tier-3.1: surface --no-ui as an env var so downstream modules
      // (which import uiBuild.ts) see the flag without threading it
      // through every call site.
      const o = program.opts() as { ui?: boolean };
      if (o.ui === false) process.env.AIDEN_NO_UI = '1';
      const cliOpts = program.opts();
      if (opts.runChatHook) {
        await opts.runChatHook(cliOpts);
        return;
      }
      await runInteractiveChat(cliOpts, opts);
    });

  // Tier-3.1: hidden one-shot — emits the UI build fingerprint and
  // exits. Used by the runtime smoke to verify the bundled artifact
  // matches the expected sub-phase without parsing other output.
  program
    .command('print-ui-build', { hidden: true })
    .description('Print the v4.1 tier-3 UI build fingerprint and exit.')
    .action(() => {
      process.stdout.write(`${AIDEN_UI_BUILD}\n`);
      process.exit(0);
    });

  // v4.12.1 — `aiden chat -q "<prompt>"` alias for the headless one-shot.
  // Same behaviour as the top-level `aiden -q`; provided for discoverability.
  program
    .command('chat')
    .description('Run one non-interactive turn and exit (headless one-shot)')
    .option('-q, --query <prompt>', 'The prompt to run')
    .option('--yolo', 'Auto-approve tool calls (default: auto-deny)')
    .action(async (cmdOpts: { query?: string; yolo?: boolean }) => {
      const merged = { ...program.opts(), ...cmdOpts };
      if (merged.query == null) {
        process.stderr.write('usage: aiden chat -q "<prompt>"\n');
        process.exit(2);
      }
      if (opts.runQueryHook) {
        process.exit(await opts.runQueryHook(merged));
      }
      process.exit(await runQuery(merged.query, merged, opts));
    });

  program
    .command('setup')
    .description('Run the setup wizard (provider + model + API key)')
    .action(async () => {
      if (opts.runSetupHook) {
        await opts.runSetupHook();
        return;
      }
      await runSetupSubcommand(opts);
    });

  program
    .command('model [spec]')
    .description('Show or pick a provider/model. Spec form: "groq:llama-3.3-70b-versatile".')
    .action(async (spec?: string) => {
      if (opts.runModelHook) {
        await opts.runModelHook(spec);
        return;
      }
      await runModelSubcommand(spec, opts);
    });

  program
    .command('config [action] [key] [value]')
    .description('View or edit ~/.aiden/config.yaml. Actions: view (default), set, check.')
    .action(async (action?: string, key?: string, value?: string) => {
      if (opts.runConfigHook) {
        await opts.runConfigHook(action, key, value);
        return;
      }
      await runConfigSubcommand(action, key, value, opts);
    });

  program
    .command('doctor')
    .description('Run diagnostic checks')
    .option(
      '--providers',
      'Also ping each configured / authed provider and report live status (deep check). Slower; useful before shipping or when a provider regression is suspected.',
    )
    .action(async (cmdOpts: { providers?: boolean }) => {
      if (opts.runDoctorHook) {
        await opts.runDoctorHook();
        return;
      }
      await runDoctorCli({ liveness: cmdOpts.providers === true });
      // Non-interactive subcommand: exit cleanly instead of hanging on a
      // lingering handle. runDoctorCli already set process.exitCode honestly
      // (0 when healthy, 1 on failure) so scripts/CI can detect a failing
      // doctor. Mirrors the explicit exit trigger/cron/mcp/artifacts use.
      process.exit();
    });

  program
    .command('sessions <action> [arg]')
    .description('Manage persisted sessions. Actions: list, search <query>.')
    .action(async (action: string, arg?: string) => {
      if (opts.runSessionsHook) {
        await opts.runSessionsHook(action, arg);
        return;
      }
      await runSessionsSubcommand(action, arg, opts);
      // Non-interactive subcommand: exit cleanly (was hanging on a lingering
      // handle after printing). Read-only list/search → success exit 0.
      process.exit(0);
    });

  program
    .command('skills <action> [arg]')
    .description('Manage installed skills. Actions: list, view <name>.')
    .action(async (action: string, arg?: string) => {
      if (opts.runSkillsHook) {
        await opts.runSkillsHook(action, arg);
        return;
      }
      await runSkillsSubcommand(action, arg, opts);
      // Non-interactive subcommand: exit cleanly (was hanging on a lingering
      // handle after printing). Read-only list/view → success exit 0.
      process.exit(0);
    });

  // v4.5 Phase 2 — file watcher trigger management.
  program
    .command('trigger <action> [args...]')
    .description('Manage daemon triggers. Actions: add, list, show, remove, enable, disable, test.')
    // Commander 5.x stores option values directly on the Command
    // instance, so `--name` would clobber Command.prototype.name().
    // Use `--label` instead; we map to the internal `name` arg below.
    .option('--label <label>', 'Trigger label/name (for add).')
    // Commander 5.x does NOT support `<x...>` variadic syntax on
    // OPTIONS (only on positional args) — repeating overwrites
    // instead of appending. Use an explicit collector so multiple
    // --path / --include / --exclude / --event flags accumulate.
    .option('--path <path>', 'Path to watch (for add file). Repeatable.', collectArray, [])
    .option('--include <glob>', 'Include glob pattern. Repeatable.', collectArray, [])
    .option('--exclude <glob>', 'Exclude glob pattern. Repeatable.', collectArray, [])
    .option('--event <type>', 'Event type: add|change|unlink. Repeatable.', collectArray, [])
    .option('--debounce-ms <n>', 'Per-path debounce in ms (default 750).', (v: string) => Number.parseInt(v, 10))
    .option('--settle-ms <n>', 'Stable-stat settle in ms (default 1000).', (v: string) => Number.parseInt(v, 10))
    .option('--max-settle-ms <n>', 'Max settle time before giving up (default 30000).', (v: string) => Number.parseInt(v, 10))
    .option('--max-queue-depth <n>', 'Max per-watcher queue depth (default 100).', (v: string) => Number.parseInt(v, 10))
    .option('--no-ignore-temp', 'Disable default ignore for editor temps + .git + node_modules.')
    .option('--content-hash', 'Compute sha256 per change (opt-in; slower).')
    .option('--reconcile <policy>', 'skip_existing | process_new_since_last_seen | full_rescan (default skip_existing).')
    .option('--polling', 'Force polling mode (network FS / WSL bind mount).')
    .option('--prompt-template <text>', 'Phase 5 — agent prompt template.')
    .option('--disabled', 'Create trigger in disabled state.')
    // v4.5 Phase 3 — webhook-specific options.
    .option('--hmac <format>', 'Webhook HMAC format: github | gitlab | generic (default generic).')
    .option('--secret <s>', 'Webhook secret. Auto-generated when omitted.')
    .option('--rate-limit <n>', 'Webhook requests/min (default 30).', (v: string) => Number.parseInt(v, 10))
    .option('--max-body-bytes <n>', 'Webhook max body cap (default 1048576).', (v: string) => Number.parseInt(v, 10))
    .option('--idempotency-ttl-ms <n>', 'Webhook idempotency TTL (default 3600000).', (v: string) => Number.parseInt(v, 10))
    .option('--deliver-only', 'Phase 3 stub: accept + log; Phase 5 will dispatch via channel.')
    // v4.5 Phase 4a — email IMAP options.
    .option('--host <host>', 'IMAP host (for add email).')
    .option('--port <n>', 'IMAP port (default 993).', (v: string) => Number.parseInt(v, 10))
    .option('--user <addr>', 'IMAP user / email address (for add email).')
    .option('--password <pwd>', 'IMAP password (for add email).')
    .option('--no-tls', 'Disable TLS (for add email; default is TLS on).')
    .option('--mailbox <name>', 'IMAP mailbox (default INBOX).')
    .option('--poll-ms <n>', 'Email poll interval ms (default 15000).', (v: string) => Number.parseInt(v, 10))
    .option('--allow-sender <addr-or-glob>', 'Allowed sender pattern (repeatable, REQUIRED for email).', collectArray, [])
    .option('--allow-subject <regex>', 'Allowed subject regex (repeatable).', collectArray, [])
    .option('--attachment-policy <policy>', 'skip | inline-text | save-to-tmp (default skip).')
    .option('--no-validate', 'Skip IMAP pre-flight connectivity check.')
    .action(async (action: string, posArgs: string[] | undefined, cmd: Command) => {
      const { runTriggerSubcommand } = await import('./commands/trigger');
      const cliOpts = cmd.opts() as Record<string, unknown>;
      const argv = {
        name:             cliOpts.label as string | undefined,
        paths:            cliOpts.path as string[] | undefined,
        include:          cliOpts.include as string[] | undefined,
        exclude:          cliOpts.exclude as string[] | undefined,
        events:           cliOpts.event as string[] | undefined,
        debounceMs:       cliOpts.debounceMs as number | undefined,
        settleMs:         cliOpts.settleMs as number | undefined,
        maxSettleMs:      cliOpts.maxSettleMs as number | undefined,
        maxQueueDepth:    cliOpts.maxQueueDepth as number | undefined,
        noIgnoreTemp:     cliOpts.ignoreTemp === false,
        contentHash:      cliOpts.contentHash === true,
        reconcile:        cliOpts.reconcile as string | undefined,
        polling:          cliOpts.polling === true,
        promptTemplate:   cliOpts.promptTemplate as string | undefined,
        disabled:         cliOpts.disabled === true,
        // v4.5 Phase 3 — webhook options.
        hmac:             cliOpts.hmac as string | undefined,
        secret:           cliOpts.secret as string | undefined,
        rateLimit:        cliOpts.rateLimit as number | undefined,
        maxBodyBytes:     cliOpts.maxBodyBytes as number | undefined,
        idempotencyTtlMs: cliOpts.idempotencyTtlMs as number | undefined,
        deliverOnly:      cliOpts.deliverOnly === true,
        // v4.5 Phase 4a — email options.
        host:             cliOpts.host as string | undefined,
        port:             cliOpts.port as number | undefined,
        user:             cliOpts.user as string | undefined,
        password:         cliOpts.password as string | undefined,
        noTls:            cliOpts.tls === false,
        mailbox:          cliOpts.mailbox as string | undefined,
        pollMs:           cliOpts.pollMs as number | undefined,
        allowSenders:     (cliOpts.allowSender as string[] | undefined) ?? [],
        allowSubjects:    (cliOpts.allowSubject as string[] | undefined) ?? [],
        attachmentPolicy: cliOpts.attachmentPolicy as string | undefined,
        noValidate:       cliOpts.validate === false,
      };
      const code = await runTriggerSubcommand(action, posArgs ?? [], argv, {
        writeOut: opts.writeOut,
      });
      process.exit(code);
    });

  // v4.9.0 Slice 9 — memory CLI surface.
  program
    .command('memory [action] [args...]')
    .description('Manage MEMORY.md + USER.md + project memory. Actions: list (default), show, add, remove, edit, backup, restore, diff, namespaces, pending, approve, reject, review.')
    .allowUnknownOption()
    .action(async (action: string | undefined, posArgs: string[] | undefined) => {
      const { runMemorySubcommand } = await import('./commands/memory');
      const code = await runMemorySubcommand(action ?? 'list', posArgs ?? [], {
        writeOut: opts.writeOut,
      });
      process.exit(code);
    });

  // v4.9.0 Slice 12b — hooks CLI surface.
  program
    .command('hooks [action] [args...]')
    .description('Manage hook subsystem. Actions: list (default), show, trust, revoke, rescan, test, doctor, audit.')
    .allowUnknownOption()
    .action(async (action: string | undefined, posArgs: string[] | undefined) => {
      const { runHooksSubcommand } = await import('./commands/hooks');
      const code = await runHooksSubcommand(action ?? 'list', posArgs ?? [], {
        writeOut: opts.writeOut,
      });
      process.exit(code);
    });

  // v4.5 Phase 4b — daemon supervisor commands.
  program
    .command('daemon <action> [args...]')
    .description('Manage the Aiden daemon. Actions: install, uninstall, start, stop, restart, status, logs, doctor.')
    // v4.9.0 Slice 8 — `aiden daemon doctor --json` / `--fix`. Allow
    // unknown flags so the subcommand can parse them via posArgs.
    .allowUnknownOption()
    .action(async (action: string, posArgs: string[] | undefined) => {
      const { runDaemonSubcommand } = await import('./commands/daemon');
      const code = await runDaemonSubcommand(action, posArgs ?? [], {
        writeOut: opts.writeOut,
      });
      process.exit(code);
    });

  // v4.5 Phase 6 — `aiden cron` top-level surface (mirrors slash command).
  program
    .command('cron <action> [args...]')
    .description('Scheduled jobs. Actions: add, list, show, remove, enable, disable, run, logs.')
    .option('--label <name>',            'job label (alphanumeric/dash/underscore)')
    .option('--schedule <expr>',         'cron expr ("0 9 * * *") / interval ("every 5m") / ISO timestamp')
    .option('--command <cmd>',           'shell command to run')
    .option('--timezone <tz>',           'IANA timezone (default UTC)')
    .option('--misfire-policy <policy>', 'skip_stale | run_once_if_late | catch_up_with_limit | manual_review')
    .option('--prompt-template <tpl>',   'render template instead of running raw command (daemon mode)')
    .option('--deliver-only',            'daemon skips the agent loop on fire')
    .action(async (action: string, posArgs: string[] | undefined, cmdObj: Record<string, unknown>) => {
      const { runCronSubcommand } = await import('./commands/cron');
      // v4.12.1 — pass the PLAIN option values, not the Command object.
      // Commander stores options as properties on the command, but the
      // command also carries its own members: `.name` is a METHOD, so
      // `argv.name ?? argv.label` in cmdCliAdd short-circuited to the
      // function and `aiden cron add` always failed "label is required".
      const argv = typeof (cmdObj as { opts?: () => Record<string, unknown> }).opts === 'function'
        ? (cmdObj as unknown as { opts: () => Record<string, unknown> }).opts()
        : cmdObj;
      const code = await runCronSubcommand(action, posArgs ?? [], argv, {
        writeOut: opts.writeOut,
      });
      process.exit(code);
    });

  // v4.5 Phase 6 — `aiden runs` surface (daemon run history).
  program
    .command('runs <action> [args...]')
    .description('Daemon runs. Actions: list, show <id>, interrupt <id>, resume <id>, stats.')
    .option('--limit <n>',    'list: max rows (default 50)', (v: string) => Number.parseInt(v, 10))
    .option('--source <src>', 'list: filter by trigger source (file/webhook/email/schedule/manual)')
    .option('--status <s>',   'list: filter by status (queued/running/completed/failed/cancelled/interrupted)')
    .option('--trigger <prefix>', 'list: sessionId prefix (e.g. "trigger:file:<id>:")')
    .option('--include-children', 'list: include sub-agent children (default: top-level only, with per-parent badge)')
    .action(async (action: string, posArgs: string[] | undefined, cmdObj: Record<string, unknown>) => {
      const { runRunsSubcommand } = await import('./commands/runs');
      const code = await runRunsSubcommand(action, posArgs ?? [], cmdObj, {
        writeOut: opts.writeOut,
      });
      process.exit(code);
    });

  program
    .command('mcp <action> [target] [extraArgs...]')
    .description(
      'MCP server mode + client config. Actions: serve | status | tools | init <client> | doctor <client> | repair <client> | uninstall <client>. ' +
      'Clients: claude (Claude Desktop), cursor, vscode.',
    )
    .allowUnknownOption()
    .action(async (action: string, target: string | undefined, extraArgs: string[] = []) => {
      if (opts.runMcpHook) {
        await opts.runMcpHook(action);
        return;
      }
      // Lazy-load so the rest of the CLI does not pay the import cost
      // for `setup`, `doctor`, `model`, etc. on every invocation.
      const { runMcpSubcommand } = await import('./commands/mcp');
      const code = await runMcpSubcommand(action, {
        writeOut: opts.writeOut,
        writeErr: (t: string) => process.stderr.write(t),
        args:   extraArgs,
        target,
      });
      if (code !== 0) process.exit(code);
    });

  program
    .command('voice [args...]')
    .description(
      'Voice diagnostics + one-shot TTS / transcribe. ' +
      'Usage: aiden voice doctor | tts "<text>" | transcribe <file>',
    )
    .allowUnknownOption()
    .action(async (args: string[]) => {
      const { runVoiceSubcommand } = await import('./voiceCli');
      const action = (args[0] ?? 'doctor').toLowerCase();
      const rest = args.slice(1);
      const code = await runVoiceSubcommand(action, rest, {
        writeOut: opts.writeOut,
        writeErr: (t: string) => process.stderr.write(t),
      });
      // Non-interactive subcommand: always exit with the honest code (was only
      // exiting on failure, so `voice doctor` SUCCESS hung on a lingering
      // handle). All voice actions return a code and none are long-running.
      process.exit(code);
    });

  program
    .command('subagent <action>')
    .description(
      'Subagent fanout diagnostics (Phase v4.1-subagent). Actions: status, tools.',
    )
    .action(async (action: string) => {
      const { runSubagentSubcommand } = await import('./commands/subagent');
      const code = await runSubagentSubcommand(action, {
        writeOut: opts.writeOut,
        writeErr: (t: string) => process.stderr.write(t),
      });
      if (code !== 0) process.exit(code);
    });

  program
    .command('fanout [args...]')
    .description(
      'Run a parallel agent fanout (Phase v4.1-subagent). ' +
      'Usage: aiden fanout "<query>" --n=3 --merge=combine [--mode=ensemble] [--dry-run]',
    )
    .allowUnknownOption()
    .action(async (args: string[]) => {
      const { runFanoutCli } = await import('./commands/fanout');
      const code = await runFanoutCli(args, {
        writeOut: opts.writeOut,
        writeErr: (t: string) => process.stderr.write(t),
      });
      if (code !== 0) process.exit(code);
    });

  // v4.1 placeholders. (`tui` graduated to a real flag in Phase 15.)
  program
    .command('cron [args...]')
    .description(
      'Cron diagnostics + one-shot list / run. ' +
      'Usage: aiden cron status | list | run <id>',
    )
    .allowUnknownOption()
    .action(async (args: string[]) => {
      const { runCronSubcommand } = await import('./cronCli');
      const action = (args[0] ?? 'status').toLowerCase();
      const rest = args.slice(1);
      const code = await runCronSubcommand(action, rest, {
        writeOut: opts.writeOut,
        writeErr: (t: string) => process.stderr.write(t),
      });
      if (code !== 0) process.exit(code);
    });

  for (const cmd of ['batch', 'gateway', 'pairing', 'update']) {
    program
      .command(cmd)
      .description(`(deferred to v4.1)`)
      .action(() => {
        const out = opts.writeOut ?? ((t) => process.stdout.write(t));
        out(`'aiden ${cmd}' is deferred to v4.1.\n`);
      });
  }

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    const out = opts.writeOut ?? ((t) => process.stderr.write(t));
    out(`${(err as Error).message}\n`);
    return 1;
  }
}

// ─── Default action: interactive chat ─────────────────────────────────

/**
 * Phase 16b: full-runtime bootstrap. Builds every subsystem the chat REPL
 * needs — provider adapter, tool registry, all 6 moat layers, AidenAgent,
 * command registry. Returns a tagged object the caller can either feed
 * straight into a `ChatSession` (the REPL path) or inspect (test path).
 *
 * `cliOpts` carries the parsed commander flags (provider/model overrides,
 * --yolo, --planner-guard, --honesty, --skill-teacher). `opts.pathsOverride`
 * lets tests redirect `~/.aiden/` to a temp dir.
 *
 * The function does NOT start the REPL or print boot output — that's the
 * caller's job. It DOES read config + run the setup wizard if the install
 * is fresh, because both happen before the moat layers can be parameterised.
 */

/**
 * v4.10 Slice 10.1b — construct the REPL's MemoryManager with cwd-derived
 * projectRoot. Single source of truth for the boot-time wiring so the
 * integration test exercises the EXACT code path production uses (no
 * `new MemoryManager({ paths, projectRoot })` shortcut in the test; if
 * a future refactor severs the boot wire, the test fails).
 *
 * `cwd` parameter is test-only; production callers omit it and the
 * default `process.cwd()` runs.
 *
 * Project root is FROZEN at REPL boot. Mid-session `git init` or cwd
 * change is not auto-detected — matches the cache shape in
 * projectRoot.ts (resolve once, reuse for the session). A
 * `/memory project rescan` slash command is planned as a future
 * power-user escape hatch (separate slice).
 */
export function createBootMemoryManager(
  paths: AidenPaths,
  cwd: string = process.cwd(),
): MemoryManager {
  const projectRoot = findProjectRoot(cwd);
  return new MemoryManager({ paths, projectRoot });
}

/**
 * v4.11 provider-auth resilience — boot fallback.
 *
 * The persisted/selected provider failed to resolve (expired OAuth
 * token, missing key, …). Find the first OTHER provider that actually
 * resolves so boot can continue into the REPL instead of hard-exiting
 * and locking the user out of `/auth` and `/model`.
 *
 * "Resolvable" is decided by `RuntimeResolver.resolve` itself — the
 * authority on credential presence + OAuth expiry. There is no
 * hardcoded priority list: the first candidate that resolves wins.
 * Candidates:
 *   1. providers `enumerateConfiguredProviders` reports as configured
 *      (env key present, OAuth token valid, or local daemon reachable);
 *   2. any provider carrying an `apiKey` in config.yaml — the enumerator
 *      inspects env vars only, so a config-only key (e.g. Together) would
 *      otherwise be missed.
 * Each candidate is then put through `resolve()`, which rejects a down
 * local daemon / stale key, so neither source produces a false positive.
 */
async function resolveFirstWorkingProvider(
  resolver: RuntimeResolver,
  config: ConfigManager,
  paths: AidenPaths,
  excludeProviderId: string,
): Promise<{ adapter: import('../../providers/v4/types').ProviderAdapter; providerId: string; modelId: string } | null> {
  const candidates: Array<{ id: string; model: string }> = [];
  const seen = new Set<string>([excludeProviderId]);

  // 1. Enumerator-confirmed providers (env key / valid OAuth / live local).
  let enumerated: Awaited<ReturnType<typeof enumerateConfiguredProviders>> = [];
  try {
    enumerated = await enumerateConfiguredProviders({ paths, env: process.env });
  } catch {
    enumerated = [];
  }
  for (const c of enumerated) {
    if (c.configured && !seen.has(c.entry.id)) {
      candidates.push({ id: c.entry.id, model: c.model });
      seen.add(c.entry.id);
    }
  }

  // 2. Config-only api keys (the enumerator checks env vars only, so a
  //    key living in config.yaml — like Together's — is added here).
  for (const entry of Object.values(PROVIDER_REGISTRY)) {
    if (seen.has(entry.id)) continue;
    const key = config.get(`providers.${entry.id}.apiKey`);
    if (key && key.length > 0) {
      candidates.push({ id: entry.id, model: pickProbeModel(entry) });
      seen.add(entry.id);
    }
  }

  // 3. resolve() is the authority — first that builds an adapter wins.
  for (const cand of candidates) {
    if (!cand.model) continue;
    try {
      const adapter = await resolver.resolve({
        providerId: cand.id,
        modelId: cand.model,
        config,
        paths,
      });
      return { adapter, providerId: cand.id, modelId: cand.model };
    } catch {
      // not resolvable — try the next candidate
    }
  }
  return null;
}

/**
 * v4.12.1 — thrown by `buildAgentRuntime({ headless })` when the install has
 * no usable provider (the point where the interactive boot would launch the
 * setup wizard). Headless callers (`aiden -q`) catch this and print a clean
 * "run `aiden setup`" message + exit non-zero instead of hanging on a wizard
 * prompt or booting a NullAdapter explore session.
 */
export class NoProviderConfiguredError extends Error {
  constructor(message = 'No provider configured') {
    super(message);
    this.name = 'NoProviderConfiguredError';
  }
}

export async function buildAgentRuntime(
  cliOpts: any,
  opts: MainOptions,
): Promise<AgentRuntime> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  await ensureAidenDirsExist(paths);

  // v4.12.1 — headless one-shot (`aiden -q`). When set, this build assembles
  // ONLY what a single agent turn needs and starts nothing long-lived: no
  // channel manager / polling, display routed to stderr so stdout stays a
  // clean pipeable answer, and approvals default to auto-DENY (no TUI to
  // prompt). See runQuery / executeOneShotTurn below.
  const headless = !!cliOpts?.headless;

  // ── v4.6 Phase 1 — always-on runStore for spawn_sub_agent ──────────────
  //
  // The spawn_sub_agent primitive persists each child run to the runs
  // table via spawned_from_run_id FK. The REPL needs a runStore handle
  // regardless of whether AIDEN_DAEMON=1 or not. SQLite WAL mode
  // (enabled in openDaemonDb) allows REPL + daemon to coexist on the
  // same file without lock contention. The connection.ts module caches
  // per-path, so when daemon foundation has already opened the DB this
  // call returns the same handle. Migration runner is idempotent on
  // already-current schemas.
  const replInstanceId = `repl-${randomUUID().slice(0, 8)}`;
  const replDb = openDaemonDb(daemonDbPath(paths.root));
  // Seed the REPL's daemon_instances row so the FK on runs.instance_id
  // is satisfied. Idempotent under INSERT OR IGNORE — multiple REPL
  // launches reusing the same instance_id (rare with random UUID
  // suffix) silently no-op.
  replDb.prepare(
    `INSERT OR IGNORE INTO daemon_instances
       (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(replInstanceId, process.pid, os.hostname(), Date.now(), Date.now(), VERSION);
  const replRunStore = createRunStore({ db: replDb });
  // v4.10 Slice 10.8 — durable Task-lite store. Shares the daemon.db
  // handle with replRunStore so /tasks listing + /adjust mutations
  // see the same WAL view chatSession's runAgentTurn writes through.
  const { createTaskStore } = await import('../../core/v4/daemon/taskStore');
  const replTaskStore = createTaskStore({ db: replDb });
  // v4.11 Slice 0 — orphan sweep. A REPL that crashed mid-turn left its
  // task row stuck at 'active' (the completed/failed transition never
  // fired). Retire those pre-boot rows to 'interrupted' so /tasks doesn't
  // accrue phantom in-flight tasks from dead sessions. The current
  // session's tasks are all created AFTER this point, so the boot-time
  // cutoff is the session guard (session id isn't assigned yet here).
  // Best-effort — a sweep failure must never block boot.
  try {
    const swept = replTaskStore.sweepOrphaned(Date.now());
    if (swept > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[tasks] swept ${swept} orphaned active task(s) from prior session(s) → interrupted`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[tasks] orphan sweep failed:',
      err instanceof Error ? err.message : String(err));
  }
  // v4.11 — artifact registry. Shares the same daemon.db handle so
  // /artifacts listing + chatSession's per-turn capture see one WAL view.
  const { createArtifactStore } = await import('../../core/v4/daemon/artifactStore');
  const replArtifactStore = createArtifactStore({ db: replDb });

  // v4.6 Phase 3A — operator kill-switch for sub-agent spawning.
  // Initialised as early as possible so any subsequent tool wiring
  // sees the singleton. The marker file lives at
  // `<paths.root>/spawn.paused` and is shared across REPL + daemon
  // + MCP for cross-process coordination. The startup probe (warn
  // operator that pause is active from a prior session) fires
  // later, once `bootLogger` is available — see the
  // `spawnPauseBootStatus` block below.
  const { initSpawnPause } = await import('../../core/v4/subagent/spawnPause');
  const spawnPauseState = initSpawnPause({ aidenHome: paths.root });

  // v4.6 Phase 3b — self-improvement loop. Initialise the durable
  // failure-ledger / recovery-report store against the same
  // daemon.db handle the runStore uses. WAL coexistence: REPL +
  // daemon + MCP all share the same connection-cached handle, so
  // any writes from one runtime are visible to the others. The
  // TCE write-through path inside the agent loop reads through the
  // module-level singleton; initialising here makes spawnSubAgent
  // and daemon-fired turns observe the same persistence.
  const { initRecoveryStore } = await import('../../core/v4/selfimprovement/recoveryStore');
  initRecoveryStore({ db: replDb });
  const spawnPauseBootStatus = spawnPauseState.isPaused()
    ? spawnPauseState.status()
    : null;

  // v4.6 Phase 2Q-B — mutable holder for the REPL's current parent
  // run id. ChatSession's `runAgentTurn` writes a row before each
  // turn dispatches and stores the id here (and clears it on
  // completion). The spawn / fanout tool factories below read it
  // through `resolveParentRunId` / `resolveParentSessionId`
  // callbacks so any child spawned mid-turn is linked back to the
  // live REPL parent row via `runs.spawned_from_run_id`.
  //
  // v4.10 Slice 10.2c — `chatSessionId` is the LONG-LIVED REPL session
  // id (mirror of ChatSession.sessionId, set once during run() init,
  // never cleared between turns). `sessionId` above is the turn-scoped
  // mirror that gets nulled on turn completion — fine for emitter
  // sites (they're called only during a turn) but wrong for read
  // surfaces like /trace recent and trace_query, which want "this
  // conversation" not "this turn." Tracked separately so the
  // existing per-turn lifecycle of `runId` / `sessionId` stays
  // unchanged.
  const replParentRunRef: {
    runId:         number | null;
    sessionId:     string | null;
    chatSessionId: string | null;
  } = {
    runId:         null,
    sessionId:     null,
    chatSessionId: null,
  };

  // Phase 16c.2: load `paths.envFile` (the aiden-managed `.env` that
  // `setupWizard.ts::upsertEnvVar` writes to) into `process.env` BEFORE
  // any provider resolution. The bug: setup wrote keys to this file but
  // the runtime never read them back, so users who configured via the
  // wizard saw "GROQ_API_KEY unset" at boot. Existing process.env entries
  // (from the user's shell or Windows User env) win — this is fill-only.
  loadAidenEnvFile(paths.envFile);

  // Phase 16b.3: first-run SOUL.md seed. idempotent write.
  // Phase 16g: the seeder may emit a one-time `notice` when SOUL.md is
  // user-edited and the bundled default has been upgraded — we surface
  // it via a dim line on boot so the user can opt in to the new
  // autonomy directives at their leisure.
  let soulNotice: string | undefined;
  try {
    const r = await ensureSoulMdSeeded(paths);
    soulNotice = r.notice;
  } catch {
    /* permission etc. — non-fatal */
  }

  // Phase 16b.1: first-run / self-heal copy of bundled skills. No-op
  // when the user's skills dir is already populated.
  await restoreBundledSkillsIfNeeded(paths).catch(() => undefined);

  // Phase 22 Group C smoke-fix: re-sync bundled skills whenever the
  // package's bundle version differs from the version recorded in
  // user-data. Without this, bundle-side updates (tightened
  // descriptions, new SKILL.md content) never reached existing
  // installs — restoreBundledSkillsIfNeeded only fires on first run.
  // User-modified skills (per BundledManifest) are preserved.
  try {
    const sync = await syncBundledSkillsIfStale(paths);
    if (sync.versionUpdated && sync.refreshed + sync.added > 0) {
      // Single line on stderr so users see the upgrade happen but
      // the boot card stays clean. skillsLogger isn't constructed
      // yet at this point in the boot sequence.
      process.stderr.write(
        `[skills] refreshed ${sync.refreshed}, added ${sync.added}, preserved ${sync.preserved} (bundle ${sync.installedVersion || '<fresh>'} → ${sync.bundleVersion})\n`,
      );
    }
  } catch {
    /* silent — sync is best-effort, restore already populated dirs */
  }

  const config = new ConfigManager(paths);
  await config.load();

  // v4.5 Phase 8a — initialise the runtimeToggles singleton with a
  // ConfigManager seam so /sandbox /tce /browser-depth flips persist
  // to config.yaml. Core modules (sandboxConfig, turnState,
  // browserState) consult this singleton; precedence is
  // env > config.yaml > default per Q-P8a-1(a).
  {
    const { initRuntimeToggles } = await import('../../core/v4/runtimeToggles');
    initRuntimeToggles({
      configRead: (key) => config.getValue(key),
      configWriteAndSave: async (key, value) => {
        config.set(key, value);
        await config.save();
      },
    });
  }

  // Phase 30.2 — fresh-user UX. Detection extends the old
  // `isFreshInstall`-only gate so we cover three new failure modes:
  //   1. fresh user with no env / no OAuth / no config → wizard fires
  //      (was working under the old gate; still does).
  //   2. user with config.yaml pointing at chatgpt-plus but a stale /
  //      missing OAuth token file → wizard fires (was NOT under old
  //      code — it saw config.yaml present and proceeded into a
  //      broken resolve, which surfaced as a confusing rate-limit
  //      error on the user's first chat).
  //   3. user with no config but Ollama running OR an env API key
  //      → wizard fires anyway. ConfigManager's DEFAULT_CONFIG points
  //      at `anthropic / claude-opus-4-7`, which doesn't match the
  //      detected env / Ollama, so skipping the wizard would surface
  //      the same confusing "missing ANTHROPIC_API_KEY" error.
  //   4. moat-boot test fixtures that stub `providers.fake.apiKey`
  //      inline in config.yaml count as configured — `isFreshInstall`
  //      already returns false for them so `wizardNeeded` stays false.
  const detection = await detectAvailableProviders({ paths });
  const configuredProviderBroken =
    !!detection.configProvider &&
    !detection.configuredProviderHasCredentials;
  // v4.11 bug fix — was: `... || (await isFreshInstall(paths))` raw,
  // which auto-fired the wizard for a LIVE config whose creds live
  // outside the config.yaml `providers:` map (OAuth tokens / env key),
  // risking overwrite of a working setup. `shouldRunWizard` honours
  // `configuredProviderHasCredentials` so a config that already names a
  // usable provider is NOT treated as fresh. See providerDetection.ts.
  const wizardNeeded = shouldRunWizard(detection, {
    forceSetup: !!opts.forceSetup,
    configEmpty: await isFreshInstall(paths),
  });

  // Phase 30.2.1: when the wizard returns 'skipped' (explore mode) we
  // boot the REPL with a NullAdapter instead of trying to resolve a
  // real provider. Flagged here, set inside the wizard block, and
  // consumed when building the adapter.
  let exploreMode = false;

  if (wizardNeeded) {
    // v4.12.1 — headless one-shot must never prompt (no TTY) nor silently
    // boot a NullAdapter explore session that would return a junk answer.
    // Bail with a typed error the caller maps to a clean "run `aiden setup`"
    // message + non-zero exit.
    if (headless) {
      throw new NoProviderConfiguredError();
    }
    // v4.5 Phase 7c — TTY guard. The wizard uses inquirer prompts
    // which block on stdin. When stdin is NOT a TTY (systemd unit
    // start, launchd run, piped invocation, CI), there's no user
    // to answer, so the wizard would hang forever — which in turn
    // blocks the rest of buildAgentRuntime AND any post-build
    // daemon wiring. Bail into exploreMode instead so the REPL
    // boots with a NullAdapter; the daemon foundation (started at
    // top of REPL action handler) keeps serving trigger rails with
    // the placeholder runner. The operator runs `aiden` interactively
    // once to finish configuration; from then on the real-agent
    // runner installs on every subsequent boot.
    if (!process.stdin.isTTY) {
      process.stderr.write(
        '[setup] stdin is not a TTY — skipping interactive wizard. ' +
        'Booting in explore mode with NullAdapter. ' +
        'Run `aiden` from a terminal once to configure a provider.\n',
      );
      exploreMode = true;
      // Skip the wizard block entirely; fall through to adapter
      // build with exploreMode=true so a NullAdapter is used.
    } else {
    if (!detection.hasAnyProvider) {
      // Truly empty: no env, no OAuth, no Ollama, no inline config.
      process.stdout.write(`\n${summarizeDetection(detection)}\n`);
    } else if (configuredProviderBroken) {
      // Config points at a provider we can't credential-resolve.
      process.stdout.write(
        `\nConfigured provider '${detection.configProvider}' has no usable credentials ` +
          `at ${path.join(paths.root, 'auth', `${detection.configProvider}.json`)}.\n`,
      );
    } else {
      // Detected something (env / oauth / ollama) but config.yaml is
      // missing or empty — DEFAULT_CONFIG would route to anthropic and
      // the resolver would fail. Surface the detection so the user
      // sees what we found, then walk them through proper setup.
      process.stdout.write(`\n${summarizeDetection(detection)}\n`);
      process.stdout.write(
        'config.yaml is empty — let\'s pick a provider that matches.\n',
      );
    }
    // ONB1-WIRE — disclaimer + loading screens land BEFORE the wizard.
    // Only inside this TTY-guarded branch (the non-TTY branch at the
    // outer else already bails into explore mode). The detection
    // summary above gives the user context for what was found; the
    // disclaimer then asks for explicit consent before we walk them
    // through setup. Declining exits 0 — the user chose not to
    // continue, that's not an error.
    //
    // Lazy-required so the test harness paths that stub the wizard
    // don't pay the load cost.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { showDisclaimer } = require('./onboarding/disclaimer') as typeof import('./onboarding/disclaimer');
    const disc = await showDisclaimer();
    if (!disc.ok) {
      // User typed 'n' / 'no'. The disclaimer already printed the
      // friendly goodbye line; just exit cleanly.
      process.exit(0);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runLoadingSequence, defaultLoadingSteps } =
      require('./onboarding/loading') as typeof import('./onboarding/loading');
    await runLoadingSequence(defaultLoadingSteps(paths));

    process.stdout.write('\n');

    // v4.9.5 Slice 1.6 — pass force when invoked via `aiden setup`
    // subcommand so the wizard fires even when config.yaml is already
    // populated. On true fresh installs `opts.forceSetup` is undefined
    // (force=false) and isFreshInstall already gates inside the
    // wizard; behavior unchanged for that path.
    const result = await runSetupWizard({ paths, force: !!opts.forceSetup });

    // Phase 30.2.1: three exit states.
    if (result.status === 'exited') {
      // Recovery option [5] — clean exit, no REPL.
      process.exit(0);
    }
    if (result.status === 'skipped') {
      // Recovery option [4] "explore mode" OR Ctrl+C cancellation.
      // Boot continues into the REPL with a NullAdapter; chat is
      // intercepted by ChatSession, slash commands work normally.
      // Flagged here and consumed below where the adapter is built.
      exploreMode = true;
    }

    // 'configured' (or 'skipped' — we still want the env/.env reload
    // for slash commands like /providers that read fresh state) →
    // re-load both so the resolver sees what the wizard wrote.
    loadAidenEnvFile(paths.envFile);
    await config.load();
    }       // end of TTY branch
  }

  // Phase v4.1.2-bug1: boot model selection now consults the priority-
  // list auto-picker (cli/v4/providerBootSelector.ts) instead of
  // hardcoded `groq + llama-3.3-70b-versatile`. Users with chatgpt-plus
  // OAuth (the post-v4.1.1 onboarding default) used to boot into Groq
  // and hit a 400 on the first tool-bearing request — llama-3.3-70b's
  // tool emission is rejected by Groq's first-party validator.
  //
  // Precedence (handled inside resolveBootProvider):
  //   1. Both --provider + --model flags  → use them
  //   2. One flag only                     → use it, resolve other
  //   3. Persisted model-selection.json   → use it
  //   4. Partial config                    → use it, resolve other
  //   5. Auto-pick from priority list      → first authed provider
  //   6. Nothing authed                    → hardcoded groq fallback
  let providerId: string;
  let modelId:    string;
  let bootSource: 'cli-flag' | 'persisted-config' | 'auto-priority' | 'cli-flag-partial' | 'config-partial' | 'hardcoded-fallback';
  try {
    const selection = await resolveBootProvider(
      {
        cliProviderId: cliOpts.provider as string | undefined,
        cliModelId:    cliOpts.model    as string | undefined,
        cfgProviderId: config.getValue<string>('model.provider'),
        cfgModelId:    config.getValue<string>('model.modelId'),
      },
      () => enumerateConfiguredProviders({ paths, env: process.env }),
    );
    if (selection) {
      providerId = selection.providerId;
      modelId    = selection.modelId;
      bootSource = selection.source;
    } else {
      // Case 6: nothing authed — preserve the prior hardcoded default
      // so the legacy first-run path (manual API-key entry into .env)
      // still works.
      providerId = 'groq';
      modelId    = 'llama-3.3-70b-versatile';
      bootSource = 'hardcoded-fallback';
    }
  } catch (err) {
    process.stderr.write(`aiden: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Resolve session continuation.
  const store = new SessionStore(paths.sessionsDb);
  const sessionManager = new SessionManager(store);
  let resumeSessionId: string | undefined;
  if (cliOpts.continue) {
    const last = sessionManager.resumeLatest();
    if (last) resumeSessionId = last.id;
  } else if (cliOpts.resume) {
    const found = sessionManager.resumeById(cliOpts.resume as string);
    if (found) resumeSessionId = found.id;
    else {
      process.stderr.write(`No session found matching "${cliOpts.resume}".\n`);
      process.exit(1);
    }
  }

  const skin = new SkinEngine();
  // Headless one-shot: route ALL display output to stderr so stdout carries
  // only the agent's answer (pipeable). Nothing streams to `display` during a
  // headless turn (runConversation is called bare), but any boot-time notice
  // must not pollute stdout.
  const display = headless
    ? new Display({ skin, stdout: process.stderr, stderr: process.stderr })
    : new Display({ skin });
  const warnSink = (msg: string) => display.warn(msg);

  // Resolver + adapter.
  const credentialResolver = new CredentialResolver(paths.authJson);
  const resolver = new RuntimeResolver(credentialResolver);
  let adapter;
  if (exploreMode) {
    // Phase 30.2.1 — wizard skipped. Use a NullAdapter so AidenAgent
    // construction succeeds; ChatSession will intercept chat attempts
    // BEFORE calling the adapter and surface the friendly message.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NullAdapter } = require('../../providers/v4/nullAdapter');
    adapter = new NullAdapter();
  } else {
    try {
      adapter = await resolver.resolve({ providerId, modelId, config, paths });
    } catch (err) {
      // v4.11 provider-auth resilience: the selected default failed to
      // resolve (expired OAuth token, missing key, …). Hard-exiting here
      // locked the user out of the very commands that fix it (/auth,
      // /model). Instead: warn, fall back to the first OTHER provider that
      // actually resolves, and only drop to a NullAdapter (recovery mode)
      // if nothing resolves — the REPL must still load either way.
      display.warn(
        `Provider '${providerId}' unavailable: ${(err as Error).message}`,
      );
      const fb = await resolveFirstWorkingProvider(resolver, config, paths, providerId);
      if (fb) {
        adapter    = fb.adapter;
        providerId = fb.providerId;
        modelId    = fb.modelId;
        display.dim(
          `[boot] fell back to ${providerId} · ${modelId}  (previous default unavailable)`,
        );
      } else {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { NullAdapter } = require('../../providers/v4/nullAdapter');
        adapter = new NullAdapter();
        display.warn(
          'No working provider found — starting in recovery mode. Run ' +
          '`/auth login <provider>` or `/auth refresh <provider>`, or `/model` ' +
          'to pick a configured provider, then restart.',
        );
      }
    }
    // Phase v4.1.2-bug1: surface the auto-pick in the boot log when
    // neither CLI flags nor persisted config specified the choice.
    // Silent on explicit selections so power users don't see noise.
    if (bootSource === 'auto-priority') {
      display.dim(`[boot] ${providerId} · ${modelId}  (auto · first authed provider)`);
    } else if (bootSource === 'hardcoded-fallback') {
      display.dim(
        `[boot] ${providerId} · ${modelId}  (no authed providers detected — using legacy default)`,
      );
    }
  }

  // Phase 16b.1: wrap chat_completions providers in a FallbackAdapter so
  // 429s on Groq slot 1 transparently retry Groq slot 2/3 and Together.
  // Only activates when there's at least one *additional* slot configured
  // beyond the primary — otherwise the wrapper would just rethrow.
  // Phase 30.2.1: skip in explore mode — wrapping a NullAdapter in
  // FallbackAdapter would just defer the friendly error one layer.
  let fallbackAdapter: FallbackAdapter | null = null;
  if (
    !exploreMode &&
    adapter.apiMode === 'chat_completions' &&
    (providerId === 'groq' || providerId === 'together')
  ) {
    const slots = buildAgentFallbackSlots(adapter, providerId, modelId);
    const reachable = slots.filter((s) => s.keyPresent);
    if (reachable.length >= 2) {
      fallbackAdapter = new FallbackAdapter({
        apiMode: 'chat_completions',
        slots,
        onRateLimit: (slotId) =>
          display.dim(`(slot ${slotId} rate-limited — falling through)`),
      });
      adapter = fallbackAdapter;
    }
  }

  // v4.12 B2.2a — wire the active adapter/model for one-shot vision calls
  // (browser_see). Routing checks supportsVision at call time; no re-routing.
  setVisionProvider({ adapter, providerId, modelId });

  // Tool registry + executor.
  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry);

  // v4.11 toolset grouping — resolve the active tool profile ONCE at
  // boot. The profile name comes from (env > config > 'standard')
  // and the concrete toolset list is what `toolRegistry.getSchemas`
  // filters on at the AidenAgent construction site below. Resolved
  // here (early, before the agent is built) so the boot dim line
  // shows the user which catalog they're getting before the model
  // ever sees it.
  //
  // The profile is STATIC for the session — flip via /tools <name>
  // or AIDEN_TOOL_PROFILE env override on the next boot. The runtime
  // never auto-swaps profiles per turn; that would thrash the
  // provider prefix cache (the absorbed pattern from the reference
  // implementation we studied explicitly rejected per-turn churn).
  const toolProfile: ResolvedProfile = resolveBootProfile(
    process.env.AIDEN_TOOL_PROFILE,
    config.getValue<string>('agent.tool_profile'),
    config.getValue<string[]>('agent.tool_profile_toolsets'),
  );
  {
    const filterDesc = toolProfile.toolsets === undefined
      ? 'all toolsets'
      : `[${[...toolProfile.toolsets].join(', ')}]`;
    display.dim(
      `[tools] profile=${toolProfile.name} (${toolProfile.source}) → ${filterDesc}`,
    );
  }

  // Memory + skill loader.
  // v4.10 Slice 10.1b — route through createBootMemoryManager so
  // projectRoot is detected from cwd. The helper is exported below
  // so the integration test exercises the SAME construction code path
  // as production (Phase D: real boot wire, not a hand-assembled
  // MemoryManager — the discipline gap that caused Slice 10.1's
  // initial smoke failure).
  const memoryManager = createBootMemoryManager(paths);
  // Phase 16b.2: malformed-skill warnings go to a file logger, not the
  // REPL spinner. The scan runs ONCE here and the result is cached on
  // the loader instance — every per-turn caller (chatSession banner,
  // skillCommands, skill_manage, etc.) reads the cache.
  const skillsLogger = createFileLogger(paths.logsDir, 'skills');
  const skillLoader = new SkillLoader(paths, { logger: skillsLogger });
  await skillLoader.loadAll().catch(() => undefined);
  const skillCounts = skillLoader.getLastCounts();
  const skipNote =
    skillCounts.skipped > 0
      ? ` (see ${skillsLogger.filePath})`
      : '';
  display.dim(
    `[skills] ${skillCounts.loaded} loaded, ${skillCounts.skipped} skipped${skipNote}`,
  );
  // Phase 17 Task 5: plugin loader boot.
  //
  // Bundled plugins (e.g. aiden-plugin-cdp-browser) are discovered
  // IN-PLACE from the package's plugins/ directory rather than copied
  // to the user dir. Reason: bundled plugins may depend on packages
  // declared in the runtime's package.json (chrome-remote-interface
  // for CDP). require() from a user-dir copy would fail because the
  // user dir has no node_modules. Users still install third-party
  // plugins into paths.pluginsDir via /plugins install — those plugins
  // ship with their own deps or stay dep-free.
  //
  // restoreBundledPluginsIfNeeded remains available for future
  // dep-free bundled plugins but is intentionally not invoked at boot.
  const bundledDir = await resolveBundledPluginsDir().catch(() => null);
  // Phase 18: OAuth provider registry. The bundled claude-pro and
  // chatgpt-plus plugins call ctx.registerOAuthProvider() during their
  // register() — without a registry wired in, that throws. /auth login,
  // /auth refresh, and the inference resolver all read tokens via
  // tokenStore directly so this registry is mostly a side-effect home;
  // useful when /auth needs the OAuthProvider object (refresh path).
  const oauthRegistry = new OAuthProviderRegistry();
  const pluginLoader = new PluginLoader({
    paths,
    toolRegistry,
    bundledDir: bundledDir ?? undefined,
    evaluatePermissions: evaluatePermissionState,
    oauthRegistry,
    log: (level, msg) => {
      // Soft logging — boot card surfaces user-visible state separately.
      // File-only; avoid REPL spinner noise.
      if (level === 'warn') skillsLogger.warn(`[plugins] ${msg}`);
      else if (level === 'error') skillsLogger.error(`[plugins] ${msg}`);
    },
  });
  await pluginLoader.discoverAndLoad();
  // Activate granted plugins (e.g. CDP browser onActivate that ensures
  // CDP is reachable). pending-grant + suspended plugins never had
  // register() complete or never registered hooks, so this only fires
  // hooks of fully-loaded plugins.
  await pluginLoader.fireHook('onActivate');
  // Render the boot card per Phase 17 Task 5 spec.
  const bootCard = formatPluginBootCard(pluginLoader.getRegistry().list());
  for (const ln of bootCard.lines) {
    if (ln.severity === 'green') display.success(ln.text);
    else if (ln.severity === 'yellow') display.warn(ln.text);
    else if (ln.severity === 'red') display.printError(ln.text);
    else display.dim(ln.text);
  }
  // v4.5 TUI polish — blank line so the plugin boot card breathes
  // before the AIDEN banner stamps in below.
  display.write('\n');

  // Phase 16g: surface the SOUL.md upgrade notice once on boot (only
  // when set — for users with edited SOUL.md that would have been
  // silently overwritten by the upgrade).
  if (soulNotice) {
    display.dim(`[soul] ${soulNotice}`);
  }

  // v4.5 update system — the old setImmediate dim/warn one-liner
  // here was superseded by the interactive boot prompt rendered
  // later inside `chatSession.run()::maybeShowBootUpdatePrompt`.
  // Single surface for update notification: the boxed prompt.
  // Pre-warm the registry probe so the cache is fresh by the time
  // the prompt asks — same non-blocking pattern, same opt-out
  // semantics, no user-visible output from this call.
  setImmediate(async () => {
    try {
      const { checkForUpdate } = await import('../../core/v4/update/checkUpdate');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require('../../package.json') as { version: string };
      await checkForUpdate({ paths, installedVersion: pkg.version });
    } catch {
      /* silent — update check is best-effort */
    }
  });

  // ── Phase 9 moat (stateless / wraps memory) ──────────────────────────
  const memoryGuard = new MemoryGuard(memoryManager);
  const ssrfProtection = new SSRFProtection();
  const tirithScanner = new TirithScanner();

  // Approval engine.
  // Phase 16f: default flips manual → smart per the approval-modes audit.
  // Smart mode short-circuits BUILTIN_SAFE_TOOLS / BUILTIN_SAFE_DOMAINS
  // and consults the recorded allowlist; only unseen non-safe calls
  // prompt. Use --yolo / `/yolo` to skip prompts entirely.
  const approvalEngine = new ApprovalEngine(
    config.getValue<'manual' | 'smart' | 'off'>('agent.approval_mode', 'smart'),
  );
  if (cliOpts.yolo) {
    approvalEngine.setMode('off', { userInitiated: true });
  } else if (headless) {
    // v4.12.1 — headless one-shot (`aiden -q`) forces MANUAL mode,
    // overriding the user's config `agent.approval_mode`. This makes the
    // safety switch deterministic and config-independent:
    //   • read-category tools still auto-allow (checkApproval short-circuits
    //     category==='read' before any mode/callback — harmless list/read).
    //   • EVERY mutating (write/execute/network/browser) tool routes to
    //     promptUser, which the headless override below answers 'deny'.
    // Two bugs this closes: (1) a config `approval_mode: off` would have
    // auto-allowed DESTRUCTIVE tools in `-q` non-yolo; (2) `smart` mode
    // runs the auxiliary-LLM riskAssess, which could rate a mutating call
    // 'safe' and auto-allow it (and is a network hop in a headless path).
    // `--yolo` (mode 'off' above) remains the explicit opt-in to run tools.
    approvalEngine.setMode('manual', { userInitiated: true });
  }
  // ★ v4.12.1 Pillar 2 — install the autonomy policy for the INTERACTIVE
  // session (the dial). Skipped for --yolo (mode 'off' short-circuits the
  // policy anyway) and for headless -q (its manual+deny floor is preserved
  // exactly). The workspace root is the cwd — Partner auto-allows writes
  // under it; everything else asks. Set BEFORE freeze so it's the boot
  // default; `/autonomy` changes it post-freeze via userInitiated.
  if (!cliOpts.yolo && !headless) {
    const level = resolveConfiguredAutonomyLevel(config);
    approvalEngine.setAutonomyPolicy(
      resolveAutonomyPolicy(level, { workspaceRoots: [process.cwd()] }),
    );
  }
  // ★ v4.12 SH.1 — freeze the mode once boot-time setup (config default +
  // --yolo) is done. From here, only user-initiated /yolo may flip it; a held
  // ApprovalEngine ref in tool/plugin code can NOT silently disable approvals.
  approvalEngine.freeze();
  // Phase 16f / v4.10 Slice 10.6: hydrate persistent allowlist from
  // BOTH sources so "Allow always" choices survive across REPL
  // restarts AND project-specific permissions don't bleed across
  // unrelated projects.
  //
  //   1. Global: <AIDEN_HOME>/approvals.json (existing Phase-16f path).
  //   2. Project: <cwd>/.aiden/approvals.json (new Slice 10.6 path).
  //
  // Project entries load AFTER global, so a project-scoped grant
  // shadows a global one for the same tool::signature (Map last-write-
  // wins inside loadPersistentAllowlist). Each entry carries a
  // `scope` marker so the future `aiden approvals list` surface
  // can group by origin.
  //
  // Entry shape supports BOTH pre-10.6 `{tool, signature}` and the
  // new `{tool, signature, createdAt, lastUsedAt}`. Legacy entries
  // get Date.now() defaults at load; the next persistAllow write
  // bakes timestamps into the file.
  const fsForLoad = require('node:fs');
  type LegacyOrNewEntry = {
    tool:        string;
    signature:   string;
    createdAt?:  number;
    lastUsedAt?: number;
  };
  function loadEntries(filePath: string, scope: 'global' | 'project'): Array<LegacyOrNewEntry & { scope: 'global' | 'project' }> {
    try {
      const raw = fsForLoad.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((e: any) => e && typeof e.tool === 'string' && typeof e.signature === 'string')
        .map((e: any) => ({
          tool:       e.tool,
          signature:  e.signature,
          createdAt:  typeof e.createdAt  === 'number' ? e.createdAt  : undefined,
          lastUsedAt: typeof e.lastUsedAt === 'number' ? e.lastUsedAt : undefined,
          scope,
        }));
    } catch {
      // Missing or unreadable file is fine — no allowlist at that scope.
      return [];
    }
  }
  const projectApprovalsJson = require('node:path').join(process.cwd(), '.aiden', 'approvals.json');
  const allEntries = [
    ...loadEntries(paths.approvalsJson, 'global'),
    ...loadEntries(projectApprovalsJson, 'project'),
  ];
  if (allEntries.length > 0) approvalEngine.loadPersistentAllowlist(allEntries);

  // v4.10 Slice 10.6 — refresh sink. When a permanent-allow entry
  // short-circuits a prompt during a turn, the engine bumps its
  // in-memory lastUsedAt. We persist the refreshed entry back to
  // disk (best-effort) so the on-disk file remains an accurate
  // audit trail of "what permissions actually got used recently."
  // Throttling: a single hot tool could fire this many times per
  // session; the rewrite cost is small (file is tiny) and atomic
  // (tmp-rename pattern below).
  approvalEngine.setRefreshSink((entry) => {
    const targetPath = entry.scope === 'project' ? projectApprovalsJson : paths.approvalsJson;
    try {
      const fs = require('node:fs');
      let cur: Array<Record<string, unknown>> = [];
      try {
        const raw = fs.readFileSync(targetPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) cur = parsed;
      } catch { /* fresh file */ }
      let touched = false;
      for (const e of cur) {
        if (e.tool === entry.tool && e.signature === entry.signature) {
          e.lastUsedAt = entry.lastUsedAt;
          touched = true;
          break;
        }
      }
      if (!touched) return;       // entry isn't in this file — refresh is a no-op here
      const tmp = `${targetPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), 'utf8');
      fs.renameSync(tmp, targetPath);
    } catch { /* refresh is best-effort; never crash a turn */ }
  });

  // Auxiliary client (compression / risk-assessment / session-summary
  // / skill-describe). v4.8.0 Slice 11 — route through Groq's cheap
  // 8B model as the default, with the parent provider/model as the
  // fallback when Groq isn't configured. Fixes the ChatGPT Plus +
  // gpt-5 routing bug: pre-Slice-11 auxiliary inherited the parent
  // (codex backend, accepts only `gpt-5-codex`/`gpt-4.1-mini`/etc.)
  // and every aux call returned a 400 model-not-supported. Groq is
  // cheap, fast, and reliable for the cheap classify/summarise jobs
  // auxiliary is designed for. If the user has no GROQ_API_KEY, the
  // resolver throws and we fall through to the parent — no regression
  // for non-codex users.
  //
  // Skip the parent fallback when the parent IS already the Groq cheap
  // model — same identity attempt twice is just noise in the verbose
  // log. (Resolver dedup; the auxiliary client itself doesn't filter.)
  const AUX_DEFAULT_PROVIDER = 'groq';
  const AUX_DEFAULT_MODEL    = 'llama-3.1-8b-instant';
  const parentSameAsDefault =
    providerId === AUX_DEFAULT_PROVIDER && modelId === AUX_DEFAULT_MODEL;
  const auxiliaryClient = new AuxiliaryClient({
    defaultProvider: AUX_DEFAULT_PROVIDER,
    defaultModel:    AUX_DEFAULT_MODEL,
    fallbacks: parentSameAsDefault
      ? []
      : [{ providerId, modelId }],
    // Phase 21 #5: ensure the auxiliary path also honors entry.oauth →
    // tokenStore. If a user runs the auxiliary cheap LLM through an
    // OAuth-only provider, omitting `paths` would skip the fast-path
    // and surface the same auth.json error as /model. The auxiliary
    // resolver type doesn't surface a paths field, so we always inject
    // the boot-resolved paths here.
    resolver: { resolve: (o) => resolver.resolve({ ...o, paths }) },
  });

  // CLI callbacks. Approval engine is stitched up after construction
  // because `callbacks.promptApproval` is a bound method.
  const callbacks = new CliCallbacks({
    display,
    auxiliaryClient,
    verboseMode: 'normal',
  });
  approvalEngine['callbacks'] = {
    promptUser: callbacks.promptApproval,
    riskAssess: callbacks.riskAssess,
    // v4.8.0 Phase 2.5 — paint the structured approval row before the
    // existing y/n prompt runs. Additive; promptApproval flow unchanged.
    // v4.10 Slice 10.2 — also tee into run_events when a parent run is
    // in flight. Approval requests fired between turns (slash-command
    // paths) skip persistence (no runId yet). Same try/catch shape as
    // the chatSession site.
    onUiEvent: (name: string, args: Record<string, unknown>) => {
      display.renderUiEvent(name, args);
      const rid = replParentRunRef.runId;
      if (rid !== null) {
        // v4.10 Slice 10.2b — rich emission with (category, kind, name)
        // taxonomy. Source='repl' because the approvalEngine fires
        // through the REPL surface, not the daemon dispatcher.
        try {
          const tags = categorizeEvent(name);
          replRunStore.emitEventRich({
            runId:     rid,
            category:  tags.category,
            kind:      tags.kind,
            name,
            sessionId: replParentRunRef.sessionId ?? null,
            payload:   args,
            visibility:'model',
            source:    'repl',
          });
        } catch { /* persistence faults must never break dispatch */ }
      }
    },
    // v4.10 Slice 10.6 — REPL approval-decision audit. Symmetric to
    // the daemon path (daemonApproval.ts:onDecision, wired Slice 10.2b).
    // Without this wire, REPL approval REQUESTS landed in run_events
    // (via onUiEvent above) but the actual DECISIONS did not — so
    // /trace recent could surface "permission asked" but never
    // "permission granted/denied" for REPL turns. The audit gap was
    // the direct mirror of the Slice 10.2d tool_call coverage gap:
    // grep-based emit-site audits don't catch "site that should emit
    // but doesn't." Best-effort try/catch so a persistence fault
    // never crashes a decision in flight.
    onDecision: (req, decision) => {
      const rid = replParentRunRef.runId;
      if (rid === null) return;
      try {
        const tags = categorizeEvent('approval_decision');
        replRunStore.emitEventRich({
          runId:     rid,
          category:  tags.category,
          kind:      tags.kind,
          name:      'approval_decision',
          sessionId: replParentRunRef.sessionId ?? null,
          status:    decision === 'deny' ? 'denied' : 'allowed',
          summary:   `${req.toolName} → ${decision} (${req.riskTier ?? 'caution'})`,
          payload: {
            toolName: req.toolName,
            category: req.category,
            riskTier: req.riskTier ?? 'caution',
            reason:   req.reason ?? null,
            decision,
          },
          visibility: 'system',
          source:     'repl',
        });
      } catch { /* observability must never break a decision */ }
    },
    // Phase 16f / v4.10 Slice 10.6: append-on-disk for "Allow always"
    // choices. Single-process REPL — atomic write via tmp-then-rename.
    //
    // Slice 10.6 — entries now carry `createdAt` + `lastUsedAt`
    // timestamps so listing surfaces can flag stale grants and audit
    // trails record when each permission was first granted. New
    // entries land at the GLOBAL scope (~/.aiden/approvals.json) by
    // default — a future slice may add a "save to project" choice in
    // the prompt for explicit project-scoped grants.
    //
    // De-dupe: if the same tool::signature already exists, refresh
    // its `lastUsedAt` so re-granting a permission updates the
    // audit trail rather than silently no-op'ing.
    persistAllow: (tool: string, signature: string) => {
      const fs = require('node:fs');
      let entries: Array<{
        tool:        string;
        signature:   string;
        createdAt?:  number;
        lastUsedAt?: number;
      }> = [];
      try {
        const cur = fs.readFileSync(paths.approvalsJson, 'utf8');
        const parsed = JSON.parse(cur);
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        /* fresh file */
      }
      const now = Date.now();
      const existing = entries.find((e) => e.tool === tool && e.signature === signature);
      if (existing) {
        // Already persisted — refresh lastUsedAt, keep original createdAt.
        existing.lastUsedAt = now;
        if (typeof existing.createdAt !== 'number') existing.createdAt = now;
      } else {
        entries.push({ tool, signature, createdAt: now, lastUsedAt: now });
      }
      const tmp = `${paths.approvalsJson}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
      fs.renameSync(tmp, paths.approvalsJson);
    },
  } as any;

  // v4.12.1 — headless one-shot approval: there is no TTY to confirm on, so
  // override the interactive prompt with a synchronous auto-DENY (mirrors the
  // child-subagent auto-deny in core/v4/subagent/childBuilder.ts). Combined
  // with the forced 'manual' mode above, EVERY mutating tool routes here and
  // is denied; read-category tools auto-allow before this callback (harmless).
  // Denials surface to the caller as a non-zero exit. `--yolo` sets mode 'off'
  // earlier (auto-allow all), so promptUser is never reached in that case.
  // onUiEvent is silenced so no approval chrome leaks.
  if (headless) {
    approvalEngine['callbacks'] = {
      ...(approvalEngine['callbacks'] as object),
      promptUser: async () => 'deny',
      onUiEvent:  () => {},
    } as any;
  }

  // MCP setup (best-effort — connection failures are non-fatal).
  const mcpResult = await setupMcpFromConfig(config, toolRegistry, { paths }).catch(
    () => ({ client: null, connected: [], failures: {} }),
  );
  const mcpClient = mcpResult.client ?? null;

  // ── Phase 12 moat: resolve modes from config + CLI flags ─────────────
  const plannerGuardMode = coerceMode<PlannerGuardMode>(
    cliOpts.plannerGuard ??
      config.getValue<string>('agent.planner_guard_mode', 'rule_based'),
    PLANNER_GUARD_MODES,
    'rule_based',
    'planner_guard_mode',
    warnSink,
  );
  const honestyMode = coerceMode<HonestyMode>(
    cliOpts.honesty ??
      config.getValue<string>('agent.honesty_mode', 'enforce'),
    HONESTY_MODES,
    'enforce',
    'honesty_mode',
    warnSink,
  );
  const skillTeacherTier = coerceMode<SkillTeacherTier>(
    cliOpts.skillTeacher ??
      config.getValue<string>('agent.skill_teacher_tier', 'tier_3_propose'),
    SKILL_TEACHER_TIERS,
    'tier_3_propose',
    'skill_teacher_tier',
    warnSink,
  );

  // PlannerGuard — pre-loop tool subset classifier. llm_classified mode
  // routes through the main provider adapter; we don't have a separate
  // cheap-classifier adapter at REPL boot (auxiliaryClient wraps but
  // doesn't expose its underlying adapter). Pass adapter only when the
  // mode actually needs it so the rule_based path stays purely local.
  const plannerGuard = new PlannerGuard(
    toolRegistry,
    plannerGuardMode,
    plannerGuardMode === 'llm_classified' ? adapter : undefined,
  );

  // HonestyEnforcement — post-loop trace inspector.
  const honestyEnforcement = new HonestyEnforcement(honestyMode);

  // SkillTeacher needs a `skill_manage` handler closure. We can't reach
  // into the ToolRegistry's bound executor here because that closure
  // bakes in a ToolContext we don't have until later — instead, we defer
  // to the registry's handler directly. SkillTeacher passes
  // `(action, args) => execute({action, ...args}, {})` so the wrapper sees
  // its argument shape. The skillManage handler accepts an empty context
  // because every action it performs is paths-relative and `paths` is
  // injected at handler-construction time (Phase 10 wiring).
  const skillManageHandler = toolRegistry.get('skill_manage');
  const skillManageProxy = {
    async execute(args: Record<string, unknown>, _ctx: unknown) {
      if (!skillManageHandler) {
        throw new Error('skill_manage handler not registered');
      }
      // Build a ToolContext mirror so skill_manage has the bits it needs.
      return skillManageHandler.execute(args, {
        cwd: process.cwd(),
        paths,
        skillLoader,
      } as any);
    },
  };
  // Phase v4.1.2-slice3: subsystem-health registry. AidenAgent owns
  // the one instance (constructor-injected, not a singleton — so
  // parallel tests don't cross-contaminate). Per-subsystem trackers
  // hang off the registry and are passed into each subsystem's
  // constructor so they can record success/failure as it happens.
  // `aiden doctor` reads `agent.subsystemHealthRegistry.snapshot()`.
  const subsystemHealthRegistry = createSubsystemHealthRegistry();
  const skillTeacherHealth = new SubsystemHealthTracker('skill-teacher');
  const skillMinerHealth   = new SubsystemHealthTracker('skill-miner');
  // Phase v4.1.2-slice4: outcome tracker — observes tool-call lifecycle,
  // attributes downstream successes/failures to skills loaded via
  // skill_view. Persisted to <skillsDir>/.skill-outcomes.json (atomic
  // write, lazy hydrate). Persist failures surface to doctor via a
  // shared slice3 SubsystemHealthTracker.
  const skillOutcomeHealth = new SubsystemHealthTracker('skill-outcome-tracker');
  const skillOutcomeTracker = new SkillOutcomeTracker(
    path.join(paths.skillsDir, '.skill-outcomes.json'),
    skillOutcomeHealth,
  );
  subsystemHealthRegistry.register(
    'skill-teacher',
    () => skillTeacherHealth.snapshot(),
  );
  subsystemHealthRegistry.register(
    'skill-miner',
    () => skillMinerHealth.snapshot(),
  );
  subsystemHealthRegistry.register(
    'skill-outcome-tracker',
    () => skillOutcomeHealth.snapshot(),
  );

  // Phase v4.1.2-memory-D fold-in (memory-C Q3 open): recall-session
  // health tracker. The tool itself (tools/v4/sessions/recallSession.ts)
  // stays pure of registry knowledge for testability; the registry
  // caller wires a tracker the tool can record into via ctx. Until
  // the tool plumbs ctx → tracker (separate follow-up), the slot stays
  // registered with a snapshot reader so doctor's expand-on-degradation
  // path sees the subsystem exists even at zero observations.
  const recallSessionHealth = new SubsystemHealthTracker('recall-session');
  subsystemHealthRegistry.register(
    'recall-session',
    () => recallSessionHealth.snapshot(),
  );

  const skillTeacher = new SkillTeacher(
    skillLoader,
    skillManageProxy,
    skillTeacherTier,
    undefined,
    (name) => toolRegistry.get(name),
    skillTeacherHealth,
  );
  // v4.1.6 Polish 2 — late-wire the SkillTeacher reference so the
  // post-render `handleSkillProposal` flow can persist accepted
  // proposals. CliCallbacks was constructed earlier (line ~906) —
  // before SkillTeacher existed — so we set it now.
  callbacks.setSkillTeacher(skillTeacher);

  // ── Tool executor with full Phase 9 + 10 context ─────────────────────
  // v4.12 /commands slice — the context is a NAMED object (not an inline
  // literal) so `/home` can patch its `.cwd` live. `buildExecutor` closes over
  // THIS object and reads `context.cwd` on every call, so mutating it here
  // takes immediate effect for file_* + shell_exec + process spawns.
  // v4.12 PM.1 — one background-process registry, shared by the REPL executor
  // and (via the reused toolExecutor closure) the daemon. Fixes the dormancy:
  // ctx.processes is now defined, so process_spawn/list/kill/wait/log_read work
  // in a real session. Reaped on shutdown via cleanup() (wired below).
  const processRegistry = new ProcessRegistry();

  const toolExecutorContext = {
    cwd: process.cwd(),
    paths,
    sessions: sessionManager,
    memory: memoryManager,
    memoryGuard,
    approvalEngine,
    ssrfProtection,
    tirithScanner,
    skillLoader,
    // v4.12 PM.1 — make the process_* tools reachable (were "not configured").
    processes: processRegistry,
    // v4.11 Slice 1 — interactive clarify callback for the `clarify` tool
    // (REPL only; reuses the approval prompt path). Absent from the daemon
    // executor, so headless agents get the tool's "unavailable" degrade.
    clarify: callbacks.promptClarify,
  };
  const toolExecutor = toolRegistry.buildExecutor(toolExecutorContext);

  // v4.12 /commands slice — the `/home` seam. Aiden sources tool cwd two ways:
  // the boot-snapshotted tool-executor `context.cwd` (file/shell tools) and
  // fresh `process.cwd()` (sandbox allow-list, subagent/mcp contexts built
  // on demand). To make `/home` genuinely take effect (not cosmetic), change
  // BOTH, then invalidate the sandbox config so its cwd-derived fs allow-list
  // rebuilds — otherwise writes into the new cwd would stay blocked when the
  // sandbox is enabled.
  const setWorkingDir = (absPath: string): void => {
    process.chdir(absPath);
    toolExecutorContext.cwd = absPath;
    invalidateSandboxConfig();
  };

  // Resolve verified-flag from memory tool results (Phase 9 wrappers
  // surface `{ ok, verified, ... }`).
  const resolveVerifiedFlag = (r: { result?: unknown }) => {
    const v = (r.result as { verified?: boolean })?.verified;
    return typeof v === 'boolean' ? v : undefined;
  };
  const resolveToolset = (name: string) =>
    toolRegistry.get(name)?.toolset;
  // v4.2 Phase 4 — checkpoint/restore mutability resolver. The agent's
  // Phase 4 hook calls this before dispatching each tool to decide
  // whether to flag the live checkpoint as having mutated state. Same
  // registry source as resolveToolset; closure captures the live
  // registry reference so newly-registered tools are seen. Unknown
  // tools return undefined → agent treats them as non-mutating (no
  // checkpoint flag); plugin authors must declare `mutates` honestly.
  const resolveMutates = (name: string) =>
    toolRegistry.get(name)?.mutates;
  // v4.8.0 Phase 2.1 — resolver for the uiOnly flag. The dispatch
  // loop branches on `=== true` so any non-true value (undefined for
  // unknown tools, false for explicit executables) keeps the normal
  // executable path. Closure-captures the live registry, same as
  // resolveMutates / resolveToolset.
  const resolveUiOnly = (name: string) =>
    toolRegistry.get(name)?.uiOnly;

  // ── Phase 16b.4: assemble system-prompt context ─────────────────────
  // PromptBuilder needs SOUL.md (read at build time from `paths.soulMd`),
  // a frozen MemorySnapshot (loaded once at boot — same lifecycle as
  //`_cached_system_prompt`), the active personality overlay, and
  // a compact skills list. All optional except the SOUL.md path itself.
  const promptBuilder = new PromptBuilder();
  const personalityManager = new PersonalityManager({
    paths,
    initialCurrent: config.getValue<string>('personality.current', 'default') ?? 'default',
  });
  let memorySnapshot;
  try {
    memorySnapshot = await memoryManager.loadSnapshot();
  } catch {
    memorySnapshot = undefined;
  }
  let activeOverlay = '';
  try {
    activeOverlay = await personalityManager.getActiveOverlay();
  } catch {
    activeOverlay = '';
  }
  let skillsList: Array<{ name: string; description: string }> = [];
  try {
    // Phase 16g kept the full inventory (one entry per installed skill)
    // so weak models can find a partially-relevant match for fuzzy
    // intents. v4.11 Skill Injection Narrowing cashes in the lazy-load
    // note left here: we still emit one entry per skill (skillsList.length
    // feeds /skills, the status bar, and "Skills bundled: N"), but each
    // description is narrowed to a first-sentence teaser via
    // narrowSkillDesc — the ~1.5k-token block was ~75% description text,
    // none of which the old .slice(0, 120) ever trimmed (avg desc ~62
    // chars). Full descriptions stay available on demand via skills_list
    // / skill_view; those paths are deliberately NOT narrowed.
    const loaded = await skillLoader.list();
    // v4.12 OM.1 — carry category/trustLevel/userModified so PromptBuilder can
    // demote off-posture / low-trust skills to names-only (name kept, teaser
    // dropped). Every name still ships; bodies stay a skill_view away.
    skillsList = loaded.map((s) => {
      const su = s as { name: string; description?: string; category?: string; trustLevel?: string; userModified?: boolean };
      return {
        name: su.name,
        description: narrowSkillDesc(su.description ?? ''),
        category: su.category,
        trustLevel: su.trustLevel,
        userModified: su.userModified,
      };
    });
  } catch {
    skillsList = [];
  }
  // Phase v4.1.2 alive-core: enumerate which toolset tags are loaded
  // so PromptBuilder can inject tool-conditional guidance. Pure
  // string-set; no ToolRegistry reference threaded through the builder.
  const toolsetsLoaded = new Set<string>();
  for (const name of toolRegistry.list()) {
    const ts = toolRegistry.get(name)?.toolset;
    if (ts) toolsetsLoaded.add(ts);
  }

  const promptBuilderOptions = {
    paths,
    memorySnapshot,
    skillsList,
    toolsetsLoaded,
    // Phase v4.1.2-followup self-awareness: feed the runtime slot.
    // toolCount comes from the same registry we just walked to build
    // toolsetsLoaded; providerId joins modelId so both halves of the
    // active route are in the prompt.
    toolCount:  toolRegistry.list().length,
    providerId,
    personalityOverlay: activeOverlay,
    modelId,
  };

  // ── Phase v4.1-skill-mining ──────────────────────────────────────────
  // Construct the miner once — it owns its in-memory session counter +
  // CandidateStore handle. Skipped entirely in MCP serve mode (the
  // serve binary doesn't run the agent loop the same way and shouldn't
  // mutate skill state from inside JSON-RPC handling).
  const skillMiner = isMcpServeMode()
    ? undefined
    : new SkillMiner({ auxiliaryClient, healthTracker: skillMinerHealth });

  // Phase v4.1.2-slice3: the structured CoreLogger isn't yet plumbed
  // through buildAgentRuntime — it's created via factory at boot but
  // not passed in here. We leave its sink-health surface available
  // via `CoreLogger.getSinkHealth()` for any caller that holds the
  // instance, and the registry stays empty for the logger slot until
  // the structured-logger wiring catches up. The registry mechanism
  // itself is exercised end-to-end by skill-teacher and skill-miner.

  // v4.10 Slice 10.2d — per-tool-call startTime map for accurate
  // duration_ms on the tool_call_completed run_event. Keyed by the
  // model's tool_call_id so concurrent / interleaved calls don't
  // clobber each other. Mirrors childBuilder.ts:455 (subagent path)
  // and realAgentRunner.ts:emitToolEvent (daemon path). Lifetime
  // matches the parent agent — one map across the whole REPL
  // process. Entries are removed at the 'after' phase; orphans (rare,
  // mid-call crash) are GC'd by the next-call cleanup.
  const replToolCallStartTimes = new Map<string, number>();

  // ── v4.11 preflight compression: construct ModelMetadata +
  // ContextCompressor ONCE so the agent's auto-trigger path AND the
  // /compress slash command share state. The compressor's
  // shouldCompress() reads model limits per (provider, model); auto
  // compression fires at the 50% utilization threshold inside
  // agent.runConversation. The dedicated SubsystemHealthTracker lets
  // `aiden doctor` surface auxiliary-call failures so a degraded
  // summarizer is visible operationally (same pattern as
  // skillMinerHealth / skillTeacherHealth above).
  const compressionHealth = new SubsystemHealthTracker('context-compressor');
  subsystemHealthRegistry.register('context-compressor',
    () => compressionHealth.snapshot());
  const modelMetadata     = new ModelMetadata();
  const contextCompressor = new ContextCompressor(
    modelMetadata,
    auxiliaryClient,
    /*compressionThreshold=*/ 0.5,
    compressionHealth,
  );

  // ── Build agent with all moat layers attached ────────────────────────
  const agent = new AidenAgent({
    provider: adapter,
    // v4.11 preflight compression — wire the compressor so
    // runConversation step 7 actually runs at the 50% threshold.
    contextCompressor,
    // v4.6 Phase 1 — 'repl' context filter excludes tools tagged
    // daemon-only (none today) and INCLUDES tools tagged repl-only
    // (e.g. spawn_sub_agent, registered after this line). Tools with
    // no `contexts` field default to visible in both contexts.
    //
    // v4.11 toolset grouping — `toolProfile.toolsets` narrows the
    // catalog by toolset tag. `undefined` (the `full` profile)
    // preserves byte-identical pre-v4.11 behaviour; any other
    // profile ships only handlers whose `toolset` matches one of
    // the resolved tags. Filter is applied ONCE at construction —
    // the agent's `this.tools` is frozen for the session so prefix
    // caching stays warm. Switching profiles via `/tools <name>`
    // requires a session restart (the slash command surfaces a
    // clear note explaining why).
    // v4.11 — strip the `ui` toolset for known-weak models that leak
    // ui_* markup instead of firing real tool_calls (the cause-level fix
    // for the UI-leak class; the sanitizer stays as defense-in-depth).
    // isWeakModel (core/v4/modelCapability.ts) is the single predicate
    // shared with the prompt-guidance gate, so guidance + tools agree.
    // v4.12 OM.2 — cost-based MCP tool deferral. Always exclude the `bridge`
    // toolset from the base assembly; applyToolDeferral injects tool_search +
    // tool_call ONLY when mcp schema cost crosses the threshold (else the schema
    // list passes through unchanged — no bridge, byte-identical to today).
    tools: applyToolDeferral(
      toolRegistry.getSchemas(
        toolProfile.toolsets as string[] | undefined,
        'repl',
        isWeakModel(modelId) ? ['ui', 'bridge'] : ['bridge'],
      ),
      toolRegistry,
      { providerId, modelId, meta: modelMetadata },
    ),
    toolExecutor,
    maxTurns: config.getValue<number>('agent.max_turns', 90)!,
    // v4.12 BE.1 — per-session token cap (money-safety). 0/unset → no cap.
    sessionTokenCap: config.getValue<number>('budget.session_token_cap', 0)! || undefined,
    auxiliaryClient,
    plannerGuard,
    honestyEnforcement,
    skillTeacher,
    skillMiner,
    subsystemHealthRegistry,
    skillOutcomeTracker,
    onSkillCandidate: (candidate: MinedCandidate) => {
      try {
        callbacks.onSkillCandidate?.(candidate);
      } catch { /* notification must not break the turn */ }
    },
    // Phase 23.5: tool event rows. CliCallbacks.onToolCall
    // emits a single line per call — `· tool <name> <args> [running]`
    // mutates to `[ok 220ms]` / `[fail 1.4s]` / `[blocked]` on resolve.
    //
    // Phase v4.1.2-slice4: compose (do NOT replace) so the
    // SkillOutcomeTracker observes the same lifecycle the CLI display
    // is rendering. Tracker hooks run first so attribution lands even
    // if the display callback throws.
    onToolCall: (call, phase, result) => {
      try {
        skillOutcomeTracker.onTool(call, phase, result);
      } catch { /* telemetry must not break the turn */ }
      // v4.5 Phase 8b — pre-tool-call contextual suggestion. Fires
      // when the call would benefit from a v4.4/v4.5 subsystem the
      // user currently has off. Engine handles dismissal + budget;
      // we just render the tip and tell the engine it was shown.
      if (phase === 'before') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getSuggestionEngine } = require('../../core/v4/suggestionEngine');
          const tip = getSuggestionEngine().checkToolCall(call);
          if (tip) {
            display.dim(tip.message);
            getSuggestionEngine().recordFired(tip.slot);
          }
        } catch { /* never let a suggestion crash a tool call */ }
      }
      // v4.10 Slice 10.2d — runtime tool_call_* emission for REPL
      // turns. Symmetric to realAgentRunner.emitToolEvent (daemon
      // path) and childBuilder.ts (subagent path). Closes the
      // /trace recent visibility gap where REPL tool activity was
      // invisible to the trace ledger. Best-effort: a write failure
      // (locked DB, schema drift) must NEVER crash dispatch.
      const rid = replParentRunRef.runId;
      if (rid !== null) {
        try {
          if (phase === 'before') {
            const startedAt = Date.now();
            replToolCallStartTimes.set(call.id, startedAt);
            const tags = categorizeEvent('tool_call_started');
            replRunStore.emitEventRich({
              runId:      rid,
              category:   tags.category,
              kind:       tags.kind,
              name:       'tool_call_started',
              sessionId:  replParentRunRef.sessionId ?? null,
              toolCallId: call.id ?? null,
              status:     'started',
              summary:    call.name,
              payload: {
                toolName: call.name,
                ts:       startedAt,
              },
              visibility: 'system',
              source:     'repl',
            });
          } else {
            const startedAt = replToolCallStartTimes.get(call.id) ?? Date.now();
            replToolCallStartTimes.delete(call.id);
            const durationMs = Date.now() - startedAt;
            const tags = categorizeEvent('tool_call_completed');
            replRunStore.emitEventRich({
              runId:      rid,
              category:   tags.category,
              kind:       tags.kind,
              name:       'tool_call_completed',
              sessionId:  replParentRunRef.sessionId ?? null,
              toolCallId: call.id ?? null,
              status:     result?.error ? 'failed' : 'ok',
              durationMs,
              summary:    `${call.name}${result?.error ? ' (failed)' : ''}`,
              payload: {
                toolName:  call.name,
                error:     result?.error ?? null,
                hasResult: result?.result !== undefined && result?.result !== null,
                durationMs,
              },
              visibility: 'system',
              source:     'repl',
            });
          }
        } catch { /* observability must never break a tool call */ }
      }
      callbacks.onToolCall?.(call, phase, result);
    },
    onCompression: callbacks.onCompression,
    onBudgetWarning: callbacks.onBudgetWarning,
    onPlannerGuardDecision: callbacks.onPlannerGuardDecision,
    skillTeacherCallbacks: { promptUser: callbacks.promptSkillProposal },
    resolveVerifiedFlag,
    resolveToolset,
    resolveMutates,
    resolveUiOnly,
    providerId,
    modelId,
    // Phase 16b.4: wire PromptBuilder so SOUL.md actually reaches the LLM.
    promptBuilder,
    promptBuilderOptions,
    // Phase 16d: refresh callback feeds the next-turn rebuild path.
    refreshMemorySnapshot: () => memoryManager.loadSnapshot(),
    onMemoryRefresh: (which) => {
      try {
        callbacks.onMemoryRefresh?.(which);
      } catch {
        // diagnostics must not break the loop
      }
    },
    // v4.1.5 Issue K — phase lifecycle hooks for the activity indicator
    // verb mutation. Each fires at a specific point in runConversation:
    //   - onMemoryRefreshStart: before memory I/O begins
    //   - onPromptBuilt: after system prompt assembly
    //   - onProviderRequestStart: just before the HTTP request opens
    // chatSession registers handlers that call `indicator.setVerb()` so
    // the user sees the model's actual workflow phase during the gap.
    // All three are forwarded through `callbacks` so chatSession owns
    // the indicator handle (created per-turn). Defensive try/catch on
    // each — a misbehaving display sink never blocks the agent loop.
    onMemoryRefreshStart: () => {
      try { callbacks.onMemoryRefreshStart?.(); } catch { /* defensive */ }
    },
    onPromptBuilt: (info) => {
      try { callbacks.onPromptBuilt?.(info); } catch { /* defensive */ }
    },
    onProviderRequestStart: (id) => {
      try { callbacks.onProviderRequestStart?.(id); } catch { /* defensive */ }
    },
    // Phase 23.4b — feed the agent's Stage-0 intent pre-arm with the
    // skill's `required_tools` from its SKILL.md frontmatter.  Returns
    // null when the skill is unknown / unloaded / empty so the agent
    // treats it as a no-op-arm (counter bumps, tracker stays disarmed).
    lookupSkillRequiredTools: async (skillName: string) => {
      try {
        const skill = await skillLoader.load(skillName);
        if (!skill) return null;
        const raw = skill.frontmatter.required_tools;
        if (!Array.isArray(raw)) return null;
        const filtered = raw
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .map((t) => t.trim());
        return filtered.length > 0 ? filtered : null;
      } catch {
        return null;
      }
    },
  });

  // Phase 16d: wire the dirty-bit signal — every successful memory mutation
  // flips the agent's flag so the NEXT turn's system prompt reflects the
  // change. Strategy (b).
  memoryManager.onMutation((file) => {
    agent.markMemoryDirty(file === 'user' ? 'user' : 'memory');
  });

  // v4.11 Obsidian vault mirror — additive side-channel. Resolves the
  // vault path from env > config; null = feature off (no-op listener
  // never registered). Boot-time full export catches up any drift
  // from offline edits; subsequent mutations fan out per-namespace.
  //
  // The exporter NEVER touches the memory write path — it reads the
  // freshly-written files and mirrors them into the vault. Listener
  // errors are swallowed by memoryManager's fireMutation guard, so a
  // vault disk-full / permission glitch can't break a memory write.
  {
    const { resolveVaultPath, exportAll, exportNamespace, exportSoul, exportSessions } =
      await import('../../core/v4/memory/vaultExporter');
    const vaultPath = resolveVaultPath(
      process.env.AIDEN_VAULT_PATH,
      config.getValue<string>('agent.vault_path'),
      // v4.12.1 poisoned-value guard — loud on the boot surface (user sees
      // it) AND in the log file, then the exporter stays off for the
      // session instead of writing into a garbage directory.
      (msg) => {
        display.warn(msg);
        bootLogger.child('vault').warn(msg);
      },
    );
    if (vaultPath !== null) {
      const vaultDeps = {
        paths,
        vaultPath,
        projectRoot: memoryManager.projectRoot,
        log: (level: 'info' | 'warn', msg: string) => {
          // File-only — vault export progress is not a chat surface.
          if (level === 'warn') bootLogger.child('vault').warn(msg);
          else bootLogger.child('vault').info(msg);
        },
      };
      // Boot-time full export — catches up after offline edits.
      // Fire-and-forget; never block the boot path.
      exportAll(vaultDeps).catch((e) => {
        bootLogger.child('vault').warn(`boot export failed: ${(e as Error).message}`);
      });
      // Per-mutation incremental export. The listener never throws.
      memoryManager.onMutation((file) => {
        const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
        const namespace = file === 'user' ? 'user' : file === 'project' ? 'project' : 'memory';
        const sourcePath = namespace === 'user'
          ? paths.userMd
          : namespace === 'project'
          ? (memoryManager.projectRoot
              ? `${memoryManager.projectRoot}/.aiden/PROJECT.md`
              : null)
          : paths.memoryMd;
        if (!sourcePath) return;
        exportNamespace(vaultDeps, namespace, sourcePath, summary).catch(() => {
          /* swallow — vault failures must never break memory mutation */
        });
      });
      // SOUL.md + distillation fan-out is deferred to boot-time + the
      // explicit `/memory vault sync` command — those sources don't
      // emit per-mutation events. exportSoul/exportSessions covered
      // by the initial exportAll above; intentional reference suppresses
      // the unused-import warning on the dynamic import.
      void exportSoul; void exportSessions;
    }
  }

  // v4.5 Phase 7b — daemon agent builder. Captures the references
  // above so the dispatcher can construct a fresh AidenAgent per
  // daemon-claimed trigger. Strategy B (closure capture) — REPL
  // construction stays untouched; we just expose the builder on
  // the returned AgentRuntime so runInteractiveChat can pass it to
  // bootstrapDaemon().
  const { buildDaemonAgentBuilder } = await import('./daemonAgentBuilder');
  const daemonAgentBuilder = buildDaemonAgentBuilder({
    paths,
    resolver,
    fallbackAdapter: adapter,
    toolRegistry,
    toolExecutor,
    auxiliaryClient,
    promptBuilder,
    promptBuilderOptions,
    memoryManager,
    resolveVerifiedFlag,
    resolveToolset,
    resolveMutates,
    resolveUiOnly,
    // v4.7.0 Phase 2.4 — share the REPL's config-resolved honesty mode
    // with daemon-built agents so autonomous turns honour the same
    // setting interactive turns do.
    honestyMode,
    maxTurns: config.getValue<number>('agent.max_turns', 90)!,
  });

  // Phase v4.1.2 alive-core: SOUL.md file watcher. Best-effort —
  // some filesystems (network mounts, certain WSL configs) don't
  // support fs.watch reliably. We try to attach; if it fails, the
  // /reload-soul slash command stays as the manual fallback.
  try {
    const soulWatcher = fsWatch(paths.soulMd, { persistent: false }, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        agent.markMemoryDirty('soul');
      }
    });
    soulWatcher.on('error', () => {
      // Some FS backends emit errors mid-stream; degrade to manual
      // fallback. The slash command still works.
    });
    // Phase 23.4b: leak-free shutdown — closed by the existing
    // process-exit cleanup path. We don't unref since we *want* the
    // watcher to keep the process alive only as long as the REPL does.
    process.on('exit', () => { try { soulWatcher.close(); } catch { /* noop */ } });
  } catch (err) {
    display.warn(
      `SOUL.md watcher could not attach (${(err as Error).message}). ` +
      'Use `/reload-soul` to apply edits mid-session.',
    );
  }

  // ── Phase v4.1-subagent.1 — subagent_fanout wiring is below
  // (after `bootLogger` is declared and the gateway processor is set
  // up). Stub registered at boot is replaced there with the real
  // closures over adapter / sessionManager / promptBuilder / etc.

  // Phase v4.1-1.3a — boot a unified mode-aware Logger ('cli-interactive'
  // mode = no stdout sinks, REPL is sacred). Declared here so the gateway
  // processor + channel manager (later in the function) can both attach
  // scoped child loggers to the same root.
  const { logger: bootLogger } = createBootLogger({
    mode:    'cli-interactive',
    logsDir: paths.logsDir,
  });
  // v4.10 Slice 10.7 — survive-by-default process-level guards. The
  // REPL has a human watching; an unhandled adapter rejection or
  // uncaught error from any subsystem (channel poller, MCP transport,
  // background task, etc.) should NOT silently kill the chat. The
  // handlers log a single dim line + keep the REPL alive. Daemon
  // path uses different (fail-fast, reclaim-then-exit) handlers in
  // `core/v4/daemon/bootstrap.ts:530-531`; that asymmetry is
  // intentional — daemon has no user to recover.
  const { installReplCrashHandlers } = await import('../../core/v4/replCrashHandlers');
  installReplCrashHandlers({
    log: (level, msg, meta) => bootLogger.child('crash')[level](msg, meta),
    notify: (line) => {
      try { process.stderr.write(`\n${line}\n`); } catch { /* stderr torn down */ }
    },
  });
  // Wire the gateway singleton's logger BEFORE registering its processor
  // so register / unregister channel events are scoped correctly.
  gateway.attachLogger(bootLogger.child('gateway'));

  // v4.6 Phase 3A — startup probe for the spawn-pause kill-switch.
  // The state was initialised early (line ~740) before tool wiring.
  // Emit a visible warning so an operator who forgot they paused in
  // a prior session learns immediately rather than puzzling at
  // silent rejected fanouts.
  //
  // v4.10 Slice 10.7a — migrated from bootLogger.warn to
  // display.warn so the user-visible message survives the StderrSink
  // removal from cli-interactive mode. display.warn is TTY-aware
  // and coordinates with the prompt lifecycle (the file log still
  // captures the structured event via bootLogger.info below).
  if (spawnPauseBootStatus) {
    const s = spawnPauseBootStatus;
    const reasonSuffix = s.reason ? ` (reason: ${s.reason})` : '';
    display.warn(
      `spawn_sub_agent / subagent_fanout are PAUSED${reasonSuffix}. ` +
      'Run /spawn-pause off to resume.',
    );
    // Also record to file log for postmortems (structured context).
    bootLogger.info(
      `spawn-pause active at boot${reasonSuffix}`,
      {
        pausedAt:   s.pausedAt   ?? null,
        pausedBy:   s.pausedBy   ?? null,
        durationMs: s.durationMs ?? null,
      },
    );
  }

  // ── Phase v4.1-subagent.1 — replace subagent_fanout stub with wired version
  //
  // tools/v4/index.ts registers a stub at boot so the schema is visible
  // to MCP / /tools immediately. NOW that the runtime has a provider
  // adapter, an active model, sessions, memory, and a built agent, we
  // re-register subagent_fanout with the real callbacks so live calls
  // (from REPL, MCP, or `aiden fanout`) actually execute children
  // instead of returning the "not wired" stub error.
  //
  // The closures capture parent runtime handles. Each fanout call
  // builds a fresh AidenAgent per child — the AidenAgent constructor
  // is cheap (per-instance state, no module singletons), so N=5
  // children = 5 instances + 5 cloned FallbackAdapters. The heavy
  // shared subsystems (registry, skillLoader, paths, memoryManager,
  // promptBuilder, promptBuilderOptions) are read-only and pass by
  // reference.
  // v4.6 Phase 2Q-A — `runFanout` routes each child through
  // `spawnSubAgent`. `spawnDeps` mirrors the deps the
  // `makeSpawnSubAgentTool` factory accepts (see registration below
  // this block). The legacy per-call `runChild` closure that lived
  // here pre-2R has been deleted; the primitive owns child
  // construction now.
  // v4.11 Slice 4 — construct the SubagentCoordinator ONCE. Both tool
  // facades (spawn_sub_agent + subagent_fanout) share the same
  // coordinator instance so the active-children registry is
  // process-wide, cost accumulators roll up into one parent's turn
  // context, and a future operator surface can query/cancel without
  // a per-tool plumbing pass.
  //
  // The coordinator wraps — does NOT replace — the existing
  // `spawnSubAgent` primitive. The primitive still owns child agent
  // construction (toolset intersection, ApprovalEngine auto-deny,
  // provider clone, internal timeout cascade). The coordinator owns
  // the BATCH abstraction layered above (id minting, linked controllers,
  // bounded concurrency, ordered aggregation, lifecycle trace).
  //
  // spawnDeps is the SAME shape v4.6 wired: tool registry, parent
  // tool context (memory / ssrf / tirith / skills), provider adapter,
  // resolvers, run store. No widening — the coordinator's API
  // accepts the existing SpawnSubAgentDeps verbatim.
  const subagentCoordinator = new SubagentCoordinator({
    spawnDeps: {
      toolRegistry,
      parentToolContext: {
        cwd:            process.cwd(),
        paths,
        sessions:       sessionManager,
        memory:         memoryManager,
        memoryGuard,
        // approvalEngine intentionally OMITTED — the child builder
        // constructs its own auto-deny ApprovalEngine. Listing it
        // here would be ignored (childBuilder overrides via spread).
        ssrfProtection,
        tirithScanner,
        skillLoader,
      },
      parentProvider:      adapter,
      parentProviderId:    providerId,
      parentModelId:       modelId,
      resolveVerifiedFlag,
      resolveToolset,
      resolveMutates,
      resolveUiOnly,
      runStore:            replRunStore,
      instanceId:          replInstanceId,
      logger:              bootLogger.child('subagent'),
      // v4.11 toolset grouping — children inherit the parent's
      // resolved profile narrowing (then apply the 5-name blocklist
      // + any `requestedToolsets` intersection on top). For the
      // `full` profile, `toolProfile.toolsets` is undefined → the
      // childBuilder falls back to "every toolset the registry
      // knows" (the pre-v4.11 behaviour). The `as readonly string[]`
      // cast is safe — childBuilder treats this list as read-only.
      parentProfileToolsets: toolProfile.toolsets as readonly string[] | undefined,
      // v4.11 — parent-based ui strip: when the REPL parent runs a
      // known-weak model, its children (which share the REPL display)
      // also drop the `ui` toolset. Mirrors the parent catalog strip
      // above so a weak session can't leak ui_* markup from a subagent.
      parentExcludeToolsets: isWeakModel(modelId) ? ['ui'] : undefined,
    },
    logger: bootLogger.child('subagent'),
    // v4.11 regression patch — display sink for per-child UI events.
    // Coordinator is the single source of truth post-Slice-4; the
    // pre-Slice-4 spawn_sub_agent facade no longer emits its own
    // pair. This restores the gutter-indented `[task] <goal> ·
    // running…` / `· done` trail rows for BOTH spawn_sub_agent
    // (1 pair) AND subagent_fanout (N pairs), which Slice 4 had
    // silently dropped from fanout.
    onUiEvent: (name: string, args: Record<string, unknown>) => {
      display.renderUiEvent(name, args);
      const rid = replParentRunRef.runId;
      if (rid !== null) {
        try {
          const tags = categorizeEvent(name);
          replRunStore.emitEventRich({
            runId:     rid,
            category:  tags.category,
            kind:      tags.kind,
            name,
            sessionId: replParentRunRef.sessionId ?? null,
            payload:   args,
            visibility:'model',
            source:    'subagent',
          });
        } catch { /* persistence faults must never break dispatch */ }
      }
    },
  });

  // ── v4.11 Slice 4 — register subagent_fanout (facade) ──────────────────
  toolRegistry.register(makeSubagentFanoutTool({
    resolveTurnContext: () => agent.getCurrentTurnContext(),
    coordinator:        subagentCoordinator,
    logger:             bootLogger.child('subagent'),
    resolveActiveModel: () => ({ providerId, modelId }),
    aggregatorAdapter:  adapter,
    resolveProviders: (): ProviderOption[] => {
      // When the parent uses FallbackAdapter, expose every key-present
      // slot's (providerId, modelId) so rotation can spread children
      // across distinct providers / keys. Otherwise just the active
      // provider+model pair — single-provider rotation falls back to
      // slot rotation within the FallbackAdapter at run time, OR to
      // pure same-provider sampling (singleProviderWarning fires).
      if (adapter instanceof FallbackAdapter) {
        const diag = adapter.getDiagnostics();
        const live = diag.slots.filter((s) => s.keyPresent);
        if (live.length > 0) {
          return live.map((s) => ({
            providerId: s.providerId,
            modelId:    s.modelId,
            label:      s.id,
          }));
        }
      }
      return [{ providerId, modelId }];
    },
  }));
  bootLogger.child('subagent').info('subagent_fanout: wired (replaces stub)', {
    providerId,
    modelId,
    fallback: adapter instanceof FallbackAdapter ? 'FallbackAdapter' : 'direct',
  });

  // ── v4.11 Slice 4 — register spawn_sub_agent (facade, REPL only) ───────
  // Deliberately NOT registered in cli/v4/daemonAgentBuilder.ts —
  // daemon-fired agents don't expose spawn_sub_agent in their tool
  // catalog (Q6 lock from v4.6 Phase 1).
  toolRegistry.register(makeSpawnSubAgentTool({
    resolveTurnContext: () => agent.getCurrentTurnContext(),
    coordinator:        subagentCoordinator,
    logger:             bootLogger.child('subagent'),
    // v4.11 regression patch — `onUiEvent` removed from the spawn
    // facade. The coordinator (constructed above) owns the single
    // ui_task_update / ui_task_done pair per child for BOTH
    // spawn_sub_agent (1 task) AND subagent_fanout (N tasks), so
    // the display sink is wired ONCE at coordinator construction
    // instead of duplicated across two facades.
  }));
  bootLogger.child('subagent').info('spawn_sub_agent: wired (REPL only)', {
    instanceId: replInstanceId,
    dbPath:     daemonDbPath(paths.root),
  });

  // ── v4.10 Slice 10.2 — trace_query (REPL only) ─────────────────────
  //
  // Registers the model-facing read-only trace_query tool. Wired AFTER
  // replRunStore + replParentRunRef are in scope so the factory captures
  // live references. Not registered in daemon agent builders — daemon
  // turns persist their own trace via realAgentRunner's onUiEvent hook
  // but don't expose introspection (Phase B Q2: scope locked to REPL).
  toolRegistry.register(makeTraceQueryTool({
    runStore:         replRunStore,
    // v4.10 Slice 10.2c — resolve to the long-lived chatSessionId
    // (set once at ChatSession.run() init) so scope='current_session'
    // works between turns. The pre-10.2c version read the turn-scoped
    // sessionId which got nulled post-turn, making the model see "no
    // session" while the conversation was clearly alive.
    resolveSessionId: () => replParentRunRef.chatSessionId,
    // v4.10 Slice 10.2b — scope='current_run' resolves to the in-flight
    // turn's runId; null when no turn is active.
    resolveRunId:     () => replParentRunRef.runId,
  }));

  // ── Phase v4.1-2.1: gateway message processor ────────────────────
  //
  // Channel adapters call `gateway.routeMessage(...)` for every inbound
  // message; the gateway then invokes the registered processor — that's
  // the bridge from channel-side I/O to the agent loop. `aiden serve`
  // wires its own processor in `api/server.ts` (HTTP-hops to /api/chat
  // because Express is already up). The CLI host (Phase v4.1-1.1)
  // never had one, so every Telegram inbound was throwing
  // "No message processor registered" and the user saw the
  // friendly-fallback "Something went wrong" reply.
  //
  // The closure mirrors the api/server processor's intent — one agent
  // turn per inbound — but invokes `agent.runConversation()` directly
  // instead of round-tripping through HTTP. Per-(channel, channelId)
  // history persists through the same SessionStore the REPL uses, so
  // a Telegram conversation accumulates context across messages, and
  // a future `/sessions` listing surfaces those threads alongside REPL
  // sessions.
  const gatewayProcessorLog = bootLogger.child('gateway.processor');
  // gateway sessionId (`session_<ts>`) → sessionStore session id.
  // In-memory only; restart re-creates a fresh sessionStore session
  // for the same channel+user pair.
  const gatewaySessionMap = new Map<string, string>();
  gateway.setProcessor(async (message) => {
    try {
      // 1. Resolve a sessionStore session for this gateway session.
      //    sessionManager.startSession opens a new row; we cache the
      //    mapping so subsequent messages from the same chat append
      //    to the same history.
      const gatewaySid = message.sessionId
        ?? `${message.channel}_${message.channelId}`;
      let storeSid = gatewaySessionMap.get(gatewaySid);
      if (!storeSid) {
        const created = sessionManager.startSession({
          providerId,
          modelId,
          title: `${message.channel}:${message.channelId}`,
        });
        storeSid = created.id;
        gatewaySessionMap.set(gatewaySid, storeSid);
      }

      // 2. Load past messages for this session and append the new
      //    user turn so the agent sees full context. We drop tool /
      //    system rows on load — the agent's prompt builder rebuilds
      //    those from scratch each call.
      // Provider Message union has tool-specific variants; we only
      // load the user/assistant turns and cast to satisfy the union.
      // Tool-call replay across adapter restarts isn't a feature we
      // need for chat-channel UX (Phase v4.1-2.1 scope).
      const past = store.getMessages(storeSid)
        .filter((r) => r.role === 'user' || r.role === 'assistant')
        .map((r) => ({ role: r.role, content: r.content })) as import('../../providers/v4/types').Message[];
      const userTurn = { role: 'user' as const, content: message.text };
      const history: import('../../providers/v4/types').Message[] = [...past, userTurn];

      // 3. Run one agent turn.
      const result = await agent.runConversation(history);

      // 4. Persist the new tail (everything past the loaded history) so
      //    the next inbound resumes seamlessly. Mirror chatSession's
      //    record-turn slice convention.
      const newSlice = result.messages.slice(history.length - 1);
      sessionManager.recordTurn(storeSid, newSlice, result.totalUsage);

      return result.finalContent || '(no response)';
    } catch (err: any) {
      // Diagnostics route through the unified logger — nothing reaches
      // stdout / stderr so the REPL stays clean. The gateway's own
      // catch returns the friendly fallback to the user.
      gatewayProcessorLog.error(
        `processor failed: ${err?.message ?? String(err)}`,
        { channel: message.channel, channelId: message.channelId },
      );
      throw err;
    }
  });

  // Command registry.
  const commandRegistry = new CommandRegistry();
  for (const cmd of allCommands) commandRegistry.register(cmd);

  // ── v4.10 Slice 10.2 — /trace recent slash command ────────────────
  //
  // User-facing introspection of the current REPL session's
  // run_events stream. Mirrors `trace_query` (model-facing) but
  // formats for human reading. Registered inline so it can capture
  // replRunStore + replParentRunRef in closure without threading
  // them through the static allCommands list (same pattern skill
  // commands use below for SkillLoader access).
  commandRegistry.register({
    name: 'trace',
    description: 'Inspect recent events from this REPL session. Usage: /trace recent [N]',
    category: 'system',
    icon: '⊙',
    handler: async (ctx) => {
      const sub = (ctx.args[0] ?? 'recent').toLowerCase();
      if (sub !== 'recent') {
        ctx.display.printError(
          `Unknown subcommand: ${sub}`,
          'Try: /trace recent [N]   (N defaults to 20, max 200)',
        );
        return {};
      }
      // v4.10 Slice 10.2c — read the long-lived chatSessionId (set
      // once at ChatSession.run() init) rather than the turn-scoped
      // sessionId (cleared between turns). The pre-10.2c gate fired
      // "no active REPL session" between turns even though the chat
      // session was alive, conflating "no in-flight turn" with "no
      // session". Defensive guard remains for the post-/quit edge
      // when the renderer outlives the chat lifecycle.
      const sessionId = replParentRunRef.chatSessionId;
      if (!sessionId) {
        ctx.display.dim('No REPL session active — start the chat first.');
        return {};
      }
      const limitArg = Number(ctx.args[1]);
      const limit = Number.isFinite(limitArg) && limitArg > 0
        ? Math.min(Math.floor(limitArg), 200)
        : 20;
      // v4.10 Slice 10.2b — query the rich shape so the renderer can
      // surface category/kind/name/status/duration without re-parsing
      // payload JSON for every row.
      let rows;
      try {
        rows = replRunStore.listEventsScoped({
          scope:     'current_session',
          sessionId,
          limit,
        });
      } catch (e) {
        ctx.display.printError(`trace query failed: ${(e as Error).message}`);
        return {};
      }
      if (rows.length === 0) {
        // Slice 10.2c — clearer message: the session IS active, just
        // no events recorded yet. Common after a greeting turn where
        // the model didn't fire any ui_* / tool_call_* events.
        ctx.display.dim('(no events recorded yet in this conversation — events appear after the first tool call or ui_* emission)');
        return {};
      }
      ctx.display.info(`Recent events (${rows.length}, newest first):`);
      for (const r of rows) {
        const tsIso = new Date(r.ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
        // Prefer the human summary when emitter set one; otherwise
        // fall back to a payload preview. Status + duration appear
        // inline so dispatcher rows surface their finish reason
        // without a payload parse.
        const summaryOrPreview = r.summary
          ?? (r.payload.length > 80 ? `${r.payload.slice(0, 77)}…` : r.payload);
        const statusBit   = r.status     ? ` [${r.status}]`       : '';
        const durationBit = r.durationMs ? ` (${r.durationMs}ms)` : '';
        ctx.display.write(
          `  ${tsIso}  run=${r.runId}  ${r.category}/${r.kind}${statusBit}${durationBit}  ${summaryOrPreview}\n`,
        );
      }
      return {};
    },
  });

  // ── v4.10 Slice 10.8 — /tasks slash command ────────────────────────
  //
  // Read-only listing surface for the durable Task-lite kernel.
  // Mirrors /trace recent's shape: query daemon.db via the long-
  // lived replParentRunRef.chatSessionId (Slice 10.2c) so the
  // command works between turns too. Auto-created per user-message
  // turn by chatSession.runAgentTurn (Slice 10.8 B3).
  //
  // Subcommands:
  //   /tasks               → all this session, newest first, default 20
  //   /tasks active        → filter by status='active'
  //   /tasks completed     → filter status='completed'
  //   /tasks cancelled     → filter status='cancelled'
  //   /tasks failed        → filter status='failed'
  //   /tasks interrupted   → filter status='interrupted' (boot-swept orphans)
  //   /tasks all           → cross-session: every session, not just this one
  //   /tasks all <status>  → cross-session + status filter (e.g. all interrupted)
  //   /tasks <N>           → numeric arg sets the limit (1..200)
  commandRegistry.register({
    name: 'tasks',
    description: 'List durable tasks for this REPL session. Usage: /tasks [all] [<status>|<N>] | /tasks <task_id> (detail + verification evidence)',
    category: 'system',
    icon: '⊡',
    handler: async (ctx) => {
      const sessionId = replParentRunRef.chatSessionId;
      if (!sessionId) {
        ctx.display.dim('No REPL session active — start the chat first.');
        return {};
      }
      // v4.11 Slice 0 — `/tasks all` is the explicit cross-session opt-in:
      // lists across every session (including boot-swept `interrupted`
      // orphans left by dead sessions, which the default session-scoped
      // view can't show). Default stays session-scoped — unchanged. A
      // status/limit arg may follow `all`, e.g. `/tasks all interrupted`.
      // v4.13 Gap 1 + Gap 3 — `/tasks <task_id>` detail view: the full
      // job-card (constraints, permissions, files touched, side effects,
      // failure state) + the verification evidence envelope. Rendering
      // lives in commands/tasksDetail.ts so it's unit-testable.
      if ((ctx.args[0] ?? '').startsWith('task_')) {
        const t = replTaskStore.get(ctx.args[0]);
        if (!t) {
          ctx.display.dim(`(no task with id ${ctx.args[0]})`);
          return {};
        }
        const { renderTaskDetail } = await import('./commands/tasksDetail');
        renderTaskDetail(t, (s) => ctx.display.write(s));
        return {};
      }
      const crossSession = (ctx.args[0] ?? '').toLowerCase() === 'all';
      const arg = (ctx.args[crossSession ? 1 : 0] ?? '').toLowerCase();
      const validStatuses = new Set([
        'pending', 'active', 'completed', 'failed', 'cancelled', 'interrupted',
        // v4.13 Gap 1 — verify-before-done states.
        'pending_verification', 'completed_unverified', 'verification_failed',
        // v4.13 Gap 4 — resume verdict terminals.
        'blocked_needs_user', 'abandoned',
      ]);
      let filterStatus: string | undefined;
      let limit = 20;
      if (arg && validStatuses.has(arg)) {
        filterStatus = arg;
      } else if (arg) {
        const n = Number(arg);
        if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 200);
      }
      let rows;
      try {
        rows = replTaskStore.listRecent({
          // Omitting sessionId widens the query to all sessions.
          ...(crossSession ? {} : { sessionId }),
          ...(filterStatus ? { status: filterStatus as any } : {}),
          limit,
        });
      } catch (e) {
        ctx.display.printError(`/tasks query failed: ${(e as Error).message}`);
        return {};
      }
      const scopeNoun = crossSession ? 'across all sessions' : 'in this conversation';
      if (rows.length === 0) {
        ctx.display.dim(filterStatus
          ? `(no ${filterStatus} tasks ${scopeNoun})`
          : `(no tasks recorded yet ${scopeNoun})`);
        return {};
      }
      const filterSuffix = filterStatus ? ` (${filterStatus})` : '';
      const scopeSuffix = crossSession ? ' [all sessions]' : '';
      ctx.display.info(`Tasks${filterSuffix}${scopeSuffix} — ${rows.length} row${rows.length === 1 ? '' : 's'}, newest first:`);
      for (const r of rows) {
        const tsIso = new Date(r.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
        // Title is already capped at 80 chars on insert (Slice 10.8
        // B2 createTaskStore); render compact for the listing.
        const trim = r.title.length > 60 ? `${r.title.slice(0, 57)}…` : r.title;
        // Cross-session mode tags the owning session so rows from
        // different conversations are distinguishable; default mode
        // omits it (output byte-identical to pre-Slice-0).
        const sess = crossSession ? `  ${r.sessionId.slice(0, 8).padEnd(8)}` : '';
        ctx.display.write(
          `  ${tsIso}${sess}  ${r.id}  [${r.status.padEnd(9)}]  ${trim}\n`,
        );
      }
      return {};
    },
  });

  // ── v4.11 — /artifacts slash command ───────────────────────────────
  //
  // Read-only listing of the artifact registry (files Aiden produced,
  // with provenance). Mirrors /tasks: default session-scoped, `all`
  // drops the filter. Each row shows time, action+kind, path, the tool,
  // and the originating task goal (resolved via replTaskStore).
  //
  //   /artifacts            → this session, newest first, default 20
  //   /artifacts all        → cross-session: every session
  //   /artifacts <N>        → numeric arg sets the limit (1..200)
  //   /artifacts all <N>    → cross-session + limit
  commandRegistry.register({
    name: 'artifacts',
    description: 'List artifacts Aiden produced (files written) with provenance. Usage: /artifacts [all] [<N>]',
    category: 'system',
    icon: '⊟',
    handler: async (ctx) => {
      const sessionId = replParentRunRef.chatSessionId;
      if (!sessionId) {
        ctx.display.dim('No REPL session active — start the chat first.');
        return {};
      }
      const crossSession = (ctx.args[0] ?? '').toLowerCase() === 'all';
      const arg = (ctx.args[crossSession ? 1 : 0] ?? '').toLowerCase();
      let limit = 20;
      if (arg) {
        const n = Number(arg);
        if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 200);
      }
      let rows;
      try {
        rows = replArtifactStore.listRecent({
          ...(crossSession ? {} : { sessionId }),
          limit,
        });
      } catch (e) {
        ctx.display.printError(`/artifacts query failed: ${(e as Error).message}`);
        return {};
      }
      const scopeNoun = crossSession ? 'across all sessions' : 'in this conversation';
      if (rows.length === 0) {
        ctx.display.dim(`(no artifacts recorded yet ${scopeNoun})`);
        return {};
      }
      const scopeSuffix = crossSession ? ' [all sessions]' : '';
      ctx.display.info(`Artifacts${scopeSuffix} — ${rows.length} row${rows.length === 1 ? '' : 's'}, newest first:`);
      for (const r of rows) {
        const tsIso = new Date(r.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
        // Resolve the originating task goal for provenance (best-effort).
        let goal = '';
        if (r.taskId) {
          try {
            const t = replTaskStore.get(r.taskId);
            if (t?.goal) goal = t.goal.length > 50 ? `${t.goal.slice(0, 47)}…` : t.goal;
          } catch { /* provenance is best-effort */ }
        }
        const sess = crossSession ? `  ${r.sessionId.slice(0, 8).padEnd(8)}` : '';
        const goalSuffix = goal ? `  ${ctx.display.applyColors(`← ${goal}`, 'muted')}` : '';
        ctx.display.write(
          `  ${tsIso}${sess}  [${`${r.action}/${r.kind}`.padEnd(15)}]  ${r.path}  ${ctx.display.applyColors(r.tool, 'muted')}${goalSuffix}\n`,
        );
      }
      return {};
    },
  });

  // ── v4.12 /commands slice — /activity roll-up ──────────────────────
  //
  // Thin aggregator over the SAME accessors /usage /budget /history /tasks
  // /artifacts read. Inline (not barrel) because the task + artifact stores
  // are boot-local, like /tasks and /artifacts. `makeActivityCommand` takes
  // the live accessors so the roll-up logic stays unit-testable.
  commandRegistry.register(makeActivityCommand({
    sessionId:     () => replParentRunRef.chatSessionId,
    getCap:        () => config.getValue<number>('budget.session_token_cap', 0) ?? 0,
    getUsedTokens: (id) => sessionManager.getSessionTokens(id),
    getHistoryCount: async () => (await loadRecent(HISTORY_MAX_ENTRIES)).length,
    listTasks:     (id) => replTaskStore.listRecent({ sessionId: id, limit: 200 }),
    listArtifacts: (id) => replArtifactStore.listRecent({ sessionId: id, limit: 200 }),
  }));

  // ── v4.10 Slice 10.8 — /adjust slash command ───────────────────────
  //
  // Mutation surface for the Task-lite kernel. Two operations:
  //
  //   /adjust <task_id> cancel        → setStatus(task_id, 'cancelled')
  //   /adjust <task_id> goal <text>   → setGoal(task_id, <text>)
  //
  // `cancel` records the intent only — does NOT abort the in-flight
  // agent loop (no abort-signal-from-outside-the-turn plumbing
  // exists yet; that's v4.11 territory per Phase B Q3). Future
  // turns observe the status and can react.
  //
  // `goal <text>` updates the task's goal verbatim. Future tools
  // and the session-summary pipeline can read the new goal.
  commandRegistry.register({
    name: 'adjust',
    description: 'Adjust a task. Usage: /adjust <task_id> cancel  OR  /adjust <task_id> goal <new text>',
    category: 'system',
    icon: '⊕',
    handler: async (ctx) => {
      const taskId = (ctx.args[0] ?? '').trim();
      const op     = (ctx.args[1] ?? '').toLowerCase();
      if (!taskId || !op) {
        ctx.display.printError(
          'Usage: /adjust <task_id> cancel  OR  /adjust <task_id> goal <text>',
          'Run /tasks to see ids.',
        );
        return {};
      }
      let existing;
      try { existing = replTaskStore.get(taskId); }
      catch (e) {
        ctx.display.printError(`/adjust lookup failed: ${(e as Error).message}`);
        return {};
      }
      if (!existing) {
        ctx.display.printError(`Task not found: ${taskId}`, 'Run /tasks to see ids.');
        return {};
      }
      if (op === 'cancel') {
        if (existing.status === 'cancelled') {
          ctx.display.dim(`Task ${taskId} is already cancelled.`);
          return {};
        }
        if (existing.status === 'completed' || existing.status === 'failed') {
          ctx.display.warn(`Task ${taskId} is ${existing.status}; marking cancelled anyway.`);
        }
        try {
          replTaskStore.setStatus(taskId, 'cancelled');
          ctx.display.success(`Task ${taskId} cancelled.`);
          ctx.display.dim(
            '  Note: this records intent. Any in-flight agent turn keeps running — mid-turn abort is a future capability.',
          );
        } catch (e) {
          ctx.display.printError(`/adjust failed: ${(e as Error).message}`);
        }
        return {};
      }
      if (op === 'goal') {
        // ctx.args[0]=task_id, args[1]='goal', args[2..]=new goal text.
        const newGoal = ctx.args.slice(2).join(' ').trim();
        if (!newGoal) {
          ctx.display.printError(
            'Goal text is required.',
            'Usage: /adjust <task_id> goal <new text>',
          );
          return {};
        }
        try {
          replTaskStore.setGoal(taskId, newGoal);
          ctx.display.success(`Task ${taskId} goal updated.`);
        } catch (e) {
          ctx.display.printError(`/adjust failed: ${(e as Error).message}`);
        }
        return {};
      }
      ctx.display.printError(
        `Unknown /adjust operation '${op}'.`,
        'Try: /adjust <task_id> cancel  OR  /adjust <task_id> goal <text>',
      );
      return {};
    },
  });

  // Skill slash commands.
  try {
    const skillCmds = new SkillCommands(skillLoader);
    const map = await skillCmds.buildCommandMap();
    for (const [name, skill] of map) {
      // Skip skills whose name collides with a system command. Keep the
      // system command authoritative — skills can still be invoked via
      // `cmd:` tags in their frontmatter.
      if (commandRegistry.get(name)) continue;
      commandRegistry.register({
        name,
        description: skill.frontmatter.description,
        category: 'skill',
        icon: '⚡',
        handler: createSkillCommandHandler(skill),
      });
    }
  } catch (err) {
    display.dim(`(skill commands unavailable: ${(err as Error).message})`);
  }

  // ── Phase v4.1-1.1: CLI-side channel manager ──────────────────────
  //
  // Build a manager local to this CLI process and register the env-driven
  // adapters that don't need an Express app (Telegram is the only one in
  // Phase 1 — Discord/Slack/etc. land iteratively). Webhook/Twilio stay
  // out of CLI scope because they need an HTTP listener.
  //
  // Conflict guard: when `aiden serve` is already running locally, BOTH
  // processes would race the same Telegram bot's long-poll, and the
  // server would lose every other update with a 409. Probe localhost:4200
  // briefly; if the server answers, skip auto-start in CLI but still
  // build the manager so /channel list / status work as a read-only view.
  //
  // Phase v4.1-1.3a — `bootLogger` + gateway logger were attached
  // earlier (right after the agent was constructed) so the gateway
  // processor closure could share the same scoped sink chain. Here
  // we just plumb the channels child logger into the manager.
  const channelManager = new ChannelManager({ logger: bootLogger.child('channels') });
  // Phase v4.1-4.1 — wire active-model lookup into the Telegram
  // adapter. The closure captures `providerId` / `modelId` from
  // this scope so the photo-vision module can decide native vs
  // text routing (and pdf-extract can compute the truncation
  // budget) using the SAME model the chat path already uses.
  // v4.12.1 — headless one-shot registers NO channels and starts NO polling:
  // a single turn must not open a Telegram/Discord long-poll (a lingering
  // handle that would hang the process). The empty channelManager is still
  // returned so the runtime shape + teardown (stopAll) stay uniform.
  if (!headless) {
    // Phase v4.1-4.1 — wire active-model lookup into the Telegram adapter.
    channelManager.register(new TelegramAdapter({
      activeModelInfo: () => ({
        providerId,
        modelId,
        contextWindow: findModel(providerId, modelId)?.contextLength,
      }),
    }));
    // Phase v4.12.1 — also register any env-driven channel whose credentials
    // are present (e.g. Discord configured via `/channel discord add`) so it
    // survives a restart. Credential-gated: unconfigured channels are skipped,
    // so no disabled-adapter noise. Telegram is handled above (model wiring).
    registerEnvChannels(channelManager);

    let serverIsHosting = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 250);
      const probe = await fetch('http://127.0.0.1:4200/health', {
        signal: ctrl.signal,
      }).catch(() => null);
      clearTimeout(timer);
      if (probe && (probe.status >= 200 && probe.status < 500)) {
        serverIsHosting = true;
      }
    } catch {
      /* no server — fall through to CLI-host */
    }

    if (serverIsHosting) {
      display.dim(
        '[channels] aiden serve is running locally — channel adapters hosted there, /channel commands stay read-only.',
      );
    } else {
      // start() resolves quickly when no token is set (logs "Disabled" and
      // returns). Errors don't crash boot.
      channelManager.startAll().catch((e: Error) =>
        display.dim(`[channels] startAll error: ${e.message}`),
      );
    }
  }

  return {
    paths,
    config,
    store,
    sessionManager,
    skin,
    display,
    resolver,
    adapter,
    toolRegistry,
    skillLoader,
    memoryManager,
    memoryGuard,
    ssrfProtection,
    tirithScanner,
    approvalEngine,
    auxiliaryClient,
    callbacks,
    plannerGuard,
    honestyEnforcement,
    skillTeacher,
    plannerGuardMode,
    honestyMode,
    skillTeacherTier,
    agent,
    // v4.11 preflight compression — expose the wired compressor so
    // the REPL session can hand it to the /compress slash command
    // context AND so tests can introspect that production has a
    // non-undefined instance (formerly dormant in Phase 13).
    contextCompressor,
    commandRegistry,
    mcpClient,
    providerId,
    modelId,
    // v4.1.3-prebump: forward the precedence-case label so the boot
    // card can render a "where this choice came from" annotation.
    // The case-3 (persisted-config) branch was confusing users who
    // expected auto-pick to kick in — surfacing the source closes the
    // information asymmetry.
    bootSource,
    resumeSessionId,
    fallbackAdapter,
    personalityManager,
    pluginLoader,
    exploreMode,
    channelManager,
    daemonAgentBuilder,
    // v4.6 Phase 2Q-B — REPL parent-run wiring.
    replRunStore,
    replInstanceId,
    replParentRunRef,
    // v4.10 Slice 10.8 — durable Task-lite store.
    replTaskStore,
    // v4.11 — artifact registry store.
    replArtifactStore,
    // v4.12 /commands slice — /home working-directory change seam.
    setWorkingDir,
    // v4.12 PM.1 — background-process registry (reaped on session shutdown).
    processRegistry,
  };
}

/**
 * Phase 16b: shape returned by `buildAgentRuntime`. Tests inspect these
 * fields to verify wiring without booting the REPL.
 */
export interface AgentRuntime {
  paths: AidenPaths;
  config: ConfigManager;
  store: SessionStore;
  sessionManager: SessionManager;
  skin: SkinEngine;
  display: Display;
  resolver: RuntimeResolver;
  adapter: any;
  toolRegistry: ToolRegistry;
  skillLoader: SkillLoader;
  memoryManager: MemoryManager;
  memoryGuard: MemoryGuard;
  ssrfProtection: SSRFProtection;
  tirithScanner: TirithScanner;
  approvalEngine: ApprovalEngine;
  auxiliaryClient: AuxiliaryClient;
  callbacks: CliCallbacks;
  plannerGuard: PlannerGuard;
  honestyEnforcement: HonestyEnforcement;
  skillTeacher: SkillTeacher;
  plannerGuardMode: PlannerGuardMode;
  honestyMode: HonestyMode;
  skillTeacherTier: SkillTeacherTier;
  agent: AidenAgent;
  /** v4.11 preflight compression — production-wired (no longer dormant). */
  contextCompressor: ContextCompressor;
  commandRegistry: CommandRegistry;
  mcpClient: ReturnType<typeof setupMcpFromConfig> extends Promise<infer R>
    ? R extends { client: infer C }
      ? C
      : null
    : null;
  providerId: string;
  modelId: string;
  /**
   * v4.1.3-prebump — which precedence case in providerBootSelector
   * produced the (providerId, modelId) pair. Surfaced in the boot card
   * so users can tell at a glance whether their session is using a
   * persisted choice, an auto-pick, a CLI override, or the hardcoded
   * legacy fallback. Mirrors BootSelection.source from
   * providerBootSelector with `hardcoded-fallback` added for Case 6.
   */
  bootSource:
    | 'cli-flag'
    | 'persisted-config'
    | 'auto-priority'
    | 'cli-flag-partial'
    | 'config-partial'
    | 'hardcoded-fallback';
  resumeSessionId: string | undefined;
  /** Phase 16b.1: present when a multi-slot fallback chain is active. */
  fallbackAdapter: FallbackAdapter | null;
  /** Phase 16b.4: personality overlay manager wired into chatSession + commands. */
  personalityManager: PersonalityManager;
  /** Phase 17 Task 5: live plugin loader for /plugins commands + onTeardown on shutdown. */
  pluginLoader: PluginLoader;
  /**
   * Phase 30.2.1 — true when the wizard returned 'skipped' (recovery
   * option [4] or Ctrl+C). The REPL boots with a NullAdapter so slash
   * commands work; ChatSession intercepts chat attempts and prints a
   * friendly "no provider configured" message instead of crashing.
   */
  exploreMode: boolean;
  /**
   * Phase v4.1-1.1 — live ChannelManager hosted by the CLI process.
   * /channel slash commands operate on this; chatSession.run() awaits
   * `stopAll()` on graceful exit so polling adapters disconnect.
   */
  channelManager: ChannelManager;
  /**
   * v4.5 Phase 7b — daemon agent builder closure. Captures the
   * REPL's initialized provider resolver, tool registry, prompt
   * builder, etc. The dispatcher invokes this per claimed trigger
   * event to construct a fresh AidenAgent for the daemon turn.
   * Passed to `bootstrapDaemon({agentBuilder})` in
   * runInteractiveChat.
   */
  daemonAgentBuilder: import('../../core/v4/daemon/dispatcher').AgentBuilder;
  /**
   * v4.6 Phase 2Q-B — REPL persistence handles. ChatSession consumes
   * `replRunStore` + `replInstanceId` to insert a `runs` row per
   * turn, and writes the row id into `replParentRunRef` so spawned
   * children link via `spawned_from_run_id`.
   */
  replRunStore:     import('../../core/v4/daemon/runStore').RunStore;
  replInstanceId:   string;
  /**
   * v4.10 Slice 10.8 — durable Task-lite store. Mirrors replRunStore's
   * lifecycle; shares the daemon.db handle so /tasks listing + /adjust
   * mutations see consistent state with chatSession's runAgentTurn
   * writes.
   */
  replTaskStore:    import('../../core/v4/daemon/taskStore').TaskStore;
  replArtifactStore: import('../../core/v4/daemon/artifactStore').ArtifactStore;
  /** v4.12 /commands slice — `/home` working-directory change seam. */
  setWorkingDir: (absPath: string) => void;
  /** v4.12 PM.1 — background-process registry (reaped on session shutdown). */
  processRegistry: import('../../core/v4/processRegistry').ProcessRegistry;
  /**
   * v4.10 Slice 10.2c — `chatSessionId` is the long-lived REPL session
   * id (set once at ChatSession.run() init, never cleared between turns).
   * `sessionId` is the per-turn mirror that gets nulled post-turn.
   * Read surfaces (/trace recent, trace_query) must use `chatSessionId`;
   * emitter sites (called during a turn) can use either.
   */
  replParentRunRef: {
    runId:         number | null;
    sessionId:     string | null;
    chatSessionId: string | null;
  };
}

// ── v4.12.1 — headless one-shot (`aiden -q`) ─────────────────────────────
//
// A single non-interactive agent turn: print the answer to stdout (clean,
// pipeable — no banner/footer/box-drawing) and exit with an honest code.
// Reuses the SAME Display-free seam the channel adapters use —
// agent.runConversation([userTurn]) — without booting the REPL/TUI, the
// greeter, the paste interceptor, watchers, or channel polling.

/** Loose structural shape of the one turn we need — lets tests pass a mock. */
interface OneShotAgent {
  runConversation(history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>): Promise<{
    finalContent?:  string;
    finishReason?:  string;
    toolCallTrace?: Array<{ error?: string }>;
  }>;
}

export interface OneShotDeps {
  agent:     OneShotAgent;
  prompt:    string;
  /** Defaults to process.stdout.write — the ONLY thing that touches stdout. */
  writeOut?: (s: string) => void;
  /** Defaults to process.stderr.write — diagnostics stay off stdout. */
  writeErr?: (s: string) => void;
  /** Best-effort resource cleanup, always awaited (finally). */
  teardown?: () => Promise<void>;
}

/**
 * Run one turn, print the answer to stdout, and return an HONEST exit code
 * (0 = clean success; non-zero = agent error, incomplete turn, or a tool
 * denied by the approval policy). Never calls process.exit — the caller owns
 * that so this stays unit-testable. Always runs `teardown` (finally) so the
 * caller can process.exit() without leaking handles.
 */
export async function executeOneShotTurn(deps: OneShotDeps): Promise<number> {
  const out = deps.writeOut ?? ((s: string) => { process.stdout.write(s); });
  const err = deps.writeErr ?? ((s: string) => { process.stderr.write(s); });
  let code = 0;
  try {
    const result = await deps.agent.runConversation([{ role: 'user', content: deps.prompt }]);
    const answer = result.finalContent ?? '';
    // stdout carries ONLY the answer (newline-terminated for pipe hygiene).
    out(answer.endsWith('\n') ? answer : `${answer}\n`);

    // Surface tools denied by the auto-deny policy so the output isn't
    // silently incomplete. Matches the executor's denial marker
    // (core/v4/toolRegistry.ts: 'Tool execution denied by approval engine').
    const denied = (result.toolCallTrace ?? []).filter(
      (e) => typeof e?.error === 'string' && /denied by (the )?approval/i.test(e.error),
    );
    if (denied.length > 0) {
      err(
        `[aiden -q] ${denied.length} tool call(s) were denied by the approval policy. ` +
        `Re-run with --yolo to allow tool use.\n`,
      );
      code = 1;
    }
    if (result.finishReason && result.finishReason !== 'stop') {
      err(`[aiden -q] turn did not complete cleanly (finishReason: ${result.finishReason}).\n`);
      if (code === 0) code = 1;
    }
  } catch (e: any) {
    err(`[aiden -q] agent error: ${e?.message ?? String(e)}\n`);
    code = 1;
  } finally {
    if (deps.teardown) {
      try { await deps.teardown(); } catch { /* teardown is best-effort */ }
    }
  }
  return code;
}

/**
 * Build a headless runtime, run one turn, tear down, and return the exit
 * code. `_build` is an injection seam for tests (defaults to the real
 * buildAgentRuntime). Does NOT call process.exit — the caller does.
 */
export async function runQuery(
  prompt: string,
  cliOpts: any,
  opts: MainOptions,
  _build: typeof buildAgentRuntime = buildAgentRuntime,
): Promise<number> {
  let runtime: AgentRuntime;
  try {
    runtime = await _build({ ...cliOpts, headless: true }, opts);
  } catch (e: any) {
    if (e instanceof NoProviderConfiguredError) {
      process.stderr.write(
        'aiden -q: no provider configured. Run `aiden setup` from a terminal first.\n',
      );
      return 1;
    }
    process.stderr.write(`aiden -q: failed to start: ${e?.message ?? String(e)}\n`);
    return 1;
  }
  return executeOneShotTurn({
    agent:  runtime.agent as unknown as OneShotAgent,
    prompt,
    teardown: async () => {
      // Same discipline as runInteractiveChat's shutdown, plus process.exit
      // in the caller guarantees no lingering-handle hang (memory #29).
      try { if (runtime.mcpClient) await runtime.mcpClient.closeAll(); } catch { /* best-effort */ }
      try { await runtime.pluginLoader?.teardown(); } catch { /* best-effort */ }
      try { await runtime.channelManager?.stopAll(); } catch { /* best-effort */ }
      try { runtime.store?.close?.(); } catch { /* best-effort */ }
    },
  });
}

async function runInteractiveChat(cliOpts: any, opts: MainOptions): Promise<void> {
  const runtime = await buildAgentRuntime(cliOpts, opts);

  // v4.5 Phase 7c — install the REAL agent runner now that the
  // REPL agent is built. The daemon foundation already came up
  // earlier (top of REPL action handler) with the Phase 5a
  // placeholder runner serving claims. This call atomically swaps
  // the dispatcher's runner from placeholder → real; the next
  // claim uses `runtime.daemonAgentBuilder` to construct a real
  // AidenAgent per fire.
  try {
    if (process.env.AIDEN_DAEMON === '1') {
      const { getDaemonHandle, installDaemonAgentBuilder } =
        await import('../../core/v4/daemon/bootstrap');
      const handle = getDaemonHandle();
      if (handle && handle.active) {
        const ok = installDaemonAgentBuilder(
          handle,
          runtime.daemonAgentBuilder,
          { provider: runtime.providerId, model: runtime.modelId },
        );
        if (!ok) {
          console.warn('[daemon] real-runner install returned false — placeholder still active');
        }
      }
    }
  } catch (e) {
    // Fail-loud but non-fatal — install failure leaves the
    // placeholder runner active; the REPL still works and the
    // daemon's rails still serve triggers.
    console.error('[daemon] install agent builder failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  const sessionOpts = {
    agent: runtime.agent,
    display: runtime.display,
    commandRegistry: runtime.commandRegistry,
    callbacks: runtime.callbacks,
    sessionManager: runtime.sessionManager,
    auxiliaryClient: runtime.auxiliaryClient,
    approvalEngine: runtime.approvalEngine,
    mcpClient: runtime.mcpClient ?? undefined,
    skin: runtime.skin,
    toolRegistry: runtime.toolRegistry,
    skillLoader: runtime.skillLoader,
    resolver: runtime.resolver,
    config: runtime.config,
    initialProviderId: runtime.providerId,
    initialModelId: runtime.modelId,
    // v4.1.3-prebump: pass through the precedence-case label so the
    // boot card can render a dim source annotation under the version
    // pill ("persisted from prior session" / "auto-picked" / …).
    initialBootSource: runtime.bootSource,
    resumeSessionId: runtime.resumeSessionId,
    yoloMode: !!cliOpts.yolo,
    fallbackAdapter: runtime.fallbackAdapter,
    paths: runtime.paths,
    personalityManager: runtime.personalityManager,
    pluginLoader: runtime.pluginLoader,
    // Phase 30.2.1 — boot card renders "model not configured" and
    // chat attempts get the friendly NotConfiguredError message.
    unconfigured: runtime.exploreMode,
    // Phase v4.1-1.1 — live ChannelManager so /channel commands can
    // list, add, remove, and inspect adapters without an external server.
    channelManager: runtime.channelManager,
    // v4.12 /commands slice — /home working-directory change seam.
    setWorkingDir: runtime.setWorkingDir,
    // v4.12 PM.1 — process registry so session shutdown reaps spawns.
    processRegistry: runtime.processRegistry,
    // Phase v4.1.2 session-summary-followup: ChatSession.maybeAutoSummarize
    // needs these to write MEMORY.md directly (bypassing the agent loop)
    // when /quit fires the auto-summary path.
    memoryManager: runtime.memoryManager,
    memoryGuard:   runtime.memoryGuard,
    // v4.11 preflight compression — give the REPL session the SAME
    // ContextCompressor instance the AidenAgent received above. The
    // `/compress` slash command (`cli/v4/commands/compress.ts`) reads
    // `ctx.compressor` from this field; before this wire it was
    // permanently undefined and the command reported "Compressor or
    // session not wired."
    compressor:    runtime.contextCompressor,
    // v4.6 Phase 2Q-B — REPL parent-run wiring. ChatSession.runAgentTurn
    // writes a runs row per turn and stores its id into
    // `replParentRunRef`; the spawn / fanout factories above read the
    // ref via their `resolveParentRunId` / `resolveParentSessionId`
    // callbacks so children get `spawned_from_run_id` populated.
    replRunStore:     runtime.replRunStore,
    replInstanceId:   runtime.replInstanceId,
    replParentRunRef: runtime.replParentRunRef,
    // v4.10 Slice 10.8 — durable Task-lite store. ChatSession's
    // runAgentTurn auto-creates a task per user message + transitions
    // status on success/failure. /tasks and /adjust slash commands
    // read/write through this same handle.
    replTaskStore:    runtime.replTaskStore,
    replArtifactStore: runtime.replArtifactStore,
  };

  if (cliOpts.tui) {
    await runTuiMode({
      sessionOpts: sessionOpts as any,
      skinName:
        runtime.config.getValue<string>('display.skin', 'default') ?? 'default',
    });
  } else {
    const session = new ChatSession(sessionOpts as any);
    await session.run();
  }
  if (runtime.mcpClient) {
    await runtime.mcpClient.closeAll().catch(() => undefined);
  }
  // Phase 17 Task 5: fire onTeardown so plugins (e.g. CDP browser) can
  // close their resources before the process exits.
  await runtime.pluginLoader.teardown().catch(() => undefined);
  // Phase v4.1-1.1 — stop polling adapters before exit so Telegram's
  // long-poll TCP connection closes cleanly. stopAll() is best-effort
  // and never throws.
  await runtime.channelManager.stopAll().catch(() => undefined);
  runtime.store.close?.();
}

// ─── setup ─────────────────────────────────────────────────────────────

/**
 * v4.9.5 Slice 1.6 — test injection seam. `runSetupSubcommand`
 * delegates to `runInteractiveChat` so the subcommand boots through
 * the exact same disclaimer → loading → wizard → REPL handoff that
 * fresh-install boot uses. Tests swap this for a counting stub to
 * verify the delegation is intact (regression layer for
 * "subcommand silently skipped onboarding screens" bug class).
 *
 * Pass null to restore the production implementation.
 */
let _runInteractiveChatImpl: typeof runInteractiveChat = runInteractiveChat;
export function setRunInteractiveChatForTest(
  fn: typeof runInteractiveChat | null,
): void {
  _runInteractiveChatImpl = fn ?? runInteractiveChat;
}

async function runSetupSubcommand(opts: MainOptions): Promise<void> {
  // v4.9.5 Slice 1.6 — `aiden setup` now goes through the full
  // fresh-install boot path: disclaimer → animated loading → wizard
  // (Steps 1–4, including curated skills) → success screen → REPL
  // handoff. Identical to typing `aiden` on a true fresh install.
  // `forceSetup: true` bypasses the wizardNeeded detection inside
  // buildAgentRuntime so the wizard fires even when an existing
  // config is present.
  //
  // Daemon foundation bootstrap mirrors the default REPL action
  // (L334–343) so users with AIDEN_DAEMON=1 don't lose background
  // rails just because they entered via `aiden setup`. The gate is
  // env-checked, so it's a no-op for the common case.
  try {
    if (process.env.AIDEN_DAEMON === '1') {
      const { bootstrapDaemonFoundation } = await import('../../core/v4/daemon/bootstrap');
      bootstrapDaemonFoundation();
    }
  } catch (e) {
    console.error('[daemon] foundation bootstrap failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  // cliOpts={} — `aiden setup` accepts no command-level flags today.
  // runInteractiveChat reads cliOpts.yolo / .skin with default-undefined
  // semantics, so an empty bag is safe.
  await _runInteractiveChatImpl({}, { ...opts, forceSetup: true });
}

// ─── model ─────────────────────────────────────────────────────────────

async function runModelSubcommand(spec: string | undefined, opts: MainOptions): Promise<void> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  const config = new ConfigManager(paths);
  await config.load();
  const credentialResolver = new CredentialResolver(paths.authJson);
  const resolver = new RuntimeResolver(credentialResolver);
  const out = opts.writeOut ?? ((t) => process.stdout.write(t));

  const result = await runModelPicker({ resolver, spec });
  if (!result) {
    out('No model selected.\n');
    return;
  }
  config.set('model.provider', result.providerId);
  config.set('model.modelId', result.modelId);
  await config.save();
  out(`Saved: ${result.providerId} / ${result.modelId}\n`);
}

// ─── config ────────────────────────────────────────────────────────────

async function runConfigSubcommand(
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  opts: MainOptions,
): Promise<void> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  const config = new ConfigManager(paths);
  await config.load();
  const out = opts.writeOut ?? ((t) => process.stdout.write(t));

  const act = action ?? 'view';
  switch (act) {
    case 'view': {
      try {
        const raw = await fs.readFile(paths.configYaml, 'utf8');
        out(raw + '\n');
      } catch {
        out(`# (no config.yaml at ${paths.configYaml})\n`);
        out(JSON.stringify(config.snapshot(), null, 2) + '\n');
      }
      return;
    }
    case 'set': {
      if (!key) {
        out('Usage: aiden config set <dotted.key> <value>\n');
        return;
      }
      config.set(key, value);
      await config.save();
      out(`Set ${key} = ${value ?? '(unset)'}\n`);
      return;
    }
    case 'check': {
      const ok = await isFreshInstall(paths).then((fresh) => !fresh);
      out(`config.yaml ${ok ? 'present' : 'missing'} at ${paths.configYaml}\n`);
      return;
    }
    default:
      out(`Unknown config action '${act}'. Use: view | set | check.\n`);
  }
}

// ─── sessions ──────────────────────────────────────────────────────────

async function runSessionsSubcommand(
  action: string,
  arg: string | undefined,
  opts: MainOptions,
): Promise<void> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  const store = new SessionStore(paths.sessionsDb);
  const mgr = new SessionManager(store);
  const out = opts.writeOut ?? ((t) => process.stdout.write(t));

  switch (action) {
    case 'list': {
      const list = mgr.listSessions({ limit: 20, orderBy: 'updated' });
      if (list.length === 0) {
        out('No sessions yet.\n');
      } else {
        for (const s of list) {
          const t = s.title ?? '(untitled)';
          const ts = new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
          out(`${s.id.slice(0, 8)}  ${ts}  ${s.providerId ?? '?'}/${s.modelId ?? '?'}  ${t}\n`);
        }
      }
      break;
    }
    case 'search': {
      if (!arg) {
        out('Usage: aiden sessions search <query>\n');
        break;
      }
      const hits = mgr.search(arg, 20);
      if (hits.length === 0) out(`No matches for "${arg}".\n`);
      else {
        for (const h of hits) {
          out(`${h.sessionId.slice(0, 8)}  ${h.title ?? '(untitled)'}\n  ${h.matchedContent.slice(0, 80)}\n`);
        }
      }
      break;
    }
    default:
      out(`Unknown sessions action '${action}'. Use: list | search.\n`);
  }
  store.close?.();
}

// ─── skills ────────────────────────────────────────────────────────────

async function runSkillsSubcommand(
  action: string,
  arg: string | undefined,
  opts: MainOptions,
): Promise<void> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  const skillLoader = new SkillLoader(paths);
  const out = opts.writeOut ?? ((t) => process.stdout.write(t));

  switch (action) {
    case 'list': {
      const skills = await skillLoader.list();
      if (skills.length === 0) {
        out('No skills installed.\n');
      } else {
        for (const s of skills) {
          out(`${s.name.padEnd(28)}  ${s.category ?? '-'}  ${s.description}\n`);
        }
      }
      break;
    }
    case 'view': {
      if (!arg) {
        out('Usage: aiden skills view <name>\n');
        break;
      }
      const skill = await skillLoader.load(arg);
      if (!skill) {
        out(`Skill '${arg}' not found.\n`);
      } else {
        out(await fs.readFile(skill.filePath, 'utf8'));
        out('\n');
      }
      break;
    }
    case 'search':
    case 'browse':
    case 'check':
    case 'update':
    case 'audit':
    case 'publish':
    case 'snapshot':
    case 'install':
    case 'uninstall':
    case 'reset':
      out(`'aiden skills ${action}' is deferred to v4.1 alongside the gateway.\n`);
      break;
    default:
      out(`Unknown skills action '${action}'. Use: list | view <name>.\n`);
  }
}

// ─── module-as-script ──────────────────────────────────────────────────

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main(process.argv).then((code) => {
    if (code !== 0) process.exit(code);
  });
}

// Export internals for tests.
export {
  runInteractiveChat,
  runSetupSubcommand,
  runModelSubcommand,
  runConfigSubcommand,
  runSessionsSubcommand,
  runSkillsSubcommand,
};
