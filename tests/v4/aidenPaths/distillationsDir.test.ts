/**
 * tests/v4/aidenPaths/distillationsDir.test.ts — v4.9.0 Slice 9.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveAidenPaths } from '../../../core/v4/paths';

describe('AidenPaths.distillationsDir + memoryBackupsDir — Slice 9', () => {
  it('distillationsDir = root/distillations', () => {
    const paths = resolveAidenPaths({ rootOverride: '/tmp/some-root' });
    expect(paths.distillationsDir).toBe(path.resolve('/tmp/some-root', 'distillations'));
  });

  it('memoryBackupsDir = root/memory-backups', () => {
    const paths = resolveAidenPaths({ rootOverride: '/tmp/some-root' });
    expect(paths.memoryBackupsDir).toBe(path.resolve('/tmp/some-root', 'memory-backups'));
  });

  it('both fields are siblings of the existing logsDir + skillsDir', () => {
    const paths = resolveAidenPaths({ rootOverride: '/tmp/some-root' });
    expect(path.dirname(paths.distillationsDir)).toBe(paths.root);
    expect(path.dirname(paths.memoryBackupsDir)).toBe(paths.root);
    expect(path.dirname(paths.logsDir)).toBe(paths.root);
  });
});
