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
import { ConfigManager } from '../../core/v4/config';
import { SessionStore } from '../../core/v4/sessionStore';
import { SessionManager } from '../../core/v4/sessionManager';
import { ToolRegistry } from '../../core/v4/toolRegistry';
import { SkillLoader } from '../../core/v4/skillLoader';
import { SkillCommands } from '../../core/v4/skillCommands';
import { AidenAgent } from '../../core/v4/aidenAgent';
import { AuxiliaryClient } from '../../core/v4/auxiliaryClient';

import { ApprovalEngine } from '../../moat/approvalEngine';

import { CredentialResolver } from '../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../providers/v4/runtimeResolver';

import { registerAllTools } from '../../tools/v4';
import { setupMcpFromConfig } from '../../tools/v4/mcpSetup';

import { createSkillCommandHandler } from './commands/skillCommandHandler';

const VERSION = '4.0.0';

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

async function runInteractiveChat(cliOpts: any, opts: MainOptions): Promise<void> {
  const paths = opts.pathsOverride ?? resolveAidenPaths();
  await ensureAidenDirsExist(paths);

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

  // Tool registry + executor.
  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry);

  // Skill loader.
  const skillLoader = new SkillLoader(paths);

  // Approval engine.
  const approvalEngine = new ApprovalEngine(
    config.getValue<'manual' | 'smart' | 'off'>('agent.approval_mode', 'manual'),
  );
  if (cliOpts.yolo) approvalEngine.setMode('off');

  // Auxiliary client (compression / risk-assessment cheap LLM). Default to
  // the same provider/model as the main loop — the resolver hands the
  // auxiliary client a separately-configured cheap model later (Phase 16).
  const auxiliaryClient = new AuxiliaryClient({
    defaultProvider: providerId,
    defaultModel: modelId,
    resolver: { resolve: (o) => resolver.resolve(o) },
  });

  // CLI callbacks.
  const callbacks = new CliCallbacks({
    display,
    auxiliaryClient,
    verboseMode: 'normal',
  });
  approvalEngine['callbacks'] = {
    promptUser: callbacks.promptApproval,
    riskAssess: callbacks.riskAssess,
  } as any;

  // MCP setup (best-effort — connection failures are non-fatal).
  const mcpResult = await setupMcpFromConfig(config, toolRegistry).catch(
    () => ({ client: null, connected: [], failures: {} }),
  );
  const mcpClient = mcpResult.client ?? null;

  // Phase 12 moat layers: skipped at REPL boot for Phase 14c. The agent
  // still functions correctly without them; PlannerGuard/Honesty/SkillTeacher
  // wiring lands in Phase 16 polish once the bootstrap data is settled.

  // Build agent. Tool executor wired with conservative context: SSRF and
  // approval engine; SkillsHub-driven `skill_view` toolset activation
  // is handled by ToolRegistry's executor itself.
  const agent = new AidenAgent({
    provider: adapter,
    tools: toolRegistry.getSchemas(),
    toolExecutor: toolRegistry.buildExecutor({
      cwd: process.cwd(),
      paths,
      sessions: sessionManager,
      memory: {} as any, // memoryManager not yet wired at REPL — Phase 16
      memoryGuard: undefined as any,
      approvalEngine,
      ssrfProtection: undefined as any,
      tirithScanner: undefined as any,
      skillLoader,
    } as any),
    maxTurns: config.getValue<number>('agent.max_turns', 90)!,
    auxiliaryClient,
    onCompression: callbacks.onCompression,
    onBudgetWarning: callbacks.onBudgetWarning,
    providerId,
    modelId,
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

  // Boot the chat session.
  const sessionOpts = {
    agent,
    display,
    commandRegistry,
    callbacks,
    sessionManager,
    auxiliaryClient,
    approvalEngine,
    mcpClient: mcpClient ?? undefined,
    skin,
    toolRegistry,
    skillLoader,
    resolver,
    config,
    initialProviderId: providerId,
    initialModelId: modelId,
    resumeSessionId,
    yoloMode: !!cliOpts.yolo,
  };

  if (cliOpts.tui) {
    await runTuiMode({
      sessionOpts: sessionOpts as any,
      skinName: config.getValue<string>('display.skin', 'default') ?? 'default',
    });
  } else {
    const session = new ChatSession(sessionOpts as any);
    await session.run();
  }
  if (mcpClient) await mcpClient.closeAll().catch(() => undefined);
  store.close?.();
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
