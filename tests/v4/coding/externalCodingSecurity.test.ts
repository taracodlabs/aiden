/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import { compileExternalCodingProtectedPaths } from '../../../core/v4/coding/securityPolicy';

describe('external coding security policy', () => {
  it('always protects repository metadata, secrets, Aiden state, and the release-protected note', () => {
    const protectedPaths = compileExternalCodingProtectedPaths(['src/protected.ts', '.env']);
    expect(protectedPaths).toEqual(expect.arrayContaining([
      '.git', '.git/**', '.aiden', '.aiden/**', '.env', '.env.*', '**/.env', '**/.env.*',
      '.npmrc', '**/.npmrc', 'release-notes-v4.16.0.md', 'src/protected.ts',
    ]));
    expect(protectedPaths).toEqual([...new Set(protectedPaths)].sort());
  });

  it('rejects absolute, parent-traversal, empty, and control-character policies', () => {
    for (const value of ['', '../outside', 'C:\\outside', '/outside', 'bad\0path']) {
      expect(() => compileExternalCodingProtectedPaths([value])).toThrow();
    }
  });
});
