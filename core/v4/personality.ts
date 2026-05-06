/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/personality.ts — Aiden v4.0.0 (Phase 16a)
 *
 * Personality overlay manager. A "personality" is a markdown file with a
 * YAML-ish frontmatter block (`name`, `description`) and a freeform body.
 * The body is layered on top of `SOUL.md` via `PromptBuilder`'s slot 2
 * (already wired in Phase 13). Switching personality mid-session just
 * swaps which body the next prompt build pulls from.
 *
 * Layout:
 *   - bundled : <repo-root>/personalities/<name>.md  (ships with the package)
 *   - user    : <aidenPaths.personalitiesDir>/<name>.md (custom overlays)
 *
 * User overlays of the same name shadow bundled ones. The "default"
 * personality has an empty body — it represents "use SOUL.md as-is."
 *
 * Hermes reference: Hermes uses `agent/prompt_builder.py` overlays without
 * a dedicated personality module; Aiden makes the surface explicit because
 * /personality is a documented v4 UX feature.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from './paths';

export type PersonalitySource = 'bundled' | 'user';

export interface PersonalityFile {
  /** Canonical lowercase name, derived from filename. */
  name: string;
  /** One-line summary from frontmatter. */
  description: string;
  /** Markdown overlay body (frontmatter stripped). May be empty for `default`. */
  body: string;
  source: PersonalitySource;
  /** Absolute path on disk; absent only for synthetic in-memory tests. */
  filePath?: string;
}

export interface PersonalityManagerOptions {
  paths: AidenPaths;
  /**
   * Override the bundled personalities directory. Tests use this to point
   * at a fixture tree; production uses the repo's `personalities/` dir
   * resolved via `import.meta.url`.
   */
  bundledDir?: string;
  /**
   * Initial active personality. Defaults to `'default'`. If the named
   * personality doesn't exist at construction time, `getCurrent()` still
   * returns this name but `getActiveOverlay()` returns the empty string.
   */
  initialCurrent?: string;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const trimmed = raw.replace(/^﻿/, '');
  const match = FRONTMATTER_RE.exec(trimmed);
  if (!match) {
    return { body: trimmed.trim() };
  }
  const [, header, rest] = match;
  let name: string | undefined;
  let description: string | undefined;
  for (const line of header.split(/\r?\n/)) {
    const eq = line.indexOf(':');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
  }
  return { name, description, body: rest.trim() };
}

function defaultBundledDir(): string {
  // Resolve `<repo-root>/personalities/` based on this module's location.
  // Compiled output sits in dist/ — we walk up until we find personalities/.
  try {
    const here = __dirname;
    let cursor = here;
    for (let i = 0; i < 6; i++) {
      cursor = path.dirname(cursor);
      const base = path.basename(cursor);
      if (base === 'DevOS' || base === 'aiden') {
        return path.join(cursor, 'personalities');
      }
    }
    return path.join(here, '..', '..', 'personalities');
  } catch {
    return path.resolve(process.cwd(), 'personalities');
  }
}

export class PersonalityManager {
  private readonly paths: AidenPaths;
  private readonly bundledDir: string;
  private current: string;
  private cache: Map<string, PersonalityFile> | null = null;

  constructor(opts: PersonalityManagerOptions) {
    this.paths = opts.paths;
    this.bundledDir = opts.bundledDir ?? defaultBundledDir();
    this.current = (opts.initialCurrent ?? 'default').toLowerCase();
  }

  /** Drop the in-memory cache so the next read re-scans both dirs. */
  invalidate(): void {
    this.cache = null;
  }

  /** Load all bundled and user personalities; user wins on name collision. */
  async loadAll(): Promise<PersonalityFile[]> {
    if (this.cache) return [...this.cache.values()];
    const map = new Map<string, PersonalityFile>();
    for (const file of await this.scanDir(this.bundledDir, 'bundled')) {
      map.set(file.name, file);
    }
    for (const file of await this.scanDir(this.paths.personalitiesDir, 'user')) {
      // user wins
      map.set(file.name, file);
    }
    this.cache = map;
    return [...map.values()];
  }

  async get(name: string): Promise<PersonalityFile | null> {
    const all = await this.loadAll();
    const lower = name.toLowerCase();
    return all.find((p) => p.name === lower) ?? null;
  }

  async list(): Promise<
    Array<{ name: string; description: string; source: PersonalitySource }>
  > {
    const all = await this.loadAll();
    return all
      .map((p) => ({
        name: p.name,
        description: p.description,
        source: p.source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getCurrent(): string {
    return this.current;
  }

  async setCurrent(name: string): Promise<{ ok: boolean; reason?: string }> {
    const lower = name.toLowerCase();
    const found = await this.get(lower);
    if (!found) {
      return { ok: false, reason: `Unknown personality '${name}'` };
    }
    this.current = lower;
    return { ok: true };
  }

  async getActiveOverlay(): Promise<string> {
    const found = await this.get(this.current);
    if (!found) return '';
    return found.body;
  }

  private async scanDir(
    dir: string,
    source: PersonalitySource,
  ): Promise<PersonalityFile[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: PersonalityFile[] = [];
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const filePath = path.join(dir, entry);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(raw);
      const fallbackName = entry.slice(0, -3).toLowerCase();
      const name = (fm.name ?? fallbackName).toLowerCase();
      out.push({
        name,
        description: fm.description ?? '',
        body: fm.body,
        source,
        filePath,
      });
    }
    return out;
  }
}
