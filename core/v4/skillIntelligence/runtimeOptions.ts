/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { buildEditionAuthority, detectProductEdition } from '../commercial/edition';
import { integrationLocalScope } from '../integrations/runtime';
import type { SkillIntelligenceAuthorityOptions } from './authority';

export interface LegacySkillCreationPolicy<TTeacherTier extends string> {
  teacherTier: TTeacherTier | 'off';
  miningEnabled: boolean;
}

/**
 * The verified Skill Intelligence pipeline supersedes the legacy single-turn
 * teacher/miner creation paths. Existing disk Skills remain compatible; only
 * the competing creation authorities are disabled for an entitled runtime.
 */
export function resolveLegacySkillCreationPolicy<TTeacherTier extends string>(input: {
  skillIntelligenceEnabled: boolean;
  configuredTeacherTier: TTeacherTier;
  mcpServeMode: boolean;
}): LegacySkillCreationPolicy<TTeacherTier> {
  return {
    teacherTier: input.skillIntelligenceEnabled ? 'off' : input.configuredTeacherTier,
    miningEnabled: !input.skillIntelligenceEnabled && !input.mcpServeMode,
  };
}

export function resolveSkillIntelligenceRuntimeOptions(
  cwd = process.cwd(),
): Omit<SkillIntelligenceAuthorityOptions, 'db'> {
  const edition = buildEditionAuthority(detectProductEdition());
  const scope = integrationLocalScope(cwd);
  return {
    enabled: edition.can('skill.intelligence'),
    ownerId: scope.ownerId,
    defaultScopeId: scope.workspaceId,
  };
}
