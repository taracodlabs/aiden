/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillsConfig.ts — Aiden v4.0.0
 *
 * Per-skill enable/disable, per-platform gating, and runtime
 * config-value resolution. State lives under `skills.<name>.*` keys
 * in `config.yaml` (Phase 6 ConfigManager); this class is the
 * typed view onto that subtree.
 *
 * Status: PHASE 10.
 */

import type { ConfigManager } from './config';
import type { ParsedSkill, Platform } from './skillSpec';
import { requiredEnvVars } from './skillReadiness';

const PLATFORM: Platform =
  process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
    ? 'macos'
    : 'linux';

export class SkillsConfig {
  constructor(private readonly config: ConfigManager) {}

  isEnabled(skill: ParsedSkill): boolean {
    const name = skill.frontmatter.name;
    const explicit = this.config.getValue<boolean>(`skills.${name}.enabled`);
    if (explicit === false) return false;
    const platforms = skill.frontmatter.platforms;
    if (Array.isArray(platforms) && platforms.length > 0) {
      if (!platforms.includes(PLATFORM)) return false;
    }
    return true;
  }

  async setEnabled(skillName: string, enabled: boolean): Promise<void> {
    this.config.set(`skills.${skillName}.enabled`, enabled);
    await this.config.save();
  }

  /** Map declared `metadata.aiden.config[]` entries to resolved
   *  values. Order: config.yaml override → declared default →
   *  omitted (caller's preflight surfaces the gap). */
  resolveSkillConfig(skill: ParsedSkill): Record<string, string> {
    const out: Record<string, string> = {};
    const declared = skill.frontmatter.metadata?.aiden?.config ?? [];
    const skillName = skill.frontmatter.name;
    for (const c of declared) {
      const override = this.config.getValue<string>(
        `skills.${skillName}.config.${c.key}`,
      );
      if (typeof override === 'string') {
        out[c.key] = override;
      } else if (typeof c.default === 'string') {
        out[c.key] = c.default;
      }
    }
    return out;
  }

  /**
   * v4.14 Pillar 6 Slice A — now reads BOTH the v4
   * `metadata.aiden.required_environment_variables` and the legacy v3 top-level
   * `env_required` (the 6 security skills used the latter, which this method
   * previously ignored). Shares the collector with the readiness gate, so the
   * env-precondition check is live on the readiness path instead of dead code.
   */
  checkRequiredEnvVars(
    skill: ParsedSkill,
  ): { ok: boolean; missing: string[] } {
    const missing = requiredEnvVars(skill.frontmatter)
      .map((r) => r.name)
      .filter((name) => !process.env[name]);
    return { ok: missing.length === 0, missing };
  }
}
