/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillSpec.ts — Aiden v4.0.0
 *
 * SKILL.md frontmatter spec + parser. v4 keeps the v3 frontmatter
 * fields (name, description, version, category, tags, license) and
 * extends with `metadata.aiden.*` per the architecture doc:
 *
 *   - tags / category — discovery hints
 *   - fallback_for_toolsets — declarative "use this skill when X
 *     toolset is missing"
 *   - requires_toolsets — gate-out skills that need toolsets the
 *     user hasn't enabled
 *   - config[] — runtime-injected values (Phase 6 ConfigManager
 *     resolves, Phase 10's SkillsConfig pulls into env)
 *   - required_environment_variables[] — preflight check before
 *     advertising the skill to the model
 *
 * Three private fields (`_trustLevel`, `_source`, `_installHash`)
 * are stamped at install time, NOT authored by skill writers. The
 * underscore prefix flags them to the security scanner.
 *
 * Status: PHASE 10.
 */

import { promises as fs } from 'node:fs';
import yaml from 'js-yaml';

export type Platform = 'windows' | 'linux' | 'macos';
export type TrustLevel = 'builtin' | 'official' | 'trusted' | 'community';

export interface AidenSkillConfig {
  key: string;
  default?: string;
  prompt?: string;
}

export interface AidenSkillEnvVar {
  name: string;
  prompt?: string;
  help?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
  category?: string;
  tags?: string[] | string;
  license?: string;
  platforms?: Platform[];
  metadata?: {
    aiden?: {
      tags?: string[];
      category?: string;
      fallback_for_toolsets?: string[];
      requires_toolsets?: string[];
      config?: AidenSkillConfig[];
      required_environment_variables?: AidenSkillEnvVar[];
    };
  };
  /** Trust level — assigned during install/scan, not authored. */
  _trustLevel?: TrustLevel;
  /** Source identifier — assigned during install. */
  _source?: string;
  /** Hash of SKILL.md at install time — for tamper detection. */
  _installHash?: string;
  /** Catch-all for forward-compatible fields we don't reject. */
  [k: string]: unknown;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  rawText: string;
  filePath: string;
}

const REQUIRED_FIELDS = ['name', 'description', 'version'] as const;

export async function parseSkillFile(filePath: string): Promise<ParsedSkill> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return parseSkillContent(raw, filePath);
}

export function parseSkillContent(
  content: string,
  filePath = '<inline>',
): ParsedSkill {
  const normalized = content.replace(/^﻿/, '');
  const m = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    throw new Error(
      `Malformed SKILL.md at ${filePath}: no frontmatter block (expected --- ... ---).`,
    );
  }
  const [, frontmatterRaw, bodyRaw] = m;

  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatterRaw);
  } catch (e) {
    throw new Error(
      `Malformed YAML frontmatter at ${filePath}: ${(e as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Malformed frontmatter at ${filePath}: top-level value must be a mapping.`,
    );
  }
  const frontmatter = parsed as SkillFrontmatter;

  // Coerce numeric `version: 1` → string (v3 compat) before
  // required-field validation.
  if (
    frontmatter.version != null &&
    typeof frontmatter.version !== 'string'
  ) {
    frontmatter.version = String(frontmatter.version);
  }

  for (const required of REQUIRED_FIELDS) {
    const v = frontmatter[required];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(
        `SKILL.md at ${filePath} is missing required field "${required}".`,
      );
    }
  }

  return {
    frontmatter,
    body: bodyRaw ?? '',
    rawText: content,
    filePath,
  };
}

export function serializeSkill(parsed: ParsedSkill): string {
  const yamlText = yaml
    .dump(parsed.frontmatter, { lineWidth: -1, noRefs: true })
    .trimEnd();
  return `---\n${yamlText}\n---\n${parsed.body}`;
}

/** Best-effort sniff: is this content a SKILL.md? */
export function looksLikeSkill(content: string): boolean {
  return /^---[\r\n][\s\S]*?[\r\n]---/.test(content.replace(/^﻿/, ''));
}
