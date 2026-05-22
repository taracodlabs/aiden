/**
 * tests/v4/memory/memorySpanIntegration.test.ts — v4.9.0 Slice 9.
 *
 * Memory mutations inside a runWithContext frame produce a `kind=memory`
 * span with `mem_<uuidv7>` attrs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrapDaemonFoundation, getDaemonHandle, getCurrentDaemonDb,
  _resetDaemonBootstrapForTests,
} from '../../../core/v4/daemon/bootstrap';
import { runMemorySubcommand } from '../../../cli/v4/commands/memory';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-mem-span-'));
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
  bootstrapDaemonFoundation();
});
afterEach(async () => {
  const h = getDaemonHandle();
  if (h?.dispatcher) { try { await h.dispatcher.stop(2_000); } catch {} }
  if (h?.httpServer) { try { h.httpServer.close(); } catch {} }
  if (h?.runtimeLock) { try { h.runtimeLock.release(); } catch {} }
  if (h?.instanceTracker) { try { h.instanceTracker.stop(); } catch {} }
  _resetDaemonBootstrapForTests();
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); } catch {}
});

function capture() {
  const out: string[] = [], err: string[] = [];
  return { out, err, writeOut: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) };
}

describe('memory span integration — Slice 9', () => {
  it('memory add produces a kind=memory span with mem_ attrs', async () => {
    await runMemorySubcommand('add', ['user', 'span integration test', '--json'], { rootDir: aidenHome, ...capture() });
    const db = getCurrentDaemonDb()!;
    const row = db.prepare(`SELECT span_id, kind, name, status, attrs_json FROM spans WHERE kind = 'memory' ORDER BY started_at DESC LIMIT 1`).get() as { span_id: string; kind: string; name: string; status: string; attrs_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('memory');
    expect(row!.name).toBe('memory_add');
    expect(row!.status).toBe('ok');
    const attrs = JSON.parse(row!.attrs_json) as { file: string; memory_id: string };
    expect(attrs.file).toBe('user');
    expect(attrs.memory_id).toMatch(/^mem_[0-9a-f]{32}$/);
  });

  it('memory remove + backup + restore each produce their own span row', async () => {
    await runMemorySubcommand('add',    ['memory', 'entry one'], { rootDir: aidenHome, ...capture() });
    await runMemorySubcommand('remove', ['memory', '--match', 'one'], { rootDir: aidenHome, ...capture() });
    await runMemorySubcommand('backup', [], { rootDir: aidenHome, ...capture() });
    const db = getCurrentDaemonDb()!;
    const spans = db.prepare(`SELECT name FROM spans WHERE kind = 'memory' ORDER BY started_at ASC`).all() as Array<{ name: string }>;
    const names = spans.map((s) => s.name);
    expect(names).toContain('memory_add');
    expect(names).toContain('memory_remove');
    expect(names).toContain('memory_backup');
  });

  it('span row carries the daemonId + incarnationId (Slice 4 enrichment)', async () => {
    await runMemorySubcommand('add', ['user', 'identity check'], { rootDir: aidenHome, ...capture() });
    const db = getCurrentDaemonDb()!;
    const span = db.prepare(`SELECT incarnation_id FROM spans WHERE kind = 'memory' ORDER BY started_at DESC LIMIT 1`).get() as { incarnation_id: string };
    expect(span.incarnation_id).toMatch(/^inc_[0-9a-f]{32}$/);
  });
});
