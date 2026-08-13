import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserState } from '../../../core/v4/browserState';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import type { ToolContext, ToolHandler } from '../../../core/v4/toolRegistry';
import { withBrowserState } from '../../../tools/v4/browser/_observer';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import type { LeaseStore } from '../../../core/v4/browserState';

const safeFetcher = () => Promise.resolve({ ok: true as const, text: '' });

describe('durable browser execution boundary', () => {
  let db: Database.Database;
  let engine: JobEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances
         (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('browser-instance',1,'localhost',?,?,'4.19.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
  });

  afterEach(() => db.close());

  function context(key: string) {
    const admitted = engine.submitJob({
      entryPoint: 'test', source: 'browser-test', sessionId: `session-${key}`,
      workspaceId: `workspace-${key}`, instanceId: 'browser-instance',
      idempotencyNamespace: 'browser-execution', idempotencyKey: key, goal: key,
    });
    const lease = engine.claimAttempt({
      attemptId: admitted.attemptId, ownerId: 'browser-instance', ttlMs: 60_000,
    });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('lease');
    return {
      engine, jobId: admitted.jobId, attemptId: admitted.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken,
      producer: 'browser-test', workspacePath: `workspace-${key}`,
    };
  }

  function state(sequence: Array<{ url: string; hash: string }>): BrowserState {
    let index = 0;
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => {
        const item = sequence[Math.min(index++, sequence.length - 1)];
        return {
          ok: true, url: item.url, title: 'Fixture', dom_text_hash: item.hash,
          frame_tree_hash: 'frame',
        };
      },
    }));
    return state;
  }

  const toolContext = { signal: undefined } as unknown as ToolContext;

  it('persists one verified receipt and bounded Evidence for observable progress', async () => {
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 'test', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() { return { success: true }; },
    };
    const wrapped = withBrowserState(handler, state([
      { url: 'https://fixture.test/start', hash: 'before' },
      { url: 'https://fixture.test/done', hash: 'after' },
    ]), safeFetcher);
    await runWithJobExecutionContext(context('verified'), () => wrapped.execute({}, toolContext));
    const receipt = db.prepare(
      'SELECT state,command_ok,semantic_ok,evidence_ids_json FROM browser_action_receipts',
    ).get() as { state: string; command_ok: number; semantic_ok: number; evidence_ids_json: string };
    expect(receipt).toMatchObject({ state: 'verified', command_ok: 1, semantic_ok: 1 });
    expect(JSON.parse(receipt.evidence_ids_json)).toHaveLength(1);
    expect(db.prepare('SELECT source FROM job_evidence').get()).toEqual({ source: 'browser.browser_click' });
  });

  it('does not equate command success with semantic success when the page made no progress', async () => {
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 'test', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() { return { success: true }; },
    };
    const wrapped = withBrowserState(handler, state([
      { url: 'https://fixture.test/same', hash: 'same' },
      { url: 'https://fixture.test/same', hash: 'same' },
    ]), safeFetcher);
    await runWithJobExecutionContext(context('noop'), () => wrapped.execute({}, toolContext));
    expect(db.prepare('SELECT state,command_ok,semantic_ok FROM browser_action_receipts').get())
      .toEqual({ state: 'returned', command_ok: 1, semantic_ok: 0 });
  });

  it('records an unknown outcome when a mutating dispatch throws', async () => {
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 'test', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() { throw new Error('transport lost'); },
    };
    const wrapped = withBrowserState(handler, state([
      { url: 'https://fixture.test/start', hash: 'before' },
    ]), safeFetcher);
    await expect(runWithJobExecutionContext(context('unknown'), () => wrapped.execute({}, toolContext)))
      .rejects.toThrow('transport lost');
    expect(db.prepare('SELECT state,command_ok,semantic_ok,error_code FROM browser_action_receipts').get())
      .toEqual({ state: 'unknown', command_ok: 0, semantic_ok: null, error_code: 'ACTION_UNKNOWN' });
  });

  it('invalidates snapshot-scoped element leases after a successful mutation', async () => {
    let leases: LeaseStore | undefined;
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 'test', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() {
        leases = currentBrowserLeaseStore();
        leases.refresh(1, 'https://fixture.test/start', [{
          frame_id: 'main', role: 'button', tag: 'button', inputType: '', submit: false,
          ariaLabel: 'Continue', labelledByText: '', textContent: 'Continue', placeholder: '',
          alt: '', title: '', css_path: '#continue', bbox: { x: 1, y: 1, w: 10, h: 10 },
        }]);
        return { success: true };
      },
    };
    const wrapped = withBrowserState(handler, state([
      { url: 'https://fixture.test/start', hash: 'before' },
      { url: 'https://fixture.test/done', hash: 'after' },
    ]), safeFetcher);
    await runWithJobExecutionContext(context('lease'), () => wrapped.execute({}, toolContext));
    expect(leases?.all()).toEqual([]);
    expect(leases?.currentSnapshotId).toBe(0);
  });

  it('persists an unknown receipt and returns promptly when cancellation interrupts an in-flight mutation', async () => {
    const controller = new AbortController();
    let dispatched = false;
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 'test', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() {
        dispatched = true;
        return new Promise(() => undefined);
      },
    };
    const wrapped = withBrowserState(handler, state([
      { url: 'https://fixture.test/start', hash: 'before' },
    ]), safeFetcher);
    const executionContext = { ...context('cancel'), signal: controller.signal };
    const execution = runWithJobExecutionContext(executionContext, () => wrapped.execute({}, {
      signal: controller.signal,
    } as ToolContext));
    await vi.waitFor(() => expect(dispatched).toBe(true));
    controller.abort(new Error('cancelled by test'));
    await expect(execution).rejects.toThrow('cancelled by test');
    expect(db.prepare('SELECT state,command_ok,semantic_ok,error_code FROM browser_action_receipts').get())
      .toEqual({ state: 'unknown', command_ok: 0, semantic_ok: null, error_code: 'ACTION_CANCELLED' });
  });

  it('moves the exact durable browser session to user control when a login blocker is observed', async () => {
    const handler: ToolHandler = {
      schema: { name: 'browser_extract', description: 'test', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: false, toolset: 'browser',
      async execute() { return { success: true, url: 'https://fixture.test/login' }; },
    };
    const wrapped = withBrowserState(handler, state([
      { url: 'https://fixture.test/login', hash: 'login' },
      { url: 'https://fixture.test/login', hash: 'login' },
    ]), async () => ({ ok: true, text: 'Sign in with your password' }));
    const jobContext = context('blocker');
    const result = await runWithJobExecutionContext(jobContext, () => wrapped.execute({}, toolContext));
    expect((result as { browserState?: { blocker?: { kind?: string } } }).browserState?.blocker?.kind).toBe('login');
    expect(engine.browser.getSessionForAttempt(jobContext.jobId, jobContext.attemptId, jobContext.generation))
      .toMatchObject({ state: 'user_control_required', recoveryState: 'login:password' });
  });
});
