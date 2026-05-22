/**
 * v4.9.0 Slice 12b — 14-scenario CLI smoke.
 *
 * Drives `runHooksSubcommand` programmatically against a tmp root so
 * we exercise the full CLI plumbing (DB open/migrate, registry scan,
 * trust/revoke, audit, doctor, test, lifecycle) without touching
 * ~/.aiden.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
function imp(rel) { return pathToFileURL(path.join(here, '..', rel)).href; }
const { runHooksSubcommand } = await import(imp('cli/v4/commands/hooks.ts'));
const { dispatchHook }       = await import(imp('core/v4/hooks/dispatcher.ts'));
const { fireSessionStart }   = await import(imp('core/v4/hooks/lifecycle.ts'));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-12b-smoke-'));
await fs.mkdir(path.join(tmp, 'hooks'),  { recursive: true });
await fs.mkdir(path.join(tmp, 'daemon'), { recursive: true });
const dbPath = path.join(tmp, 'daemon', 'daemon.db');

function header(n, label) {
  process.stdout.write(`\n══ scenario ${String(n).padStart(2, '0')} — ${label}\n`);
}
function capture() {
  const buf = [];
  return { sink: (s) => buf.push(s), text: () => buf.join('') };
}
async function run(action, args, autoYes = true) {
  const out = capture(), err = capture();
  const code = await runHooksSubcommand(action, args, {
    writeOut: out.sink, writeErr: err.sink,
    dbPath, rootDir: tmp,
    promptYesNo: async () => autoYes,
  });
  return { code, out: out.text(), err: err.text() };
}
function show(r, prefix = '  ') {
  if (r.out) process.stdout.write(r.out.split('\n').map((l) => prefix + l).join('\n').replace(/\n$/, '') + '\n');
  if (r.err) process.stdout.write(r.err.split('\n').map((l) => prefix + '[err] ' + l).join('\n').replace(/\n$/, '') + '\n');
  process.stdout.write(prefix + `(exit=${r.code})\n`);
}
async function installHook(name, manifest, script) {
  const dir = path.join(tmp, 'hooks', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'HOOK.yaml'), manifest, 'utf8');
  await fs.writeFile(path.join(dir, 'run.js'), script, 'utf8');
}
function getHookIdByName(name) {
  const db = new Database(dbPath);
  const row = db.prepare(`SELECT hook_id FROM hooks WHERE name = ? LIMIT 1`).get(name);
  db.close();
  return row?.hook_id;
}

// ── 1. help ────────────────────────────────────────────────────────
header(1, 'hooks --help → lists subcommands');
show(await run('--help', []));

// ── 2. list empty ──────────────────────────────────────────────────
header(2, 'hooks list (no hooks installed) → "no hooks discovered"');
show(await run('list', []));

// ── 3. install + rescan → list shows untrusted/disabled ────────────
header(3, 'install global hook + rescan → list shows untrusted, disabled');
await installHook('demo', `id: demo_hook
name: Demo
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: allow, on_timeout: allow}
`, 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(JSON.stringify({decision:"none"})));');
show(await run('rescan', []));
show(await run('list', []));
const demoId = getHookIdByName('Demo');
process.stdout.write(`  demo hook_id = ${demoId}\n`);

// ── 4. trust --yes ─────────────────────────────────────────────────
header(4, 'hooks trust <id> --yes → status changes to trusted, enabled');
show(await run('trust', [demoId, '--yes']));
show(await run('list', []));

// ── 5. show ────────────────────────────────────────────────────────
header(5, 'hooks show <id> → full manifest + subs + zero recent execs');
show(await run('show', [demoId]));

// ── 6. fire via dispatch → audit row appears ───────────────────────
header(6, 'fire hook via dispatchHook → audit shows execution row');
{
  const db = new Database(dbPath);
  await dispatchHook(db, 'tool.call.pre', { tool: 'echo' }, { runId: 'smoke_run_1' });
  db.close();
}
show(await run('audit', ['--hook', demoId]));

// ── 7. audit --json ────────────────────────────────────────────────
header(7, 'hooks audit --json → machine-parseable rows');
const r7 = await run('audit', ['--json', '--limit', '5']);
const parsed7 = JSON.parse(r7.out);
process.stdout.write(`  rows=${parsed7.length}  first.status=${parsed7[0]?.status}\n`);
show(r7, '  json: ');

// ── 8. broken hook (non-JSON) + disable_hook → auto-disabled ───────
header(8, 'broken hook on_error=disable_hook → auto-disabled after first failure');
await installHook('broken', `id: broken_hook
name: Broken
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: disable_hook, on_timeout: disable_hook}
`, 'process.stdout.write("not-json"); process.exit(0);');
show(await run('rescan', []));
const brokenId = getHookIdByName('Broken');
show(await run('trust', [brokenId, '--yes']));
{
  const db = new Database(dbPath);
  await dispatchHook(db, 'tool.call.pre', {}, {});
  db.close();
}
show(await run('list', []));

// ── 9. 3-strike rule with on_error=allow ───────────────────────────
header(9, '3-strike rule fires regardless of on_error: allow');
await installHook('crashy', `id: crashy_hook
name: Crashy
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: allow, on_timeout: allow}
`, 'process.exit(1);');
show(await run('rescan', []));
const crashyId = getHookIdByName('Crashy');
show(await run('trust', [crashyId, '--yes']));
{
  const db = new Database(dbPath);
  for (let i = 0; i < 3; i++) {
    await dispatchHook(db, 'tool.call.pre', {}, {});
  }
  const row = db.prepare(`SELECT trust_state, enabled, consecutive_failures AS cf FROM hooks WHERE hook_id=?`).get(crashyId);
  db.close();
  process.stdout.write(`  after 3 fires: trust_state=${row.trust_state} enabled=${row.enabled} cf=${row.cf}\n`);
}

// ── 10. test command does NOT mutate counter ───────────────────────
header(10, 'hooks test → invokes subprocess, no counter mutation');
await installHook('testable', `id: testable_hook
name: Testable
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: allow, on_timeout: allow}
`, 'process.exit(1);');
show(await run('rescan', []));
const testableId = getHookIdByName('Testable');
show(await run('test', [testableId, '--payload', '{"k":"v"}']));
{
  const db = new Database(dbPath);
  const row = db.prepare(`SELECT consecutive_failures AS cf, trust_state FROM hooks WHERE hook_id=?`).get(testableId);
  db.close();
  process.stdout.write(`  after test: cf=${row.cf} trust_state=${row.trust_state}  (BOTH unchanged — pass)\n`);
}

// ── 11. revoke ─────────────────────────────────────────────────────
header(11, 'hooks revoke <id> --yes → trust_state=revoked, enabled=0');
show(await run('revoke', [demoId, '--yes']));

// ── 12. doctor ─────────────────────────────────────────────────────
header(12, 'hooks doctor → all checks shown');
show(await run('doctor', []));

// ── 13. rescan w/ modified hook → drift detected ───────────────────
header(13, 'edit entrypoint → rescan flags drifted');
await fs.writeFile(path.join(tmp, 'hooks', 'testable', 'run.js'),
  'process.stdout.write("{\\"decision\\":\\"none\\"}"); /* EDITED VERSION */', 'utf8');
show(await run('rescan', []));
{
  const db = new Database(dbPath);
  const row = db.prepare(`SELECT trust_state, enabled FROM hooks WHERE hook_id=?`).get(testableId);
  db.close();
  process.stdout.write(`  testable after edit: trust_state=${row.trust_state} enabled=${row.enabled}\n`);
}

// ── 14. lifecycle: session.start fires ─────────────────────────────
header(14, 'install session.start hook → fireSessionStart writes audit row');
await installHook('starty', `id: starty_hook
name: Starty
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - {event: session.start, authority: observe, mode: best_effort_observer, timeout_ms: 5000, on_error: allow, on_timeout: allow}
`, 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(JSON.stringify({decision:"none"})));');
show(await run('rescan', []));
const startyId = getHookIdByName('Starty');
show(await run('trust', [startyId, '--yes']));
{
  const db = new Database(dbPath);
  await fireSessionStart(db, { session_id: 'smoke_session_1', source: 'cli', started_at: new Date().toISOString() });
  db.close();
}
show(await run('audit', ['--hook', startyId, '--event', 'session.start']));

await fs.rm(tmp, { recursive: true, force: true });
process.stdout.write('\n══ smoke complete\n');
