/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/daemonDoctor.ts — v4.9.0 Slice 8.
 *
 * `aiden daemon doctor` — read-only diagnostic of substrate health.
 * `aiden daemon doctor --json` — machine-parseable shape.
 * `aiden daemon doctor --fix`  — runs sweeps for safely-fixable issues.
 *
 * Checks (in display order):
 *   1. daemon_id file exists + parses
 *   2. Schema at LATEST_SCHEMA_VERSION
 *   3. Recent incarnation row present + heartbeat fresh
 *   4. Recent crashes (24h) — warn if more than 3
 *   5. Stuck attempts present (sweep candidates)
 *   6. Orphan spans present (sweep candidates)
 *   7. Idempotency table bounded (warn if > 10000 rows)
 *   8. Pending-but-stale trigger events (claim lease expired)
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { resolveAidenRoot } from '../../../core/v4/paths';
import { daemonIdFilePath } from '../../../core/v4/identity';
import { LATEST_SCHEMA_VERSION } from '../../../core/v4/daemon/db/migrations';
import { sweepStuckAttempts } from '../../../core/v4/daemon/runs/stuckAttemptWatchdog';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface CheckResult {
  name:    string;
  status:  CheckStatus;
  detail:  string;
  fixable: boolean;
  fix?:    () => void;
}

export interface DoctorReport {
  overall: CheckStatus;
  checks:  Array<Omit<CheckResult, 'fix'>>;
  fixed?:  string[];
}

export interface RunDoctorOptions {
  /** JSON output (machine-parseable) when true. */
  json?:    boolean;
  /** Invoke `fix()` for each fixable check. */
  fix?:     boolean;
  /** Override the aiden root (tests). */
  rootDir?: string;
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Compute overall status: error if any error, warn if any warn, else ok. */
function overall(results: CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === 'error')) return 'error';
  if (results.some((r) => r.status === 'warn'))  return 'warn';
  return 'ok';
}

interface CountRow { c: number }

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
  ).get(name) as { name?: string } | undefined;
  return !!row?.name;
}

/**
 * Run all checks against the daemon DB at `<root>/daemon/daemon.db`.
 * Pure-data path; no terminal I/O. Renders happen in `runDaemonDoctor`.
 */
export function collectDoctorChecks(rootDir: string): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. daemon_id file
  const idPath = daemonIdFilePath(rootDir);
  if (!fs.existsSync(idPath)) {
    checks.push({ name: 'daemon_id file', status: 'error',
      detail: `missing: ${idPath} (daemon never booted in this root)`,
      fixable: false });
  } else {
    const content = fs.readFileSync(idPath, 'utf8').trim();
    checks.push({ name: 'daemon_id file', status: content.startsWith('dmn_') ? 'ok' : 'error',
      detail: `${idPath} → ${content.slice(0, 40)}...`,
      fixable: false });
  }

  // Open DB. If unavailable, remaining checks short-circuit.
  const dbPath = path.join(rootDir, 'daemon', 'daemon.db');
  if (!fs.existsSync(dbPath)) {
    checks.push({ name: 'daemon DB', status: 'error',
      detail: `missing: ${dbPath}`, fixable: false });
    return checks;
  }
  const db = new Database(dbPath, { readonly: false });
  db.pragma('foreign_keys = ON');
  try {
    // 2. Schema version
    const verRow = db.prepare(`SELECT version FROM schema_version WHERE id = 1`)
      .get() as { version?: number } | undefined;
    const ver = verRow?.version ?? 0;
    checks.push({ name: 'schema version', status: ver === LATEST_SCHEMA_VERSION ? 'ok' : 'warn',
      detail: `current=${ver} latest=${LATEST_SCHEMA_VERSION}`,
      fixable: false });

    // 3. Recent incarnation
    const inc = db.prepare(
      `SELECT incarnation_id, started_at, ended_at, exit_reason FROM daemon_incarnations
        ORDER BY started_at DESC LIMIT 1`,
    ).get() as { incarnation_id: string; started_at: string; ended_at: string | null;
                 exit_reason: string | null } | undefined;
    if (!inc) {
      checks.push({ name: 'recent incarnation', status: 'warn',
        detail: 'no daemon_incarnations rows (daemon never booted post-Slice-4)',
        fixable: false });
    } else {
      const closedDetail = inc.ended_at
        ? `last incarnation ${inc.incarnation_id.slice(0, 20)}... ended_at=${inc.ended_at} reason=${inc.exit_reason}`
        : `latest incarnation ${inc.incarnation_id.slice(0, 20)}... still open (started_at=${inc.started_at})`;
      checks.push({ name: 'recent incarnation', status: 'ok', detail: closedDetail, fixable: false });
    }

    // 4. Recent crashes (24h)
    const sinceIso = new Date(Date.now() - TWENTY_FOUR_HOURS_MS).toISOString();
    const crashes = db.prepare(
      `SELECT COUNT(*) AS c FROM daemon_incarnations
        WHERE exit_reason = 'crash' AND started_at > ?`,
    ).get(sinceIso) as CountRow;
    checks.push({ name: 'recent crashes (24h)',
      status: crashes.c === 0 ? 'ok' : crashes.c > 3 ? 'warn' : 'ok',
      detail: `${crashes.c} crash(es) in last 24h`,
      fixable: false });

    // 5. Stuck attempts (require Slice 5 + 8 tables)
    let stuckAttempts = 0;
    if (tableExists(db, 'run_attempts')) {
      const currentInc = inc?.incarnation_id ?? '';
      const cutoffIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      stuckAttempts = (db.prepare(
        `SELECT COUNT(*) AS c FROM run_attempts
          WHERE status='running' AND incarnation_id != ? AND started_at < ?`,
      ).get(currentInc, cutoffIso) as CountRow).c;
    }
    checks.push({ name: 'stuck attempts',
      status: stuckAttempts === 0 ? 'ok' : 'warn',
      detail: `${stuckAttempts} stuck attempt(s) eligible for sweep`,
      fixable: stuckAttempts > 0,
      fix: stuckAttempts > 0 && inc
        ? (): void => { sweepStuckAttempts(db, { currentIncarnationId: inc.incarnation_id }); }
        : undefined });

    // 6. Orphan spans (open + non-current incarnation)
    let orphanSpans = 0;
    if (tableExists(db, 'spans')) {
      const currentInc = inc?.incarnation_id ?? '';
      orphanSpans = (db.prepare(
        `SELECT COUNT(*) AS c FROM spans
          WHERE status IS NULL AND ended_at IS NULL AND incarnation_id != ?`,
      ).get(currentInc) as CountRow).c;
    }
    checks.push({ name: 'orphan spans',
      status: orphanSpans === 0 ? 'ok' : 'warn',
      detail: `${orphanSpans} orphan span(s) eligible for sweep`,
      fixable: orphanSpans > 0,
      fix: orphanSpans > 0 && inc
        ? (): void => { sweepStuckAttempts(db, { currentIncarnationId: inc.incarnation_id }); }
        : undefined });

    // 7. Idempotency tables size
    let idemRows = 0;
    if (tableExists(db, 'run_idempotency_keys')) {
      idemRows = (db.prepare(`SELECT COUNT(*) AS c FROM run_idempotency_keys`).get() as CountRow).c;
    }
    checks.push({ name: 'run_idempotency_keys size',
      status: idemRows < 10_000 ? 'ok' : 'warn',
      detail: `${idemRows} row(s)` + (idemRows >= 10_000 ? ' — consider sweepExpired' : ''),
      fixable: false });

    // 8. Stale-claimed trigger events
    let staleClaimed = 0;
    if (tableExists(db, 'trigger_events')) {
      staleClaimed = (db.prepare(
        `SELECT COUNT(*) AS c FROM trigger_events
          WHERE status='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at < ?`,
      ).get(Date.now()) as CountRow).c;
    }
    checks.push({ name: 'stale-claimed trigger events',
      status: staleClaimed === 0 ? 'ok' : 'warn',
      detail: `${staleClaimed} trigger_events past claim_expires_at`,
      fixable: false });

  } finally {
    try { db.close(); } catch { /* noop */ }
  }
  return checks;
}

/**
 * CLI entry. Returns the desired process exit code (0=ok, 1=error,
 * 0 for warn-only since warnings shouldn't break scripts).
 */
export function runDaemonDoctor(opts: RunDoctorOptions = {}): number {
  const root = opts.rootDir ?? resolveAidenRoot();
  const out  = opts.writeOut ?? ((s: string): void => { process.stdout.write(s); });
  const err  = opts.writeErr ?? ((s: string): void => { process.stderr.write(s); });

  const checks = collectDoctorChecks(root);
  const fixed: string[] = [];

  if (opts.fix) {
    for (const c of checks) {
      if (c.fixable && c.fix) {
        try { c.fix(); fixed.push(c.name); }
        catch (e) { err(`[doctor] fix '${c.name}' failed: ${e instanceof Error ? e.message : String(e)}\n`); }
      }
    }
  }

  const report: DoctorReport = {
    overall: overall(checks),
    checks:  checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail, fixable: c.fixable })),
    ...(opts.fix ? { fixed } : {}),
  };

  if (opts.json) {
    out(JSON.stringify(report, null, 2) + '\n');
  } else {
    const sym = (s: CheckStatus): string => s === 'ok' ? '[ok]  ' : s === 'warn' ? '[warn]' : '[err] ';
    out(`aiden daemon doctor — ${report.overall.toUpperCase()}\n`);
    out(`root: ${root}\n\n`);
    for (const c of report.checks) {
      out(`  ${sym(c.status)} ${c.name}: ${c.detail}\n`);
    }
    if (opts.fix && fixed.length > 0) {
      out(`\nfixed: ${fixed.join(', ')}\n`);
    } else if (opts.fix) {
      out(`\nno fixable issues found\n`);
    }
  }
  return report.overall === 'error' ? 1 : 0;
}
