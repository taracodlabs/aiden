/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startWorkbenchBridge,
  type WorkbenchBridge,
  type WorkbenchCapabilityManagementPort,
} from '../../../core/v4/workbench/bridgeServer';

const TOKEN = 'workbench-capability-token';
const reader = { listEventsScoped: () => [] };
let bridge: WorkbenchBridge | null = null;

afterEach(async () => {
  await bridge?.close();
  bridge = null;
});
async function request(target: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${target}`, init);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function port(): WorkbenchCapabilityManagementPort {
  const snapshot = () => ({
    executionEnabled: true,
    sandbox: { available: true, mechanism: 'docker' as const, image: 'node:test' },
    items: [],
  });
  return {
    snapshot,
    install: vi.fn(async () => ({ capabilityId: 'dev.taracod.sample' })),
    activate: vi.fn(), rollback: vi.fn(), disable: vi.fn(), test: vi.fn(), uninstall: vi.fn(),
  };
}

describe('Workbench capability management bridge', () => {
  it('projects bounded capability state without host paths or process internals', async () => {
    const management = port();
    bridge = await startWorkbenchBridge({
      reader,
      capabilities: () => ({ modelSwitch: { available: false }, skills: [], plugins: [], extensions: management.snapshot() }),
      capabilityManagement: management,
      token: TOKEN,
      port: 0,
    });
    const result = await request('/api/workbench/capabilities');
    expect(result).toMatchObject({ status: 200, body: { extensions: { executionEnabled: true, items: [] } } });
    expect(JSON.stringify(result.body)).not.toMatch(/installPath|environment|fenceToken|secret/i);
  });

  it('token-gates install and requires explicit permission acceptance for activation', async () => {
    const management = port();
    bridge = await startWorkbenchBridge({ reader, capabilityManagement: management, token: TOKEN, port: 0 });
    const denied = await request('/api/capabilities/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'C:/sample' }),
    });
    expect(denied.status).toBe(401);
    expect(management.install).not.toHaveBeenCalled();
    const installed = await request('/api/capabilities/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({ path: 'C:/sample' }),
    });
    expect(installed).toMatchObject({ status: 201, body: { capabilityId: 'dev.taracod.sample' } });
    expect(management.install).toHaveBeenCalledWith('C:/sample');

    await request('/api/capabilities/dev.taracod.sample/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({ version: '1.0.0', acceptPermissions: true }),
    });
    expect(management.activate).toHaveBeenCalledWith({
      capabilityId: 'dev.taracod.sample', version: '1.0.0', acceptPermissions: true,
    });
  });
});
