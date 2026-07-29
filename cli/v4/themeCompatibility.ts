/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getYaml } from '../../core/v4/theme/bundledThemes';
import { loadThemeFile, parseThemeYaml } from '../../core/v4/theme/themeLoader';
import { applyTheme, resetToDefault } from '../../core/v4/theme/themeRegistry';
import type { SkinEngine } from './skinEngine';

const LEGACY_THEME_MAP: Readonly<Record<string, string>> = Object.freeze({
  default: 'aiden-ember',
  monochrome: 'monochrome',
  light: 'light',
});

export interface EffectiveThemeInitialization {
  name: string;
  source: 'theme-file' | 'legacy-migration' | 'bundled-default';
  themePath: string;
  persisted: boolean;
}

/** Resolve persisted visual state before any interactive startup output. */
export function initializeEffectiveTheme(
  root: string,
  legacySkin: string | null | undefined,
  skin: SkinEngine,
): EffectiveThemeInitialization {
  const themePath = path.join(root, 'theme.yaml');
  skin.setActive('default');

  if (existsSync(themePath)) {
    const { parsed } = loadThemeFile(themePath);
    if (parsed) {
      applyTheme(parsed, themePath);
      return { name: parsed.name, source: 'theme-file', themePath, persisted: true };
    }
  }

  const legacy = (legacySkin ?? 'default').trim().toLowerCase();
  const name = LEGACY_THEME_MAP[legacy] ?? 'aiden-ember';
  const yamlText = getYaml(name as 'aiden-ember' | 'monochrome' | 'light');
  const parsed = yamlText ? parseThemeYaml(yamlText).parsed : null;
  if (!parsed) {
    resetToDefault();
    return { name: 'aiden-ember', source: 'bundled-default', themePath, persisted: false };
  }

  if (legacy !== 'default' && LEGACY_THEME_MAP[legacy]) {
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(themePath, yamlText!, 'utf8');
      applyTheme(parsed, themePath);
      return { name: parsed.name, source: 'legacy-migration', themePath, persisted: true };
    } catch {
      applyTheme(parsed, null);
      return { name: parsed.name, source: 'legacy-migration', themePath, persisted: false };
    }
  }

  applyTheme(parsed, null);
  return { name: parsed.name, source: 'bundled-default', themePath, persisted: false };
}
