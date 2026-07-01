/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/mcpManage.ts — v4.12 Slice 1a
 *
 * `/mcp` slash command: read-only surfacing of the live MCP client.
 *
 * Distinct from `cli/v4/commands/mcp.ts`, which is the `aiden mcp` CLI
 * subcommand (serve / install Aiden *as* a server into Claude Desktop
 * etc.). THIS command is the in-REPL view of Aiden's OUTBOUND
 * connections to external MCP servers and the tools they expose to the
 * model — the consumer side proven live in v4.12 Slice 0.
 *
 * Read-only surfaces:
 *   /mcp               — list connected servers: name · status · #tools
 *   /mcp status [name] — detail; with a name, that server's per-tool
 *                        list; without, all servers + a tool-count summary
 *
 * Mutating subcommands (`/mcp add | remove | import | catalog | auth`) are
 * implemented below — they spawn subprocesses from config and are gated on
 * ctx.confirm.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import type { McpServer, McpServerConfig } from '../../../core/v4/mcpClient';
import { promises as fs } from 'node:fs';
import { mapStandardMcpServers } from '../../../tools/v4/mcpImport';
import { ensureMcpOAuthConfig } from '../../../core/v4/mcp/oauthDiscovery';
import {
  runLoopbackAuthFlow,
  loopbackRedirectUris,
  persistMcpTokens,
} from '../../../core/v4/mcp/oauthLoginFlow';
import type { OAuthUserAgent } from '../../../core/v4/auth/oauthFlow';
import { openOAuthBrowserUrl } from '../auth/loadProvider';
import {
  MCP_CATALOG,
  findCatalogEntry,
  catalogEntryToRawConfig,
  type CatalogAuth,
} from './mcpCatalog';

const STATUS_GLYPH: Record<McpServer['status'], string> = {
  ready:        '●',
  initializing: '◐',
  reconnecting: '↻',
  error:        '✗',
  failed:       '✗',
  closed:       '○',
  'needs-auth': '🔑',
};

function toolWord(n: number): string {
  return `${n} tool${n === 1 ? '' : 's'}`;
}

/**
 * v4.12 Slice 2b — circuit-breaker overlay. The server stays `ready`; this
 * surfaces an open/half-open breaker so a flapping tool isn't invisible.
 */
function breakerNote(server: McpServer): string {
  const b = server.breaker;
  if (!b || b.state === 'closed') return '';
  if (b.state === 'half-open') return ' (circuit half-open, probing)';
  const retryIn = Math.max(0, Math.ceil((b.openedAt + b.cooldownMs - Date.now()) / 1000));
  return ` (circuit open, retry in ${retryIn}s)`;
}

/** v4.12 Slice 3a.3 — actionable hint for a locked (needs-auth) server. */
function authHint(server: McpServer): string {
  return server.status === 'needs-auth' ? `  (run /mcp auth ${server.config.name})` : '';
}

function serverLine(server: McpServer): string {
  const note = breakerNote(server);
  const glyph = note ? '⚠' : (STATUS_GLYPH[server.status] ?? '·');
  return `  ${glyph} ${server.config.name}  —  ${server.status}  ·  ${toolWord(server.tools.length)}${note}${authHint(server)}\n`;
}

function emptyState(ctx: SlashCommandContext): void {
  ctx.display.info('No MCP servers connected.');
  ctx.display.dim(
    'Add one with `/mcp add <name> <command> [args...]`, browse presets with ' +
      '`/mcp catalog`, or declare servers in config.yaml under `mcp.servers`.',
  );
}

/** `/mcp` — one line per connected server. */
function renderList(ctx: SlashCommandContext, servers: McpServer[]): void {
  if (servers.length === 0) { emptyState(ctx); return; }
  ctx.display.info(`Connected MCP servers (${servers.length})`);
  for (const s of servers) {
    ctx.display.write(serverLine(s));
    if (s.status === 'error' && s.lastError) ctx.display.dim(`      ${s.lastError}`);
  }
  ctx.display.dim('Run `/mcp status <name>` to see a server’s tools.');
}

/** `/mcp status <name>` — one server's per-tool detail. */
function renderServerDetail(ctx: SlashCommandContext, server: McpServer): void {
  const note = breakerNote(server);
  const glyph = note ? '⚠' : (STATUS_GLYPH[server.status] ?? '·');
  ctx.display.info(`${glyph} ${server.config.name} — ${server.status} (${server.config.type})${note}`);
  if (server.status === 'needs-auth') ctx.display.dim(`  run /mcp auth ${server.config.name} to sign in`);
  if (server.lastError) ctx.display.dim(`  last error: ${server.lastError}`);
  if (server.tools.length === 0) { ctx.display.dim('  (no tools exposed)'); return; }
  ctx.display.dim(`  ${toolWord(server.tools.length)}:`);
  for (const t of server.tools) {
    ctx.display.write(`    ${t.prefixedName}\n`);
    if (t.description) {
      const oneLine = t.description.replace(/\s+/g, ' ').trim();
      ctx.display.dim(`        ${oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine}`);
    }
  }
}

/** `/mcp status` (no name) — all servers + total tool count. */
function renderStatusSummary(ctx: SlashCommandContext, servers: McpServer[]): void {
  if (servers.length === 0) { emptyState(ctx); return; }
  const totalTools = servers.reduce((acc, s) => acc + s.tools.length, 0);
  ctx.display.info(`${servers.length} MCP server(s), ${toolWord(totalTools)} total`);
  for (const s of servers) ctx.display.write(serverLine(s));
  ctx.display.dim('Run `/mcp status <name>` for a server’s tool list.');
}

// ── Mutations (Slice 1b) ───────────────────────────────────────────────────
//
// `/mcp add` and `/mcp remove` are the first slash surfaces that change
// persisted config AND spawn subprocesses. The security gate (ctx.confirm,
// default N) is mandatory: adding a server runs an arbitrary command now and
// on every future boot, so the exact command + that warning are shown before
// any write or spawn. A declined confirm is a clean no-op (no write, no spawn).

const NAME_RE = /^[A-Za-z0-9_]+$/;

/** Raw config shape stored under `mcp.servers.<name>` (name is the key). */
interface RawStdioEntry {
  type: 'stdio';
  stdio: { command: string; args: string[] };
}

function toolCountLabel(n: number): string {
  return `${n} tool${n === 1 ? '' : 's'}`;
}

/** Raw config union written under `mcp.servers.<name>`. */
type RawServerEntry =
  | RawStdioEntry
  | { type: 'http'; http: { baseUrl: string; transport: 'streamable' | 'sse' } };

/**
 * Shared add core (Slice 1b + Slice 4): collision check → security gate
 * (ctx.confirm, default N; message adapts to stdio/http/oauth) → write config →
 * connect. EXCEPTION: oauth entries write + hint `/mcp auth <name>` and do NOT
 * connect (no token yet; discovery+DCR+flow happen in /mcp auth). Both /mcp add
 * and /mcp catalog add funnel through here — the catalog never bypasses the gate.
 */
async function addServer(
  ctx: SlashCommandContext,
  name: string,
  rawEntry: RawServerEntry,
  opts: { authType?: CatalogAuth } = {},
): Promise<void> {
  const { display } = ctx;
  if (!ctx.mcpClient) { display.warn('MCP client is not available in this session.'); return; }
  if (!ctx.config)    { display.printError('Cannot persist — config is not available in this context.'); return; }
  if (!ctx.confirm)   { display.printError('Cannot confirm in this context — aborting for safety.'); return; }

  if (!NAME_RE.test(name)) {
    display.printError(`Invalid server name '${name}'.`, 'Use letters, digits, and underscores only.');
    return;
  }

  // Collision: reject (don't overwrite) if already configured or connected.
  const existing = ctx.config.getValue<Record<string, unknown>>('mcp.servers') ?? {};
  if (Object.prototype.hasOwnProperty.call(existing, name) || ctx.mcpClient.get(name)) {
    display.printError(
      `An MCP server named '${name}' is already configured.`,
      `Use a different name, or run /mcp remove ${name} first.`,
    );
    return;
  }

  const isOauth = opts.authType === 'oauth';

  // ── Security gate ── show exactly what will run/connect, then y/N (default N).
  if (rawEntry.type === 'stdio') {
    const cmdLine = [rawEntry.stdio.command, ...rawEntry.stdio.args].join(' ');
    display.warn(`Add MCP server '${name}' — this will run the command:`);
    display.write('\n');
    display.write(`      ${cmdLine}\n`);
    display.write('\n');
    display.warn('Aiden will spawn this subprocess NOW and on EVERY future boot.');
    display.dim('It runs with your user permissions. Only add servers you trust.');
  } else {
    display.warn(`Add MCP server '${name}' — this will connect to:`);
    display.write('\n');
    display.write(`      ${rawEntry.http.baseUrl}\n`);
    display.write('\n');
    display.warn(
      isOauth
        ? 'Aiden will authorize via your browser, then connect with the stored token on EVERY future boot.'
        : 'Aiden will send MCP requests to this URL NOW and on EVERY future boot.',
    );
    display.dim('It can access whatever the server exposes. Only add servers you trust.');
  }

  const proceed = await ctx.confirm(`Add '${name}'${isOauth ? '' : ' and run it now'} (and on every boot)?`);
  if (!proceed) return; // declined → clean no-op: no config write, no spawn

  // confirm → write config. No rollback on connect failure: the config is the
  // user's intent and boot retries it; connect() self-cleans on failure.
  ctx.config.set(`mcp.servers.${name}`, rawEntry);
  await ctx.config.save();

  // OAuth: defer the connect to the explicit /mcp auth (no token yet).
  if (isOauth) {
    display.success(`Saved '${name}'. Run /mcp auth ${name} to authorize and connect.`);
    return;
  }

  try {
    const cfg: McpServerConfig = { name, ...rawEntry };
    const server = await ctx.mcpClient.connect(cfg);
    display.success(`Connected '${name}' — ${toolCountLabel(server.tools.length)} registered. Run /mcp to view.`);
  } catch (err) {
    const msg = (err as Error).message;
    display.printError(
      `Saved '${name}' to config, but it failed to start: ${msg}`,
      `Aiden will try again on next boot. If the command is wrong, run /mcp remove ${name}.`,
    );
  }
}

/** `/mcp add <name> <command> [args...]` — parse args → shared add core. */
async function handleAdd(ctx: SlashCommandContext): Promise<void> {
  const { display } = ctx;
  const name = ctx.args[1];
  const command = ctx.args[2];
  const cmdArgs = ctx.args.slice(3);

  if (!name || !command) {
    display.printError(
      'Usage: /mcp add <name> <command> [args...]',
      'e.g. /mcp add fs npx -y @modelcontextprotocol/server-filesystem /path',
    );
    return;
  }
  await addServer(ctx, name, { type: 'stdio', stdio: { command, args: cmdArgs } });
}

// ── Catalog (Slice 4) ───────────────────────────────────────────────────────

/** `/mcp catalog` — list curated servers (read-only, no spawn). */
function handleCatalog(ctx: SlashCommandContext): void {
  const { display } = ctx;
  display.info(`MCP catalog — ${MCP_CATALOG.length} curated servers`);
  for (const e of MCP_CATALOG) {
    const auth = e.auth === 'oauth' ? ' · 🔑 oauth' : '';
    display.write(`  ${e.slug}  —  ${e.name}  (${e.transport}${auth})\n`);
    display.dim(`      ${e.description}`);
  }
  display.dim('Add one with `/mcp catalog add <slug>` (or `/mcp install <slug>`). Same confirm gate as /mcp add.');
}

/** `/mcp catalog add <slug> [args]` / `/mcp install <slug> [args]` — pre-fill → shared gate. */
async function handleCatalogAdd(ctx: SlashCommandContext, slug: string, extraArgs: string[]): Promise<void> {
  const { display } = ctx;
  if (!slug) {
    display.printError('Usage: /mcp catalog add <slug> [args]', 'Run /mcp catalog to see slugs.');
    return;
  }
  const entry = findCatalogEntry(slug);
  if (!entry) {
    display.printError(`No catalog entry '${slug}'.`, 'Run /mcp catalog to see available servers.');
    return;
  }
  // Surface the entry's security notes before the gate.
  if (entry.securityNotes) display.dim(entry.securityNotes);
  await addServer(ctx, entry.slug, catalogEntryToRawConfig(entry, extraArgs), { authType: entry.auth });
}

/** `/mcp remove <name>` — light confirm → disconnect live → prune config. */
async function handleRemove(ctx: SlashCommandContext): Promise<void> {
  const { display } = ctx;
  if (!ctx.config)  { display.printError('Cannot persist — config is not available in this context.'); return; }
  if (!ctx.confirm) { display.printError('Cannot confirm in this context — aborting for safety.'); return; }

  const name = ctx.args[1];
  if (!name) { display.printError('Usage: /mcp remove <name>.'); return; }

  const configured = ctx.config.getValue<Record<string, unknown>>('mcp.servers') ?? {};
  const inConfig = Object.prototype.hasOwnProperty.call(configured, name);
  const live = ctx.mcpClient?.get(name);
  if (!inConfig && !live) {
    display.printError(
      `No MCP server named '${name}' is configured or connected.`,
      'Run /mcp to see connected servers.',
    );
    return;
  }

  const proceed = await ctx.confirm(`Remove MCP server '${name}' from config?`);
  if (!proceed) return; // declined → clean no-op

  // Stop the live server first (kills the subprocess + unregisters its tools).
  if (ctx.mcpClient?.get(name)) {
    await ctx.mcpClient.disconnect(name);
  }
  // Prune from config (no delete API → re-set the pruned servers object).
  const pruned: Record<string, unknown> = { ...configured };
  delete pruned[name];
  ctx.config.set('mcp.servers', pruned);
  await ctx.config.save();

  display.success(`Removed '${name}'.`);
}

/** `/mcp import <path>` — map a standard mcpServers JSON file, batch-confirm, import. */
async function handleImport(ctx: SlashCommandContext): Promise<void> {
  const { display } = ctx;
  if (!ctx.mcpClient) { display.warn('MCP client is not available in this session.'); return; }
  if (!ctx.config)    { display.printError('Cannot persist — config is not available in this context.'); return; }
  if (!ctx.confirm)   { display.printError('Cannot confirm in this context — aborting for safety.'); return; }

  const filePath = ctx.args[1];
  if (!filePath) {
    display.printError('Usage: /mcp import <path-to-json>', 'Point at a Claude-Desktop/Cursor mcp config file.');
    return;
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, 'utf8');
  } catch {
    display.printError(`Cannot read file '${filePath}'.`, 'Check the path and try again.');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    display.printError(`'${filePath}' is not valid JSON.`);
    return;
  }

  const mapped = mapStandardMcpServers(parsed);
  if (!mapped.hadMcpServersKey) {
    display.printError(
      `No "mcpServers" object found in '${filePath}'.`,
      'Expected the Claude-Desktop/Cursor format: { "mcpServers": { … } }.',
    );
    return;
  }

  // Collision: skip names already configured or connected (don't overwrite — matches /mcp add).
  const existing = ctx.config.getValue<Record<string, unknown>>('mcp.servers') ?? {};
  const toAdd: typeof mapped.servers = [];
  const collisions: string[] = [];
  for (const s of mapped.servers) {
    if (Object.prototype.hasOwnProperty.call(existing, s.name) || ctx.mcpClient.get(s.name)) {
      collisions.push(s.name);
    } else {
      toAdd.push(s);
    }
  }

  // Report what won't be imported up front.
  for (const sk of mapped.skipped) display.dim(`  skip ${sk.name}: ${sk.reason}`);
  for (const c of collisions) display.dim(`  skip ${c}: already configured`);

  if (toAdd.length === 0) {
    display.info('Nothing to import — all entries were skipped or already configured.');
    return;
  }

  // ── Security gate ── every command line + NOW/EVERY-BOOT warning, one y/N (default N).
  display.warn(`Import ${toAdd.length} MCP server(s) — these will run:`);
  display.write('\n');
  for (const s of toAdd) display.write(`      ${s.name}:  ${s.cmdLine}\n`);
  display.write('\n');
  display.warn('Aiden will spawn these subprocesses NOW and on EVERY future boot.');
  display.dim('They run with your user permissions. Only import servers you trust.');

  const proceed = await ctx.confirm(`Import ${toAdd.length} MCP server(s) and run them now (and on every boot)?`);
  if (!proceed) return; // declined → clean no-op: nothing written, nothing spawned

  // Write all at once, then connect each live (a bad server doesn't abort the rest).
  for (const s of toAdd) ctx.config.set(`mcp.servers.${s.name}`, s.entry);
  await ctx.config.save();

  let connected = 0;
  for (const s of toAdd) {
    try {
      const cfg: McpServerConfig = { name: s.name, ...s.entry };
      const server = await ctx.mcpClient.connect(cfg);
      display.success(`Connected '${s.name}' — ${toolCountLabel(server.tools.length)}.`);
      connected += 1;
    } catch (err) {
      display.printError(
        `Saved '${s.name}' to config, but it failed to start: ${(err as Error).message}`,
        `Aiden will try again on next boot. If the command is wrong, run /mcp remove ${s.name}.`,
      );
    }
  }

  const skippedCount = mapped.skipped.length + collisions.length;
  display.info(`Imported ${toAdd.length}, connected ${connected}, skipped ${skippedCount}.`);
}

/** OAuthUserAgent for /mcp auth — mirrors /auth's, but no prompt (loopback captures the code). */
function buildMcpUserAgent(ctx: SlashCommandContext): OAuthUserAgent {
  return {
    log: (line: string) => ctx.display.write(line + '\n'),
    openBrowser: openOAuthBrowserUrl,
    async prompt() {
      throw new Error('MCP OAuth uses a loopback callback — no manual paste needed.');
    },
    async sleep(ms: number) {
      return new Promise<void>((r) => setTimeout(r, ms));
    },
  };
}

/**
 * `/mcp auth <server>` — explicit, never-inline OAuth for a hosted (http) server.
 * Discovery + DCR (cached) → loopback authorization-code+PKCE flow → persist.
 */
async function handleAuth(ctx: SlashCommandContext): Promise<void> {
  const { display } = ctx;
  const name = ctx.args[1];
  if (!name) {
    display.printError('Usage: /mcp auth <server>', 'OAuth applies to hosted (http) MCP servers.');
    return;
  }
  if (!ctx.paths)  { display.printError('Cannot store tokens — user paths are not available yet.'); return; }
  if (!ctx.config) { display.printError('Cannot read server config — config is not available.');   return; }

  const mcpCfg = ctx.config.getValue<{
    servers?: Record<string, { type?: string; http?: { baseUrl?: string } }>;
  }>('mcp');
  const entry = mcpCfg?.servers?.[name];
  if (!entry) {
    display.printError(`No MCP server named '${name}' in config.`, 'Run `/mcp` to see configured servers.');
    return;
  }
  if (entry.type !== 'http' || !entry.http?.baseUrl) {
    display.printError(`'${name}' is not an HTTP server — OAuth applies to hosted (http) servers only.`);
    return;
  }

  const serverUrl = entry.http.baseUrl;
  try {
    const config = await ensureMcpOAuthConfig(ctx.paths, name, serverUrl, {
      fetchFn: fetch,
      redirectUris: loopbackRedirectUris(),
    });
    const result = await runLoopbackAuthFlow({ config, server: name, ua: buildMcpUserAgent(ctx) });
    await persistMcpTokens(ctx.paths, name, result);

    // Handoff: token persisted → (re)connect so the tools register immediately.
    if (ctx.mcpClient && ctx.mcpClient.get(name)) {
      try {
        const server = await ctx.mcpClient.authorizeAndConnect(name);
        display.info(`✅ Authorized '${name}' — ${server.tools.length} tools now available.`);
      } catch (connErr) {
        display.warn(`Authorized '${name}', but connecting failed: ${(connErr as Error).message}`);
      }
    } else {
      display.info(`✅ Authorized '${name}'. Token stored — restart Aiden to connect the server.`);
    }
  } catch (err) {
    display.printError(`OAuth for '${name}' failed: ${(err as Error).message}`);
  }
}

export const mcp: SlashCommand = {
  name: 'mcp',
  description: 'List connected MCP servers and their tools (read-only).',
  category: 'system',
  icon: '🔌', // 🔌
  handler: async (ctx: SlashCommandContext) => {
    if (!ctx.mcpClient) {
      ctx.display.warn('MCP client is not available in this session.');
      return {};
    }

    const sub = (ctx.args[0] ?? '').toLowerCase();
    const servers = ctx.mcpClient.list();

    if (sub === 'status') {
      const name = ctx.args[1];
      if (name) {
        const server = ctx.mcpClient.get(name);
        if (!server) {
          ctx.display.printError(
            `No connected MCP server named '${name}'.`,
            'Run `/mcp` to see connected servers.',
          );
          return {};
        }
        renderServerDetail(ctx, server);
      } else {
        renderStatusSummary(ctx, servers);
      }
      return {};
    }

    // Slice 1b — mutating subcommands (config write + subprocess spawn).
    if (sub === 'add')    { await handleAdd(ctx);    return {}; }
    if (sub === 'remove') { await handleRemove(ctx); return {}; }

    // Slice 1c — import a standard mcpServers JSON file.
    if (sub === 'import') { await handleImport(ctx); return {}; }

    // Slice 3a.2 — explicit OAuth for a hosted (http) server.
    if (sub === 'auth')   { await handleAuth(ctx);   return {}; }

    // Slice 4 — curated catalog (display + pre-fill, funnels the /mcp add gate).
    if (sub === 'catalog') {
      if ((ctx.args[1] ?? '').toLowerCase() === 'add') {
        await handleCatalogAdd(ctx, ctx.args[2] ?? '', ctx.args.slice(3));
      } else {
        handleCatalog(ctx);
      }
      return {};
    }
    if (sub === 'install') { await handleCatalogAdd(ctx, ctx.args[1] ?? '', ctx.args.slice(2)); return {}; }

    if (sub && sub !== 'list') {
      ctx.display.printError(`Unknown subcommand '${sub}'.`, 'Try `/mcp` or `/mcp status [name]`.');
      return {};
    }

    renderList(ctx, servers);
    return {};
  },
};
