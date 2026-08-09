import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitTask,
  cancelTask,
  clearRunHandle,
  followRun,
  loadRuntimeInfo,
  parseTaskAdmission,
  persistRunHandle,
  reconcileRestoredRunHandle,
  restoreRunHandle,
  runTask,
  type TaskAdmission,
  type TurnHandlers,
  type V4Event,
} from '../../../dashboard-next/lib/aidenClient';

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

  it('A7 emits terminal completion exactly once when compatibility terminal events duplicate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      identity: { jobId: 'job_exact', attemptId: 'attempt_exact', runId: 41 },
      receipt: { terminal: true, status: 'verified', summary: 'done' },
    }, true, 200)));
    const done = vi.fn();
    const pending = followRun({ admission: admission(), lastEventId: 0 }, { onDone: done });
    const es = FakeEventSource.instances[0];
    es.emit(event(41, 1, 'ui', 'ui_task_done'));
    es.emit(event(41, 2, 'dispatcher.completed'));
    await pending;
    expect(done).toHaveBeenCalledTimes(1);
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
});
