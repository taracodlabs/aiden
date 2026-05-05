import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import {
  PluginContext,
  PluginContextError,
} from '../../../core/v4/plugins/pluginContext';
import {
  MANIFEST_VERSION,
  type LifecycleHook,
  type PluginManifest,
} from '../../../core/v4/plugins/pluginManifest';

function manifestFixture(extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    name: 'fix',
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

describe('PluginContext.registerTool', () => {
  let tools: ToolRegistry;
  let hooks: Map<LifecycleHook, Array<() => void | Promise<void>>>;

  beforeEach(() => {
    tools = new ToolRegistry();
    hooks = new Map();
  });

  it('17. registers a declared tool with matching permission', () => {
    const ctx = new PluginContext(
      manifestFixture({ tools: ['ping'], permissions: ['network'] }),
      tools,
      hooks,
    );
    ctx.registerTool({
      schema: { name: 'ping', description: 'p', input_schema: { type: 'object', properties: {} } } as any,
      category: 'network',
      mutates: false,
      async execute() {
        return {};
      },
    });
    expect(tools.list()).toContain('ping');
    expect(ctx.getContributions().tools).toEqual(['ping']);
  });

  it('18. rejects a tool not declared in manifest.tools', () => {
    const ctx = new PluginContext(
      manifestFixture({ tools: [], permissions: [] }),
      tools,
      hooks,
    );
    expect(() =>
      ctx.registerTool({
        schema: { name: 'sneaky', description: 'd', input_schema: { type: 'object', properties: {} } } as any,
        category: 'read',
        mutates: false,
        async execute() {
          return {};
        },
      }),
    ).toThrow(PluginContextError);
    expect(tools.list()).not.toContain('sneaky');
  });

  it('19. rejects a network tool when network permission is not declared', () => {
    const ctx = new PluginContext(
      manifestFixture({ tools: ['fetch'], permissions: [] }),
      tools,
      hooks,
    );
    expect(() =>
      ctx.registerTool({
        schema: { name: 'fetch', description: 'd', input_schema: { type: 'object', properties: {} } } as any,
        category: 'network',
        mutates: false,
        async execute() {
          return {};
        },
      }),
    ).toThrow(/permission "network"/);
    expect(tools.list()).not.toContain('fetch');
  });

  it('20. records hooks under the right lifecycle name', () => {
    const ctx = new PluginContext(manifestFixture(), tools, hooks);
    ctx.registerHook('onActivate', () => {});
    ctx.registerHook('onActivate', () => {});
    ctx.registerHook('onTeardown', () => {});
    expect(hooks.get('onActivate')?.length).toBe(2);
    expect(hooks.get('onTeardown')?.length).toBe(1);
    expect(ctx.getContributions().hooks).toEqual(['onActivate', 'onTeardown']);
  });
});
