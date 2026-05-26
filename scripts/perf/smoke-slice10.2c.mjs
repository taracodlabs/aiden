// Phase D smoke for v4.10 Slice 10.2c.
// Validates the between-turns read path works through the factories
// using an isolated DB + the exact pattern production uses (callbacks
// that read from a long-lived ref).

import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createRunStore }  = require(path.resolve('dist/core/v4/daemon/runStore.js'));
const { categorizeEvent } = require(path.resolve('dist/core/v4/daemon/eventCategories.js'));
const { runMigrations }   = require(path.resolve('dist/core/v4/daemon/db/migrations.js'));
const { makeTraceQueryTool } = require(path.resolve('dist/tools/v4/trace/traceQuery.js'));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-slice102c-smoke-'));
const db  = new Database(path.join(tmp, 'daemon.db'));
runMigrations(db);
db.prepare(
  `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run('smoke-inst', process.pid, 'localhost', Date.now(), Date.now(), '4.10.0-smoke');

const store = createRunStore({ db });

// Simulate the production refs.
const replParentRunRef = { runId: null, sessionId: null, chatSessionId: null };

// Simulate ChatSession.run() init — publish the long-lived id.
const CHAT_SESSION_ID = 'chat-sess-2026-05-26-smoke';
replParentRunRef.chatSessionId = CHAT_SESSION_ID;

// ─── Simulate a turn: create run, emit events, complete, then NULL
//     turn-scoped refs (matches chatSession.ts:1641-1642). ───
const runId = store.create({ sessionId: CHAT_SESSION_ID, instanceId: 'smoke-inst', status: 'running' });
replParentRunRef.runId = runId;
replParentRunRef.sessionId = CHAT_SESSION_ID;

// Fire 3 ui_* emissions like chatSession does.
for (const name of ['ui_task_update', 'ui_task_done', 'ui_command_result']) {
  const tags = categorizeEvent(name);
  store.emitEventRich({
    runId,
    category:  tags.category,
    kind:      tags.kind,
    name,
    sessionId: CHAT_SESSION_ID,
    payload:   { name },
    source:    'repl',
  });
}
store.setStatus(runId, 'completed', { finishReason: 'stop' });

// Turn finished — production clears the turn-scoped refs.
replParentRunRef.runId = null;
replParentRunRef.sessionId = null;
// chatSessionId stays populated.

console.log(`After turn: runId=${replParentRunRef.runId} sessionId=${replParentRunRef.sessionId} chatSessionId=${replParentRunRef.chatSessionId}`);

// ─── Now exercise the trace_query factory with the production wiring
//     pattern: resolveSessionId reads chatSessionId (long-lived). ───
const tool = makeTraceQueryTool({
  runStore:         store,
  resolveSessionId: () => replParentRunRef.chatSessionId,    // ← Slice 10.2c fix
  resolveRunId:     () => replParentRunRef.runId,             // null between turns
});

const r1 = await tool.execute({}, { cwd: tmp, paths: {} });
console.log(`\ntrace_query default scope (current_session) BETWEEN TURNS:`);
console.log(`  success=${r1.success} count=${r1.count ?? '-'} error=${r1.error ?? '-'}`);
const repro = r1.success && r1.count === 3;
console.log(`  ${repro ? '✅ PASS' : '❌ FAIL'} — the bug user reported is fixed`);

// Also verify scope='current_run' correctly fails between turns (no
// in-flight turn → null runId → friendly error, no crash).
const r2 = await tool.execute({ scope: 'current_run' }, { cwd: tmp, paths: {} });
console.log(`\ntrace_query scope='current_run' BETWEEN TURNS:`);
console.log(`  success=${r2.success} error=${r2.error ?? '-'}`);
const noRunGuard = !r2.success && /no REPL turn is in flight/i.test(r2.error ?? '');
console.log(`  ${noRunGuard ? '✅ PASS' : '❌ FAIL'} — defensive guard fires correctly`);

// And the regression case: with chatSessionId null (post-quit edge),
// the default scope errors with the differentiated message.
replParentRunRef.chatSessionId = null;
const r3 = await tool.execute({}, { cwd: tmp, paths: {} });
console.log(`\ntrace_query default scope POST-QUIT (chatSessionId null):`);
console.log(`  success=${r3.success} error=${r3.error ?? '-'}`);
const postQuit = !r3.success && /no REPL session active/i.test(r3.error ?? '');
console.log(`  ${postQuit ? '✅ PASS' : '❌ FAIL'} — clearer message vs pre-10.2c`);

db.close();
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== Slice 10.2c smoke summary ===`);
console.log(`Between-turn read works (the actual bug)      ${repro ? '✅' : '❌'}`);
console.log(`current_run scope null-runId guard            ${noRunGuard ? '✅' : '❌'}`);
console.log(`Post-quit chatSessionId-null defensive guard  ${postQuit ? '✅' : '❌'}`);
process.exit((repro && noRunGuard && postQuit) ? 0 : 1);
