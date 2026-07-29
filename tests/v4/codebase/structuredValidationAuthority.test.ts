/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  StructuredValidationPlan,
  ValidationEnvironment,
  ValidationExecutionResult,
} from '../../../core/v4/codebase/structuredValidationAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type AdmissionResult, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { normalizedArgsDigest } from '../../../core/v4/daemon/jobExecutionContext';

const ENVIRONMENT: ValidationEnvironment = {
  platform: 'win32',
  architecture: 'x64',
  nodeVersion: 'v22.23.1',
  npmVersion: '11.8.0',
  toolVersions: { vitest: '4.1.7', typescript: '5.9.3' },
};

describe('snapshot-bound structured validation authority', () => {
  let db: Database.Database;
  let engine: JobEngine;
  let root: string;
  let admission: AdmissionResult;
  let generation: number;
  let fenceToken: string;
  let ordinal: number;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('validation-test',1,'localhost',1,1,'4.17.0')`,
    ).run();
    engine = createJobEngine({ db });
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-validation-'));
    admission = engine.submitJob({
      entryPoint: 'test', source: 'unit', sessionId: 'validation', workspaceId: root,
      instanceId: 'validation-test', idempotencyNamespace: 'validation',
      idempotencyKey: path.basename(root), goal: 'validate exact source',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'worker', ttlMs: 60_000 });
    generation = lease.generation!;
    fenceToken = lease.fenceToken!;
    engine.transitionAttempt({
      attemptId: admission.attemptId, expectedStateVersion: lease.stateVersion!, generation,
      fenceToken, to: 'running', eventIdempotencyKey: 'validation-attempt-running', producer: 'test',
    });
    engine.transitionJob({
      jobId: admission.jobId, attemptId: admission.attemptId, generation, fenceToken,
      expectedStateVersion: 0, to: 'running', eventIdempotencyKey: 'validation-job-running', producer: 'test',
    });
    ordinal = 0;
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const binding = () => ({
    jobId: admission.jobId,
    attemptId: admission.attemptId,
    generation,
    fenceToken,
  });

  async function capture(previousSnapshotId?: string) {
    return engine.repository.captureSnapshot({
      ...binding(), requestedPath: root, previousSnapshotId, producer: 'test',
    });
  }

  async function start(plan: StructuredValidationPlan, snapshotId: string, environment = ENVIRONMENT) {
    ordinal += 1;
    const toolCallId = `validation-tool-${ordinal}`;
    const prepared = engine.prepareToolCall({
      ...binding(), toolCallId, toolName: 'shell_exec',
      normalizedArgsDigest: normalizedArgsDigest({ command: plan.command, cwd: plan.workingDirectory }),
      riskTier: 'dangerous', mutates: true, producer: 'test',
      effect: {
        classification: 'non_reconcilable_mutation', kind: 'process.execute', target: plan.command,
        retrySafety: 'never_retry', idempotencySupported: false, idempotencyKey: null,
        reconciliationSupported: false, verificationSupported: true,
        approvalRequirement: 'policy', approvalState: 'not_required', sensitiveFields: ['command'],
        redactionRules: ['digest_arguments'], trusted: true,
      },
    });
    if (!prepared.effectId) throw new Error('validation Effect was not created');
    engine.startToolCall({ toolCallId, ...binding(), producer: 'test' });
    const run = engine.validation.start({
      ...binding(), repositorySnapshotId: snapshotId, toolCallId, effectId: prepared.effectId,
      plan, environment, producer: 'test',
    });
    return { run, toolCallId, effectId: prepared.effectId };
  }

  async function complete(
    runId: string,
    execution: Partial<ValidationExecutionResult> = {},
    rawOutput?: { stdout: string; stderr: string },
  ) {
    return engine.validation.complete({
      ...binding(), runId, producer: 'test',
      execution: {
        exitCode: 0,
        stdout: 'Tests  1 passed (1)\n',
        stderr: '',
        timedOut: false,
        cancelled: false,
        ...execution,
      },
      rawOutput,
    });
  }

  it('binds a passing TestRun to one source snapshot and invalidates it for newer source', async () => {
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    const source = await capture();
    const { run } = await start({
      kind: 'test', command: 'npm test -- --run source.test.ts', workingDirectory: root, scope: 'focused',
    }, source.id);
    const completed = await complete(run.runId);
    expect(completed.run).toMatchObject({
      kind: 'test', state: 'succeeded', repositorySnapshotId: source.id,
      sourceStateDigest: source.stateDigest, passedCount: 1, failedCount: 0, skippedCount: 0,
      scope: 'focused', rawLogEvidenceId: expect.any(String), claimIds: [expect.any(String)],
    });
    expect((await engine.validation.assess(run.runId, { repositorySnapshotId: source.id })).usable).toBe(true);

    await writeFile(path.join(root, 'source.ts'), 'export const value = 2;\n');
    const newer = await capture(source.id);
    await expect(engine.validation.assess(run.runId, { repositorySnapshotId: newer.id }))
      .resolves.toMatchObject({ usable: false, reasons: expect.arrayContaining(['snapshot_mismatch']) });
  });

  it('detects a BuildRun artifact changed after successful execution', async () => {
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    const source = await capture();
    const { run } = await start({
      kind: 'build', command: 'npm run build', workingDirectory: root, scope: 'full', outputPaths: ['dist'],
    }, source.id);
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist', 'bundle.js'), 'bundle-v1\n');
    const completed = await complete(run.runId, { stdout: 'build completed\n' });
    expect(completed.run).toMatchObject({
      kind: 'build', state: 'succeeded', outputArtifacts: [expect.objectContaining({ path: 'dist/bundle.js' })],
      outputHashes: { 'dist/bundle.js': expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    await writeFile(path.join(root, 'dist', 'bundle.js'), 'bundle-v2\n');
    await expect(engine.validation.assess(run.runId, { repositorySnapshotId: source.id }))
      .resolves.toMatchObject({ usable: false, reasons: expect.arrayContaining(['artifact_changed']) });
  });

  it('does not verify a Claim from exit code zero when test parsing fails', async () => {
    await writeFile(path.join(root, 'source.ts'), 'value\n');
    const source = await capture();
    const { run } = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    const completed = await complete(run.runId, { stdout: 'command completed without structured test totals\n' });
    expect(completed.run).toMatchObject({ state: 'succeeded', parseState: 'unparsed' });
    expect(engine.proof.listClaims(admission.jobId)).toContainEqual(expect.objectContaining({ state: 'unknown' }));
    expect((await engine.validation.assess(run.runId, { repositorySnapshotId: source.id })).usable).toBe(false);
  });

  it('keeps timed-out, cancelled, environment and product failures distinct', async () => {
    await writeFile(path.join(root, 'source.ts'), 'value\n');
    const source = await capture();
    const timed = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    expect((await complete(timed.run.runId, { exitCode: -1, timedOut: true, stderr: 'timed out' })).run.state).toBe('timed_out');
    const cancelled = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    expect((await complete(cancelled.run.runId, { exitCode: -1, cancelled: true, stderr: 'interrupted' })).run.state).toBe('cancelled');
    const environment = await start({ kind: 'build', command: 'npm run build', workingDirectory: root, scope: 'full' }, source.id);
    expect((await complete(environment.run.runId, { exitCode: -1, stderr: 'spawn npm ENOENT' })).run.state).toBe('environment_failed');
    const product = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    expect((await complete(product.run.runId, { exitCode: 1, stdout: 'Tests  1 failed (1)\nFAIL source.test.ts > rejects invalid input' })).run.state).toBe('failed');
  });

  it('creates a descendant snapshot and withholds verification when validation mutates source', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'snapshot: old\n');
    const source = await capture();
    const { run } = await start({ kind: 'test', command: 'npm test -u', workingDirectory: root, scope: 'full' }, source.id);
    await writeFile(path.join(root, 'source.test.ts'), 'snapshot: updated\n');
    const completed = await complete(run.runId);
    expect(completed.run).toMatchObject({
      state: 'succeeded', resultingSnapshotId: expect.any(String), sourceMutations: ['source.test.ts'],
    });
    expect(engine.proof.listClaims(admission.jobId)).toContainEqual(expect.objectContaining({ state: 'unknown' }));
    expect(completed.diagnostics).toContainEqual(expect.objectContaining({ code: 'VALIDATION_SOURCE_MUTATION' }));
  });

  it('detects undeclared files created by a test command', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test\n');
    const source = await capture();
    const { run } = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    await writeFile(path.join(root, 'unexpected.tmp'), 'undeclared\n');
    const completed = await complete(run.runId);
    expect(completed.run.sourceMutations).toContain('unexpected.tmp');
    expect((await engine.validation.assess(run.runId, { repositorySnapshotId: source.id })).usable).toBe(false);
  });

  it('preserves the full sanitized raw log artifact when provider-facing output is truncated', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test\n');
    const source = await capture();
    const { run } = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    const full = `${'line\n'.repeat(20_000)}Tests  1 passed (1)\ncredential=must_not_survive_validation_log`;
    const completed = await complete(run.runId, { stdout: 'Tests  1 passed (1)\n' }, { stdout: full, stderr: '' });
    const artifact = engine.validation.getArtifact(completed.run.artifactIds[0]!);
    expect(artifact).toMatchObject({ kind: 'log', byteCount: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const stored = engine.validation.readLogArtifact(artifact!.artifactId);
    expect(stored.length).toBeGreaterThan(50_000);
    expect(stored).toContain('Tests  1 passed (1)');
    expect(stored).not.toContain('must_not_survive_validation_log');
  });

  it('preserves raw Evidence and diagnostics when result parsing fails', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test\n');
    const source = await capture();
    const { run } = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    const completed = await complete(run.runId, { stdout: 'unrecognized runner output\nsource.ts:7:3 error TS9999: invalid result\n' });
    expect(completed.run).toMatchObject({ parseState: 'unparsed', rawLogEvidenceId: expect.any(String) });
    expect(completed.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', path: 'source.ts', line: 7, column: 3, code: 'TS9999',
    }));
  });

  it('fingerprints Node and npm versions and keeps focused validation scoped', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test\n');
    const source = await capture();
    const first = await start({
      kind: 'test', command: 'npm test -- --run source.test.ts', workingDirectory: root, scope: 'focused',
    }, source.id, ENVIRONMENT);
    const second = await start({
      kind: 'test', command: 'npm test -- --run source.test.ts', workingDirectory: root, scope: 'focused',
    }, source.id, { ...ENVIRONMENT, nodeVersion: 'v20.19.5', npmVersion: '10.8.2' });
    expect(first.run.environmentFingerprint).not.toBe(second.run.environmentFingerprint);
    await complete(first.run.runId);
    await expect(engine.validation.assess(first.run.runId, { repositorySnapshotId: source.id, requiredScope: 'full' }))
      .resolves.toMatchObject({ usable: false, reasons: expect.arrayContaining(['scope_too_narrow']) });
  });

  it('reloads a completed run after restart without rebinding it to a newer snapshot', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test\n');
    const source = await capture();
    const { run } = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    await complete(run.runId);
    engine = createJobEngine({ db });
    expect(engine.validation.getRun(run.runId)).toMatchObject({ repositorySnapshotId: source.id, state: 'succeeded' });
    await writeFile(path.join(root, 'source.test.ts'), 'changed\n');
    const newer = await capture(source.id);
    await expect(engine.validation.assess(run.runId, { repositorySnapshotId: newer.id }))
      .resolves.toMatchObject({ usable: false, reasons: expect.arrayContaining(['snapshot_mismatch']) });
  });

  it('discovers common package, workflow, instruction and explicit validation commands', async () => {
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }));
    await writeFile(path.join(root, 'package-lock.json'), '{}\n');
    await writeFile(path.join(root, 'AGENTS.md'), 'Validate with `npm run lint`.\n');
    await writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: npm test\n');
    const source = await capture();
    const discovery = await engine.validation.discover(source.id, [{ command: 'npm run build', kind: 'build' }]);
    expect(discovery.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manifest', path: 'package.json' }),
      expect.objectContaining({ kind: 'lockfile', path: 'package-lock.json' }),
      expect.objectContaining({ kind: 'workflow', path: '.github/workflows/ci.yml' }),
      expect.objectContaining({ kind: 'instruction', path: 'AGENTS.md' }),
    ]));
    expect(discovery.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'npm test', kind: 'test' }),
      expect.objectContaining({ command: 'npm run build', kind: 'build' }),
      expect.objectContaining({ command: 'npm run lint', kind: 'build' }),
    ]));
    await expect(readFile(path.join(root, 'package.json'), 'utf8')).resolves.toContain('vitest run');
  });

  it('rejects completion after the producing lease loses authority', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test\n');
    const source = await capture();
    const { run } = await start({ kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full' }, source.id);
    db.prepare('UPDATE runs SET lease_expires_at=0 WHERE attempt_id=?').run(admission.attemptId);

    await expect(complete(run.runId)).rejects.toMatchObject({ code: 'STALE_VALIDATION_AUTHORITY' });
    expect(engine.validation.getRun(run.runId)).toMatchObject({ state: 'running', rawLogEvidenceId: null });
    expect(engine.proof.listClaims(admission.jobId)).toContainEqual(expect.objectContaining({ state: 'unverified' }));
  });

  it('replays an identical start idempotently without duplicating its Claim', async () => {
    await writeFile(path.join(root, 'source.test.ts'), 'test\n');
    const source = await capture();
    const plan: StructuredValidationPlan = {
      kind: 'test', command: 'npm test', workingDirectory: root, scope: 'full',
    };
    const first = await start(plan, source.id);
    const replay = engine.validation.start({
      ...binding(), repositorySnapshotId: source.id, toolCallId: first.toolCallId,
      effectId: first.effectId,
      plan: { ...plan, workingDirectory: `${root}${path.sep}alias${path.sep}..` },
      environment: ENVIRONMENT, producer: 'test',
    });

    expect(replay.runId).toBe(first.run.runId);
    expect(engine.proof.listClaims(admission.jobId)).toHaveLength(1);
  });
});
