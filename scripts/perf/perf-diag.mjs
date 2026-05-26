/**
 * Slice 10.8 perf diagnosis — DB row counts, hot-path query timings,
 * index coverage check. No code modifications; pure read against the
 * production daemon.db.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Local', 'aiden', 'daemon', 'daemon.db');
const db = new Database(dbPath, { readonly: true });

console.log(`DB: ${dbPath}\n`);

// ─── Row counts ──────────────────────────────────────────────────────
for (const t of ['runs', 'run_events', 'tasks']) {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
    console.log(`${t.padEnd(12)} rows: ${r.c}`);
  } catch (e) {
    console.log(`${t.padEnd(12)} ERROR: ${e.message}`);
  }
}

// ─── Hot-path query timings (best-of-5 to filter cold-cache outliers) ──
function timeQuery(label, fn) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1_000_000);
  }
  samples.sort((a, b) => a - b);
  console.log(`  ${label.padEnd(60)} min=${samples[0].toFixed(2)}ms  med=${samples[2].toFixed(2)}ms  max=${samples[4].toFixed(2)}ms`);
}

console.log(`\nHot-path query timings (5 samples, sorted):`);

// emitEventRich's per-call seq lookup. This fires PER EMITTED EVENT.
const recentRun = db.prepare(`SELECT id FROM runs ORDER BY id DESC LIMIT 1`).get();
const sampleRunId = recentRun?.id ?? 1;
timeQuery(`SELECT MAX(seq)+1 FROM run_events WHERE run_id=${sampleRunId}`,
  () => db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE run_id = ?`).get(sampleRunId));

// emitEventRich's session_id lookup (only fires when caller doesn't pre-pass)
timeQuery(`SELECT session_id FROM runs WHERE id=${sampleRunId}`,
  () => db.prepare(`SELECT session_id FROM runs WHERE id = ?`).get(sampleRunId));

// listEventsScoped's current_run query (used by /trace recent + trace_query)
timeQuery(`SELECT * FROM run_events WHERE run_id=? ORDER BY ts DESC LIMIT 200`,
  () => db.prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT ?`).all(sampleRunId, 200));

// listEventsScoped current_session query
const recentSession = db.prepare(`SELECT session_id FROM run_events WHERE session_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
if (recentSession) {
  timeQuery(`SELECT * FROM run_events WHERE session_id=? ORDER BY ts DESC LIMIT 200`,
    () => db.prepare(`SELECT * FROM run_events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?`).all(recentSession.session_id, 200));
}

// Task lookups
timeQuery(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50`,
  () => db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`).all(50));

// ─── Index coverage for hot paths ────────────────────────────────────
console.log(`\nIndex coverage check (EXPLAIN QUERY PLAN):`);
const eqp = (label, sql, params = []) => {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  console.log(`  ${label}`);
  for (const p of plan) console.log(`    ${p.detail}`);
};
eqp('emitEventRich seq lookup',
  `SELECT COALESCE(MAX(seq), 0) FROM run_events WHERE run_id = ?`, [sampleRunId]);
eqp('listEventsScoped current_run',
  `SELECT * FROM run_events WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT 200`, [sampleRunId]);
if (recentSession) {
  eqp('listEventsScoped current_session',
    `SELECT * FROM run_events WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 200`, [recentSession.session_id]);
}

// ─── INSERT timing — simulate emitEventRich write cost ───────────────
// Read-only handle can't INSERT; open a separate read-write handle to
// a tmp copy of the schema for write timing. Skip — we'd need to write
// to the production DB or copy it. Just measure the SELECT-MAX-seq +
// the SELECT-session-id pair which is what every emitEventRich does
// BEFORE its INSERT. Those two SELECTs are the per-call cost.

db.close();

// ─── INSERT timing on a fresh tmp DB so we measure the WAL write cost ──
console.log(`\nemitEventRich INSERT timing (fresh tmp DB, samples):`);
// open a fresh tmp DB, run migrations via dist, time INSERT
const fs = await import('node:fs');
const tmpPath = path.join(os.tmpdir(), `aiden-perf-${Date.now()}.db`);
const tmpDb = new Database(tmpPath);
const { createRequire } = await import('node:module');
const req = createRequire(import.meta.url);
const migs = req(path.resolve('dist/core/v4/daemon/db/migrations.js'));
migs.runMigrations(tmpDb);
// Seed instance + run row so FK is satisfied
tmpDb.prepare(`INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version) VALUES (?, ?, ?, ?, ?, ?)`)
  .run('perf-inst', process.pid, 'localhost', Date.now(), Date.now(), '4.10.0-perf');
const runRes = tmpDb.prepare(`INSERT INTO runs (session_id, instance_id, status, started_at) VALUES (?, ?, ?, ?)`)
  .run('perf-sess', 'perf-inst', 'running', Date.now());
const tmpRunId = Number(runRes.lastInsertRowid);

// Time the actual emitEventRich INSERT (the heavy 19-column one).
const insertStmt = tmpDb.prepare(`INSERT INTO run_events (
  run_id, session_id, turn_id, seq, ts,
  category, kind, name,
  tool_call_id, parent_event_id,
  status, duration_ms, summary,
  payload, payload_truncated, payload_bytes, payload_ref,
  visibility, source
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function timeInsert(label, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    // Compute seq + insert (mirrors emitEventRich)
    const seqRow = tmpDb.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE run_id = ?`).get(tmpRunId);
    insertStmt.run(
      tmpRunId, 'perf-sess', null, seqRow.m + 1, Date.now(),
      'task', 'task.update', 'ui_task_update',
      null, null,
      null, null, 'sample summary',
      '{"sample":"payload"}', 0, null, null,
      'model', 'repl',
    );
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1_000_000);
  }
  samples.sort((a, b) => a - b);
  console.log(`  ${label.padEnd(50)} min=${samples[0].toFixed(2)}ms  med=${samples[Math.floor(n/2)].toFixed(2)}ms  max=${samples[n-1].toFixed(2)}ms (n=${n})`);
}

timeInsert('seq-lookup + INSERT (1st 5 — cold)', 5);
timeInsert('seq-lookup + INSERT (next 50 — warm)', 50);
timeInsert('seq-lookup + INSERT (next 500 — sustained)', 500);

// TaskStore write cost
const taskStore = req(path.resolve('dist/core/v4/daemon/taskStore.js')).createTaskStore({ db: tmpDb });
function timeTaskCreate(n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    taskStore.create({ title: `task ${i}`, goal: `goal ${i}`, sessionId: 'perf-sess', channelId: 'repl', status: 'active' });
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1_000_000);
  }
  samples.sort((a, b) => a - b);
  console.log(`  ${`taskStore.create (n=${n})`.padEnd(50)} min=${samples[0].toFixed(2)}ms  med=${samples[Math.floor(n/2)].toFixed(2)}ms  max=${samples[n-1].toFixed(2)}ms`);
}
timeTaskCreate(20);
timeTaskCreate(100);

tmpDb.close();
fs.unlinkSync(tmpPath);
try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
