// Phase D smoke harness for v4.10 Slice 10.2b.
// Direct better-sqlite3 inspection of the production DB.
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Local', 'aiden', 'daemon', 'daemon.db');
console.log(`DB: ${dbPath}`);

const db = new Database(dbPath, { readonly: true });

// Phase D.1.a — schema version (table is schema_version, single row id=1).
const ver = db.prepare('SELECT version FROM schema_version WHERE id = 1').get();
console.log(`\n[D.1.a] schema_version: ${ver?.version} (expect ≥ 13)`);

// Phase D.1.b — run_events row shape, newest 5 rows.
const rows = db.prepare(`
  SELECT id, kind, category, name, session_id, seq, source, status, payload_truncated
    FROM run_events
   ORDER BY id DESC
   LIMIT 5
`).all();
console.log(`\n[D.1.b] newest 5 run_events rows:`);
for (const r of rows) {
  console.log(JSON.stringify(r));
}

// Phase D.1.b extra — sample of legacy rows (oldest, where backfill should have applied)
const legacy = db.prepare(`
  SELECT id, kind, category, name, session_id, seq
    FROM run_events
   ORDER BY id ASC
   LIMIT 5
`).all();
console.log(`\n[D.1.b'] oldest 5 run_events rows (post-backfill):`);
for (const r of legacy) {
  console.log(JSON.stringify(r));
}

// Distribution of category values.
const catDist = db.prepare(`SELECT category, COUNT(*) AS c FROM run_events GROUP BY category ORDER BY c DESC`).all();
console.log(`\n[D.1.b''] category distribution:`);
for (const r of catDist) console.log(`  ${r.category}: ${r.c}`);

// Phase D.1.c — indexes on run_events.
const idx = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_events' ORDER BY name`).all();
console.log(`\n[D.1.c] run_events indexes (${idx.length}):`);
for (const i of idx) {
  console.log(`  ${i.name}`);
}

db.close();
