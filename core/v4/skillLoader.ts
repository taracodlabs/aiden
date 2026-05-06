/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillLoader.ts — Aiden v4.0.0
 *
 * Walks `paths.skillsDir` and loads every SKILL.md it finds. Two
 * layouts are supported:
 *
 *   skills/<skill-name>/SKILL.md          (preferred — one dir per skill,
 *                                          may include reference files)
 *   skills/<skill-name>.md                (single-file skill — v3 has 4
 *                                          of these: code_interpreter,
 *                                          folder_watch, social_research,
 *                                          system_control)
 *
 * Malformed SKILL.md files are SKIPPED and logged via the optional
 * file-only `AidenFileLogger` (Phase 16b.2). Before 16b.2 the warnings
 * went to `console.warn` and corrupted the REPL spinner on every turn.
 *
 * Caching (Phase 16b.2):
 *   `loadAll()` caches its result on the instance after the first scan.
 *   Subsequent calls return the cached array without touching disk. Tests
 *   that mutate the skills dir between calls must `invalidate()` to force
 *   a re-scan; the runtime path scans exactly once at boot.
 *
 * Status: PHASE 10, cache + file logger added Phase 16b.2.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from './paths';
import {
  parseSkillContent,
  type ParsedSkill,
} from './skillSpec';
import {
  createNullLogger,
  type AidenFileLogger,
} from './aidenLogger';

export interface SkillSummary {
  name: string;
  description: string;
  version: string;
  category?: string;
  trustLevel?: string;
  userModified?: boolean;
  filePath: string;
}

export interface SkillLoaderOptions {
  /** Optional in-memory diagnostic sink (overrides the file logger). */
  log?: (level: 'warn' | 'info', msg: string) => void;
  /** File-only logger that receives malformed-skill warnings. */
  logger?: AidenFileLogger;
}

/** Counts surfaced for the boot summary line. */
export interface SkillScanCounts {
  loaded: number;
  skipped: number;
  /** Absolute paths of skipped files (for `logs/skills.log` cross-ref). */
  skippedPaths: string[];
}

export class SkillLoader {
  private cache: ParsedSkill[] | null = null;
  private lastCounts: SkillScanCounts = { loaded: 0, skipped: 0, skippedPaths: [] };
  private readonly logger: AidenFileLogger;

  constructor(
    private readonly paths: AidenPaths,
    private readonly options: SkillLoaderOptions = {},
  ) {
    this.logger = options.logger ?? createNullLogger();
  }

  /** Walk skills/ and load every parseable SKILL.md (or single-file
   *  `<name>.md`). Unparseable files are skipped; one bad skill
   *  never breaks the others.
   *
   *  Result is cached after the first call. Use `invalidate()` to force
   *  a re-scan (tests, hot-reload, future `/skills reload`). */
  async loadAll(): Promise<ParsedSkill[]> {
    if (this.cache !== null) return this.cache;
    const scan = await this.scanDisk();
    this.cache = scan.skills;
    this.lastCounts = {
      loaded: scan.skills.length,
      skipped: scan.skipped.length,
      skippedPaths: scan.skipped,
    };
    return this.cache;
  }

  /** Force the next `loadAll()` call to re-scan disk. */
  invalidate(): void {
    this.cache = null;
  }

  /** Counts from the last `loadAll()` (or zeros if never called). */
  getLastCounts(): SkillScanCounts {
    return { ...this.lastCounts, skippedPaths: [...this.lastCounts.skippedPaths] };
  }

  async load(name: string): Promise<ParsedSkill | null> {
    // Honour the cache when available so we don't re-walk for a
    // single-skill lookup. Falls through to disk on a miss so newly
    // dropped skills still resolve in long-running processes (the cache
    // never sees them otherwise — that's the whole point of `invalidate`).
    if (this.cache) {
      const hit = this.cache.find((s) => s.frontmatter.name === name);
      if (hit) return hit;
    }
    const dirSkill = path.join(this.paths.skillsDir, name, 'SKILL.md');
    const fileSkill = path.join(this.paths.skillsDir, `${name}.md`);
    return (await this.tryParse(dirSkill)) ?? (await this.tryParse(fileSkill));
  }

  async list(): Promise<SkillSummary[]> {
    const skills = await this.loadAll();
    return skills.map((s) => ({
      name: s.frontmatter.name,
      description: s.frontmatter.description,
      version: s.frontmatter.version,
      category: s.frontmatter.category ?? s.frontmatter.metadata?.aiden?.category,
      trustLevel: s.frontmatter._trustLevel,
      userModified: undefined, // SkillLoader doesn't know; BundledManifest does.
      filePath: s.filePath,
    }));
  }

  /** Read a reference file inside a skill's directory. Used by
   *  `skill_view` for progressive-disclosure level 2. */
  async readSkillFile(skillName: string, relativePath: string): Promise<string> {
    const skillDir = path.join(this.paths.skillsDir, skillName);
    // Refuse path traversal: resolve, then check it stays inside skillDir.
    const target = path.resolve(skillDir, relativePath);
    const resolvedDir = path.resolve(skillDir);
    if (!target.startsWith(resolvedDir + path.sep) && target !== resolvedDir) {
      throw new Error(
        `Path traversal refused: ${relativePath} escapes skill directory`,
      );
    }
    return fs.readFile(target, 'utf-8');
  }

  // ── Internals ───────────────────────────────────────────────

  /** Walk the skills dir once. Pure I/O — caching layered above. */
  private async scanDisk(): Promise<{ skills: ParsedSkill[]; skipped: string[] }> {
    const skills: ParsedSkill[] = [];
    const skipped: string[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.paths.skillsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { skills, skipped };
      }
      throw e;
    }
    for (const entry of entries) {
      const entryPath = path.join(this.paths.skillsDir, entry);
      let stat;
      try {
        stat = await fs.stat(entryPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const skillFile = path.join(entryPath, 'SKILL.md');
        const result = await this.tryParseTracked(skillFile);
        if (result.parsed) skills.push(result.parsed);
        else if (result.attempted) skipped.push(skillFile);
      } else if (stat.isFile() && entry.toLowerCase().endsWith('.md')) {
        const lc = entry.toLowerCase();
        if (lc === 'aiden_catalog.md' || lc === 'skill_template.md') continue;
        const result = await this.tryParseTracked(entryPath);
        if (result.parsed) skills.push(result.parsed);
        else if (result.attempted) skipped.push(entryPath);
      }
    }
    return { skills, skipped };
  }

  /** Internal variant that distinguishes "file not present" (`attempted=false`)
   *  from "file present but malformed" (`attempted=true, parsed=null`).
   *  Only the latter counts as a skip. */
  private async tryParseTracked(
    filePath: string,
  ): Promise<{ parsed: ParsedSkill | null; attempted: boolean }> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      return { parsed: null, attempted: false };
    }
    try {
      return { parsed: parseSkillContent(raw, filePath), attempted: true };
    } catch (e) {
      const msg = `Skipping malformed skill at ${filePath}: ${(e as Error).message}`;
      // In-memory sink wins when explicitly provided (kept for
      // backwards-compat with tests that use `options.log`).
      if (this.options.log) this.options.log('warn', msg);
      else this.logger.warn(`[SkillLoader] ${msg}`);
      return { parsed: null, attempted: true };
    }
  }

  /** Public wrapper retained for `load(name)` so single-skill lookups can
   *  surface a parse error too. */
  private async tryParse(filePath: string): Promise<ParsedSkill | null> {
    const r = await this.tryParseTracked(filePath);
    return r.parsed;
  }
}
