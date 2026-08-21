/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { win32 } from 'node:path';

import {
  UNKNOWN_MUTATION_EFFECT_CONTRACT,
  describeToolEffect,
} from '../../../core/v4/effectContract';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4';

describe('durable tool effect contracts', () => {
  it('classifies every registered tool and gives every built-in mutation a trusted contract', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);

    for (const name of registry.list()) {
      const handler = registry.get(name)!;
      const descriptor = describeToolEffect(handler, {});
      if (handler.mutates === false) {
        expect(descriptor.classification, name).toBe('read_only');
      } else {
        expect(handler.effectContract, name).toBeDefined();
        expect(descriptor.classification, name).not.toBe('read_only');
        expect(descriptor.trusted, name).toBe(true);
      }
    }
  });

  it('uses a fail-closed unknown contract without retaining secret values', () => {
    const descriptor = describeToolEffect({
      schema: { name: 'plugin_write', description: 'writes externally', inputSchema: { type: 'object' } },
      category: 'write', riskTier: 'dangerous', mutates: true, toolset: 'plugin',
      async execute() { return { ok: true }; },
    }, {
      endpoint: 'https://example.test/resource',
      apiKey: 'must-not-survive',
      password: 'also-secret',
    });

    expect(descriptor).toMatchObject({
      ...UNKNOWN_MUTATION_EFFECT_CONTRACT,
      trusted: false,
      target: null,
      retrySafety: 'never_automatic',
      approvalRequirement: 'always',
    });
    expect(JSON.stringify(descriptor)).not.toContain('must-not-survive');
    expect(JSON.stringify(descriptor)).not.toContain('also-secret');
  });

  it('keeps external coding on exact per-occurrence approval in every mode', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(describeToolEffect(registry.get('external_coding')!, {
      goal: 'Fix the failing test.',
      allowed_scope: ['src/value.js'],
    })).toMatchObject({
      kind: 'worker.external_coding',
      approvalRequirement: 'always',
      trusted: true,
    });
  });

  it('removes URL credentials, query values, and fragments from durable targets', () => {
    const descriptor = describeToolEffect({
      mutates: true,
      effectContract: {
        classification: 'unsafe_mutation', kind: 'network.request', retrySafety: 'never_automatic',
        idempotencySupported: false, reconciliationSupported: false, verificationSupported: false,
        approvalRequirement: 'always', sensitiveFields: ['url'], redactionRules: ['strip_url_secrets'],
        target: (args) => String(args.url),
      },
    }, { url: 'https://user:password@example.test/path?token=private#secret' });

    expect(descriptor.target).toBe('https://example.test/path');
    expect(JSON.stringify(descriptor)).not.toMatch(/password|private|#secret/);
  });

  it('persists only a digest and resolved target for file-write reconciliation', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const content = 'private file body';
    const descriptor = describeToolEffect(
      registry.get('file_write')!,
      { path: 'result.txt', content },
      'C:\\workspace',
    );

    expect(descriptor.reconciliationData).toEqual({
      path: win32.join('C:\\workspace', 'result.txt'),
      expectedContentSha256: createHash('sha256').update(content).digest('hex'),
      expectedSize: Buffer.byteLength(content),
    });
    expect(JSON.stringify(descriptor.reconciliationData)).not.toContain(content);
  });

  it('derives patch verification from the exact pre-execution content', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiden-patch-effect-'));
    try {
      const target = path.join(root, 'source.ts');
      writeFileSync(target, 'const value = 1;\n');
      const registry = new ToolRegistry();
      registerAllTools(registry);
      const expected = 'const value = 2;\n';
      const descriptor = describeToolEffect(
        registry.get('file_patch')!,
        { path: 'source.ts', find: 'value = 1', replace: 'value = 2' },
        root,
      );
      expect(descriptor.reconciliationData).toEqual({
        path: target,
        expectedContentSha256: createHash('sha256').update(expected).digest('hex'),
        expectedSize: Buffer.byteLength(expected),
      });
      expect(JSON.stringify(descriptor.reconciliationData)).not.toContain('value = 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
