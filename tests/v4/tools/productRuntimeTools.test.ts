import { describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../../../core/v4/toolRegistry';
import { aidenStatusTool, createAidenRuntimeStatus } from '../../../tools/v4/system/aidenStatus';
import { automationManageTool, automationStatusTool } from '../../../tools/v4/automation/automationTools';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), paths: {} as ToolContext['paths'], ...overrides };
}

describe('canonical runtime self-awareness tools', () => {
  it('queries the injected durable projection instead of inspecting files', async () => {
    const runtimeStatus = vi.fn(async () => ({ topic: 'learning', entries: [{ content: 'Prefer pnpm.' }] }));
    const result = await aidenStatusTool.execute(
      { topic: 'learning', query: 'preferences' },
      context({ runtimeStatus }),
    );
    expect(runtimeStatus).toHaveBeenCalledWith('learning', 'preferences');
    expect(result).toEqual({ topic: 'learning', entries: [{ content: 'Prefer pnpm.' }] });
  });

  it('fails honestly when the canonical projection is unavailable', async () => {
    await expect(aidenStatusTool.execute({ topic: 'presence' }, context())).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/unavailable/i),
    });
  });

  it('projects bounded Learning, Presence, Skill, and readiness truth from existing authorities', async () => {
    const runtimeStatus = createAidenRuntimeStatus({
      readiness: async () => ({
        overall: 'ready', checkedAt: 1, issues: [],
        items: [{
          id: 'coding-provider', category: 'coding', state: 'setup_available', title: 'Coding provider',
          detail: 'Coding model is not selected.', configured: false, available: true, healthy: false,
          supported: true, authenticated: true, runtimeAvailable: true, permissionAvailable: true,
          validationAvailable: false, ready: false, reason: 'Coding model is not selected.',
          recommendedAction: 'Choose a supported coding model.', blocking: false, severity: 'info',
          availableActions: ['manage_coding'], checkedAt: 1,
        }],
      }),
      learning: {
        retrieve: vi.fn(() => ({ items: [{
          id: 'learn-1', scope: { kind: 'REPOSITORY', key: 'repo', ownerId: 'owner', workspaceId: 'workspace' },
          type: 'WORKSPACE_CONVENTION', confidence: 'TRUSTED', lifecycle: 'ACTIVE', content: 'Prefer pnpm.', eligible: true,
          subjectKey: 'package-manager', contentDigest: 'digest', sourceCount: 1, version: 1,
          expiresAt: null, createdAt: 1, updatedAt: 1, deletedAt: null, score: 1, reasons: [],
        }], context: 'private expanded context' })),
        list: vi.fn(() => []),
      } as any,
      learningScopes: [{ kind: 'REPOSITORY', key: 'repo', ownerId: 'owner', workspaceId: 'workspace' }],
      presence: {
        snapshot: vi.fn(() => ({
          enabled: true, quietHours: false, interruptions: [], reviewWhenReady: [], recentlyResolved: [],
          needsYou: [{
            id: 'presence-1', state: 'active', category: 'approval_required', title: 'Approval needed',
            summary: 'A write is waiting.', reason: 'Exact action requires approval.', recommendedAction: 'Review approval',
          }],
        })),
        proposals: vi.fn(() => [{ id: 'proposal-1', state: 'proposed', goal: 'Review the task' }]),
      } as any,
      skills: {
        snapshot: vi.fn(() => ({
          enabled: true, doctor: { enabled: true, candidates: 1, active: 1, degraded: 0, drifted: 0 },
          candidates: [{ id: 'candidate-1', proposedName: 'repo-review', purpose: 'Review a repository', state: 'candidate' }],
          drafts: [], evaluations: [], approvals: [],
          active: [{
            pointer: { skillId: 'repo-review', enabled: true, driftState: 'clean' },
            version: { id: 'version-1', version: 2 }, versions: [{ id: 'version-0' }, { id: 'version-1' }],
            health: { state: 'healthy' }, outcomes: [], rollbackTarget: { id: 'version-0', version: 1 },
          }],
        })),
      } as any,
    });

    await expect(runtimeStatus('readiness')).resolves.toMatchObject({
      items: [{ id: 'coding-provider', ready: false, configured: false, reason: 'Coding model is not selected.' }],
    });
    await expect(runtimeStatus('learning', 'preferences')).resolves.toMatchObject({
      entries: [{ id: 'learn-1', content: 'Prefer pnpm.', scope: 'REPOSITORY', confidence: 'TRUSTED' }],
    });
    await expect(runtimeStatus('presence')).resolves.toMatchObject({
      needsYou: [{ id: 'presence-1', reason: 'Exact action requires approval.' }],
      proposals: [{ id: 'proposal-1', state: 'proposed' }],
    });
    await expect(runtimeStatus('skills')).resolves.toMatchObject({
      candidates: [{ id: 'candidate-1', name: 'repo-review' }],
      active: [{ skillId: 'repo-review', version: 2, rollbackAvailable: true }],
    });
  });
});

describe('Reliable Automations model tools', () => {
  it('uses the v4.22 read port for capability, list, and schedule preview', async () => {
    const snapshot = vi.fn(() => ({
      capability: { available: true }, scheduler: { ready: true, dueBindings: 0 },
      automations: [], history: [], attention: [],
    }));
    const preview = vi.fn(() => ['2026-08-24T03:30:00.000Z']);
    const automation = { snapshot, preview } as unknown as NonNullable<ToolContext['automation']>;

    await expect(automationStatusTool.execute({ action: 'capabilities' }, context({ automation })))
      .resolves.toMatchObject({ capability: { available: true }, scheduler: { ready: true } });
    await expect(automationStatusTool.execute({ action: 'list' }, context({ automation })))
      .resolves.toMatchObject({ automations: [] });
    await expect(automationStatusTool.execute({
      action: 'preview', expression: '0 9 * * *', timezone: 'Asia/Kolkata',
    }, context({ automation }))).resolves.toMatchObject({ instants: ['2026-08-24T03:30:00.000Z'] });
    expect(preview).toHaveBeenCalledWith({ expression: '0 9 * * *', timezone: 'Asia/Kolkata', count: 5 });
  });

  it('creates through the existing automation port with bounded safe defaults', async () => {
    const create = vi.fn((input) => ({ automationId: 'automation-1', ...input }));
    const automation = { create } as unknown as NonNullable<ToolContext['automation']>;
    const result = await automationManageTool.execute({
      action: 'create', name: 'Morning brief', prompt: 'Summarize the repository.',
      expression: '0 9 * * *', timezone: 'Asia/Kolkata',
    }, context({ automation }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Morning brief', createdBy: 'local-user',
      action: { kind: 'prompt', prompt: 'Summarize the repository.' },
      trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'Asia/Kolkata' },
      policies: {
        misfire: { kind: 'run_once', maxAgeMs: 3_600_000 }, overlap: 'skip', retry: { maxAttempts: 1 },
      },
      capabilities: [], credentialRefs: [], approval: { mode: 'policy' },
    }));
    expect(result).toMatchObject({ automationId: 'automation-1' });
  });
});
