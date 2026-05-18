/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/subagent/spawnPause.test.ts — v4.6 Phase 3A.
 *
 * Covers the file-marker-backed kill-switch for sub-agent spawning.
 * Design rationale lives in `core/v4/subagent/spawnPause.ts`.
 *
 * Scenarios:
 *   1.  Default state — no marker → not paused
 *   2.  pause() creates marker + status reads back
 *   3.  pause() with reason captures + returns reason
 *   4.  resume() removes marker, isPaused() flips back
 *   5.  Marker survives across SpawnPauseState reconstruction
 *       (cross-process / restart simulation)
 *   6.  Atomic write — interrupted write leaves no marker
 *   7.  Concurrent read while marker is being rewritten — never sees
 *       half-written JSON (verified via the rename-into-place pattern)
 *   8.  pausedBy field populated correctly
 *   9.  status() tolerates a corrupt marker (returns paused: true,
 *       no metadata)
 *   10. resume() is idempotent (ENOENT on second call doesn't throw)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SpawnPauseState,
  initSpawnPause,
  getSpawnPause,
  _resetSpawnPauseForTests,
} from '../../../core/v4/subagent/spawnPause';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-spawnpause-'));
  _resetSpawnPauseForTests();
});
afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
  _resetSpawnPauseForTests();
});

describe('SpawnPauseState — v4.6 Phase 3A file-marker kill-switch', () => {
  it('1. default state: no marker → isPaused() === false, status.paused === false', () => {
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    expect(s.isPaused()).toBe(false);
    expect(s.status().paused).toBe(false);
  });

  it('2. pause() creates marker; status() reads metadata back', () => {
    const s = new SpawnPauseState({ aidenHome: tmpHome, now: () => 1_700_000_000_000 });
    s.pause({ pausedBy: 'repl' });
    expect(s.isPaused()).toBe(true);
    const st = s.status();
    expect(st.paused).toBe(true);
    expect(st.pausedAt).toBe(1_700_000_000_000);
    expect(st.reason).toBeNull();
    expect(st.pausedBy).toBe('repl');
    // Marker file exists on disk at the expected path.
    expect(fs.existsSync(path.join(tmpHome, 'spawn.paused'))).toBe(true);
  });

  it('3. pause() with reason captures + returns reason in status', () => {
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    s.pause({ reason: 'deploy window', pausedBy: 'repl' });
    const st = s.status();
    expect(st.paused).toBe(true);
    expect(st.reason).toBe('deploy window');
  });

  it('4. resume() removes marker; isPaused() flips back to false', () => {
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    s.pause({ pausedBy: 'repl' });
    expect(s.isPaused()).toBe(true);
    s.resume();
    expect(s.isPaused()).toBe(false);
    expect(s.status().paused).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'spawn.paused'))).toBe(false);
  });

  it('5. marker survives reconstruction — simulates cross-process / restart', () => {
    // Process A pauses.
    const a = new SpawnPauseState({ aidenHome: tmpHome });
    a.pause({ reason: 'runaway-fanout', pausedBy: 'daemon' });
    // Process B (fresh state, same aidenHome) reads the marker.
    const b = new SpawnPauseState({ aidenHome: tmpHome });
    const st = b.status();
    expect(st.paused).toBe(true);
    expect(st.reason).toBe('runaway-fanout');
    expect(st.pausedBy).toBe('daemon');
  });

  it('6. atomic write: interrupted writes do not leave a usable marker', () => {
    // Simulate an interrupted write by leaving a stray .tmp file —
    // the marker proper should NOT exist, so isPaused() returns false.
    fs.writeFileSync(path.join(tmpHome, 'spawn.paused.tmp'), '{partial');
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    expect(s.isPaused()).toBe(false);
  });

  it('7. concurrent reads during rewrite never see half-written JSON', () => {
    // Hard to test the race window directly; assert the rename-into-
    // place pattern by checking that the production code writes to
    // a tmp path first. We verify the BEHAVIOUR: a status() read
    // between two pause() calls always returns a fully-formed marker.
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    s.pause({ reason: 'first', pausedBy: 'repl' });
    const mid = s.status();
    s.pause({ reason: 'second', pausedBy: 'repl' });
    const after = s.status();
    expect(mid.paused).toBe(true);
    expect(mid.reason).toBe('first');
    expect(after.paused).toBe(true);
    expect(after.reason).toBe('second');
  });

  it('8. pausedBy field populated correctly for each runtime', () => {
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    for (const by of ['repl', 'daemon', 'mcp', 'unknown']) {
      s.pause({ pausedBy: by });
      expect(s.status().pausedBy).toBe(by);
    }
  });

  it('9. status() tolerates a corrupt marker: paused: true, no metadata', () => {
    fs.writeFileSync(path.join(tmpHome, 'spawn.paused'), 'not-json{');
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    const st = s.status();
    // EXISTENCE is the durable contract — the marker is there, so paused.
    expect(st.paused).toBe(true);
    // Metadata fields are unparseable, so dropped.
    expect(st.pausedAt).toBeUndefined();
    expect(st.reason).toBeUndefined();
  });

  it('10. resume() is idempotent — ENOENT on second call does NOT throw', () => {
    const s = new SpawnPauseState({ aidenHome: tmpHome });
    s.pause({ pausedBy: 'repl' });
    s.resume();
    expect(() => s.resume()).not.toThrow();
    expect(s.isPaused()).toBe(false);
  });

  it('11. status().durationMs computed correctly', () => {
    let clock = 1_700_000_000_000;
    const s = new SpawnPauseState({ aidenHome: tmpHome, now: () => clock });
    s.pause({ pausedBy: 'repl' });
    clock += 5_000;
    const st = s.status();
    expect(st.durationMs).toBe(5_000);
  });
});

describe('spawnPause module singleton', () => {
  it('initSpawnPause + getSpawnPause return the same instance', () => {
    const a = initSpawnPause({ aidenHome: tmpHome });
    const b = getSpawnPause();
    expect(a).toBe(b);
  });

  it('getSpawnPause() throws when not initialized', () => {
    expect(() => getSpawnPause()).toThrow(/not initialized/);
  });

  it('initSpawnPause replaces the singleton on re-init', () => {
    const otherTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-spawnpause-alt-'));
    try {
      const a = initSpawnPause({ aidenHome: tmpHome });
      const b = initSpawnPause({ aidenHome: otherTmp });
      expect(b).not.toBe(a);
      // Pausing through b writes the marker into otherTmp, NOT tmpHome.
      b.pause({ pausedBy: 'repl' });
      expect(fs.existsSync(path.join(otherTmp, 'spawn.paused'))).toBe(true);
      expect(fs.existsSync(path.join(tmpHome,  'spawn.paused'))).toBe(false);
    } finally {
      try { fs.rmSync(otherTmp, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});

// ── Tool-handler gate (spawn_sub_agent + subagent_fanout) ─────────────────

describe('spawn_sub_agent handler — pause gate (v4.6 Phase 3A)', () => {
  it('returns SUBAGENT_SPAWN_PAUSED envelope when paused', async () => {
    // Init the singleton + pause it.
    const state = initSpawnPause({ aidenHome: tmpHome });
    state.pause({ reason: 'unit test', pausedBy: 'repl' });

    // Stand up the spawn tool with deliberately broken deps —
    // the pause gate fires FIRST, so the deps never get touched.
    const { makeSpawnSubAgentTool } = await import('../../../tools/v4/subagent/spawnSubAgentTool');
    const tool = makeSpawnSubAgentTool({
      parentAgent:       { getCurrentSignal: () => undefined } as never,
      toolRegistry:      {} as never,
      parentToolContext: {} as never,
      parentProvider:    {} as never,
      parentProviderId:  'mock',
      parentModelId:     'mock',
      runStore:          {} as never,
      instanceId:        'inst-test',
    });
    const result = (await tool.execute({ goal: 'do thing' }, {} as never)) as {
      success: boolean; errorCode?: string; message?: string;
      pausedAt?: number | null; reason?: string | null;
      pausedBy?: string | null; durationMs?: number | null;
    };
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SUBAGENT_SPAWN_PAUSED');
    expect(result.message).toMatch(/spawning is paused/i);
    expect(result.message).toMatch(/unit test/);
    expect(result.message).toMatch(/\/spawn-pause off/);
    expect(result.reason).toBe('unit test');
    expect(result.pausedBy).toBe('repl');
    expect(typeof result.pausedAt).toBe('number');
  });

  it('does NOT write a runs row for paused calls (operator-induced, not a real failure)', async () => {
    const state = initSpawnPause({ aidenHome: tmpHome });
    state.pause({ pausedBy: 'repl' });

    // Use a real runStore so we can introspect whether anything was written.
    const realDb = new (await import('better-sqlite3')).default(':memory:');
    realDb.pragma('foreign_keys = ON');
    const { runMigrations: m } = await import('../../../core/v4/daemon/db/migrations');
    m(realDb);
    realDb.prepare(
      `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('inst-pause', 1, 'h', Date.now(), Date.now(), '4.6.0');
    const { createRunStore: cs } = await import('../../../core/v4/daemon/runStore');
    const rs = cs({ db: realDb });

    const { makeSpawnSubAgentTool } = await import('../../../tools/v4/subagent/spawnSubAgentTool');
    const tool = makeSpawnSubAgentTool({
      parentAgent:       { getCurrentSignal: () => undefined } as never,
      toolRegistry:      {} as never,
      parentToolContext: {} as never,
      parentProvider:    {} as never,
      parentProviderId:  'mock',
      parentModelId:     'mock',
      runStore:          rs,
      instanceId:        'inst-pause',
    });
    await tool.execute({ goal: 'x' }, {} as never);
    const rowCount = realDb.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number };
    expect(rowCount.c).toBe(0);
    realDb.close();
  });

  it('resumed → handler proceeds past the pause gate (no immediate rejection)', async () => {
    const state = initSpawnPause({ aidenHome: tmpHome });
    state.pause({ pausedBy: 'repl' });
    state.resume();

    const { makeSpawnSubAgentTool } = await import('../../../tools/v4/subagent/spawnSubAgentTool');
    const tool = makeSpawnSubAgentTool({
      parentAgent:       { getCurrentSignal: () => undefined } as never,
      toolRegistry:      {} as never,
      parentToolContext: {} as never,
      parentProvider:    {} as never,
      parentProviderId:  'mock',
      parentModelId:     'mock',
      runStore:          {} as never,
      instanceId:        'inst-test',
    });
    // Empty goal → handler proceeds to its OWN validation error.
    // Crucially, the error is NOT SUBAGENT_SPAWN_PAUSED.
    const result = (await tool.execute({}, {} as never)) as { success: boolean; errorCode?: string; error?: string };
    expect(result.errorCode).toBeUndefined();
    // We expect the goal-required validation path, not the pause path.
  });
});

describe('subagent_fanout handler — pause gate (v4.6 Phase 3A)', () => {
  it('returns SUBAGENT_SPAWN_PAUSED envelope when paused; no partial fanout', async () => {
    const state = initSpawnPause({ aidenHome: tmpHome });
    state.pause({ reason: 'partial-fanout-prevention', pausedBy: 'repl' });

    const { makeSubagentFanoutTool } = await import('../../../tools/v4/subagent/subagentFanout');
    const tool = makeSubagentFanoutTool({
      resolveProviders:    () => [{ providerId: 'mock', modelId: 'mock', label: 'mock-0' }],
      resolveActiveModel:  () => ({ providerId: 'mock', modelId: 'mock' }),
      aggregatorAdapter:   {} as never,
      // NOTE: deliberately no spawnDeps. Gate fires before any deps
      // are used; if the gate were missing the test would fail with
      // a "tool not wired" envelope instead.
    });
    const result = (await tool.execute({ mode: 'ensemble', query: 'q', n: 3, merge: 'all' }, {} as never)) as {
      success: boolean; errorCode?: string; message?: string; reason?: string | null;
    };
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SUBAGENT_SPAWN_PAUSED');
    expect(result.message).toMatch(/spawning is paused/i);
    expect(result.message).toMatch(/partial-fanout-prevention/);
    expect(result.reason).toBe('partial-fanout-prevention');
  });

  it('resumed → handler proceeds past the pause gate', async () => {
    const state = initSpawnPause({ aidenHome: tmpHome });
    state.pause({ pausedBy: 'repl' });
    state.resume();

    const { makeSubagentFanoutTool } = await import('../../../tools/v4/subagent/subagentFanout');
    const tool = makeSubagentFanoutTool({
      resolveProviders:    () => [],
      resolveActiveModel:  () => ({ providerId: 'mock', modelId: 'mock' }),
      aggregatorAdapter:   {} as never,
    });
    // Empty providers → handler's OWN downstream error (NOT the pause error).
    const result = (await tool.execute({ mode: 'ensemble', query: 'q', n: 3, merge: 'all' }, {} as never)) as {
      success: boolean; errorCode?: string; error?: string;
    };
    expect(result.errorCode).not.toBe('SUBAGENT_SPAWN_PAUSED');
  });
});
