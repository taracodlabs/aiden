/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/cron.ts — Phase 24.1b
 *
 * `/cron [add|list|run|show|logs|enable|disable|remove] ...`
 *
 * Subcommand surface:
 *   add <name> <schedule> <command>  — create a job
 *   list                             — table of jobs
 *   run <id|name>                    — fire immediately
 *   show <id|name>                   — full detail incl. last output
 *   logs <id|name>                   — tail last 100 lines of run log
 *   enable / disable <id|name>       — toggle without deleting
 *   remove <id|name>                 — confirm + delete
 *
 * Quoting: the registry's tokenizer is whitespace-only, so this command
 * re-parses ctx.rawArgs to honour double-quoted strings (necessary
 * because schedules and commands routinely contain spaces, e.g.
 * `/cron add brief "0 9 * * *" "give me NSE top movers"`).
 */

import { promises as fsp } from 'node:fs';
import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { renderTable } from '../table';
// v4.11 — quote-aware tokenizer extracted to a shared helper (also used
// by /memory vault link). Re-exported below so existing importers
// (cronCommand.test.ts) keep resolving `tokenize` from here.
import { tokenize } from './_argTokens';
import {
  createJob, createJobAsync, listJobs, getJob,
  pauseJob, resumeJob, deleteJob, triggerJob,
  pauseJobAsync, resumeJobAsync, deleteJobAsync,
  awaitPendingSaves,
  getDiagnostics,
  AIDEN_CRON_BUILD,
  type CronJob,
} from '../../../core/cronManager';
// v4.5 Phase 6 — daemon-mode scheduled_workflows read-through.
import {
  daemonDbPath,
  openDaemonDb,
} from '../../../core/v4/daemon';
import { jobToRow } from '../../../core/v4/daemon/cron/cronBridge';
import { isMisfirePolicy } from '../../../core/v4/daemon/cron/misfirePolicy';
import { resolveAidenRoot } from '../../../core/v4/paths';

const NAME_RE      = /^[A-Za-z0-9_-]+$/;
const LOGS_DIR     = path.join(os.homedir(), '.aiden', 'cron-logs');
const TAIL_LINES   = 100;

// ── Quote-aware arg tokenizer ──────────────────────────────────────────────
//
// v4.11 — moved to the shared `_argTokens` helper (also used by
// `/memory vault link`). Re-exported so callers/tests importing
// `tokenize` from this module are unaffected.
export { tokenize };

// ── Resolve id-prefix or exact name ────────────────────────────────────────

export function resolveJob(ref: string): CronJob | null {
  if (!ref) return null;
  const all = listJobs();
  // Exact id wins.
  const exactId = all.find(j => j.id === ref);
  if (exactId) return exactId;
  // Exact name (description).
  const exactName = all.find(j => j.description === ref);
  if (exactName) return exactName;
  // Unique prefix on id.
  const idPref = all.filter(j => j.id.startsWith(ref));
  if (idPref.length === 1) return idPref[0];
  return null;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function colourResult(
  ctx: SlashCommandContext,
  result?: 'ok' | 'fail' | 'warn' | 'error' | 'timeout' | null,
): string {
  if (result === 'ok')      return '✓';
  if (result === 'warn')    return '∼';
  if (result === 'fail'
   || result === 'error'
   || result === 'timeout') return '✗';
  return '·';
}

function fmtTime(iso?: string): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16);
}

// ── Subcommand handlers ────────────────────────────────────────────────────

async function cmdAdd(ctx: SlashCommandContext, args: string[]): Promise<void> {
  if (args.length < 3) {
    ctx.display.printError('Usage: /cron add <name> <schedule> <command>');
    return;
  }
  const [name, schedule, ...rest] = args;
  const command = rest.join(' ');

  if (!NAME_RE.test(name)) {
    ctx.display.printError(
      `Invalid name "${name}". Use alphanumeric, dash, or underscore only.`,
    );
    return;
  }
  if (!command) {
    ctx.display.printError('Command is required.');
    return;
  }
  if (resolveJob(name)) {
    ctx.display.printError(`A job named "${name}" already exists.`);
    return;
  }

  try {
    const job = createJob(name, schedule, command);
    ctx.display.success(
      `Created [${shortId(job.id)}] ${job.description} — ${job.schedule}`,
    );
    if (job.nextRun) ctx.display.dim(`next run: ${fmtTime(job.nextRun)}`);
  } catch (e: any) {
    ctx.display.printError(`Could not create job: ${e?.message ?? e}`);
  }
}

function cmdList(ctx: SlashCommandContext): void {
  const jobs = listJobs();
  if (jobs.length === 0) {
    ctx.display.dim('No cron jobs. Use /cron add <name> <schedule> <command>.');
    return;
  }
  const rows = jobs.map(j => ({
    id:        shortId(j.id),
    name:      j.description || '(unnamed)',
    schedule:  j.schedule,
    enabled:   j.enabled ? 'on' : 'off',
    lastRun:   fmtTime(j.lastRun),
    result:    j.lastResult ?? '—',
  }));
  ctx.display.write(
    renderTable(rows, [
      { key: 'id',       header: 'ID',       align: 'left'  },
      { key: 'name',     header: 'Name',     align: 'left', flex: true },
      { key: 'schedule', header: 'Schedule', align: 'left'  },
      { key: 'enabled',  header: 'En',       align: 'center',
        color: (v) => (v === 'on' ? 'success' : 'muted') },
      { key: 'lastRun',  header: 'Last Run', align: 'left'  },
      { key: 'result',   header: 'R',        align: 'center',
        color: (v) => (v === 'ok' ? 'success' : v === 'fail' ? 'error' : 'muted') },
    ]),
  );
}

async function cmdRun(ctx: SlashCommandContext, args: string[]): Promise<void> {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  ctx.display.info(`Triggering [${shortId(job.id)}] ${job.description}…`);
  const ok = await triggerJob(job.id);
  if (!ok) { ctx.display.printError('Trigger failed.'); return; }
  const fresh = getJob(job.id);
  if (fresh?.lastResult === 'ok') ctx.display.success(`Done (${fmtTime(fresh.lastRun)}).`);
  else                            ctx.display.warn(`Finished with errors (${fmtTime(fresh?.lastRun)}).`);
  if (fresh?.lastOutput) {
    ctx.display.dim('--- output ---');
    ctx.display.write(fresh.lastOutput.replace(/\n?$/, '\n'));
  }
}

function cmdShow(ctx: SlashCommandContext, args: string[]): void {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  ctx.display.info(`${job.description} [${job.id}]`);
  ctx.display.write(`schedule    : ${job.schedule}\n`);
  ctx.display.write(`kind        : ${job.kind}\n`);
  ctx.display.write(`command     : ${job.action}\n`);
  ctx.display.write(`enabled     : ${job.enabled ? 'yes' : 'no'}\n`);
  ctx.display.write(`runs        : ${job.runCount}\n`);
  ctx.display.write(`last run    : ${fmtTime(job.lastRun)}\n`);
  ctx.display.write(`last result : ${job.lastResult ?? '—'}\n`);
  ctx.display.write(`next run    : ${fmtTime(job.nextRun)}\n`);
  if (job.lastOutput) {
    ctx.display.dim('--- last output ---');
    ctx.display.write(job.lastOutput.replace(/\n?$/, '\n'));
  }
}

async function cmdLogs(ctx: SlashCommandContext, args: string[]): Promise<void> {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  const logPath = path.join(LOGS_DIR, `${job.id}.log`);
  if (!fs.existsSync(logPath)) {
    ctx.display.dim(`No log yet for ${job.description} (${shortId(job.id)}).`);
    return;
  }
  const text  = await fsp.readFile(logPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const tail  = lines.slice(Math.max(0, lines.length - TAIL_LINES - 1));
  ctx.display.dim(`--- ${logPath} (last ${tail.length} lines) ---`);
  ctx.display.write(tail.join('\n') + '\n');
}

function cmdEnable(ctx: SlashCommandContext, args: string[]): void {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  if (resumeJob(job.id)) ctx.display.success(`Enabled ${job.description}.`);
  else                   ctx.display.printError('Enable failed.');
}

function cmdDisable(ctx: SlashCommandContext, args: string[]): void {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  if (pauseJob(job.id)) ctx.display.success(`Disabled ${job.description}.`);
  else                  ctx.display.printError('Disable failed.');
}

async function cmdStatus(ctx: SlashCommandContext): Promise<void> {
  const diag = await getDiagnostics();
  ctx.display.info(`Aiden cron — ${AIDEN_CRON_BUILD}`);
  ctx.display.write(`  schema version : ${diag.schemaVersion}\n`);
  ctx.display.write(`  tick interval  : ${diag.tickMs}ms\n`);
  ctx.display.write(`  fire timeout   : ${diag.timeoutMs}ms\n`);
  ctx.display.write(`  heartbeat      : ${diag.heartbeatActive ? 'active' : 'idle'}\n`);
  ctx.display.write(`  last heartbeat : ${diag.lastHeartbeatAt ?? 'never'}\n`);
  ctx.display.write(`  skipped ticks  : ${diag.skippedTicks}\n`);
  ctx.display.write(`  fires (boot)   : ${diag.firesStarted}\n`);
  ctx.display.write(`  lock           : ${diag.lock.held ? 'held' : 'free'} (${diag.lock.path})\n`);
  if (diag.recentFires.length > 0) {
    ctx.display.write(`  recent fires:\n`);
    for (const r of diag.recentFires) {
      const tag = r.status === 'ok' ? '✓'
                : r.status === 'warn' ? '∼'
                : r.status === 'timeout' ? 'T'
                : '✗';
      ctx.display.write(
        `    ${tag} [${r.jobId.slice(0, 8)}]  ${fmtTime(r.startedAt)}  ${r.durationMs}ms` +
        `${r.error ? '  ' + r.error.slice(0, 60) : ''}\n`,
      );
    }
  }
}

async function cmdRemove(ctx: SlashCommandContext, args: string[]): Promise<void> {
  const job = resolveJob(args[0] ?? '');
  if (!job) { ctx.display.printError(`Job not found: ${args[0] ?? '(missing)'}`); return; }
  // Confirmation: prefer ctx.prompt so we own the y/N parsing — that way
  // typing the job's id (or anything other than y/yes) is unambiguously
  // treated as cancel. If neither prompt nor confirm is wired we refuse the
  // destructive op rather than surprise-deleting.
  const question = `Delete cron job "${job.description}" [${shortId(job.id)}]? (y/N) `;
  let ok = false;
  if (ctx.prompt) {
    const answer = (await ctx.prompt(question)).trim();
    ok = /^(y|yes)$/i.test(answer);
  } else if (ctx.confirm) {
    ok = await ctx.confirm(question);
  }
  // v4.9.2 Slice 3 — when ctx.confirm was the source, the primitive
  // already printed a per-input rejection message. The ctx.prompt
  // branch above does its own y/N parsing, so it still owns its own
  // "Cancelled." line.
  if (!ok) {
    if (ctx.prompt) ctx.display.dim('Cancelled.');
    return;
  }
  if (deleteJob(job.id)) {
    await awaitPendingSaves();
    ctx.display.success(`Removed ${job.description}.`);
  } else {
    ctx.display.printError('Remove failed.');
  }
}

// ── v4.5 Phase 6 — top-level `aiden cron` CLI surface ──────────────────────
//
// Parallel to runTriggerSubcommand / runDaemonSubcommand. Reuses the
// cronManager API for JSON I/O (legacy source of truth) and reads the
// SQLite scheduled_workflows table when AIDEN_DAEMON=1 to surface the
// daemon-mode emitter's last_fired_at / misfire_policy.

export interface CronCliOptions {
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const cronNoopOut = (s: string): void => { process.stdout.write(s); };
const cronNoopErr = (s: string): void => { process.stderr.write(s); };

export interface CronAddArgs {
  name?:           string;
  label?:          string;          // alias accepted by the Commander wire
  schedule?:       string;
  command?:        string;
  timezone?:       string;
  misfirePolicy?:  string;
  promptTemplate?: string;
  deliverOnly?:    boolean;
}

interface SqlWorkflowSummary {
  id:               string;
  misfire_policy:   string;
  last_fired_at:    number | null;
  next_fire_at:     number | null;
}

/** Read the scheduled_workflows rows for the daemon-mode view. */
function readScheduledWorkflows(): Map<string, SqlWorkflowSummary> {
  const out: Map<string, SqlWorkflowSummary> = new Map();
  try {
    const root = resolveAidenRoot();
    const db = openDaemonDb(daemonDbPath(root));
    const rows = db.prepare(
      `SELECT id, misfire_policy, last_fired_at, next_fire_at FROM scheduled_workflows`,
    ).all() as SqlWorkflowSummary[];
    for (const r of rows) out.set(r.id, r);
  } catch { /* daemon DB absent — return empty map */ }
  return out;
}

/** Write/refresh a scheduled_workflows row from a CronJobV2. Idempotent. */
function upsertScheduledWorkflow(job: CronJob, misfirePolicy?: string, promptTemplate?: string, deliverOnly?: boolean): void {
  try {
    const root = resolveAidenRoot();
    const db = openDaemonDb(daemonDbPath(root));
    const row = jobToRow(job as CronJob);
    const policy = misfirePolicy && isMisfirePolicy(misfirePolicy) ? misfirePolicy : row.misfire_policy;
    db.prepare(
      `INSERT INTO scheduled_workflows
         (id, name, schedule_expression, timezone, enabled, payload_json,
          prompt_template, deliver_only, misfire_policy, fire_rate_limit,
          catch_up_limit, grace_ms, last_fired_at, next_fire_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         schedule_expression = excluded.schedule_expression,
         enabled = excluded.enabled,
         payload_json = excluded.payload_json,
         prompt_template = excluded.prompt_template,
         deliver_only = excluded.deliver_only,
         misfire_policy = excluded.misfire_policy,
         updated_at = excluded.updated_at`,
    ).run(
      row.id, row.name, row.schedule_expression, row.timezone, row.enabled,
      row.payload_json,
      promptTemplate ?? row.prompt_template,
      deliverOnly === true ? 1 : 0,
      policy,
      row.fire_rate_limit, row.catch_up_limit, row.grace_ms,
      row.last_fired_at, row.next_fire_at,
      row.created_at, row.updated_at,
    );
  } catch { /* daemon DB absent — JSON path still wrote the job */ }
}

/** Delete a scheduled_workflows row. Best-effort. */
function deleteScheduledWorkflow(id: string): void {
  try {
    const root = resolveAidenRoot();
    const db = openDaemonDb(daemonDbPath(root));
    db.prepare(`DELETE FROM scheduled_workflows WHERE id = ?`).run(id);
  } catch { /* noop */ }
}

/** Set enabled = 0/1 on scheduled_workflows. Best-effort. */
function setWorkflowEnabled(id: string, enabled: number): void {
  try {
    const root = resolveAidenRoot();
    const db = openDaemonDb(daemonDbPath(root));
    db.prepare(
      `UPDATE scheduled_workflows SET enabled = ?, updated_at = ? WHERE id = ?`,
    ).run(enabled, Date.now(), id);
  } catch { /* noop */ }
}

/**
 * Top-level `aiden cron` dispatcher. Mirrors runTriggerSubcommand shape.
 */
export async function runCronSubcommand(
  action: string,
  args:   string[],
  argv:   Record<string, unknown>,
  opts:   CronCliOptions = {},
): Promise<number> {
  const out = opts.writeOut ?? cronNoopOut;
  const err = opts.writeErr ?? cronNoopErr;

  switch (action) {
    case 'add':                return cmdCliAdd(argv as unknown as CronAddArgs, out, err);
    case 'list':               return cmdCliList(out);
    case 'show':               return cmdCliShow(args[0], out, err);
    case 'remove': case 'rm':  return cmdCliRemove(args[0], out, err);
    case 'enable':             return cmdCliEnable(args[0], out, err);
    case 'disable':            return cmdCliDisable(args[0], out, err);
    case 'run':                return cmdCliRun(args[0], out, err);
    case 'logs':               return cmdCliLogs(args[0], out, err);
    default:
      err(`Unknown cron action: ${action}\n`);
      err('Actions: add, list, show <id>, remove <id>, enable <id>, disable <id>, run <id>, logs <id>\n');
      return 2;
  }
}

async function cmdCliAdd(a: CronAddArgs, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  // v4.12.1 — tolerate a raw Commander Command being passed as argv:
  // `.name` on a Command is a METHOD, which previously short-circuited
  // `a.name ?? a.label` to a function and made `aiden cron add` fail
  // "label is required" no matter what. Only string values count.
  const name = (typeof a.name === 'string' ? a.name : undefined)
    ?? (typeof a.label === 'string' ? a.label : undefined);
  if (!name || !NAME_RE.test(name)) {
    err('cron add: --label is required (alphanumeric, dash, underscore only)\n');
    return 2;
  }
  if (!a.schedule || a.schedule.length === 0) {
    err('cron add: --schedule is required (cron expr, "every Nm/h/d", or ISO timestamp)\n');
    return 2;
  }
  if (!a.command || a.command.length === 0) {
    err('cron add: --command is required\n');
    return 2;
  }
  if (a.misfirePolicy && !isMisfirePolicy(a.misfirePolicy)) {
    err(`cron add: invalid --misfire-policy "${a.misfirePolicy}" (skip_stale|run_once_if_late|catch_up_with_limit|manual_review)\n`);
    return 2;
  }
  if (resolveJob(name)) {
    err(`cron add: a job named "${name}" already exists\n`);
    return 2;
  }
  let job: CronJob;
  try { job = await createJobAsync(name, a.schedule, a.command); }
  catch (e) { err(`cron add: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
  // Mirror to SQLite for daemon-mode visibility.
  upsertScheduledWorkflow(job, a.misfirePolicy, a.promptTemplate, a.deliverOnly === true);
  await awaitPendingSaves();
  out(`cron added: ${job.id} (${job.description})\n`);
  out(`  schedule:       ${job.schedule}\n`);
  out(`  command:        ${job.action}\n`);
  if (a.misfirePolicy) out(`  misfire policy: ${a.misfirePolicy}\n`);
  if (a.deliverOnly)   out(`  deliver_only:   true (daemon will skip the agent loop)\n`);
  if (job.nextRun)     out(`  next run:       ${fmtTime(job.nextRun)}\n`);
  return 0;
}

function cmdCliList(out: (s: string) => void): number {
  const jobs = listJobs();
  if (jobs.length === 0) {
    out('No cron jobs.\n');
    return 0;
  }
  const sqlView = readScheduledWorkflows();
  out(`${'id'.padEnd(10)}  ${'enabled'.padEnd(8)}  ${'schedule'.padEnd(20)}  ${'misfire'.padEnd(20)}  ${'lastRun'.padEnd(20)}  name\n`);
  for (const j of jobs) {
    const sql = sqlView.get(j.id);
    const id = j.id.slice(0, 10).padEnd(10);
    const enabled = (j.enabled ? 'on' : 'off').padEnd(8);
    const sched = (j.schedule || '').slice(0, 20).padEnd(20);
    const policy = (sql?.misfire_policy ?? '-').padEnd(20);
    const lastRun = (j.lastRun ? fmtTime(j.lastRun) : '-').padEnd(20);
    out(`${id}  ${enabled}  ${sched}  ${policy}  ${lastRun}  ${j.description}\n`);
  }
  out(`\n${jobs.length} job${jobs.length === 1 ? '' : 's'}\n`);
  return 0;
}

function cmdCliShow(ref: string | undefined, out: (s: string) => void, err: (s: string) => void): number {
  if (!ref) { err('cron show: id or name required\n'); return 2; }
  const job = resolveJob(ref);
  if (!job) { err(`cron show: not found: ${ref}\n`); return 1; }
  const sqlView = readScheduledWorkflows().get(job.id);
  out(JSON.stringify({
    jsonView: job,
    sqlView:  sqlView ?? null,
  }, null, 2) + '\n');
  return 0;
}

// v4.12.1 — the CLI mutation handlers await the *Async cronManager
// variants: the sync ones persist in a background IIFE, which a one-shot
// CLI process kills at process.exit — `cron remove` printed success while
// the job survived on disk. The awaited variants persist under the file
// lock BEFORE resolving, so the write can never be lost to an exit.
async function cmdCliRemove(ref: string | undefined, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!ref) { err('cron remove: id or name required\n'); return 2; }
  const job = resolveJob(ref);
  if (!job) { err(`cron remove: not found: ${ref}\n`); return 1; }
  if (!(await deleteJobAsync(job.id))) { err('cron remove: delete failed\n'); return 1; }
  deleteScheduledWorkflow(job.id);
  await awaitPendingSaves();
  out(`cron removed: ${job.id} (${job.description})\n`);
  return 0;
}

async function cmdCliEnable(ref: string | undefined, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!ref) { err('cron enable: id or name required\n'); return 2; }
  const job = resolveJob(ref);
  if (!job) { err(`cron enable: not found: ${ref}\n`); return 1; }
  if (!(await resumeJobAsync(job.id))) { err('cron enable: enable failed\n'); return 1; }
  setWorkflowEnabled(job.id, 1);
  await awaitPendingSaves();
  out(`cron enabled: ${job.id}\n`);
  return 0;
}

async function cmdCliDisable(ref: string | undefined, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!ref) { err('cron disable: id or name required\n'); return 2; }
  const job = resolveJob(ref);
  if (!job) { err(`cron disable: not found: ${ref}\n`); return 1; }
  if (!(await pauseJobAsync(job.id))) { err('cron disable: disable failed\n'); return 1; }
  setWorkflowEnabled(job.id, 0);
  await awaitPendingSaves();
  out(`cron disabled: ${job.id}\n`);
  return 0;
}

async function cmdCliRun(ref: string | undefined, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!ref) { err('cron run: id or name required\n'); return 2; }
  const job = resolveJob(ref);
  if (!job) { err(`cron run: not found: ${ref}\n`); return 1; }
  out(`cron run: triggering ${job.id} (${job.description})...\n`);
  const ok = await triggerJob(job.id);
  if (!ok) { err('cron run: trigger failed\n'); return 1; }
  const fresh = getJob(job.id);
  out(`cron run: done — lastResult=${fresh?.lastResult ?? 'unknown'}\n`);
  return 0;
}

async function cmdCliLogs(ref: string | undefined, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!ref) { err('cron logs: id or name required\n'); return 2; }
  const job = resolveJob(ref);
  if (!job) { err(`cron logs: not found: ${ref}\n`); return 1; }
  const logPath = path.join(LOGS_DIR, `${job.id}.log`);
  if (!fs.existsSync(logPath)) {
    out(`No log yet for ${job.id} (${job.description}).\n`);
    return 0;
  }
  const text = await fsp.readFile(logPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - TAIL_LINES - 1));
  out(`--- ${logPath} (last ${tail.length} lines) ---\n`);
  out(tail.join('\n') + '\n');
  return 0;
}

// ── SlashCommand definition ────────────────────────────────────────────────

export const cron: SlashCommand = {
  name: 'cron',
  description: 'Manage scheduled jobs (add, list, run, logs, enable/disable, remove).',
  category: 'system',
  icon: '⏰',
  handler: async (ctx) => {
    const tokens = tokenize(ctx.rawArgs);
    const sub    = (tokens[0] ?? 'list').toLowerCase();
    const rest   = tokens.slice(1);

    switch (sub) {
      case 'add':                 await cmdAdd    (ctx, rest); break;
      case 'list':  case 'ls':    cmdList         (ctx);       break;
      case 'run':   case 'trigger': await cmdRun  (ctx, rest); break;
      case 'show':  case 'info':  cmdShow         (ctx, rest); break;
      case 'status':              await cmdStatus (ctx);       break;
      case 'logs':  case 'log':   await cmdLogs   (ctx, rest); break;
      case 'enable':              cmdEnable       (ctx, rest); break;
      case 'disable': case 'pause': cmdDisable    (ctx, rest); break;
      case 'remove':  case 'rm': case 'delete':
                                  await cmdRemove (ctx, rest); break;
      case 'help':
      case '?':
        ctx.display.info('/cron usage:');
        ctx.display.write('  /cron add <name> <schedule> <command>\n');
        ctx.display.write('  /cron list\n');
        ctx.display.write('  /cron run <id|name>\n');
        ctx.display.write('  /cron show <id|name>\n');
        ctx.display.write('  /cron logs <id|name>\n');
        ctx.display.write('  /cron enable|disable <id|name>\n');
        ctx.display.write('  /cron remove <id|name>\n');
        ctx.display.write('  /cron status                  (v4.1-cron diagnostics)\n');
        ctx.display.dim('Schedules: cron expr ("0 9 * * *"), interval ("every 2m"), one-shot ISO.');
        break;
      default:
        ctx.display.printError(`Unknown subcommand: ${sub}. Try /cron help.`);
    }
  },
};
