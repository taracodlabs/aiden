/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  reconcileFilesystemEffect,
  type EffectReconciliationInput,
} from '../../../core/v4/effectReconciliation';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiden-effect-reconcile-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<EffectReconciliationInput> = {}): EffectReconciliationInput {
  return {
    effectId: 'effect_1',
    kind: 'filesystem.write',
    target: null,
    retrySafety: 'reconcile_before_retry',
    idempotencyKey: 'idem_1',
    reconciliationData: null,
    ...overrides,
  };
}

describe('Effect reconciliation', () => {
  it('proves an expected file write occurred from exact content evidence', async () => {
    const dir = tempDir();
    const path = join(dir, 'result.txt');
    const content = 'durable result';
    writeFileSync(path, content);

    const result = await reconcileFilesystemEffect(input({
      target: path,
      reconciliationData: {
        expectedContentSha256: createHash('sha256').update(content).digest('hex'),
        expectedSize: Buffer.byteLength(content),
      },
    }));

    expect(result).toMatchObject({
      outcome: 'occurred', confidence: 'high', retryRecommendation: 'do_not_retry',
      humanResolutionRequired: false,
    });
    expect(result.evidence).toMatchObject({ exists: true, size: Buffer.byteLength(content) });
  });

  it('proves a new-file write did not occur only when prior absence is known', async () => {
    const dir = tempDir();
    const path = join(dir, 'missing.txt');

    const result = await reconcileFilesystemEffect(input({
      target: path,
      reconciliationData: { before: { exists: false }, expectedContentSha256: 'abc' },
    }));

    expect(result).toMatchObject({
      outcome: 'did_not_occur', confidence: 'high', retryRecommendation: 'retry_same_identity',
      humanResolutionRequired: false,
    });
  });

  it('keeps mismatched or insufficient file state unknown', async () => {
    const dir = tempDir();
    const path = join(dir, 'existing.txt');
    writeFileSync(path, 'different');

    const result = await reconcileFilesystemEffect(input({
      target: path,
      reconciliationData: { before: { exists: true, contentSha256: 'old' }, expectedContentSha256: 'expected' },
    }));

    expect(result).toMatchObject({
      outcome: 'unknown', retryRecommendation: 'human_review', humanResolutionRequired: true,
    });
    expect(JSON.stringify(result)).not.toContain('different');
  });

  it('never infers arbitrary process effects from an exit status', async () => {
    const result = await reconcileFilesystemEffect(input({
      kind: 'process.command', target: 'local-runtime', reconciliationData: { exitCode: 0 },
    }));
    expect(result).toMatchObject({
      outcome: 'unknown', confidence: 'low', retryRecommendation: 'human_review',
      humanResolutionRequired: true,
    });
  });
});
