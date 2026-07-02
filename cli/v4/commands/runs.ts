/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/runs.ts — v4.5 Phase 6: `aiden runs` command set.
 *
 * Surfaces the daemon's `runs` + `run_events` tables (Phase 1
 * runStore) so operators can inspect daemon-fired turn history
 * outside the REPL.
 *
 * Subcommands:
 *   list    — recent runs; optional --limit / --source / --status filters
 *   show    — full run row + all run_events for one runId
 *   interrupt — request cancellation of a running turn (Q-P6-4a:
 *               SIGUSR1 + marker file pattern)
 *   stats   — aggregate counts by status + mean duration
 *
 * The `interrupt` path writes
 * `~/.aiden/daemon/interrupt-<runId>.req` and signals the daemon
 * via SIGUSR1. The dispatcher polls the marker directory on each
 * lease-renew tick (~60s) and cancels runs whose marker exists.
 * This matches the existing SIGUSR1 → exit 75 restart contract
 * and keeps cancellation signal-driven rather than DB-poll.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  daemonDbPath,
  openDaemonDb,
  daemonRuntimeLockPath,
  createRunStore,
} from '../../../core/v4/daemon';
import { resolveAidenRoot } from '../../../core/v4/paths';
import { renderTable } from '../table';

export interface RunsCliOptions {
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const noopOut = (s: string): void => { process.stdout.write(s); };
const noopErr = (s: string): void => { process.stderr.write(s); };

export interface RunsListArgs {
  limit?:  number;
  source?: string;
  status?: string;
  trigger?: string;          // sessionIdPrefix: trigger:<src>:<id>:
  /**
   * v4.6 Phase 2Q-B — when true, the list returns parent + child
   * rows interleaved (legacy pre-2Q-B view). Default false: rows
   * with non-NULL `spawned_from_run_id` are filtered at the SQL
   * layer so users see "user-triggered turns" cleanly, and each
   * parent gets an inline child-count badge instead.
   */
  includeChildren?: boolean;
}

export async function runRunsSubcommand(
  action: string,
  args:   string[],
  argv:   Record<string, unknown>,
  opts:   RunsCliOptions = {},
): Promise<number> {
  const out = opts.writeOut ?? noopOut;
  const err = opts.writeErr ?? noopErr;
  const aidenRoot = resolveAidenRoot();
  const db = openDaemonDb(daemonDbPath(aidenRoot));
  const runStore = createRunStore({ db });

  switch (action) {
    case 'list':      return cmdList(runStore, argv as unknown as RunsListArgs, out);
    case 'show':      return cmdShow(runStore, args[0], out, err);
    case 'interrupt': return cmdInterrupt(args[0], aidenRoot, out, err);
    case 'resume':    return cmdResume(db, runStore, args[0], out, err);
    case 'stats':     return cmdStats(db, out);
    default:
      err(`Unknown runs action: ${action}\n`);
      err('Actions: list, show <runId>, interrupt <runId>, resume <runId>, stats\n');
      return 2;
  }
}

// ── resume (v4.13 Gap 4) ───────────────────────────────────────────────────
//
// Manual re-drive of a single resume_pending run: builds the ResumePlan
// (revalidation-first), and either enqueues the fresh-conversation resume
// event, parks the task on a user question, or abandons honestly. The
// enqueued event is executed by the RUNNING daemon's dispatcher — this
// command only queues; if no daemon is up, the event waits for one.
function cmdResume(
  db:       ReturnType<typeof openDaemonDb>,
  runStore: ReturnType<typeof createRunStore>,
  ref:      string | undefined,
  out:      (s: string) => void,
  err:      (s: string) => void,
): number {
  if (!ref) { err('runs resume: runId required\n'); return 2; }
  const runId = Number.parseInt(ref, 10);
  if (!Number.isFinite(runId)) { err(`runs resume: invalid runId "${ref}"\n`); return 2; }
  const run = runStore.get(runId);
  if (!run) { err(`runs resume: no run ${runId}\n`); return 1; }
  if (!run.resumePending) {
    err(`runs resume: run ${runId} is not resume-pending (status=${run.status}${run.resumeReason ? `, reason=${run.resumeReason}` : ''})\n`);
    return 1;
  }
  // Lazy imports keep the runs CLI light for list/show.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createTaskStore } = require('../../../core/v4/daemon/taskStore') as typeof import('../../../core/v4/daemon/taskStore');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createTriggerBus } = require('../../../core/v4/daemon/triggerBus') as typeof import('../../../core/v4/daemon/triggerBus');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sweepResumePending } = require('../../../core/v4/daemon/resumeSweep') as typeof import('../../../core/v4/daemon/resumeSweep');
  const result = sweepResumePending({
    runStore,
    taskStore:  createTaskStore({ db }),
    triggerBus: createTriggerBus({ db }),
    runId,
    log: (_lvl, msg) => out(`${msg}\n`),
  });
  if (result.resumed > 0)   { out(`runs resume: run ${runId} re-drive enqueued (the daemon dispatcher will pick it up)\n`); return 0; }
  if (result.askedUser > 0) { out(`runs resume: run ${runId} needs a user decision — see /tasks detail\n`); return 0; }
  if (result.abandoned > 0) { out(`runs resume: run ${runId} abandoned — see /tasks detail\n`); return 0; }
  err(`runs resume: run ${runId} could not be resumed (no job-card, or already claimed)\n`);
  return 1;
}

// ── list ──────────────────────────────────────────────────────────────────

function cmdList(
  runStore: ReturnType<typeof createRunStore>,
  argv:     RunsListArgs,
  out:      (s: string) => void,
): number {
  const allowedStatuses = new Set([
    'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
  ]);
  const status = argv.status && allowedStatuses.has(argv.status)
    ? (argv.status as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted')
    : undefined;
  // v4.6 Phase 2Q-B — default `topLevelOnly: true` hides children.
  // `--include-children` flag (parsed by the CLI argv layer into
  // `includeChildren: true`) flips the predicate to drop the IS NULL
  // filter so child rows appear inline with parents.
  const includeChildren = argv.includeChildren === true;
  const rows = runStore.listRecent({
    limit:           argv.limit ?? 50,
    status,
    source:          argv.source,
    sessionIdPrefix: argv.trigger,
    topLevelOnly:    !includeChildren,
  });
  // v4.8.0 Slice 3 — migrate from padEnd string concatenation to the
  // framed table primitive. Title + count in the top border; empty
  // state paints a framed message so layout weight matches populated
  // runs. The trigger-badge (child-count summary) becomes part of the
  // sessionId cell's `format` so column widths still auto-fit.
  const tableRows = rows.map((r) => {
    let badge = '';
    if (!includeChildren) {
      const { total, completed } = runStore.countChildren(r.id);
      if (total > 0) {
        badge = `  (${total} ${total === 1 ? 'child' : 'children'}, ${completed} OK)`;
      }
    }
    return {
      runId:     String(r.id),
      status:    r.status,
      finish:    r.finishReason ?? '-',
      started:   new Date(r.startedAt).toISOString().slice(0, 19) + 'Z',
      sessionId: r.sessionId + badge,
    };
  });
  out(renderTable(
    tableRows,
    [
      { key: 'runId',     header: 'runId',     align: 'left'                 },
      { key: 'status',    header: 'status',    align: 'left'                 },
      { key: 'finish',    header: 'finish',    align: 'left'                 },
      { key: 'started',   header: 'started',   align: 'left'                 },
      { key: 'sessionId', header: 'sessionId', align: 'left', flex: true     },
    ],
    {
      title:        'Recent runs',
      totalCount:   `${rows.length} ${rows.length === 1 ? 'run' : 'runs'}`,
      emptyMessage: 'no runs match the filter',
    },
  ));
  if (rows.length > 0) {
    const hint = includeChildren
      ? '(parents + sub-agent children)'
      : '(top-level; use --include-children for sub-agents)';
    out(`  ${hint}\n`);
  }
  return 0;
}

// ── show ──────────────────────────────────────────────────────────────────

function cmdShow(
  runStore: ReturnType<typeof createRunStore>,
  rawId:    string | undefined,
  out:      (s: string) => void,
  err:      (s: string) => void,
): number {
  if (!rawId) { err('runs show: runId required\n'); return 2; }
  const runId = Number.parseInt(rawId, 10);
  if (!Number.isFinite(runId) || runId <= 0) {
    err(`runs show: invalid runId: ${rawId}\n`);
    return 2;
  }
  const row = runStore.get(runId);
  if (!row) { err(`runs show: not found: ${runId}\n`); return 1; }
  const events = runStore.listEvents(runId, 500);
  out(JSON.stringify({
    run:    row,
    events: events.map((e) => ({
      ts:      new Date(e.ts).toISOString(),
      kind:    e.kind,
      payload: safeParse(e.payload),
    })),
  }, null, 2) + '\n');
  return 0;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); }
  catch { return s; }
}

// ── interrupt ─────────────────────────────────────────────────────────────

function cmdInterrupt(
  rawId:     string | undefined,
  aidenRoot: string,
  out:       (s: string) => void,
  err:       (s: string) => void,
): number {
  if (!rawId) { err('runs interrupt: runId required\n'); return 2; }
  const runId = Number.parseInt(rawId, 10);
  if (!Number.isFinite(runId) || runId <= 0) {
    err(`runs interrupt: invalid runId: ${rawId}\n`);
    return 2;
  }
  const markerDir = path.join(aidenRoot, 'daemon', 'interrupt');
  try { fs.mkdirSync(markerDir, { recursive: true }); }
  catch (e) {
    err(`runs interrupt: failed to create marker dir: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const markerPath = path.join(markerDir, `${runId}.req`);
  try { fs.writeFileSync(markerPath, JSON.stringify({ runId, requestedAt: Date.now() })); }
  catch (e) {
    err(`runs interrupt: failed to write marker: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // Best-effort SIGUSR1 to the daemon. If the daemon isn't running,
  // the marker is still there for whoever boots next — they'll find
  // the run in `interrupted` state via the boot crash-recovery pass.
  const lockPath = daemonRuntimeLockPath(aidenRoot);
  let pid: number | null = null;
  try {
    if (fs.existsSync(lockPath)) {
      const lines = fs.readFileSync(lockPath, 'utf-8').split(/\r?\n/);
      // runtime.lock format: line 0 = instanceId, line 1 = pid, line 2 = port
      const candidate = Number.parseInt(lines[1] ?? '', 10);
      if (Number.isFinite(candidate)) pid = candidate;
    }
  } catch { /* noop */ }
  if (pid !== null && process.platform !== 'win32') {
    try { process.kill(pid, 'SIGUSR1'); }
    catch { /* daemon may have died; marker still wins on next boot */ }
  }
  out(`runs interrupt: marker written at ${markerPath}\n`);
  if (pid !== null && process.platform !== 'win32') {
    out(`runs interrupt: SIGUSR1 sent to daemon pid=${pid}\n`);
  } else if (process.platform === 'win32') {
    out('runs interrupt: SIGUSR1 not available on Windows — daemon picks up marker on next renew tick\n');
  } else {
    out('runs interrupt: no live daemon found — marker will be honoured on next boot\n');
  }
  return 0;
}

// ── stats ─────────────────────────────────────────────────────────────────

function cmdStats(
  db:  ReturnType<typeof openDaemonDb>,
  out: (s: string) => void,
): number {
  const counts = db.prepare(
    `SELECT status, COUNT(*) AS c FROM runs GROUP BY status`,
  ).all() as Array<{ status: string; c: number }>;
  const completed = db.prepare(
    `SELECT AVG(completed_at - started_at) AS mean,
            MIN(completed_at - started_at) AS min,
            MAX(completed_at - started_at) AS max,
            COUNT(*) AS n
       FROM runs
      WHERE status = 'completed' AND completed_at IS NOT NULL`,
  ).get() as { mean: number | null; min: number | null; max: number | null; n: number };
  // v4.8.0 Slice 3 — framed table replaces the padEnd block. Right-
  // align the count column so multi-digit totals don't break visual
  // rhythm. Empty state paints a framed message.
  out(renderTable(
    counts.map((r) => ({ status: r.status, count: String(r.c) })),
    [
      { key: 'status', header: 'status', align: 'left'  },
      { key: 'count',  header: 'count',  align: 'right' },
    ],
    {
      title:        'Run status counts',
      totalCount:   `${counts.length} ${counts.length === 1 ? 'status' : 'statuses'}`,
      emptyMessage: 'no runs recorded',
    },
  ));
  if (completed.n > 0 && completed.mean !== null) {
    out('\nCompleted-run duration (ms):\n');
    out(`  mean  ${Math.round(completed.mean)}\n`);
    out(`  min   ${completed.min}\n`);
    out(`  max   ${completed.max}\n`);
    out(`  n     ${completed.n}\n`);
  }
  return 0;
}
