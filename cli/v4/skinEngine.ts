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
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

// v4.9.0 Slice 1a hotfix — read live theme overrides from tokens.ts.
import { colors as liveColors } from './design/tokens';
import { getActivePath as getActiveThemePath } from '../../core/v4/theme/themeRegistry';

/** Wrap text with a 24-bit ANSI foreground colour. */
function ansiRgb(text: string, r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/**
 * v4.9.0 Slice 1a hotfix — map each SkinEngine `ColorKind` to a dotted
 * path inside the v4.8 `tokens.ts` colour tree so the legacy paint API
 * (`applyColors(text, kind)`) can resolve user-theme overrides without
 * touching the legacy skin YAML cache. Each kind picks the closest
 * semantic equivalent from the new tree; kinds without a natural fit
 * (e.g. `agent`, `user`) fall through to the skin's own RGB tuple.
 *
 * The lookup is only consulted when a user theme is active (i.e.
 * `getActiveThemePath() !== null`). When no theme is loaded, the
 * legacy skin path runs unchanged — preserves /skin custom-palette
 * users from being silently overridden by tokens.ts baselines.
 */
const COLOR_KIND_TO_TOKEN_PATH: Partial<Record<string, string>> = {
  brand:       'brand.primary',
  accent:      'brand.primary',
  heading:     'brand.primary',
  tool:        'metrics.model',
  session:     'metrics.model',
  error:       'semantic.error',
  warn:        'semantic.warn',
  success:     'semantic.success',
  muted:       'content.secondary',
  tertiary:    'content.tertiary',
  metric_turn: 'metrics.turnCount',
  degraded:    'semantic.warn',
};

function hexToRgb(hex: string): [number, number, number] | null {
  const m3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(hex);
  if (m3) return [parseInt(m3[1] + m3[1], 16), parseInt(m3[2] + m3[2], 16), parseInt(m3[3] + m3[3], 16)];
  const m6 = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
  return null;
}

function readDottedPath(root: unknown, dotted: string): unknown {
  let node: unknown = root;
  for (const seg of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
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
  | 'heading'
  /** Cyan — session IDs, session-end card labels. v4.1.3-repl-polish. */
  | 'session'
  /** Yellow — degraded tool outcomes (best-effort, partial result). v4.1.3-repl-polish. */
  | 'degraded'
  /** Purple — status footer turn counter (⌘). v4.8.0 Slice 7 hotfix #2. */
  | 'metric_turn'
  /** Dim cool grey — least-important text (unchecked task glyphs,
   *  deprecated rows, captions). v4.8.0 Slice 8 — bridges
   *  `colors.content.tertiary` from tokens.ts into runtime. */
  | 'tertiary';

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
    // v4.1.4 reply-quality polish: muted shifts from neutral grey
    // (#888888) to warm Aiden-tinted dim (#b8a89a). Mid-grey at +56
    // brightness on red/green channels with a slight cool-down on
    // blue, putting muted in the same warm family as brand orange
    // (#FF6B35) without competing with it. Reads as "intentional
    // dim" rather than washed-out terminal grey. Used by tool-trail
    // gutter, status footer, code-block rail, blockquote rail, and
    // display.dim() — surfaces the user reads constantly.
    muted: [0xb8, 0xa8, 0x9a],
    heading: BRAND_ORANGE,
    // v4.1.3-repl-polish: session = soft cyan (ex-muted); used for IDs
    // and the session-end card header labels.
    session: [0x6f, 0xb3, 0xd2],
    // v4.1.3-repl-polish: degraded = amber yellow; distinct from warn
    // (which shares the colour) so callers can differentiate in code
    // even though they render identically.
    degraded: [0xff, 0xc1, 0x07],
    // v4.8.0 Slice 7 hotfix #2 — purple accent for the turn-counter
    // segment (⌘) in the status footer. #a48be0 reads as a soft
    // lavender that doesn't compete with brand orange.
    metric_turn: [0xa4, 0x8b, 0xe0],
    // v4.8.0 Slice 8 — tertiary dim grey, dimmer than `muted` (warm
    // tint) for lowest-priority text like unchecked task markers.
    tertiary: [0x6a, 0x6a, 0x6a],
  },
  glyphs: {
    bullet: '•',
    arrow: '›',
    // Tier-3.1 (v4.1-tier3.1): replaced the generic braille spinner
    // with a custom Aiden frame set derived from the ▲ prompt glyph.
    // Six-frame rotating-triangle cadence reads as motion at the
    // standard ~80ms tick without depending on colour, so it works
    // identically under monochrome forks of this skin.
    spinner: ['▲', '△', '▴', '▵', '▴', '△'],
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
    // v4.1.4 reply-quality polish: proportional warm-shift for the
    // light skin too. Was neutral #606060; new value #7a6e5e keeps the
    // dark-on-light contrast budget but adds the same warm tint as the
    // default skin's muted so themed surfaces feel coherent across
    // skin switches.
    muted: [0x7a, 0x6e, 0x5e],
    heading: [0xc4, 0x42, 0x10],
    session: [0x00, 0x55, 0x88],
    degraded: [0x80, 0x60, 0x00],
    // Slice 7 hotfix #2 — deeper purple on light bg keeps contrast budget.
    metric_turn: [0x6e, 0x50, 0xaa],
    // Slice 8 — lighter grey on light bg keeps the dim-but-readable feel.
    tertiary: [0x9a, 0x9a, 0x9a],
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
    session: null,
    degraded: null,
    metric_turn: null,
    tertiary: null,
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
    // Tier-3-essentials: 'auto' resolves to a concrete skin via the
    // multi-signal detector (AIDEN_THEME / NO_COLOR / COLORFGBG /
    // TERM_PROGRAM, falling back to 'default'). Resolves once per
    // call — caller can re-invoke loadSkin('auto') if env changes.
    if (name === 'auto') {
      // Lazy import keeps the skin loader free of detector deps in
      // synchronous test paths that bypass loadSkin.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { detectTheme, detectedToSkinName } = require('./themeDetect');
      const detected = detectTheme();
      const resolved = detectedToSkinName(detected);
      // Re-enter loadSkin with the resolved name (no infinite loop —
      // the detector never returns 'auto').
      return this.loadSkin(resolved);
    }
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
    // v4.9.0 Slice 1a hotfix — when a user theme is active, resolve
    // the colour from the live tokens.ts tree FIRST. This lets a
    // ~/.aiden/theme.yaml override every paint surface that routes
    // through SkinEngine (Aiden reply chrome, panel bars, status
    // footer text, tool rows) without requiring users to also
    // re-author a parallel ~/.aiden/skins/<name>.yaml. When no user
    // theme is active, the legacy skin RGB path runs unchanged —
    // preserves /skin custom-palette users from regression.
    if (getActiveThemePath() !== null) {
      const dotted = COLOR_KIND_TO_TOKEN_PATH[kind];
      if (dotted) {
        const hex = readDottedPath(liveColors, dotted);
        if (typeof hex === 'string') {
          const rgb = hexToRgb(hex);
          if (rgb) return ansiRgb(text, rgb[0], rgb[1], rgb[2]);
        }
      }
    }
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
