/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { describe, expect, it } from 'vitest';

import { projectFileEffect, projectRepositoryState } from '../../../cli/v4/effectPresentation';

describe('canonical file-effect presentation', () => {
  it.each([
    ['create', 'A', 'Created'],
    ['modify', 'M', 'Modified'],
    ['patch', 'M', 'Modified'],
    ['delete', 'D', 'Deleted'],
  ] as const)('projects %s from the durable operation', (operation, marker, label) => {
    expect(projectFileEffect({
      toolName: 'file_write', cwd: 'C:/repo',
      result: { success: true, operation, path: 'C:/repo/src/math.mjs', verified: true },
    })).toMatchObject({ marker, label, path: 'src/math.mjs', verified: true });
  });

  it.each([
    ['rename', 'R', 'Renamed'],
    ['move', 'R', 'Moved'],
  ] as const)('projects %s source and destination', (operation, marker, label) => {
    expect(projectFileEffect({
      toolName: 'file_move', cwd: 'C:/repo',
      result: {
        success: true, operation, path: 'C:/repo/src/old.ts',
        destination: 'C:/repo/src/new.ts', verified: true,
      },
    })).toMatchObject({ marker, label, path: 'src/old.ts', destination: 'src/new.ts' });
  });

  it('projects stale conflicts as blocked without claiming a change', () => {
    expect(projectFileEffect({
      toolName: 'file_write', cwd: 'C:/repo',
      result: {
        success: false, operation: 'modify', path: 'C:/repo/src/race.ts',
        conflict: 'source changed after approval',
      },
    })).toMatchObject({ marker: '!', label: 'Conflict blocked', blocked: true, verified: false });
  });

  it('does not project failed writes or failed atomic readback as successful effects', () => {
    expect(projectFileEffect({
      toolName: 'file_write', cwd: 'C:/repo',
      result: { success: false, operation: 'modify', path: 'C:/repo/src/a.ts', error: 'write failed' },
    })).toBeNull();
    expect(projectFileEffect({
      toolName: 'file_write', cwd: 'C:/repo',
      result: { success: false, operation: 'modify', path: 'C:/repo/src/a.ts', error: 'readback mismatch' },
    })).toBeNull();
  });

  it('projects a skipped absent delete as unchanged', () => {
    expect(projectFileEffect({
      toolName: 'file_delete', cwd: 'C:/repo',
      result: { success: true, skipped: true, operation: 'delete', path: 'C:/repo/old.ts' },
    })).toMatchObject({ marker: '=', label: 'Unchanged', path: 'old.ts' });
  });
});

describe('repository state presentation', () => {
  it('projects an unborn repository without raw probe errors', () => {
    expect(projectRepositoryState({ vcsKind: 'git', branch: 'master', headCommit: null })).toEqual({
      branch: 'master', head: 'no commits yet', state: 'unborn repository',
    });
  });

  it('projects a non-Git directory without inventing a branch', () => {
    expect(projectRepositoryState({ vcsKind: 'none', branch: null, headCommit: null })).toEqual({
      branch: 'not applicable', head: 'not applicable', state: 'non-Git directory',
    });
  });
});
