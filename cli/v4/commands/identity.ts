/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/identity.ts — Phase 16b.3
 *
 * `/identity` — dump the current SOUL.md so the user can verify what
 * persona is being injected into slot #1 of the system prompt. Falls back
 * to the bundled default identity when SOUL.md is missing/empty.
 *
 * Hermes reference: Hermes has no equivalent slash command — the user
 * `cat`s `~/.hermes/SOUL.md`. We add this because the v4 sprint has
 * surfaced "identity drift" twice, and an in-REPL diagnostic is faster
 * than asking users to fish through %LOCALAPPDATA% on Windows.
 */
import { promises as fs } from 'node:fs';
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { DEFAULT_SOUL_MD } from '../defaultSoul';

export const identity: SlashCommand = {
  name: 'identity',
  description: 'Dump the active SOUL.md identity (slot 1 of the system prompt).',
  category: 'system',
  icon: '🪪',
  handler: async (ctx: SlashCommandContext) => {
    if (!ctx.paths) {
      ctx.display.warn('Identity command requires paths in context (not wired in this mode).');
      return {};
    }
    const soulPath = ctx.paths.soulMd;
    let content: string | null = null;
    let source: 'disk' | 'bundled-default' = 'bundled-default';
    try {
      const buf = await fs.readFile(soulPath, 'utf8');
      if (buf.trim()) {
        content = buf;
        source = 'disk';
      }
    } catch {
      // ENOENT etc. — fall back to bundled default.
    }
    if (!content) content = DEFAULT_SOUL_MD;

    ctx.display.info(`SOUL.md (${source}): ${soulPath}`);
    ctx.display.write('\n');
    ctx.display.write(content.trimEnd() + '\n');
    ctx.display.write('\n');
    ctx.display.dim(
      source === 'bundled-default'
        ? '(no SOUL.md on disk — agent is using the bundled identity. Edit the file above to customise.)'
        : '(edit this file to change the agent identity. Restart the REPL to pick up changes.)',
    );
    return {};
  },
};
