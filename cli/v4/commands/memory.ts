/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/memory.ts — v4.9.0 Slice 9.
 *
 * User-facing CLI for the existing `MemoryManager` + `MemoryGuard`. Does
 * NOT introduce a new memory engine; just exposes what's already there
 * with substrate-aware spans, atomic backups, and a `--json` surface.
 *
 *   aiden memory                                 alias for `list`
 *   aiden memory list                            both files + char counts
 *   aiden memory show <memory|user>              cat with line numbers
 *   aiden memory add <memory|user> "<text>"      append entry
 *   aiden memory remove <memory|user> --match "<substr>"  remove first match
 *   aiden memory backup                          snapshot to memory-backups/<ts>/
 *   aiden memory restore <timestamp>             restore from snapshot
 *   aiden memory edit <memory|user>              print path (user opens in editor)
 *   aiden memory diff                            current vs most-recent backup
 *
 * Flags: `--json` (machine-parseable) ; `--yes` (skip confirms).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { resolveAidenPaths } from '../../../core/v4/paths';
import {
  MemoryManager,
  MEMORY_CHAR_LIMIT,
  USER_CHAR_LIMIT,
  ENTRY_SEPARATOR,
  type MemoryFile,
} from '../../../core/v4/memoryManager';
import { MemoryGuard } from '../../../moat/memoryGuard';
import {
  runWithContext,
  newRunId,
  newTraceId,
  newSpanId,
  newMemoryId,
  type ExecutionContext,
} from '../../../core/v4/identity';
import { withSpan } from '../../../core/v4/daemon/spans/spanHelpers';
import { getCurrentDaemonDb, getCurrentDaemonId, getCurrentIncarnationId } from '../../../core/v4/daemon/bootstrap';

export interface MemoryCliOptions {
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const noopOut = (s: string): void => { process.stdout.write(s); };
const noopErr = (s: string): void => { process.stderr.write(s); };

/** Validate the `<memory|user>` positional. */
function parseFile(raw: string | undefined): MemoryFile | null {
  if (raw === 'memory' || raw === 'user') return raw;
  return null;
}

function limitFor(f: MemoryFile): number {
  return f === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

/** Build a minimal ExecutionContext for a one-shot CLI invocation. */
function buildCliCtx(opName: string): ExecutionContext {
  return {
    daemonId:      getCurrentDaemonId()      ?? 'dmn_cli_oneshot00000000000000000000',
    incarnationId: getCurrentIncarnationId() ?? 'inc_cli_oneshot00000000000000000000',
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'cli',
    attempt:       1,
    baggage:       { op: opName },
  };
}

/** Wrap a memory mutation in a span; return the span_id (`mem_...` synonym). */
async function withMemorySpan<T>(
  ctx:      ExecutionContext,
  opName:   string,
  file:     MemoryFile,
  fn:       (memoryId: string) => Promise<T>,
): Promise<{ memoryId: string; value: T }> {
  const memoryId = newMemoryId();
  const db = getCurrentDaemonDb();
  if (!db) {
    // Daemon not booted (common for one-shot CLI). Skip the span and
    // still return the mem_ id so the response shape is stable.
    const value = await fn(memoryId);
    return { memoryId, value };
  }
  const value = await runWithContext(ctx, () => withSpan(
    db,
    { kind: 'memory', name: `memory_${opName}`, attrs: { file, memory_id: memoryId } },
    async () => fn(memoryId),
  ));
  return { memoryId, value };
}

interface RunMemoryCliOptions extends MemoryCliOptions {
  /** Override the aiden root (tests). */
  rootDir?: string;
}

/** Entry — `aiden memory <action> [args...]`. Returns desired process exit. */
export async function runMemorySubcommand(
  action: string,
  args:   string[],
  opts:   RunMemoryCliOptions = {},
): Promise<number> {
  const out  = opts.writeOut ?? noopOut;
  const err  = opts.writeErr ?? noopErr;
  const json = args.includes('--json');
  const yes  = args.includes('--yes');
  // Strip flags from positional args.
  const positional = args.filter((a) => !a.startsWith('--'));

  const paths = resolveAidenPaths(opts.rootDir ? { rootOverride: opts.rootDir } : {});
  const mgr   = new MemoryManager(paths);
  const guard = new MemoryGuard(mgr);

  const effective = action || 'list';

  switch (effective) {
    case 'list':     return cmdList(mgr, paths, out, json);
    case 'show':     return cmdShow(positional[0], paths, out, err, json);
    case 'add':      return cmdAdd(positional[0], positional[1], guard, mgr, paths, out, err, json);
    case 'remove':   return cmdRemove(positional[0], args, guard, out, err, json);
    case 'edit':     return cmdEdit(positional[0], paths, out, err);
    case 'backup':   return cmdBackup(paths, out, err, json);
    case 'restore':  return cmdRestore(positional[0], paths, out, err, json, yes);
    case 'diff':     return cmdDiff(paths, out, err);
    case '--help':
    case 'help':     return cmdHelp(out);
    default:
      err(`Unknown memory action: ${effective}\n`);
      cmdHelp(err);
      return 2;
  }
}

function cmdHelp(write: (s: string) => void): number {
  write(
    'Usage: aiden memory <action> [args...] [--json] [--yes]\n\n' +
    'Manage Aiden\'s MEMORY.md (~2200 chars) and USER.md (~1375 chars).\n\n' +
    'Actions:\n' +
    '  list                                 Show both files with char counts (default).\n' +
    '  show <memory|user>                   Cat the file with line numbers.\n' +
    '  add <memory|user> "<text>"           Append an entry (MemoryGuard verified).\n' +
    '  remove <memory|user> --match "<s>"   Remove the unique entry containing <s>.\n' +
    '  edit <memory|user>                   Print path so you can open in $EDITOR.\n' +
    '  backup                               Snapshot both files to memory-backups/<ts>/.\n' +
    '  restore <timestamp>                  Restore both files from a snapshot.\n' +
    '  diff                                 Diff current state against latest backup.\n',
  );
  return 0;
}

async function cmdList(
  mgr:   MemoryManager,
  paths: import('../../../core/v4/paths').AidenPaths,
  out:   (s: string) => void,
  json:  boolean,
): Promise<number> {
  const snap = await mgr.loadSnapshot();
  if (json) {
    out(JSON.stringify({
      memory: { path: paths.memoryMd, chars: snap.memoryMd.length, limit: MEMORY_CHAR_LIMIT, entries: splitEntries(snap.memoryMd) },
      user:   { path: paths.userMd,   chars: snap.userMd.length,   limit: USER_CHAR_LIMIT,   entries: splitEntries(snap.userMd) },
    }, null, 2) + '\n');
    return 0;
  }
  out(`memory: ${snap.memoryMd.length} / ${MEMORY_CHAR_LIMIT} chars  (${paths.memoryMd})\n`);
  out(`user:   ${snap.userMd.length} / ${USER_CHAR_LIMIT} chars  (${paths.userMd})\n`);
  const mEntries = splitEntries(snap.memoryMd);
  const uEntries = splitEntries(snap.userMd);
  if (mEntries.length > 0) {
    out(`\n--- memory ---\n`);
    mEntries.forEach((e, i) => out(`  ${i + 1}. ${e}\n`));
  }
  if (uEntries.length > 0) {
    out(`\n--- user ---\n`);
    uEntries.forEach((e, i) => out(`  ${i + 1}. ${e}\n`));
  }
  return 0;
}

async function cmdShow(
  fileRaw: string | undefined,
  paths:   import('../../../core/v4/paths').AidenPaths,
  out:     (s: string) => void,
  err:     (s: string) => void,
  json:    boolean,
): Promise<number> {
  const file = parseFile(fileRaw);
  if (!file) { err('show: pass `memory` or `user`\n'); return 2; }
  const target = file === 'user' ? paths.userMd : paths.memoryMd;
  let text = '';
  try { text = await fs.readFile(target, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (json) { out(JSON.stringify({ file, path: target, content: text }, null, 2) + '\n'); return 0; }
  out(`# ${target}\n`);
  text.split('\n').forEach((line, i) => out(`${String(i + 1).padStart(4, ' ')} | ${line}\n`));
  return 0;
}

async function cmdAdd(
  fileRaw: string | undefined,
  content: string | undefined,
  guard:   MemoryGuard,
  mgr:     MemoryManager,
  paths:   import('../../../core/v4/paths').AidenPaths,
  out:     (s: string) => void,
  err:     (s: string) => void,
  json:    boolean,
): Promise<number> {
  const file = parseFile(fileRaw);
  if (!file)   { err('add: pass `memory` or `user`\n'); return 2; }
  if (!content) { err('add: missing entry text\n'); return 2; }
  const ctx = buildCliCtx('memory_add');
  // Ensure parent dir exists (first-run convenience).
  await fs.mkdir(path.dirname(file === 'user' ? paths.userMd : paths.memoryMd), { recursive: true });
  const { memoryId, value: result } = await withMemorySpan(ctx, 'add', file, async () => guard.guardedAdd(file, content));
  if (!result.ok || !result.verified) {
    if (json) { out(JSON.stringify({ ok: false, reason: result.reason, mem_id: memoryId }) + '\n'); }
    else      { err(`add failed: ${result.reason ?? 'unknown'}\n`); }
    return 1;
  }
  const snap = await mgr.loadSnapshot();
  const len  = (file === 'user' ? snap.userMd : snap.memoryMd).length;
  if (json) { out(JSON.stringify({ ok: true, file, mem_id: memoryId, chars: len, limit: limitFor(file) }) + '\n'); }
  else      { out(`added to ${file} (now ${len} / ${limitFor(file)} chars)  mem_id=${memoryId}\n`); }
  return 0;
}

async function cmdRemove(
  fileRaw: string | undefined,
  args:    string[],
  guard:   MemoryGuard,
  out:     (s: string) => void,
  err:     (s: string) => void,
  json:    boolean,
): Promise<number> {
  const file = parseFile(fileRaw);
  if (!file) { err('remove: pass `memory` or `user`\n'); return 2; }
  const matchIdx = args.findIndex((a) => a === '--match');
  if (matchIdx < 0 || matchIdx + 1 >= args.length) {
    err('remove: pass --match "<substring>"\n');
    return 2;
  }
  const target = args[matchIdx + 1];
  const ctx = buildCliCtx('memory_remove');
  const { memoryId, value: result } = await withMemorySpan(ctx, 'remove', file, async () => guard.guardedRemove(file, target));
  if (!result.ok || !result.verified) {
    if (json) { out(JSON.stringify({ ok: false, reason: result.reason, mem_id: memoryId }) + '\n'); }
    else      { err(`remove failed: ${result.reason ?? 'unknown'}\n`); }
    return 1;
  }
  if (json) { out(JSON.stringify({ ok: true, file, mem_id: memoryId, match: target }) + '\n'); }
  else      { out(`removed entry containing "${target}" from ${file}  mem_id=${memoryId}\n`); }
  return 0;
}

async function cmdEdit(
  fileRaw: string | undefined,
  paths:   import('../../../core/v4/paths').AidenPaths,
  out:     (s: string) => void,
  err:     (s: string) => void,
): Promise<number> {
  const file = parseFile(fileRaw);
  if (!file) { err('edit: pass `memory` or `user`\n'); return 2; }
  const target = file === 'user' ? paths.userMd : paths.memoryMd;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.access(target); }
  catch { await fs.writeFile(target, '', 'utf8'); }
  out(`${target}\n`);
  return 0;
}

interface BackupManifest {
  timestamp:      string;
  daemonId:       string | null;
  incarnationId: string | null;
  spanId:         string;
  files:          Array<{ name: string; bytes: number; sha256: string }>;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function cmdBackup(
  paths: import('../../../core/v4/paths').AidenPaths,
  out:   (s: string) => void,
  _err:  (s: string) => void,
  json:  boolean,
): Promise<number> {
  const ctx = buildCliCtx('memory_backup');
  const stamp = ts();
  const dir = path.join(paths.memoryBackupsDir, stamp);
  await fs.mkdir(dir, { recursive: true });
  const memText = await fs.readFile(paths.memoryMd, 'utf8').catch(() => '');
  const usrText = await fs.readFile(paths.userMd,   'utf8').catch(() => '');
  const { memoryId } = await withMemorySpan(ctx, 'backup', 'memory', async () => {
    await fs.writeFile(path.join(dir, 'memory.md'), memText, 'utf8');
    await fs.writeFile(path.join(dir, 'user.md'),   usrText, 'utf8');
    return null;
  });
  const manifest: BackupManifest = {
    timestamp:    stamp,
    daemonId:     getCurrentDaemonId(),
    incarnationId: getCurrentIncarnationId(),
    spanId:       memoryId,
    files: [
      { name: 'memory.md', bytes: Buffer.byteLength(memText, 'utf8'), sha256: sha256(memText) },
      { name: 'user.md',   bytes: Buffer.byteLength(usrText, 'utf8'), sha256: sha256(usrText) },
    ],
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (json) { out(JSON.stringify({ ok: true, dir, manifest }, null, 2) + '\n'); }
  else      { out(`backup: ${dir}\n  memory.md: ${manifest.files[0].bytes} B\n  user.md:   ${manifest.files[1].bytes} B\n  mem_id=${memoryId}\n`); }
  return 0;
}

async function cmdRestore(
  stampRaw: string | undefined,
  paths:    import('../../../core/v4/paths').AidenPaths,
  out:      (s: string) => void,
  err:      (s: string) => void,
  json:     boolean,
  _yes:     boolean,
): Promise<number> {
  if (!stampRaw) { err('restore: pass <timestamp> (use `aiden memory backup` first, then `ls memory-backups/`)\n'); return 2; }
  const dir = path.join(paths.memoryBackupsDir, stampRaw);
  try { await fs.access(dir); }
  catch { err(`restore: backup not found: ${dir}\n`); return 1; }
  const ctx = buildCliCtx('memory_restore');
  const memBackup = await fs.readFile(path.join(dir, 'memory.md'), 'utf8');
  const usrBackup = await fs.readFile(path.join(dir, 'user.md'),   'utf8');
  await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
  const { memoryId } = await withMemorySpan(ctx, 'restore', 'memory', async () => {
    await fs.writeFile(paths.memoryMd, memBackup, 'utf8');
    await fs.writeFile(paths.userMd,   usrBackup, 'utf8');
    return null;
  });
  if (json) { out(JSON.stringify({ ok: true, restored_from: dir, mem_id: memoryId }) + '\n'); }
  else      { out(`restored from ${dir}\n  memory.md: ${memBackup.length} chars\n  user.md:   ${usrBackup.length} chars\n  mem_id=${memoryId}\n`); }
  return 0;
}

async function cmdDiff(
  paths: import('../../../core/v4/paths').AidenPaths,
  out:   (s: string) => void,
  err:   (s: string) => void,
): Promise<number> {
  let entries: string[];
  try { entries = await fs.readdir(paths.memoryBackupsDir); }
  catch { err('diff: no backups exist yet (run `aiden memory backup` first)\n'); return 1; }
  const sorted = entries.filter((e) => /^\d{8}-\d{6}$/.test(e)).sort();
  if (sorted.length === 0) { err('diff: no backups found\n'); return 1; }
  const latest = sorted[sorted.length - 1];
  const dir = path.join(paths.memoryBackupsDir, latest);
  const memBefore = await fs.readFile(path.join(dir, 'memory.md'), 'utf8').catch(() => '');
  const usrBefore = await fs.readFile(path.join(dir, 'user.md'),   'utf8').catch(() => '');
  const memNow    = await fs.readFile(paths.memoryMd, 'utf8').catch(() => '');
  const usrNow    = await fs.readFile(paths.userMd,   'utf8').catch(() => '');
  out(`diff vs backup ${latest}\n`);
  out(diffSummary('memory.md', memBefore, memNow));
  out(diffSummary('user.md',   usrBefore, usrNow));
  return 0;
}

function diffSummary(label: string, before: string, after: string): string {
  if (before === after) return `  ${label}: unchanged\n`;
  const b = splitEntries(before), a = splitEntries(after);
  const bs = new Set(b), as = new Set(a);
  const added   = a.filter((e) => !bs.has(e));
  const removed = b.filter((e) => !as.has(e));
  let s = `  ${label}: ${added.length} added, ${removed.length} removed\n`;
  for (const e of added)   s += `    + ${e}\n`;
  for (const e of removed) s += `    - ${e}\n`;
  return s;
}

function splitEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(ENTRY_SEPARATOR).map((e) => e.trim()).filter((e) => e.length > 0);
}
