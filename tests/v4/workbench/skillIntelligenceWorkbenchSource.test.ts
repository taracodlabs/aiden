/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const page = fs.readFileSync(path.join(root, 'dashboard-next/app/page.tsx'), 'utf8');
const client = fs.readFileSync(path.join(root, 'dashboard-next/lib/aidenClient.ts'), 'utf8');

describe('Workbench Skill Intelligence source contract', () => {
  it('extends the existing Settings Skills destination with review and health sections', () => {
    const manager = page.slice(page.indexOf('function SkillsManager()'), page.indexOf('// ── MCPView'));
    for (const label of ['Active Skills', 'Candidates', 'Needs review', 'History']) {
      expect(manager).toContain(label);
    }
    expect(manager).toContain('aiden.loadSkillIntelligence()');
    expect(manager).toContain('aiden.loadSkillCandidate(candidate.id)');
    expect(manager).toContain('Why Aiden noticed this');
    expect(manager).toContain('Deterministic evaluation');
    expect(manager).toContain('Dismiss candidate');
    expect(manager).toContain('Approve exact draft');
    expect(manager).toContain('Rollback');
  });

  it('uses exact typed bridge actions rather than browser-owned activation state', () => {
    for (const endpoint of [
      '/api/skill-intelligence',
      '/candidates/${encodeURIComponent(candidateId)}/dismiss',
      '/drafts/${encodeURIComponent(draftId)}/evaluate',
      '/approvals/${encodeURIComponent(approvalId)}/decision',
      '/approvals/${encodeURIComponent(approvalId)}/activate',
      '/skills/${encodeURIComponent(skillId)}/rollback',
    ]) expect(client).toContain(endpoint);
    expect(client).toContain('draftDigest');
    expect(client).toContain('evaluationDigest');
    expect(client).not.toContain('localStorage.setItem(\'aiden.skill');
  });

  it('keeps candidates and drafts visibly inert until exact approval and activation', () => {
    const manager = page.slice(page.indexOf('function SkillsManager()'), page.indexOf('// ── MCPView'));
    expect(manager).toContain('Candidate is inert');
    expect(manager).toContain('Draft is inert');
    expect(manager).toContain('Evaluation does not activate this Skill');
  });

  it('presents the exact managed Skill identity, prerequisites, and rollback target', () => {
    const manager = page.slice(page.indexOf('function SkillsManager()'), page.indexOf('// ── MCPView'));
    expect(client).toContain('canonicalSpec: Record<string, unknown>');
    expect(client).toContain('prerequisiteIssues: number');
    expect(page).toContain('function managedSkillName(');
    expect(manager).toContain('managedSkillName(item.version)');
    expect(manager).toContain('managedSkillName(version)');
    expect(manager).toContain('draft.capabilityRequirements.map');
    expect(manager).toContain('Rollback to v{item.rollbackTarget!.version}');
    expect(manager).toContain('item.rollbackTarget.digest.slice(0, 12)');
  });
});
