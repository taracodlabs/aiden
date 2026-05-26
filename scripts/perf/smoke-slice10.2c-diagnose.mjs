// Diagnose: did the REPL "list files" turn write ANYTHING to run_events?
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Local', 'aiden', 'daemon', 'daemon.db');
const db = new Database(dbPath, { readonly: true });

// Most recent runs (REPL or daemon).
const runs = db.prepare(`
  SELECT id, session_id, instance_id, status, finish_reason, started_at,
         (SELECT COUNT(*) FROM run_events WHERE run_id = runs.id) AS event_count
    FROM runs
   ORDER BY id DESC
   LIMIT 8
`).all();
console.log(`Most recent 8 runs:`);
for (const r of runs) {
  const ts = new Date(r.started_at).toISOString().slice(11, 19);
  console.log(`  run=${r.id}  session=${r.session_id.slice(0, 36)}…  status=${r.status}/${r.finish_reason ?? '—'}  events=${r.event_count}  ts=${ts}`);
}

// Pick the latest REPL-origin run (session_id NOT LIKE 'trigger:%').
const replRun = db.prepare(`
  SELECT id, session_id, started_at
    FROM runs
   WHERE session_id NOT LIKE 'trigger:%'
   ORDER BY id DESC
   LIMIT 1
`).get();
console.log(`\nLatest REPL run: ${JSON.stringify(replRun)}`);

if (replRun) {
  const events = db.prepare(`
    SELECT id, category, kind, name, source, status, seq, payload
      FROM run_events
     WHERE run_id = ?
     ORDER BY id ASC
  `).all(replRun.id);
  console.log(`\nrun_events for run ${replRun.id} (${events.length} rows):`);
  for (const e of events) {
    const pay = e.payload ? e.payload.slice(0, 80) : '';
    console.log(`  id=${e.id} seq=${e.seq} category=${e.category} kind=${e.kind} name=${e.name} source=${e.source} status=${e.status}  payload=${pay}`);
  }

  // Also check the session's full event count across all runs in it.
  const allInSession = db.prepare(`
    SELECT COUNT(*) AS c
      FROM run_events e
      JOIN runs r ON r.id = e.run_id
     WHERE r.session_id = ?
  `).get(replRun.session_id);
  console.log(`\nTotal events across this REPL session (${replRun.session_id}): ${allInSession.c}`);
}

db.close();
