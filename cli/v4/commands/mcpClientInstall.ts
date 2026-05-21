/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/mcpClientInstall.ts — v4.9.0 Slice 2a.
 *
 * Handlers for `aiden mcp init|doctor|repair <client>`. Pure user-
 * facing orchestration over the install primitives in
 * `core/v4/mcp/install/`.
 */

import { existsSync, readFileSync, copyFileSync } from 'node:fs';

import {
  resolveClientPath,
  type ClientId,
} from '../../../core/v4/mcp/install/clientPaths';
import {
  installClient,
  planInstall,
  readClient,
} from '../../../core/v4/mcp/install/clients';
import {
  buildAidenEntryObject,
} from '../../../core/v4/mcp/install/jsoncMerge';
import { detectWsl, buildAidenEntry } from '../../../core/v4/mcp/install/wslDetect';
import { countBackups, findLatestBackup } from '../../../core/v4/mcp/install/backup';
import { runHealthCheck } from '../../../core/v4/mcp/install/healthCheck';

export interface IO {
  writeOut: (t: string) => void;
  writeErr: (t: string) => void;
}

const SUPPORTED: ReadonlySet<string> = new Set(['claude', 'cursor']);

function isClientId(s: string | undefined): s is ClientId {
  return typeof s === 'string' && SUPPORTED.has(s);
}

function usage(io: IO, action: string): number {
  io.writeErr(`Usage: aiden mcp ${action} <client> [--dry-run] [--print-snippet] [--yes]\n`);
  io.writeErr(`Supported clients: ${Array.from(SUPPORTED).join(', ')}\n`);
  return 1;
}

export async function runClientCommand(
  action:    'init' | 'doctor' | 'repair',
  client:    string | undefined,
  extraArgs: string[],
  io:        IO,
): Promise<number> {
  if (!isClientId(client)) return usage(io, action);
  const dryRun       = extraArgs.includes('--dry-run');
  const printSnippet = extraArgs.includes('--print-snippet');
  const yes          = extraArgs.includes('--yes');

  if (action === 'init')   return doInit(client,   io, { dryRun, printSnippet, yes });
  if (action === 'doctor') return doDoctor(client, io);
  return doRepair(client, io, { yes });
}

interface InitOpts { dryRun: boolean; printSnippet: boolean; yes: boolean }

async function doInit(client: ClientId, io: IO, opts: InitOpts): Promise<number> {
  const wsl     = detectWsl();
  const entry   = buildAidenEntry({ wsl, target: wsl.inWsl ? 'host' : undefined });
  const planned = planInstall(client, { command: entry.command, args: entry.args });
  if (!planned) {
    io.writeErr(`Could not resolve config path for ${client}.\n`);
    return 1;
  }

  if (opts.printSnippet) {
    // Emit just the Aiden entry as a JSON blob the user can paste.
    const obj = buildAidenEntryObject({ command: entry.command, args: entry.args });
    io.writeOut(JSON.stringify({ mcpServers: { aiden: obj } }, null, 2) + '\n');
    return 0;
  }

  if (planned.parentMissing) {
    // v4.9.0 Slice 2a hotfix #1 — clearer diagnostic. If the user
    // believes the client IS installed (file is right there in
    // Explorer / Finder), the most likely cause is that they're
    // running an older `aiden` bin from npm that doesn't have these
    // commands at all — globally-installed aiden-runtime predates
    // v4.9.0. Surface that hypothesis explicitly so they don't chase
    // a phantom path-detection bug.
    io.writeErr(
      `${planned.resolution.displayName} doesn't appear to be installed.\n` +
      `Expected parent dir: ${planned.resolution.parentDir}\n` +
      `Install ${planned.resolution.displayName} first, or run with --print-snippet to copy the entry manually.\n` +
      `\n` +
      `If you're sure the client IS installed and you see this error,\n` +
      `check that your \`aiden\` bin is the current dev build (not a\n` +
      `published version): run \`which aiden\` (POSIX) or \`where aiden\`\n` +
      `(Windows) and verify the resolved path matches your local repo.\n`,
    );
    return 1;
  }

  if (opts.dryRun) {
    io.writeOut(`[dry-run] Would write to: ${planned.resolution.configPath}\n`);
    io.writeOut(`[dry-run] New content (${planned.resolution.format}):\n`);
    io.writeOut(planned.newText);
    return 0;
  }

  if (!opts.yes) {
    io.writeOut(`About to write Aiden's MCP entry to:\n  ${planned.resolution.configPath}\n`);
    io.writeOut(`A timestamped backup will be created first. Continue? [Y/n]\n`);
    // Best-effort confirmation: non-TTY callers (CI, npx) implicitly
    // pass --yes; interactive callers can answer at the prompt below.
    if (process.stdin.isTTY) {
      const answer = await readOneLine();
      if (answer && /^n/i.test(answer)) {
        io.writeOut('Aborted.\n');
        return 0;
      }
    }
  }

  const result = installClient(client, { command: entry.command, args: entry.args });
  if (result.outcome === 'error') {
    io.writeErr(`Install failed: ${result.error}\n`);
    return 1;
  }
  if (result.outcome === 'noop') {
    io.writeOut(`${planned.resolution.displayName}: Aiden entry already up to date.\n`);
    return 0;
  }
  io.writeOut(`✓ Wrote Aiden entry to ${result.configPath}\n`);
  if (result.backupPath) {
    io.writeOut(`  Backup: ${result.backupPath}\n`);
  }

  // Connection health check — spawn the wired command + parse JSON.
  io.writeOut('Running health check…\n');
  const health = await runHealthCheck({ command: entry.command, args: entry.args });
  if (health.ok) {
    io.writeOut(`✓ Health check ok — ${health.tools ?? '?'} tools exposed, build ${health.version ?? '?'}\n`);
  } else {
    io.writeOut(`⚠ Health check failed: ${health.error}\n`);
    io.writeOut(`  The entry is written; you can retry with /aiden mcp doctor ${client}.\n`);
  }

  // Restart guidance.
  io.writeOut(`\nRestart ${planned.resolution.displayName} to load Aiden as an MCP server.\n`);
  if (client === 'cursor') {
    io.writeOut('  (In Cursor: Developer → Reload Window also picks up the change.)\n');
  }
  return 0;
}

async function doDoctor(client: ClientId, io: IO): Promise<number> {
  const { resolution, entry, exists, text } = readClient(client);
  io.writeOut(`${resolution.displayName} MCP diagnosis\n`);
  io.writeOut(`  Config path:  ${resolution.configPath}\n`);

  if (!exists) {
    io.writeOut(`  ✗ Config file does not exist.\n`);
    io.writeOut(`    Hint: run "aiden mcp init ${client}" to create it.\n`);
    return 1;
  }
  io.writeOut(`  ✓ Config file exists\n`);

  // Validate JSON / JSONC parses.
  let parseOk = false;
  try {
    if (resolution.format === 'json') JSON.parse(text ?? '');
    // jsonc-parser tolerates everything; only plain-JSON.parse can fail
    parseOk = true;
  } catch (err) {
    io.writeOut(`  ✗ Config is malformed: ${(err as Error).message}\n`);
    const latest = findLatestBackup(resolution.configPath);
    if (latest) {
      io.writeOut(`    Latest backup: ${latest}\n`);
      io.writeOut(`    Hint: aiden mcp repair ${client}  — restores from the latest backup.\n`);
    }
    return 1;
  }
  if (parseOk) io.writeOut(`  ✓ Config parses cleanly\n`);

  if (!entry) {
    io.writeOut(`  ✗ Aiden entry missing under mcpServers.aiden\n`);
    io.writeOut(`    Hint: aiden mcp init ${client}\n`);
    return 1;
  }
  io.writeOut(`  ✓ Aiden entry present\n`);

  const wsl       = detectWsl();
  const expected  = buildAidenEntry({ wsl, target: wsl.inWsl ? 'host' : undefined });
  const cmdOk     = entry.command === expected.command;
  const argsOk    = JSON.stringify(entry.args) === JSON.stringify(expected.args);
  io.writeOut(`  ${cmdOk ? '✓' : '✗'} command: ${entry.command} (expected ${expected.command})\n`);
  io.writeOut(`  ${argsOk ? '✓' : '✗'} args:    ${JSON.stringify(entry.args)} (expected ${JSON.stringify(expected.args)})\n`);

  const managed = entry._aiden?.managed === true;
  io.writeOut(`  ${managed ? '✓' : '⚠'} Managed by Aiden: ${managed ? 'yes' : 'no — entry exists but was authored externally'}\n`);

  io.writeOut(`  Backups: ${countBackups(resolution.configPath)} file(s)\n`);

  // Health check.
  const health = await runHealthCheck({ command: entry.command, args: entry.args });
  if (health.ok) {
    io.writeOut(`  ✓ Health check: ${health.tools ?? '?'} tools, build ${health.version ?? '?'}\n`);
  } else {
    io.writeOut(`  ✗ Health check: ${health.error}\n`);
  }

  const allGood = cmdOk && argsOk && managed && health.ok;
  return allGood ? 0 : 1;
}

async function doRepair(client: ClientId, io: IO, opts: { yes: boolean }): Promise<number> {
  const { resolution, entry, exists, text } = readClient(client);
  if (!exists) {
    io.writeOut(`${resolution.displayName}: config doesn't exist. Running init instead.\n`);
    return doInit(client, io, { dryRun: false, printSnippet: false, yes: opts.yes });
  }

  // Try to parse the config; if it's broken, offer a restore.
  let parseOk = true;
  if (resolution.format === 'json') {
    try { JSON.parse(text ?? ''); } catch { parseOk = false; }
  }
  if (!parseOk) {
    const latest = findLatestBackup(resolution.configPath);
    if (!latest) {
      io.writeErr(`Config is malformed and no backup is available. Aborting.\n`);
      return 1;
    }
    io.writeOut(`Config is malformed. Restoring from backup: ${latest}\n`);
    try {
      copyFileSync(latest, resolution.configPath);
    } catch (err) {
      io.writeErr(`Restore failed: ${(err as Error).message}\n`);
      return 1;
    }
    io.writeOut(`✓ Restored. Re-running init to ensure Aiden entry is present.\n`);
    return doInit(client, io, { dryRun: false, printSnippet: false, yes: true });
  }

  const wsl      = detectWsl();
  const expected = buildAidenEntry({ wsl, target: wsl.inWsl ? 'host' : undefined });
  const cmdOk    = entry?.command === expected.command;
  const argsOk   = JSON.stringify(entry?.args) === JSON.stringify(expected.args);
  if (entry && cmdOk && argsOk) {
    io.writeOut(`${resolution.displayName}: entry already correct, nothing to repair.\n`);
    return 0;
  }
  io.writeOut(`${resolution.displayName}: updating stale entry to current values.\n`);
  return doInit(client, io, { dryRun: false, printSnippet: false, yes: true });
}

/** Read one line from stdin. Best-effort; tolerates non-TTY callers. */
function readOneLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      if (buf.includes('\n')) {
        process.stdin.removeListener('data', onData);
        resolve(buf.split('\n')[0].trim());
      }
    };
    process.stdin.on('data', onData);
  });
}

// Re-export for tests.
export {
  resolveClientPath,
  readClient,
  planInstall,
  installClient,
  buildAidenEntry,
  detectWsl,
  countBackups,
  findLatestBackup,
  runHealthCheck,
};

// Silence unused-import lint when only used as type.
void readFileSync;
void existsSync;
