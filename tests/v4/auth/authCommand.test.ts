import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  saveTokens,
  loadTokens,
  hasTokens,
} from '../../../core/v4/auth/tokenStore';
import {
  auth,
  formatRelativeExpiry,
} from '../../../cli/v4/commands/auth';
import {
  CommandRegistry,
  type SlashCommandContext,
} from '../../../cli/v4/commandRegistry';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-auth-cmd-'));
  process.env.AIDEN_TOKEN_KEY = 'test-key';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
});

function captured() {
  const o: any = { out: [], errs: [] };
  o.info = (m: string) => o.out.push('info:' + m);
  o.warn = (m: string) => o.out.push('warn:' + m);
  o.dim = (m: string) => o.out.push('dim:' + m);
  o.write = (m: string) => o.out.push(m);
  o.line = () => o.out.push('---');
  o.printError = (...m: string[]) => o.errs.push(m.join(' | '));
  o.success = (m: string) => o.out.push('ok:' + m);
  o.startSpinner = () => ({ stop() {} });
  return o;
}

async function buildCtx(extra: Partial<SlashCommandContext> = {}) {
  const paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);
  const display = captured();
  const ctx: SlashCommandContext = {
    args: [],
    rawArgs: '',
    display: display as any,
    registry: new CommandRegistry(),
    paths,
    ...extra,
  };
  return { ctx, display };
}

/**
 * Stub the plugin's buildProvider via require.cache so /auth login + refresh
 * exercise the OAuthProviderRuntime path without real network.
 */
function stubPluginBuildProvider(
  pluginRelPath: string,
  loginResult: any,
  refreshResult: any = loginResult,
): () => void {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const absPath = path.resolve(repoRoot, pluginRelPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const original = require(absPath);
  const stubbed = {
    ...original,
    buildProvider: () => ({
      id: pluginRelPath.includes('claude-pro') ? 'claude-pro' : 'chatgpt-plus',
      displayName: 'Stub',
      defaultModels: ['stub-model-a', 'stub-model-b'],
      async login() {
        return loginResult;
      },
      async refresh() {
        return refreshResult;
      },
      describeRuntime() {
        return { apiMode: 'anthropic_messages' as const };
      },
    }),
  };
  require.cache[require.resolve(absPath)]!.exports = stubbed;
  return () => {
    require.cache[require.resolve(absPath)]!.exports = original;
  };
}

describe('/auth status', () => {
  it('48. status with no tokens shows "not authenticated" + login hint', async () => {
    const { ctx, display } = await buildCtx();
    ctx.args = ['status'];
    await auth.handler(ctx);
    const text = display.out.join('\n');
    expect(text).toContain('claude-pro');
    expect(text).toContain('not authenticated');
    expect(text).toContain('/auth login claude-pro');
    expect(text).toContain('chatgpt-plus');
  });

  it('49. status renders authed providers with relative expiry + account', async () => {
    const { ctx, display } = await buildCtx();
    await saveTokens(ctx.paths!, {
      provider: 'claude-pro',
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAtMs: Date.now() + 3600_000,
      account: 'shiva@example.com',
      models: ['claude-opus-4-7'],
    });
    ctx.args = ['status'];
    await auth.handler(ctx);
    const text = display.out.join('\n');
    expect(text).toContain('shiva@example.com');
    expect(text).toMatch(/expires in \d+ (minute|minutes|hour|hours)/);
    expect(text).toContain('state: authed');
    // Post-v4.1.1 cleanup: /auth status no longer renders the stored
    // `tokens.models` list — it goes stale when providers rotate their
    // catalog. Current model list lives in /model. We assert the model
    // id is NOT in the output to lock in the new behavior.
    expect(text).not.toContain('claude-opus-4-7');
  });

  it('50. status flags tokens within the 5-min preflight window as "expiring soon"', async () => {
    const { ctx, display } = await buildCtx();
    await saveTokens(ctx.paths!, {
      provider: 'claude-pro',
      accessToken: 'AT',
      expiresAtMs: Date.now() + 60_000, // 1 min
    });
    ctx.args = ['status', 'claude-pro'];
    await auth.handler(ctx);
    const text = display.out.join('\n');
    expect(text).toContain('expiring soon');
    expect(text).toContain('/auth refresh claude-pro');
  });

  it('51. status footer shows encryption note + multi-provider hint', async () => {
    const { ctx, display } = await buildCtx();
    ctx.args = ['status'];
    await auth.handler(ctx);
    const text = display.out.join('\n');
    expect(text).toMatch(/machine-derived key/);
    expect(text).toMatch(/edit .*config\.yaml directly/i);
  });

  it('52. status with unknown provider returns honest error', async () => {
    const { ctx, display } = await buildCtx();
    ctx.args = ['status', 'fake-provider'];
    await auth.handler(ctx);
    expect(display.errs[0]).toMatch(/Unknown provider 'fake-provider'/);
  });
});

describe('/auth login', () => {
  it('53. login persists tokens via OAuthProviderRuntime', async () => {
    const { ctx, display } = await buildCtx({
      prompt: async () => 'AUTHCODE#STATE',
    });
    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-claude-pro/index.js',
      {
        accessToken: 'login-AT',
        refreshToken: 'login-RT',
        expiresInSeconds: 3600,
        extras: { account: 'shiva@example.com' },
      },
    );
    try {
      ctx.args = ['login', 'claude-pro'];
      await auth.handler(ctx);
      const tokens = await loadTokens(ctx.paths!, 'claude-pro');
      expect(tokens?.accessToken).toBe('login-AT');
      expect(tokens?.account).toBe('shiva@example.com');
      const text = display.out.join('\n');
      expect(text).toContain('claude-pro authed');
      expect(text).toContain('shiva@example.com');
    } finally {
      restore();
    }
  });

  it('54. login without provider arg surfaces usage error', async () => {
    const { ctx, display } = await buildCtx();
    ctx.args = ['login'];
    await auth.handler(ctx);
    expect(display.errs[0]).toMatch(/Usage: \/auth login <provider>/);
  });

  it('55. login with unknown provider surfaces honest error', async () => {
    const { ctx, display } = await buildCtx();
    ctx.args = ['login', 'no-such-provider'];
    await auth.handler(ctx);
    expect(display.errs[0]).toMatch(/Unknown provider/);
  });
});

describe('/auth logout', () => {
  it('56. logout deletes the token file', async () => {
    const { ctx, display } = await buildCtx();
    await saveTokens(ctx.paths!, {
      provider: 'claude-pro',
      accessToken: 'AT',
      expiresAtMs: Date.now() + 3600_000,
    });
    expect(await hasTokens(ctx.paths!, 'claude-pro')).toBe(true);
    ctx.args = ['logout', 'claude-pro'];
    await auth.handler(ctx);
    expect(await hasTokens(ctx.paths!, 'claude-pro')).toBe(false);
    expect(display.out.join('\n')).toContain('signed out');
  });

  it('57. logout when no tokens present is a no-op with friendly message', async () => {
    const { ctx, display } = await buildCtx();
    ctx.args = ['logout', 'claude-pro'];
    await auth.handler(ctx);
    expect(display.out.join('\n')).toContain('nothing to log out');
  });
});

describe('/auth refresh', () => {
  it('58. refresh re-issues tokens via OAuthProviderRuntime', async () => {
    const { ctx, display } = await buildCtx();
    await saveTokens(ctx.paths!, {
      provider: 'claude-pro',
      accessToken: 'OLD',
      refreshToken: 'OLD-RT',
      expiresAtMs: Date.now() - 1000, // expired
    });
    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-claude-pro/index.js',
      {
        accessToken: 'NEW',
        refreshToken: 'NEW-RT',
        expiresInSeconds: 3600,
      },
    );
    try {
      ctx.args = ['refresh', 'claude-pro'];
      await auth.handler(ctx);
      const tokens = await loadTokens(ctx.paths!, 'claude-pro');
      expect(tokens?.accessToken).toBe('NEW');
      expect(display.out.join('\n')).toMatch(
        /claude-pro refreshed.*expires in/,
      );
    } finally {
      restore();
    }
  });

  it('59. refresh without prior login surfaces clear error pointing at login', async () => {
    const { ctx, display } = await buildCtx();
    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-claude-pro/index.js',
      { accessToken: 'X', refreshToken: null, expiresInSeconds: 0 },
    );
    try {
      ctx.args = ['refresh', 'claude-pro'];
      await auth.handler(ctx);
      expect(display.errs.join('\n')).toMatch(/refresh failed/);
      expect(display.errs.join('\n')).toMatch(/\/auth login claude-pro/);
    } finally {
      restore();
    }
  });
});

describe('formatRelativeExpiry', () => {
  it('60. produces "expires in <future>" / "expired <past> ago"', () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeExpiry(now + 47 * 60_000, now)).toBe(
      'expires in 47 minutes',
    );
    expect(formatRelativeExpiry(now - 2 * 86_400_000, now)).toBe(
      'expired 2 days ago',
    );
    expect(formatRelativeExpiry(now + 60_000, now)).toBe('expires in 1 minute');
    expect(formatRelativeExpiry(now + 3600_000, now)).toBe(
      'expires in 1 hour',
    );
  });
});
