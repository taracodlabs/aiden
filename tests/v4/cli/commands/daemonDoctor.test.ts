/**
 * tests/v4/cli/commands/daemonDoctor.test.ts — v4.9.0 Slice 8.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrapDaemonFoundation,
  getDaemonHandle,
  _resetDaemonBootstrapForTests,
} from '../../../../core/v4/daemon/bootstrap';
import { collectDoctorChecks, runDaemonDoctor } from '../../../../cli/v4/commands/daemonDoctor';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-s8-doc-'));
  prev = {
    AIDEN_HOME: process.env.AIDEN_HOME, HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE, AIDEN_DAEMON: process.env.AIDEN_DAEMON,
    AIDEN_DAEMON_PORT: process.env.AIDEN_DAEMON_PORT,
  };
  process.env.AIDEN_HOME = aidenHome;
  process.env.HOME = aidenHome;
  process.env.USERPROFILE = aidenHome;
  process.env.AIDEN_DAEMON = '1';
  process.env.AIDEN_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
  _resetDaemonBootstrapForTests();
});
afterEach(async () => {
  const h = getDaemonHandle();
  if (h?.dispatcher) { try { await h.dispatcher.stop(2_000); } catch { /* noop */ } }
  if (h?.httpServer) { try { h.httpServer.close(); } catch { /* noop */ } }
  if (h?.runtimeLock) { try { h.runtimeLock.release(); } catch { /* noop */ } }
  if (h?.instanceTracker) { try { h.instanceTracker.stop(); } catch { /* noop */ } }
  _resetDaemonBootstrapForTests();
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('aiden daemon doctor — Slice 8', () => {
  it('reports error when daemon never booted in this root', () => {
    const checks = collectDoctorChecks(aidenHome);
    const daemonIdCheck = checks.find((c) => c.name === 'daemon_id file')!;
    expect(daemonIdCheck.status).toBe('error');
    expect(daemonIdCheck.detail).toContain('missing');
  });

  it('reports overall=ok with all checks after a clean bootstrap', () => {
    bootstrapDaemonFoundation();
    const checks = collectDoctorChecks(aidenHome);
    expect(checks.find((c) => c.name === 'daemon_id file')!.status).toBe('ok');
    expect(checks.find((c) => c.name === 'schema version')!.status).toBe('ok');
    expect(checks.find((c) => c.name === 'recent incarnation')!.status).toBe('ok');
    expect(checks.find((c) => c.name === 'stuck attempts')!.status).toBe('ok');
    expect(checks.find((c) => c.name === 'orphan spans')!.status).toBe('ok');
  });

  it('runDaemonDoctor emits JSON shape on --json', () => {
    bootstrapDaemonFoundation();
    let out = '';
    const exit = runDaemonDoctor({
      json: true, rootDir: aidenHome,
      writeOut: (s) => { out += s; },
      writeErr: () => { /* noop */ },
    });
    expect(exit).toBe(0);
    const parsed = JSON.parse(out) as { overall: string; checks: Array<{ name: string; status: string }> };
    expect(['ok', 'warn']).toContain(parsed.overall);
    expect(parsed.checks.length).toBeGreaterThanOrEqual(7);
    expect(parsed.checks[0].name).toBe('daemon_id file');
  });

  it('runDaemonDoctor emits human format by default', () => {
    bootstrapDaemonFoundation();
    let out = '';
    runDaemonDoctor({
      rootDir: aidenHome,
      writeOut: (s) => { out += s; },
      writeErr: () => { /* noop */ },
    });
    expect(out).toMatch(/aiden daemon doctor/);
    expect(out).toMatch(/daemon_id file/);
    expect(out).toMatch(/schema version/);
  });

  it('--fix invokes fix() for fixable checks (no-op when nothing fixable)', () => {
    bootstrapDaemonFoundation();
    let out = '';
    runDaemonDoctor({
      fix: true, rootDir: aidenHome,
      writeOut: (s) => { out += s; },
      writeErr: () => { /* noop */ },
    });
    // No stuck attempts on a fresh boot; fix loop completes with no work.
    expect(out).toMatch(/no fixable issues found/);
  });

  it('overall=error when daemon_id missing (returns exit code 1)', () => {
    let out = '';
    const exit = runDaemonDoctor({
      rootDir: aidenHome,
      writeOut: (s) => { out += s; },
      writeErr: () => { /* noop */ },
    });
    expect(exit).toBe(1);
    expect(out).toMatch(/ERROR/);
  });
});
