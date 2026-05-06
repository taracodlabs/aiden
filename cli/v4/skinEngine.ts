/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/skinEngine.ts — Aiden v4.0.0 (Phase 14a)
 *
 * Data-driven skin/theme engine for the v4 CLI.
 *
 * A "skin" is a colour + glyph palette referenced by name. The default
 * skin uses the Aiden brand orange (#FF6B35) on dark backgrounds. Two
 * other bundled skins ship: `light` (dark text on light terminals) and
 * `monochrome` (no colour at all — accessibility / pipe / CI).
 *
 * Custom skins live at `<aiden-home>/skins/<name>.yaml` and are loaded
 * lazily on first reference. If a skin file is missing or unparseable,
 * SkinEngine falls back to the default skin and surfaces a warning via
 * the optional `onError` callback.
 *
 * Hermes reference: hermes_cli/skin_engine.py.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

/** Wrap text with a 24-bit ANSI foreground colour. */
function ansiRgb(text: string, r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export type ColorKind =
  | 'brand'
  | 'accent'
  | 'user'
  | 'agent'
  | 'tool'
  | 'error'
  | 'warn'
  | 'success'
  | 'muted'
  | 'heading';

export interface SkinDefinition {
  name: string;
  description: string;
  /** ANSI 24-bit RGB values per kind. `null` means "no colour". */
  colors: Record<ColorKind, [number, number, number] | null>;
  /** Optional glyph overrides used by Display. */
  glyphs?: {
    bullet?: string;
    arrow?: string;
    spinner?: string[];
  };
}

const BRAND_ORANGE: [number, number, number] = [0xff, 0x6b, 0x35];

const DEFAULT_SKIN: SkinDefinition = {
  name: 'default',
  description: 'Aiden brand — orange accent on dark terminal',
  colors: {
    brand: BRAND_ORANGE,
    accent: BRAND_ORANGE,
    user: [0x4e, 0xc9, 0xb0], // teal — user input
    agent: [0xe0, 0xe0, 0xe0], // off-white — agent reply
    tool: [0x9c, 0xdc, 0xfe], // cyan — tool calls
    error: [0xf4, 0x47, 0x47],
    warn: [0xff, 0xc1, 0x07],
    success: [0x4c, 0xaf, 0x50],
    muted: [0x80, 0x80, 0x80],
    heading: BRAND_ORANGE,
  },
  glyphs: {
    bullet: '•',
    arrow: '›',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  },
};

const LIGHT_SKIN: SkinDefinition = {
  name: 'light',
  description: 'Light terminal — dark text on light background',
  colors: {
    brand: [0xc4, 0x42, 0x10],
    accent: [0xc4, 0x42, 0x10],
    user: [0x00, 0x66, 0x55],
    agent: [0x20, 0x20, 0x20],
    tool: [0x00, 0x55, 0x88],
    error: [0xb0, 0x10, 0x10],
    warn: [0x80, 0x60, 0x00],
    success: [0x1b, 0x5e, 0x20],
    muted: [0x60, 0x60, 0x60],
    heading: [0xc4, 0x42, 0x10],
  },
  glyphs: { ...DEFAULT_SKIN.glyphs },
};

const MONOCHROME_SKIN: SkinDefinition = {
  name: 'monochrome',
  description: 'No colour — pipes, CI, accessibility',
  colors: {
    brand: null,
    accent: null,
    user: null,
    agent: null,
    tool: null,
    error: null,
    warn: null,
    success: null,
    muted: null,
    heading: null,
  },
  glyphs: {
    bullet: '*',
    arrow: '>',
    spinner: ['|', '/', '-', '\\'],
  },
};

const BUNDLED: Record<string, SkinDefinition> = {
  default: DEFAULT_SKIN,
  light: LIGHT_SKIN,
  monochrome: MONOCHROME_SKIN,
};

export interface SkinEngineOptions {
  /** Directory to search for user `<name>.yaml` skin files. */
  skinsDir?: string;
  /**
   * Directory holding bundled `<name>.yaml` skins shipped with the package.
   * Defaults to `<repo-root>/skins/`. User-dir files shadow bundled files
   * when both exist. (Phase 16.)
   */
  bundledDir?: string;
  /** Hook invoked when a custom skin fails to load. */
  onError?: (msg: string) => void;
  /**
   * Force colour off even when `process.stdout.isTTY` is true. Useful
   * for tests and `NO_COLOR`-aware deployments.
   */
  forceMono?: boolean;
}

export type SkinSource = 'bundled-builtin' | 'bundled-yaml' | 'user';

export interface SkinSummary {
  name: string;
  description: string;
  source: SkinSource;
  filePath?: string;
}

function defaultBundledDir(): string {
  try {
    const here = __dirname;
    let cursor = here;
    for (let i = 0; i < 6; i++) {
      cursor = path.dirname(cursor);
      const base = path.basename(cursor);
      if (base === 'DevOS' || base === 'aiden') {
        return path.join(cursor, 'skins');
      }
    }
    return path.join(here, '..', '..', 'skins');
  } catch {
    return path.resolve(process.cwd(), 'skins');
  }
}

export class SkinEngine {
  private current: SkinDefinition = DEFAULT_SKIN;
  private readonly skinsDir: string;
  private readonly bundledDir: string;
  private readonly onError?: (msg: string) => void;
  private readonly forceMono: boolean;
  private readonly cache = new Map<string, SkinDefinition>();
  private readonly sourceMap = new Map<string, SkinSource>();
  private readonly fileMap = new Map<string, string>();

  constructor(opts: SkinEngineOptions = {}) {
    this.skinsDir =
      opts.skinsDir ?? path.join(os.homedir(), '.aiden', 'skins');
    this.bundledDir = opts.bundledDir ?? defaultBundledDir();
    this.onError = opts.onError;
    this.forceMono =
      opts.forceMono ??
      (process.env.NO_COLOR != null && process.env.NO_COLOR !== '');
    for (const name of Object.keys(BUNDLED)) {
      this.cache.set(name, BUNDLED[name]);
      this.sourceMap.set(name, 'bundled-builtin');
    }
  }

  /** Return the active skin (read-only snapshot). */
  getActive(): SkinDefinition {
    return this.current;
  }

  /**
   * Load a skin by name. Order:
   *   1. cached / bundled
   *   2. `<skinsDir>/<name>.yaml`
   *   3. fall back to default + emit onError
   * The loaded skin becomes the active skin.
   */
  async loadSkin(name: string): Promise<SkinDefinition> {
    if (this.cache.has(name)) {
      this.current = this.cache.get(name)!;
      return this.current;
    }
    const file = path.join(this.skinsDir, `${name}.yaml`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = yaml.load(raw) as Partial<SkinDefinition> | null;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`skin file ${file} is not an object`);
      }
      const merged: SkinDefinition = {
        name,
        description: parsed.description ?? `Custom skin ${name}`,
        colors: { ...DEFAULT_SKIN.colors, ...(parsed.colors ?? {}) },
        glyphs: { ...DEFAULT_SKIN.glyphs, ...(parsed.glyphs ?? {}) },
      };
      this.cache.set(name, merged);
      this.current = merged;
      return merged;
    } catch (err) {
      this.onError?.(
        `skin '${name}' failed to load: ${
          err instanceof Error ? err.message : String(err)
        } — falling back to default`,
      );
      this.current = DEFAULT_SKIN;
      return DEFAULT_SKIN;
    }
  }

  /** Synchronous switch to a bundled skin by name. */
  setActive(name: string): SkinDefinition {
    const skin = this.cache.get(name);
    if (!skin) {
      this.onError?.(`unknown skin '${name}' — keeping ${this.current.name}`);
      return this.current;
    }
    this.current = skin;
    return skin;
  }

  /**
   * Wrap `text` with the colour mapped to `kind` for the active skin.
   * In monochrome mode, or when the skin defines `null` for the kind,
   * the text is returned unchanged.
   */
  applyColors(text: string, kind: ColorKind): string {
    if (this.forceMono) return text;
    const rgb = this.current.colors[kind];
    if (!rgb) return text;
    return ansiRgb(text, rgb[0], rgb[1], rgb[2]);
  }

  /** List all skin names currently cached (bundled + previously loaded). */
  listSkins(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Scan both `bundledDir` and `skinsDir`, layering disk yaml files on top
   * of the in-memory built-in defaults. User-dir files shadow bundled files
   * with the same name. Idempotent — safe to call multiple times. Returns
   * the merged list. (Phase 16.)
   */
  async discover(): Promise<SkinSummary[]> {
    await this.scanDir(this.bundledDir, 'bundled-yaml');
    await this.scanDir(this.skinsDir, 'user');
    return this.list();
  }

  /** Drop and re-load the active skin's yaml from disk. (Phase 16.) */
  async reload(): Promise<SkinDefinition> {
    const name = this.current.name;
    const builtin = BUNDLED[name];
    this.cache.delete(name);
    this.sourceMap.delete(name);
    this.fileMap.delete(name);
    if (builtin) {
      this.cache.set(name, builtin);
      this.sourceMap.set(name, 'bundled-builtin');
    }
    return this.loadSkin(name);
  }

  /**
   * Rich summary of every cached skin, including source label and file
   * path when known. Sorted alphabetically. (Phase 16.)
   */
  list(): SkinSummary[] {
    const out: SkinSummary[] = [];
    for (const [name, def] of this.cache.entries()) {
      out.push({
        name,
        description: def.description,
        source: this.sourceMap.get(name) ?? 'bundled-builtin',
        filePath: this.fileMap.get(name),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async scanDir(dir: string, source: SkinSource): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.yaml') && !entry.toLowerCase().endsWith('.yml')) {
        continue;
      }
      const filePath = path.join(dir, entry);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = yaml.load(raw) as Partial<SkinDefinition> | null;
        if (!parsed || typeof parsed !== 'object') {
          this.onError?.(`skin file ${filePath} is not a yaml object — skipped`);
          continue;
        }
        const ext = entry.toLowerCase().endsWith('.yml') ? 4 : 5;
        const fallbackName = entry.slice(0, -ext);
        const name = (parsed.name ?? fallbackName).toLowerCase();
        if (!parsed.colors && this.cache.has(name)) {
          // file is missing required `colors` — but a builtin already covers
          // the same name, so just keep the builtin and surface a warning.
          this.onError?.(`skin file ${filePath} missing 'colors' — kept existing definition`);
          continue;
        }
        if (!parsed.colors) {
          this.onError?.(`skin file ${filePath} missing 'colors' — skipped`);
          continue;
        }
        const merged: SkinDefinition = {
          name,
          description: parsed.description ?? `Custom skin ${name}`,
          colors: { ...DEFAULT_SKIN.colors, ...parsed.colors },
          glyphs: { ...DEFAULT_SKIN.glyphs, ...(parsed.glyphs ?? {}) },
        };
        this.cache.set(name, merged);
        this.sourceMap.set(name, source);
        this.fileMap.set(name, filePath);
      } catch (err) {
        this.onError?.(
          `skin file ${filePath} failed to parse: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

/** Module-level singleton for convenience. Tests should construct their own. */
let _global: SkinEngine | null = null;
export function getSkinEngine(opts?: SkinEngineOptions): SkinEngine {
  if (!_global) _global = new SkinEngine(opts);
  return _global;
}
export function resetSkinEngineForTests(): void {
  _global = null;
}
