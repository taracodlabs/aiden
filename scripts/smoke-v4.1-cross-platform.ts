/**
 * scripts/smoke-v4.1-cross-platform.ts — Phase v4.1-cross-platform offline self-smoke.
 *
 * Sections:
 *   A — Path normalization (audit + helpers)
 *   B — Audio backend detection (current OS)
 *   C — Skills loader case-insensitive lookup
 *   D — Doctor checks include audio + platform paths
 *   E — Platform helpers (normalizePath / platformShell / isWritable)
 *   F — Build fingerprint
 *   G — Attribution sweep clean
 *
 * Run: npx ts-node scripts/smoke-v4.1-cross-platform.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  normalizePath,
  joinPaths,
  expandHome,
  platformShell,
  isWritable,
  isReadable,
  classifyPlatform,
} from '../core/v4/platformPaths';
import {
  detectBackend,
  missingBackendMessage,
  listKnownBackends,
  _resetBackendCacheForTests,
} from '../core/voice/audioBackend';
import { AIDEN_CROSS_PLATFORM_BUILD } from '../cli/v4/uiBuild';

const REPO_ROOT = path.resolve(__dirname, '..');

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

(async () => {
  // ── A — Path normalization audit + helpers ───────────────────────
  header('A — Path normalization');

  // A1: shipped tree contains no hardcoded `C:\\` literals (outside
  //     test fixtures + the dist bundle).
  const a1 = spawnSync('node', ['-e', `
    const cp = require('child_process');
    try {
      const out = cp.execSync('git grep -lE "C:\\\\\\\\\\\\\\\\\\\\\\\\\\\\" -- core cli moat providers tools', { encoding: 'utf8', cwd: ${JSON.stringify(REPO_ROOT)} });
      process.stdout.write(out);
    } catch {
      // grep exits 1 when no matches — that's the success case.
    }
  `], { encoding: 'utf8' });
  const a1Hits = (a1.stdout ?? '').trim();
  if (a1Hits.length === 0) {
    ok('A1 no hardcoded `C:\\\\` literals in core/cli/moat/providers/tools');
  } else {
    notOk('A1 no hardcoded `C:\\\\` literals', a1Hits.slice(0, 200));
  }

  // A2: shipped tree contains no hardcoded /home/<user>/ or /Users/<user>/.
  const a2 = spawnSync('git', ['grep', '-nE', '/home/[a-z]|/Users/[a-zA-Z]', '--', 'core', 'cli', 'moat', 'providers', 'tools'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  const hostUserPathHits = (a2.stdout ?? '')
    .split(/\r?\n/u)
    .filter(Boolean)
    // This is the unprivileged HOME inside the isolated capability
    // container, never a host filesystem or user-specific path.
    .filter((line) => !/^core\/v4\/capabilities\/processHost\.ts:\d+:.*\/home\/capability(?:[:'",]|$)/u.test(line));
  if (hostUserPathHits.length === 0) {
    ok('A2 no hardcoded /home/<user>/ or /Users/<user>/ paths');
  } else {
    notOk('A2 no hardcoded /home or /Users user paths', hostUserPathHits.join('\n').slice(0, 200));
  }

  // A3: powershell EXEC/SPAWN calls in shipped tree are all gated
  // on win32. Files that merely mention "powershell" in a comment or
  // string literal (e.g. tool-icon maps, prose) are not the concern;
  // the bug class we care about is "spawning powershell on Linux".
  // Scope to v4-active paths. v3 legacy modules (core/toolRegistry,
  // core/voiceOutput) aren't reached in v4 mode and intentionally
  // remain Windows-first; auditing them would surface noise.
  const a3 = spawnSync('git', [
    'grep', '-lE',
    "(spawn|exec|execAsync|execFile|execSync)\\([^)]*['\"`]powershell",
    '--', 'core/v4', 'cli/v4', 'core/voice',
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  const psFiles = (a3.stdout ?? '').trim().split('\n').filter(Boolean);
  let allGated = true;
  let firstUngated = '';
  for (const file of psFiles) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (!text.includes('win32')) {
      allGated = false;
      firstUngated = file;
      break;
    }
  }
  if (allGated) {
    ok(`A3 powershell exec/spawn calls all in win32-aware files (${psFiles.length} files)`);
  } else {
    notOk(`A3 powershell exec/spawn calls all in win32-aware files`, firstUngated);
  }

  // A4: expandHome correctness on current platform.
  const home = os.homedir();
  const e1 = expandHome('~/foo');
  const e2 = expandHome('~');
  const e3 = expandHome('/abs/path');
  const e4 = expandHome('./rel');
  if (e1 === path.join(home, 'foo') && e2 === home && e3 === '/abs/path' && e4 === './rel') {
    ok(`A4 expandHome correct (home=${home})`);
  } else {
    notOk('A4 expandHome correct',
          `~/foo=${e1} ~=${e2} /abs=${e3} ./rel=${e4}`);
  }

  // A5: normalizePath / joinPaths basic round-trip.
  const j = joinPaths('a', 'b', 'c');
  const norm = normalizePath(`a${path.sep}b${path.sep}${path.sep}c`);
  if (j.includes('a') && j.includes('b') && j.includes('c') && norm.length > 0) {
    ok('A5 joinPaths + normalizePath produce platform-safe paths');
  } else {
    notOk('A5 joinPaths + normalizePath', `j=${j} norm=${norm}`);
  }

  // ── B — Audio backend detection ──────────────────────────────────
  header('B — Audio backend detection (current OS)');

  _resetBackendCacheForTests();
  const t0 = Date.now();
  const playback = detectBackend('playback');
  const record   = detectBackend('record');
  const elapsed  = Date.now() - t0;

  if (elapsed < 2500) {
    ok(`B1 detection probe completes in <2.5s (took ${elapsed}ms)`);
  } else {
    notOk(`B1 detection probe completes in <2.5s`, `${elapsed}ms`);
  }

  if (process.platform === 'win32') {
    if (playback?.builtin && record?.builtin) {
      ok(`B2 Windows: builtin PowerShell backends detected for playback + record`);
    } else {
      notOk('B2 Windows: builtin backends detected', `playback=${playback?.label} record=${record?.label}`);
    }
  } else {
    // POSIX — at least one candidate may or may not be installed; both
    // outcomes are valid. The smoke just verifies the API works.
    const knownPlayback = listKnownBackends('playback');
    if (knownPlayback.length > 0) {
      ok(`B2 ${process.platform}: ${knownPlayback.length} known playback candidates (${playback ? 'detected: ' + playback.label : 'none installed'})`);
    } else {
      notOk(`B2 ${process.platform}: no known playback candidates`);
    }
  }

  // B3: missing backend produces a friendly message string.
  const msg = missingBackendMessage('playback');
  if (msg.length > 30 && /backend|unavailable|install/i.test(msg)) {
    ok('B3 missingBackendMessage produces a non-empty friendly hint');
  } else {
    notOk('B3 missingBackendMessage produces a non-empty friendly hint', msg);
  }

  // B4: cache works — second probe should be <50ms even if first was slow.
  const t1 = Date.now();
  detectBackend('playback');
  detectBackend('record');
  const cachedElapsed = Date.now() - t1;
  if (cachedElapsed < 50) {
    ok(`B4 second-call cache hit (${cachedElapsed}ms)`);
  } else {
    notOk(`B4 second-call cache hit`, `${cachedElapsed}ms`);
  }

  // ── C — Skills loader case-insensitive lookup ──────────────────
  header('C — Skills loader case-insensitive lookup');

  // Set up a temp AIDEN_HOME with a CamelCase skill on disk.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crossplat-skills-'));
  process.env.AIDEN_HOME = tmpHome;
  const skillDir = path.join(tmpHome, 'skills', 'WebSearch');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: WebSearch\ndescription: web search test\nversion: 1.0.0\n---\n# WebSearch\n',
    'utf8',
  );

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SkillLoader } = require('../core/v4/skillLoader');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveAidenPaths } = require('../core/v4/paths');
  const loader = new SkillLoader(resolveAidenPaths());

  const a = await loader.load('WebSearch');
  const b = await loader.load('websearch');
  const c = await loader.load('WEBSEARCH');
  const d = await loader.load('webSearch');

  if (a && b && c && d &&
      a.frontmatter.name === 'WebSearch' &&
      b.frontmatter.name === 'WebSearch' &&
      c.frontmatter.name === 'WebSearch' &&
      d.frontmatter.name === 'WebSearch') {
    ok('C1 case-insensitive lookup resolves all variants to the registered skill');
  } else {
    notOk('C1 case-insensitive lookup',
          `a=${a?.frontmatter.name} b=${b?.frontmatter.name} c=${c?.frontmatter.name} d=${d?.frontmatter.name}`);
  }

  // C2: original case preserved in the returned name.
  if (a?.frontmatter.name === 'WebSearch') {
    ok('C2 original case "WebSearch" preserved in returned frontmatter');
  } else {
    notOk('C2 original case preserved in returned frontmatter');
  }

  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }

  // ── D — Doctor checks ────────────────────────────────────────────
  header('D — Doctor checks include audio + platform paths');

  const doctorSrc = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'v4', 'doctor.ts'), 'utf8');
  if (/checkAudioBackend\b/.test(doctorSrc)) {
    ok('D1 doctor.ts exports checkAudioBackend');
  } else {
    notOk('D1 doctor.ts exports checkAudioBackend');
  }
  if (/results\.push\(await checkAudioBackend\(\)\)/.test(doctorSrc)) {
    ok('D2 runDoctor invokes checkAudioBackend');
  } else {
    notOk('D2 runDoctor invokes checkAudioBackend');
  }
  if (/checkPlatformPaths\b/.test(doctorSrc)) {
    ok('D3 doctor.ts retains checkPlatformPaths (existing)');
  } else {
    notOk('D3 doctor.ts retains checkPlatformPaths');
  }

  // ── E — Platform helpers ────────────────────────────────────────
  header('E — Platform helpers');

  // E1 — normalizePath idempotent.
  const dup = path.join('a', 'b');
  if (normalizePath(dup) === dup) {
    ok('E1 normalizePath idempotent on already-normal path');
  } else {
    notOk('E1 normalizePath idempotent on already-normal path');
  }

  // E2 — platformShell returns expected value per OS.
  const sh = platformShell();
  if (process.platform === 'win32' && sh === 'powershell') {
    ok('E2 platformShell returns "powershell" on Windows');
  } else if (process.platform !== 'win32' && (sh === 'bash' || sh === 'sh')) {
    ok(`E2 platformShell returns "${sh}" on ${process.platform}`);
  } else {
    notOk('E2 platformShell returns expected value', `got "${sh}" on ${process.platform}`);
  }

  // E3 — isWritable returns true for tmp + false for non-existent.
  const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'crossplat-w-'));
  if (isWritable(tmpFile) && !isWritable(path.join(tmpFile, 'never-existed-xyz'))) {
    ok('E3 isWritable detects writable + missing paths');
  } else {
    notOk('E3 isWritable detects writable + missing paths');
  }
  try { fs.rmSync(tmpFile, { recursive: true, force: true }); } catch { /* */ }

  // E4 — isReadable mirror of isWritable shape.
  if (isReadable(REPO_ROOT) && !isReadable(path.join(REPO_ROOT, 'never-existed-xyz'))) {
    ok('E4 isReadable detects readable + missing paths');
  } else {
    notOk('E4 isReadable detects readable + missing paths');
  }

  // E5 — classifyPlatform matches process.platform for known OSes.
  const klass = classifyPlatform();
  const expected = ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'other';
  if (klass === expected) {
    ok(`E5 classifyPlatform returns "${klass}" for ${process.platform}`);
  } else {
    notOk(`E5 classifyPlatform returns matching value`, `got "${klass}" expected "${expected}"`);
  }

  // ── F — Build fingerprint ────────────────────────────────────────
  header('F — Build fingerprint');
  if (AIDEN_CROSS_PLATFORM_BUILD === 'v4.1-cross-platform') {
    ok('F1 AIDEN_CROSS_PLATFORM_BUILD === "v4.1-cross-platform"');
  } else {
    notOk('F1 AIDEN_CROSS_PLATFORM_BUILD === "v4.1-cross-platform"', AIDEN_CROSS_PLATFORM_BUILD);
  }

  // ── G — Attribution sweep ───────────────────────────────────────
  header('G — Permanent attribution sweep clean');
  const sweep = spawnSync('npx', ['ts-node', 'scripts/smoke-v4.1-attribution-sweep.ts'], {
    cwd: REPO_ROOT, encoding: 'utf8', shell: true,
  });
  if (sweep.status === 0) {
    ok('G1 attribution sweep stays green');
  } else {
    notOk('G1 attribution sweep stays green',
          `status=${sweep.status} stdout=${(sweep.stdout ?? '').slice(-300)}`);
  }

  // ── Summary ──────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('');
  if (fail === 0) {
    // eslint-disable-next-line no-console
    console.log(`\x1b[32m✓ All ${pass} checks passed.\x1b[0m\n`);
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.log(`\x1b[31m✗ ${fail} of ${pass + fail} checks failed:\x1b[0m`);
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.log(`    - ${f}`);
    }
    // eslint-disable-next-line no-console
    console.log('');
    process.exit(1);
  }
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\x1b[31m✗ smoke crashed:\x1b[0m', err);
  process.exit(2);
});
