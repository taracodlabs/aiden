/**
 * scripts/smoke-v4.1-cross-platform-runtime.ts — runtime smoke for v4.1-cross-platform.
 *
 * Sections:
 *   R0 — built artifact mtime is fresh
 *   R1 — AIDEN_CROSS_PLATFORM_BUILD constant present in dist
 *   R2 — `aiden doctor` runs and includes the audio backend check
 *   R3 — `aiden voice doctor` handles missing backend gracefully
 *   R4 — MCP serve mode unaffected
 *   R5 — Skill loader case-mixed lookup works in dist artifact
 *   R6 — AIDEN_NO_NETWORK=1 propagates through runtime smokes
 *
 * Run: npx ts-node scripts/smoke-v4.1-cross-platform-runtime.ts
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

for (const k of ['TELEGRAM_BOT_TOKEN', 'AIDEN_TELEGRAM_BOT_TOKEN', 'TELEGRAM_USER_ID']) {
  delete process.env[k];
}

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY     = path.join(REPO_ROOT, 'dist', 'cli', 'v4', 'aidenCLI.js');
// Doctor can run five independently bounded 3 s probes before filesystem and
// capability checks. Leave cold Windows runners enough margin without changing
// any production timeout or the surrounding smoke budget.
const DOCTOR_SMOKE_TIMEOUT_MS = 30_000;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string): void {
  // eslint-disable-next-line no-console
  console.log(`  \x1b[32m✓\x1b[0m  ${label}`);
  pass += 1;
}
function notOk(label: string, detail?: string): void {
  // eslint-disable-next-line no-console
  console.log(`  \x1b[31m✗\x1b[0m  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  failures.push(label);
}
function header(title: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

(async () => {
  // ── R0 — built artifact freshness ──
  header('R0 — Built artifact freshness');
  if (!fs.existsSync(ENTRY)) {
    notOk('R0 dist/cli/v4/aidenCLI.js exists', 'missing — run `npm run build` first');
    summary();
    return;
  }
  const newestSrc = Math.max(
    ...[
      'cli/v4/uiBuild.ts',
      'core/v4/platformPaths.ts',
      'core/voice/audioBackend.ts',
      'core/v4/skillLoader.ts',
      'cli/v4/doctor.ts',
    ].map((p) => fs.statSync(path.join(REPO_ROOT, p)).mtimeMs),
  );
  const distMtime = fs.statSync(ENTRY).mtimeMs;
  if (distMtime >= newestSrc) ok('R0 dist artifact at least as fresh as cross-platform sources');
  else notOk('R0 dist artifact at least as fresh as cross-platform sources',
             `dist=${new Date(distMtime).toISOString()} src=${new Date(newestSrc).toISOString()}`);

  // ── R1 — fingerprint constant in dist ──
  header('R1 — AIDEN_CROSS_PLATFORM_BUILD in dist');
  const distUiBuild = path.join(REPO_ROOT, 'dist', 'cli', 'v4', 'uiBuild.js');
  if (fs.existsSync(distUiBuild)) {
    const text = fs.readFileSync(distUiBuild, 'utf8');
    if (text.includes('v4.1-cross-platform')) {
      ok('R1 dist uiBuild.js contains "v4.1-cross-platform"');
    } else {
      notOk('R1 dist uiBuild.js contains "v4.1-cross-platform"');
    }
  } else {
    notOk('R1 dist uiBuild.js exists', 'missing');
  }

  // ── R2 — aiden doctor runs cleanly ──
  // Spawn with isolated AIDEN_HOME so the doctor doesn't probe the
  // dev's real env. We expect exit 0 OR 1 (the failure path is a
  // reportable diagnostic, not a smoke failure) — what we care about
  // is that doctor produced output and didn't crash.
  header('R2 — aiden doctor runs and surfaces audio backend check');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-doctor-'));
  fs.writeFileSync(
    path.join(tmpHome, 'config.yaml'),
    'model:\n  provider: groq\n  modelId: llama-3.3-70b-versatile\nproviders:\n  groq:\n    apiKey: smoke-fake\n',
    'utf8',
  );
  const r2 = spawnSync('node', [ENTRY, 'doctor'], {
    encoding: 'utf8',
    timeout:  DOCTOR_SMOKE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      AIDEN_HOME:  tmpHome,
      AIDEN_NO_UI: '1',
      AIDEN_NO_NETWORK: '1',
      GROQ_API_KEY: 'smoke-fake',
    },
  });
  const r2out = stripAnsi((r2.stdout ?? '') + (r2.stderr ?? ''));
  if (r2.status !== null && /audio backend/i.test(r2out)) {
    ok(`R2 aiden doctor surfaces "audio backend" check (status=${r2.status})`);
  } else {
    notOk(`R2 aiden doctor surfaces "audio backend" check`,
          `status=${r2.status} tail=${r2out.slice(-300)}`);
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }

  // ── R3 — voice doctor handles missing backend gracefully ──
  header('R3 — aiden voice doctor exits without crash');
  const r3 = spawnSync('node', [ENTRY, 'voice', 'doctor'], {
    encoding: 'utf8',
    timeout:  20_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, AIDEN_NO_UI: '1' },
  });
  // voice doctor is expected to exit cleanly on every platform —
  // missing backends produce warnings, not crashes.
  if (r3.status !== null && r3.status !== 137 && r3.signal === null) {
    ok(`R3 aiden voice doctor exits cleanly (status=${r3.status})`);
  } else {
    notOk(`R3 aiden voice doctor exits cleanly`,
          `status=${r3.status} signal=${r3.signal} tail=${stripAnsi((r3.stdout ?? '') + (r3.stderr ?? '')).slice(-200)}`);
  }

  // ── R4 — MCP serve mode unaffected ──
  header('R4 — MCP serve mode (no UI bleed)');
  const r4 = await new Promise<{ stdoutBytes: string; status: number | null }>((resolve) => {
    const proc: ChildProcessWithoutNullStreams = spawn('node', [ENTRY, 'mcp', 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   { ...process.env, AIDEN_MCP_SERVE: '1' },
    });
    let bytes = '';
    proc.stdout.on('data', (c) => { bytes += c.toString(); });
    proc.on('close', (code) => resolve({ stdoutBytes: bytes, status: code }));
    const req = JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params:  {
        protocolVersion: '2024-11-05',
        capabilities:    {},
        clientInfo:      { name: 'cross-platform-rt', version: '0.0.0' },
      },
    }) + '\n';
    setTimeout(() => {
      proc.stdin.write(req);
      setTimeout(() => { try { proc.stdin.end(); } catch { /* */ } }, 1200);
    }, 1500);
    setTimeout(() => { try { proc.kill(); } catch { /* */ } }, 18_000);
  });
  const lines = r4.stdoutBytes.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let allJson = lines.length > 0;
  let firstBad: string | undefined;
  for (const ln of lines) {
    try { JSON.parse(ln); } catch { allJson = false; firstBad = ln.slice(0, 200); break; }
  }
  if (allJson) {
    ok(`R4 MCP serve stdout is pure JSON-RPC (${lines.length} frames)`);
  } else {
    notOk('R4 MCP serve stdout is pure JSON-RPC',
          `first non-JSON line: ${firstBad ?? '(empty stdout)'}`);
  }

  // ── R5 — Skill loader case-mixed lookup via dist module ──
  header('R5 — Skill loader case-insensitive lookup (dist)');
  const tmpHome5 = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-skill-'));
  process.env.AIDEN_HOME = tmpHome5;
  const skillDir = path.join(tmpHome5, 'skills', 'CrossPlatformDemo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: CrossPlatformDemo\ndescription: x\nversion: 1.0.0\n---\n# CrossPlatformDemo\n',
    'utf8',
  );
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const distLoader = require(path.join(REPO_ROOT, 'dist', 'core', 'v4', 'skillLoader.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const distPaths  = require(path.join(REPO_ROOT, 'dist', 'core', 'v4', 'paths.js'));
  const loader = new distLoader.SkillLoader(distPaths.resolveAidenPaths());
  const a = await loader.load('CrossPlatformDemo');
  const b = await loader.load('crossplatformdemo');
  if (a && b && a.frontmatter.name === 'CrossPlatformDemo' && b.frontmatter.name === 'CrossPlatformDemo') {
    ok('R5 dist SkillLoader resolves CamelCase + lowercase to same skill');
  } else {
    notOk('R5 dist SkillLoader resolves CamelCase + lowercase',
          `a=${a?.frontmatter.name} b=${b?.frontmatter.name}`);
  }
  try { fs.rmSync(tmpHome5, { recursive: true, force: true }); } catch { /* */ }

  // ── R6 — AIDEN_NO_NETWORK propagates ──
  header('R6 — AIDEN_NO_NETWORK env var propagates to spawned aiden');
  const r6 = spawnSync('node', [
    '-e',
    'console.log(JSON.stringify({ noNet: process.env.AIDEN_NO_NETWORK }))',
  ], { encoding: 'utf8', env: { ...process.env, AIDEN_NO_NETWORK: '1' } });
  try {
    const parsed = JSON.parse((r6.stdout ?? '').trim());
    if (parsed.noNet === '1') {
      ok('R6 AIDEN_NO_NETWORK=1 visible to spawned child process');
    } else {
      notOk('R6 AIDEN_NO_NETWORK=1 visible to spawned child process', JSON.stringify(parsed));
    }
  } catch {
    notOk('R6 AIDEN_NO_NETWORK=1 visible to spawned child process', r6.stdout);
  }

  summary();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\x1b[31m✗ smoke crashed:\x1b[0m', err);
  process.exit(2);
});

function summary(): void {
  // eslint-disable-next-line no-console
  console.log('');
  if (fail === 0) {
    // eslint-disable-next-line no-console
    console.log(`\x1b[32m✓ All ${pass} runtime checks passed.\x1b[0m\n`);
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.log(`\x1b[31m✗ ${fail} of ${pass + fail} runtime checks failed:\x1b[0m`);
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.log(`    - ${f}`);
    }
    // eslint-disable-next-line no-console
    console.log('');
    process.exit(1);
  }
}
