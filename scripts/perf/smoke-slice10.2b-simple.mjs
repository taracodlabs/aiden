// Slice 10.2b — simple smoke. Read the production daemon.db, look for
// REPL-side emissions (source='repl' OR session_id NOT LIKE 'trigger:%')
// and verify they show rich categorization (category != 'legacy', name
// populated, etc.). If we find any, the REPL emission path is validated
// end-to-end against the real binary.

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), 'AppData', 'Local', 'aiden', 'daemon', 'daemon.db');
const db = new Database(dbPath, { readonly: true });

console.log(`DB: ${dbPath}\n`);

// All rows where source='repl' (these are NEW emissions from chatSession path).
const replRows = db.prepare(`
  SELECT id, kind, category, name, session_id, seq, source, status
    FROM run_events
   WHERE source = 'repl'
   ORDER BY id DESC
   LIMIT 20
`).all();
console.log(`REPL-source rows: ${replRows.length}`);
for (const r of replRows) console.log(JSON.stringify(r));

// All rows where source is set (not null). source column only gets
// populated by emitEventRich — pre-migration legacy rows have NULL.
const sourcedRows = db.prepare(`
  SELECT id, kind, category, name, session_id, seq, source, status
    FROM run_events
   WHERE source IS NOT NULL
   ORDER BY id DESC
   LIMIT 20
`).all();
console.log(`\nAll rows with source populated (proves emitEventRich wrote them): ${sourcedRows.length}`);
for (const r of sourcedRows) console.log(JSON.stringify(r));

// Group by (category, source) to see the distribution of rich emissions.
const dist = db.prepare(`
  SELECT category, source, COUNT(*) AS c
    FROM run_events
   WHERE source IS NOT NULL
   GROUP BY category, source
   ORDER BY c DESC
`).all();
console.log(`\nDistribution of rich-emitted rows (category × source):`);
for (const r of dist) console.log(`  ${r.category}/${r.source}: ${r.c}`);

// Check whether any non-legacy categories appear (proves rich path
// fired post-migration somewhere).
const nonLegacy = db.prepare(`SELECT COUNT(*) AS c FROM run_events WHERE category != 'legacy'`).get();
console.log(`\nNon-legacy rows total: ${nonLegacy.c}`);

// And: sample a couple of payloads with payload_truncated/payload_bytes
// to confirm truncation accounting is working.
const truncated = db.prepare(`
  SELECT id, kind, name, payload_truncated, payload_bytes,
         LENGTH(payload) AS payload_len
    FROM run_events
   WHERE payload_truncated = 1
   ORDER BY id DESC
   LIMIT 3
`).all();
console.log(`\nRows with payload_truncated=1: ${truncated.length}`);
for (const r of truncated) console.log(JSON.stringify(r));

db.close();
