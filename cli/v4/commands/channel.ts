/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/channel.ts — Phase v4.1-1.1
 *
 * `/channel` — manage channel adapters from inside the REPL.
 *
 * Subcommands (Phase 1.1 — Telegram only; the other 8 land iteratively):
 *
 *   /channel list                — table of all 9 channel slots + state
 *   /channel telegram add        — paste token, validate via getMe,
 *                                  write .env atomically, restart adapter
 *   /channel telegram remove     — confirm, stop polling, strip token
 *                                  from .env
 *   /channel telegram status     — bot username, polling state,
 *                                  last-message wall-clock, error count
 *
 * The CLI now hosts a `ChannelManager` directly (Phase v4.1-1.1 boot
 * change in aidenCLI.ts), so this command operates on a live manager
 * — no HTTP round-trip to a separate API server.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';
import { TelegramAdapter } from '../../../core/channels/telegram';
import { DiscordAdapter } from '../../../core/channels/discord';
import type { ChannelAdapter } from '../../../core/channels/adapter';
import { renderTable } from '../table';

// ── Channel registry — drives /channel list -----------------------
//
// Static metadata for the nine adapters. Mirrors `core/channels/*` so
// users see "not configured" slots even when no adapter is registered
// in their session (e.g. a user who ran the CLI in a deeply restricted
// shell where some adapters declined to instantiate).
interface ChannelDescriptor {
  id:        string;
  envVars:   readonly string[];
  shortHelp: string;
}

const CHANNEL_DESCRIPTORS: readonly ChannelDescriptor[] = [
  { id: 'telegram', envVars: ['TELEGRAM_BOT_TOKEN'],
    shortHelp: 'Bot via @BotFather' },
  { id: 'discord',  envVars: ['DISCORD_BOT_TOKEN'],
    shortHelp: 'Bot via Discord developer portal' },
  { id: 'slack',    envVars: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    shortHelp: 'Slack app + Socket Mode token' },
  { id: 'whatsapp', envVars: ['WHATSAPP_BUSINESS_API_KEY'],
    shortHelp: 'WhatsApp Business Cloud API' },
  { id: 'email',    envVars: ['EMAIL_IMAP_PASSWORD', 'EMAIL_SMTP_PASSWORD'],
    shortHelp: 'IMAP+SMTP credentials' },
  { id: 'webhook',  envVars: [],
    shortHelp: 'HTTP POST endpoint (always-on when API server runs)' },
  { id: 'twilio',   envVars: ['TWILIO_AUTH_TOKEN'],
    shortHelp: 'Twilio SMS' },
  { id: 'imessage', envVars: ['BLUEBUBBLES_PASSWORD'],
    shortHelp: 'BlueBubbles bridge (macOS)' },
  { id: 'signal',   envVars: [],
    shortHelp: 'signal-cli bridge' },
];

// ── .env upsert (atomic) ------------------------------------------
//
// Mirrors `cli/v4/setupWizard.upsertEnvVar` but local to this command
// so the slash-command path doesn't pull a wizard import. Tmp + rename
// guarantees no half-written .env files even if the process is killed
// mid-write.

async function upsertEnv(envFile: string, key: string, value: string): Promise<void> {
  const k = key.toUpperCase();
  let body = '';
  try { body = await fs.readFile(envFile, 'utf8'); } catch { /* fresh file */ }
  const lines = body.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`${k}=`)) {
      lines[i] = `${k}=${value}`;
      replaced = true;
    }
  }
  if (!replaced) lines.push(`${k}=${value}`);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  const tmp = `${envFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${lines.join('\n')}\n`, 'utf8');
  await fs.rename(tmp, envFile);
}

async function deleteEnvKey(envFile: string, key: string): Promise<boolean> {
  const k = key.toUpperCase();
  let body = '';
  try { body = await fs.readFile(envFile, 'utf8'); } catch { return false; }
  const lines = body.split(/\r?\n/);
  const filtered = lines.filter((l) => !l.startsWith(`${k}=`));
  if (filtered.length === lines.length) return false;
  while (filtered.length > 0 && filtered[filtered.length - 1] === '') filtered.pop();
  const tmp = `${envFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${filtered.join('\n')}\n`, 'utf8');
  await fs.rename(tmp, envFile);
  return true;
}

// ── Generic single-token channel-add scaffold ---------------------
//
// The shared shape behind `/channel <x> add` for a channel whose only
// credential is one bot token: prompt → validate via a channel-specific
// probe → persist via the channel-agnostic upsertEnv → (re)register a fresh
// adapter + restart it live. Telegram keeps its own bespoke handler below
// (it has extra subcommands + active-model wiring, and it is the one proven
// channel — not worth the regression risk of re-routing it). This scaffold
// is the extraction Discord uses; Phase B multi-field channels can build on
// it. Deliberately single-token only — no multi-field prompt-loop
// abstraction until a channel actually needs one.

interface TokenProbeResult {
  ok:        boolean;
  /** Bot identity for the success line (username / tag); optional. */
  identity?: string;
  /** Human-readable failure reason. MUST NOT contain the token. */
  reason?:   string;
}

interface SingleTokenChannelSpec {
  id:               string;   // manager/channel id, e.g. 'discord'
  displayName:      string;   // 'Discord'
  envVar:           string;   // 'DISCORD_BOT_TOKEN'
  intakeHint:       string;   // printed before the prompt
  promptLabel:      string;   // prompt caption
  tokenFormat?:     RegExp;   // optional client-side sanity check
  formatErrorHint?: string;
  validatingLabel:  string;   // spinner caption
  validate:         (token: string) => Promise<TokenProbeResult>;
  makeAdapter:      () => ChannelAdapter;
  successMessage:   (identity: string) => string;
}

export async function channelAddSingleToken(
  ctx: import('../commandRegistry').SlashCommandContext,
  spec: SingleTokenChannelSpec,
): Promise<void> {
  const { display, prompt } = ctx;
  if (!prompt) {
    display.printError('Cannot prompt for input in this context.');
    return;
  }
  if (!ctx.paths) {
    display.printError('Cannot resolve .env path — paths missing in context.');
    return;
  }

  display.write(spec.intakeHint);
  const raw = await prompt(spec.promptLabel);
  const token = (raw ?? '').trim();
  if (!token) {
    display.dim('  Empty token — cancelled.');
    return;
  }
  if (spec.tokenFormat && !spec.tokenFormat.test(token)) {
    display.printError(
      `That doesn't look like a ${spec.displayName} bot token.`,
      spec.formatErrorHint ?? 'Double-check what you pasted.',
    );
    return;
  }

  const spinner = display.startSpinner(spec.validatingLabel);
  let probe: TokenProbeResult;
  try { probe = await spec.validate(token); }
  finally { spinner.stop(); }

  if (!probe.ok) {
    display.printError(
      `${spec.displayName} rejected the token: ${probe.reason ?? 'unknown error'}.`,
      `Re-run /channel ${spec.id} add with a fresh token.`,
    );
    return;
  }

  // Persist to the env file Aiden resolves at boot. upsertEnv is
  // channel-agnostic; the value is re-read by the fresh adapter below.
  process.env[spec.envVar] = token;
  await upsertEnv(ctx.paths.envFile, spec.envVar, token);

  const manager = ctx.channelManager;
  if (!manager) {
    display.warn('Token saved, but no channel manager wired in this session — restart aiden to apply.');
    return;
  }
  // Stop any existing adapter, then register a FRESH instance so its
  // constructor picks up the token we just wrote — some adapters (Discord)
  // read the token only in the constructor, not on start(). register()
  // overwrites the map entry by name, so there is no double-registration.
  const existing = manager.get(spec.id);
  if (existing) { try { await existing.stop(); } catch { /* best-effort */ } }
  const adapter = spec.makeAdapter();
  manager.register(adapter);
  const result = await manager.restart(spec.id);

  if (result.status === 'started' && adapter.isHealthy()) {
    display.success(spec.successMessage(probe.identity ?? 'bot'));
    display.dim(`  Token saved to ${ctx.paths.envFile}`);
  } else {
    display.printError(
      `Token saved but adapter did not come up: ${result.error ?? result.status}.`,
      `Run /channel ${spec.id} status for diagnostics.`,
    );
  }
}

// ── Telegram getMe — token validation -----------------------------

interface TelegramGetMeResult {
  ok:        boolean;
  username?: string;
  firstName?: string;
  reason?:   string;
}

async function validateTelegramToken(token: string): Promise<TelegramGetMeResult> {
  // Phase v4.1-1.1: validate before persisting. A bad token costs us
  // one HTTP call but spares the user the "I saved it but the adapter
  // won't start" debugging path. Hard-cap the request at 10s so a
  // network stall can't lock the REPL.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: ctrl.signal },
    );
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const json = (await res.json()) as { ok: boolean; result?: { username?: string; first_name?: string }; description?: string };
    if (!json.ok) {
      return { ok: false, reason: json.description ?? 'Telegram returned ok=false' };
    }
    return {
      ok:        true,
      username:  json.result?.username,
      firstName: json.result?.first_name,
    };
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'request timed out (10s)' : (err?.message ?? 'network error') };
  } finally {
    clearTimeout(timer);
  }
}

// ── /channel list -------------------------------------------------

function formatList(ctx: import('../commandRegistry').SlashCommandContext): void {
  const { display } = ctx;
  const manager     = ctx.channelManager;
  display.write('\n  Configured channels:\n');

  type Row = { channel: string; state: string; status: 'active' | 'conflict' | 'connecting' | 'degraded' | 'offline' | 'not-configured' | 'not-registered'; detail: string };
  const rows: Row[] = CHANNEL_DESCRIPTORS.map((desc) => {
    const adapter = manager?.get(desc.id);
    const healthy = adapter?.isHealthy() === true;
    const tg = adapter as (TelegramAdapter & {
      getBotUsername?: () => string | null;
      getState?:       () => string;
    }) | undefined;
    const tgState = typeof tg?.getState === 'function' ? tg.getState() : null;
    if (!adapter) {
      return { channel: desc.id, state: 'not registered', status: 'not-registered', detail: '' };
    }
    if (healthy) {
      const username = typeof tg?.getBotUsername === 'function' ? tg.getBotUsername() : null;
      return { channel: desc.id, state: 'active', status: 'active', detail: username ? `@${username}` : '' };
    }
    if (tgState === 'conflict') {
      return { channel: desc.id, state: 'conflict', status: 'conflict',
               detail: 'another instance polling — /channel telegram takeover' };
    }
    if (tgState === 'connecting') {
      return { channel: desc.id, state: 'connecting', status: 'connecting', detail: '' };
    }
    if (tgState === 'degraded') {
      return { channel: desc.id, state: 'degraded', status: 'degraded',
               detail: 'see /channel telegram status' };
    }
    const envHit = desc.envVars.some((v) => (process.env[v] ?? '').trim() !== '');
    return envHit
      ? { channel: desc.id, state: 'offline',         status: 'offline',         detail: 'env set, not connected' }
      : { channel: desc.id, state: 'not configured',  status: 'not-configured',  detail: '' };
  });

  display.write(
    renderTable(rows, [
      { key: 'channel', header: 'Channel', align: 'left',  minWidth: 10 },
      { key: 'state',   header: 'State',   align: 'left',
        color: (_v, row) => {
          switch ((row as Row).status) {
            case 'active':     return 'success';
            case 'conflict':
            case 'degraded':
            case 'offline':    return 'warn';
            default:           return 'muted';
          }
        } },
      { key: 'detail',  header: 'Detail',  align: 'left', flex: true,
        color: () => 'muted' },
    ]),
  );
  display.write(`  ${display.muted('Set up Telegram: /channel telegram add')}\n\n`);
}

// ── /channel telegram add -----------------------------------------

async function telegramAdd(ctx: import('../commandRegistry').SlashCommandContext): Promise<void> {
  const { display, prompt } = ctx;
  if (!prompt) {
    display.printError('Cannot prompt for input in this context.');
    return;
  }
  if (!ctx.paths) {
    display.printError('Cannot resolve .env path — paths missing in context.');
    return;
  }

  display.write('\n  Open Telegram, message @BotFather, send /newbot, copy the token.\n');
  const raw = await prompt('  Paste your Telegram bot token: ');
  const token = (raw ?? '').trim();
  if (!token) {
    display.dim('  Empty token — cancelled.');
    return;
  }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    display.printError(
      'That doesn\'t look like a Telegram bot token.',
      'Format is `<bot_id>:<secret>`. Double-check what BotFather sent.',
    );
    return;
  }

  const spinner = display.startSpinner('Validating token via Telegram /getMe…');
  let probe: TelegramGetMeResult;
  try { probe = await validateTelegramToken(token); }
  finally { spinner.stop(); }

  if (!probe.ok) {
    display.printError(
      `Telegram rejected the token: ${probe.reason ?? 'unknown error'}.`,
      'Re-run /channel telegram add with a fresh token from BotFather.',
    );
    return;
  }

  // Persist to the env file Aiden's runtime resolves at boot. ChannelManager
  // re-reads process.env on adapter restart (Phase v4.1-1.1 contract).
  process.env.TELEGRAM_BOT_TOKEN = token;
  await upsertEnv(ctx.paths.envFile, 'TELEGRAM_BOT_TOKEN', token);

  // Restart the adapter through the manager — stop() then start(); start()
  // re-reads the env we just updated.
  const manager = ctx.channelManager;
  if (!manager) {
    display.warn('Token saved, but no channel manager wired in this session — restart aiden to apply.');
    return;
  }
  let adapter = manager.get('telegram');
  if (!adapter) {
    // Manager doesn't have a Telegram adapter registered — register one now.
    adapter = new TelegramAdapter();
    manager.register(adapter);
  }
  const result = await manager.restart('telegram');
  if (result.status === 'started' && adapter.isHealthy()) {
    const username = probe.username ?? probe.firstName ?? 'bot';
    display.success(`Bot connected as @${username}. Ready to chat!`);
    display.dim(`  Token saved to ${ctx.paths.envFile}`);
  } else {
    display.printError(
      `Token saved but adapter did not come up: ${result.error ?? result.status}.`,
      'Run /channel telegram status for diagnostics.',
    );
  }
}

// ── /channel telegram remove --------------------------------------

async function telegramRemove(ctx: import('../commandRegistry').SlashCommandContext): Promise<void> {
  const { display, confirm } = ctx;
  if (!confirm) {
    display.printError('Cannot confirm in this context.');
    return;
  }
  if (!ctx.paths) {
    display.printError('Cannot resolve .env path — paths missing.');
    return;
  }
  const proceed = await confirm('Remove the Telegram bot token? This stops polling.');
  // v4.9.2 Slice 3 — confirm() now owns the rejection message.
  if (!proceed) return;

  // Stop the live adapter first so polling actually halts even if the
  // .env write fails for some reason.
  const manager = ctx.channelManager;
  const adapter = manager?.get('telegram');
  if (adapter && adapter.isHealthy()) {
    try { await adapter.stop(); } catch { /* shutdown best-effort */ }
  }

  delete process.env.TELEGRAM_BOT_TOKEN;
  const removed = await deleteEnvKey(ctx.paths.envFile, 'TELEGRAM_BOT_TOKEN');
  if (removed) {
    display.success('Telegram disabled. TELEGRAM_BOT_TOKEN removed from .env.');
  } else {
    display.dim('Telegram disabled. (No TELEGRAM_BOT_TOKEN entry was in .env.)');
  }

  // v4.10 Slice 10.7 — honest UX disclosure. Aiden only owns the
  // .env file + the in-process env var. If the user previously set
  // the token via their shell (`setx TELEGRAM_BOT_TOKEN ...` on
  // Windows or `export` in POSIX rc files), the next REPL launch
  // would rehydrate it from the shell environment and silently
  // re-enable Telegram. The remove command can't reach those
  // surfaces — but it can tell the user what it can't clean.
  display.dim('');
  display.dim('Note: if you set the token via your shell, it may persist there.');
  display.dim('  PowerShell user env: setx TELEGRAM_BOT_TOKEN ""');
  display.dim('  POSIX shell:        unset TELEGRAM_BOT_TOKEN  (also edit ~/.bashrc / .zshrc)');

  // v4.10 Slice 10.7 — defensive config.yaml scan. Aiden's config
  // supports `${VAR}` interpolation; users sometimes embed the
  // Telegram token from there too. If the file mentions
  // ${TELEGRAM_BOT_TOKEN}, removing the env var leaves config.yaml
  // pointing at an undefined variable — surface this so the user
  // can prune that pointer before the next launch logs a warning.
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const configPath = path.join(ctx.paths.root, 'config.yaml');
    const yaml = fs.readFileSync(configPath, 'utf8');
    if (yaml.includes('${TELEGRAM_BOT_TOKEN}')) {
      display.dim('');
      display.warn('config.yaml references ${TELEGRAM_BOT_TOKEN}.');
      display.dim('  Edit the file to drop that placeholder, otherwise the next REPL launch will fail to interpolate it.');
    }
  } catch { /* config.yaml unreadable or absent — silent skip */ }
}

// ── /channel telegram takeover ------------------------------------
//
// When two Aiden instances share TELEGRAM_BOT_TOKEN, both poll the
// same bot and Telegram returns 409 Conflict to the loser. Phase
// v4.1-1.2 — `/channel telegram takeover` reaches the network
// directly to evict the rival poller (deleteWebhook +
// drop_pending_updates + getUpdates offset reset) and re-arms this
// instance's adapter from a clean state.

async function telegramTakeover(ctx: import('../commandRegistry').SlashCommandContext): Promise<void> {
  const { display, confirm } = ctx;
  const manager = ctx.channelManager;
  const adapter = manager?.get('telegram') as
    | (TelegramAdapter & { takeoverPolling?: () => Promise<{ ok: boolean; reason?: string }>; getState?: () => string })
    | undefined;
  if (!adapter || typeof adapter.takeoverPolling !== 'function') {
    display.warn('No Telegram adapter registered in this session.');
    return;
  }
  const proceed = confirm
    ? await confirm(
        'Take over Telegram polling? This will boot any other Aiden instance off the bot.',
      )
    : true;
  // v4.9.2 Slice 3 — confirm() now owns the rejection message.
  if (!proceed) return;

  const spinner = display.startSpinner('Reclaiming Telegram polling…');
  let result: { ok: boolean; reason?: string };
  try { result = await adapter.takeoverPolling(); }
  finally { spinner.stop(); }

  if (result.ok) {
    display.success('Takeover successful — this instance is now polling.');
  } else {
    display.printError(
      `Takeover failed: ${result.reason ?? 'unknown error'}.`,
      'Verify your token via /channel telegram status, or close the other Aiden instance and retry.',
    );
  }
}

// ── /channel telegram status --------------------------------------

function telegramStatus(ctx: import('../commandRegistry').SlashCommandContext): void {
  const { display } = ctx;
  const manager = ctx.channelManager;
  const adapter = manager?.get('telegram') as
    | (TelegramAdapter & { getDiagnostics?: () => any })
    | undefined;
  if (!adapter || typeof adapter.getDiagnostics !== 'function') {
    display.warn('No Telegram adapter registered in this session.');
    return;
  }
  const d = adapter.getDiagnostics();
  // Phase v4.1-1.2 — render the coarse state explicitly. "conflict"
  // means another aiden instance is polling this bot; the user's
  // remediation hint is /channel telegram takeover.
  let stateLabel: string;
  if (d.state === 'active')        stateLabel = display.paint('active', 'success');
  else if (d.state === 'conflict') stateLabel = display.paint('conflict (another instance is polling)', 'warn');
  else if (d.state === 'degraded') stateLabel = display.paint('degraded', 'warn');
  else if (d.state === 'connecting') stateLabel = display.muted('connecting…');
  else                              stateLabel = display.muted('inactive');

  display.write('\n  Telegram status:\n');
  display.write(`    state:         ${stateLabel}\n`);
  display.write(`    bot:           ${d.botUsername ? '@' + d.botUsername : '(not connected)'}\n`);
  display.write(`    healthy:       ${d.healthy ? display.paint('yes', 'success') : display.paint('no', 'warn')}\n`);
  display.write(`    token set:     ${d.hasToken ? 'yes' : display.paint('no', 'warn')}\n`);
  display.write(`    polling:       ${d.pollingActive ? display.paint('active', 'success') : display.muted('idle')}\n`);
  display.write(`    last message:  ${d.lastMessageAt ? new Date(d.lastMessageAt).toISOString() : display.muted('never')}\n`);
  display.write(`    polling errors:${d.errorCount > 0 ? ' ' + display.paint(String(d.errorCount), 'warn') : ' 0'}\n`);
  if (typeof d.consecutiveConflicts === 'number' && d.consecutiveConflicts > 0) {
    display.write(`    409 streak:    ${display.paint(String(d.consecutiveConflicts), 'warn')}\n`);
  }
  if (ctx.paths) {
    display.write(`    log file:      ${ctx.paths.logsDir}/telegram.log\n`);
  }
  if (d.state === 'conflict') {
    display.write(`\n  ${display.muted('Run /channel telegram takeover to reclaim this bot from the other instance.')}\n`);
  }
  display.write('\n');
}

// ── /channel telegram allowlist (Phase v4.1-2) --------------------
//
// Manages the TELEGRAM_ALLOWED_GROUPS env var, which gates which
// group ids the bot will respond in. Empty = open (default); populated
// = strict allowlist. Mutations write to the live process.env AND
// persist to .env so the setting survives restart.

async function telegramAllowlist(
  ctx: import('../commandRegistry').SlashCommandContext,
  rest: string[],
): Promise<void> {
  const { display } = ctx;
  const sub  = (rest[0] ?? 'list').toLowerCase();
  const arg  = rest[1] ?? '';

  const current = (process.env.TELEGRAM_ALLOWED_GROUPS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (sub === 'list' || sub === 'ls') {
    if (current.length === 0) {
      display.write('\n  Group allowlist: ' + display.muted('disabled (open — bot replies in any group it is added to)') + '\n');
      display.write(`  ${display.muted('Add a group: /channel telegram allowlist add <group_id>')}\n\n`);
    } else {
      display.write('\n  Group allowlist (strict — only these groups):\n');
      for (const id of current) display.write(`    ${id}\n`);
      display.write('\n');
    }
    return;
  }

  if (!ctx.paths) {
    display.printError('Cannot resolve .env path — paths missing.');
    return;
  }
  if (sub === 'add') {
    if (!arg) { display.printError('Usage: /channel telegram allowlist add <group_id>'); return; }
    if (!/^-?\d+$/.test(arg)) { display.printError('Group id must be a numeric Telegram chat id.'); return; }
    if (current.includes(arg)) {
      display.dim(`  Already on allowlist: ${arg}`);
      return;
    }
    const next = [...current, arg];
    process.env.TELEGRAM_ALLOWED_GROUPS = next.join(',');
    await upsertEnv(ctx.paths.envFile, 'TELEGRAM_ALLOWED_GROUPS', next.join(','));
    display.success(`Added ${arg} to TELEGRAM_ALLOWED_GROUPS (${next.length} group(s) allowed).`);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!arg) { display.printError('Usage: /channel telegram allowlist remove <group_id>'); return; }
    const next = current.filter(g => g !== arg);
    if (next.length === current.length) {
      display.dim(`  Not on allowlist: ${arg}`);
      return;
    }
    if (next.length === 0) {
      process.env.TELEGRAM_ALLOWED_GROUPS = '';
      await deleteEnvKey(ctx.paths.envFile, 'TELEGRAM_ALLOWED_GROUPS');
      display.success(`Removed ${arg}; allowlist now empty (open mode restored).`);
    } else {
      process.env.TELEGRAM_ALLOWED_GROUPS = next.join(',');
      await upsertEnv(ctx.paths.envFile, 'TELEGRAM_ALLOWED_GROUPS', next.join(','));
      display.success(`Removed ${arg} (${next.length} group(s) allowed).`);
    }
    return;
  }

  display.printError(
    `Unknown allowlist action '${sub}'.`,
    'Try: /channel telegram allowlist list | add <id> | remove <id>',
  );
}

// ── /channel telegram groups (Phase v4.1-2) -----------------------
//
// Surfaces the persistent group state managed by TelegramGroupStore.
// `list` is the headline — shows every group the bot has observed,
// status (active / paused), title, last message timestamp.
// `pause` / `resume` flip the persistent pause flag so a group can
// be silenced from the CLI without leaving the chat.

async function telegramGroups(
  ctx: import('../commandRegistry').SlashCommandContext,
  rest: string[],
): Promise<void> {
  const { display } = ctx;
  const manager = ctx.channelManager;
  const adapter = manager?.get('telegram') as
    | (TelegramAdapter & {
        getGroupStore?: () => import('../../../core/channels/telegram-groups').TelegramGroupStore | null;
      })
    | undefined;
  const store = typeof adapter?.getGroupStore === 'function' ? adapter.getGroupStore() : null;

  const sub = (rest[0] ?? 'list').toLowerCase();
  const arg = rest[1] ?? '';

  if (sub === 'list' || sub === 'ls') {
    if (!store) {
      display.warn('Telegram adapter has not started yet — no group state available.');
      return;
    }
    const groups = store.list();
    if (groups.length === 0) {
      display.write('\n  No groups observed yet. ' + display.muted('Add the bot to a group to start.') + '\n\n');
      return;
    }
    display.write('\n  Telegram groups:\n');
    for (const g of groups) {
      const status  = g.paused ? display.paint('paused', 'warn') : display.paint('active', 'success');
      const title   = g.title ?? display.muted('(unknown title)');
      const lastSeen = g.lastMessageAt
        ? new Date(g.lastMessageAt).toISOString()
        : display.muted('never');
      display.write(`    ${g.groupId}  ${status}  ${title}\n`);
      display.write(`      last message: ${lastSeen}\n`);
      if (g.allowedUsers.length > 0) {
        display.write(`      allowed users: ${g.allowedUsers.length}\n`);
      }
    }
    display.write('\n');
    return;
  }

  if (sub === 'pause' || sub === 'resume') {
    if (!store) {
      display.warn('Telegram adapter has not started yet — cannot mutate group state.');
      return;
    }
    if (!arg) {
      display.printError(`Usage: /channel telegram groups ${sub} <group_id>`);
      return;
    }
    if (!store.get(arg)) {
      display.printError(
        `Unknown group id: ${arg}.`,
        'Run /channel telegram groups list to see observed groups.',
      );
      return;
    }
    store.setPaused(arg, sub === 'pause', 'cli');
    display.success(`Group ${arg} ${sub === 'pause' ? 'paused' : 'resumed'}.`);
    return;
  }

  display.printError(
    `Unknown groups action '${sub}'.`,
    'Try: /channel telegram groups list | pause <id> | resume <id>',
  );
}

// ── /channel telegram voice (Phase v4.1-3) ------------------------
//
// Status / enable / disable for the Telegram voice-note path.
// Persists the toggle to TELEGRAM_VOICE_ENABLED in .env (atomic write
// via the upsertEnv helper above). Status reads back the live counter
// state from the adapter plus the on-disk cache footprint, so the user
// can confirm voice messages are landing in the cache and being
// transcribed.

async function telegramVoice(
  ctx: import('../commandRegistry').SlashCommandContext,
  rest: string[],
): Promise<void> {
  const { display } = ctx;
  const sub = (rest[0] ?? 'status').toLowerCase();
  const manager = ctx.channelManager;
  const adapter = manager?.get('telegram') as
    | (TelegramAdapter & {
        getVoiceDiagnostics?: () => Promise<{
          enabled:           boolean;
          threshold:         number;
          language:          string | null;
          cacheDir:          string;
          cacheBytes:        number;
          cacheFileCount:    number;
          transcribedCount:  number;
          receivedCount:     number;
        }>;
      })
    | undefined;

  if (sub === 'status' || sub === '') {
    if (!adapter || typeof adapter.getVoiceDiagnostics !== 'function') {
      display.warn('No Telegram adapter registered in this session.');
      return;
    }
    const d = await adapter.getVoiceDiagnostics();
    const stateLabel = d.enabled
      ? display.paint('enabled', 'success')
      : display.paint('disabled', 'warn');
    const sizeMb = (d.cacheBytes / (1024 * 1024)).toFixed(1);
    display.write('\n  Telegram voice status:\n');
    display.write(`    voice notes:     ${stateLabel}\n`);
    display.write(`    confidence:      threshold ${d.threshold} (echo when below)\n`);
    display.write(`    language:        ${d.language ?? display.muted('auto-detect')}\n`);
    display.write(`    cache dir:       ${d.cacheDir}\n`);
    display.write(`    cache size:      ${sizeMb} MB across ${d.cacheFileCount} file(s)\n`);
    display.write(`    received:        ${d.receivedCount} (since adapter start)\n`);
    display.write(`    transcribed:     ${d.transcribedCount}\n`);
    display.write('\n');
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    if (!ctx.paths) {
      display.printError('Cannot resolve .env path — paths missing.');
      return;
    }
    const next = sub === 'enable' ? 'true' : 'false';
    process.env.TELEGRAM_VOICE_ENABLED = next;
    await upsertEnv(ctx.paths.envFile, 'TELEGRAM_VOICE_ENABLED', next);
    if (sub === 'enable') {
      display.success('Voice notes enabled. Send a voice DM to test.');
    } else {
      display.success('Voice notes disabled. Inbound voice will get a friendly reject.');
    }
    return;
  }

  display.printError(
    `Unknown voice action '${sub}'.`,
    'Try: /channel telegram voice status | enable | disable',
  );
}

// ── /channel telegram media (Phase v4.1-4) ------------------------
//
// Aggregate status / enable / disable for the photo + document path.
// Voice retains its own /channel telegram voice subcommand. Status
// reads back the live counter state from the adapter plus the
// on-disk cache footprint for all three media subdirs.

async function telegramMedia(
  ctx: import('../commandRegistry').SlashCommandContext,
  rest: string[],
): Promise<void> {
  const { display } = ctx;
  const sub = (rest[0] ?? 'status').toLowerCase();
  const manager = ctx.channelManager;
  const adapter = manager?.get('telegram') as
    | (TelegramAdapter & {
        getMediaDiagnostics?: () => Promise<{
          enabled:           boolean;
          supportedDocTypes: readonly string[];
          voice:    { dir: string; bytes: number; files: number };
          photos:   { dir: string; bytes: number; files: number; receivedCount: number; processedCount: number };
          documents:{ dir: string; bytes: number; files: number; receivedCount: number; processedCount: number };
        }>;
      })
    | undefined;

  if (sub === 'status' || sub === '') {
    if (!adapter || typeof adapter.getMediaDiagnostics !== 'function') {
      display.warn('No Telegram adapter registered in this session.');
      return;
    }
    const d = await adapter.getMediaDiagnostics();
    const stateLabel = d.enabled
      ? display.paint('enabled', 'success')
      : display.paint('disabled', 'warn');
    const fmt = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    display.write('\n  Telegram media status:\n');
    display.write(`    photos + docs:   ${stateLabel}\n`);
    display.write(`    supported docs:  ${d.supportedDocTypes.join(', ')}\n`);
    display.write(`    voice cache:     ${fmt(d.voice.bytes)} across ${d.voice.files} file(s)\n`);
    display.write(`    photo cache:     ${fmt(d.photos.bytes)} across ${d.photos.files} file(s)\n`);
    display.write(`    document cache:  ${fmt(d.documents.bytes)} across ${d.documents.files} file(s)\n`);
    display.write(`    photos received: ${d.photos.receivedCount} / processed: ${d.photos.processedCount}\n`);
    display.write(`    docs received:   ${d.documents.receivedCount} / processed: ${d.documents.processedCount}\n`);
    display.write('\n');
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    if (!ctx.paths) {
      display.printError('Cannot resolve .env path — paths missing.');
      return;
    }
    const next = sub === 'enable' ? 'true' : 'false';
    process.env.TELEGRAM_MEDIA_ENABLED = next;
    await upsertEnv(ctx.paths.envFile, 'TELEGRAM_MEDIA_ENABLED', next);
    if (sub === 'enable') {
      display.success('Photos + documents enabled. Send a photo or PDF to test.');
    } else {
      display.success('Photos + documents disabled. Inbound media will get a friendly reject.');
    }
    return;
  }

  display.printError(
    `Unknown media action '${sub}'.`,
    'Try: /channel telegram media status | enable | disable',
  );
}

// ── Discord (Phase A — v4.12.1) -----------------------------------
//
// Second caller of the single-token scaffold. Discord needs only a bot
// token; the optional guild/channel allowlists (DISCORD_ALLOWED_GUILDS /
// _CHANNELS) are honoured by the adapter but not prompted here (Phase B).

export async function validateDiscordToken(token: string): Promise<TokenProbeResult> {
  // Verify before persisting — one API call spares the "saved but won't
  // start" path. GET /users/@me with the Bot auth scheme; 10s hard cap so a
  // network stall can't lock the REPL. The token travels only in the
  // Authorization header — never logged, never echoed, never in an error.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal:  ctrl.signal,
    });
    if (res.status === 401) {
      return { ok: false, reason: 'invalid token (401 Unauthorized)' };
    }
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const json = (await res.json()) as { username?: string; discriminator?: string; id?: string };
    const uname = json.username ?? 'bot';
    // Modern Discord bots report discriminator '0'; only append a legacy
    // #discriminator when it's a real tag.
    const identity = json.discriminator && json.discriminator !== '0'
      ? `${uname}#${json.discriminator}`
      : uname;
    return { ok: true, identity };
  } catch (err: any) {
    return {
      ok: false,
      reason: err?.name === 'AbortError' ? 'request timed out (10s)' : (err?.message ?? 'network error'),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function discordAdd(ctx: import('../commandRegistry').SlashCommandContext): Promise<void> {
  await channelAddSingleToken(ctx, {
    id:          'discord',
    displayName: 'Discord',
    envVar:      'DISCORD_BOT_TOKEN',
    intakeHint:
      '\n  Create an app at https://discord.com/developers/applications -> Bot ->\n' +
      '  Reset Token, copy it. Enable the "Message Content Intent" on that page.\n',
    promptLabel: '  Paste your Discord bot token: ',
    // Lenient sanity check — Discord bot tokens are dot-separated and long.
    // The API probe is authoritative; this only catches obvious paste slips.
    tokenFormat:     /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]{20,}$/,
    formatErrorHint: 'A Discord bot token looks like `<id>.<part>.<part>` — copy it from the Bot page.',
    validatingLabel: 'Validating token via Discord /users/@me…',
    validate:        validateDiscordToken,
    makeAdapter:     () => new DiscordAdapter(),
    successMessage:  (identity) => `Discord connected as ${identity}. Ready to chat!`,
  });
}

function discordStatus(ctx: import('../commandRegistry').SlashCommandContext): void {
  const { display } = ctx;
  const adapter  = ctx.channelManager?.get('discord');
  const hasToken = (process.env.DISCORD_BOT_TOKEN ?? '').trim() !== '';
  display.write('\n  Discord status:\n');
  display.write(`    registered:  ${adapter ? 'yes' : display.muted('no')}\n`);
  display.write(`    healthy:     ${adapter?.isHealthy() ? display.paint('yes', 'success') : display.paint('no', 'warn')}\n`);
  display.write(`    token set:   ${hasToken ? 'yes' : display.paint('no', 'warn')}\n`);
  if (!hasToken) {
    display.write(`\n  ${display.muted('Set it up: /channel discord add')}\n`);
  }
  display.write('\n');
}

async function discordRemove(ctx: import('../commandRegistry').SlashCommandContext): Promise<void> {
  const { display, confirm } = ctx;
  if (!confirm) {
    display.printError('Cannot confirm in this context.');
    return;
  }
  if (!ctx.paths) {
    display.printError('Cannot resolve .env path — paths missing.');
    return;
  }
  const proceed = await confirm('Remove the Discord bot token? This disconnects the bot.');
  if (!proceed) return;

  const adapter = ctx.channelManager?.get('discord');
  if (adapter && adapter.isHealthy()) {
    try { await adapter.stop(); } catch { /* shutdown best-effort */ }
  }
  delete process.env.DISCORD_BOT_TOKEN;
  const removed = await deleteEnvKey(ctx.paths.envFile, 'DISCORD_BOT_TOKEN');
  if (removed) {
    display.success('Discord disabled. DISCORD_BOT_TOKEN removed from .env.');
  } else {
    display.dim('Discord disabled. (No DISCORD_BOT_TOKEN entry was in .env.)');
  }
  display.dim('');
  display.dim('Note: if you set the token via your shell, it may persist there.');
}

// ── Top-level command --------------------------------------------

export const channel: SlashCommand = {
  name: 'channel',
  description: 'Manage channel adapters (telegram, discord, slack, …).',
  category: 'system',
  icon: '📡',
  handler: async (ctx) => {
    const args = ctx.rawArgs.trim().split(/\s+/).filter(Boolean);
    const sub  = args[0]?.toLowerCase();

    if (!sub || sub === 'list' || sub === 'ls') {
      formatList(ctx);
      return;
    }

    if (sub === 'telegram') {
      const action = args[1]?.toLowerCase() ?? 'status';
      switch (action) {
        case 'add':      await telegramAdd(ctx);      return;
        case 'remove':
        case 'rm':       await telegramRemove(ctx);   return;
        case 'status':   telegramStatus(ctx);         return;
        case 'takeover': await telegramTakeover(ctx); return;
        // Phase v4.1-2 subcommands.
        case 'allowlist': await telegramAllowlist(ctx, args.slice(2)); return;
        case 'groups':    await telegramGroups(ctx, args.slice(2));    return;
        // Phase v4.1-3 subcommand.
        case 'voice':     await telegramVoice(ctx, args.slice(2));     return;
        // Phase v4.1-4 subcommand.
        case 'media':     await telegramMedia(ctx, args.slice(2));     return;
        default:
          ctx.display.printError(
            `Unknown telegram action '${action}'.`,
            'Try: /channel telegram add | remove | status | takeover | allowlist | groups | voice | media',
          );
          return;
      }
    }

    if (sub === 'discord') {
      const action = args[1]?.toLowerCase() ?? 'status';
      switch (action) {
        case 'add':      await discordAdd(ctx);    return;
        case 'remove':
        case 'rm':       await discordRemove(ctx); return;
        case 'status':   discordStatus(ctx);       return;
        default:
          ctx.display.printError(
            `Unknown discord action '${action}'.`,
            'Try: /channel discord add | remove | status',
          );
          return;
      }
    }

    // Other channel ids — Phase B/C surface area. Honest stub.
    if (CHANNEL_DESCRIPTORS.some((c) => c.id === sub)) {
      ctx.display.write(
        `\n  /channel ${sub} management is coming in a later phase.\n` +
          `  For now, set the env var(s) directly and restart aiden:\n`,
      );
      const desc = CHANNEL_DESCRIPTORS.find((c) => c.id === sub)!;
      for (const v of desc.envVars) ctx.display.write(`    ${v}=...\n`);
      ctx.display.write('\n');
      return;
    }

    ctx.display.printError(
      `Unknown channel '${sub}'.`,
      'Try: /channel list | /channel telegram add',
    );
  },
};
