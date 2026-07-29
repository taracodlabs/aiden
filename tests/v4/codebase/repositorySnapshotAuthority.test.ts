import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import { fileReadTool } from '../../../tools/v4/files/fileRead';
import { fileListTool } from '../../../tools/v4/files/fileList';

let db: Database.Database;
let engine: JobEngine;
let root: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)')
    .run('instance', 1, 'localhost', Date.now(), Date.now(), '4.17.0');
  engine = createJobEngine({ db });
  root = await mkdtemp(path.join(os.tmpdir(), 'aiden-snapshot-'));
});

afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

function authority() {
  const admitted = engine.submitJob({
    entryPoint: 'test', source: 'unit', sessionId: 'session', workspaceId: root,
    instanceId: 'instance', idempotencyNamespace: 'snapshot', idempotencyKey: 'one', goal: 'inspect',
  });
  const lease = engine.claimAttempt({ attemptId: admitted.attemptId, ownerId: 'worker', ttlMs: 60_000 });
  if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('lease');
  return { ...admitted, generation: lease.generation, fenceToken: lease.fenceToken };
}

describe('RepositorySnapshot authority', () => {
  it('captures immutable dirty Git state with a deterministic state digest', async () => {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    execFileSync('git', ['-C', root, 'add', 'package.json']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
    await writeFile(path.join(root, 'package.json'), '{"name":"changed"}\n');
    await writeFile(path.join(root, 'new.txt'), 'untracked\n');
    const binding = authority();
    const first = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    const second = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test', previousSnapshotId: first.id });
    expect(first.stateDigest).toBe(second.stateDigest);
    expect(first.id).not.toBe(second.id);
    expect(first.dirtyPaths).toContain('package.json');
    expect(first.untrackedPaths).toContain('new.txt');
    expect(engine.repository.getWorkspace(first.workspaceId)?.canonicalPath).toBe(await (await import('node:fs/promises')).realpath(root));
    expect(await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8')).toContain('changed');
    expect(engine.repository.getAttemptSnapshot(binding.jobId, binding.attemptId)?.id).toBe(first.id);
  });

  it('rejects stale generations and expired fences', async () => {
    await writeFile(path.join(root, 'package.json'), '{}');
    const binding = authority();
    await expect(engine.repository.captureSnapshot({ ...binding, generation: binding.generation + 1, requestedPath: root, producer: 'test' }))
      .rejects.toMatchObject({ code: 'STALE_REPOSITORY_SNAPSHOT_AUTHORITY' });
    db.prepare('UPDATE runs SET lease_expires_at=? WHERE attempt_id=?').run(Date.now() - 1, binding.attemptId);
    await expect(engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' }))
      .rejects.toMatchObject({ code: 'STALE_REPOSITORY_SNAPSHOT_AUTHORITY' });
  });

  it('changes the state digest without mutating prior records', async () => {
    await writeFile(path.join(root, 'package.json'), '{"name":"before"}');
    const binding = authority();
    const first = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    await writeFile(path.join(root, 'package.json'), '{"name":"after"}');
    const second = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test', previousSnapshotId: first.id });
    expect(second.stateDigest).not.toBe(first.stateDigest);
    expect(engine.repository.getSnapshot(first.id)?.stateDigest).toBe(first.stateDigest);
    expect(engine.repository.compareSnapshots(first.id, second.id).changed).toContain('package.json');
    engine.repository.compareSnapshots(first.id, second.id);
    expect(engine.listEvents(binding.jobId).filter((event) => event.type === 'repository.snapshot_compared')).toHaveLength(1);
    await expect(engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test', previousSnapshotId: first.id }))
      .rejects.toMatchObject({ code: 'INVALID_REPOSITORY_SNAPSHOT_ANCESTRY' });
  });

  it('records bounded incomplete captures explicitly', async () => {
    await writeFile(path.join(root, 'a.ts'), 'a');
    await writeFile(path.join(root, 'b.ts'), 'b');
    const binding = authority();
    const snapshot = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test', policy: { maxEntries: 1 } });
    expect(snapshot.incomplete).toBe(true);
    expect(snapshot.incompleteReasons).toContain('entry_limit:1');
    expect(engine.listEvents(binding.jobId).map((event) => event.type)).toContain('repository.snapshot_incomplete');
  });

  it('changes digest for staged state and HEAD identity', async () => {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(root, 'source.ts'), 'one');
    execFileSync('git', ['-C', root, 'add', 'source.ts']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'one']);
    const binding = authority();
    const committed = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    await writeFile(path.join(root, 'source.ts'), 'two');
    execFileSync('git', ['-C', root, 'add', 'source.ts']);
    const staged = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test', previousSnapshotId: committed.id });
    expect(staged.stateDigest).not.toBe(committed.stateDigest);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'two']);
    const nextHead = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test', previousSnapshotId: staged.id });
    expect(nextHead.headCommit).not.toBe(committed.headCommit);
    expect(nextHead.stateDigest).not.toBe(staged.stateDigest);
  });

  it('persists snapshot binding and ordered events across engine reconstruction', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Repository instructions');
    const binding = authority();
    const snapshot = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    const restored = createJobEngine({ db });
    expect(restored.repository.getAttemptSnapshot(binding.jobId, binding.attemptId)?.id).toBe(snapshot.id);
    expect(restored.repository.discoverInstructions(snapshot.id)).toEqual([
      expect.objectContaining({ path: 'AGENTS.md', snapshotId: snapshot.id, trust: 'repository' }),
    ]);
    expect(restored.listEvents(binding.jobId).map((event) => event.type)).toEqual([
      'job.submitted', 'attempt.created', 'attempt.leased',
      'repository.workspace_resolved', 'repository.snapshot_capture_started', 'repository.snapshot_captured',
    ]);
  });

  it('provides bounded snapshot inventory, read and lexical search', async () => {
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(path.join(root, 'source.ts'), 'export const value = "needle";\n');
    const binding = authority();
    const snapshot = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    const inventory = await engine.repository.inventory(snapshot.id, { limit: 1 });
    expect(inventory.snapshotId).toBe(snapshot.id);
    expect(inventory.truncated).toBe(true);
    const read = await engine.repository.readFile(snapshot.id, 'source.ts', { offset: 0, limit: 6 });
    expect(read.fullContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(read.pageContentHash).not.toBe(read.fullContentHash);
    expect(read.fullFileHash).toBe(true);
    const search = await engine.repository.search(snapshot.id, 'needle', { limit: 10 });
    expect(search.matches[0]).toMatchObject({ path: 'source.ts', line: 1 });
    await writeFile(path.join(root, 'source.ts'), 'changed after capture\n');
    expect((await engine.repository.readFile(snapshot.id, 'source.ts')).stale).toBe(true);
  });

  it('extends canonical file tools with an optional immutable inspection view', async () => {
    await writeFile(path.join(root, 'source.ts'), 'snapshot content');
    const binding = authority();
    const snapshot = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    const context = {
      cwd: root,
      paths: {} as never,
      repositoryInspection: { snapshotId: snapshot.id, rootPath: root, authority: engine.repository },
    };
    const read = await fileReadTool.execute({ path: 'source.ts' }, context) as Record<string, unknown>;
    expect(read).toMatchObject({ success: true, snapshotId: snapshot.id, stateDigest: snapshot.stateDigest, content: 'snapshot content' });
    const list = await fileListTool.execute({}, context) as Record<string, unknown>;
    expect(list).toMatchObject({ success: true, snapshotId: snapshot.id, entries: [{ name: 'source.ts', type: 'file' }] });
  });

  it('records policy exclusions without hashing excluded directory changes', async () => {
    await (await import('node:fs/promises')).mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'dependency.js'), 'one');
    await writeFile(path.join(root, 'package.json'), '{}');
    const binding = authority();
    const first = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    await writeFile(path.join(root, 'node_modules', 'dependency.js'), 'two');
    const second = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test', previousSnapshotId: first.id });
    expect(second.stateDigest).toBe(first.stateDigest);
    const inventory = await engine.repository.inventory(first.id);
    expect(inventory.entries).toContainEqual(expect.objectContaining({ path: 'node_modules/', captureStatus: 'excluded' }));
  });

  it('records secret metadata without reading secret content through inspection', async () => {
    await writeFile(path.join(root, '.env'), 'SETTING=fixture');
    const binding = authority();
    const snapshot = await engine.repository.captureSnapshot({ ...binding, requestedPath: root, producer: 'test' });
    const inventory = await engine.repository.inventory(snapshot.id);
    expect(inventory.entries).toContainEqual(expect.objectContaining({ path: '.env', captureStatus: 'metadata_only', contentHash: null, reason: 'secret_content' }));
    await expect(engine.repository.readFile(snapshot.id, '.env')).rejects.toMatchObject({ code: 'SNAPSHOT_PATH_NOT_READABLE' });
  });
});
