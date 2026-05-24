/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillsHub.ts — Aiden v4.0.0
 *
 * Skill installer + remote-source resolver. Eight identifier
 * formats parse here:
 *
 *   official/<category>/<name>           → 'official'
 *   agentskills.io/<...>                 → 'agentskills'
 *   skills-sh/<org>/<name>               → 'skills-sh'
 *   well-known:<url>                     → 'well-known'
 *   <org>/<repo>/<skill?>  (3+ slashes)  → 'github'
 *   https?://<...>                       → 'url'
 *   clawhub.ai/<...>                     → 'clawhub'
 *   anthropics/<...> (2 slashes)         → 'claude-marketplace'
 *
 * Phase 10 ships full install for `github`, `url`, `well-known` —
 * the rest stub-throw with "Phase 14" so the parse layer is
 * complete and the install code paths are exercisable now without
 * needing live registry servers.
 *
 * Status: PHASE 10.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { AidenPaths } from './paths';
import type { ParsedSkill } from './skillSpec';
import { parseSkillContent, validateAttribution } from './skillSpec';
import { SkillSecurityScanner } from './skillSecurityScanner';
import { BundledManifest } from './skillBundledManifest';
// v4.9.5 Slice 1 — curated-skill manifest fetch + resolution.
import {
  fetchCuratedManifest,
  type CuratedManifestEntry,
  type FetchImpl as ManifestFetchImpl,
} from './skills/curatedManifest';
import type {
  HubSource,
  HubSearchResult,
  HubSourceType,
} from './skillsHubTypes';

export type { HubSource, HubSearchResult, HubSourceType };

export type FetchFn = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SkillsHubOptions {
  /** Override the fetch implementation — tests use this to mock
   *  hub responses without hitting the network. */
  fetch?: FetchFn;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  warnings?: string[];
  skill?: ParsedSkill;
  installPath?: string;
}

const NOT_IMPLEMENTED =
  'Hub source not implemented in Phase 10 — lands in Phase 14 (`aiden skills` CLI).';

export class SkillsHub {
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly paths: AidenPaths,
    private readonly security: SkillSecurityScanner,
    private readonly manifest: BundledManifest,
    options: SkillsHubOptions = {},
  ) {
    this.fetchFn =
      options.fetch ??
      ((url: string) => fetch(url) as unknown as ReturnType<FetchFn>);
  }

  parseSource(identifier: string): HubSource {
    const id = identifier.trim();
    if (!id) throw new Error('Empty identifier');

    if (/^https?:\/\//i.test(id)) {
      return { type: 'url', url: id };
    }
    if (/^well-known:/i.test(id)) {
      return { type: 'well-known', url: id.slice('well-known:'.length) };
    }
    if (/^official\//i.test(id)) {
      return { type: 'official', identifier: id.slice('official/'.length) };
    }
    if (/^agentskills(\.io)?\//i.test(id)) {
      return {
        type: 'agentskills',
        identifier: id.replace(/^agentskills(\.io)?\//i, ''),
      };
    }
    if (/^skills-sh\//i.test(id)) {
      return { type: 'skills-sh', identifier: id.slice('skills-sh/'.length) };
    }
    if (/^clawhub(\.ai)?\//i.test(id)) {
      return {
        type: 'clawhub',
        identifier: id.replace(/^clawhub(\.ai)?\//i, ''),
      };
    }
    const parts = id.split('/');
    if (parts.length >= 3) {
      const [org, repo, ...rest] = parts;
      if (org && repo) {
        return {
          type: 'github',
          identifier: id,
          org,
          repo,
          skillPath: rest.length > 0 ? rest.join('/') : undefined,
        };
      }
    }
    if (parts.length === 2) {
      return { type: 'claude-marketplace', identifier: id };
    }
    throw new Error(`Unrecognised skill source identifier: ${id}`);
  }

  async inspect(identifier: string): Promise<ParsedSkill> {
    const source = this.parseSource(identifier);
    const content = await this.fetchSkillContent(source);
    return parseSkillContent(content, identifier);
  }

  async install(
    identifier: string,
    opts: { force?: boolean; targetName?: string } = {},
  ): Promise<InstallResult> {
    let source: HubSource;
    try {
      source = this.parseSource(identifier);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }

    let content: string;
    try {
      content = await this.fetchSkillContent(source);
    } catch (e) {
      return { ok: false, reason: `Fetch failed: ${(e as Error).message}` };
    }

    let skill: ParsedSkill;
    try {
      skill = parseSkillContent(content, identifier);
    } catch (e) {
      return { ok: false, reason: `Parse failed: ${(e as Error).message}` };
    }

    // v4.9.5 Slice 1 — attribution invariant. STRICT mode for the
    // 'official' (taracod-curated) source: a missing author / license
    // / upstream_source field is a hard reject — it means a bug in
    // the aiden-skills curation repo, not in the user's install.
    // Permissive mode for community sources never blocks install;
    // /skills list renders the "(uncredited)" marker from the
    // SkillSummary.author absence instead.
    if (source.type === 'official') {
      const attr = validateAttribution(skill.frontmatter, 'strict');
      if (!attr.ok) {
        return {
          ok:     false,
          reason: `Curated skill "${skill.frontmatter.name}" is missing required attribution: ` +
                  `${attr.missing.join(', ')}. This is a bug in the aiden-skills curation repo, ` +
                  `not your install — please report at https://github.com/taracodlabs/aiden-skills/issues.`,
        };
      }
    }

    const trustLevel = this.security.trustLevelForSource(source);
    const findings = this.security.scan(skill);
    const decision = this.security.decideInstall(trustLevel, findings);
    if (!decision.allowed) {
      return { ok: false, reason: decision.reason, warnings: decision.warnings };
    }

    const skillName = opts.targetName ?? skill.frontmatter.name;
    const targetDir = path.join(this.paths.skillsDir, skillName);
    const targetSkillFile = path.join(targetDir, 'SKILL.md');

    if (!opts.force) {
      const userModified = await this.manifest.isUserModified(skillName);
      if (userModified) {
        return {
          ok: false,
          reason: `Skill "${skillName}" is user-modified. Pass force:true to overwrite, or aiden skills reset ${skillName}.`,
          warnings: decision.warnings,
        };
      }
    }

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetSkillFile, content, 'utf-8');

    skill.frontmatter._trustLevel = trustLevel;
    skill.frontmatter._source = identifierString(source);
    skill.frontmatter._installHash = sha256(content);

    await this.manifest.upsert(skillName, {
      hash: skill.frontmatter._installHash,
      userModified: false,
      installedAt: Date.now(),
      source: identifierString(source),
    });

    return {
      ok: true,
      skill,
      installPath: targetSkillFile,
      warnings: decision.warnings,
    };
  }

  async uninstall(name: string): Promise<{ ok: boolean; reason?: string }> {
    const dir = path.join(this.paths.skillsDir, name);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      await this.manifest.remove(name);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async reset(
    name: string,
    opts: { restore?: boolean } = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const entry = await this.manifest.get(name);
    if (!entry) return { ok: false, reason: `No manifest entry for "${name}"` };
    if (opts.restore && entry.source && entry.source !== 'builtin') {
      const result = await this.install(entry.source, {
        force: true,
        targetName: name,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
    }
    await this.manifest.reset(name);
    return { ok: true };
  }

  // ── Network-dependent operations (Phase 14) ──────────────────

  async search(_query: string): Promise<HubSearchResult[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async browse(
    _source: 'official' | 'agentskills' | 'skills-sh' | 'all',
  ): Promise<HubSearchResult[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async checkForUpdates(): Promise<
    Array<{ name: string; currentVersion: string; latestVersion: string }>
  > {
    throw new Error(NOT_IMPLEMENTED);
  }
  async update(_name: string): Promise<{ ok: boolean; reason?: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async audit(): Promise<Array<{ skillName: string; findings: string[] }>> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async publish(): Promise<{ ok: boolean; url?: string; reason?: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async snapshot(): Promise<
    Record<string, { version: string; source: string }>
  > {
    throw new Error(NOT_IMPLEMENTED);
  }
  async tapAdd(
    _orgRepoSlug: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async tapRemove(
    _orgRepoSlug: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async tapList(): Promise<string[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  // ── Internals ───────────────────────────────────────────────

  private async fetchSkillContent(source: HubSource): Promise<string> {
    switch (source.type) {
      case 'url':
        return this.fetchText(source.url);
      case 'well-known':
        return this.fetchText(source.url);
      case 'github': {
        const skillSubpath = source.skillPath
          ? `${source.skillPath}/SKILL.md`
          : 'SKILL.md';
        const url = `https://raw.githubusercontent.com/${source.org}/${source.repo}/main/${skillSubpath}`;
        return this.fetchText(url);
      }
      case 'official': {
        // v4.9.5 Slice 1 — taracod-curated source. Resolve the skill
        // name via the manifest (per-process cached), then fetch the
        // skill's SKILL.md from the pinned commit. Reproducible across
        // days; the manifest pins both its OWN commit and each skill's
        // upstream_commit (the latter is informational for ATTRIBUTION.md
        // and not used in this fetch — we always fetch from the curated
        // repo's mirrored copy).
        const entry = await this.resolveOfficial(source.identifier);
        const url = `https://raw.githubusercontent.com/taracodlabs/aiden-skills/${entry.commit}/${entry.path}/SKILL.md`;
        return this.fetchText(url);
      }
      default:
        throw new Error(NOT_IMPLEMENTED);
    }
  }

  /**
   * v4.9.5 Slice 1 — resolve a curated skill name to (manifest_commit, path).
   * Caches the manifest per-process so N installs in one `aiden`
   * session = 1 HTTP fetch, not N. The cache is keyed at the SkillsHub
   * instance level (one cache per hub), which matches one Aiden boot.
   *
   * `forceRefresh` clears the cache and re-fetches — used by the
   * `/skills setup` subcommand for the rare "user knows the catalog
   * just updated" path.
   */
  private cachedCuratedManifest: { commit: string; entries: Map<string, CuratedManifestEntry> } | null = null;

  /**
   * v4.9.5 Slice 1 — fetch + cache the curated manifest. Public so
   * `runCuratedSetupFlow` (the wizard + /skills setup flow) can read
   * the same cached manifest the install path uses — one cache per
   * SkillsHub instance, populated lazily, shared between preview
   * rendering and install resolution.
   */
  async getCuratedManifest(opts: { forceRefresh?: boolean } = {}): Promise<{ commit: string; entries: ReadonlyMap<string, CuratedManifestEntry> }> {
    if (opts.forceRefresh) this.cachedCuratedManifest = null;
    if (!this.cachedCuratedManifest) {
      const result = await fetchCuratedManifest(this.fetchFn as ManifestFetchImpl);
      if (!result.manifest) {
        throw new Error(`Curated manifest unavailable: ${result.reason ?? 'unknown'}`);
      }
      const entries = new Map<string, CuratedManifestEntry>();
      for (const e of result.manifest.skills) entries.set(e.name, e);
      this.cachedCuratedManifest = { commit: result.manifest.commit, entries };
    }
    return this.cachedCuratedManifest;
  }

  private async resolveOfficial(
    identifier: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<{ commit: string; path: string }> {
    const cache = await this.getCuratedManifest(opts);
    // Accept both `official/<name>` and `official/<category>/<name>`
    // by taking the last `/`-separated segment as the canonical skill
    // name. The legacy parseSource hits `official/security/1password`
    // → identifier='security/1password' so the last-segment fallback
    // preserves backward-compat with the existing parser shape.
    const skillName = identifier.includes('/')
      ? identifier.slice(identifier.lastIndexOf('/') + 1)
      : identifier;
    const entry = cache.entries.get(skillName);
    if (!entry) {
      throw new Error(`Curated skill "${skillName}" not found in manifest`);
    }
    return { commit: cache.commit, path: entry.path };
  }

  private async fetchText(url: string): Promise<string> {
    const r = await this.fetchFn(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
    return r.text();
  }
}

function identifierString(source: HubSource): string {
  switch (source.type) {
    case 'url':
    case 'well-known':
      return source.url;
    case 'github':
      return `github:${source.identifier}`;
    case 'official':
    case 'agentskills':
    case 'skills-sh':
    case 'clawhub':
    case 'claude-marketplace':
    case 'builtin':
      return `${source.type}:${source.identifier}`;
    default:
      return JSON.stringify(source);
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
