/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';

function get(port: number, pathname: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }));
    });
    request.on('error', reject);
  });
}

let bridge: WorkbenchBridge | null = null;
afterEach(async () => { await bridge?.close(); bridge = null; });

describe('Live Execution bridge', () => {
  it('SEC1 requires and forwards the exact Job, Attempt, generation, and run identity', async () => {
    const read = vi.fn(() => ({ schemaVersion: 1, surfaces: [] }));
    bridge = await startWorkbenchBridge({
      reader: { listEventsScoped: () => [] }, liveExecution: { get: read }, port: 0,
    });
    const response = await get(bridge.port, '/api/jobs/job_exact/live-execution?attemptId=attempt_exact&generation=3&runId=41');
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith({ jobId: 'job_exact', attemptId: 'attempt_exact', generation: 3, runId: 41 });
  });

  it('fails closed when any exact identity component is missing', async () => {
    const read = vi.fn();
    bridge = await startWorkbenchBridge({
      reader: { listEventsScoped: () => [] }, liveExecution: { get: read }, port: 0,
    });
    expect((await get(bridge.port, '/api/jobs/job_exact/live-execution?attemptId=attempt_exact&runId=41')).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns not found rather than leaking another Job or stale generation', async () => {
    bridge = await startWorkbenchBridge({
      reader: { listEventsScoped: () => [] }, liveExecution: { get: () => null }, port: 0,
    });
    const response = await get(bridge.port, '/api/jobs/job_wrong/live-execution?attemptId=attempt_old&generation=2&runId=41');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'exact live execution projection not found' });
  });
});
