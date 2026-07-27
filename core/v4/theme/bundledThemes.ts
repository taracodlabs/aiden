/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/theme/bundledThemes.ts — v4.9.0 Slice 1b.
 *
 * Locates the bundled theme YAML files. Themes live at `themes/*.yaml`
 * at the repo root and are included in the published npm artifact via
 * `package.json#files`. This module resolves the on-disk path for
 * each theme name and exposes a tiny API that the `/theme list` and
 * `/theme set` slash commands consume without needing to know the
 * fs layout.
 *
 * Defense-in-depth: if a corrupted install is missing the `themes/`
 * directory entirely, callers fall through gracefully — `getYaml()`
 * returns null, `/theme list` shows zero bundled themes (but still
 * lists any user themes from `~/.aiden/themes/`).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Aiden-native bundled themes shown by `/theme list`. */
export const BUNDLED_NAMES = ['aiden-ember', 'midnight', 'aurora', 'monochrome', 'high-contrast'] as const;
/** Previously shipped identifiers remain resolvable for persisted configuration compatibility. */
export const LEGACY_BUNDLED_NAMES = ['default', 'light', 'tokyo-night', 'dracula'] as const;
export type BundledName = typeof BUNDLED_NAMES[number] | typeof LEGACY_BUNDLED_NAMES[number];

/**
 * Walk up from `__dirname` looking for the repo root that holds the
 * `themes/` directory. Works for:
 *   - tsc tree    (dist/core/v4/theme/bundledThemes.js → walk 3 up)
 *   - esbuild     (dist-bundle/cli.js → walk 1 up)
 *   - source      (core/v4/theme/bundledThemes.ts → walk 3 up via tsx)
 *   - npm install (node_modules/aiden-runtime/dist/... → walk to the
 *                  aiden-runtime root)
 *
 * Returns null when no `themes/` directory is found within 6 ancestors
 * (corrupted install). Callers treat null as "no bundled themes
 * available" and degrade gracefully.
 */
function findThemesDir(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'themes');
    if (existsSync(candidate) && existsSync(path.join(candidate, 'default.yaml'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cachedThemesDir: string | null | undefined;

function themesDir(): string | null {
  if (cachedThemesDir === undefined) cachedThemesDir = findThemesDir();
  return cachedThemesDir;
}

/** Absolute path to a bundled YAML, or null when the themes/ dir is missing. */
export function bundledYamlPath(name: BundledName): string | null {
  const dir = themesDir();
  if (!dir) return null;
  return path.join(dir, `${name}.yaml`);
}

/** Read the YAML for a bundled theme. Returns null on missing-file. */
export function getYaml(name: BundledName): string | null {
  const file = bundledYamlPath(name);
  if (!file || !existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Lightweight summary entry for `/theme list`. */
export interface BundledSummary {
  name:        BundledName;
  description: string;
}

const DESCRIPTIONS: Record<BundledName, string> = {
  'aiden-ember': "Aiden's warm orange identity on a restrained dark surface.",
  midnight:      'Restrained blue and gray accents for low-light terminals.',
  aurora:        'Cool luminous accents with clear semantic contrast.',
  'high-contrast': 'Accessibility-focused contrast and bright state boundaries.',
  default:       "Aiden's signature brand-orange theme on a dark terminal.",
  monochrome:    'Pure greyscale. Semantic accents retained for error/success readability.',
  light:         'Light terminal. Dark text on light background. Brand orange accent.',
  'tokyo-night': 'Inspired by Tokyo Night. Cool nocturnal palette.',
  dracula:       'Inspired by Dracula. High-contrast dark with vivid accents.',
};

/** Enumerate bundled themes. Filters out any that fail to resolve on disk. */
export function listBundled(): BundledSummary[] {
  return BUNDLED_NAMES
    .filter((n) => bundledYamlPath(n) !== null)
    .map((n) => ({ name: n, description: DESCRIPTIONS[n] }));
}

export function isBundled(name: string): name is BundledName {
  return ([...BUNDLED_NAMES, ...LEGACY_BUNDLED_NAMES] as readonly string[]).includes(name);
}

/** Test-only reset of the themes-dir cache. */
export function _resetForTests(): void { cachedThemesDir = undefined; }
