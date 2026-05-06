/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillBundledManifest.ts — Aiden v4.0.0
 *
 * Tracks which skills shipped with Aiden vs. were added/modified by
 * the user. Lives at `paths.bundledManifest` as a single JSON file:
 *
 *   {
 *     "<skill-name>": {
 *       "hash": "sha256-of-SKILL.md-at-install",
 *       "userModified": false,
 *       "installedAt": 1714780000000,
 *       "source"?: "builtin" | "github:org/repo" | ...
 *     }
 *   }
 *
 * Used by:
 *   - SkillLoader.list()       — userModified flag.
 *   - SkillsHub.install()      — refuses to overwrite user-modified
 *                                skills without `force`.
 *   - SkillsHub.reset()        — restores bundled hash on reset.
 *   - aiden skills list/audit  — surfaces drift to the user.
 *
 * Atomic writes via fs.rename. In-process serialisation via a single
 * write queue prevents JSON corruption from concurrent calls.
 *
 * Status: PHASE 10.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { AidenPaths } from './paths';

export interface ManifestEntry {
  hash: string;
  userModified: boolean;
  installedAt: number;
  source?: string;
}

export type ManifestRecord = Record<string, ManifestEntry>;

export class BundledManifest {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: AidenPaths) {}

  /** Walk a bundled-skills directory, hash every SKILL.md, write
   *  the manifest. Idempotent: existing entries are NOT overwritten,
   *  so a user who modified a skill before this method ran keeps
   *  their userModified=true flag across subsequent boots. */
  async initialize(bundledSkillsDir: string): Promise<void> {
    const existing = await this.read();
    const next: ManifestRecord = { ...existing };
    const now = Date.now();

    let entries: string[] = [];
    try {
      entries = await fs.readdir(bundledSkillsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }

    for (const entry of entries) {
      const dir = path.join(bundledSkillsDir, entry);
      const skillFile = path.join(dir, 'SKILL.md');
      let stat;
      try {
        stat = await fs.stat(skillFile);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const content = await fs.readFile(skillFile, 'utf-8');
      const hash = sha256(content);
      if (!next[entry]) {
        next[entry] = {
          hash,
          userModified: false,
          installedAt: now,
          source: 'builtin',
        };
      }
    }

    await this.write(next);
  }

  async read(): Promise<ManifestRecord> {
    try {
      const text = await fs.readFile(this.paths.bundledManifest, 'utf-8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as ManifestRecord;
      }
      return {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  async get(skillName: string): Promise<ManifestEntry | null> {
    const record = await this.read();
    return record[skillName] ?? null;
  }

  /** Compare on-disk SKILL.md content against the recorded hash. */
  async isUserModified(skillName: string): Promise<boolean> {
    const entry = await this.get(skillName);
    if (!entry) return false;
    if (entry.userModified) return true;
    const skillPath = path.join(
      this.paths.skillsDir,
      skillName,
      'SKILL.md',
    );
    let content: string;
    try {
      content = await fs.readFile(skillPath, 'utf-8');
    } catch {
      return false;
    }
    return sha256(content) !== entry.hash;
  }

  async markUserModified(skillName: string): Promise<void> {
    return this.update(skillName, (e) => ({ ...e, userModified: true }));
  }

  async upsert(skillName: string, patch: Partial<ManifestEntry>): Promise<void> {
    return this.serialised(async () => {
      const record = await this.read();
      const prev = record[skillName] ?? {
        hash: '',
        userModified: false,
        installedAt: Date.now(),
      };
      record[skillName] = { ...prev, ...patch };
      await this.writeNow(record);
    });
  }

  /** Reset the manifest entry to "not user-modified" and refresh
   *  the recorded hash from current disk content. The actual file
   *  restoration (if `restore: true`) is the caller's job — this
   *  method just clears the modification flag. */
  async reset(skillName: string): Promise<void> {
    const skillPath = path.join(
      this.paths.skillsDir,
      skillName,
      'SKILL.md',
    );
    let hash = '';
    try {
      const content = await fs.readFile(skillPath, 'utf-8');
      hash = sha256(content);
    } catch {
      /* entry may already be gone */
    }
    await this.update(skillName, (e) => ({ ...e, userModified: false, hash: hash || e.hash }));
  }

  async remove(skillName: string): Promise<void> {
    return this.serialised(async () => {
      const record = await this.read();
      delete record[skillName];
      await this.writeNow(record);
    });
  }

  // ── Internals ───────────────────────────────────────────────

  private async update(
    skillName: string,
    transform: (entry: ManifestEntry) => ManifestEntry,
  ): Promise<void> {
    return this.serialised(async () => {
      const record = await this.read();
      const prev = record[skillName] ?? {
        hash: '',
        userModified: false,
        installedAt: Date.now(),
      };
      record[skillName] = transform(prev);
      await this.writeNow(record);
    });
  }

  /** Writes the record without serialising — caller must already
   *  hold the write queue (used inside `upsert` / `update`). */
  private async writeNow(record: ManifestRecord): Promise<void> {
    await atomicWrite(this.paths.bundledManifest, JSON.stringify(record, null, 2));
  }

  private write(record: ManifestRecord): Promise<void> {
    return this.serialised(() => this.writeNow(record));
  }

  /** Serialise read-modify-write cycles so concurrent calls don't
   *  step on each other. */
  private serialised<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, filePath);
}
