/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Phase A — /channel discord add coverage.
 *
 * Covers the Discord graduation from the "coming in a later phase" stub:
 *   - validateDiscordToken: good token → ok + identity; 401 → clean reject;
 *     token never leaks into the failure reason; Bot auth header + endpoint.
 *   - channelAddSingleToken scaffold: persists to .env, (re)registers +
 *     restarts via the manager, honours empty/format/validation-fail paths.
 *   - routing: /channel discord {status,add,bogus} reach the Discord handlers
 *     (not the stub); other channels stay on the honest stub.
 *   - registerEnvChannels (boot): registers a creds-present channel, skips a
 *     creds-absent one, never touches Telegram (no double-registration).
 *   - the stale /mcp "coming in a later slice" message is gone.
 *
 * The Discord adapter is mocked so tests never import discord.js or touch
 * the network; fetch is stubbed per-test for the token probe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the Discord adapter — a light fake satisfying ChannelAdapter so we
// never load discord.js or hit the gateway. start() flips healthy=true.
vi.mock('../../../../core/channels/discord', () => {
  class DiscordAdapter {
    name = 'discord';
    private healthy = false;
    async start(): Promise<void> { this.healthy = true; }
    async stop():  Promise<void> { this.healthy = false; }
    isHealthy(): boolean { return this.healthy; }
    attachLogger(): void { /* noop */ }
    async send(): Promise<void> { /* noop */ }
  }
  return { DiscordAdapter };
});

import {
  channel,
  channelAddSingleToken,
  validateDiscordToken,
} from '../../../../cli/v4/commands/channel';
import { registerEnvChannels } from '../../../../cli/v4/channelBoot';

// ── test doubles ─────────────────────────────────────────────────────

function mkDisplay() {
  const lines: string[] = [];
  return {
    lines,
    write:        (m: string) => { lines.push(`[write] ${m}`); },
    success:      (m: string) => { lines.push(`[success] ${m}`); },
    dim:          (m: string) => { lines.push(`[dim] ${m}`); },
    warn:         (m: string) => { lines.push(`[warn] ${m}`); },
    printError:   (m: string, h?: string) => { lines.push(`[error] ${m}${h ? ` -- ${h}` : ''}`); },
    paint:        (m: string) => m,
    muted:        (m: string) => m,
    startSpinner: (_label: string) => ({ stop: () => { /* noop */ } }),
  };
}

function mkManager() {
  const adapters = new Map<string, any>();
  return {
    adapters,
    register: vi.fn((a: any) => { adapters.set(a.name, a); }),
    get:      vi.fn((n: string) => adapters.get(n)),
    restart:  vi.fn(async (n: string) => {
      const a = adapters.get(n);
      if (!a) return { name: n, status: 'failed', error: 'unknown' };
      await a.stop?.();
      await a.start?.();
      return { name: n, status: a.isHealthy?.() ? 'started' : 'disabled' };
    }),
  };
}

/** Stub global fetch with a scripted response. */
function stubFetch(resp: { ok: boolean; status: number; statusText?: string; json?: () => Promise<any> }) {
  const spy = vi.fn(async () => ({
    ok: resp.ok, status: resp.status, statusText: resp.statusText ?? '',
    json: resp.json ?? (async () => ({})),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

let tmp: string;
const SAVED_DISCORD = process.env.DISCORD_BOT_TOKEN;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-discord-'));
  delete process.env.DISCORD_BOT_TOKEN;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  if (SAVED_DISCORD === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = SAVED_DISCORD;
});

// ── validateDiscordToken ─────────────────────────────────────────────

describe('validateDiscordToken', () => {
  it('accepts a good token and returns the bot identity', async () => {
    const spy = stubFetch({ ok: true, status: 200, json: async () => ({ username: 'aidenbot', discriminator: '0' }) });
    const r = await validateDiscordToken('good-token-value');
    expect(r.ok).toBe(true);
    expect(r.identity).toBe('aidenbot');
    // Correct endpoint + Bot auth scheme.
    const [url, init] = spy.mock.calls[0] as [string, any];
    expect(url).toBe('https://discord.com/api/v10/users/@me');
    expect(init.headers.Authorization).toBe('Bot good-token-value');
  });

  it('appends a legacy #discriminator when present', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({ username: 'foo', discriminator: '1234' }) });
    const r = await validateDiscordToken('t');
    expect(r.identity).toBe('foo#1234');
  });

  it('rejects a 401 cleanly and never leaks the token in the reason', async () => {
    stubFetch({ ok: false, status: 401, statusText: 'Unauthorized' });
    const secret = 'super-secret-bot-token-abc123';
    const r = await validateDiscordToken(secret);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/401/);
    expect(r.reason ?? '').not.toContain(secret);
  });
});

// ── channelAddSingleToken scaffold ───────────────────────────────────

function baseSpec(over: Record<string, any> = {}) {
  return {
    id:              'discord',
    displayName:     'Discord',
    envVar:          'MY_TOKEN',
    intakeHint:      '\n  hint\n',
    promptLabel:     '  paste: ',
    validatingLabel: 'validating…',
    validate:        async () => ({ ok: true, identity: 'bot-x' }),
    makeAdapter:     () => {
      let healthy = false;
      return { name: 'discord', async start() { healthy = true; }, async stop() { healthy = false; }, isHealthy() { return healthy; }, attachLogger() {} };
    },
    successMessage:  (id: string) => `Discord connected as ${id}. Ready to chat!`,
    ...over,
  };
}

describe('channelAddSingleToken scaffold', () => {
  it('persists the token to .env and registers + restarts the adapter', async () => {
    const envFile = path.join(tmp, '.env');
    const display = mkDisplay();
    const manager = mkManager();
    const ctx: any = { display, prompt: async () => 'my-token-123', paths: { envFile }, channelManager: manager };

    await channelAddSingleToken(ctx, baseSpec() as any);

    const env = await fs.readFile(envFile, 'utf8');
    expect(env).toMatch(/MY_TOKEN=my-token-123/);
    expect(process.env.MY_TOKEN).toBe('my-token-123');
    expect(manager.register).toHaveBeenCalledTimes(1);
    expect(manager.restart).toHaveBeenCalledWith('discord');
    expect(display.lines.join('\n')).toMatch(/Discord connected as bot-x/);
    delete process.env.MY_TOKEN;
  });

  it('does NOT persist or register when validation fails', async () => {
    const envFile = path.join(tmp, '.env');
    const display = mkDisplay();
    const manager = mkManager();
    const ctx: any = { display, prompt: async () => 'bad', paths: { envFile }, channelManager: manager };

    await channelAddSingleToken(ctx, baseSpec({ validate: async () => ({ ok: false, reason: 'nope' }) }) as any);

    await expect(fs.readFile(envFile, 'utf8')).rejects.toThrow(); // never written
    expect(manager.register).not.toHaveBeenCalled();
    expect(display.lines.join('\n')).toMatch(/Discord rejected the token: nope/);
  });

  it('cancels on an empty token without validating', async () => {
    const display = mkDisplay();
    const validate = vi.fn(async () => ({ ok: true }));
    const ctx: any = { display, prompt: async () => '   ', paths: { envFile: path.join(tmp, '.env') }, channelManager: mkManager() };
    await channelAddSingleToken(ctx, baseSpec({ validate }) as any);
    expect(validate).not.toHaveBeenCalled();
    expect(display.lines.join('\n')).toMatch(/Empty token — cancelled/);
  });

  it('rejects a malformed token via the optional format check', async () => {
    const display = mkDisplay();
    const validate = vi.fn(async () => ({ ok: true }));
    const ctx: any = { display, prompt: async () => 'abc', paths: { envFile: path.join(tmp, '.env') }, channelManager: mkManager() };
    await channelAddSingleToken(ctx, baseSpec({ tokenFormat: /^\d+$/, validate }) as any);
    expect(validate).not.toHaveBeenCalled();
    expect(display.lines.join('\n')).toMatch(/doesn't look like a Discord bot token/);
  });
});

// ── routing via channel.handler ──────────────────────────────────────

describe('/channel discord routing', () => {
  it('routes `discord status` to the Discord handler (not the stub)', async () => {
    const display = mkDisplay();
    const ctx: any = { display, rawArgs: 'discord status', channelManager: mkManager(), paths: { envFile: path.join(tmp, '.env') } };
    await channel.handler(ctx);
    const joined = display.lines.join('\n');
    expect(joined).toMatch(/Discord status:/);
    expect(joined).not.toMatch(/coming in a later phase/);
  });

  it('routes `discord add` through the scaffold (proves it is not the stub)', async () => {
    // 401 path — exercises routing → discordAdd → scaffold → validateDiscordToken
    // end to end without a successful login.
    stubFetch({ ok: false, status: 401, statusText: 'Unauthorized' });
    const display = mkDisplay();
    const token = 'A'.repeat(24) + '.' + 'B'.repeat(24);   // passes the format check
    const ctx: any = { display, rawArgs: 'discord add', prompt: async () => token, channelManager: mkManager(), paths: { envFile: path.join(tmp, '.env') } };
    await channel.handler(ctx);
    const joined = display.lines.join('\n');
    expect(joined).toMatch(/Discord rejected the token/);
    expect(joined).not.toMatch(/coming in a later phase/);
  });

  it('reports an unknown discord action', async () => {
    const display = mkDisplay();
    const ctx: any = { display, rawArgs: 'discord bogus', channelManager: mkManager(), paths: { envFile: path.join(tmp, '.env') } };
    await channel.handler(ctx);
    expect(display.lines.join('\n')).toMatch(/Unknown discord action 'bogus'/);
  });

  it('leaves the other channels on the honest stub', async () => {
    const display = mkDisplay();
    const ctx: any = { display, rawArgs: 'slack', channelManager: mkManager(), paths: { envFile: path.join(tmp, '.env') } };
    await channel.handler(ctx);
    expect(display.lines.join('\n')).toMatch(/coming in a later phase/);
  });
});

// ── registerEnvChannels (boot) ───────────────────────────────────────

describe('registerEnvChannels', () => {
  it('registers a channel whose credentials are present', () => {
    const manager = mkManager();
    const ids = registerEnvChannels(manager as any, { DISCORD_BOT_TOKEN: 'x' } as any);
    expect(ids).toContain('discord');
    expect(manager.get('discord')).toBeDefined();
  });

  it('skips a channel whose credentials are absent', () => {
    const manager = mkManager();
    const ids = registerEnvChannels(manager as any, {} as any);
    expect(ids).toEqual([]);
    expect(manager.register).not.toHaveBeenCalled();
  });

  it('never registers Telegram (no double-registration with the boot)', () => {
    const manager = mkManager();
    registerEnvChannels(manager as any, { DISCORD_BOT_TOKEN: 'x', TELEGRAM_BOT_TOKEN: 'y' } as any);
    expect(manager.get('telegram')).toBeUndefined();
  });
});

// ── /mcp message freshness ───────────────────────────────────────────

describe('/mcp empty-state message is not stale', () => {
  it('no longer claims `/mcp add` is coming in a later slice', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../../cli/v4/commands/mcpManage.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/coming in a later slice/);
    expect(src).toMatch(/\/mcp add/);
  });
});
