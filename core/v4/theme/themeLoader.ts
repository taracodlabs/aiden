/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/theme/themeLoader.ts — v4.9.0 Slice 1a.
 *
 * YAML parser + validator for user theme files. Permissive by design:
 * a malformed file or invalid field warns and falls back per-field
 * rather than rejecting the entire theme. Aiden must keep running
 * with a sensible visual even if the user's theme.yaml has typos.
 *
 * Wire format (hex strings throughout — see also the legacy
 * `skins/*.yaml` format which uses RGB tuples; the two systems
 * deliberately use distinct formats so users can tell which file
 * goes with which slash command):
 *
 *   name: "my-theme"
 *   description: "..."
 *   inherits: null  # or a bundled theme name
 *   colors:
 *     brand: { primary: "#FF6B35", muted: "#7a3119" }
 *     # ... etc
 *   glyphs:
 *     panel: { bar: "│" }
 *     trail: { gutter: "┊" }
 *     # ... etc
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import type { ParsedTheme } from './themeRegistry';

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface LoadResult {
  parsed:   ParsedTheme | null;
  warnings: string[];
}

/**
 * Parse a YAML string into a ParsedTheme. Returns `parsed: null`
 * only on top-level YAML parse failure (in which case the caller
 * should keep the current theme). Otherwise returns the best-effort
 * parse with per-field warnings; bad fields are silently dropped
 * from the override maps so the baseline shows through.
 */
export function parseThemeYaml(text: string): LoadResult {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (err) {
    warnings.push(`YAML parse error: ${(err as Error).message}`);
    return { parsed: null, warnings };
  }
  // v4.9.0 Slice 1a hotfix — `yaml.load('')` returns `undefined` for
  // an empty file. That's a benign transient state — the user just
  // created theme.yaml via /theme edit and hasn't typed content yet,
  // OR they cleared the file before retyping. Don't surface a warning
  // for that case; just signal "no theme parsed" and let the caller
  // keep the current theme active.
  if (doc === undefined || doc === null) {
    return { parsed: null, warnings };
  }
  if (typeof doc !== 'object') {
    warnings.push('Theme root must be a mapping; got ' + typeof doc);
    return { parsed: null, warnings };
  }
  const root = doc as Record<string, unknown>;
  const name = typeof root.name === 'string' && root.name.trim().length > 0
    ? root.name.trim()
    : 'custom';
  const description = typeof root.description === 'string'
    ? root.description
    : undefined;

  const colorOverrides: Record<string, string> = {};
  collectStringPaths(root.colors, 'colors', colorOverrides, warnings, (value, path) => {
    if (!HEX_RE.test(value)) {
      warnings.push(`Invalid hex at ${path}: "${value}" (expected #RGB or #RRGGBB); falling back to default.`);
      return null;
    }
    return value;
  });

  const glyphOverrides: Record<string, string> = {};
  collectStringPaths(root.glyphs, 'glyphs', glyphOverrides, warnings, (value /* , path */) => {
    // Glyphs are free-form strings — no validation beyond "is a string".
    return value;
  });

  // The dotted paths returned by collectStringPaths include the
  // `colors.` / `glyphs.` prefix. Strip those so the registry can
  // write directly into the `colors` / `glyphs` singletons.
  const colorOverridesStripped: Record<string, string> = {};
  for (const [k, v] of Object.entries(colorOverrides)) {
    colorOverridesStripped[k.replace(/^colors\./, '')] = v;
  }
  const glyphOverridesStripped: Record<string, string> = {};
  for (const [k, v] of Object.entries(glyphOverrides)) {
    glyphOverridesStripped[k.replace(/^glyphs\./, '')] = v;
  }

  return {
    parsed: {
      name,
      description,
      colorOverrides: colorOverridesStripped,
      glyphOverrides: glyphOverridesStripped,
    },
    warnings,
  };
}

/**
 * Load + parse a theme file from disk. Returns `{ parsed: null }`
 * on missing-file or read-error so the caller can degrade gracefully.
 */
export function loadThemeFile(filepath: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(filepath, 'utf8');
  } catch (err) {
    return {
      parsed: null,
      warnings: [`Could not read theme file ${filepath}: ${(err as Error).message}`],
    };
  }
  return parseThemeYaml(text);
}

/**
 * Walk `node` recursively. For every string leaf, call `transform`
 * to optionally validate / normalise it. If `transform` returns null
 * the leaf is dropped (validation failure). Non-string non-object
 * leaves trigger a warning and are dropped.
 */
function collectStringPaths(
  node:        unknown,
  pathSoFar:   string,
  out:         Record<string, string>,
  warnings:    string[],
  transform:   (value: string, path: string) => string | null,
): void {
  if (node === undefined || node === null) return;
  if (typeof node !== 'object') {
    warnings.push(`Expected object at ${pathSoFar}; got ${typeof node}`);
    return;
  }
  if (Array.isArray(node)) {
    warnings.push(`Array not supported at ${pathSoFar}`);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const childPath = `${pathSoFar}.${k}`;
    if (typeof v === 'string') {
      const value = transform(v, childPath);
      if (value !== null) out[childPath] = value;
    } else if (typeof v === 'object' && v !== null) {
      collectStringPaths(v, childPath, out, warnings, transform);
    } else {
      warnings.push(`Unsupported leaf type at ${childPath}: ${typeof v}`);
    }
  }
}
