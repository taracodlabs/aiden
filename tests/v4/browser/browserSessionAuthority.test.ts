import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { BrowserAuthorityError } from '../../../core/v4/browser/browserSessionAuthority';
import { reconcileBrowserEffect } from '../../../core/v4/browser/browserEffectResolver';

describe('BrowserSession authority', () => {
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

  function admit(key: string, workspaceId = `workspace-${key}`) {
    const admission = engine.submitJob({
      entryPoint: 'test', source: 'browser-test', sessionId: `session-${key}`,
      workspaceId, instanceId: 'browser-instance', idempotencyNamespace: 'browser-session',
      idempotencyKey: key, goal: `browser ${key}`,
    });
    const lease = engine.claimAttempt({
      attemptId: admission.attemptId,
      ownerId: 'browser-instance',
      ttlMs: 60_000,
    });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('lease');
    return {
      jobId: admission.jobId,
      attemptId: admission.attemptId,
      generation: lease.generation,
      fenceToken: lease.fenceToken,
      workspaceId,
      mode: 'owned' as const,
      profileIdentity: 'aiden-default',
    };
  }

  it('creates one durable session identity per authoritative Attempt', () => {
    const binding = admit('one');
    const first = engine.browser!.ensureSession(binding);
    const replay = engine.browser!.ensureSession(binding);
    expect(replay.browserSessionId).toBe(first.browserSessionId);
    expect(first).toMatchObject({
      jobId: binding.jobId,
      attemptId: binding.attemptId,
      generation: binding.generation,
      workspaceId: binding.workspaceId,
      state: 'ready',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get()).toEqual({ n: 1 });
  });

  it('prevents one Job from operating another Job tab', () => {
    const a = admit('a');
    const b = admit('b');
    const sessionA = engine.browser!.ensureSession(a);
    engine.browser!.ensureSession(b);
    engine.browser!.bindTab(a, {
      tabId: 'tab-a', createdBy: 'aiden', controlled: true, openerTabId: null,
      purpose: 'primary', url: 'https://a.example.test', title: 'A',
    });
    expect(() => engine.browser!.assertActionable(b, 'tab-a')).toThrowError(
      expect.objectContaining({ code: 'TAB_NOT_OWNED' }),
    );
    expect(engine.browser!.listTabs(sessionA.browserSessionId)).toHaveLength(1);
  });

  it('rejects stale generation and fence authority', () => {
    const binding = admit('stale');
    engine.browser!.ensureSession(binding);
    expect(() => engine.browser!.assertActionable({ ...binding, generation: binding.generation + 1 }))
      .toThrowError(expect.objectContaining({ code: 'SESSION_NOT_AUTHORIZED' }));
    expect(() => engine.browser!.assertActionable({ ...binding, fenceToken: 'stale-fence' }))
      .toThrowError(expect.objectContaining({ code: 'SESSION_NOT_AUTHORIZED' }));
  });

  it('supersedes the prior session when a recovery Attempt becomes authoritative', () => {
    const first = admit('recover');
    const session = engine.browser!.ensureSession(first);
    db.prepare("UPDATE runs SET status='crashed', lease_expires_at=? WHERE attempt_id=?")
      .run(Date.now() - 1, first.attemptId);
    const recovered = engine.createRecoveryAttempt({
      jobId: first.jobId,
      recoveryOfAttemptId: first.attemptId,
      instanceId: 'browser-instance',
      triggerReason: 'test recovery',
      eventIdempotencyKey: 'browser-recovery',
      producer: 'test',
    });
    const lease = engine.claimAttempt({ attemptId: recovered.attemptId, ownerId: 'browser-instance', ttlMs: 60_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('recovery lease');
    const next = engine.browser!.ensureSession({
      jobId: first.jobId,
      attemptId: recovered.attemptId,
      generation: lease.generation,
      fenceToken: lease.fenceToken,
      workspaceId: first.workspaceId,
      mode: 'owned',
      profileIdentity: 'aiden-default',
    });
    expect(next.browserSessionId).not.toBe(session.browserSessionId);
    expect(engine.browser!.getSession(session.browserSessionId)?.state).toBe('lost');
  });

  it('invalidates future actions after cancellation and rejects late settlement', () => {
    const binding = admit('cancel');
    const session = engine.browser!.ensureSession(binding);
    const action = engine.browser!.beginAction(binding, {
      toolCallId: 'tool-call', effectId: null, tabId: null,
      actionType: 'browser_navigate', args: { url: 'https://example.test' },
      preStateDigest: 'before-cancel',
      expectedOutcome: { normalizedUrl: 'https://example.test' },
    });
    engine.cancelJob({
      jobId: binding.jobId, reason: 'test', producer: 'test', eventIdempotencyKey: 'cancel-browser',
    });
    engine.browser!.cancelSession(session.browserSessionId, 'job cancelled');
    expect(() => engine.browser!.assertActionable(binding)).toThrowError(BrowserAuthorityError);
    expect(engine.browser!.completeAction(binding, action.actionId, {
      outcome: 'verified', commandOk: true, semanticOk: true,
      postStateDigest: 'late', verification: { ok: true }, evidencePayload: null,
    })).toMatchObject({ applied: false, late: true });
  });

  it('protects user tabs while allowing owned-tab cleanup', () => {
    const binding = admit('cleanup');
    const session = engine.browser!.ensureSession(binding);
    engine.browser!.bindTab(binding, {
      tabId: 'owned', createdBy: 'aiden', controlled: true, openerTabId: null,
      purpose: 'primary', url: 'about:blank', title: '',
    });
    engine.browser!.bindTab(binding, {
      tabId: 'user', createdBy: 'user', controlled: false, openerTabId: null,
      purpose: 'explicit-user-tab', url: 'https://user.example.test', title: 'User',
    });
    expect(engine.browser!.canCloseTab(binding, 'owned')).toBe(true);
    expect(engine.browser!.canCloseTab(binding, 'user')).toBe(false);
    engine.browser!.closeSession(binding, 'completed');
    expect(engine.browser!.getSession(session.browserSessionId)?.state).toBe('closed');
    expect(engine.browser!.listTabs(session.browserSessionId).every((tab) => !tab.controlled)).toBe(true);
  });

  it('removes actionable browser authority when the owning lifecycle settles', () => {
    const binding = admit('settled');
    const session = engine.browser.ensureSession(binding);
    engine.browser.bindTab(binding, {
      tabId: 'owned-settled', createdBy: 'aiden', controlled: true, openerTabId: null, url: 'about:blank',
    });
    engine.browser.bindTab(binding, {
      tabId: 'user-settled', createdBy: 'user', controlled: false, openerTabId: null, url: 'https://user.example.test',
    });
    const settled = engine.browser.settleSession(binding, 'closed', 'completed');
    expect(settled.state).toBe('closed');
    expect(settled.controlledTabId).toBeNull();
    expect(() => engine.browser.assertActionable(binding)).toThrowError(
      expect.objectContaining({ code: 'SESSION_NOT_ACTIONABLE' }),
    );
    expect(engine.browser.getSession(session.browserSessionId)?.closedAt).not.toBeNull();
    expect(engine.browser.listTabs(session.browserSessionId)).toEqual([
      expect.objectContaining({ tabId: 'owned-settled', closedAt: expect.any(Number) }),
      expect.objectContaining({ tabId: 'user-settled', closedAt: null }),
    ]);
  });

  it('keeps navigation history and budgets isolated per Job', () => {
    const a = admit('budget-a');
    const b = admit('budget-b');
    const sessionA = engine.browser.ensureSession(a);
    const sessionB = engine.browser.ensureSession(b);
    engine.browser.bindTab(a, { tabId: 'a', createdBy: 'aiden', controlled: true, openerTabId: null, url: 'about:blank' });
    engine.browser.bindTab(b, { tabId: 'b', createdBy: 'aiden', controlled: true, openerTabId: null, url: 'about:blank' });
    engine.browser.recordObservation(a, {
      tabId: 'a', url: 'https://example.test/path?utm_source=test', title: 'A', stateDigest: 'a1',
    });
    expect(engine.browser.canRepeatNavigation(a, 'https://example.test/path')).toBe(false);
    expect(engine.browser.canRepeatNavigation(b, 'https://example.test/path')).toBe(true);
    expect(sessionA.browserSessionId).not.toBe(sessionB.browserSessionId);
  });

  it('enforces per-Job action and tab budgets without blocking an existing controlled tab', () => {
    const previousNavigations = process.env.AIDEN_BROWSER_MAX_NAVIGATIONS;
    const previousTabs = process.env.AIDEN_BROWSER_MAX_TABS;
    process.env.AIDEN_BROWSER_MAX_NAVIGATIONS = '1';
    process.env.AIDEN_BROWSER_MAX_TABS = '1';
    try {
      const a = admit('hard-budget-a');
      const b = admit('hard-budget-b');
      engine.browser.ensureSession(a);
      engine.browser.ensureSession(b);
      const firstTab = { tabId: 'only-a', createdBy: 'aiden' as const, controlled: true, openerTabId: null, url: 'about:blank' };
      engine.browser.bindTab(a, firstTab);
      expect(() => engine.browser.bindTab(a, firstTab)).not.toThrow();
      expect(() => engine.browser.bindTab(a, { ...firstTab, tabId: 'extra-a' }))
        .toThrowError(expect.objectContaining({ code: 'BUDGET_EXHAUSTED' }));

      engine.browser.beginAction(a, {
        toolCallId: null, effectId: null, tabId: 'only-a', actionType: 'browser_navigate',
        args: { url: 'https://first.example.test' },
        preStateDigest: 'budget-a-1',
      });
      expect(() => engine.browser.beginAction(a, {
        toolCallId: null, effectId: null, tabId: 'only-a', actionType: 'browser_navigate',
        args: { url: 'https://second.example.test' },
        preStateDigest: 'budget-a-2',
      })).toThrowError(expect.objectContaining({ code: 'BUDGET_EXHAUSTED' }));
      expect(() => engine.browser.beginAction(b, {
        toolCallId: null, effectId: null, tabId: null, actionType: 'browser_navigate',
        args: { url: 'https://independent.example.test' },
        preStateDigest: 'budget-b-1',
      })).not.toThrow();
    } finally {
      if (previousNavigations === undefined) delete process.env.AIDEN_BROWSER_MAX_NAVIGATIONS;
      else process.env.AIDEN_BROWSER_MAX_NAVIGATIONS = previousNavigations;
      if (previousTabs === undefined) delete process.env.AIDEN_BROWSER_MAX_TABS;
      else process.env.AIDEN_BROWSER_MAX_TABS = previousTabs;
    }
  });

  it('stops a repeated no-progress action while allowing a changed replan', () => {
    const binding = admit('loop');
    engine.browser.ensureSession(binding);
    const first = engine.browser.beginAction(binding, {
      toolCallId: null, effectId: null, tabId: null, actionType: 'browser_click',
      args: { selector: '#same' }, preStateDigest: 'unchanged',
    });
    engine.browser.markActionDispatched(binding, first.actionId);
    engine.browser.completeAction(binding, first.actionId, {
      outcome: 'returned', commandOk: true, semanticOk: false,
      postStateDigest: 'unchanged', verification: { progress: 0 }, evidencePayload: null,
    });
    expect(() => engine.browser.beginAction(binding, {
      toolCallId: null, effectId: null, tabId: null, actionType: 'browser_click',
      args: { selector: '#same' }, preStateDigest: 'unchanged',
    })).toThrowError(expect.objectContaining({ code: 'NO_PROGRESS' }));
    expect(() => engine.browser.beginAction(binding, {
      toolCallId: null, effectId: null, tabId: null, actionType: 'browser_click',
      args: { selector: '#alternative' }, preStateDigest: 'unchanged',
    })).not.toThrow();
  });

  it('refuses a mutation that has no fresh pre-action observation', () => {
    const binding = admit('fresh-observation');
    engine.browser.ensureSession(binding);
    expect(() => engine.browser.beginAction(binding, {
      toolCallId: null, effectId: null, tabId: null,
      actionType: 'browser_click', args: { selector: '#submit' }, preStateDigest: null,
    })).toThrowError(expect.objectContaining({ code: 'FRESH_OBSERVATION_REQUIRED' }));
    expect(() => engine.browser.beginAction(binding, {
      toolCallId: null, effectId: null, tabId: null,
      actionType: 'browser_extract', args: {}, preStateDigest: null,
    })).not.toThrow();
  });

  it('lets a recovery Attempt inspect and reconcile a prior unknown action without replaying it', async () => {
    const first = admit('reconcile');
    engine.browser.ensureSession(first);
    const action = engine.browser.beginAction(first, {
      toolCallId: null, effectId: null, tabId: null, actionType: 'browser_click',
      args: { selector: '#submit' }, preStateDigest: 'before',
    });
    engine.browser.markActionDispatched(first, action.actionId);
    engine.browser.completeAction(first, action.actionId, {
      outcome: 'unknown', commandOk: false, semanticOk: null, postStateDigest: null,
      verification: { reason: 'response_lost' }, evidencePayload: null,
    });
    db.prepare("UPDATE runs SET status='crashed', lease_expires_at=? WHERE attempt_id=?")
      .run(Date.now() - 1, first.attemptId);
    const recovered = engine.createRecoveryAttempt({
      jobId: first.jobId, recoveryOfAttemptId: first.attemptId, instanceId: 'browser-instance',
      triggerReason: 'reconcile unknown browser effect', eventIdempotencyKey: 'browser-reconcile', producer: 'test',
    });
    const lease = engine.claimAttempt({ attemptId: recovered.attemptId, ownerId: 'browser-instance', ttlMs: 60_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('recovery lease');
    const next = { ...first, attemptId: recovered.attemptId, generation: lease.generation, fenceToken: lease.fenceToken };
    expect(engine.browser.ensureSession(next)).toMatchObject({
      state: 'reconciling', recoveryState: 'reconcile_prior_unknown_actions',
    });
    expect(engine.browser.listUnresolvedActions(first.jobId)).toEqual([
      expect.objectContaining({ actionId: action.actionId, state: 'unknown' }),
    ]);
    let inspections = 0;
    const resolution = await reconcileBrowserEffect({
      authority: engine.browser,
      binding: next,
      actionId: action.actionId,
      inspect: async () => {
        inspections += 1;
        return {
          outcome: 'verified', verification: { recordId: 'fixture-1' },
          evidencePayload: { recordId: 'fixture-1' },
        };
      },
    });
    expect(inspections).toBe(1);
    expect(resolution.receipt).toMatchObject({ state: 'verified', semanticOk: true });
    expect(engine.browser.getSessionForAttempt(first.jobId, recovered.attemptId, lease.generation))
      .toMatchObject({ state: 'ready', recoveryState: 'none' });
    expect(engine.proof.listEvidence(first.jobId).at(-1)).toMatchObject({
      attemptId: recovered.attemptId,
      generation: lease.generation,
      source: 'browser.reconciliation',
      verificationResult: 'verified',
    });
  });

  it('requires a fresh observation after user takeover before another action', () => {
    const binding = admit('takeover');
    engine.browser.ensureSession(binding);
    engine.browser.bindTab(binding, {
      tabId: 'controlled', createdBy: 'aiden', controlled: true, openerTabId: null,
      url: 'https://example.test/start', title: 'Start',
    });
    engine.browser.requireUserControl(binding, 'login_required');
    expect(engine.browser.takeUserControl(binding).state).toBe('user_control');
    expect(engine.browser.returnControl(binding)).toMatchObject({
      state: 'reconciling', recoveryState: 'fresh_observation_required',
    });
    expect(() => engine.browser.beginAction(binding, {
      toolCallId: null, effectId: null, tabId: 'controlled', actionType: 'browser_click', args: { ref: 'button' }, preStateDigest: 'fresh',
    })).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_ACTIONABLE' }));
    engine.browser.recordObservation(binding, {
      tabId: 'controlled', url: 'https://example.test/after-login', title: 'Ready', stateDigest: 'fresh',
    });
    expect(engine.browser.getSessionForAttempt(binding.jobId, binding.attemptId, binding.generation))
      .toMatchObject({ state: 'ready', recoveryState: 'none' });
    expect(() => engine.browser.beginAction(binding, {
      toolCallId: null, effectId: null, tabId: 'controlled', actionType: 'browser_click', args: { ref: 'button' }, preStateDigest: 'fresh',
    })).not.toThrow();
  });

  it('reuses exact equivalent source Evidence instead of creating uncontrolled copies', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const binding = admit('evidence-dedup');
      engine.browser.ensureSession(binding);
      const complete = () => {
        const action = engine.browser.beginAction(binding, {
          toolCallId: 'tool-read', effectId: null, tabId: null,
          actionType: 'browser_extract', args: { source: 'main' }, preStateDigest: 'same-pre',
        });
        engine.browser.markActionDispatched(binding, action.actionId);
        return engine.browser.completeAction(binding, action.actionId, {
          outcome: 'verified', commandOk: true, semanticOk: true, postStateDigest: 'same-post',
          verification: { contentDigest: 'same-content' },
          evidencePayload: { url: 'https://example.test/source', contentDigest: 'same-content' },
        }).receipt;
      };
      const first = complete();
      const second = complete();
      expect(first.evidenceIds).toHaveLength(1);
      expect(second.evidenceIds).toEqual(first.evidenceIds);
      expect(engine.proof.listEvidence(binding.jobId)).toHaveLength(1);
      expect(engine.proof.listEvidence(binding.jobId)[0].payload).toMatchObject({
        browserActionId: first.actionId, toolCallId: 'tool-read',
      });
    } finally {
      clock.mockRestore();
    }
  });
});
