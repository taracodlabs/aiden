/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

describe('packaged Workbench dashboard contract', () => {
  it('ships the built dashboard in the runtime package', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    expect(manifest.files).toContain('dashboard-next/out/');
  });

  it('resolves the packaged dashboard independently of the current workspace', () => {
    const source = fs.readFileSync(path.join(root, 'cli/v4/aidenCLI.ts'), 'utf8');
    const candidates = source.match(/const staticCandidates = \[[\s\S]*?\]\.filter/)?.[0] ?? '';
    expect(candidates).toContain("nodePath.resolve(__dirname, '../../../dashboard-next/out')");
    expect(candidates.indexOf('__dirname')).toBeLessThan(candidates.indexOf('process.cwd()'));
  });
});
