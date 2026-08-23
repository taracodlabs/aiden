/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import {
  parseSkillContent,
  serializeSkill,
  type ParsedSkill,
  type SkillFrontmatter,
} from '../skillSpec';
import type { ManagedSkillSource } from '../skillLoader';
import type { SkillIntelligenceAuthority } from './authority';
import type { ResolvedSkillVersion, SkillVersion } from './types';

function readableProcedure(spec: Record<string, unknown>): string {
  const procedure = spec.procedure && typeof spec.procedure === 'object'
    ? spec.procedure as Record<string, unknown>
    : {};
  const steps = Array.isArray(procedure.steps)
    ? procedure.steps as Array<Record<string, unknown>>
    : [];
  const expected = Array.isArray(procedure.expectedEvidence)
    ? procedure.expectedEvidence.filter((value): value is string => typeof value === 'string')
    : [];
  const lines = ['# Procedure', ''];
  if (steps.length === 0) {
    lines.push('Follow the reviewed Skill instructions and preserve durable Evidence.');
  } else {
    steps.forEach((step, index) => {
      const operation = typeof step.operation === 'string' ? step.operation : 'perform';
      const target = typeof step.target === 'string' ? ` ${step.target}` : '';
      lines.push(`${index + 1}. ${operation}${target}`);
    });
  }
  if (expected.length > 0) {
    lines.push('', '## Expected Evidence', '');
    expected.forEach((item) => lines.push(`- ${item}`));
  }
  return `${lines.join('\n')}\n`;
}

function renderVersion(version: SkillVersion): string {
  const spec = version.canonicalSpec;
  if (typeof spec.rawText === 'string') return spec.rawText;
  const sourceFrontmatter = spec.frontmatter && typeof spec.frontmatter === 'object'
    ? spec.frontmatter as SkillFrontmatter
    : {} as SkillFrontmatter;
  const frontmatter: SkillFrontmatter = {
    ...sourceFrontmatter,
    version: String(version.version),
  };
  return serializeSkill({
    frontmatter,
    body: typeof spec.body === 'string' ? spec.body : readableProcedure(spec),
    rawText: '',
    filePath: `<managed-skill:${version.id}>`,
  });
}

function parsed(resolved: ResolvedSkillVersion): ParsedSkill {
  const rawText = renderVersion(resolved.version);
  const value = parseSkillContent(rawText, `<managed-skill:${resolved.version.id}>`);
  return {
    ...value,
    rawText,
    managedIdentity: {
      skillId: resolved.skillId,
      skillVersionId: resolved.version.id,
      digest: resolved.version.digest,
      version: resolved.version.version,
      scopeId: resolved.scopeId,
    },
  };
}

export function createManagedSkillSource(
  authority: SkillIntelligenceAuthority,
  scopeId: string,
): ManagedSkillSource {
  const nameOf = (version: SkillVersion): string | null => {
    const frontmatter = version.canonicalSpec.frontmatter;
    if (!frontmatter || typeof frontmatter !== 'object') return null;
    const name = (frontmatter as Record<string, unknown>).name;
    return typeof name === 'string' && name.trim() ? name.trim().toLowerCase() : null;
  };
  const blocked = (): string[] => authority.listPointers(scopeId).flatMap((pointer) => {
    if (pointer.enabled && pointer.driftState === 'clean') return [];
    const version = authority.listVersions(pointer.skillId)
      .find((candidate) => candidate.id === pointer.skillVersionId);
    const name = version ? nameOf(version) : null;
    return name ? [name] : [];
  });
  return {
    async load(name) {
      const resolved = authority.resolveActiveByName(name, scopeId);
      return resolved ? parsed(resolved) : null;
    },
    async loadAll() {
      return authority.listActive(scopeId).map(parsed);
    },
    async blockedNames() {
      return blocked();
    },
    async isBlocked(name) {
      return blocked().includes(name.trim().toLowerCase());
    },
  };
}
