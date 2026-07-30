import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveRuntimeStorageRoot, runtimeArtifactDirectory } from '../../../core/v4/runtimeStorage';

describe('runtime storage location', () => {
  it('keeps internal state out of the active repository', () => {
    const repository = path.resolve('C:/user/project');
    const aidenHome = path.resolve('C:/isolated/aiden-home');
    const root = resolveRuntimeStorageRoot({}, { root: aidenHome });
    expect(root).toBe(aidenHome);
    expect(root).not.toBe(repository);
    expect(runtimeArtifactDirectory('screenshots', root)).toBe(path.join(aidenHome, 'artifacts', 'screenshots'));
  });

  it('honors an explicit packaged user-data root', () => {
    const packaged = path.resolve('C:/packaged/user-data');
    expect(resolveRuntimeStorageRoot(
      { AIDEN_USER_DATA: packaged },
      { root: path.resolve('C:/fallback') },
    )).toBe(packaged);
  });
});
