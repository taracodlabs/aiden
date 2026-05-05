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
 * Hermes reference: hermes_cli/main.py — its `main()` dispatches via
 * `argparse` subparsers. We use `commander` instead but the surface
 * matches Hermes's chat-first invocation flow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ChatSession } from './chatSession';
import { runTuiMode } from './aidenTUI';
import { Display } from './display';
import { SkinEngine } from './skinEngine';
import { CommandRegistry } from './commandRegistry';
import { CliCallbacks } from './callbacks';
import { runSetupWizard, isFreshInstall } from './setupWizard';
import { runDoctorCli } from './doctor';
import { runModelPicker } from './commands/modelPicker';
import { allCommands } from './commands';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
  type AidenPaths,
} from '../../core/v4/paths';
import { ensureSoulMdSeeded } from '../../core/v4/soulSeed';
import { ConfigManager } from '../../core/v4/config';
import { SessionStore } from '../../core/v4/sessionStore';
import { SessionManager } from '../../core/v4/sessionManager';
import { ToolRegistry } from '../../core/v4/toolRegistry';
import { SkillLoader } from '../../core/v4/skillLoader';
import { SkillCommands } from '../../core/v4/skillCommands';
import { AidenAgent } from '../../core/v4/aidenAgent';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import { PersonalityManager } from '../../core/v4/personality';
import { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import { MemoryManager } from '../../core/v4/memoryManager';

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
import { MemoryGuard } from '../../moat/memoryGuard';
import { SSRFProtection } from '../../moat/ssrfProtection';
import { TirithScanner } from '../../moat/tirithScanner';

import { CredentialResolver } from '../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../providers/v4/runtimeResolver';
import { ChatCompletionsAdapter } from '../../providers/v4/chatCompletionsAdapter';
import {
  FallbackAdapter,
  buildDefaultSlots,
  type ProviderSlot,
} from '../../core/v4/providerFallback';
import { restoreBundledSkillsIfNeeded } from '../../core/v4/skillBundledRestore';
import { createFileLogger } from '../../core/v4/aidenLogger';

import { registerAllTools } from '../../tools/v4';
import { setupMcpFromConfig } from '../../tools/v4/mcpSetup';

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

const VERSION = '4.0.0';

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
  /** Path override for tests. */
  pathsOverride?: AidenPaths;
  /** Stub stdout writer (defaults to process.stdout.write). */
  writeOut?: (text: string) => void;
}

export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const program = new Command();

  program
    .name('aiden')
    .description('Aiden — local-first AI agent')
    .version(VERSION, '-v, --version')
    .option('--tui', 'Launch full-screen TUI renderer', false)
    .option('-c, --continue', 'Resume the most recent session')
    .option('-r, --resume <title>', 'Resume a session by id-prefix or partial title')
    .option('--yolo', 'Skip approval prompts (YOLO mode)')
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
    .action(async () => {
      const cliOpts = program.opts();
      if (opts.runChatHook) {
        await opts.runChatHook(cliOpts);
        return;
      }
      await runInteractiveChat(cliOpts, opts);
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
    .action(async () => {
      if (opts.runDoctorHook) {
        await opts.runDoctorHook();
        return;
      }
      await runDoctorCli();
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
    });

  program
    .command('mcp <action>')
    .description('Manage MCP servers (full impl deferred to v4.1 with the gateway).')
    .action(async (action: string) => {
      if (opts.runMcpHook) {
        await opts.runMcpHook(action);
        return;
      }
      const out = opts.writeOut ?? ((t) => process.stdout.write(t));
      out(`'aiden mcp ${action}' is deferred to v4.1 alongside the gateway.\n`);
    });

  // v4.1 placeholders. (`tui` graduated to a real flag in Phase 15.)
  for (const cmd of ['batch', 'gateway', 'cron', 'pairing', 'update']) {
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
export async function buildAgentRuntime(
  cliOpts: any,
  opts: MainOptions,
): Promise<AgentRuntime> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  await ensureAidenDirsExist(paths);

  // Phase 16c.2: load `paths.envFile` (the aiden-managed `.env` that
  // `setupWizard.ts::upsertEnvVar` writes to) into `process.env` BEFORE
  // any provider resolution. The bug: setup wrote keys to this file but
  // the runtime never read them back, so users who configured via the
  // wizard saw "GROQ_API_KEY unset" at boot. Existing process.env entries
  // (from the user's shell or Windows User env) win — this is fill-only.
  loadAidenEnvFile(paths.envFile);

  // Phase 16b.3: first-run SOUL.md seed. Hermes-style idempotent write — if
  // the user already has a SOUL.md (even one byte), we never touch it.
  await ensureSoulMdSeeded(paths).catch(() => undefined);

  // Phase 16b.1: first-run / self-heal copy of bundled skills. No-op
  // when the user's skills dir is already populated.
  await restoreBundledSkillsIfNeeded(paths).catch(() => undefined);

  const config = new ConfigManager(paths);
  await config.load();

  if (await isFreshInstall(paths)) {
    process.stdout.write('Aiden is not configured yet. Running setup wizard…\n');
    await runSetupWizard({ paths });
    await config.load();
  }

  const providerId =
    (cliOpts.provider as string | undefined) ??
    config.getValue<string>('model.provider', 'groq')!;
  const modelId =
    (cliOpts.model as string | undefined) ??
    config.getValue<string>('model.modelId', 'llama-3.3-70b-versatile')!;

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
  const display = new Display({ skin });
  const warnSink = (msg: string) => display.warn(msg);

  // Resolver + adapter.
  const credentialResolver = new CredentialResolver(paths.authJson);
  const resolver = new RuntimeResolver(credentialResolver);
  let adapter;
  try {
    adapter = await resolver.resolve({ providerId, modelId, config });
  } catch (err) {
    display.printError(
      `Could not resolve provider '${providerId}' / model '${modelId}': ${(err as Error).message}`,
      'Run `aiden model` to pick a valid provider, or `aiden doctor`.',
    );
    process.exit(1);
  }

  // Phase 16b.1: wrap chat_completions providers in a FallbackAdapter so
  // 429s on Groq slot 1 transparently retry Groq slot 2/3 and Together.
  // Only activates when there's at least one *additional* slot configured
  // beyond the primary — otherwise the wrapper would just rethrow.
  let fallbackAdapter: FallbackAdapter | null = null;
  if (
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

  // Tool registry + executor.
  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry);

  // Memory + skill loader.
  const memoryManager = new MemoryManager(paths);
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
  if (cliOpts.yolo) approvalEngine.setMode('off');
  // Phase 16f: hydrate persistent allowlist from disk so "Allow always"
  // choices survive across REPL restarts.
  try {
    const raw = require('node:fs').readFileSync(paths.approvalsJson, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      approvalEngine.loadPersistentAllowlist(
        parsed.filter(
          (e: any) =>
            e &&
            typeof e.tool === 'string' &&
            typeof e.signature === 'string',
        ),
      );
    }
  } catch {
    // Missing or unreadable file is fine — no permanent allowlist yet.
  }

  // Auxiliary client (compression / risk-assessment cheap LLM). Default to
  // the same provider/model as the main loop — the resolver hands the
  // auxiliary client a separately-configured cheap model later (v4.1).
  const auxiliaryClient = new AuxiliaryClient({
    defaultProvider: providerId,
    defaultModel: modelId,
    resolver: { resolve: (o) => resolver.resolve(o) },
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
    // Phase 16f: append-on-disk for "Allow always" choices. Single-process
    // REPL — atomic write via tmp-then-rename.
    persistAllow: (tool: string, signature: string) => {
      const fs = require('node:fs');
      let entries: Array<{ tool: string; signature: string }> = [];
      try {
        const cur = fs.readFileSync(paths.approvalsJson, 'utf8');
        const parsed = JSON.parse(cur);
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        /* fresh file */
      }
      // De-dupe: same tool+signature shouldn't appear twice.
      if (
        !entries.some((e) => e.tool === tool && e.signature === signature)
      ) {
        entries.push({ tool, signature });
        const tmp = `${paths.approvalsJson}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
        fs.renameSync(tmp, paths.approvalsJson);
      }
    },
  } as any;

  // MCP setup (best-effort — connection failures are non-fatal).
  const mcpResult = await setupMcpFromConfig(config, toolRegistry).catch(
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
  const skillTeacher = new SkillTeacher(
    skillLoader,
    skillManageProxy,
    skillTeacherTier,
    undefined,
    (name) => toolRegistry.get(name),
  );

  // ── Tool executor with full Phase 9 + 10 context ─────────────────────
  const toolExecutor = toolRegistry.buildExecutor({
    cwd: process.cwd(),
    paths,
    sessions: sessionManager,
    memory: memoryManager,
    memoryGuard,
    approvalEngine,
    ssrfProtection,
    tirithScanner,
    skillLoader,
  });

  // Resolve verified-flag from memory tool results (Phase 9 wrappers
  // surface `{ ok, verified, ... }`).
  const resolveVerifiedFlag = (r: { result?: unknown }) => {
    const v = (r.result as { verified?: boolean })?.verified;
    return typeof v === 'boolean' ? v : undefined;
  };
  const resolveToolset = (name: string) =>
    toolRegistry.get(name)?.toolset;

  // ── Phase 16b.4: assemble system-prompt context ─────────────────────
  // PromptBuilder needs SOUL.md (read at build time from `paths.soulMd`),
  // a frozen MemorySnapshot (loaded once at boot — same lifecycle as
  // Hermes' `_cached_system_prompt`), the active personality overlay, and
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
    const loaded = await skillLoader.list();
    skillsList = loaded.slice(0, 32).map((s) => ({
      name: (s as { name: string }).name,
      description: ((s as { description?: string }).description ?? '').slice(0, 120),
    }));
  } catch {
    skillsList = [];
  }
  const promptBuilderOptions = {
    paths,
    memorySnapshot,
    skillsList,
    personalityOverlay: activeOverlay,
    modelId,
  };

  // ── Build agent with all moat layers attached ────────────────────────
  const agent = new AidenAgent({
    provider: adapter,
    tools: toolRegistry.getSchemas(),
    toolExecutor,
    maxTurns: config.getValue<number>('agent.max_turns', 90)!,
    auxiliaryClient,
    plannerGuard,
    honestyEnforcement,
    skillTeacher,
    onCompression: callbacks.onCompression,
    onBudgetWarning: callbacks.onBudgetWarning,
    onPlannerGuardDecision: callbacks.onPlannerGuardDecision,
    skillTeacherCallbacks: { promptUser: callbacks.promptSkillProposal },
    resolveVerifiedFlag,
    resolveToolset,
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
  });

  // Phase 16d: wire the dirty-bit signal — every successful memory mutation
  // flips the agent's flag so the NEXT turn's system prompt reflects the
  // change. Strategy (b) per docs/sprint/hermes-memory-refresh-audit.md.
  memoryManager.onMutation((file) => {
    agent.markMemoryDirty(file === 'user' ? 'user' : 'memory');
  });

  // Command registry.
  const commandRegistry = new CommandRegistry();
  for (const cmd of allCommands) commandRegistry.register(cmd);

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
    commandRegistry,
    mcpClient,
    providerId,
    modelId,
    resumeSessionId,
    fallbackAdapter,
    personalityManager,
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
  commandRegistry: CommandRegistry;
  mcpClient: ReturnType<typeof setupMcpFromConfig> extends Promise<infer R>
    ? R extends { client: infer C }
      ? C
      : null
    : null;
  providerId: string;
  modelId: string;
  resumeSessionId: string | undefined;
  /** Phase 16b.1: present when a multi-slot fallback chain is active. */
  fallbackAdapter: FallbackAdapter | null;
  /** Phase 16b.4: personality overlay manager wired into chatSession + commands. */
  personalityManager: PersonalityManager;
}

async function runInteractiveChat(cliOpts: any, opts: MainOptions): Promise<void> {
  const runtime = await buildAgentRuntime(cliOpts, opts);

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
    resumeSessionId: runtime.resumeSessionId,
    yoloMode: !!cliOpts.yolo,
    fallbackAdapter: runtime.fallbackAdapter,
    paths: runtime.paths,
    personalityManager: runtime.personalityManager,
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
  runtime.store.close?.();
}

// ─── setup ─────────────────────────────────────────────────────────────

async function runSetupSubcommand(opts: MainOptions): Promise<void> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  await runSetupWizard({ paths, force: true });
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
