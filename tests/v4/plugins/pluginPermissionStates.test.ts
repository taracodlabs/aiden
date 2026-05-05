import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAidenPaths, ensureAidenDirsExist } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { PluginLoader } from '../../../core/v4/plugins/pluginLoader';
import {
  evaluatePermissionState,
  saveGrantedPermissions,
} from '../../../core/v4/plugins/pluginPermissions';
import { plugins as pluginsCmd } from '../../../cli/v4/commands/plugins';
import { CommandRegistry, type SlashCommandContext } from '../../../cli/v4/commandRegistry';
import { MANIFEST_VERSION } from '../../../core/v4/plugins/pluginManifest';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-task4-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writePlugin(
  root: string,
  name: string,
  permissions: string[],
  toolsList: string[] = [],
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      manifestVersion: MANIFEST_VERSION,
      name,
      version: '1.0.0',
      author: 't',
      description: 'd',
      tools: toolsList,
      permissions,
    }),
  );
  const toolJs = toolsList
    .map(
      (n) => `
      ctx.registerTool({
        schema: { name: ${JSON.stringify(n)}, description: 'd', input_schema: { type: 'object', properties: {} } },
        category: 'network', mutates: false,
        async execute() { return { real: true }; },
      });`,
    )
    .join('\n');
  await fs.writeFile(
    path.join(dir, 'index.js'),
    `module.exports = { register(ctx) { ${toolJs} } };`,
  );
  return dir;
}

describe('evaluatePermissionState', () => {
  it('45. plugin with no declared perms is always granted', async () => {
    const dir = await writePlugin(tmpRoot, 'no-perms', []);
    const e = evaluatePermissionState({
      manifestVersion: MANIFEST_VERSION,
      name: 'no-perms',
      version: '1.0.0',
      author: 't', description: 'd',
      kind: 'standalone',
      tools: [], skills: [], providers: [],
      permissions: [], requiresEnv: [],
      path: dir,
    });
    expect(e.state).toBe('granted');
  });

  it('46. plugin with declared perms but no granted file is pending-grant', async () => {
    const dir = await writePlugin(tmpRoot, 'p1', ['network']);
    const e = evaluatePermissionState({
      manifestVersion: MANIFEST_VERSION,
      name: 'p1', version: '1.0.0', author: 't', description: 'd',
      kind: 'standalone',
      tools: [], skills: [], providers: [],
      permissions: ['network'], requiresEnv: [],
      path: dir,
    });
    expect(e.state).toBe('pending-grant');
    expect(e.missing).toEqual(['network']);
    expect(e.grantedFileExists).toBe(false);
  });

  it('47. granted file covering declared perms ⇒ granted', async () => {
    const dir = await writePlugin(tmpRoot, 'p2', ['network']);
    await saveGrantedPermissions(dir, ['network']);
    const e = evaluatePermissionState({
      manifestVersion: MANIFEST_VERSION,
      name: 'p2', version: '1.0.0', author: 't', description: 'd',
      kind: 'standalone',
      tools: [], skills: [], providers: [],
      permissions: ['network'], requiresEnv: [],
      path: dir,
    });
    expect(e.state).toBe('granted');
    expect(e.missing).toEqual([]);
  });

  it('48. manifest expanded vs granted ⇒ suspended with missing diff', async () => {
    const dir = await writePlugin(tmpRoot, 'p3', ['network', 'shell']);
    // User previously granted only network (e.g. plugin v1.0); v1.1
    // now also asks for shell.
    await saveGrantedPermissions(dir, ['network']);
    const e = evaluatePermissionState({
      manifestVersion: MANIFEST_VERSION,
      name: 'p3', version: '1.1.0', author: 't', description: 'd',
      kind: 'standalone',
      tools: [], skills: [], providers: [],
      permissions: ['network', 'shell'], requiresEnv: [],
      path: dir,
    });
    expect(e.state).toBe('suspended');
    expect(e.missing).toEqual(['shell']);
  });
});

describe('PluginLoader pending-grant + suspended end-to-end', () => {
  it('49. pending-grant plugin: tool registered but execute returns refusal', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await writePlugin(paths.pluginsDir, 'realdocs', ['network'], ['fetch_doc']);
    const tools = new ToolRegistry();
    const loader = new PluginLoader({
      paths,
      toolRegistry: tools,
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();

    const entry = loader.getRegistry().get('realdocs');
    expect(entry?.status).toBe('pending-grant');
    expect(entry?.missingPermissions).toEqual(['network']);

    // Tool is registered (so /tools list shows it) ...
    expect(tools.list()).toContain('fetch_doc');
    // ... but execute returns the refusal.
    const exec = tools.buildExecutor({ cwd: tmpRoot, paths });
    const result = await exec({ id: '1', name: 'fetch_doc', arguments: {} });
    expect(result.error).toBeUndefined();
    // result.result is the structured object the wrapped handler returned.
    expect((result.result as any).error).toMatch(/permissions not granted/);
    expect((result.result as any).error).toContain('/plugins grant realdocs');
  });

  it('50. suspended plugin: tools NOT registered, status surfaces missing diff', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const dir = await writePlugin(paths.pluginsDir, 'upgraded', ['network', 'shell'], ['t1']);
    await saveGrantedPermissions(dir, ['network']); // user granted only network earlier
    const tools = new ToolRegistry();
    const loader = new PluginLoader({
      paths, toolRegistry: tools,
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();
    const entry = loader.getRegistry().get('upgraded');
    expect(entry?.status).toBe('suspended');
    expect(entry?.missingPermissions).toEqual(['shell']);
    // No tool wrapper registered.
    expect(tools.list()).not.toContain('t1');
  });
});

describe('/plugins grant subcommand', () => {
  function captured() {
    const o: any = { out: [], errs: [] };
    o.info = (m: string) => o.out.push('info:' + m);
    o.warn = (m: string) => o.out.push('warn:' + m);
    o.dim  = (m: string) => o.out.push('dim:' + m);
    o.write = (m: string) => o.out.push(m);
    o.line = () => o.out.push('---');
    o.printError = (...m: string[]) => o.errs.push(m.join(' | '));
    o.success = (m: string) => o.out.push('ok:' + m);
    o.startSpinner = () => ({ stop() {} });
    return o;
  }

  it('51. /plugins grant moves a pending-grant plugin to loaded', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await writePlugin(paths.pluginsDir, 'svc', ['network'], ['svc_call']);
    const tools = new ToolRegistry();
    const loader = new PluginLoader({
      paths, toolRegistry: tools,
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();
    expect(loader.getRegistry().get('svc')?.status).toBe('pending-grant');

    const display = captured();
    const ctx: SlashCommandContext = {
      args: ['grant', 'svc'],
      rawArgs: 'grant svc',
      display,
      registry: new CommandRegistry(),
      paths,
      pluginLoader: loader,
      confirm: async () => true,
    };
    await pluginsCmd.handler(ctx);

    const after = loader.getRegistry().get('svc');
    expect(after?.status).toBe('loaded');
    // Real (unwrapped) execute now reachable.
    const exec = tools.buildExecutor({ cwd: tmpRoot, paths });
    const r = await exec({ id: '1', name: 'svc_call', arguments: {} });
    expect((r.result as any).real).toBe(true);
  });

  it('52. /plugins grant flags NEW perms when manifest expanded', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const dir = await writePlugin(paths.pluginsDir, 'grew', ['network', 'shell'], ['t']);
    await saveGrantedPermissions(dir, ['network']);
    const loader = new PluginLoader({
      paths, toolRegistry: new ToolRegistry(),
      evaluatePermissions: evaluatePermissionState,
    });
    await loader.discoverAndLoad();
    expect(loader.getRegistry().get('grew')?.status).toBe('suspended');

    const display = captured();
    const ctx: SlashCommandContext = {
      args: ['grant', 'grew'],
      rawArgs: 'grant grew',
      display,
      registry: new CommandRegistry(),
      paths,
      pluginLoader: loader,
      confirm: async () => true,
    };
    await pluginsCmd.handler(ctx);

    const out = display.out.join('\n');
    expect(out).toMatch(/NEW permissions requested: shell/);
    expect(loader.getRegistry().get('grew')?.status).toBe('loaded');
  });
});
