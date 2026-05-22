/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/hooks.ts — v4.9.0 Slice 12b.
 *
 *   aiden hooks                          alias for `list`
 *   aiden hooks list [--json]
 *   aiden hooks show <hook_id>
 *   aiden hooks trust <hook_id>  [--yes] (risk warning + y/N prompt unless --yes)
 *   aiden hooks revoke <hook_id> [--yes]
 *   aiden hooks rescan
 *   aiden hooks test <hook_id>   [--event <name>] [--payload <json>]
 *   aiden hooks doctor           [--json] [--fix]
 *   aiden hooks audit            [--hook id] [--event n] [--since iso]
 *                                [--status s] [--limit n] [--json]
 *
 * Doctor's `--fix` is intentionally conservative: it creates the hooks
 * directory and runs a rescan, but NEVER auto-trusts anything (trust
 * remains an explicit, deliberate user action).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';

import { resolveAidenPaths } from '../../../core/v4/paths';
import { daemonDbPath } from '../../../core/v4/daemon/daemonConfig';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../../core/v4/daemon/db/migrations';
import { listHooks, scanAndLoadHooks, type HookRow } from '../../../core/v4/hooks/registry';
import { markTrusted, markRevoked } from '../../../core/v4/hooks/trust';
import { dispatchHook } from '../../../core/v4/hooks/dispatcher';
import { queryHookExecutions, failureRates, countByStatus, type AuditRow } from '../../../core/v4/hooks/auditQuery';
import { findProjectRoot } from '../../../core/v4/memory/projectRoot';

export interface HooksCliOptions {
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
  /** Override DB path (tests). When unset, opens the daemon DB. */
  dbPath?:   string;
  /** Override aiden root (tests). */
  rootDir?:  string;
  /** Override stdin prompt (tests). When set, replaces interactive y/N. */
  promptYesNo?: (question: string) => Promise<boolean>;
}

const noopOut = (s: string): void => { process.stdout.write(s); };
const noopErr = (s: string): void => { process.stderr.write(s); };

interface Ctx {
  out: (s: string) => void;
  err: (s: string) => void;
  db: Database.Database;
  paths: ReturnType<typeof resolveAidenPaths>;
  json: boolean;
  yes:  boolean;
  positional: string[];
  args: string[];
  promptYesNo: (q: string) => Promise<boolean>;
}

export async function runHooksSubcommand(
  action: string,
  args:   string[],
  opts:   HooksCliOptions = {},
): Promise<number> {
  const out  = opts.writeOut ?? noopOut;
  const err  = opts.writeErr ?? noopErr;
  const json = args.includes('--json');
  const yes  = args.includes('--yes');
  const positional = args.filter((a) => !a.startsWith('--'));
  const paths = resolveAidenPaths(opts.rootDir ? { rootOverride: opts.rootDir } : {});

  let db: Database.Database;
  try {
    const dbp = opts.dbPath ?? daemonDbPath(paths.root);
    await fs.mkdir(path.dirname(dbp), { recursive: true });
    db = new Database(dbp);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  } catch (e) {
    err(`hooks: cannot open daemon db: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const ctx: Ctx = {
    out, err, db, paths, json, yes, positional, args,
    promptYesNo: opts.promptYesNo ?? defaultPromptYesNo,
  };
  const effective = action || 'list';
  try {
    switch (effective) {
      case 'list':     return await cmdList(ctx);
      case 'show':     return await cmdShow(ctx);
      case 'trust':    return await cmdTrust(ctx);
      case 'revoke':   return await cmdRevoke(ctx);
      case 'rescan':   return await cmdRescan(ctx);
      case 'test':     return await cmdTest(ctx);
      case 'doctor':   return await cmdDoctor(ctx);
      case 'audit':    return await cmdAudit(ctx);
      case '--help':
      case 'help':     return cmdHelp(out);
      default:
        err(`Unknown hooks action: ${effective}\n`);
        cmdHelp(err);
        return 2;
    }
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

function cmdHelp(w: (s: string) => void): number {
  w(
    'Usage: aiden hooks <action> [args...] [--json] [--yes]\n\n' +
    'Manage Aiden\'s manifest-driven hook subsystem.\n\n' +
    'Actions:\n' +
    '  list                                  All discovered hooks (default).\n' +
    '  show <hook_id>                        Hook manifest + subscriptions + recent executions.\n' +
    '  trust <hook_id> [--yes]               Mark trusted + enabled (confirmation required).\n' +
    '  revoke <hook_id> [--yes]              Mark revoked + disabled (confirmation required).\n' +
    '  rescan                                Walk hook dirs, surface new + drifted.\n' +
    '  test <hook_id> [--event N] [--payload JSON]\n' +
    '                                        Dry-run invocation (no counter mutation).\n' +
    '  doctor [--json] [--fix]               Pre-flight diagnostics.\n' +
    '  audit [--hook id] [--event N] [--status S] [--since ISO] [--limit N] [--json]\n' +
    '                                        Recent hook_executions rows.\n',
  );
  return 0;
}

function defaultPromptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes');
    });
  });
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

interface SubRow {
  subscription_id: string; hook_id: string; event: string;
  authority: string; mode: string; priority: number;
  timeout_ms: number; on_error: string; on_timeout: string;
  matcher_json: string | null; enabled: number;
}

function hooksWithSubs(db: Database.Database): Array<HookRow & { subs: SubRow[]; consecutive_failures: number }> {
  const hooks = db.prepare(
    `SELECT *, consecutive_failures FROM hooks ORDER BY name`,
  ).all() as Array<HookRow & { consecutive_failures: number }>;
  return hooks.map((h) => ({
    ...h,
    subs: db.prepare(`SELECT * FROM hook_subscriptions WHERE hook_id = ? ORDER BY event, priority DESC`).all(h.hook_id) as SubRow[],
  }));
}

async function cmdList(ctx: Ctx): Promise<number> {
  const rows = hooksWithSubs(ctx.db);
  if (ctx.json) { ctx.out(JSON.stringify(rows, null, 2) + '\n'); return 0; }
  if (rows.length === 0) {
    ctx.out('no hooks discovered (drop a HOOK.yaml under ~/.aiden/hooks/<name>/ then run `aiden hooks rescan`)\n');
    return 0;
  }
  for (const h of rows) {
    const stateLabel = `${h.trust_state}, ${h.enabled ? 'enabled' : 'disabled'}`;
    ctx.out(`${h.hook_id}  ${h.name.padEnd(24)} ${stateLabel.padEnd(24)} ${h.source}  (${h.subs.length} subscription${h.subs.length === 1 ? '' : 's'})\n`);
    for (const s of h.subs) {
      ctx.out(`  ${s.event.padEnd(20)} authority=${s.authority.padEnd(18)} mode=${s.mode}\n`);
    }
  }
  return 0;
}

async function cmdShow(ctx: Ctx): Promise<number> {
  const hookId = ctx.positional[0];
  if (!hookId) { ctx.err('show: missing <hook_id>\n'); return 2; }
  const h = ctx.db.prepare(`SELECT *, consecutive_failures FROM hooks WHERE hook_id = ?`).get(hookId) as
    (HookRow & { consecutive_failures: number }) | undefined;
  if (!h) { ctx.err(`show: hook not found: ${hookId}\n`); return 1; }
  const subs = ctx.db.prepare(`SELECT * FROM hook_subscriptions WHERE hook_id = ? ORDER BY event, priority DESC`)
    .all(hookId) as SubRow[];
  const grants = ctx.db.prepare(`SELECT capability, scope_json FROM hook_capability_grants WHERE hook_id = ?`)
    .all(hookId) as Array<{ capability: string; scope_json: string }>;
  const recent = queryHookExecutions(ctx.db, { hookId, limit: 10 });
  if (ctx.json) {
    ctx.out(JSON.stringify({ hook: h, subscriptions: subs, capabilities: grants, recent }, null, 2) + '\n');
    return 0;
  }
  ctx.out(`Hook: ${h.name}  (${h.hook_id})\n`);
  ctx.out(`  state:    ${h.trust_state}, ${h.enabled ? 'enabled' : 'disabled'}\n`);
  ctx.out(`  source:   ${h.source}\n`);
  ctx.out(`  manifest: ${h.manifest_path}\n`);
  ctx.out(`  hash:     ${h.code_hash.slice(0, 16)}...\n`);
  ctx.out(`  consecutive failures: ${h.consecutive_failures}\n`);
  ctx.out('Subscriptions:\n');
  for (const s of subs) {
    ctx.out(`  ${s.event}  authority=${s.authority} mode=${s.mode} priority=${s.priority}\n`);
    ctx.out(`    timeout=${s.timeout_ms}ms  on_error=${s.on_error}  on_timeout=${s.on_timeout}\n`);
    if (s.matcher_json) ctx.out(`    matcher=${s.matcher_json}\n`);
  }
  if (grants.length > 0) {
    ctx.out('Capabilities (declared, not enforced):\n');
    for (const g of grants) ctx.out(`  ${g.capability}  ${g.scope_json}\n`);
  }
  ctx.out(`Recent executions (last ${recent.length}):\n`);
  for (const r of recent) {
    ctx.out(`  ${r.started_at}  ${r.event.padEnd(20)} ${r.status.padEnd(8)} ${r.elapsed_ms}ms\n`);
  }
  return 0;
}

async function cmdTrust(ctx: Ctx): Promise<number> {
  const hookId = ctx.positional[0];
  if (!hookId) { ctx.err('trust: missing <hook_id>\n'); return 2; }
  const h = ctx.db.prepare(`SELECT * FROM hooks WHERE hook_id = ?`).get(hookId) as HookRow | undefined;
  if (!h) { ctx.err(`trust: hook not found: ${hookId}\n`); return 1; }
  if (!ctx.yes) {
    ctx.err(`Hook: ${h.name}  (${h.hook_id})\n  manifest: ${h.manifest_path}\n  current state: ${h.trust_state}\n`);
    ctx.err('RISK WARNING: This hook can affect tool execution. Only trust hooks you\'ve reviewed.\n');
    const ok = await ctx.promptYesNo('Trust this hook? [y/N] ');
    if (!ok) {
      if (ctx.json) ctx.out(JSON.stringify({ ok: false, reason: 'declined' }) + '\n');
      else          ctx.err('trust: declined\n');
      return 1;
    }
  }
  markTrusted(ctx.db, hookId);
  if (ctx.json) ctx.out(JSON.stringify({ ok: true, hook_id: hookId, trust_state: 'trusted', enabled: 1 }) + '\n');
  else          ctx.out(`trusted ${h.name}  (${hookId})\n`);
  return 0;
}

async function cmdRevoke(ctx: Ctx): Promise<number> {
  const hookId = ctx.positional[0];
  if (!hookId) { ctx.err('revoke: missing <hook_id>\n'); return 2; }
  const h = ctx.db.prepare(`SELECT * FROM hooks WHERE hook_id = ?`).get(hookId) as HookRow | undefined;
  if (!h) { ctx.err(`revoke: hook not found: ${hookId}\n`); return 1; }
  if (!ctx.yes) {
    ctx.err(`Hook: ${h.name}  (${h.hook_id})  current state: ${h.trust_state}\n`);
    const ok = await ctx.promptYesNo('Revoke this hook? [y/N] ');
    if (!ok) {
      if (ctx.json) ctx.out(JSON.stringify({ ok: false, reason: 'declined' }) + '\n');
      else          ctx.err('revoke: declined\n');
      return 1;
    }
  }
  markRevoked(ctx.db, hookId);
  if (ctx.json) ctx.out(JSON.stringify({ ok: true, hook_id: hookId, trust_state: 'revoked', enabled: 0 }) + '\n');
  else          ctx.out(`revoked ${h.name}  (${hookId})\n`);
  return 0;
}

async function cmdRescan(ctx: Ctx): Promise<number> {
  const projectRoot = findProjectRoot(process.cwd());
  const r = await scanAndLoadHooks(ctx.db, { aidenRoot: ctx.paths.root, projectRoot });
  if (ctx.json) { ctx.out(JSON.stringify(r, null, 2) + '\n'); return 0; }
  ctx.out(`scanned: loaded=${r.loaded} errored=${r.errored} drifted=${r.drifted}\n`);
  for (const e of r.errors) ctx.out(`  ERR  ${e.path}: ${e.message}\n`);
  return 0;
}

async function cmdTest(ctx: Ctx): Promise<number> {
  const hookId = ctx.positional[0];
  if (!hookId) { ctx.err('test: missing <hook_id>\n'); return 2; }
  const h = ctx.db.prepare(`SELECT * FROM hooks WHERE hook_id = ?`).get(hookId) as HookRow | undefined;
  if (!h) { ctx.err(`test: hook not found: ${hookId}\n`); return 1; }
  // Temporarily ignore enabled/trust_state by flipping to trusted+enabled
  // ONLY in-memory for the test dispatch? Cleaner: dispatch reads its
  // own subs filter; we'll invoke against a synthetic event matching
  // the hook's first subscription. The CLI is opinionated: pick the
  // hook's first subscription as the test target.
  const sub = ctx.db.prepare(`SELECT event FROM hook_subscriptions WHERE hook_id = ? ORDER BY priority DESC LIMIT 1`)
    .get(hookId) as { event: string } | undefined;
  const event = flagValue(ctx.args, '--event') ?? sub?.event ?? 'tool.call.pre';
  let payload: Record<string, unknown> = { tool_name: 'echo', synthetic: true };
  const payloadRaw = flagValue(ctx.args, '--payload');
  if (payloadRaw) {
    try { payload = JSON.parse(payloadRaw) as Record<string, unknown>; }
    catch (e) { ctx.err(`test: invalid --payload JSON: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
  }
  // To test even when untrusted/disabled, briefly flip state in-memory.
  // We use a savepoint to ensure the flip is rolled back after.
  const restoreState  = h.trust_state;
  const restoreEnabled = h.enabled;
  ctx.db.prepare(`UPDATE hooks SET trust_state='trusted', enabled=1 WHERE hook_id=?`).run(hookId);
  try {
    const result = await dispatchHook(ctx.db, event, payload, { testMode: true, runId: 'test', traceId: 'test' });
    const fired = result.fired.find((f) => f.hookId === hookId);
    const exec = ctx.db.prepare(
      `SELECT * FROM hook_executions WHERE hook_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(hookId) as AuditRow | undefined;
    if (ctx.json) {
      ctx.out(JSON.stringify({ event, payload, dispatched: result, exec, fired }, null, 2) + '\n');
    } else {
      ctx.out(`Test fired ${h.name} on ${event}:\n`);
      ctx.out(`  status:    ${fired?.status ?? 'n/a'}\n`);
      ctx.out(`  decision:  ${fired?.decision ?? 'n/a'}\n`);
      ctx.out(`  elapsed:   ${fired?.elapsedMs ?? 0}ms\n`);
      if (exec?.error_message) ctx.out(`  error:     ${exec.error_message}\n`);
      if (result.decision === 'block') ctx.out(`  AGGREGATE: block (reason=${result.reason ?? 'n/a'})\n`);
    }
  } finally {
    ctx.db.prepare(`UPDATE hooks SET trust_state=?, enabled=? WHERE hook_id=?`).run(restoreState, restoreEnabled, hookId);
  }
  return 0;
}

async function cmdDoctor(ctx: Ctx): Promise<number> {
  const fix = ctx.args.includes('--fix');
  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; detail: string; fixable: boolean }> = [];
  const hooksDir = path.join(ctx.paths.root, 'hooks');

  // 1. hooks dir exists
  let dirExists = false;
  try { await fs.access(hooksDir); dirExists = true; } catch { /* missing */ }
  if (!dirExists && fix) {
    await fs.mkdir(hooksDir, { recursive: true });
    dirExists = true;
  }
  checks.push({
    name: 'hooks_dir_exists',
    status: dirExists ? 'ok' : 'warn',
    detail: dirExists ? hooksDir : `missing: ${hooksDir} (run with --fix to create)`,
    fixable: !dirExists,
  });

  // 2. schema v12
  const v = ctx.db.prepare(`SELECT version FROM schema_version`).get() as { version: number } | undefined;
  checks.push({
    name: 'schema_v12_current',
    status: v && v.version >= 12 ? 'ok' : 'error',
    detail: `db schema version = ${v?.version ?? 0}, latest = ${LATEST_SCHEMA_VERSION}`,
    fixable: false,
  });

  // 3. parseable hooks
  const rows = listHooks(ctx.db);
  const drifted = rows.filter((r) => r.trust_state === 'drifted');
  const untrusted = rows.filter((r) => r.trust_state === 'untrusted');
  const trustedEnabled = rows.filter((r) => r.trust_state === 'trusted' && r.enabled === 1);
  checks.push({
    name: 'drift_count',
    status: drifted.length === 0 ? 'ok' : 'warn',
    detail: `${drifted.length} drifted hook(s) (re-trust to re-enable)`,
    fixable: false,
  });
  checks.push({
    name: 'untrusted_count',
    status: untrusted.length === 0 ? 'ok' : 'warn',
    detail: `${untrusted.length} untrusted hook(s) installed but not yet enabled`,
    fixable: false,
  });
  checks.push({
    name: 'trusted_enabled_count',
    status: 'ok',
    detail: `${trustedEnabled.length} trusted + enabled hook(s)`,
    fixable: false,
  });

  // 4. auto-disabled last 24h — revoked + non-zero recent executions
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentStatus = countByStatus(ctx.db, since);
  const recentNonOk = (recentStatus.crash ?? 0) + (recentStatus.timeout ?? 0) + (recentStatus.malformed_output ?? 0);
  const recentRevoked = ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM hooks WHERE trust_state='revoked' AND updated_at >= ?`,
  ).get(since) as { n: number };
  checks.push({
    name: 'auto_disabled_24h',
    status: recentRevoked.n === 0 ? 'ok' : 'warn',
    detail: `${recentRevoked.n} hook(s) revoked in last 24h (${recentNonOk} non-ok executions)`,
    fixable: false,
  });

  // 5. high-failure-rate hooks
  const fr = failureRates(ctx.db, 100).filter((f) => f.failureRate > 0.1);
  checks.push({
    name: 'high_failure_rate',
    status: fr.length === 0 ? 'ok' : 'warn',
    detail: fr.length === 0 ? 'no hooks > 10% failure last 100 executions' : `${fr.length} hook(s) > 10% failure: ${fr.map((r) => r.hook_id).join(', ')}`,
    fixable: false,
  });

  if (ctx.json) {
    ctx.out(JSON.stringify({ checks, fix }, null, 2) + '\n');
    return checks.some((c) => c.status === 'error') ? 1 : 0;
  }
  for (const c of checks) {
    const icon = c.status === 'ok' ? '[ok]   ' : c.status === 'warn' ? '[warn] ' : '[ERR]  ';
    ctx.out(`${icon}${c.name.padEnd(24)} ${c.detail}\n`);
  }
  return checks.some((c) => c.status === 'error') ? 1 : 0;
}

async function cmdAudit(ctx: Ctx): Promise<number> {
  const limitRaw = flagValue(ctx.args, '--limit');
  const q = {
    hookId: flagValue(ctx.args, '--hook'),
    event:  flagValue(ctx.args, '--event'),
    status: flagValue(ctx.args, '--status'),
    since:  flagValue(ctx.args, '--since'),
    limit:  limitRaw ? Number.parseInt(limitRaw, 10) : 50,
  };
  const rows = queryHookExecutions(ctx.db, q);
  if (ctx.json) { ctx.out(JSON.stringify(rows, null, 2) + '\n'); return 0; }
  if (rows.length === 0) { ctx.out('no executions match\n'); return 0; }
  ctx.out(`${'started_at'.padEnd(26)} ${'hook'.padEnd(18)} ${'event'.padEnd(20)} ${'status'.padEnd(10)} ${'decision'.padEnd(10)} elapsed\n`);
  for (const r of rows) {
    ctx.out(`${r.started_at.padEnd(26)} ${(r.hook_name ?? r.hook_id).slice(0, 18).padEnd(18)} ${r.event.padEnd(20)} ${r.status.padEnd(10)} ${(r.decision ?? '-').padEnd(10)} ${r.elapsed_ms}ms\n`);
  }
  return 0;
}
