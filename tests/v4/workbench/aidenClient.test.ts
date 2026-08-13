import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitTask,
  assistantOutputText,
  cancelTask,
  controlBrowserSession,
  clearRunHandle,
  followRun,
  loadRuntimeInfo,
  loadBrowserSession,
  loadWorkbenchBootstrap,
  parseTaskAdmission,
  persistRunHandle,
  reconcileRestoredRunHandle,
  restoreRunHandle,
  runTask,
  type ActivityItem,
  type TaskAdmission,
  type TurnHandlers,
  type V4Event,
} from '../../../dashboard-next/lib/aidenClient';
import { mergeLiveActivity } from '../../../dashboard-next/lib/workbenchUx';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(event: V4Event): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  close(): void { this.closed = true; }
}

const admission = (overrides: Partial<TaskAdmission> = {}): TaskAdmission => ({
  accepted: true,
  jobId: 'job_exact',
  attemptId: 'attempt_exact',
  runId: 41,
  triggerEventId: 17,
  duplicate: false,
  ...overrides,
});

const event = (runId: number, id: number, kind: string, name: string | null = null): V4Event => ({
  id,
  runId,
  sessionId: 'session_exact',
  ts: id,
  category: 'runtime',
  kind,
  name,
  status: null,
  durationMs: null,
  summary: null,
  payload: {},
});

const response = (body: unknown, ok = true, status = 202): Response => ({
  ok,
  status,
  json: async () => body,
} as Response);

describe('Workbench exact task admission and run following', () => {
  it('loads provider/model/runtime from the bounded Workbench bootstrap contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        runtime: { version: '4.19.1', status: 'ready', local: true },
        provider: { id: 'chatgpt-plus', displayName: 'ChatGPT Plus' },
        model: { id: 'gpt-5.5', displayName: 'GPT-5.5' },
        connection: 'connected', readOnly: false,
        execution: { available: true, runner: 'real', workerCount: 4, pending: 2, claimed: 1, inflight: 1, oldestPendingMs: 80, processed: 5 },
        activeJobs: [{
          sessionId: 'session_a', jobId: 'job_a', attemptId: 'attempt_a', runId: 7,
          title: 'Inspect package.json', status: 'approval_required', statusDetail: 'Approval required',
          updatedAt: 10, triggerEventId: 9, triggerStatus: 'claimed',
          queue: { pending: 2, claimed: 1, oldestPendingMs: 80 },
        }],
      }),
    } as Response)));
    await expect(loadWorkbenchBootstrap()).resolves.toMatchObject({
      runtime: { version: '4.19.1' },
      provider: { id: 'chatgpt-plus' },
      model: { id: 'gpt-5.5' },
      execution: { available: true, runner: 'real', workerCount: 4, pending: 2 },
      activeJobCount: 1,
      activeJobs: [{ jobId: 'job_a', runId: 7, status: 'approval_required', title: 'Inspect package.json' }],
    });
  });
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('window', { __WB_TOKEN__: 'token_exact' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('A1 parses the exact Job, Attempt, run, and trigger identities', () => {
    expect(parseTaskAdmission({
      accepted: true,
      job_id: 'job_exact',
      attempt_id: 'attempt_exact',
      run_id: 41,
      triggerEventId: 17,
      duplicate: false,
    })).toEqual(admission());
  });

  it.each([
    [{ accepted: true, attempt_id: 'attempt_exact', run_id: 41 }],
    [{ accepted: true, job_id: 'job_exact', run_id: 41 }],
    [{ accepted: true, job_id: 'job_exact', attempt_id: 'attempt_exact' }],
    [{ accepted: false, job_id: 'job_exact', attempt_id: 'attempt_exact', run_id: 41 }],
    [{ accepted: true, job_id: '', attempt_id: 'attempt_exact', run_id: 41 }],
  ])('A2 fails closed for malformed admission %j', (wire) => {
    expect(() => parseTaskAdmission(wire)).toThrow(/admission/i);
  });

  it('A3 consumes the admission response before opening the exact run stream', async () => {
    const fetchMock = vi.fn(async () => response({
      accepted: true, job_id: 'job_exact', attempt_id: 'attempt_exact', run_id: 41,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await admitTask('inspect repository');

    expect(handle.admission).toMatchObject(admission({ triggerEventId: undefined }));
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ method: 'POST' }));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('A4 scopes each concurrent handle to its own returned run even when events are interleaved', async () => {
    const repliesA: string[] = [];
    const repliesB: string[] = [];
    const a = { admission: admission({ jobId: 'job_a', attemptId: 'attempt_a', runId: 1 }), lastEventId: 0 };
    const b = { admission: admission({ jobId: 'job_b', attemptId: 'attempt_b', runId: 2 }), lastEventId: 0 };
    const pa = followRun(a, { onReply: (text) => repliesA.push(text) });
    const pb = followRun(b, { onReply: (text) => repliesB.push(text) });
    const [ea, eb] = FakeEventSource.instances;

    eb.emit({ ...event(2, 2, 'ui', 'assistant_message'), payload: { text: 'B' } });
    ea.emit({ ...event(1, 1, 'ui', 'assistant_message'), payload: { text: 'A' } });
    ea.emit({ ...event(2, 3, 'ui', 'assistant_message'), payload: { text: 'wrong' } });

    expect(repliesA).toEqual(['A']);
    expect(repliesB).toEqual(['B']);
    ea.close(); eb.close();
    void pa; void pb;
  });

  it('A5 uses persisted run replay so an event emitted before the POST response is not lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/tasks') return response({ accepted: true, job_id: 'job_exact', attempt_id: 'attempt_exact', run_id: 41 });
      return response({});
    }));
    const replies: string[] = [];
    const pending = runTask('race safe', { onReply: (text) => replies.push(text) });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain('/api/runs/41/events');
    es.emit({ ...event(41, 7, 'ui', 'assistant_message'), payload: { text: 'replayed' } });
    expect(replies).toEqual(['replayed']);
    es.close();
    void pending;
  });

  it('A6 ignores stale and foreign run events', () => {
    const replies: string[] = [];
    const handle = { admission: admission(), lastEventId: 12 };
    void followRun(handle, { onReply: (text) => replies.push(text) });
    const es = FakeEventSource.instances[0];
    es.emit({ ...event(41, 12, 'ui', 'assistant_message'), payload: { text: 'stale' } });
    es.emit({ ...event(99, 13, 'ui', 'assistant_message'), payload: { text: 'foreign' } });
    es.emit({ ...event(41, 14, 'ui', 'assistant_message'), payload: { text: 'current' } });
    expect(replies).toEqual(['current']);
  });

  it('projects an exact tool target from the durable serialized argument payload', () => {
    const activities: ActivityItem[] = [];
    void followRun({ admission: admission(), lastEventId: 0 }, { onActivity: (item) => activities.push(item) });
    const stream = FakeEventSource.instances[0];
    stream.emit({
      ...event(41, 15, 'tool.call.started', 'tool_call_started'),
      toolCallId: 'call_exact',
      payload: { toolName: 'file_read', args: JSON.stringify({ path: 'package.json', limit: 12000 }) },
    });
    stream.emit({
      ...event(41, 16, 'tool.call.completed', 'tool_call_completed'),
      toolCallId: 'call_exact',
      status: 'completed',
      durationMs: 12,
      payload: { toolName: 'file_read', durationMs: 12 },
    });

    expect(activities).toMatchObject([
      { id: 'tool:call_exact', detail: 'package.json', status: 'running' },
      { id: 'tool:call_exact', status: 'ok' },
    ]);
    expect(activities.reduce(mergeLiveActivity, [])).toMatchObject([
      { id: 'tool:call_exact', detail: 'package.json', status: 'ok', durationMs: 12 },
    ]);
  });

  it('A7 treats ui_task_done as ephemeral and settles only from durable terminal truth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: true, status: 'verified', summary: 'done' },
    }, true, 200)));
    const done = vi.fn();
    const pending = followRun({ admission: admission(), lastEventId: 0 }, { onDone: done });
    const es = FakeEventSource.instances[0];
    es.emit(event(41, 1, 'ui', 'ui_task_done'));
    expect(done).not.toHaveBeenCalled();
    es.emit(event(41, 2, 'dispatcher.completed'));
    await pending;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('keeps following while final synthesis continues after ui_task_done', async () => {
    vi.useFakeTimers();
    let terminal = false;
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      assistantOutput: terminal ? [{ eventId: 7, sequence: 1, text: 'late answer' }] : [],
      receipt: terminal
        ? { terminal: true, status: 'verified', summary: 'done' }
        : { terminal: false, status: 'running' },
    }, true, 200)));
    const snapshots = vi.fn();
    const done = vi.fn();
    const error = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onReplySnapshot: snapshots, onDone: done, onError: error },
      { stallMs: 25_000 },
    );
    const es = FakeEventSource.instances[0];
    es.emit(event(41, 1, 'ui', 'ui_task_done'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(done).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    terminal = true;
    es.emit(event(41, 2, 'dispatcher.completed'));
    await pending;
    expect(snapshots).toHaveBeenCalledWith('late answer');
    expect(done).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps task completion summaries out of assistant output and hydrates durable reply truth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      assistantOutput: [
        { eventId: 12, sequence: 1, text: 'Authoritative ' },
        { eventId: 13, sequence: 2, text: 'answer' },
      ],
      receipt: { terminal: true, status: 'verified', summary: 'task step summary' },
    }, true, 200)));
    const chunks: string[] = [];
    const snapshots: string[] = [];
    const done = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      {
        onReply: (text) => chunks.push(text),
        onReplySnapshot: (text) => snapshots.push(text),
        onDone: done,
      },
    );
    const stream = FakeEventSource.instances[0];

    stream.emit({
      ...event(41, 10, 'task.done', 'ui_task_done'),
      payload: { status: 'success', summary: 'Read package.json, README.md, and tsconfig.json' },
    });
    await pending;

    expect(chunks).toEqual([]);
    expect(snapshots).toEqual(['Authoritative answer']);
    expect(done).toHaveBeenCalledOnce();
  });

  it('reconciles a final Job event that arrives while an earlier terminal check is in flight', async () => {
    let releaseFirstProjection!: () => void;
    const firstProjectionBlocked = new Promise<void>((resolve) => { releaseFirstProjection = resolve; });
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        await firstProjectionBlocked;
        return response({
          identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
          receipt: { terminal: false, status: 'running' },
        }, true, 200);
      }
      return response({
        identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
        receipt: { terminal: true, status: 'verified', summary: 'done' },
      }, true, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();
    const pending = followRun({ admission: admission(), lastEventId: 0 }, { onDone: done });
    const es = FakeEventSource.instances[0];

    es.emit(event(41, 1, 'dispatcher.completed'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    es.emit(event(41, 2, 'job.finalized'));
    releaseFirstProjection();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 250 });
    await pending;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('hydrates authoritative assistant output when the live chunk event was missed', async () => {
    const fetchMock = vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      assistantOutput: [
        { eventId: 10, sequence: 1, text: 'first ' },
        { eventId: 11, sequence: 2, text: 'second' },
      ],
      receipt: { terminal: true, status: 'verified', summary: 'done' },
    }, true, 200));
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = vi.fn();
    const done = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onDone: done, onReplySnapshot: snapshot } as TurnHandlers & { onReplySnapshot: (text: string) => void },
    );
    FakeEventSource.instances[0].emit(event(41, 12, 'dispatcher.completed'));
    await pending;
    expect(snapshot).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledWith('first second');
    expect(done).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/projection?attemptId=attempt_exact&runId=41'),
      { cache: 'no-store' },
    );
  });

  it('normalizes durable response chunks by sequence and event identity', () => {
    expect(assistantOutputText({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: true, status: 'verified' },
      assistantOutput: [
        { eventId: 12, sequence: 2, text: 'second' },
        { eventId: 11, sequence: 1, text: 'first ' },
        { eventId: 11, sequence: 1, text: 'duplicate' },
      ],
    })).toBe('first second');
  });

  it('replaces live partial output with the exact durable terminal snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      assistantOutput: [
        { eventId: 1, sequence: 1, text: 'first ' },
        { eventId: 2, sequence: 2, text: 'second' },
      ],
      receipt: { terminal: true, status: 'verified', summary: 'done' },
    }, true, 200)));
    const chunks: string[] = [];
    const snapshots: string[] = [];
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onReply: (text) => chunks.push(text), onReplySnapshot: (text) => snapshots.push(text) },
    );
    const stream = FakeEventSource.instances[0];
    stream.emit({ ...event(41, 1, 'assistant.message', 'assistant_message'), payload: { text: 'first ' } });
    stream.emit(event(41, 3, 'dispatcher.completed'));
    await pending;
    expect(chunks).toEqual(['first ']);
    expect(snapshots).toEqual(['first second']);
  });

  it('rechecks durable truth when completion is observed before Job finalization', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: fetchMock.mock.calls.length === 1
        ? { terminal: false, status: 'running' }
        : { terminal: true, status: 'verified', summary: 'done' },
    }, true, 200));
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onDone: done },
      { stallMs: 10_000 },
    );
    FakeEventSource.instances[0].emit(event(41, 12, 'dispatcher.completed'));
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(done).toHaveBeenCalledOnce();
  });

  it('A8 does not classify stream silence as successful completion', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: false, status: 'running' },
    }, true, 200)));
    const done = vi.fn();
    const state = vi.fn();
    void followRun({ admission: admission(), lastEventId: 0 }, { onDone: done, onConnectionState: state }, { stallMs: 25 });
    await vi.advanceTimersByTimeAsync(30);
    expect(done).not.toHaveBeenCalled();
    expect(state).toHaveBeenCalledWith('stalled');
  });

  it('A9 treats a disconnected stream as reconnecting, not terminal', () => {
    const done = vi.fn();
    const state = vi.fn();
    void followRun({ admission: admission(), lastEventId: 0 }, { onDone: done, onConnectionState: state });
    FakeEventSource.instances[0].onerror?.();
    expect(state).toHaveBeenCalledWith('reconnecting');
    expect(done).not.toHaveBeenCalled();
  });

  it('A10 parses cancellation acceptance instead of trusting HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ accepted: false, runId: 41 }, true, 202)));
    await expect(cancelTask(41)).resolves.toBe(false);
  });

  it('A11 sends controls only to the exact admitted run', async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true, runId: 41 }, true, 202));
    vi.stubGlobal('fetch', fetchMock);
    const handle = { admission: admission(), lastEventId: 0 };
    await cancelTask(handle);
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/41/cancel', expect.anything());
  });

  it('A12 rejects a durable projection whose identity does not match the admission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_other', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: true, status: 'verified' },
    }, true, 200)));
    const error = vi.fn();
    const pending = followRun({ admission: admission(), lastEventId: 0 }, { onError: error });
    FakeEventSource.instances[0].emit(event(41, 1, 'dispatcher.completed'));
    await pending;
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/identity/i));
  });

  it('A13 preserves the latest durable event cursor on the run handle', () => {
    const handle = { admission: admission(), lastEventId: 0 };
    void followRun(handle, {});
    FakeEventSource.instances[0].emit(event(41, 9, 'ui', 'ui_task_update'));
    expect(handle.lastEventId).toBe(9);
  });

  it('A14 includes the cursor when following a reloaded handle', () => {
    void followRun({ admission: admission(), lastEventId: 27 }, {});
    expect(FakeEventSource.instances[0].url).toContain('lastId=27');
  });

  it('A15 rejects terminal model prose without a durable terminal receipt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: false, status: 'running' },
    }, true, 200)));
    const done = vi.fn();
    void followRun({ admission: admission(), lastEventId: 0 }, { onDone: done });
    const es = FakeEventSource.instances[0];
    es.emit({ ...event(41, 1, 'ui', 'assistant_message'), payload: { text: 'I am done' } });
    es.emit(event(41, 2, 'dispatcher.completed'));
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
  });

  it('A16 reports admission rejection without opening a stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ accepted: false, error: 'blocked' }, false, 409)));
    await expect(admitTask('blocked')).rejects.toThrow(/blocked/);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('A17 exposes exact admission identity before any event callback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ accepted: true, job_id: 'job_exact', attempt_id: 'attempt_exact', run_id: 41 })));
    const ids: number[] = [];
    const pending = runTask('identity first', { onRunId: (id) => ids.push(id) });
    await vi.waitFor(() => expect(ids).toEqual([41]));
    FakeEventSource.instances[0].close();
    void pending;
  });

  it('A18 never adopts a dispatcher event as task identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ accepted: true, job_id: 'job_exact', attempt_id: 'attempt_exact', run_id: 41 })));
    const ids: number[] = [];
    const pending = runTask('exact identity', { onRunId: (id) => ids.push(id) });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.instances[0].emit(event(999, 1, 'dispatcher.invoked'));
    expect(ids).toEqual([41]);
    FakeEventSource.instances[0].close();
    void pending;
  });

  it('A19 restores the exact Job, Attempt, run, and event cursor after reload', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      __WB_TOKEN__: 'token_exact',
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const handle = { admission: admission(), lastEventId: 29 };
    persistRunHandle(handle);
    expect(restoreRunHandle()).toEqual(handle);
  });

  it('A19b clears a stale stored handle and its deep-link identity', () => {
    const values = new Map<string, string>([['aiden.workbench.active-run.v1', '{}']]);
    let href = 'http://127.0.0.1:4280/?job=job_stale&attempt=attempt_stale&run=9';
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
      location: { href },
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, next: URL) => { href = next.toString(); },
      },
    });
    clearRunHandle();
    expect(values.size).toBe(0);
    expect(href).toBe('http://127.0.0.1:4280/');
  });

  it('A20 rejects a corrupt reload handle instead of adopting partial identity', () => {
    const values = new Map<string, string>([['aiden.workbench.active-run.v1', JSON.stringify({
      admission: { accepted: true, job_id: 'job_exact', run_id: 41 },
      lastEventId: 9,
    })]]);
    vi.stubGlobal('window', {
      __WB_TOKEN__: 'token_exact',
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    expect(restoreRunHandle()).toBeNull();
    expect(values.size).toBe(0);
  });

  it('A21 restores an exact Job detail deep link without adopting stored foreign work', () => {
    const values = new Map<string, string>([['aiden.workbench.active-run.v1', JSON.stringify({
      admission: admission({ jobId: 'job_foreign', attemptId: 'attempt_foreign', runId: 99 }),
      lastEventId: 88,
    })]]);
    vi.stubGlobal('window', {
      __WB_TOKEN__: 'token_exact',
      location: { search: '?job=job_linked&attempt=attempt_linked&run=51' },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    expect(restoreRunHandle()).toEqual({
      admission: {
        accepted: true, jobId: 'job_linked', attemptId: 'attempt_linked', runId: 51, duplicate: false,
      },
      lastEventId: 0,
    });
  });
  it('A21b does not let one Job settlement clear another persisted run handle', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
      location: { href: 'http://127.0.0.1:4280/' },
      history: { state: null, replaceState: () => {} },
    });
    const handle = { admission: admission({ jobId: 'job_b', attemptId: 'attempt_b', runId: 2 }), lastEventId: 0 };
    persistRunHandle(handle);
    clearRunHandle({ jobId: 'job_a', attemptId: 'attempt_a', runId: 1 });
    expect(restoreRunHandle()).toEqual(handle);
    clearRunHandle(handle.admission);
    expect(restoreRunHandle()).toBeNull();
  });
  it('preserves the selected durable deep link when its active restore handle settles', () => {
    const values = new Map<string, string>();
    let href = 'http://127.0.0.1:4280/?session=session_exact&job=job_exact&attempt=attempt_exact&run=41';
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
      location: { href },
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, next: URL) => { href = next.toString(); },
      },
    });
    const handle = { admission: admission(), lastEventId: 29 };
    persistRunHandle(handle);

    clearRunHandle(handle.admission);

    expect(values.size).toBe(0);
    expect(href).toBe('http://127.0.0.1:4280/?session=session_exact&job=job_exact&attempt=attempt_exact&run=41');
  });
  it('A22 gives simultaneous submissions distinct exact run handles', async () => {
    let sequence = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      sequence += 1;
      return response({
        accepted: true,
        job_id: `job_${sequence}`,
        attempt_id: `attempt_${sequence}`,
        run_id: sequence,
      });
    }));
    const [first, second] = await Promise.all([admitTask('first'), admitTask('second')]);
    expect(first.admission).toMatchObject({ jobId: 'job_1', attemptId: 'attempt_1', runId: 1 });
    expect(second.admission).toMatchObject({ jobId: 'job_2', attemptId: 'attempt_2', runId: 2 });
  });
  it('A23 does not let a rejected event override a still-running durable Job', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: false, status: 'running' },
    }, true, 200)));
    const error = vi.fn();
    const done = vi.fn();
    const controller = new AbortController();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onError: error, onDone: done },
      { stallMs: 10_000, signal: controller.signal },
    );
    FakeEventSource.instances[0].emit({ ...event(41, 1, 'dispatcher.rejected'), summary: 'rejected event' });
    await Promise.resolve(); await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    controller.abort();
    await pending;
  });
  it('A24 presents a durable failed receipt as failure, not completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: true, status: 'failed', summary: 'verification failed' },
    }, true, 200)));
    const error = vi.fn();
    const done = vi.fn();
    const pending = followRun({ admission: admission(), lastEventId: 0 }, { onError: error, onDone: done });
    FakeEventSource.instances[0].emit(event(41, 1, 'dispatcher.completed'));
    await pending;
    expect(error).toHaveBeenCalledWith('verification failed');
    expect(done).not.toHaveBeenCalled();
  });
  it('A25 accepts cancellation only when the exact response body confirms it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ accepted: true, runId: 41 }, true, 202)));
    await expect(cancelTask({ admission: admission(), lastEventId: 0 })).resolves.toBe(true);
  });
  it('A26 disposes the stream and stall timer when its owner unmounts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const done = vi.fn();
    const error = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onDone: done, onError: error },
      { stallMs: 25, signal: controller.signal },
    );
    const stream = FakeEventSource.instances[0];
    controller.abort();
    await pending;
    await vi.advanceTimersByTimeAsync(50);
    expect(stream.closed).toBe(true);
    expect(done).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it('A27 lets one run settle from durable truth while another stream is disconnected', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response({
      identity: url.includes('job_b')
        ? { jobId: 'job_b', attemptId: 'attempt_b', runId: 2 }
        : { jobId: 'job_a', attemptId: 'attempt_a', runId: 1 },
      receipt: url.includes('job_b')
        ? { terminal: true, status: 'verified', summary: 'B complete' }
        : { terminal: false, status: 'running' },
    }, true, 200)));
    const abortA = new AbortController();
    const doneA = vi.fn();
    const doneB = vi.fn();
    const a = followRun(
      { admission: admission({ jobId: 'job_a', attemptId: 'attempt_a', runId: 1 }), lastEventId: 0 },
      { onDone: doneA },
      { signal: abortA.signal },
    );
    const b = followRun(
      { admission: admission({ jobId: 'job_b', attemptId: 'attempt_b', runId: 2 }), lastEventId: 0 },
      { onDone: doneB },
    );
    const [streamA, streamB] = FakeEventSource.instances;
    streamA.onerror?.();
    streamB.emit(event(2, 1, 'dispatcher.completed'));
    await b;
    expect(doneB).toHaveBeenCalledWith(expect.objectContaining({ status: 'verified' }));
    expect(doneA).not.toHaveBeenCalled();
    abortA.abort();
    await a;
  });
  it('A28 discovers terminal Proof through durable reconciliation when the UI event was missed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: true, status: 'verified', summary: 'proved without UI event' },
    }, true, 200)));
    const done = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onDone: done },
      { stallMs: 25 },
    );
    await vi.advanceTimersByTimeAsync(30);
    await pending;
    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      status: 'verified', summary: 'proved without UI event',
    }));
  });

  it('A29 classifies a terminal restored Job before opening a run stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: true, status: 'verified', summary: 'already complete' },
    }, true, 200)));

    await expect(reconcileRestoredRunHandle({ admission: admission(), lastEventId: 0 }))
      .resolves.toMatchObject({ kind: 'terminal', projection: { receipt: { status: 'verified' } } });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('A30 rejects a stale or foreign restored handle without opening a run stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'not found' }, false, 404)));
    await expect(reconcileRestoredRunHandle({ admission: admission(), lastEventId: 0 }))
      .resolves.toEqual({ kind: 'missing' });

    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_other', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: false, status: 'running' },
    }, true, 200)));
    await expect(reconcileRestoredRunHandle({ admission: admission(), lastEventId: 0 }))
      .resolves.toEqual({ kind: 'missing' });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('reattaches a restored Job to its current recovery Attempt instead of following the crashed run', async () => {
    const fetchMock = vi.fn(async (url: string) => response(url.includes('attempt_current') ? {
      identity: { jobId: 'job_exact', attemptId: 'attempt_current', runId: 42, generation: 2 },
      attempts: [
        { rowId: 41, id: 'attempt_exact', generation: 1, status: 'crashed' },
        { rowId: 42, id: 'attempt_current', generation: 2, status: 'running' },
      ],
      receipt: { terminal: false, status: 'running' },
    } : {
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41, generation: 1 },
      attempts: [
        { rowId: 41, id: 'attempt_exact', generation: 1, status: 'crashed' },
        { rowId: 42, id: 'attempt_current', generation: 2, status: 'running' },
      ],
      receipt: { terminal: false, status: 'running', summary: 'lease_expired' },
    }, true, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileRestoredRunHandle({ admission: admission(), lastEventId: 29 }))
      .resolves.toMatchObject({
        kind: 'active',
        handle: {
          admission: { jobId: 'job_exact', attemptId: 'attempt_current', runId: 42 },
          lastEventId: 0,
        },
        projection: { identity: { attemptId: 'attempt_current', runId: 42 } },
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves a terminal recovered Job through the authoritative replacement Attempt', async () => {
    const fetchMock = vi.fn(async (url: string) => response(url.includes('attempt_current') ? {
      identity: { jobId: 'job_exact', attemptId: 'attempt_current', runId: 42, generation: 2 },
      attempts: [
        { rowId: 41, id: 'attempt_exact', generation: 1, status: 'crashed' },
        { rowId: 42, id: 'attempt_current', generation: 2, status: 'succeeded' },
      ],
      assistantOutput: [{ eventId: 90, sequence: 1, text: 'recovered terminal output' }],
      receipt: { terminal: true, status: 'verified', summary: 'recovered' },
    } : {
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41, generation: 1 },
      attempts: [
        { rowId: 41, id: 'attempt_exact', generation: 1, status: 'crashed' },
        { rowId: 42, id: 'attempt_current', generation: 2, status: 'succeeded' },
      ],
      receipt: { terminal: true, status: 'unknown', summary: 'stop' },
    }, true, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileRestoredRunHandle({ admission: admission(), lastEventId: 29 }))
      .resolves.toMatchObject({
        kind: 'terminal',
        handle: {
          admission: { jobId: 'job_exact', attemptId: 'attempt_current', runId: 42 },
          lastEventId: 0,
        },
        projection: {
          identity: { attemptId: 'attempt_current', runId: 42 },
          assistantOutput: [{ text: 'recovered terminal output' }],
          receipt: { status: 'verified' },
        },
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('switches an in-flight restored follower to the recovery run after lease recovery', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => response(
      fetchMock.mock.calls.length >= 3 ? {
        identity: { jobId: 'job_exact', attemptId: 'attempt_current', runId: 42, generation: 2 },
        assistantOutput: [{ eventId: 90, sequence: 1, text: 'recovered output' }],
        receipt: { terminal: true, status: 'verified', summary: 'recovered' },
      } : url.includes('attempt_current') ? {
        identity: { jobId: 'job_exact', attemptId: 'attempt_current', runId: 42, generation: 2 },
        attempts: [{ rowId: 42, id: 'attempt_current', generation: 2, status: 'running' }],
        receipt: { terminal: false, status: 'running' },
      } : {
        identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41, generation: 1 },
        attempts: [
          { rowId: 41, id: 'attempt_exact', generation: 1, status: 'crashed' },
          { rowId: 42, id: 'attempt_current', generation: 2, status: 'running' },
        ],
        receipt: { terminal: false, status: 'running', summary: 'lease_expired' },
      },
      true,
      200,
    ));
    vi.stubGlobal('fetch', fetchMock);
    const reattached = vi.fn();
    const snapshot = vi.fn();
    const done = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onReattached: reattached, onReplySnapshot: snapshot, onDone: done },
      { stallMs: 10, maxUncertainMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(15);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(reattached).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'attempt_current', runId: 42 }));
    FakeEventSource.instances[1].emit(event(42, 91, 'dispatcher.completed'));
    await pending;
    expect(snapshot).toHaveBeenCalledWith('recovered output');
    expect(done).toHaveBeenCalledOnce();
  });

  it('A31 releases a restored run after bounded SSE uncertainty without claiming success', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: false, status: 'running' },
    }, true, 200)));
    const done = vi.fn();
    const error = vi.fn();
    const pending = followRun(
      { admission: admission(), lastEventId: 0 },
      { onDone: done, onError: error },
      { stallMs: 10, maxUncertainMs: 20 },
    );
    FakeEventSource.instances[0].onerror?.();
    await vi.advanceTimersByTimeAsync(30);
    await pending;
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not be confirmed/i));
    expect(done).not.toHaveBeenCalled();
  });

  it('A32 loads the running backend version from Workbench health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: true, service: 'aiden-workbench-bridge', version: '9.8.7-test', readOnly: false,
    }, true, 200)));
    await expect(loadRuntimeInfo()).resolves.toEqual({
      service: 'aiden-workbench-bridge', version: '9.8.7-test', readOnly: false,
    });
  });

  it('projects and controls only the selected durable browser Job', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => response({
      accepted: true,
      browser: {
        browserSessionId: 'browser_exact', jobId: 'job_exact', attemptId: 'attempt_exact',
        generation: 2, state: init?.method === 'POST' ? 'user_control' : 'ready', mode: 'owned',
      },
    }, true, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadBrowserSession('job_exact')).resolves.toMatchObject({
      browserSessionId: 'browser_exact', jobId: 'job_exact', state: 'ready',
    });
    await expect(controlBrowserSession('job_exact', 'take')).resolves.toMatchObject({
      browserSessionId: 'browser_exact', state: 'user_control',
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/jobs/job_exact/browser/take',
      expect.objectContaining({ method: 'POST', headers: { 'x-workbench-token': 'token_exact' } }),
    );
  });
});
