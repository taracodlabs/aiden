/**
 * v4.5 Phase 2+3 fix — CLI smoke test for `aiden trigger add`.
 *
 * Verifies the runTriggerSubcommand entry point handles both file
 * and webhook trigger kinds without the Commander `name` collision
 * (Phase 3 live-test bug — `--name` clobbered Command.prototype.name()
 * → 'this.name is not a function' on every `trigger add` invocation).
 *
 * These tests bypass Commander itself (the renamed --label flag is
 * tested via end-to-end smoke). What we cover here is the argv
 * shape the action handler builds, end-to-end through runAddFile
 * and runAddWebhook into the database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  daemonDbPath,
  openDaemonDb,
  _closeAllDaemonDbsForTests,
} from '../../../core/v4/daemon';
import { runTriggerSubcommand } from '../../../cli/v4/commands/trigger';

let aidenHome: string;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-cli-trig-'));
  process.env.AIDEN_HOME = aidenHome;
});

afterEach(() => {
  delete process.env.AIDEN_HOME;
  _closeAllDaemonDbsForTests();
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); }
  catch { /* noop */ }
});

function out(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => { lines.push(s); } };
}

describe('runTriggerSubcommand — add file', () => {
  it('writes a triggers row with source=file and exits 0', async () => {
    const o = out();
    const e = out();
    const code = await runTriggerSubcommand(
      'add', ['file'],
      { name: 'my-watcher', paths: [aidenHome] },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(0);
    expect(o.lines.join('')).toMatch(/trigger added:/);

    const db = openDaemonDb(daemonDbPath(aidenHome));
    const rows = db.prepare(`SELECT name, source, enabled, spec_json FROM triggers`).all() as Array<{ name: string; source: string; enabled: number; spec_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('my-watcher');
    expect(rows[0].source).toBe('file');
    expect(rows[0].enabled).toBe(1);
    const spec = JSON.parse(rows[0].spec_json);
    expect(spec.paths).toEqual([aidenHome]);
    expect(spec.ignoreTemp).toBe(true);
    expect(spec.reconcile).toBe('skip_existing');
  });

  it('errors with 2 when --label missing', async () => {
    const o = out();
    const e = out();
    const code = await runTriggerSubcommand(
      'add', ['file'],
      { paths: [aidenHome] },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/name/i);
  });

  it('errors with 2 when --path missing', async () => {
    const o = out();
    const e = out();
    const code = await runTriggerSubcommand(
      'add', ['file'],
      { name: 'w' },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(2);
  });
});

describe('runTriggerSubcommand — add webhook', () => {
  it('writes a triggers row with source=webhook + prints secret with warning', async () => {
    const o = out();
    const e = out();
    const code = await runTriggerSubcommand(
      'add', ['webhook'],
      { name: 'my-hook', hmac: 'generic' },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(0);
    const stdout = o.lines.join('');
    expect(stdout).toMatch(/trigger added:/);
    expect(stdout).toMatch(/webhook url:/);
    expect(stdout).toMatch(/secret:/);
    expect(stdout).toMatch(/Save this secret now/);

    const db = openDaemonDb(daemonDbPath(aidenHome));
    const rows = db.prepare(`SELECT name, source, spec_json FROM triggers WHERE source='webhook'`).all() as Array<{ name: string; source: string; spec_json: string }>;
    expect(rows).toHaveLength(1);
    const spec = JSON.parse(rows[0].spec_json);
    expect(spec.name).toBe('my-hook');
    expect(spec.hmacFormat).toBe('generic');
    expect(typeof spec.secret).toBe('string');
    expect(spec.secret.length).toBeGreaterThanOrEqual(32);
  });

  it('errors with 2 when --label missing', async () => {
    const o = out();
    const e = out();
    const code = await runTriggerSubcommand(
      'add', ['webhook'],
      { hmac: 'github' },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/name/i);
  });
});

describe('runTriggerSubcommand — unknown kind', () => {
  it('errors with 2', async () => {
    const o = out();
    const e = out();
    const code = await runTriggerSubcommand(
      'add', ['email'],
      { name: 'x' },
      { writeOut: o.write, writeErr: e.write },
    );
    expect(code).toBe(2);
    expect(e.lines.join('')).toMatch(/file.*or.*webhook/i);
  });
});
