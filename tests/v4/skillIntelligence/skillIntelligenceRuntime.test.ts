/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine } from '../../../core/v4/daemon/jobEngine';
import { executeDurableJob } from '../../../core/v4/daemon/jobLifecycle';
import {
  executeWithDurableToolCall,
  runWithJobExecutionContext,
} from '../../../core/v4/daemon/jobExecutionContext';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { SkillLoader } from '../../../core/v4/skillLoader';
import { createManagedSkillSource } from '../../../core/v4/skillIntelligence/managedSkillSource';
import { resolveLegacySkillCreationPolicy } from '../../../core/v4/skillIntelligence/runtimeOptions';
import { skillViewTool } from '../../../tools/v4/skills/skillView';

const databases: Database.Database[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (databases.length) databases.pop()!.close();
  while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true });
});

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances(instance_id,pid,hostname,started_at,last_heartbeat,version)
     VALUES ('skill-runtime',1,'localhost',1,1,'test')`,
  ).run();
  const engine = createJobEngine({
    db,
    skillIntelligence: {
      enabled: true,
      ownerId: 'owner_1',
      defaultScopeId: 'workspace_1',
    },
  });
  return { db, engine };
}

describe('Skill Intelligence production wiring', () => {
  it('makes the reviewed intelligence pipeline the sole Pro Skill creation authority', () => {
    expect(resolveLegacySkillCreationPolicy({
      skillIntelligenceEnabled: true,
      configuredTeacherTier: 'tier_4_auto',
      mcpServeMode: false,
    })).toEqual({ teacherTier: 'off', miningEnabled: false });
    expect(resolveLegacySkillCreationPolicy({
      skillIntelligenceEnabled: false,
      configuredTeacherTier: 'tier_3_propose',
      mcpServeMode: false,
    })).toEqual({ teacherTier: 'tier_3_propose', miningEnabled: true });
    expect(resolveLegacySkillCreationPolicy({
      skillIntelligenceEnabled: false,
      configuredTeacherTier: 'tier_3_propose',
      mcpServeMode: true,
    })).toEqual({ teacherTier: 'tier_3_propose', miningEnabled: false });
  });

  it('observes canonical lifecycle settlement only after verified Proof is durable', async () => {
    const { engine } = fixture();
    for (let index = 0; index < 3; index += 1) {
      await executeDurableJob({
        engine,
        ownerId: 'skill-runtime',
        admission: {
          entryPoint: 'test', source: 'test', sessionId: `session_${index}`,
          instanceId: 'skill-runtime', idempotencyNamespace: 'skill-intelligence',
          idempotencyKey: `job_${index}`, goal: 'Repository summary workflow',
          workspaceId: 'workspace_1',
        },
        execute: async (handle) => {
          const claim = engine.proof.createClaim({
            jobId: handle.jobId, attemptId: handle.attemptId, generation: handle.generation,
            category: 'contract', statement: 'repository summary is evidence-backed', required: true,
          });
          const evidence = engine.proof.recordEvidence({
            jobId: handle.jobId, attemptId: handle.attemptId, generation: handle.generation,
            fenceToken: handle.fenceToken, source: 'test', producer: 'test', observedAt: 100 + index,
            coverage: 'full', verificationResult: 'verified', payload: { count: 1 },
          });
          engine.proof.checkClaim({
            claimId: claim.claimId, attemptId: handle.attemptId, generation: handle.generation,
            evidenceIds: [evidence.evidenceId], state: 'verified',
          });
          return 'done';
        },
        finalize: () => ({ status: 'completed', outcome: 'completed', finishReason: 'verified', evidence: {} }),
      });
    }

    expect(engine.skillIntelligence.listPatterns()).toEqual([
      expect.objectContaining({ verifiedCount: 3, independentPositiveCount: 3, state: 'eligible' }),
    ]);
    expect(engine.skillIntelligence.listCandidates()).toEqual([
      expect.objectContaining({ state: 'candidate', executable: false }),
    ]);
  });

  it('loads only active immutable managed content and records exact skill_view identity', async () => {
    const { db, engine } = fixture();
    const content = [
      '---',
      'name: managed-summary',
      'description: Review a repository summary.',
      'version: 1.0.0',
      '---',
      '',
      '# Managed summary',
      '',
      'Use read-only repository tools and return Evidence.',
      '',
    ].join('\n');
    const version = engine.skillIntelligence.importLegacy({
      content, source: 'reviewed-local', sourcePath: '<durable>',
      scopeId: 'workspace_1', trustLevel: 'builtin',
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-managed-skill-'));
    directories.push(root);
    const paths = resolveAidenPaths({ rootOverride: root });
    await fs.mkdir(paths.skillsDir, { recursive: true });
    const loader = new SkillLoader(paths, {
      managedSource: createManagedSkillSource(engine.skillIntelligence, 'workspace_1'),
    });
    const loaded = await loader.load('managed-summary');
    expect(loaded?.rawText).toContain('# Managed summary');
    expect(loaded?.managedIdentity).toEqual({
      skillId: version.skillId,
      skillVersionId: version.id,
      digest: version.digest,
      version: version.version,
      scopeId: 'workspace_1',
    });
    const otherWorkspaceLoader = new SkillLoader(paths, {
      managedSource: createManagedSkillSource(engine.skillIntelligence, 'workspace_2'),
    });
    expect(await otherWorkspaceLoader.load('managed-summary')).toBeNull();

    const admission = engine.submitJob({
      entryPoint: 'test', source: 'test', sessionId: 'skill_view_session', instanceId: 'skill-runtime',
      idempotencyNamespace: 'skill-view', idempotencyKey: 'managed-view', goal: 'Use managed summary',
      workspaceId: 'workspace_1',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'test', ttlMs: 60_000 });
    const result = await runWithJobExecutionContext({
      engine, jobId: admission.jobId, attemptId: admission.attemptId,
      generation: lease.generation!, fenceToken: lease.fenceToken!, producer: 'test',
      workspacePath: 'workspace_1',
    }, () => executeWithDurableToolCall({
      toolCallId: 'model-skill-view', toolName: 'skill_view', args: { name: 'managed-summary' },
      riskTier: 'safe', mutates: false,
      execute: () => skillViewTool.execute({ name: 'managed-summary' }, {
        cwd: root, paths, skillLoader: loader,
      }),
      isSuccessful: (value) => Boolean((value as { success?: boolean }).success),
    }));
    expect(result).toMatchObject({ success: true, skillVersionId: version.id, skillDigest: version.digest });
    expect(db.prepare('SELECT skill_version_id,job_id,attempt_id,generation FROM skill_invocations').all())
      .toEqual([{ skill_version_id: version.id, job_id: admission.jobId, attempt_id: admission.attemptId, generation: 1 }]);
  });

  it('detects an edited imported Skill file and blocks disk fallback under the same name', async () => {
    const { engine } = fixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-managed-drift-'));
    directories.push(root);
    const paths = resolveAidenPaths({ rootOverride: root });
    const skillDir = path.join(paths.skillsDir, 'managed-drift');
    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    const reviewed = [
      '---',
      'name: managed-drift',
      'description: Reviewed immutable content.',
      'version: 1.0.0',
      '---',
      '',
      '# Reviewed content',
      '',
    ].join('\n');
    await fs.writeFile(skillPath, reviewed, 'utf8');
    const version = engine.skillIntelligence.importLegacy({
      content: reviewed, source: 'reviewed-local', sourcePath: skillPath,
      scopeId: 'workspace_1', trustLevel: 'local',
    });
    await fs.writeFile(skillPath, reviewed.replace('Reviewed content', 'Unreviewed changed content'), 'utf8');

    const loader = new SkillLoader(paths, {
      managedSource: createManagedSkillSource(engine.skillIntelligence, 'workspace_1'),
    });
    expect(await loader.load('managed-drift')).toBeNull();
    expect(await loader.loadAll()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ frontmatter: expect.objectContaining({ name: 'managed-drift' }) }),
    ]));
    expect(engine.skillIntelligence.listPointers('workspace_1')).toEqual([
      expect.objectContaining({
        skillId: version.skillId,
        skillVersionId: version.id,
        enabled: false,
        driftState: 'drifted',
      }),
    ]);
  });

  it('refreshes managed enumeration when the exact active pointer changes without rescanning disk', async () => {
    const { engine } = fixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-managed-refresh-'));
    directories.push(root);
    const paths = resolveAidenPaths({ rootOverride: root });
    await fs.mkdir(paths.skillsDir, { recursive: true });
    await fs.writeFile(path.join(paths.skillsDir, 'disk-skill.md'), [
      '---',
      'name: disk-skill',
      'description: Existing disk Skill.',
      'version: 1.0.0',
      '---',
      '',
      '# Existing disk Skill',
      '',
    ].join('\n'), 'utf8');

    const first = engine.skillIntelligence.importLegacy({
      content: [
        '---',
        'name: managed-refresh',
        'description: First reviewed version.',
        'version: 1.0.0',
        '---',
        '',
        '# First reviewed version',
        '',
      ].join('\n'),
      source: 'reviewed-local', sourcePath: '<durable-v1>',
      scopeId: 'workspace_1', trustLevel: 'builtin',
    });
    const loader = new SkillLoader(paths, {
      managedSource: createManagedSkillSource(engine.skillIntelligence, 'workspace_1'),
    });

    const initial = await loader.loadAll();
    expect(initial).toEqual(expect.arrayContaining([
      expect.objectContaining({ managedIdentity: expect.objectContaining({ skillVersionId: first.id }) }),
      expect.objectContaining({ frontmatter: expect.objectContaining({ name: 'disk-skill' }) }),
    ]));

    const second = engine.skillIntelligence.importLegacy({
      content: [
        '---',
        'name: managed-refresh',
        'description: Second reviewed version.',
        'version: 2.0.0',
        '---',
        '',
        '# Second reviewed version',
        '',
      ].join('\n'),
      source: 'reviewed-local', sourcePath: '<durable-v2>',
      scopeId: 'workspace_1', trustLevel: 'builtin',
    });

    const refreshed = await loader.loadAll();
    expect(refreshed.filter((skill) => skill.frontmatter.name === 'managed-refresh')).toEqual([
      expect.objectContaining({ managedIdentity: expect.objectContaining({ skillVersionId: second.id }) }),
    ]);

    engine.skillIntelligence.disable({
      skillId: second.skillId,
      scopeId: 'workspace_1',
      requestedBy: 'owner_1',
    });
    expect((await loader.loadAll()).map((skill) => skill.frontmatter.name)).toEqual(['disk-skill']);
  });
});
