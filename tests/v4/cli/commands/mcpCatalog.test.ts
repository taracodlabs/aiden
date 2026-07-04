/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 4 — curated MCP catalog: data integrity, read-only listing, and
 * `/mcp catalog add` / `/mcp install` funnelling through the same /mcp add gate
 * (pre-fill, transport:'streamable' for http, oauth defers connect + hints).
 */
import { describe, it, expect, vi } from 'vitest';
import { mcp, extractClientIdFlag } from '../../../../cli/v4/commands/mcpManage';
import {
  MCP_CATALOG,
  findCatalogEntry,
  catalogEntryToRawConfig,
} from '../../../../cli/v4/commands/mcpCatalog';
import { CommandRegistry, type SlashCommandContext } from '../../../../cli/v4/commandRegistry';

function fakeConfig(servers: Record<string, unknown> = {}) {
  const store: any = Object.keys(servers).length ? { mcp: { servers: { ...servers } } } : {};
  return {
    store,
    save: vi.fn(async () => {}),
    getValue: (key: string) => { let c: any = store; for (const p of key.split('.')) { if (c == null) return undefined; c = c[p]; } return c; },
    set: (key: string, val: unknown) => {
      const parts = key.split('.'); let c: any = store;
      for (let i = 0; i < parts.length - 1; i += 1) { if (typeof c[parts[i]] !== 'object' || c[parts[i]] == null) c[parts[i]] = {}; c = c[parts[i]]; }
      c[parts[parts.length - 1]] = val;
    },
  };
}
function fakeClient() {
  return {
    list: () => [],
    get: () => undefined,
    connect: vi.fn(async (cfg: { name: string }) => ({ config: cfg, tools: [{ rawName: 't', prefixedName: `mcp_${cfg.name}_t` }], status: 'ready' })),
  };
}
function captured() {
  const o: any = { out: [] as string[] };
  o.info = (m: string) => o.out.push(`info:${m}`);
  o.warn = (m: string) => o.out.push(`warn:${m}`);
  o.dim = (m: string) => o.out.push(`dim:${m}`);
  o.write = (m: string) => o.out.push(m.replace(/\n$/, ''));
  o.success = (m: string) => o.out.push(`ok:${m}`);
  o.printError = (m: string, s?: string) => o.out.push(`err:${m}${s ? ` | ${s}` : ''}`);
  return o;
}
function buildCtx(args: string[], client: unknown, extra: Partial<SlashCommandContext> = {}) {
  const display = captured();
  const ctx = { args, rawArgs: args.join(' '), display: display as never, registry: new CommandRegistry(), mcpClient: client as never, ...extra } as SlashCommandContext;
  return { ctx, display };
}
const text = (d: any) => d.out.join('\n');

describe('MCP catalog — data integrity', () => {
  it('slugs are unique, slug-safe, and 9 entries are seeded', () => {
    const slugs = MCP_CATALOG.map((e) => e.slug);
    expect(slugs.length).toBe(9);
    expect(new Set(slugs).size).toBe(slugs.length); // unique
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+$/);
  });

  it('every entry has required fields + valid transport/auth, and shape matches transport', () => {
    for (const e of MCP_CATALOG) {
      expect(e.name && e.description && e.sourceUrl && e.securityNotes).toBeTruthy();
      expect(['stdio', 'streamable', 'sse']).toContain(e.transport);
      expect(['none', 'oauth']).toContain(e.auth);
      if (e.transport === 'stdio') { expect(e.command).toBeTruthy(); expect(Array.isArray(e.args)).toBe(true); }
      else { expect(e.baseUrl).toMatch(/^https?:\/\//); }
    }
  });

  it('uvx entries call out the uv dependency', () => {
    for (const e of MCP_CATALOG) {
      if (e.command === 'uvx') expect(e.securityNotes.toLowerCase()).toContain('uv');
    }
  });

  it('catalogEntryToRawConfig: stdio appends extra args; http carries transport:streamable', () => {
    const fs = catalogEntryToRawConfig(findCatalogEntry('filesystem')!, ['/some/dir']);
    expect(fs).toEqual({ type: 'stdio', stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/some/dir'] } });
    const gh = catalogEntryToRawConfig(findCatalogEntry('github')!);
    expect(gh).toEqual({ type: 'http', http: {
      baseUrl: 'https://api.githubcopilot.com/mcp/', transport: 'streamable',
      oauth: { clientId: '', deviceAuthorizationEndpoint: 'https://github.com/login/device/code', scopes: ['repo', 'read:org', 'read:user'] },
    } });
  });
});

describe('/mcp catalog — list (read-only)', () => {
  it('lists every curated server; no spawn', async () => {
    const client = fakeClient();
    const { ctx, display } = buildCtx(['catalog'], client);
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('MCP catalog');
    for (const e of MCP_CATALOG) expect(out).toContain(e.slug);
    expect(out).toContain('🔑 oauth'); // github marked
    expect(client.connect).not.toHaveBeenCalled();
  });
});

describe('/mcp catalog add — funnels the gate', () => {
  it('confirm=yes (stdio, no-auth): pre-fills command, gate shown, writes config, connects', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const client = fakeClient();
    const { ctx, display } = buildCtx(['catalog', 'add', 'memory'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('npx -y @modelcontextprotocol/server-memory');
    expect(out).toContain('NOW and on EVERY future boot');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cfg.getValue('mcp.servers').memory).toEqual({ type: 'stdio', stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Connected 'memory'/);
  });

  it('trailing args append (filesystem path)', async () => {
    const cfg = fakeConfig();
    const { ctx } = buildCtx(['catalog', 'add', 'filesystem', '/data'], fakeClient(), { config: cfg as never, confirm: vi.fn(async () => true) });
    await mcp.handler(ctx);
    expect(cfg.getValue('mcp.servers').filesystem.stdio.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/data']);
  });

  it('confirm=no → clean no-op (no write, no connect)', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => false);
    const client = fakeClient();
    const { ctx } = buildCtx(['catalog', 'add', 'memory'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cfg.getValue('mcp.servers')).toBeUndefined();
    expect(cfg.save).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('oauth entry (github): writes http+streamable config, hints /mcp auth, does NOT connect', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const client = fakeClient();
    const { ctx, display } = buildCtx(['install', 'github'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    const out = text(display);
    expect(cfg.getValue('mcp.servers').github).toEqual({ type: 'http', http: {
      baseUrl: 'https://api.githubcopilot.com/mcp/', transport: 'streamable',
      oauth: { clientId: '', deviceAuthorizationEndpoint: 'https://github.com/login/device/code', scopes: ['repo', 'read:org', 'read:user'] },
    } });
    expect(out).toContain('https://api.githubcopilot.com/mcp/');
    expect(out).toContain("Saved 'github'"); // written, not connected
    expect(out).toContain('/mcp auth github'); // hint to authorize
    expect(client.connect).not.toHaveBeenCalled(); // deferred to /mcp auth
  });

  it('unknown slug → error, no write', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['catalog', 'add', 'nope'], fakeClient(), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toContain("No catalog entry 'nope'");
    expect(confirm).not.toHaveBeenCalled();
  });

  it('collision → reject (no confirm, no write)', async () => {
    const cfg = fakeConfig({ memory: { type: 'stdio', stdio: { command: 'x', args: [] } } });
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['catalog', 'add', 'memory'], fakeClient(), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toContain('already configured');
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ── Fix 3 — --client-id persists with the entry (no env var required) ─────────
describe('extractClientIdFlag', () => {
  it('parses --client-id <id> and removes it from the rest', () => {
    expect(extractClientIdFlag(['--client-id', 'Ov23abc'])).toEqual({ clientId: 'Ov23abc', rest: [] });
  });
  it('parses --client-id=<id>', () => {
    expect(extractClientIdFlag(['--client-id=Ov23xyz', '/dir'])).toEqual({ clientId: 'Ov23xyz', rest: ['/dir'] });
  });
  it('no flag → undefined, args pass through', () => {
    expect(extractClientIdFlag(['/some/dir'])).toEqual({ clientId: undefined, rest: ['/some/dir'] });
  });
  it('blank value → undefined', () => {
    expect(extractClientIdFlag(['--client-id', '  '])).toEqual({ clientId: undefined, rest: [] });
  });
});

describe('/mcp catalog add github --client-id — persists the public client id', () => {
  it('stores --client-id into the server config oauth.clientId (safe to persist)', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const { ctx } = buildCtx(['catalog', 'add', 'github', '--client-id', 'Ov23-live-id'], fakeClient(), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    const stored = cfg.getValue('mcp.servers.github') as { http?: { oauth?: { clientId?: string } } };
    expect(stored?.http?.oauth?.clientId).toBe('Ov23-live-id'); // read back on every future boot
    expect(JSON.stringify(stored)).not.toMatch(/secret/i);       // no secret stored (device flow)
  });

  it('--client-id on a non-OAuth entry is ignored with a note (not stored)', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['catalog', 'add', 'memory', '--client-id', 'X'], fakeClient(), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toMatch(/--client-id ignored/);
    expect(JSON.stringify(cfg.getValue('mcp.servers.memory'))).not.toContain('X');
  });
});
