import { afterEach, describe, expect, it, vi } from 'vitest';

import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
import type { WorkbenchLearningPort } from '../../../core/v4/workbench/learningPort';

const TOKEN = 'learning-token';
const reader = { listEventsScoped: () => [] };
let bridge: WorkbenchBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function port(): WorkbenchLearningPort {
  const entry = { id: 'learning_1', content: 'Prefer concise answers.', confidence: 'TRUSTED', lifecycle: 'ACTIVE', version: 1 };
  return {
    snapshot: vi.fn(() => ({ enabled: true, trusted: [entry], needsReview: [], archived: [], conflicts: [], counts: { trusted: 1, needsReview: 0, conflicts: 0, archived: 0 } }) as never),
    review: vi.fn(() => ({ entry, history: [], versions: [], sources: [], conflicts: [] }) as never),
    remember: vi.fn(() => entry as never),
    edit: vi.fn(() => ({ ...entry, version: 2 }) as never),
    rollback: vi.fn(() => ({ ...entry, version: 2 }) as never),
    demote: vi.fn(() => ({ ...entry, lifecycle: 'DEMOTED', version: 2 }) as never),
    archive: vi.fn(() => ({ ...entry, lifecycle: 'ARCHIVED', version: 2 }) as never),
    delete: vi.fn(() => ({ ...entry, lifecycle: 'DELETED', content: null, version: 2 }) as never),
    export: vi.fn(() => ({ exportedAt: 1, entries: [entry], sources: [], conflicts: [] }) as never),
    rebuild: vi.fn(() => ({ entries: 1, indexed: 1, conflicts: 0 })),
  };
}

describe('Workbench Learning bridge', () => {
  it('token-gates private reads and returns the bounded current projection', async () => {
    const learning = port();
    bridge = await startWorkbenchBridge({ reader, learning, token: TOKEN, port: 0 });
    expect((await request('/api/learning')).status).toBe(401);
    expect(await request('/api/learning', { headers: { 'x-workbench-token': TOKEN } })).toMatchObject({
      status: 200, body: { enabled: true, trusted: [expect.objectContaining({ id: 'learning_1' })] },
    });
    expect((await request('/api/learning/learning_1', { headers: { 'x-workbench-token': TOKEN } })).status).toBe(200);
  });

  it('token-gates every mutation and forwards only typed bounded fields', async () => {
    const learning = port();
    bridge = await startWorkbenchBridge({ reader, learning, token: TOKEN, port: 0 });
    const body = JSON.stringify({
      content: 'Prefer concise answers.', subjectKey: 'style', type: 'USER_PREFERENCE',
      scopeKind: 'WORKSPACE', idempotencyKey: 'remember_1', password: 'must-not-forward',
    });
    expect((await request('/api/learning/remember', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })).status).toBe(401);
    expect(learning.remember).not.toHaveBeenCalled();
    const headers = { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN };
    expect((await request('/api/learning/remember', { method: 'POST', headers, body })).status).toBe(201);
    expect(learning.remember).toHaveBeenCalledWith(expect.not.objectContaining({ password: expect.anything() }));
    expect((await request('/api/learning/learning_1/delete', {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1, reason: 'privacy request' }),
    })).status).toBe(200);
    expect(learning.delete).toHaveBeenCalledWith({ entryId: 'learning_1', expectedVersion: 1, reason: 'privacy request' });
  });
});
