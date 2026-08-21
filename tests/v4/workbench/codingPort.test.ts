/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it, vi } from 'vitest';

import type { JobEngine } from '../../../core/v4/daemon/jobEngine';
import { createWorkbenchCodingPort, projectExternalCodingHealth } from '../../../core/v4/workbench/codingPort';

describe('Workbench coding review projection', () => {
  it('routes normal model setup through the backend coding authority', async () => {
    const configure = vi.fn(async ({ model }: { model: string }) => ({
      ready: true, state: 'ready' as const, provider: 'Codex CLI', executable: 'codex',
      executableSource: 'known_installation' as const, version: '0.148.0', model,
      modelValidation: 'ready' as const, authentication: 'ready', authenticationMode: 'chatgpt_account' as const,
      isolation: 'available' as const, network: 'disabled_by_default' as const, reason: 'Ready.',
    }));
    const port = createWorkbenchCodingPort({
      engine: {} as JobEngine, actions: {} as never, instanceId: 'workbench-1', configure,
    });

    await expect(port.configure({ model: '  gpt-exact  ' })).resolves.toMatchObject({
      ready: true, model: 'gpt-exact', modelValidation: 'ready',
    });
    expect(configure).toHaveBeenCalledWith({ model: 'gpt-exact' });
  });

  it('reports Ready only after the exact configured model succeeds', () => {
    const common = {
      provider: 'Codex CLI',
      detection: { available: true, executable: 'codex', reason: null },
      version: { raw: 'codex-cli 0.147.0', normalized: '0.147.0', supported: true },
      health: { healthy: true, authentication: 'ready' as const, detail: 'Authentication is ready.' },
      model: 'gpt-exact',
      isolation: 'available' as const,
    };
    expect(projectExternalCodingHealth({
      ...common,
      modelHealth: { ready: false, modelId: 'gpt-exact', state: 'unsupported_model', detail: 'Exact model unavailable.', checkedAt: 1 },
    })).toMatchObject({ ready: false, state: 'unsupported_model', modelValidation: 'unsupported_model', reason: 'Exact model unavailable.' });
    expect(projectExternalCodingHealth({
      ...common,
      modelHealth: { ready: true, modelId: 'gpt-exact', state: 'ready', detail: 'Ready.', checkedAt: 2 },
    })).toMatchObject({ ready: true, state: 'ready', modelValidation: 'ready' });
  });

  it('reports exact authentication-mode incompatibility and unavailable isolation without false readiness', () => {
    const common = {
      provider: 'Codex CLI',
      detection: { available: true, executable: 'codex', reason: null },
      version: { raw: 'codex-cli 0.147.0', normalized: '0.147.0', supported: true },
      health: {
        healthy: true,
        authentication: 'ready' as const,
        authenticationMode: 'chatgpt_account' as const,
        detail: 'Authentication is ready.',
      },
      model: 'gpt-exact',
    };
    expect(projectExternalCodingHealth({
      ...common,
      modelHealth: {
        ready: false,
        modelId: 'gpt-exact',
        state: 'model_unavailable_for_auth_mode',
        detail: 'The exact configured model is not available with the active authentication mode.',
        checkedAt: 1,
      },
      isolation: 'available',
    })).toMatchObject({
      ready: false,
      state: 'model_unavailable_for_auth_mode',
      authenticationMode: 'chatgpt_account',
    });
    expect(projectExternalCodingHealth({
      ...common,
      modelHealth: { ready: true, modelId: 'gpt-exact', state: 'ready', detail: 'Ready.', checkedAt: 2 },
      isolation: 'unavailable',
    })).toMatchObject({
      ready: false,
      state: 'sandbox_unavailable',
      modelValidation: 'ready',
      reason: 'Independent coding validation is unavailable.',
    });
  });

  it('returns a bounded semantic before/after review without workspace or raw-process fields', async () => {
    const readFile = vi.fn(async (snapshotId: string, relativePath: string, options: { limit: number }) => {
      expect(options.limit).toBe(128 * 1024);
      if (relativePath === 'created.ts' && snapshotId === 'snapshot_target') throw new Error('absent');
      if (relativePath === 'deleted.ts' && snapshotId === 'snapshot_candidate') throw new Error('absent');
      if (relativePath === 'binary.dat') {
        return { encoding: 'base64', content: 'SECRET_RAW_BYTES', fullContentHash: 'binary-hash', truncated: false };
      }
      return {
        encoding: 'utf8',
        content: `${snapshotId}:${relativePath}`,
        fullContentHash: `${snapshotId}:${relativePath}:hash`,
        truncated: relativePath === 'truncated.ts',
      };
    });
    const engine = {
      codingPromotions: {
        get: vi.fn(() => ({
          promotionId: 'coding_promotion_1', codingSessionId: 'coding_session_1', state: 'prepared',
          targetSnapshotId: 'snapshot_target', candidateSnapshotId: 'snapshot_candidate',
          changedPaths: ['created.ts', 'updated.ts', 'deleted.ts', 'binary.dat', 'truncated.ts'],
        })),
      },
      repository: { readFile },
    } as unknown as JobEngine;
    const port = createWorkbenchCodingPort({ engine, actions: {} as never, instanceId: 'workbench-1' });

    const review = await port.review('coding_promotion_1');

    expect(review.files.map((file) => [file.path, file.operation])).toEqual([
      ['created.ts', 'create'], ['updated.ts', 'update'], ['deleted.ts', 'delete'],
      ['binary.dat', 'update'], ['truncated.ts', 'update'],
    ]);
    expect(review.files.find((file) => file.path === 'binary.dat')).toMatchObject({
      before: '[binary content omitted]', after: '[binary content omitted]', truncated: true,
    });
    expect(JSON.stringify(review)).not.toContain('SECRET_RAW_BYTES');
    expect(JSON.stringify(review)).not.toContain('workspacePath');
    expect(JSON.stringify(review)).not.toContain('rawOutput');
    expect(review.truncated).toBe(true);
  });

  it('limits a review to the first one hundred exact changed paths', async () => {
    const changedPaths = Array.from({ length: 105 }, (_, index) => `src/file-${index}.ts`);
    const readFile = vi.fn(async (_snapshotId: string, relativePath: string) => ({
      encoding: 'utf8', content: relativePath, fullContentHash: `${relativePath}:hash`, truncated: false,
    }));
    const engine = {
      codingPromotions: { get: () => ({
        promotionId: 'coding_promotion_many', codingSessionId: 'coding_session_many', state: 'prepared',
        targetSnapshotId: 'snapshot_target', candidateSnapshotId: 'snapshot_candidate', changedPaths,
      }) },
      repository: { readFile },
    } as unknown as JobEngine;
    const port = createWorkbenchCodingPort({ engine, actions: {} as never, instanceId: 'workbench-1' });

    const review = await port.review('coding_promotion_many');

    expect(review.files).toHaveLength(100);
    expect(readFile).toHaveBeenCalledTimes(200);
    expect(review.truncated).toBe(true);
  });

  it('routes an explicit unknown-session discard through exact durable coding authority', async () => {
    const discardUnknown = vi.fn(async (input: Record<string, unknown>) => ({
      codingSessionId: input.codingSessionId,
      workspaceLeaseId: 'coding_workspace_exact',
      state: 'failed',
      reconciliationState: 'reconciled',
    }));
    const engine = {
      coding: { discardUnknown },
      codingWorkspaces: { get: () => ({ state: 'released' }) },
    } as unknown as JobEngine;
    const port = createWorkbenchCodingPort({
      engine,
      actions: {} as never,
      instanceId: 'workbench-1',
      sessionHomeParent: 'C:\\managed\\coding\\homes',
    });

    await expect(port.discardUnknown('coding_session_exact')).resolves.toEqual({
      codingSessionId: 'coding_session_exact',
      state: 'failed',
      reconciliationState: 'reconciled',
      workspaceState: 'released',
    });
    expect(discardUnknown).toHaveBeenCalledWith(expect.objectContaining({
      codingSessionId: 'coding_session_exact',
      sessionHomeParent: 'C:\\managed\\coding\\homes',
      decidedBy: 'workbench-user',
      decisionChannel: 'workbench-coding-reconciliation',
    }));
  });
});
