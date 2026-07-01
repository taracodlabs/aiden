/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/channelBoot.ts — v4.12.1 Phase A
 *
 * Credential-gated boot registration for env-driven channel adapters in
 * the CLI/REPL.
 *
 * The REPL boot always registers Telegram (it carries active-model wiring).
 * This registers the OTHER env-only channels whose credentials are present,
 * so a channel configured via `/channel <x> add` survives a restart — WITHOUT
 * registering unconfigured channels (which would add disabled-adapter noise)
 * and WITHOUT a per-channel special-case in the boot (the set is a table, not
 * code). Webhook/Twilio are intentionally excluded: they need the HTTP
 * listener that only `aiden serve` provides. Phase B extends the table.
 */
import type { ChannelManager } from '../../core/channels/manager';
import type { ChannelAdapter } from '../../core/channels/adapter';
import { DiscordAdapter } from '../../core/channels/discord';

interface EnvChannelSpec {
  id:    string;
  creds: readonly string[];
  make:  () => ChannelAdapter;
}

// Env-driven, no-Express channels the CLI can host. Telegram is deliberately
// absent — the boot registers it separately with its active-model options.
const ENV_CHANNELS: readonly EnvChannelSpec[] = [
  { id: 'discord', creds: ['DISCORD_BOT_TOKEN'], make: () => new DiscordAdapter() },
];

/**
 * Register every env-driven channel whose required credentials are all
 * present in `env`. Returns the ids registered (for logging / tests). Does
 * NOT touch Telegram (registered separately by the boot), so there is no
 * double-registration.
 */
export function registerEnvChannels(
  manager: ChannelManager,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const registered: string[] = [];
  for (const ch of ENV_CHANNELS) {
    const configured = ch.creds.every((k) => (env[k] ?? '').trim() !== '');
    if (configured) {
      manager.register(ch.make());
      registered.push(ch.id);
    }
  }
  return registered;
}
