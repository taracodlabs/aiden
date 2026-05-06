/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/skin.ts — Phase 14b + Phase 16a
 *
 * `/skin`              list available skins + show current
 * `/skin <name>`       switch to a named skin
 * `/skin reload`       re-read the active skin from disk (live iteration)
 */
import type { SlashCommand } from '../commandRegistry';

export const skin: SlashCommand = {
  name: 'skin',
  description: 'Switch terminal colour skin, list available, or /skin reload.',
  category: 'system',
  icon: '🎨',
  handler: async (ctx) => {
    const engine = ctx.skin;
    if (!engine) {
      ctx.display.warn('Skin engine not wired in this context.');
      return {};
    }
    const target = ctx.rawArgs.trim();

    if (target === 'reload') {
      try {
        await engine.reload();
        ctx.display.success(`Skin reloaded: ${engine.getActive().name}`);
      } catch (err) {
        ctx.display.printError(
          `Skin reload failed: ${err instanceof Error ? err.message : String(err)}`,
          'Check the yaml syntax in your skins directory.',
        );
      }
      return {};
    }

    if (!target) {
      // discover() is idempotent; safe to call on every list.
      try {
        await engine.discover();
      } catch {
        // non-fatal — built-in defaults remain
      }
      const summary = engine.list();
      const current = engine.getActive().name;
      ctx.display.info(`Active skin: ${current}`);
      ctx.display.info('Available skins:');
      for (const s of summary) {
        const marker = s.name === current ? '*' : ' ';
        const tag =
          s.source === 'user'
            ? ' (user)'
            : s.source === 'bundled-yaml'
              ? ' (yaml)'
              : '';
        const desc = s.description ? ` — ${s.description}` : '';
        ctx.display.write(`  ${marker} ${s.name}${tag}${desc}\n`);
      }
      return {};
    }

    // Switch path. Try discovery first so user yaml is recognised.
    try {
      await engine.discover();
    } catch {
      // ignore
    }
    const before = engine.getActive().name;
    const known = engine.listSkins().includes(target);
    if (!known) {
      // Try loading from disk (covers the case where discover missed a file).
      const loaded = await engine.loadSkin(target);
      if (loaded.name === before && before !== target) {
        ctx.display.printError(
          `Unknown skin '${target}'.`,
          'Run /skin to see available names.',
        );
        return {};
      }
      ctx.display.success(`Skin: ${loaded.name}`);
      return {};
    }
    const result = engine.setActive(target);
    if (result.name !== target) {
      ctx.display.printError(
        `Unknown skin '${target}'.`,
        'Run /skin to see available names.',
      );
      return {};
    }
    ctx.display.success(`Skin: ${result.name}`);
    return {};
  },
};
