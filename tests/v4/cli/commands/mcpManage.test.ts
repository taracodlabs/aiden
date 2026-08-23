/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 1a + 1b — /mcp surfacing.
 *
 * 1a: read-only views (list / status / empty-state) + the config-schema
 *     change (mcp is a known top-level key → no boot warning, still read).
 * 1b: mutating subcommands /mcp add + /mcp remove — the security gate
 *     (ctx.confirm, default N), confirm→write→connect with no rollback on
 *     connect failure, light confirm on remove, declined = clean no-op.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { mcp } from '../../../../cli/v4/commands/mcpManage';
import { CommandRegistry, type SlashCommandContext } from '../../../../cli/v4/commandRegistry';
import { ConfigManager } from '../../../../core/v4/config';
import { resolveAidenPaths } from '../../../../core/v4/paths';
import { hasTokens, saveTokens } from '../../../../core/v4/auth/tokenStore';
import { mcpTokenId } from '../../../../core/v4/mcp/oauthDiscovery';

// ── Fakes ────────────────────────────────────────────────────────────────

function fakeServer(
  name: string,
  status: string,
  toolNames: string[],
  breaker?: { state: string; failures: number; openedAt: number; cooldownMs: number },
) {
  return {
    config: { name, type: 'stdio' },
    transport: {} as never,
    capabilities: {},
    status,
    lastError: status === 'error' ? 'spawn failed: ENOENT' : undefined,
    breaker: breaker ?? { state: 'closed', failures: 0, openedAt: 0, cooldownMs: 60000 },
    tools: toolNames.map((t) => ({
      serverName: name,
      prefixedName: `mcp_${name}_${t}`,
      rawName: t,
      description: `Tool ${t} description.`,
      inputSchema: { type: 'object' as const, properties: {} },
    })),
  };
}

interface ClientOpts {
  connect?: ReturnType<typeof vi.fn>;
  disconnect?: ReturnType<typeof vi.fn>;
  revoke?: ReturnType<typeof vi.fn>;
}

function fakeClient(servers: ReturnType<typeof fakeServer>[], opts: ClientOpts = {}) {
  const connect =
    opts.connect ??
    vi.fn(async (cfg: { name: string }) => {
      const s = fakeServer(cfg.name, 'ready', ['t1', 't2']);
      servers.push(s);
      return s;
    });
  const disconnect =
    opts.disconnect ??
    vi.fn(async (n: string) => {
      const i = servers.findIndex((s) => s.config.name === n);
      if (i >= 0) servers.splice(i, 1);
    });
  return {
    list: () => servers,
    get: (n: string) => servers.find((s) => s.config.name === n),
    connect,
    disconnect,
    revoke: opts.revoke ?? vi.fn(async (n: string) => {
      await disconnect(n);
      return { trustState: 'revoked' };
    }),
  };
}

/** Minimal in-memory ConfigManager stand-in (getValue/set/save with dotted keys). */
function fakeConfig(servers: Record<string, unknown> = {}) {
  const store: any = Object.keys(servers).length ? { mcp: { servers: { ...servers } } } : {};
  const save = vi.fn(async () => {});
  return {
    store,
    save,
    getValue: (key: string) => {
      let cur: any = store;
      for (const p of key.split('.')) { if (cur == null) return undefined; cur = cur[p]; }
      return cur;
    },
    set: (key: string, val: unknown) => {
      const parts = key.split('.');
      let cur: any = store;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = val;
    },
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
  o.line = () => o.out.push('---');
  return o;
}

function buildCtx(
  args: string[],
  client: unknown,
  extra: Partial<SlashCommandContext> = {},
  display = captured(),
): { ctx: SlashCommandContext; display: any } {
  const ctx = {
    args,
    rawArgs: args.join(' '),
    display: display as never,
    registry: new CommandRegistry(),
    mcpClient: client as never,
    ...extra,
  } as SlashCommandContext;
  return { ctx, display };
}

const text = (d: any) => d.out.join('\n');

// ── 1a: /mcp list ───────────────────────────────────────────────────────────

describe('/mcp — list', () => {
  it('lists each connected server with status + tool count', async () => {
    const client = fakeClient([
      fakeServer('fs', 'ready', ['list_directory', 'read_file', 'write_file']),
      fakeServer('db', 'error', []),
    ]);
    const { ctx, display } = buildCtx([], client);
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('Connected MCP servers (2)');
    expect(out).toMatch(/fs.*ready.*3 tools/);
    expect(out).toMatch(/db.*error.*0 tools/);
    expect(out).toContain('spawn failed: ENOENT');
  });

  it('singular "1 tool" for a one-tool server', async () => {
    const { ctx, display } = buildCtx([], fakeClient([fakeServer('solo', 'ready', ['only'])]));
    await mcp.handler(ctx);
    expect(text(display)).toMatch(/solo.*1 tool\b/);
    expect(text(display)).not.toMatch(/1 tools/);
  });

  it('empty-state when no servers are connected', async () => {
    const { ctx, display } = buildCtx([], fakeClient([]));
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('No MCP servers connected');
    expect(out).toContain('mcp.servers');
  });

  it('warns when no mcpClient is wired into the session', async () => {
    const { ctx, display } = buildCtx([], undefined);
    await mcp.handler(ctx);
    expect(text(display)).toContain('warn:MCP client is not available');
  });
});

// ── 1a: /mcp status ──────────────────────────────────────────────────────────

describe('/mcp status', () => {
  it('status <name> shows that server\'s per-tool list (prefixed names)', async () => {
    const client = fakeClient([fakeServer('fs', 'ready', ['list_directory', 'read_file'])]);
    const { ctx, display } = buildCtx(['status', 'fs'], client);
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('fs — ready (stdio)');
    expect(out).toContain('mcp_fs_list_directory');
    expect(out).toContain('mcp_fs_read_file');
    expect(out).toContain('Tool list_directory description.');
  });

  it('status <name> exposes protocol, endpoint, trust and capability-review truth', async () => {
    const server = fakeServer('repo', 'ready', ['read_file', 'write_file']) as ReturnType<typeof fakeServer> & Record<string, unknown>;
    server.config = { name: 'repo', type: 'http', http: { baseUrl: 'https://mcp.example.test/service', transport: 'streamable' } };
    server.protocolVersion = '2025-11-25';
    server.externalTrustState = 'verified_endpoint';
    server.capabilityChangeClass = 'mutation';
    server.capabilityReviewRequired = true;
    server.mutationBlocked = true;
    server.capabilities = { resources: { listChanged: true } };
    const { ctx, display } = buildCtx(['status', 'repo'], fakeClient([server]));

    await mcp.handler(ctx);

    const out = text(display);
    expect(out).toContain('https://mcp.example.test/service');
    expect(out).toContain('streamable');
    expect(out).toContain('2025-11-25');
    expect(out).toContain('verified_endpoint');
    expect(out).toMatch(/capabilit.*mutation.*review/i);
    expect(out).toMatch(/mutation.*blocked/i);
    expect(out).toMatch(/resources.*available/i);
  });

  it('status with no name shows all servers + total tool count', async () => {
    const client = fakeClient([
      fakeServer('fs', 'ready', ['a', 'b']),
      fakeServer('git', 'ready', ['c']),
    ]);
    const { ctx, display } = buildCtx(['status'], client);
    await mcp.handler(ctx);
    expect(text(display)).toContain('2 MCP server(s), 3 tools total');
  });

  it('status <unknown> errors with a helpful hint', async () => {
    const { ctx, display } = buildCtx(['status', 'nope'], fakeClient([fakeServer('fs', 'ready', ['a'])]));
    await mcp.handler(ctx);
    expect(text(display)).toContain("err:No connected MCP server named 'nope'");
  });
});

// ── 1b: /mcp add ─────────────────────────────────────────────────────────────

describe('/mcp add', () => {
  it('confirm=yes → shows command + warning, writes config, connects', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const client = fakeClient([]);
    const { ctx, display } = buildCtx(
      ['add', 'fs', 'npx', '-y', '@mcp/fs', '/p'], client, { config: cfg as never, confirm },
    );
    await mcp.handler(ctx);
    const out = text(display);
    // Security gate: exact command line + the NOW/EVERY-BOOT warning, shown before confirm.
    expect(out).toContain('npx -y @mcp/fs /p');
    expect(out).toContain('NOW and on EVERY future boot');
    expect(out).toContain('Only add servers you trust');
    expect(confirm).toHaveBeenCalledTimes(1);
    // Config written + saved.
    expect(cfg.getValue('mcp.servers').fs).toEqual({
      type: 'stdio',
      stdio: { command: 'npx', args: ['-y', '@mcp/fs', '/p'] },
    });
    expect(cfg.save).toHaveBeenCalledTimes(1);
    // Live connect happened.
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Connected 'fs'/);
  });

  it('confirm=no → clean no-op: no config write, no save, no connect', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => false);
    const client = fakeClient([], { connect: vi.fn() });
    const { ctx } = buildCtx(['add', 'fs', 'npx'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cfg.getValue('mcp.servers')).toBeUndefined();
    expect(cfg.save).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('collision → reject (no confirm, no write) when name already configured', async () => {
    const cfg = fakeConfig({ fs: { type: 'stdio', stdio: { command: 'x', args: [] } } });
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['add', 'fs', 'npx'], fakeClient([]), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toContain("already configured");
    expect(confirm).not.toHaveBeenCalled();
    expect(cfg.save).not.toHaveBeenCalled();
  });

  it('connect failure → config kept + saved, reports failure with remove hint', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const client = fakeClient([], { connect: vi.fn(async () => { throw new Error('spawn ENOENT'); }) });
    const { ctx, display } = buildCtx(['add', 'bad', 'nope-cmd'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    const out = text(display);
    expect(cfg.getValue('mcp.servers').bad).toBeDefined(); // NOT rolled back
    expect(cfg.save).toHaveBeenCalledTimes(1);
    expect(out).toContain('failed to start: spawn ENOENT');
    expect(out).toContain('/mcp remove bad');
  });

  it('missing args → usage error (no confirm, no write)', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['add'], fakeClient([]), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toContain('Usage: /mcp add');
    expect(confirm).not.toHaveBeenCalled();
    expect(cfg.save).not.toHaveBeenCalled();
  });
});

// ── 1b: /mcp remove ──────────────────────────────────────────────────────────

describe('/mcp remove', () => {
  it('confirm=yes → disconnects live server, prunes config, saves', async () => {
    const client = fakeClient([fakeServer('fs', 'ready', ['a', 'b'])]);
    const cfg = fakeConfig({ fs: { type: 'stdio', stdio: { command: 'x', args: [] } } });
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['remove', 'fs'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledWith('fs');
    expect(cfg.getValue('mcp.servers').fs).toBeUndefined();
    expect(cfg.save).toHaveBeenCalledTimes(1);
    expect(text(display)).toMatch(/Removed 'fs'/);
  });

  it('confirm=no → clean no-op: no disconnect, no save', async () => {
    const client = fakeClient([fakeServer('fs', 'ready', ['a'])]);
    const cfg = fakeConfig({ fs: { type: 'stdio', stdio: { command: 'x', args: [] } } });
    const confirm = vi.fn(async () => false);
    const { ctx } = buildCtx(['remove', 'fs'], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(cfg.save).not.toHaveBeenCalled();
  });

  it('not configured + not connected → friendly error (no confirm)', async () => {
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['remove', 'ghost'], fakeClient([]), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toContain("No MCP server named 'ghost'");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('/mcp revoke', () => {
  it('revokes durable trust and clears only the exact server credential', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-revoke-'));
    process.env.AIDEN_TOKEN_KEY = 'mcp-revoke-test';
    try {
      const paths = resolveAidenPaths({ rootOverride: root });
      await saveTokens(paths, {
        provider: mcpTokenId('repo'), accessToken: 'TOKEN', refreshToken: null,
        expiresAtMs: Date.now() + 60_000,
      });
      const revoke = vi.fn(async () => ({ trustState: 'revoked' }));
      const client = fakeClient([fakeServer('repo', 'ready', ['read'])], { revoke });
      const confirm = vi.fn(async () => true);
      const { ctx, display } = buildCtx(['revoke', 'repo'], client, { paths, confirm });

      await mcp.handler(ctx);

      expect(revoke).toHaveBeenCalledWith('repo');
      expect(await hasTokens(paths, mcpTokenId('repo'))).toBe(false);
      expect(text(display)).toMatch(/Revoked 'repo'/);
    } finally {
      delete process.env.AIDEN_TOKEN_KEY;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ── 1c: /mcp import ──────────────────────────────────────────────────────────

describe('/mcp import', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-imp-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  async function writeJson(obj: unknown): Promise<string> {
    const p = path.join(tmp, 'mcp.json');
    await fs.writeFile(p, JSON.stringify(obj), 'utf8');
    return p;
  }

  it('confirm=yes → shows commands, writes all, connects each, summary', async () => {
    const p = await writeJson({ mcpServers: {
      fs: { command: 'npx', args: ['-y', '@x/fs', '/p'] },
      git: { command: 'uvx', args: ['mcp-server-git'] },
    } });
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const client = fakeClient([]);
    const { ctx, display } = buildCtx(['import', p], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('npx -y @x/fs /p');
    expect(out).toContain('NOW and on EVERY future boot');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cfg.getValue('mcp.servers').fs).toBeDefined();
    expect(cfg.getValue('mcp.servers').git).toBeDefined();
    expect(cfg.save).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(out).toContain('Imported 2, connected 2, skipped 0');
  });

  it('collision → skips already-configured, imports the rest', async () => {
    const p = await writeJson({ mcpServers: { fs: { command: 'npx' }, newone: { command: 'uvx' } } });
    const cfg = fakeConfig({ fs: { type: 'stdio', stdio: { command: 'x', args: [] } } });
    const confirm = vi.fn(async () => true);
    const client = fakeClient([]);
    const { ctx, display } = buildCtx(['import', p], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('skip fs: already configured');
    expect(out).toContain('Imported 1, connected 1, skipped 1');
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('declined → clean no-op (no write, no connect)', async () => {
    const p = await writeJson({ mcpServers: { fs: { command: 'npx' } } });
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => false);
    const client = fakeClient([], { connect: vi.fn() });
    const { ctx } = buildCtx(['import', p], client, { config: cfg as never, confirm });
    await mcp.handler(ctx);
    expect(cfg.getValue('mcp.servers')).toBeUndefined();
    expect(cfg.save).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('partial failure → bad server kept + reported, others still connect', async () => {
    const p = await writeJson({ mcpServers: { good: { command: 'npx' }, bad: { command: 'nope' } } });
    const cfg = fakeConfig();
    const confirm = vi.fn(async () => true);
    const connect = vi.fn(async (c: { name: string }) => {
      if (c.name === 'bad') throw new Error('spawn ENOENT');
      return fakeServer(c.name, 'ready', ['t']);
    });
    const { ctx, display } = buildCtx(['import', p], fakeClient([], { connect }), { config: cfg as never, confirm });
    await mcp.handler(ctx);
    const out = text(display);
    expect(cfg.getValue('mcp.servers').good).toBeDefined();
    expect(cfg.getValue('mcp.servers').bad).toBeDefined(); // kept despite connect failure
    expect(out).toContain('failed to start: spawn ENOENT');
    expect(out).toContain('/mcp remove bad');
    expect(out).toContain('Imported 2, connected 1, skipped 0');
  });

  it('missing file → friendly error, no confirm', async () => {
    const confirm = vi.fn(async () => true);
    const { ctx, display } = buildCtx(['import', path.join(tmp, 'nope.json')], fakeClient([]), { config: fakeConfig() as never, confirm });
    await mcp.handler(ctx);
    expect(text(display)).toContain('Cannot read file');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('not JSON → friendly error', async () => {
    const p = path.join(tmp, 'bad.json');
    await fs.writeFile(p, 'not json{', 'utf8');
    const { ctx, display } = buildCtx(['import', p], fakeClient([]), { config: fakeConfig() as never, confirm: vi.fn(async () => true) });
    await mcp.handler(ctx);
    expect(text(display)).toContain('is not valid JSON');
  });

  it('no mcpServers key → friendly error', async () => {
    const p = await writeJson({ foo: 1 });
    const { ctx, display } = buildCtx(['import', p], fakeClient([]), { config: fakeConfig() as never, confirm: vi.fn(async () => true) });
    await mcp.handler(ctx);
    expect(text(display)).toContain('No "mcpServers" object found');
  });
});

// ── unknown subcommand ───────────────────────────────────────────────────────

describe('/mcp — unknown subcommand', () => {
  it('unknown subcommand errors', async () => {
    const { ctx, display } = buildCtx(['wat'], fakeClient([]));
    await mcp.handler(ctx);
    expect(text(display)).toContain("err:Unknown subcommand 'wat'");
  });
});

// ── 2b: /mcp status breaker annotation ───────────────────────────────────────

describe('/mcp — circuit-breaker annotation (Slice 2b)', () => {
  it('open breaker → ⚠ + "circuit open, retry in Ns", server still ready', async () => {
    const open = { state: 'open', failures: 3, openedAt: Date.now(), cooldownMs: 60000 };
    const { ctx, display } = buildCtx([], fakeClient([fakeServer('fs', 'ready', ['a'], open)]));
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).toContain('⚠');
    expect(out).toMatch(/circuit open, retry in \d+s/);
    expect(out).toContain('ready'); // server is still ready, breaker is an overlay
  });

  it('half-open breaker → "circuit half-open, probing"', async () => {
    const half = { state: 'half-open', failures: 3, openedAt: Date.now(), cooldownMs: 60000 };
    const { ctx, display } = buildCtx([], fakeClient([fakeServer('fs', 'ready', ['a'], half)]));
    await mcp.handler(ctx);
    expect(text(display)).toMatch(/circuit half-open, probing/);
  });

  it('closed breaker → no annotation (normal ● line)', async () => {
    const { ctx, display } = buildCtx([], fakeClient([fakeServer('fs', 'ready', ['a'])]));
    await mcp.handler(ctx);
    const out = text(display);
    expect(out).not.toMatch(/circuit/);
    expect(out).toContain('●');
  });
});

// ── 1a: config schema — mcp is a known top-level key ─────────────────────────

describe('config schema — mcp is a known top-level key', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-cfg-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('loading config.yaml with an mcp block does NOT warn, and mcp is readable', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    await fs.writeFile(
      paths.configYaml,
      [
        'model:',
        '  provider: groq',
        'mcp:',
        '  servers:',
        '    fs:',
        '      type: stdio',
        '      stdio:',
        '        command: npx',
        '        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/x"]',
        '',
      ].join('\n'),
      'utf8',
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = new ConfigManager(paths);
    await config.load();

    const mcpWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /Unknown top-level key 'mcp'/.test(m));
    expect(mcpWarnings).toEqual([]);
    warnSpy.mockRestore();

    const mcpCfg = config.getValue<{ servers?: Record<string, unknown> }>('mcp');
    expect(Object.keys(mcpCfg?.servers ?? {})).toEqual(['fs']);
  });
});
