/**
 * tests/v4/daemon/runs/stuckAttemptWatchdog.test.ts — v4.9.0 Slice 8.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { sweepStuckAttempts } from '../../../../core/v4/daemon/runs/stuckAttemptWatchdog';
import { createAttempt, getAttempt } from '../../../../core/v4/daemon/runs/attemptStore';
import { newIncarnationId } from '../../../../core/v4/identity';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;

function seedInstance(id: string): void {
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, 1, 'host', ?, ?, 'v')`,
  ).run(id, Date.now(), Date.now());
}
function seedRun(incarnationId: string): number {
  const r = db.prepare(
    `INSERT INTO runs (session_id, instance_id, status, started_at) VALUES ('s', ?, 'running', ?)`,
  ).run(incarnationId, Date.now());
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('sweepStuckAttempts — Slice 8', () => {
  it('sweeps stale running attempts owned by non-current incarnation', () => {
    const deadInc = newIncarnationId();
    const curInc  = newIncarnationId();
    seedInstance(deadInc);
    seedInstance(curInc);
    const runId = seedRun(deadInc);
    const staleId = createAttempt(db, {
      runId, incarnationId: deadInc,
      startedAt: '2026-01-01T00:00:00.000Z',  // ancient
    });
    const r = sweepStuckAttempts(db, { currentIncarnationId: curInc, thresholdMs: 1000 });
    expect(r.reclaimedAttempts).toBe(1);
    expect(r.attemptIds).toEqual([staleId]);
    const after = getAttempt(db, staleId)!;
    expect(after.status).toBe('crashed');
    expect(after.finish_reason).toBe('stuck_attempt_swept');
    expect(after.ended_at).not.toBeNull();
  });

  it('does NOT touch current incarnation attempts (even if stale)', () => {
    const curInc = newIncarnationId();
    seedInstance(curInc);
    const runId = seedRun(curInc);
    const fresh = createAttempt(db, {
      runId, incarnationId: curInc,
      startedAt: '2026-01-01T00:00:00.000Z',  // looks stale
    });
    const r = sweepStuckAttempts(db, { currentIncarnationId: curInc, thresholdMs: 1000 });
    expect(r.reclaimedAttempts).toBe(0);
    expect(getAttempt(db, fresh)!.status).toBe('running');
  });

  it('does NOT touch attempts under threshold', () => {
    const deadInc = newIncarnationId();
    const curInc  = newIncarnationId();
    seedInstance(deadInc); seedInstance(curInc);
    const runId = seedRun(deadInc);
    const recent = createAttempt(db, {
      runId, incarnationId: deadInc,
      startedAt: new Date().toISOString(),  // now
    });
    const r = sweepStuckAttempts(db, { currentIncarnationId: curInc, thresholdMs: 60_000 });
    expect(r.reclaimedAttempts).toBe(0);
    expect(getAttempt(db, recent)!.status).toBe('running');
  });

  it('sweeps orphan spans (open status + non-current incarnation, ANY age)', () => {
    const deadInc = newIncarnationId();
    const curInc  = newIncarnationId();
    seedInstance(deadInc); seedInstance(curInc);
    db.prepare(
      `INSERT INTO spans (span_id, trace_id, incarnation_id, kind, name, started_at)
       VALUES ('spn_o', 'trc_x', ?, 'tool', 'echo', ?)`,
    ).run(deadInc, new Date().toISOString());
    const r = sweepStuckAttempts(db, { currentIncarnationId: curInc, thresholdMs: 60_000 });
    expect(r.reclaimedSpans).toBe(1);
    const spanRow = db.prepare(`SELECT status, error_class FROM spans WHERE span_id = 'spn_o'`)
      .get() as { status: string; error_class: string };
    expect(spanRow.status).toBe('cancelled');
    expect(spanRow.error_class).toBe('OrphanedSpan');
  });

  it('idempotent: second sweep against same state touches zero', () => {
    const deadInc = newIncarnationId();
    const curInc  = newIncarnationId();
    seedInstance(deadInc); seedInstance(curInc);
    const runId = seedRun(deadInc);
    createAttempt(db, { runId, incarnationId: deadInc, startedAt: '2026-01-01T00:00:00.000Z' });
    sweepStuckAttempts(db, { currentIncarnationId: curInc, thresholdMs: 1000 });
    const second = sweepStuckAttempts(db, { currentIncarnationId: curInc, thresholdMs: 1000 });
    expect(second.reclaimedAttempts).toBe(0);
    expect(second.reclaimedSpans).toBe(0);
  });

  it('zero candidates: clean noop', () => {
    const r = sweepStuckAttempts(db, { currentIncarnationId: newIncarnationId(), thresholdMs: 1000 });
    expect(r.reclaimedAttempts).toBe(0);
    expect(r.reclaimedSpans).toBe(0);
    expect(r.attemptIds).toEqual([]);
    expect(r.spanIds).toEqual([]);
  });
});
