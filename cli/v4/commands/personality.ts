/**
 * cli/v4/commands/personality.ts — Phase 16a; Phase 16b.4 wiring
 *
 * `/personality`           list available + show current
 * `/personality <name>`    switch active personality (live — invalidates the
 *                          agent's cached system prompt so the next turn
 *                          rebuilds with the new slot-2 overlay)
 * `/personality default`   revert to default (no overlay layered on SOUL.md)
 * `/personality show`      dump the current overlay body
 *
 * Hermes diverges — Hermes has no /personality, users edit SOUL.md directly.
 * Aiden keeps a separate manager because v4 UX docs treat overlays as a
 * runtime-switchable layer above (not replacing) the SOUL.md identity.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';
import {
  createFeatureGate,
  FEATURE_FLAGS,
} from '../../../core/v4/license/featureGate';

const STARTER_OVERLAY = (name: string) => `# Personality: ${name}

This overlay layers on top of SOUL.md and shapes Aiden's tone, focus, and
behaviour for this session. SOUL.md remains the canonical identity layer.

## Voice
- (describe the speaking style — formal, casual, terse, expansive, ...)

## Focus
- (which tools / domains this personality emphasises)

## Avoid
- (what this personality should not do — e.g. small talk during a debugging session)
`;

export const personality: SlashCommand = {
  name: 'personality',
  description: 'Show or switch the personality overlay layered on SOUL.md.',
  category: 'system',
  icon: '🎭',
  handler: async (ctx) => {
    const mgr = ctx.personalityManager;
    if (!mgr) {
      ctx.display.warn('Personality manager not wired in this context.');
      return {};
    }
    const target = ctx.rawArgs.trim();

    // ── /personality install <name> ── Pro-gated: scaffold a user overlay
    if (target.startsWith('install ') || target === 'install') {
      const arg = target.slice('install'.length).trim();
      if (!arg) {
        ctx.display.printError(
          'Usage: /personality install <name>',
          'Creates a starter overlay file in your personalities dir.',
        );
        return {};
      }
      if (!ctx.paths) {
        ctx.display.warn('Cannot install without resolved paths.');
        return {};
      }
      const gate = createFeatureGate(ctx.paths);
      const allowed = await gate.isProEnabled(FEATURE_FLAGS.CUSTOM_PERSONALITIES);
      if (!allowed) {
        ctx.display.printError(gate.degradationMessage(FEATURE_FLAGS.CUSTOM_PERSONALITIES));
        return {};
      }
      const safeName = arg.replace(/[^a-z0-9-_]/gi, '_').toLowerCase();
      if (!safeName) {
        ctx.display.printError('Invalid personality name.');
        return {};
      }
      const overlayFile = path.join(ctx.paths.personalitiesDir, `${safeName}.md`);
      try {
        await fs.access(overlayFile);
        ctx.display.warn(`${safeName}.md already exists — open it to edit.`);
        ctx.display.dim(`Path: ${overlayFile}`);
        return {};
      } catch {
        // not present — write the starter
      }
      await fs.mkdir(ctx.paths.personalitiesDir, { recursive: true });
      await fs.writeFile(overlayFile, STARTER_OVERLAY(safeName), 'utf8');
      ctx.display.success(`Created starter overlay at ${overlayFile}`);
      ctx.display.dim(`Edit the file, then run \`/personality ${safeName}\` to activate.`);
      return {};
    }

    // ── /personality (no args) ── list + current
    if (!target) {
      const list = await mgr.list();
      const current = mgr.getCurrent();
      ctx.display.info(`Active personality: ${current}`);
      ctx.display.info('Available personalities:');
      for (const p of list) {
        const marker = p.name === current ? '*' : ' ';
        const tag = p.source === 'user' ? ' (user)' : '';
        const desc = p.description ? ` — ${p.description}` : '';
        ctx.display.write(`  ${marker} ${p.name}${tag}${desc}\n`);
      }
      return {};
    }

    // ── /personality show ── dump current overlay body
    if (target === 'show') {
      const current = mgr.getCurrent();
      const body = await mgr.getActiveOverlay();
      ctx.display.info(`Personality '${current}' overlay (slot 2):`);
      ctx.display.write('\n');
      if (!body || !body.trim()) {
        ctx.display.dim('(empty — SOUL.md is used as the sole identity layer)');
      } else {
        ctx.display.write(body.trimEnd() + '\n');
      }
      return {};
    }

    // ── /personality <name> ── switch
    const result = await mgr.setCurrent(target);
    if (!result.ok) {
      ctx.display.printError(
        result.reason ?? `Unknown personality '${target}'.`,
        'Run /personality to see available names.',
      );
      return {};
    }

    // Push the new overlay into the agent's frozen prompt options. The agent
    // invalidates its cached system prompt on overlay change so the next
    // runConversation call rebuilds slot 2 from the new body. SOUL.md (slot
    // 1) and the rest of the slot order are untouched — overlays never
    // replace identity.
    if (ctx.agent) {
      const newOverlay = await mgr.getActiveOverlay();
      ctx.agent.setPersonalityOverlay(newOverlay);
    }
    ctx.display.success(`Personality: ${mgr.getCurrent()}`);
    return {};
  },
};
