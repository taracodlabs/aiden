/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/theme.ts — v4.9.0 Slice 1a.
 *
 * `/theme`              show current theme name + path + hint
 * `/theme reload`       force re-read of ~/.aiden/theme.yaml
 * `/theme reset`        delete ~/.aiden/theme.yaml, restore baseline
 * `/theme edit`         print ~/.aiden/theme.yaml path
 *
 * `/theme list` and `/theme set <name>` ship in Slice 1b alongside
 * the remaining 4 bundled themes.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';
import { loadThemeFile, parseThemeYaml } from '../../../core/v4/theme/themeLoader';
import {
  applyTheme,
  resetToDefault,
  getCurrentName,
  getActivePath,
} from '../../../core/v4/theme/themeRegistry';
import {
  listBundled,
  isBundled,
  getYaml,
  BUNDLED_NAMES,
} from '../../../core/v4/theme/bundledThemes';

function themeFilePath(ctx: { paths?: { root?: string } | null }): string | null {
  const root = ctx.paths?.root;
  if (!root) return null;
  return path.join(root, 'theme.yaml');
}

function userThemesDir(ctx: { paths?: { root?: string } | null }): string | null {
  const root = ctx.paths?.root;
  if (!root) return null;
  return path.join(root, 'themes');
}

interface UserThemeSummary { name: string; description: string; }

function listUserThemes(dir: string | null): UserThemeSummary[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => {
        const name = f.replace(/\.yaml$/, '');
        let description = '';
        try {
          const yaml = readFileSync(path.join(dir, f), 'utf8');
          const { parsed } = parseThemeYaml(yaml);
          description = parsed?.description ?? '';
        } catch { /* tolerate unreadable */ }
        return { name, description };
      });
  } catch { return []; }
}

export const theme: SlashCommand = {
  name: 'theme',
  description: 'Show, reload, reset, or open the user theme.yaml.',
  category: 'system',
  icon: '🎨',
  handler: async (ctx) => {
    const sub = ctx.rawArgs.trim();
    const themePath = themeFilePath(ctx as { paths?: { root?: string } | null });

    if (sub === '' || sub === 'show') {
      const current = getCurrentName();
      const displayCurrent = current === 'default' ? 'aiden-ember' : current;
      const active  = getActivePath();
      ctx.display.info(`Active theme: ${displayCurrent}`);
      if (active) {
        ctx.display.info(`Source: ${active}`);
      } else if (themePath) {
        ctx.display.info(`No user theme.yaml at ${themePath} — using bundled default.`);
      }
      ctx.display.info('Use /theme list, /theme set <name>, /theme reload, /theme reset, or /theme edit.');
      return {};
    }

    if (sub === 'list') {
      const current  = getCurrentName();
      const displayCurrent = current === 'default' ? 'aiden-ember' : current;
      const bundled  = listBundled();
      const userDir  = userThemesDir(ctx as { paths?: { root?: string } | null });
      const userList = listUserThemes(userDir);
      ctx.display.info(`Active theme: ${displayCurrent}`);
      ctx.display.info('Available themes:');
      const labelW = Math.max(
        ...bundled.map((b) => b.name.length),
        ...userList.map((u) => u.name.length),
        4,
      );
      for (const b of bundled) {
        const marker = b.name === displayCurrent ? '●' : '○';
        const padded = b.name.padEnd(labelW);
        ctx.display.info(`  ${marker} ${padded}  (bundled)  ${b.description}`);
      }
      for (const u of userList) {
        const marker = u.name === current ? '●' : '○';
        const padded = u.name.padEnd(labelW);
        ctx.display.info(`  ${marker} ${padded}  (user)     ${u.description}`);
      }
      if (bundled.length === 0 && userList.length === 0) {
        ctx.display.warn('No themes found. Reinstall aiden-runtime or use /theme edit to author one.');
      }
      return {};
    }

    const directTheme = isBundled(sub) ? sub : null;
    if (sub.startsWith('set ') || sub === 'set' || directTheme) {
      const name = directTheme ?? sub.replace(/^set\s*/, '').trim();
      if (!name) {
        ctx.display.printError(
          'Usage: /theme set <name>',
          `Try one of: ${BUNDLED_NAMES.join(', ')} or /theme list for full options.`,
        );
        return {};
      }
      if (!themePath) {
        ctx.display.warn('/theme set needs Aiden user-data paths — try in a real session.');
        return {};
      }

      // Resolution order: bundled → user themes/ dir.
      let yamlText: string | null = null;
      let sourceLabel = '';
      if (isBundled(name)) {
        yamlText = getYaml(name);
        sourceLabel = 'bundled';
      }
      if (!yamlText) {
        const userDir = userThemesDir(ctx as { paths?: { root?: string } | null });
        if (userDir) {
          const userFile = path.join(userDir, `${name}.yaml`);
          if (existsSync(userFile)) {
            try {
              yamlText = readFileSync(userFile, 'utf8');
              sourceLabel = 'user';
            } catch { /* fall through to not-found */ }
          }
        }
      }
      if (!yamlText) {
        ctx.display.printError(
          `Theme not found: "${name}"`,
          `Available bundled: ${BUNDLED_NAMES.join(', ')}. Or create ~/.aiden/themes/${name}.yaml.`,
        );
        return {};
      }

      // Copy to ~/.aiden/theme.yaml and apply immediately (don't wait
      // for the chokidar watcher debounce — slash-command-driven
      // changes should feel instant).
      try {
        mkdirSync(path.dirname(themePath), { recursive: true });
        writeFileSync(themePath, yamlText, 'utf8');
      } catch (err) {
        ctx.display.printError(
          `Could not write ${themePath}: ${(err as Error).message}`,
          'Check filesystem permissions and try again.',
        );
        return {};
      }
      const { parsed, warnings } = parseThemeYaml(yamlText);
      for (const w of warnings) ctx.display.warn(`theme: ${w}`);
      if (parsed) {
        applyTheme(parsed, themePath);
        ctx.skin?.setActive('default');
        ctx.display.success(
          `Theme set to ${name} (${sourceLabel}). Run /theme reset to revert to default.`,
        );
      } else {
        ctx.display.printError(
          `Theme "${name}" parsed empty; current theme retained.`,
          'Check the warnings above for the specific YAML / hex error.',
        );
      }
      return {};
    }

    if (sub === 'reload') {
      if (!themePath) {
        ctx.display.warn('/theme reload needs Aiden user-data paths — try in a real session.');
        return {};
      }
      if (!existsSync(themePath)) {
        ctx.display.warn(`No theme file at ${themePath}. Use /theme edit to create one.`);
        return {};
      }
      const { parsed, warnings } = loadThemeFile(themePath);
      for (const w of warnings) ctx.display.warn(`theme: ${w}`);
      if (parsed) {
        applyTheme(parsed, themePath);
        ctx.skin?.setActive('default');
        ctx.display.success(`Theme reloaded: ${parsed.name}`);
      } else {
        ctx.display.printError(
          'Theme parse failed; current theme retained.',
          'Check the warnings above for the specific YAML / hex error.',
        );
      }
      return {};
    }

    if (sub === 'reset') {
      if (!themePath) {
        ctx.display.warn('/theme reset needs Aiden user-data paths — try in a real session.');
        return {};
      }
      if (existsSync(themePath)) {
        try {
          unlinkSync(themePath);
        } catch (err) {
          ctx.display.warn(`Could not delete ${themePath}: ${(err as Error).message}`);
          return {};
        }
      }
      resetToDefault();
      ctx.skin?.setActive('default');
      ctx.display.success('Theme reset to bundled default.');
      return {};
    }

    if (sub === 'edit') {
      if (!themePath) {
        ctx.display.warn('/theme edit needs Aiden user-data paths — try in a real session.');
        return {};
      }
      ctx.display.info(`Theme file: ${themePath}`);
      if (!existsSync(themePath)) {
        ctx.display.info('File does not exist yet. Create it with your editor; Aiden hot-reloads on save.');
      }
      return {};
    }

    ctx.display.printError(
      `Unknown /theme subcommand: ${sub}`,
      'Available: /theme | /theme list | /theme set <name> | /theme reload | /theme reset | /theme edit',
    );
    return {};
  },
};
