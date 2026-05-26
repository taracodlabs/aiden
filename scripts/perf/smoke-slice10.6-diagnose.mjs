// Diagnose Slice 10.6 smoke result by inspecting the daemon DB for
// what events landed during the user's "create test.txt" turn.
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Local', 'aiden', 'daemon', 'daemon.db');
const db = new Database(dbPath, { readonly: true });

// Most recent REPL run.
const replRun = db.prepare(`
  SELECT id, session_id, started_at, status
    FROM runs
   WHERE session_id NOT LIKE 'trigger:%'
   ORDER BY id DESC
   LIMIT 1
`).get();
console.log(`Latest REPL run: ${JSON.stringify(replRun)}`);

if (replRun) {
  const events = db.prepare(`
    SELECT id, category, kind, name, source, status, summary
      FROM run_events
     WHERE run_id = ?
     ORDER BY id ASC
  `).all(replRun.id);
  console.log(`\nrun_events for run ${replRun.id} (${events.length} rows):`);
  for (const e of events) {
    console.log(`  id=${e.id} ${e.category}/${e.kind} name=${e.name} source=${e.source} status=${e.status}  ${e.summary ?? ''}`);
  }

  // Specifically look for any approval events.
  const approvalEvents = events.filter((e) => e.category === 'approval');
  console.log(`\napproval events: ${approvalEvents.length}`);

  // Look for file_write tool calls.
  const fileWriteEvents = events.filter((e) =>
    e.summary && (e.summary.includes('file_write') || e.summary.includes('write_file')));
  console.log(`file_write tool_call events: ${fileWriteEvents.length}`);
}

db.close();
