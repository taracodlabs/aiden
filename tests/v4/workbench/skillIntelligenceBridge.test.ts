/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startWorkbenchBridge, type WorkbenchBridge } from '../../../core/v4/workbench/bridgeServer';
import type { WorkbenchSkillIntelligencePort } from '../../../core/v4/workbench/skillIntelligencePort';

const TOKEN = 'skill-intelligence-token';
const reader = { listEventsScoped: () => [] };
let bridge: WorkbenchBridge | null = null;

afterEach(async () => { await bridge?.close(); bridge = null; });

const snapshot = () => ({
  enabled: true,
  doctor: { enabled: true, schemaReady: true, traces: 3, patterns: 1, candidates: 1, drafts: 0, active: 0, degraded: 0, drifted: 0 },
  candidates: [], drafts: [], evaluations: [], approvals: [], active: [],
});

function port(): WorkbenchSkillIntelligencePort {
  return {
    snapshot,
    reviewCandidate: vi.fn(() => ({ candidate: {} as never, pattern: {} as never, traces: [] })),
    dismissCandidate: vi.fn(snapshot),
    createDraft: vi.fn(snapshot), updateDraft: vi.fn(snapshot), evaluate: vi.fn(snapshot),
    requestApproval: vi.fn(snapshot), decideApproval: vi.fn(snapshot), activate: vi.fn(snapshot),
    disable: vi.fn(snapshot), rollback: vi.fn(snapshot),
  };
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe('Workbench Skill Intelligence bridge', () => {
  it('exposes bounded read-only review without transcript or credential content', async () => {
    const skills = port();
    bridge = await startWorkbenchBridge({ reader, skillIntelligence: skills, token: TOKEN, port: 0 });
    const result = await request('/api/skill-intelligence');
    expect(result).toMatchObject({ status: 200, body: { enabled: true, doctor: { patterns: 1 } } });
    expect(JSON.stringify(result.body)).not.toMatch(/prompt|credential|transcript|apiKey/i);
  });

  it('token-gates exact digest decisions and passes only typed management fields', async () => {
    const skills = port();
    bridge = await startWorkbenchBridge({ reader, skillIntelligence: skills, token: TOKEN, port: 0 });
    const denied = await request('/api/skill-intelligence/approvals/approval_1/decision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', draftDigest: 'draft_digest', evaluationDigest: 'evaluation_digest' }),
    });
    expect(denied.status).toBe(401);
    expect(skills.decideApproval).not.toHaveBeenCalled();
    const accepted = await request('/api/skill-intelligence/approvals/approval_1/decision', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({ decision: 'approved', draftDigest: 'draft_digest', evaluationDigest: 'evaluation_digest' }),
    });
    expect(accepted.status).toBe(200);
    expect(skills.decideApproval).toHaveBeenCalledWith({
      approvalId: 'approval_1',
      decision: 'approved',
      draftDigest: 'draft_digest',
      evaluationDigest: 'evaluation_digest',
    });
  });

  it('token-gates candidate dismissal and preserves the exact state version', async () => {
    const skills = port();
    bridge = await startWorkbenchBridge({ reader, skillIntelligence: skills, token: TOKEN, port: 0 });
    const denied = await request('/api/skill-intelligence/candidates/candidate_1/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 4 }),
    });
    expect(denied.status).toBe(401);
    expect(skills.dismissCandidate).not.toHaveBeenCalled();

    const accepted = await request('/api/skill-intelligence/candidates/candidate_1/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': TOKEN },
      body: JSON.stringify({ expectedVersion: 4 }),
    });
    expect(accepted.status).toBe(200);
    expect(skills.dismissCandidate).toHaveBeenCalledWith({ candidateId: 'candidate_1', expectedVersion: 4 });
  });
});
