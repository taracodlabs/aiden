import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  continueTask,
  loadContinuity,
  loadRunProjection,
} from '../../../dashboard-next/lib/aidenClient';

const response = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as Response);

describe('minimal Workbench continuity surface', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('E1 loads Job detail by exact durable identity', async () => {
    const fetchMock = vi.fn(async () => response({ identity: { jobId: 'job_1' }, receipt: { terminal: false, status: 'running' } }));
    vi.stubGlobal('fetch', fetchMock);
    await loadRunProjection('job_1', 'attempt_1', 7);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/jobs/job_1/projection?attemptId=attempt_1&runId=7',
      { cache: 'no-store' },
    );
  });
  it('E2 loads the current continuity checkpoint by Job identity', async () => {
    const fetchMock = vi.fn(async () => response({ checkpointId: 'checkpoint_1' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadContinuity('job_1')).resolves.toMatchObject({ checkpointId: 'checkpoint_1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job_1/continuity');
  });
  it('E3 treats an absent checkpoint as absent, not an empty success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'not found' }, 404)));
    await expect(loadContinuity('job_1')).resolves.toBeNull();
  });
  it('E4 sends Continue with exact checkpoint identity and idempotency key', async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true, decision: 'continued' }, 202));
    vi.stubGlobal('fetch', fetchMock);
    await expect(continueTask('checkpoint_1', 'job_1', 'key_1')).resolves.toMatchObject({ accepted: true, decision: 'continued' });
    expect(fetchMock).toHaveBeenCalledWith('/api/checkpoints/checkpoint_1/continue', expect.objectContaining({ body: JSON.stringify({ jobId: 'job_1', idempotencyKey: 'key_1' }) }));
  });
  it('E5 preserves a rejected Continue decision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ accepted: false, decision: 'blocked_unknown_effect', reason: 'reconcile' }, 409)));
    await expect(continueTask('checkpoint_1', 'job_1', 'key_1')).resolves.toEqual({ accepted: false, decision: 'blocked_unknown_effect', reason: 'reconcile' });
  });

  const source = () => fs.readFileSync(path.resolve('dashboard-next/app/page.tsx'), 'utf8');
  it('E6 exposes Active Work in the existing Activity view', () => expect(source()).toContain('<strong>Active Work '));
  it('E7 exposes exact Job, Attempt generation, and run identity', () => {
    const page = source();
    expect(page).toContain('projection.identity.jobId} · {projection.identity.attemptId}');
    expect(page).toContain('generation {projection.identity.generation ?? 0} · run {projection.identity.runId}');
  });
  it('E8 exposes the exact durable event timeline without showing a false empty state', () => {
    const page = source();
    expect(page).toContain('Timeline: {projection.timeline?.length ?? 0}');
    expect(page).toContain('Durable timeline restored');
    expect(page).toContain('projection.job?.status ?? projection.receipt.status');
    expect(page).not.toContain('Attempt Timeline:');
  });
  it('E9 exposes the Worker tree', () => expect(source()).toContain('Worker Tree:'));
  it('E10 exposes pending approvals and Evidence counts', () => {
    expect(source()).toContain('Pending Approvals:'); expect(source()).toContain('Evidence:');
  });
  it('E11 exposes the canonical result receipt status', () => expect(source()).toContain('projection.receipt.status'));
  it('E12 exposes continuity reason and blocked truth without a new shell', () => {
    expect(source()).toContain('<strong>Continuity / Continue</strong>');
    expect(source()).toContain('continuity.blockers.length');
    expect(source()).not.toContain('ContinuityDashboardShell');
  });

  it('clears the prior transcript when selecting an active Job without cached messages', () => {
    const page = source();
    expect(page).toContain('setMessages(stored ?? [])');
    expect(page).not.toContain('if (stored) setMessages(stored)');
  });
  it('E13 restores the exact admitted context on browser reload', () => {
    expect(source()).toContain('aiden.restoreRunHandle()');
    expect(source()).toContain('restored.admission.runId');
    expect(source()).toContain('restored.admission.jobId');
  });
  it('E14 exposes a guarded idempotent Continue action', () => {
    expect(source()).toContain('continueKeys.current[continuity.checkpointId]');
    expect(source()).toContain('aiden.continueTask(continuity.checkpointId, projection.identity.jobId, key)');
    expect(source()).toContain('Continue safely');
  });
  it('E15 labels Proof, recovery reason, and canonical receipt explicitly', () => {
    expect(source()).toContain('Verification / Proof');
    expect(source()).toContain('Recovery Reason:');
    expect(source()).toContain('Canonical Result Receipt');
  });
  it('E16 keeps running state until durable cancellation confirmation arrives', () => {
    const page = source();
    const stop = page.slice(page.indexOf('const stopExecution'), page.indexOf('// ── Send message'));
    expect(stop).toContain('await aiden.cancelTask(rid)');
    expect(stop).not.toContain('setIsStreaming(false)');
    expect(stop).not.toContain('setIsExecuting(false)');
  });
  it('E17 cleans up canonical projection polling when the view changes or settles', () => {
    expect(source()).toContain('window.clearInterval(poll)');
    expect(source()).toContain('projection?.receipt.terminal ? null');
  });
  it('E17b keeps the exact terminal Attempt and run bound after Job settlement', () => {
    const page = source();
    expect(page).toContain('aiden.loadRunProjection(jobId, attemptId, runId)');
    expect(page).toContain('attemptId={activeAttemptId}');
    expect(page).toContain('runId={activeRunId}');
  });
  it('E18 reattaches the run-scoped event follower after browser reload', () => {
    const page = source();
    const restore = page.slice(page.indexOf('let restored = aiden.restoreRunHandle()'), page.indexOf('// ── Plus menu state'));
    expect(restore).toContain('const replay = { admission: restored.admission, lastEventId: 0 }');
    expect(restore).toContain('aiden.followRun(replay');
    expect(restore).toContain("onConnectionState: (state)");
    expect(restore).toContain('activeRunFollowAbortRef.current = controller');
    expect(restore).toContain('signal: controller.signal');
    expect(restore).toContain('aiden.reconcileRestoredRunHandle(restored)');
    expect(restore).toContain("if (resolution.kind === 'missing') throw new Error('stale Workbench run handle')");
    expect(restore).toContain('aiden.clearRunHandle(restored.admission)');
  });
  it('E19 settles a terminal durable projection before attempting SSE restoration', () => {
    const page = source();
    const restore = page.slice(page.indexOf('let restored = aiden.restoreRunHandle()'), page.indexOf('// ── Plus menu state'));
    expect(restore).toContain('aiden.reconcileRestoredRunHandle(restored)');
    expect(restore).toContain('restored = resolution.handle');
    expect(restore).toContain("resolution.kind === 'terminal'");
    expect(restore.indexOf("resolution.kind === 'terminal'")).toBeLessThan(restore.indexOf('startReplay()'));
    expect(restore).toContain('aiden.clearRunHandle(restored.admission)');
    expect(restore).toContain('settle()');
  });
  it('E20 bounds restored SSE uncertainty and reports stale restoration honestly', () => {
    const page = source();
    const restore = page.slice(page.indexOf('let restored = aiden.restoreRunHandle()'), page.indexOf('// ── Plus menu state'));
    expect(restore).toContain('maxUncertainMs:');
    expect(restore).toContain('saved activity could not be restored');
  });
  it('E21 renders the backend runtime version instead of a hard-coded release', () => {
    const page = source();
    expect(page).not.toContain("const AIDEN_VERSION = '3.7.0'");
    expect(page).toContain('aiden.loadWorkbenchBootstrap()');
    expect(page).toContain('runtimeVersion');
  });
  it('E22 reconciles an explicit URL selection instead of skipping durable restoration', () => {
    const page = source();
    expect(page).toContain('selectionFromSearch(window.location.search)');
    expect(page).not.toContain('if (urlSelection.jobId || urlSelection.attemptId || urlSelection.runId !== null) return');
    expect(page).toContain('let restored = aiden.restoreRunHandle()');
    expect(page).toContain('aiden.reconcileRestoredRunHandle(restored)');
  });
  it('E23 scopes foreground output by exact Job identity when sessions share a context', () => {
    const page = source();
    expect(page).toContain('selected.jobId === admittedJobId');
    expect(page).toContain('activeRunFollowControllersRef');
  });
  it('E24 restores conversation content when browser history changes the selection', () => {
    const page = source();
    expect(page).toContain('window.addEventListener(\'popstate\', onPopState)');
    expect(page).toContain('setMessages(conversation.messages)');
    expect(page).toContain('window.history.pushState');
  });
  it('E25 uses one authoritative bootstrap request path and starts disconnected', () => {
    const page = source();
    expect(page.match(/aiden\.loadWorkbenchBootstrap\(\)/g)).toHaveLength(1);
    expect(page).not.toContain('aiden.loadRuntimeInfo()');
    expect(page).toContain("useState<'connected' | 'reconnecting' | 'unavailable'>('unavailable')");
  });
  it('E26 never clears a live foreground activity merely because wall-clock time elapsed', () => {
    const page = source();
    expect(page).not.toContain('setTimeout(() => setThinking(null), 30000)');
  });
  it('E27 keeps task submission explicitly unavailable when execution authority is absent', () => {
    const page = source();
    expect(page).toContain('disabled={(!input.trim() && attachments.length === 0) || (isStreaming && hasSelectedWork) || !executionAvailable || workbenchReadOnly}');
    expect(page).toContain('Task execution is unavailable. Configure a provider with the Aiden CLI');
  });
  it('E28 binds a delayed admission only when its original empty conversation is still selected', () => {
    const page = source();
    expect(page).toContain('const attachToForeground = shouldAttachAdmission(');
    expect(page).toContain('workbenchControllerRef.current.register(admission, requestSessionId, userMsg.content)');
    expect(page).toContain('if (attachToForeground) {');
  });
  it('E29 persists a completed turn even when durable Proof remains unknown', () => {
    const page = source();
    expect(page).toContain('const persistTurn = () => {');
    expect(page.match(/persistTurn\(\)/g)).toHaveLength(2);
  });
  it('persists exact Attempt and run identity with completed conversation history', () => {
    const page = source();
    const persist = page.slice(page.indexOf('const persistTurn = () => {'), page.indexOf('// Send onto the v4 safe job path'));
    expect(persist).toContain('attemptId: admittedAttemptId ?? c.attemptId');
    expect(persist).toContain('runId: admittedRunId ?? c.runId');
    expect(persist).toContain('attemptId: admittedAttemptId ?? undefined');
    expect(persist).toContain('runId: admittedRunId ?? undefined');
  });
});
