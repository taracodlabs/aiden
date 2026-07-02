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
// v4.9.0 Slice 11 — namespace registry + project root detection.
import {
  listNamespaces,
  listNamespaceNames,
  hasNamespace,
  getNamespace,
} from '../../../core/v4/memory/namespaceRegistry';
import { findProjectRoot } from '../../../core/v4/memory/projectRoot';
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

/**
 * v4.9.0 Slice 11 — validate against the dynamic namespace registry
 * rather than the hard-coded `'memory' | 'user'` pair. Return type
 * widened to `string` so the caller can pass any registered name
 * through MemoryManager / MemoryGuard (whose method signatures were
 * widened in the same slice).
 */
function parseFile(raw: string | undefined): string | null {
  if (!raw) return null;
  return hasNamespace(raw) ? raw : null;
}

function limitFor(f: string): number {
  if (hasNamespace(f)) return getNamespace(f).charLimit;
  // Defensive fallback — should never hit in practice.
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

/** Wrap a memory mutation in a span; return the span_id (`mem_...` synonym).
 *  v4.9.0 Slice 11 — `file` widened to `string` to accept any namespace. */
async function withMemorySpan<T>(
  ctx:      ExecutionContext,
  opName:   string,
  file:     string,
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
  /**
   * v4.9.0 Slice 10 — injectable LLM callback for the reviewer. When
   * absent, `review --now` reports "no LLM configured" instead of
   * routing through a real provider. The CLI binding (aidenCLI.ts)
   * wires a real provider callback in production; tests pass a stub.
   */
  reviewerCallLLM?: (prompt: string) => Promise<string>;
  /**
   * v4.9.0 Slice 10 — injectable recent-turns supplier. When absent,
   * `review --now` reports "no session context". The CLI binding
   * wires the active session's last N messages; tests pass a stub.
   */
  reviewerRecentTurns?: () => Promise<Array<{ role: string; content: string }>>;
  /**
   * v4.9.0 Slice 10 — override the loaded config (tests). When absent,
   * the CLI loads config.yaml via the standard ConfigProvider.
   */
  reviewerConfig?: {
    enabled?:        boolean;
    mode?:           'off' | 'on_quit' | 'every_n_turns';
    timeoutMs?:      number;
    maxCandidates?:  number;
  };
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
  // v4.9.0 Slice 11 — detect project root from cwd so the `project`
  // namespace can resolve its file path. `null` is fine — the
  // namespace's resolver throws on access, the CLI catches + surfaces
  // a helpful message instead of routing the error to the user.
  const projectRoot = findProjectRoot(process.cwd());
  const mgr   = new MemoryManager({ paths, projectRoot });
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
    // v4.9.0 Slice 10 — post-turn reviewer surface.
    case 'namespaces': return cmdNamespaces(paths, projectRoot, out, json);
    case 'pending':  return cmdPending(paths, out, json);
    case 'approve':  return cmdApprove(positional[0], args, paths, guard, mgr, out, err, json);
    case 'reject':   return cmdReject(positional[0], args, paths, out, err, json);
    case 'review':   return cmdReview(args, paths, opts, out, err, json);
    // v4.11 Obsidian vault mirror — `/memory vault link <path>` +
    // `/memory vault status` + `/memory vault sync`. Pure side-channel:
    // never touches the memory write path. positional[0] is the sub-op.
    case 'vault':    return cmdVault(positional, paths, projectRoot, out, err, json);
    case '--help':
    case 'help':     return cmdHelp(out);
    default: {
      err(`Unknown memory action: ${effective}\n`);
      const { closestAction } = await import('../util/closestAction');
      const m = closestAction(effective, ['list','show','add','remove','edit','backup','restore','diff','namespaces','pending','approve','reject','review']);
      if (m) err(`Did you mean: ${m}?\n\n`);
      cmdHelp(err);
      return 2;
    }
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
    '  diff                                 Diff current state against latest backup.\n' +
    '  namespaces                           List registered memory namespaces.\n' +
    '  pending                              List candidates from `## Pending review` blocks.\n' +
    '  approve <mem_id> | --all             Promote a pending candidate to a live entry.\n' +
    '  reject <mem_id> | --all              Discard a pending candidate (logged).\n' +
    '  review --now | --status              Run / inspect the post-turn memory reviewer.\n' +
    '  vault link <path>                    Persist agent.vault_path (Obsidian-compatible mirror).\n' +
    '  vault status                         Show resolved vault path + source (env|config|unset).\n' +
    '  vault sync                           One-shot full export to the configured vault now.\n',
  );
  return 0;
}

async function cmdList(
  mgr:   MemoryManager,
  paths: import('../../../core/v4/paths').AidenPaths,
  out:   (s: string) => void,
  json:  boolean,
): Promise<number> {
  // v4.9.0 Slice 11 — iterate every registered namespace via the
  // snapshot's `files` map. Namespaces requiring a project root (e.g.
  // `project`) that aren't reachable from cwd are silently absent —
  // matches `loadSnapshot` behaviour.
  const snap = await mgr.loadSnapshot();
  const files = snap.files ?? {};
  if (json) {
    const payload: Record<string, unknown> = {};
    for (const ns of listNamespaces()) {
      const f = files[ns.name];
      if (!f) continue;
      payload[ns.name] = { path: f.path, chars: f.charCount, limit: f.charLimit, entries: splitEntries(f.content) };
    }
    out(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }
  // Human format: one summary line per available namespace. Slice 9
  // formatted as "memory: ...", "user:   ..." with the value column
  // at offset 8. Match that, with min 1 space for longer names.
  for (const ns of listNamespaces()) {
    const f = files[ns.name];
    if (!f) continue;
    const pad = ' '.repeat(Math.max(1, 8 - (ns.name.length + 1)));
    out(`${ns.name}:${pad}${f.charCount} / ${f.charLimit} chars  (${f.path})\n`);
  }
  for (const ns of listNamespaces()) {
    const f = files[ns.name];
    if (!f) continue;
    const entries = splitEntries(f.content);
    if (entries.length > 0) {
      out(`\n--- ${ns.name} ---\n`);
      entries.forEach((e, i) => out(`  ${i + 1}. ${e}\n`));
    }
  }
  return 0;
}

async function cmdNamespaces(
  paths:       import('../../../core/v4/paths').AidenPaths,
  projectRoot: string | null,
  out:         (s: string) => void,
  json:        boolean,
): Promise<number> {
  const rows = listNamespaces().map((ns) => {
    let resolvedPath: string | null = null;
    let available = true;
    let reason: string | undefined;
    try { resolvedPath = ns.resolve(paths, projectRoot); }
    catch (e) {
      available = false;
      reason = e instanceof Error ? e.message : String(e);
    }
    return {
      name: ns.name, label: ns.label, description: ns.description,
      charLimit: ns.charLimit, requiresProject: !!ns.requiresProject,
      injectIntoPrompt: ns.injectIntoPrompt, available, path: resolvedPath, reason,
    };
  });
  if (json) {
    out(JSON.stringify({ projectRoot, namespaces: rows }, null, 2) + '\n');
    return 0;
  }
  out(`project root: ${projectRoot ?? '(none detected)'}\n\n`);
  for (const r of rows) {
    const status = r.available ? `ok   path=${r.path}` : `requires project root — ${r.reason}`;
    out(`  ${r.name.padEnd(8)} (${r.charLimit} chars)  ${status}\n    ${r.description}\n`);
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
  // v4.9.0 Slice 11 — resolve via registry (supports project namespace).
  let target: string;
  try { target = getNamespace(file).resolve(paths, findProjectRoot(process.cwd())); }
  catch (e) { err(`${file}: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
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
  // v4.9.0 Slice 11 — ensure parent dir exists via registry-resolved path.
  let nsPath: string;
  try { nsPath = getNamespace(file).resolve(paths, findProjectRoot(process.cwd())); }
  catch (e) { err(`${file}: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
  await fs.mkdir(path.dirname(nsPath), { recursive: true });
  const { memoryId, value: result } = await withMemorySpan(ctx, 'add', file, async () => guard.guardedAdd(file, content));
  if (!result.ok || !result.verified) {
    if (json) { out(JSON.stringify({ ok: false, reason: result.reason, mem_id: memoryId }) + '\n'); }
    else      { err(`add failed: ${result.reason ?? 'unknown'}\n`); }
    return 1;
  }
  const snap = await mgr.loadSnapshot();
  // v4.9.0 Slice 11 — read post-write length from the generalized
  // files map (`memory`/`user` keys still populated for back-compat).
  const len  = (snap.files?.[file]?.content
    ?? (file === 'user' ? snap.userMd : snap.memoryMd) ?? '').length;
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
  // v4.9.0 Slice 11 — resolve via registry (supports project namespace).
  let target: string;
  try { target = getNamespace(file).resolve(paths, findProjectRoot(process.cwd())); }
  catch (e) { err(`${file}: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
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
  // v4.9.0 Slice 11 — snapshot every reachable namespace.
  const projectRoot = findProjectRoot(process.cwd());
  const snapshots: Array<{ name: string; bytes: number; sha256: string }> = [];
  const { memoryId } = await withMemorySpan(ctx, 'backup', 'memory', async () => {
    for (const ns of listNamespaces()) {
      let srcPath: string;
      try { srcPath = ns.resolve(paths, projectRoot); }
      catch { continue;  /* requiresProject + no root → skip */ }
      const text = await fs.readFile(srcPath, 'utf8').catch(() => '');
      const outName = `${ns.name}.md`;
      await fs.writeFile(path.join(dir, outName), text, 'utf8');
      snapshots.push({ name: outName, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) });
    }
    return null;
  });
  const manifest: BackupManifest = {
    timestamp:    stamp,
    daemonId:     getCurrentDaemonId(),
    incarnationId: getCurrentIncarnationId(),
    spanId:       memoryId,
    files:        snapshots,
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (json) { out(JSON.stringify({ ok: true, dir, manifest }, null, 2) + '\n'); }
  else {
    out(`backup: ${dir}\n`);
    for (const f of manifest.files) out(`  ${f.name.padEnd(12)} ${f.bytes} B\n`);
    out(`  mem_id=${memoryId}\n`);
  }
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
  // v4.9.0 Slice 11 — restore every namespace file that exists in the
  // backup. Namespace files missing from the backup are skipped (not
  // an error — older snapshots may pre-date the namespace).
  const projectRoot = findProjectRoot(process.cwd());
  const restored: Array<{ name: string; chars: number }> = [];
  const { memoryId } = await withMemorySpan(ctx, 'restore', 'memory', async () => {
    for (const ns of listNamespaces()) {
      let destPath: string;
      try { destPath = ns.resolve(paths, projectRoot); }
      catch { continue;  /* requiresProject + no root → skip */ }
      const src = path.join(dir, `${ns.name}.md`);
      const text = await fs.readFile(src, 'utf8').catch(() => null);
      if (text === null) continue;
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, text, 'utf8');
      restored.push({ name: ns.name, chars: text.length });
    }
    return null;
  });
  if (json) { out(JSON.stringify({ ok: true, restored_from: dir, restored, mem_id: memoryId }) + '\n'); }
  else {
    out(`restored from ${dir}\n`);
    for (const r of restored) out(`  ${r.name.padEnd(10)} ${r.chars} chars\n`);
    out(`  mem_id=${memoryId}\n`);
  }
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

// ── v4.9.0 Slice 10 — post-turn reviewer surface ────────────────────────

import { runReview } from '../../../core/v4/memory/reviewer';
import {
  listAllPending,
  dropCandidate,
  type PendingCandidate,
} from '../../../core/v4/memory/reviewer/pendingStore';

async function cmdPending(
  paths: import('../../../core/v4/paths').AidenPaths,
  out:   (s: string) => void,
  json:  boolean,
): Promise<number> {
  const pending = await listAllPending(paths.memoryMd, paths.userMd);
  if (json) {
    out(JSON.stringify({ pending }, null, 2) + '\n');
    return 0;
  }
  if (pending.length === 0) { out('no pending candidates\n'); return 0; }
  out(`${pending.length} pending candidate(s):\n`);
  for (const c of pending) {
    out(`  ${c.memId}  [${c.file}]  ${c.text}\n    ↳ ${c.rationale}  (proposed ${c.proposedAt})\n`);
  }
  return 0;
}

async function cmdApprove(
  memIdRaw: string | undefined,
  args:     string[],
  paths:    import('../../../core/v4/paths').AidenPaths,
  guard:    MemoryGuard,
  mgr:      MemoryManager,
  out:      (s: string) => void,
  err:      (s: string) => void,
  json:     boolean,
): Promise<number> {
  const all = args.includes('--all');
  const pending = await listAllPending(paths.memoryMd, paths.userMd);
  const targets: PendingCandidate[] = all
    ? pending
    : (memIdRaw ? pending.filter((c) => c.memId === memIdRaw) : []);
  if (targets.length === 0) {
    if (json) { out(JSON.stringify({ ok: false, reason: 'no_match' }) + '\n'); }
    else      { err('approve: no pending candidate matched (use `--all` for batch, or pass a mem_id)\n'); }
    return 1;
  }
  let approved = 0;
  void mgr;
  for (const c of targets) {
    const ctx = buildCliCtx('memory_approve');
    const filePath = c.file === 'user' ? paths.userMd : paths.memoryMd;
    // v4.9.0 Slice 10 — DROP the pending candidate row BEFORE calling
    // guardedAdd. Otherwise MemoryManager.add's substring-dedup sees
    // the candidate text inside the pending block and short-circuits
    // to `deduped: true` without appending a live entry.
    await dropCandidate(filePath, c.memId);
    await withMemorySpan(ctx, 'approve', c.file, async () => guard.guardedAdd(c.file, c.text));
    approved += 1;
  }
  if (json) { out(JSON.stringify({ ok: true, approved }) + '\n'); }
  else      { out(`approved ${approved} candidate(s)\n`); }
  return 0;
}

async function cmdReject(
  memIdRaw: string | undefined,
  args:     string[],
  paths:    import('../../../core/v4/paths').AidenPaths,
  out:      (s: string) => void,
  err:      (s: string) => void,
  json:     boolean,
): Promise<number> {
  const all = args.includes('--all');
  const pending = await listAllPending(paths.memoryMd, paths.userMd);
  const targets = all ? pending : (memIdRaw ? pending.filter((c) => c.memId === memIdRaw) : []);
  if (targets.length === 0) {
    if (json) { out(JSON.stringify({ ok: false, reason: 'no_match' }) + '\n'); }
    else      { err('reject: no pending candidate matched\n'); }
    return 1;
  }
  let rejected = 0;
  for (const c of targets) {
    const ctx = buildCliCtx('memory_reject');
    await withMemorySpan(ctx, 'reject', c.file, async () => {
      await dropCandidate(c.file === 'user' ? paths.userMd : paths.memoryMd, c.memId);
      return null;
    });
    rejected += 1;
  }
  if (json) { out(JSON.stringify({ ok: true, rejected }) + '\n'); }
  else      { out(`rejected ${rejected} candidate(s)\n`); }
  return 0;
}

async function cmdReview(
  args:  string[],
  paths: import('../../../core/v4/paths').AidenPaths,
  opts:  RunMemoryCliOptions,
  out:   (s: string) => void,
  err:   (s: string) => void,
  json:  boolean,
): Promise<number> {
  const cfg = {
    enabled:       opts.reviewerConfig?.enabled       ?? true,
    mode:          opts.reviewerConfig?.mode          ?? ('on_quit' as const),
    timeoutMs:     opts.reviewerConfig?.timeoutMs     ?? 30_000,
    maxCandidates: opts.reviewerConfig?.maxCandidates ?? 5,
  };

  if (args.includes('--status')) {
    if (json) { out(JSON.stringify({ enabled: cfg.enabled, mode: cfg.mode, last_review: null, pending: (await listAllPending(paths.memoryMd, paths.userMd)).length }, null, 2) + '\n'); }
    else {
      const pendingCount = (await listAllPending(paths.memoryMd, paths.userMd)).length;
      out(`review enabled: ${cfg.enabled}, mode: ${cfg.mode}, last review: never, pending: ${pendingCount}\n`);
    }
    return 0;
  }

  if (!args.includes('--now')) {
    err('review: pass --now to trigger a pass, or --status to inspect config\n');
    return 2;
  }

  if (!cfg.enabled || cfg.mode === 'off') {
    if (json) { out(JSON.stringify({ outcome: 'disabled', reason: cfg.mode === 'off' ? 'mode_off' : 'config_disabled' }) + '\n'); }
    else      { out('review disabled (config: memory.review.enabled=false or mode=off)\n'); }
    return 0;
  }

  if (!opts.reviewerCallLLM) {
    if (json) { out(JSON.stringify({ outcome: 'no_llm_configured' }) + '\n'); }
    else      { err('review --now: no LLM callback wired (the CLI binding must inject reviewerCallLLM)\n'); }
    return 1;
  }

  const recentTurns = opts.reviewerRecentTurns
    ? await opts.reviewerRecentTurns()
    : [];

  const liveMemoryRaw = await import('node:fs').then((m) => m.promises.readFile(paths.memoryMd, 'utf8').catch(() => ''));
  const liveUserRaw   = await import('node:fs').then((m) => m.promises.readFile(paths.userMd,   'utf8').catch(() => ''));

  // Wrap the review in a memory span so doctor / spans table track it.
  const ctx = buildCliCtx('memory_review');
  let outcome: import('../../../core/v4/memory/reviewer').ReviewOutcome | null = null;
  await withMemorySpan(ctx, 'review', 'memory', async () => {
    outcome = await runReview({
      recentTurns, liveMemoryRaw, liveUserRaw,
      memoryPath: paths.memoryMd, userPath: paths.userMd,
      // v4.9.0 Slice 11 — pass paths + projectRoot so the reviewer
      // can route `project`-namespace candidates to the right file
      // when a project root is detected.
      paths, projectRoot: findProjectRoot(process.cwd()),
      callLLM:        opts.reviewerCallLLM!,
      maxCandidates:  cfg.maxCandidates,
      timeoutMs:      cfg.timeoutMs,
      log: (level, msg) => {
        if (level === 'error') err(msg + '\n');
        else                   out(msg + '\n');
      },
    });
    return outcome;
  });

  if (json) {
    out(JSON.stringify(outcome, null, 2) + '\n');
  } else {
    const o = outcome!;
    if (o.outcome === 'ok') {
      out(`review ok: proposed=${o.candidatesProposed.length} duration=${o.durationMs}ms\n`);
      for (const c of o.candidatesProposed) {
        out(`  ${c.memId}  [${c.file}]  ${c.text}\n`);
      }
    } else if (o.outcome === 'timeout') {
      out(`review timed out after ${o.durationMs}ms (no candidates produced — user unaffected)\n`);
    } else if (o.outcome === 'error') {
      out(`review error (fail-open): ${o.error} (no candidates produced)\n`);
    } else {
      out(`review disabled: ${(o as { reason?: string }).reason ?? ''}\n`);
    }
  }
  return 0;
}

/**
 * v4.11 Obsidian vault mirror — `/memory vault {link|status|sync}`.
 *
 *   /memory vault link <path>   — write `agent.vault_path` to config
 *                                 (persists across restarts). Caller
 *                                 still needs to restart for the live
 *                                 mutation listener to attach.
 *   /memory vault status        — show resolved vault path + source
 *                                 (env / config / unset).
 *   /memory vault sync          — run a one-shot full export NOW
 *                                 against the resolved vault path.
 *
 * Pure side-channel: never touches MEMORY.md / USER.md / etc. The
 * exporter itself lives in `core/v4/memory/vaultExporter.ts` and is
 * the same code path the boot listener fires.
 */
async function cmdVault(
  positional:  string[],
  paths:       import('../../../core/v4/paths').AidenPaths,
  projectRoot: string | null,
  out:         (s: string) => void,
  err:         (s: string) => void,
  json:        boolean,
): Promise<number> {
  const sub = (positional[0] ?? 'status').toLowerCase();
  const { resolveVaultPath, exportAll } = await import('../../../core/v4/memory/vaultExporter');

  if (sub === 'status') {
    const envVal = process.env.AIDEN_VAULT_PATH;
    let cfgVal: string | undefined;
    try {
      const { ConfigManager } = await import('../../../core/v4/config');
      const cm = new ConfigManager(paths);
      await cm.load();
      cfgVal = cm.getValue<string>('agent.vault_path');
    } catch { /* missing config = no-op */ }
    const resolved = resolveVaultPath(envVal, cfgVal, (m) => err(`${m}\n`));
    if (json) {
      out(JSON.stringify({
        env:      envVal ?? null,
        config:   cfgVal ?? null,
        resolved: resolved,
        source:   resolved ? (envVal ? 'env' : 'config') : 'unset',
      }, null, 2) + '\n');
      return 0;
    }
    out(`vault.env:      ${envVal ?? '(unset)'}\n`);
    out(`vault.config:   ${cfgVal ?? '(unset)'}\n`);
    out(`vault.resolved: ${resolved ?? '(off — no export running)'}\n`);
    return 0;
  }

  if (sub === 'link') {
    // v4.12.1 — routed through the central resolveUserPath (quote-strip,
    // ~ expansion, absolute-wins), replacing the v4.11 local spot-patch.
    // positional[1] arrives quote-aware-tokenized (internal spaces
    // preserved by `_argTokens`), but a mismatched/partial quoting or a
    // non-tokenized entry path may still arrive wrapped — the resolver
    // heals it so we never persist a cwd-glued path again.
    const { resolveUserPath } = await import('../../../core/v4/paths');
    const abs = resolveUserPath(positional[1] ?? '');
    if (!abs) {
      err('Usage: /memory vault link <absolute-path>\n');
      return 1;
    }
    try {
      const { ConfigManager } = await import('../../../core/v4/config');
      const cm = new ConfigManager(paths);
      await cm.load();
      cm.set('agent.vault_path', abs);
      await cm.save();
      out(`vault path saved: ${abs}\n`);
      out('Restart Aiden for the live mutation listener to attach (or run `/memory vault sync` for a one-shot export now).\n');
      return 0;
    } catch (e) {
      err(`failed to persist vault path: ${(e as Error).message}\n`);
      return 1;
    }
  }

  if (sub === 'sync') {
    const envVal = process.env.AIDEN_VAULT_PATH;
    let cfgVal: string | undefined;
    try {
      const { ConfigManager } = await import('../../../core/v4/config');
      const cm = new ConfigManager(paths);
      await cm.load();
      cfgVal = cm.getValue<string>('agent.vault_path');
    } catch { /* noop */ }
    const resolved = resolveVaultPath(envVal, cfgVal, (m) => err(`${m}\n`));
    if (!resolved) {
      err('no vault path configured — run `/memory vault link <path>` first or set AIDEN_VAULT_PATH\n');
      return 1;
    }
    const summary = await exportAll({
      paths,
      vaultPath:   resolved,
      projectRoot,
      log: (level, msg) => (level === 'warn' ? err : out)(`${msg}\n`),
    });
    if (json) { out(JSON.stringify(summary, null, 2) + '\n'); return 0; }
    out(`vault sync → ${resolved}\n`);
    out(`  written: ${summary.written}  removed: ${summary.removed}  skipped: ${summary.skipped}\n`);
    if (summary.errors.length > 0) {
      err(`  errors:\n`);
      for (const e of summary.errors) err(`    - ${e}\n`);
    }
    return 0;
  }

  err(`Unknown vault subcommand: ${sub}. Try: link <path> | status | sync\n`);
  return 1;
}

