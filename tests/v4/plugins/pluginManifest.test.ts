import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  validateManifest,
  readManifest,
  MANIFEST_VERSION,
} from '../../../core/v4/plugins/pluginManifest';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pman-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('validateManifest', () => {
  it('1. accepts a minimal well-formed manifest', () => {
    const result = validateManifest({
      manifestVersion: MANIFEST_VERSION,
      name: 'sample',
      version: '1.0.0',
      author: 'Aiden',
      description: 'sample plugin',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('sample');
      expect(result.manifest.kind).toBe('standalone');
      expect(result.manifest.tools).toEqual([]);
    }
  });

  it('2. rejects unknown manifest version', () => {
    const result = validateManifest({
      manifestVersion: 99,
      name: 'x',
      version: '1.0.0',
      author: 'a',
      description: 'd',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('unsupported manifestVersion'))).toBe(true);
    }
  });

  it('3. reports every offending field in one pass (name + permissions)', () => {
    const result = validateManifest({
      manifestVersion: MANIFEST_VERSION,
      name: 'has spaces',
      version: '1.0.0',
      author: 'a',
      description: 'd',
      permissions: ['network', 'disk'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
      expect(result.errors.some((e) => e.includes('disk'))).toBe(true);
    }
  });

  it('4. rejects duplicate permissions', () => {
    const result = validateManifest({
      manifestVersion: MANIFEST_VERSION,
      name: 'sample',
      version: '1.0.0',
      author: 'a',
      description: 'd',
      permissions: ['network', 'network'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('duplicate'))).toBe(true);
    }
  });

  it('5. rejects unknown kind', () => {
    const result = validateManifest({
      manifestVersion: MANIFEST_VERSION,
      name: 'sample',
      version: '1.0.0',
      author: 'a',
      description: 'd',
      kind: 'demonic',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('kind'))).toBe(true);
    }
  });
});

describe('readManifest', () => {
  it('6. reads a valid plugin.json from disk', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'plugin.json'),
      JSON.stringify({
        manifestVersion: MANIFEST_VERSION,
        name: 'on-disk',
        version: '0.1.0',
        author: 'Aiden',
        description: 'd',
        tools: ['noop'],
        permissions: ['network'],
      }),
    );
    const result = await readManifest(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.path).toBe(tmpDir);
      expect(result.manifest.tools).toEqual(['noop']);
    }
  });

  it('7. returns ENOENT-style error when plugin.json missing', async () => {
    const result = await readManifest(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('no plugin.json');
    }
  });

  it('8. returns parse error on invalid JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'plugin.json'), '{not json');
    const result = await readManifest(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/invalid JSON/i);
    }
  });
});
