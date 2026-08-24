import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkbenchAutomationPort } from '../../../core/v4/workbench/automationPort';
import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';

const TOKEN = 'automation-token';
const reader = { listEventsScoped: () => [] };
let bridge: WorkbenchBridge | null = null;

afterEach(async () => { await bridge?.close(); bridge = null; });

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function stub(): WorkbenchAutomationPort {
  return {
    snapshot: vi.fn(() => ({
      capability: { available: true }, scheduler: { ready: true, dueBindings: 0 },
      automations: [], attention: [],
    })),
    create: vi.fn((input) => ({
      automationId: 'automation-1', name: input.name, enabled: true,
      revisionId: 'revision-1', revisionNumber: 1, action: input.action, trigger: input.trigger,
      policies: input.policies, capabilities: input.capabilities,
      nextFireAt: '2026-08-22T03:30:00.000Z', lastOccurrence: null,
    })),
    revise: vi.fn((automationId, input) => ({
      automationId, name: 'Daily', enabled: true,
      revisionId: 'revision-2', revisionNumber: 2, action: input.action, trigger: input.trigger,
      policies: input.policies, capabilities: input.capabilities,
      nextFireAt: '2026-08-22T04:30:00.000Z', lastOccurrence: null,
    })),
    setEnabled: vi.fn(), runNow: vi.fn(() => ({ triggerEventId: 42 })),
    replay: vi.fn(() => ({ triggerEventId: 43 })),
    preview: vi.fn(() => ['2026-08-22T03:30:00.000Z']),
  };
}

describe('Workbench Automations bridge', () => {
  it('token-gates reads and all writes', async () => {
    const automations = stub();
    bridge = await startWorkbenchBridge({ reader, automations, token: TOKEN, port: 0 });
    expect((await request('/api/automations')).status).toBe(401);
    expect((await request('/api/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect(automations.create).not.toHaveBeenCalled();
  });

  it('creates through the typed port and never accepts raw credential fields as required input', async () => {
    const automations = stub();
    bridge = await startWorkbenchBridge({ reader, automations, token: TOKEN, port: 0 });
    const response = await request('/api/automations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({
        name: 'Daily', action: { kind: 'prompt', prompt: 'Summarize' },
        trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
        policies: { misfire: { kind: 'run_once' }, overlap: 'queue', retry: { maxAttempts: 2 } },
        capabilities: [], credentialRefs: [],
        budget: { runtimeMs: 300000, modelCalls: 8, effects: 0 },
        approval: { mode: 'always' },
      }),
    });
    expect(response.status).toBe(201);
    expect(automations.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Daily', createdBy: 'workbench', credentialRefs: [],
      budget: { runtimeMs: 300000, modelCalls: 8, effects: 0 },
      approval: { mode: 'always' },
    }));
    expect(JSON.stringify(response.body)).not.toMatch(/password|token|secret/i);
  });

  it('supports preview, Run Now, pause and replay through exact identities', async () => {
    const automations = stub();
    bridge = await startWorkbenchBridge({ reader, automations, token: TOKEN, port: 0 });
    const headers = { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN };
    expect((await request('/api/automations/preview', {
      method: 'POST', headers, body: JSON.stringify({ expression: '0 9 * * *', timezone: 'Asia/Kolkata' }),
    })).status).toBe(200);
    expect((await request('/api/automations/automation-1/run', { method: 'POST', headers })).body).toEqual({ triggerEventId: 42 });
    await request('/api/automations/automation-1/disable', { method: 'POST', headers });
    await request('/api/automation-occurrences/occurrence-1/replay', { method: 'POST', headers });
    expect(automations.setEnabled).toHaveBeenCalledWith('automation-1', false);
    expect(automations.replay).toHaveBeenCalledWith('occurrence-1');
  });

  it('revises an automation through the token-gated immutable revision authority', async () => {
    const automations = stub();
    bridge = await startWorkbenchBridge({ reader, automations, token: TOKEN, port: 0 });
    const response = await request('/api/automations/automation-1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({
        action: { kind: 'prompt', prompt: 'Updated brief' },
        trigger: { kind: 'schedule', expression: '0 10 * * *', timezone: 'Europe/Tallinn' },
        policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 2 } },
        capabilities: ['repository.read'], credentialRefs: [],
      }),
    });
    expect(response.status).toBe(200);
    expect(automations.revise).toHaveBeenCalledWith('automation-1', expect.objectContaining({
      createdBy: 'workbench', action: { kind: 'prompt', prompt: 'Updated brief' },
    }));
  });
});
