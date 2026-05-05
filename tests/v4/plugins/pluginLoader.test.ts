import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
  type AidenPaths,
} from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { PluginLoader } from '../../../core/v4/plugins/pluginLoader';
import { MANIFEST_VERSION } from '../../../core/v4/plugins/pluginManifest';

let tmpRoot: string;
let bundledRoot: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pload-'));
  bundledRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bundled-'));
  paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(bundledRoot, { recursive: true, force: true });
});

async function writePlugin(
  root: string,
  name: string,
  manifestExtra: Record<string, unknown>,
  indexJs: string,
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    name,
    version: '1.0.0',
    author: 'test',
    description: 'test plugin',
    ...manifestExtra,
  };
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
  );
  await fs.writeFile(path.join(dir, 'index.js'), indexJs);
  return dir;
}

describe('PluginLoader.discoverAndLoad', () => {
  it('9. handles empty plugins dir without crashing', async () => {
    const tools = new ToolRegistry();
    const loader = new PluginLoader({ paths, toolRegistry: tools });
    await loader.discoverAndLoad();
    expect(loader.getRegistry().list()).toEqual([]);
  });

  it('10. discovers + loads a user plugin and runs register()', async () => {
    await writePlugin(
      paths.pluginsDir,
      'noop-plugin',
      {
        tools: ['noop'],
        permissions: ['filesystem'],
      },
      `
        module.exports = {
          register(ctx) {
            ctx.registerTool({
              schema: { name: 'noop', description: 'd', input_schema: { type: 'object', properties: {} } },
              category: 'read',
              mutates: false,
              async execute() { return { ok: true }; },
            });
          },
        };
      `,
    );
    const tools = new ToolRegistry();
    const loader = new PluginLoader({ paths, toolRegistry: tools });
    await loader.discoverAndLoad();
    const list = loader.getRegistry().list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('loaded');
    expect(list[0].contributions.tools).toEqual(['noop']);
    expect(tools.list()).toContain('noop');
  });

  it('11. records error when register() throws (does not crash loader)', async () => {
    await writePlugin(
      paths.pluginsDir,
      'broken-plugin',
      { tools: [], permissions: [] },
      `module.exports = { register() { throw new Error('boom'); } };`,
    );
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
    });
    await loader.discoverAndLoad();
    const list = loader.getRegistry().list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('error');
    expect(list[0].error).toContain('boom');
  });

  it('12. records error when manifest is invalid', async () => {
    const dir = path.join(paths.pluginsDir, 'bad-manifest');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ manifestVersion: 99, name: 'x' }),
    );
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
    });
    await loader.discoverAndLoad();
    const list = loader.getRegistry().list();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('error');
    expect(list[0].error).toContain('manifest invalid');
  });

  it('13. user plugin overrides bundled with same name', async () => {
    await writePlugin(
      bundledRoot,
      'shared',
      { tools: [], permissions: [] },
      `module.exports = { register() {} };`,
    );
    await writePlugin(
      paths.pluginsDir,
      'shared',
      { tools: [], permissions: [], description: 'user version' },
      `module.exports = { register() {} };`,
    );
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
      bundledDir: bundledRoot,
    });
    await loader.discoverAndLoad();
    const found = loader.getRegistry().get('shared');
    expect(found).toBeDefined();
    expect(found!.manifest.source).toBe('user');
    expect(found!.manifest.description).toBe('user version');
  });

  it('14. permission denied via isPermissionGranted blocks load', async () => {
    await writePlugin(
      paths.pluginsDir,
      'needs-net',
      { tools: [], permissions: ['network'] },
      `module.exports = { register() {} };`,
    );
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
      isPermissionGranted: () => false,
    });
    await loader.discoverAndLoad();
    const found = loader.getRegistry().get('needs-net');
    expect(found?.status).toBe('error');
    expect(found?.error).toContain('permissions not granted');
  });
});

describe('PluginLoader.fireHook + teardown', () => {
  it('15. fires onActivate hooks; one throw does not stop the others', async () => {
    await writePlugin(
      paths.pluginsDir,
      'plugin-a',
      { tools: [], permissions: [] },
      `module.exports = {
         register(ctx) {
           ctx.registerHook('onActivate', () => { throw new Error('a-fail'); });
         },
       };`,
    );
    let bRan = false;
    // Inject a second plugin that records its activation in a side-channel file
    // (since we can't share JS state between dynamic imports cleanly).
    const sentinel = path.join(tmpRoot, 'sentinel.txt');
    await writePlugin(
      paths.pluginsDir,
      'plugin-b',
      { tools: [], permissions: ['filesystem'] },
      `const fs = require('node:fs');
       module.exports = {
         register(ctx) {
           ctx.registerHook('onActivate', () => { fs.writeFileSync(${JSON.stringify(sentinel)}, 'ok'); });
         },
       };`,
    );
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
    });
    await loader.discoverAndLoad();
    await loader.fireHook('onActivate');
    bRan = await fs
      .access(sentinel)
      .then(() => true)
      .catch(() => false);
    expect(bRan).toBe(true);
  });

  it('16. teardown unregisters tools and clears registry', async () => {
    await writePlugin(
      paths.pluginsDir,
      'cleaner',
      { tools: ['cleanme'], permissions: ['filesystem'] },
      `module.exports = {
         register(ctx) {
           ctx.registerTool({
             schema: { name: 'cleanme', description: 'd', input_schema: { type: 'object', properties: {} } },
             category: 'read',
             mutates: false,
             async execute() { return {}; },
           });
         },
       };`,
    );
    const tools = new ToolRegistry();
    const loader = new PluginLoader({ paths, toolRegistry: tools });
    await loader.discoverAndLoad();
    expect(tools.list()).toContain('cleanme');
    await loader.teardown();
    expect(tools.list()).not.toContain('cleanme');
    expect(loader.getRegistry().list()).toEqual([]);
  });
});
