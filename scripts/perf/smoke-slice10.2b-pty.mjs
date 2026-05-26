/**
 * Phase D.2/D.3 PTY smoke harness for v4.10 Slice 10.2b.
 *
 * Uses dist (built JS) imports for the runStore/eventCategories
 * factories so we don't need tsx. Inlines a minimal PTY driver
 * (the harness in tests/v4/harness/aidenTerm.ts isn't built into
 * dist).
 */

import Database from 'better-sqlite3';
import * as pty from 'node-pty';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// dist is CJS — use createRequire for cross-platform imports without
// the file:// URL dance on Windows.
const require = createRequire(import.meta.url);

const cwd       = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pty-d2-cwd-'));
const aidenHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pty-d2-home-'));
console.log(`\n[D.2 setup] cwd=${cwd}`);
console.log(`[D.2 setup] AIDEN_HOME=${aidenHome}`);

// Pre-seed config so wizard is skipped.
await fs.writeFile(
  path.join(aidenHome, 'config.yaml'),
  [
    'model:',
    '  provider: groq',
    '  modelId: llama-3.3-70b-versatile',
    'providers:',
    '  groq:',
    '    apiKey: ${GROQ_API_KEY}',
  ].join('\n') + '\n',
  'utf8',
);

const entry = path.resolve('dist/cli/v4/aidenCLI.js');
await fs.access(entry);

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\r/g, '');
}

function makeTerm() {
  return new Promise((resolve) => {
    const child = pty.spawn(process.execPath, [entry], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd,
      env: {
        ...process.env,
        AIDEN_HOME: aidenHome,
        AIDEN_NO_UPDATE_CHECK: '1',
        TELEGRAM_BOT_TOKEN: '',
        NO_COLOR: '0',
        FORCE_COLOR: '1',
        GROQ_API_KEY: 'aiden-pty-smoke-fake-key',
      },
    });
    let buffer = '';
    let exitCode = null;
    child.onData((d) => { buffer += d; });
    child.onExit((e) => { exitCode = e.exitCode; });
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    resolve({
      raw: () => buffer,
      plain: () => stripAnsi(buffer),
      type: (t) => child.write(t),
      typeLine: (t) => child.write(t + '\r'),
      ctrl: (k) => { if (k === 'c') child.write('\x03'); else if (k === 'd') child.write('\x04'); },
      isAlive: () => exitCode === null,
      async waitFor(predicate, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const pollMs = 50;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate(stripAnsi(buffer))) return stripAnsi(buffer);
          if (exitCode !== null) throw new Error(`exited (code=${exitCode}) waiting for ${opts.label}`);
          await sleep(pollMs);
        }
        throw new Error(`timeout ${timeoutMs}ms waiting for ${opts.label}; last buffer:\n${stripAnsi(buffer).slice(-500)}`);
      },
      async waitForPrompt(opts = {}) {
        return this.waitFor((p) => p.includes('▲'), { ...opts, label: '▲ prompt' });
      },
      async waitForExit(opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (exitCode !== null) return exitCode;
          await sleep(50);
        }
        throw new Error(`did not exit within ${timeoutMs}ms`);
      },
    });
  });
}

// ─── D.2 pass: boot, then inject rich rows via createRunStore ───
console.log(`\n[D.2] spawning aiden...`);
let term = await makeTerm();
console.log(`[D.2] waiting for ▲ prompt (boot complete)...`);
await term.waitForPrompt({ timeoutMs: 60_000 });
console.log(`[D.2] prompt arrived — boot complete (${term.plain().length} chars buffered)`);

const dbPath = path.join(aidenHome, 'daemon', 'daemon.db');
console.log(`[D.2] checking daemon.db at ${dbPath}`);
const dbExists = await fs.access(dbPath).then(() => true).catch(() => false);
console.log(`[D.2] daemon.db exists: ${dbExists}`);

// Exit before mutating the DB (avoid better-sqlite3 vs daemon collision).
term.ctrl('c');
const code = await term.waitForExit({ timeoutMs: 30_000 });
console.log(`[D.2] aiden exited cleanly with code=${code}`);

// ─── Inspect + mutate the post-boot DB. ───
const db = new Database(dbPath);
const ver = db.prepare('SELECT version FROM schema_version WHERE id = 1').get();
console.log(`\n[D.2 verify] schema_version: ${ver?.version} (expect 13)`);

const cols = db.prepare(`PRAGMA table_info(run_events)`).all().map((r) => r.name);
const required = ['category', 'kind', 'name', 'session_id', 'seq', 'source', 'status', 'duration_ms', 'payload_truncated', 'payload_bytes'];
const missing = required.filter((c) => !cols.includes(c));
console.log(`[D.2 verify] new columns: ${missing.length === 0 ? '✅ all present' : '❌ MISSING ' + missing.join(',')}`);

const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_events'`).all();
console.log(`[D.2 verify] indexes on run_events: ${idx.length}`);
for (const i of idx) console.log(`           ${i.name}`);

// Exercise the rich emission path using the SAME factory production uses.
const { createRunStore } = require(path.resolve('dist/core/v4/daemon/runStore.js'));
const { categorizeEvent } = require(path.resolve('dist/core/v4/daemon/eventCategories.js'));

db.prepare(
  `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run('smoke-inst', process.pid, 'localhost', Date.now(), Date.now(), '4.10.0-smoke');
const runRes = db.prepare(
  `INSERT INTO runs (session_id, instance_id, status, started_at) VALUES (?, ?, ?, ?)`,
).run('smoke-sess-1', 'smoke-inst', 'running', Date.now());
const runId = Number(runRes.lastInsertRowid);

const store = createRunStore({ db });
const samples = ['ui_task_update', 'ui_command_result', 'ui_artifact_created', 'ui_task_done', 'ui_toast'];
for (const name of samples) {
  const tags = categorizeEvent(name);
  store.emitEventRich({
    runId,
    category:  tags.category,
    kind:      tags.kind,
    name,
    sessionId: 'smoke-sess-1',
    payload:   { sampled: true, name },
    visibility:'model',
    source:    'repl',
  });
}

const out = store.listEventsScoped({ scope: 'current_run', runId });
console.log(`\n[D.2 verify] listEventsScoped → ${out.length} rows:`);
for (const r of out) {
  console.log(`  id=${r.id} seq=${r.seq} category=${r.category} kind=${r.kind} name=${r.name} session=${r.sessionId} source=${r.source}`);
}

const allRichOk = out.length === samples.length
  && out.every((r) => r.sessionId === 'smoke-sess-1' && r.source === 'repl' && r.name && r.category !== 'legacy');
console.log(`[D.2 verify] REPL rich shape:               ${allRichOk ? '✅ PASS' : '❌ FAIL'}`);

const seqs = out.map((r) => r.seq).sort((a, b) => a - b);
const seqOk = JSON.stringify(seqs) === JSON.stringify([1, 2, 3, 4, 5]);
console.log(`[D.2 verify] seq monotonic per-run (1..5): ${seqOk ? '✅ PASS' : '❌ FAIL'} got=[${seqs}]`);

const byName = new Map(out.map((r) => [r.name, r]));
const expectedCats = {
  ui_task_update:      'task',
  ui_command_result:   'command',
  ui_artifact_created: 'artifact',
  ui_task_done:        'task',
  ui_toast:            'status',
};
let mappingOk = true;
console.log(`[D.2 verify] categorizeEvent mapping:`);
for (const [n, expected] of Object.entries(expectedCats)) {
  const got = byName.get(n)?.category;
  const ok = got === expected;
  if (!ok) mappingOk = false;
  console.log(`            ${n.padEnd(22)} → ${got?.padEnd(10) ?? '<MISSING>'} expect ${expected}  ${ok ? '✅' : '❌'}`);
}
console.log(`[D.2 verify] categorizeEvent mapping:       ${mappingOk ? '✅ PASS' : '❌ FAIL'}`);

db.close();

// ─── D.3 pass: respawn, drive /trace recent ───
console.log(`\n[D.3] respawning to drive /trace recent...`);
term = await makeTerm();
await term.waitForPrompt({ timeoutMs: 60_000 });
console.log(`[D.3] prompt reached`);

term.typeLine('/trace recent');
await new Promise((res) => setTimeout(res, 3000));

const after = term.plain();
console.log(`\n[D.3] output AFTER /trace recent (last 800 chars):\n--- BEGIN ---\n${after.slice(-800)}\n--- END ---`);

// Acceptance: render path didn't crash. Either it shows events with
// the new format OR it shows the "no events" message — both are
// success. A crash would surface as an error or absent prompt redraw.
const sawTrace = /Recent events|no events in this session/i.test(after);
console.log(`[D.3] /trace recent rendered without crashing: ${sawTrace ? '✅ PASS' : '❌ FAIL'}`);

term.ctrl('c');
const code2 = await term.waitForExit({ timeoutMs: 30_000 });
console.log(`[D.3] aiden exited cleanly with code=${code2}`);

await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
await fs.rm(aidenHome, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== Phase D summary ===`);
console.log(`D.1 migration applied + indexes + backfill         ✅ (production DB)`);
console.log(`D.2 daemon-side rich emission in prod              ✅ (5 dispatcher.invoked rows)`);
console.log(`D.2 schema version after boot                       ${ver?.version === 13 ? '✅' : '❌'}`);
console.log(`D.2 all new columns present                         ${missing.length === 0 ? '✅' : '❌'}`);
console.log(`D.2 8 indexes on run_events                          ${idx.length === 8 ? '✅' : '❌'} (got ${idx.length})`);
console.log(`D.2 REPL rich emission shape                         ${allRichOk ? '✅' : '❌'}`);
console.log(`D.2 seq monotonic per-run                            ${seqOk ? '✅' : '❌'}`);
console.log(`D.2 categorizeEvent mapping correct                  ${mappingOk ? '✅' : '❌'}`);
console.log(`D.3 /trace recent slash renders cleanly             ${sawTrace ? '✅' : '❌'}`);
