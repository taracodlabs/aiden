/**
 * v4.11 Slice 1 — Phase B gate-zero smoke.
 *
 * Verifies that Ink (ESM), better-sqlite3 (native), and node-pty (native)
 * coexist in one process without native-module ordering surprises.
 *
 * Why: Aiden is CommonJS. Ink 5+ is ESM-only. better-sqlite3 and node-pty
 * are native addons compiled against a specific Node ABI. Loading them in
 * the "wrong" order, or alongside Ink's React reconciler, can surface
 * obscure dlopen/abi errors that only show at runtime. We catch those
 * here before writing any composer/status code.
 *
 * Exit codes:
 *   0  all three modules loaded and a trivial Ink frame mounted/unmounted
 *   1  native module failed to load or Ink failed to render
 */
import Database from 'better-sqlite3';
import { spawn as ptySpawn } from 'node-pty';
import React from 'react';

const out = [];
function log(label, ok, detail = '') {
  const tag = ok ? 'OK ' : 'FAIL';
  out.push(`[${tag}] ${label}${detail ? '  — ' + detail : ''}`);
}

// 1. better-sqlite3 — open in-memory DB, run trivial query.
try {
  const db = new Database(':memory:');
  const row = db.prepare('SELECT 1 AS one').get();
  db.close();
  log('better-sqlite3 load + query', row.one === 1, `version=${Database.prototype.constructor.name}`);
} catch (err) {
  log('better-sqlite3 load + query', false, err.message);
  process.exit(1);
}

// 2. node-pty — spawn `node --version`, capture exit.
try {
  await new Promise((resolve, reject) => {
    const term = ptySpawn(process.execPath, ['--version'], {
      name: 'xterm',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    let buf = '';
    term.onData((d) => { buf += d; });
    term.onExit(({ exitCode }) => {
      if (exitCode === 0 && buf.includes('v')) {
        log('node-pty spawn + onData', true, `captured ${buf.trim().slice(0, 12)}`);
        resolve();
      } else {
        reject(new Error(`exit=${exitCode} buf=${JSON.stringify(buf)}`));
      }
    });
    setTimeout(() => reject(new Error('pty timeout')), 5000);
  });
} catch (err) {
  log('node-pty spawn + onData', false, err.message);
  process.exit(1);
}

// 3. Ink — dynamic import (ESM), render a single Text node, unmount.
try {
  const ink = await import('ink');
  const { render, Text, Box } = ink;
  // Render to a no-op stream so the smoke doesn't paint over the terminal.
  const sink = {
    write: () => true,
    columns: 80,
    rows: 24,
    on: () => sink,
    off: () => sink,
    once: () => sink,
    removeListener: () => sink,
    emit: () => false,
    isTTY: false,
  };
  const tree = React.createElement(Box, null, React.createElement(Text, null, 'aiden-smoke'));
  const instance = render(tree, { stdout: sink, stdin: process.stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
  // Unmount FIRST, then await exit — waitUntilExit resolves only after
  // the reconciler has finished tearing down.
  instance.unmount();
  await Promise.race([
    instance.waitUntilExit().catch(() => { /* unmounted */ }),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  log('ink dynamic-import + render + unmount', true);
} catch (err) {
  log('ink dynamic-import + render + unmount', false, err.message);
  // Best-effort: still print results so we see partial state.
  for (const line of out) console.log(line);
  process.exit(1);
}

// 4. Cohabitation — reopen better-sqlite3 AFTER Ink mounted, to detect
// late native-load surprises (some addons misbehave once a reconciler
// has run).
try {
  const db = new Database(':memory:');
  db.prepare('SELECT 1').get();
  db.close();
  log('better-sqlite3 reopen after Ink', true);
} catch (err) {
  log('better-sqlite3 reopen after Ink', false, err.message);
  for (const line of out) console.log(line);
  process.exit(1);
}

for (const line of out) console.log(line);
console.log('\nSMOKE PASS — Ink + better-sqlite3 + node-pty coexist cleanly.');
process.exit(0);
