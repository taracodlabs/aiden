/**
 * v4.5 Phase 7c — two-phase bootstrap tests.
 *
 * Covers:
 *   1. bootstrapDaemonFoundation boots without an agentBuilder
 *   2. installDaemonAgentBuilder swaps placeholder → real runner
 *   3. installDaemonAgentBuilder returns false when handle inactive
 *   4. Foundation admits work durably but cannot falsely complete it before
 *      the real runner is installed
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bootstrapDaemonFoundation,
  installDaemonAgentBuilder,
  getDaemonHandle,
  _resetDaemonBootstrapForTests,
} from '../../../core/v4/daemon/bootstrap';
import { makeRunner } from '../../../core/v4/daemon/dispatcher';
import type {
  AgentBuilder,
  DaemonAgentInput,
  DaemonAgentResult,
} from '../../../core/v4/daemon/dispatcher';
import type { AidenAgent, AidenAgentResult } from '../../../core/v4/aidenAgent';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-p7c-'));
  prev = {
    AIDEN_HOME:        process.env.AIDEN_HOME,
    HOME:              process.env.HOME,
    USERPROFILE:       process.env.USERPROFILE,
    AIDEN_DAEMON:      process.env.AIDEN_DAEMON,
    AIDEN_DAEMON_PORT: process.env.AIDEN_DAEMON_PORT,
  };
  process.env.AIDEN_HOME = aidenHome;
  process.env.HOME = aidenHome;
  process.env.USERPROFILE = aidenHome;
  process.env.AIDEN_DAEMON = '1';
  // Pick a random high port to avoid clashes with the user's daemon
  // or other parallel tests.
  process.env.AIDEN_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
  _resetDaemonBootstrapForTests();
});
afterEach(async () => {
  // Clean shutdown of the singleton's HTTP server + timers.
  const handle = getDaemonHandle();
  if (handle?.dispatcher) {
    try { await handle.dispatcher.stop(2_000); } catch { /* noop */ }
  }
  if (handle?.httpServer) {
    try { handle.httpServer.close(); } catch { /* noop */ }
  }
  if (handle?.runtimeLock) {
    try { handle.runtimeLock.release(); } catch { /* noop */ }
  }
  if (handle?.instanceTracker) {
    try { handle.instanceTracker.stop(); } catch { /* noop */ }
  }
  _resetDaemonBootstrapForTests();
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else                       process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); }
  catch { /* noop */ }
});

describe('bootstrapDaemonFoundation', () => {
  it('boots without agentBuilder; dispatcher uses placeholder runner', () => {
    const handle = bootstrapDaemonFoundation();
    expect(handle.active).toBe(true);
    expect(handle.dispatcher).not.toBeNull();
    expect(handle.dispatcher!.runnerKind()).toBe('placeholder');
  });

  it('idempotent — second call returns same singleton', () => {
    const h1 = bootstrapDaemonFoundation();
    const h2 = bootstrapDaemonFoundation();
    expect(h1).toBe(h2);
  });
});

describe('installDaemonAgentBuilder', () => {
  function stubAgentBuilder(): AgentBuilder {
    return () => ({
      runConversation: async (): Promise<AidenAgentResult> => {
        return { finishReason: 'stop' } as unknown as AidenAgentResult;
      },
    } as unknown as AidenAgent);
  }

  it('returns true + flips dispatcher runner kind to "real"', () => {
    const handle = bootstrapDaemonFoundation();
    expect(handle.dispatcher!.runnerKind()).toBe('placeholder');
    const ok = installDaemonAgentBuilder(handle, stubAgentBuilder(), { provider: 'ollama', model: 'llama3.2' });
    expect(ok).toBe(true);
    expect(handle.dispatcher!.runnerKind()).toBe('real');
  });

  it('returns false when handle inactive (NOOP_HANDLE)', () => {
    // Build a NOOP-shaped handle.
    const noopHandle = {
      active: false,
      dispatcher: null,
      triggerBus: null,
      runStore: null,
    } as any;
    const ok = installDaemonAgentBuilder(noopHandle, stubAgentBuilder(), { provider: 'ollama', model: 'llama3.2' });
    expect(ok).toBe(false);
  });
});

describe('foundation admission before runner install', () => {
  it('placeholder leaves admitted work retryable instead of reporting false success', async () => {
    const handle = bootstrapDaemonFoundation();
    expect(handle.dispatcher!.runnerKind()).toBe('placeholder');

    // Insert a trigger via the bus + pump.
    const inserted = handle.triggerBus!.insert({
      source: 'manual', sourceKey: 'k', idempotencyKey: 'i-placeholder',
      payload: {},
    });
    await handle.dispatcher!._pumpOnce();
    const ev = handle.triggerBus!.get(inserted.id);
    expect(ev?.status).toBe('pending');
    expect(ev?.runId).toBeNull();
  });
});
