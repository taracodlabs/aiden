import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { PluginLoader } from '../../../core/v4/plugins/pluginLoader';
import { PluginContext, PluginContextError } from '../../../core/v4/plugins/pluginContext';
import { OAuthProviderRegistry } from '../../../core/v4/auth/providerAuth';
import {
  evaluatePermissionState,
  saveGrantedPermissions,
} from '../../../core/v4/plugins/pluginPermissions';
import { MANIFEST_VERSION } from '../../../core/v4/plugins/pluginManifest';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-claudepro-reg-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  // Smoke for Phase 17 polluted the in-place plugin dir; mirror its cleanup
  // here. /plugins grant on the bundled plugin path writes a real file
  // because manifest.path points to <repo>/plugins/...
  const real = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'plugins',
    'aiden-plugin-claude-pro',
    '.granted-permissions.json',
  );
  await fs.rm(real, { force: true });
});

describe('aiden-plugin-claude-pro: registration through PluginContext', () => {
  it('30. registerOAuthProvider succeeds when manifest declares auth-providers', async () => {
    const oauth = new OAuthProviderRegistry();
    const tools = new ToolRegistry();
    const ctx = new PluginContext(
      {
        manifestVersion: MANIFEST_VERSION,
        name: 'aiden-plugin-claude-pro',
        version: '1.0.0',
        author: 'a',
        description: 'd',
        kind: 'bundled',
        tools: [],
        skills: [],
        providers: ['claude-pro'],
        permissions: ['auth-providers', 'network'],
        requiresEnv: [],
      },
      tools,
      new Map() as any,
      'granted',
      oauth,
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const claudePro = require('../../../plugins/aiden-plugin-claude-pro/index.js');
    await claudePro.register(ctx);
    expect(oauth.get('claude-pro')).toBeDefined();
    expect(oauth.list().map((p) => p.id)).toEqual(['claude-pro']);
    expect(ctx.getRegisteredOAuthProviderIds()).toEqual(['claude-pro']);
  });

  it('31. registerOAuthProvider rejects when manifest is missing auth-providers permission', () => {
    const oauth = new OAuthProviderRegistry();
    const ctx = new PluginContext(
      {
        manifestVersion: MANIFEST_VERSION,
        name: 'forgot-perm',
        version: '1.0.0',
        author: 'a',
        description: 'd',
        kind: 'standalone',
        tools: [],
        skills: [],
        providers: [],
        permissions: ['network'],
        requiresEnv: [],
      },
      new ToolRegistry(),
      new Map() as any,
      'granted',
      oauth,
    );
    expect(() =>
      ctx.registerOAuthProvider({
        id: 'x',
        displayName: 'x',
        async login() {
          return { accessToken: '', refreshToken: null, expiresInSeconds: 0 };
        },
        async refresh() {
          return { accessToken: '', refreshToken: null, expiresInSeconds: 0 };
        },
      }),
    ).toThrow(PluginContextError);
    expect(oauth.list()).toEqual([]);
  });

  it('32. PluginLoader passes oauthRegistry through to plugin contexts (synthetic plugin)', async () => {
    // Use a tmp synthetic plugin to avoid racing with the in-place
    // claude-pro plugin dir's granted-permissions file (the smoke test
    // also mutates that dir).
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const synthDir = path.join(paths.pluginsDir, 'fake-oauth-plugin');
    await fs.mkdir(synthDir, { recursive: true });
    await fs.writeFile(
      path.join(synthDir, 'plugin.json'),
      JSON.stringify({
        manifestVersion: MANIFEST_VERSION,
        name: 'fake-oauth-plugin',
        version: '1.0.0',
        author: 'test',
        description: 'd',
        tools: [],
        permissions: ['auth-providers'],
      }),
    );
    await fs.writeFile(
      path.join(synthDir, 'index.js'),
      `module.exports = {
        register(ctx) {
          ctx.registerOAuthProvider({
            id: 'fake-prov',
            displayName: 'Fake',
            async login() {
              return { accessToken: 'a', refreshToken: null, expiresInSeconds: 0 };
            },
            async refresh() {
              return { accessToken: 'a', refreshToken: null, expiresInSeconds: 0 };
            },
          });
        },
      };`,
    );
    // Grant in the user-dir copy (not the bundled in-place one).
    await saveGrantedPermissions(synthDir, ['auth-providers']);

    const oauth = new OAuthProviderRegistry();
    const loader = new PluginLoader({
      paths,
      toolRegistry: new ToolRegistry(),
      evaluatePermissions: evaluatePermissionState,
      oauthRegistry: oauth,
    });
    await loader.discoverAndLoad();
    const entry = loader.getRegistry().get('fake-oauth-plugin');
    expect(entry?.status).toBe('loaded');
    expect(oauth.get('fake-prov')).toBeDefined();
  });
});
