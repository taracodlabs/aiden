/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/capabilities.ts — Phase v4.1.2-followup self-awareness.
 *
 * Runtime-computed manifest of what Aiden actually has loaded. Fed
 * into the `## Runtime` slot of the system prompt so the model can
 * answer questions like "what version are you" and "what tools do
 * you have" from facts in its context, instead of hallucinating from
 * whatever stale text used to live in SOUL.md.
 *
 * The manifest is computed at prompt-build time, never cached
 * separately — it piggybacks on the existing system-prompt cache.
 * On dirty-bit invalidation (memory / user / soul write, or
 * personality overlay change) the prompt rebuilds and so do these
 * numbers.
 *
 * No hardcoded "shipped vs deferred" framing here. The slot describes
 * what IS loaded; absence is absence, not declared deferral.
 */

import { VERSION } from '../version';

export interface RuntimeManifest {
  /** Aiden version. Auto-synced with package.json via scripts/inject-version.js. */
  version:       string;
  /** Count of tools registered in the live ToolRegistry. */
  toolCount:     number;
  /** Count of bundled skills currently advertised to the model. */
  skillCount:    number;
  /** User-facing channel/surface names (gateway adapters + interaction surfaces). */
  channels:      ReadonlyArray<string>;
  /** Current provider id (chatgpt-plus / anthropic / groq / ...). */
  providerId?:   string;
  /** Current model id within the provider. */
  modelId?:      string;
}

/**
 * TODO(v4.2): replace with a proper channel registry enumeration once
 * channels expose a registration API. Today the gateway adapters are
 * wired directly in `api/server.ts` (DiscordAdapter, SlackAdapter,
 * TelegramAdapter, WhatsAppAdapter, EmailAdapter, WebhookAdapter,
 * TwilioAdapter, IMessageAdapter, SignalAdapter — nine in total) and
 * interaction surfaces (cli REPL, MCP server, OpenAI-compat HTTP, voice
 * mode, headless --no-ui, web dashboard) are scattered across cli/v4
 * and api/. This list conflates the two for the user-visible "channels
 * Aiden is available on" count; a follow-up should pick a single
 * definition and back this with a real registry.
 */
const KNOWN_CHANNELS: ReadonlyArray<string> = Object.freeze([
  'cli',
  'telegram',
  'discord',
  'slack',
  'mcp',
  'voice',
  'headless',
  'web',
  'api',
]);

export interface BuildRuntimeManifestOptions {
  toolCount:    number;
  skillCount:   number;
  providerId?:  string;
  modelId?:     string;
}

/**
 * Build the manifest from caller-supplied counts + persistent imports.
 * Pure function — no side effects, no async, no I/O — so PromptBuilder
 * can call it inline and keep the same determinism contract for its
 * prefix-cache friendliness.
 */
export function buildRuntimeManifest(
  opts: BuildRuntimeManifestOptions,
): RuntimeManifest {
  return {
    version:    VERSION,
    toolCount:  opts.toolCount,
    skillCount: opts.skillCount,
    channels:   KNOWN_CHANNELS,
    providerId: opts.providerId,
    modelId:    opts.modelId,
  };
}

/**
 * Render the manifest as the `## Runtime` prompt slot. Visual style
 * mirrors the other slots in PromptBuilder — h2 header, simple
 * `key: value` lines, no marketing speak.
 *
 * Always emits a complete block even when provider/model are unknown;
 * the contract is "always present, even if some values are unknown"
 * so the model doesn't second-guess whether the slot was suppressed.
 */
export function renderRuntimeSlot(manifest: RuntimeManifest): string {
  const lines: string[] = ['## Runtime'];
  lines.push(`Version: ${manifest.version}`);
  lines.push(`Tools loaded: ${manifest.toolCount}`);
  lines.push(`Skills bundled: ${manifest.skillCount}`);
  lines.push(`Active channels: ${manifest.channels.join(', ')}`);
  if (manifest.providerId) lines.push(`Provider: ${manifest.providerId}`);
  if (manifest.modelId)    lines.push(`Model: ${manifest.modelId}`);
  return lines.join('\n');
}
