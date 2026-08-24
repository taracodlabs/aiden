/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

describe('v4.21.0 release identity', () => {
  it('keeps runtime, lockfile, README, and release notes on one version', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'RELEASE-NOTES-v4.21.0.md'), 'utf8');

    expect(manifest).toMatchObject({ name: 'aiden-runtime', version: '4.21.0' });
    expect(lock.version).toBe('4.21.0');
    expect(lock.packages['']?.version).toBe('4.21.0');
    expect(lock.packages['packages/aiden-os']?.version).toBe('4.18.0');
    expect(readme).toContain('**Stable:** `v4.21.0` through npm `latest`');
    expect(readme).toContain('npm latest → 4.21.0');
    expect(notes).toContain('# Aiden v4.21.0');
    expect(notes).toContain('npm install -g aiden-runtime@4.21.0');
  });
});
