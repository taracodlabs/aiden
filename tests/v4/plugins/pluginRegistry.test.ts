import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../../core/v4/plugins/pluginRegistry';
import {
  MANIFEST_VERSION,
  type PluginManifest,
} from '../../../core/v4/plugins/pluginManifest';

function fix(name: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    name,
    version: '1.0.0',
    author: 'a',
    description: 'd',
    kind: 'standalone',
    tools: [],
    skills: [],
    providers: [],
    permissions: [],
    requiresEnv: [],
    ...extra,
  };
}

describe('PluginRegistry', () => {
  it('21. upsert + get round-trip', () => {
    const r = new PluginRegistry();
    r.upsert({
      manifest: fix('alpha'),
      status: 'loaded',
      contributions: { tools: [], hooks: [] },
    });
    expect(r.get('alpha')?.status).toBe('loaded');
  });

  it('22. list returns alphabetical order', () => {
    const r = new PluginRegistry();
    for (const n of ['gamma', 'alpha', 'beta']) {
      r.upsert({
        manifest: fix(n),
        status: 'loaded',
        contributions: { tools: [], hooks: [] },
      });
    }
    expect(r.list().map((p) => p.manifest.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('23. countByStatus tallies correctly', () => {
    const r = new PluginRegistry();
    r.upsert({ manifest: fix('a'), status: 'loaded', contributions: { tools: [], hooks: [] } });
    r.upsert({ manifest: fix('b'), status: 'error', contributions: { tools: [], hooks: [] }, error: 'x' });
    r.upsert({ manifest: fix('c'), status: 'loaded', contributions: { tools: [], hooks: [] } });
    const counts = r.countByStatus();
    expect(counts.loaded).toBe(2);
    expect(counts.error).toBe(1);
    expect(counts.disabled).toBe(0);
  });
});
