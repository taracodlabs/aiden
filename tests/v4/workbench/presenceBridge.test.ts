import { afterEach, describe, expect, it, vi } from 'vitest';

import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
import type { WorkbenchPresencePort } from '../../../core/v4/workbench/presencePort';

const TOKEN = 'presence-token';
const reader = { listEventsScoped: () => [] };
let bridge: WorkbenchBridge | null = null;

afterEach(async () => { await bridge?.close(); bridge = null; });

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function port(): WorkbenchPresencePort {
  return {
    snapshot: vi.fn(() => ({
      enabled: true, quietHours: false, interruptions: [],
      needsYou: [{ id: 'presence_1', title: 'Approval needed', reason: 'A protected action is waiting.', state: 'active' }],
      reviewWhenReady: [], recentlyResolved: [],
    }) as never),
    briefing: vi.fn(() => ({
      briefingId: 'boot_1', duplicate: false, items: [],
      groups: { changed: [], resolved: [], blocked: [], ready: [], next: [] },
    })),
    preferences: vi.fn(() => ({
      workspaceId: null, ownerId: null, timezone: 'UTC', quietStart: null, quietEnd: null,
      maxInterruptions: 3, interruptionWindowMs: 3_600_000, cooldownMs: 300_000,
      notificationConsent: false, allowedDeliveryClasses: [], defaultSnoozeMs: 3_600_000, version: 0,
    })),
    updatePreferences: vi.fn((input) => ({
      workspaceId: null, ownerId: null, timezone: input.timezone ?? 'UTC', quietStart: input.quietStart ?? null,
      quietEnd: input.quietEnd ?? null, maxInterruptions: input.maxInterruptions ?? 3,
      interruptionWindowMs: input.interruptionWindowMs ?? 3_600_000, cooldownMs: input.cooldownMs ?? 300_000,
      notificationConsent: input.notificationConsent ?? false, allowedDeliveryClasses: input.allowedDeliveryClasses ?? [],
      defaultSnoozeMs: input.defaultSnoozeMs ?? 3_600_000, version: 1,
    })),
    explain: vi.fn(() => ({ itemId: 'presence_1', reason: 'A protected action is waiting.', history: [] }) as never),
    snooze: vi.fn(() => ({ id: 'presence_1', state: 'snoozed', version: 2 }) as never),
    dismiss: vi.fn(() => ({ id: 'presence_1', state: 'dismissed', version: 2 }) as never),
    feedback: vi.fn(() => ({ accepted: true })),
    propose: vi.fn(() => ({ id: 'proposal_1', state: 'proposed', version: 1 }) as never),
    proposals: vi.fn(() => ([{ id: 'proposal_1', itemId: 'presence_1', state: 'proposed', version: 1 }] as never)),
    acceptProposal: vi.fn(() => ({ id: 'proposal_1', state: 'accepted', jobId: 'job_1', version: 2 }) as never),
  };
}

describe('Workbench Presence bridge', () => {
  it('projects durable attention while isolating projection failure from Workbench health', async () => {
    const presence = port();
    bridge = await startWorkbenchBridge({ reader, presence, token: TOKEN, port: 0 });
    expect((await request('/api/presence', { headers: { 'x-workbench-token': TOKEN } }))).toMatchObject({
      status: 200,
      body: { enabled: true, needsYou: [expect.objectContaining({ id: 'presence_1' })] },
    });
    expect((await request('/api/presence/proposals', { headers: { 'x-workbench-token': TOKEN } }))).toMatchObject({
      status: 200,
      body: [expect.objectContaining({ id: 'proposal_1', itemId: 'presence_1', state: 'proposed' })],
    });

    (presence.snapshot as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('projection failed'); });
    expect((await request('/api/presence', { headers: { 'x-workbench-token': TOKEN } })).status).toBe(503);
    expect((await request('/api/health')).status).toBe(200);
  });

  it('token-gates every Presence mutation and accepts a proposal only through the typed port', async () => {
    const presence = port();
    bridge = await startWorkbenchBridge({ reader, presence, token: TOKEN, port: 0 });
    expect((await request('/api/presence/presence_1/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }),
    })).status).toBe(401);
    expect(presence.dismiss).not.toHaveBeenCalled();

    const headers = { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN };
    expect((await request('/api/presence/presence_1/snooze', {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1, until: 99 }),
    })).status).toBe(200);
    expect((await request('/api/presence/proposals/proposal_1/accept', {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1, sessionId: 'session_1' }),
    })).status).toBe(202);
    expect(presence.acceptProposal).toHaveBeenCalledWith({ proposalId: 'proposal_1', expectedVersion: 1, sessionId: 'session_1' });
  });

  it('token-gates scoped attention preferences and never stores delivery credentials', async () => {
    const presence = port();
    bridge = await startWorkbenchBridge({ reader, presence, token: TOKEN, port: 0 });
    expect((await request('/api/presence/preferences')).status).toBe(401);
    const headers = { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN };
    expect((await request('/api/presence/preferences', { headers })).body).toMatchObject({ timezone: 'UTC' });
    const updated = await request('/api/presence/preferences', {
      method: 'POST', headers, body: JSON.stringify({
        timezone: 'Europe/Tallinn', quietStart: '22:00', quietEnd: '07:00', notificationConsent: true,
        allowedDeliveryClasses: ['desktop'], password: 'must-not-be-forwarded',
      }),
    });
    expect(updated).toMatchObject({ status: 200, body: { timezone: 'Europe/Tallinn', notificationConsent: true } });
    expect(presence.updatePreferences).toHaveBeenCalledWith(expect.not.objectContaining({ password: expect.anything() }));
  });
});
