/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Db } from '../daemon/db/connection';
import type { AttemptRecord, JobRecord } from '../daemon/jobEngine';
import { isPathAllowed, isWithin, realpathWithFallback } from '../sandboxFs';
import { resolveWorkspace, type WorkspaceDescriptor } from './workspaceResolver';

const execFileAsync = promisify(execFile);
const HASH = 'sha256';
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'vendor', '.cache', '.next', '.nuxt', 'dist', 'build', 'coverage', 'target', '__pycache__',
]);
const SECRET_NAME = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const INSTRUCTION_NAME = /^(?:AGENTS\.md|AIDEN\.md|PROJECT\.md|INSTRUCTIONS\.md|CONTRIBUTING\.md)$/i;
const MANIFEST_NAME = /^(?:package\.json|pnpm-workspace\.yaml|Cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?)$/i;
const LOCKFILE_NAME = /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$/i;
const CONFIG_NAME = /^(?:tsconfig(?:\..+)?\.json|vitest\.config\..+|jest\.config\..+|vite\.config\..+|Makefile|Taskfile\.ya?ml|turbo\.json|nx\.json)$/i;

export interface RepositoryCapturePolicy {
  maxEntries: number;
  maxFileBytes: number;
  excludedDirectories: readonly string[];
  explicitlyInspectedPaths: readonly string[];
}

export interface RepositorySnapshotEntry {
  path: string;
  canonicalIdentity: string;
  classification: string;
  gitState: string | null;
  size: number | null;
  modifiedAt: number | null;
  mode: number | null;
  contentHash: string | null;
  captureStatus: 'captured' | 'metadata_only' | 'excluded' | 'unavailable';
  reason: string | null;
}

export interface RepositorySnapshotRecord {
  id: string;
  workspaceId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  repositoryRoot: string | null;
  vcsKind: 'git' | 'none';
  branch: string | null;
  headCommit: string | null;
  upstream: string | null;
  indexDigest: string;
  workingTreeDigest: string;
  capturePolicyDigest: string;
  incomplete: boolean;
  incompleteReasons: string[];
  previousSnapshotId: string | null;
  stateDigest: string;
  capturedAt: number;
  dirtyPaths: string[];
  stagedPaths: string[];
  untrackedPaths: string[];
}

export class RepositorySnapshotAuthorityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RepositorySnapshotAuthorityError'; this.code = code; }
}

interface CaptureState {
  descriptor: WorkspaceDescriptor;
  policy: RepositoryCapturePolicy;
  capturePolicyDigest: string;
  branch: string | null;
  headCommit: string | null;
  upstream: string | null;
  stagedPaths: string[];
  dirtyPaths: string[];
  untrackedPaths: string[];
  entries: RepositorySnapshotEntry[];
  incompleteReasons: string[];
  indexDigest: string;
  workingTreeDigest: string;
  stateDigest: string;
}

export interface RepositorySnapshotAuthority {
  captureSnapshot(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    requestedPath: string; producer: string; previousSnapshotId?: string | null;
    policy?: Partial<RepositoryCapturePolicy>;
  }): Promise<RepositorySnapshotRecord>;
  getSnapshot(snapshotId: string): RepositorySnapshotRecord | undefined;
  getWorkspace(workspaceId: string): WorkspaceDescriptor | undefined;
  getAttemptSnapshot(jobId: string, attemptId: string): RepositorySnapshotRecord | undefined;
  getEntry(snapshotId: string, relativePath: string): RepositorySnapshotEntry | undefined;
  compareSnapshots(baseId: string, currentId: string): { baseId: string; currentId: string; added: string[]; removed: string[]; changed: string[] };
  inventory(snapshotId: string, options?: { cursor?: string; limit?: number }): Promise<{ snapshotId: string; stateDigest: string; entries: RepositorySnapshotEntry[]; nextCursor: string | null; truncated: boolean; stale: boolean }>;
  readFile(snapshotId: string, relativePath: string, options?: { offset?: number; limit?: number }): Promise<Record<string, unknown>>;
  search(snapshotId: string, query: string, options?: { limit?: number; include?: RegExp; exclude?: RegExp }): Promise<{ snapshotId: string; stateDigest: string; matches: Array<{ path: string; line: number; column: number; text: string }>; truncated: boolean; stale: boolean }>;
  discoverInstructions(snapshotId: string): Array<{ path: string; contentHash: string | null; scope: string; precedence: number; trust: 'repository'; snapshotId: string }>;
}

function digest(value: unknown): string { return createHash(HASH).update(JSON.stringify(value)).digest('hex'); }
function normalizeRelative(value: string): string { return value.split(path.sep).join('/').replace(/^\.\//, ''); }
function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values.map(normalizeRelative))].sort(); }
function parseNul(value: string): string[] { return value.split('\0').filter(Boolean).map(normalizeRelative); }

async function git(root: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-c', 'color.ui=false', '-C', root, ...args], {
      windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
    });
    return result.stdout.trimEnd();
  } catch { return null; }
}

function classify(relativePath: string): string {
  const name = path.posix.basename(relativePath);
  if (INSTRUCTION_NAME.test(name)) return 'instruction';
  if (MANIFEST_NAME.test(name)) return 'manifest';
  if (LOCKFILE_NAME.test(name)) return 'lockfile';
  if (relativePath.startsWith('.github/workflows/')) return 'ci';
  if (CONFIG_NAME.test(name)) return 'configuration';
  return 'source';
}

function policyOf(input?: Partial<RepositoryCapturePolicy>): RepositoryCapturePolicy {
  return {
    maxEntries: Math.max(1, Math.min(50_000, input?.maxEntries ?? DEFAULT_MAX_ENTRIES)),
    maxFileBytes: Math.max(1, Math.min(16 * 1024 * 1024, input?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)),
    excludedDirectories: uniqueSorted(input?.excludedDirectories ?? [...EXCLUDED_DIRECTORIES]),
    explicitlyInspectedPaths: uniqueSorted(input?.explicitlyInspectedPaths ?? []),
  };
}

function excludedByPolicy(relativePath: string, policy: RepositoryCapturePolicy): boolean {
  const first = normalizeRelative(relativePath).split('/')[0].toLowerCase();
  return policy.excludedDirectories.some((item) => item.toLowerCase() === first);
}

async function gatherState(requestedPath: string, policyInput?: Partial<RepositoryCapturePolicy>, resolved?: WorkspaceDescriptor): Promise<CaptureState> {
  const descriptor = resolved ?? await resolveWorkspace(requestedPath);
  if (!descriptor.exists) throw new RepositorySnapshotAuthorityError('WORKSPACE_NOT_FOUND', 'Repository snapshot root does not exist');
  const root = descriptor.repositoryRoot ?? descriptor.canonicalPath;
  const policy = policyOf(policyInput);
  const capturePolicyDigest = digest({ version: 1, ...policy });
  const branch = descriptor.vcsKind === 'git' ? (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) : null;
  const headCommit = descriptor.vcsKind === 'git' ? (await git(root, ['rev-parse', '--verify', 'HEAD'])) : null;
  const upstream = descriptor.vcsKind === 'git' ? (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])) : null;
  const stagedPaths = descriptor.vcsKind === 'git' ? uniqueSorted(parseNul(await git(root, ['diff', '--cached', '--name-only', '-z', '--']) ?? '')).filter((item) => !excludedByPolicy(item, policy)) : [];
  const dirtyPaths = descriptor.vcsKind === 'git' ? uniqueSorted(parseNul(await git(root, ['diff', '--name-only', '-z', '--']) ?? '')).filter((item) => !excludedByPolicy(item, policy)) : [];
  const untrackedPaths = descriptor.vcsKind === 'git' ? uniqueSorted(parseNul(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']) ?? '')).filter((item) => !excludedByPolicy(item, policy)) : [];
  const gitStates = new Map<string, string>();
  for (const item of stagedPaths) gitStates.set(item, 'staged');
  for (const item of dirtyPaths) gitStates.set(item, gitStates.has(item) ? 'staged,dirty' : 'dirty');
  for (const item of untrackedPaths) gitStates.set(item, 'untracked');
  const entries: RepositorySnapshotEntry[] = [];
  const incompleteReasons: string[] = [];
  const excluded = new Set(policy.excludedDirectories.map((item) => item.toLowerCase()));

  async function walk(directory: string, relative = ''): Promise<void> {
    if (entries.length >= policy.maxEntries) return;
    let children;
    try { children = await fs.readdir(directory, { withFileTypes: true }); }
    catch { incompleteReasons.push(`unreadable:${relative || '.'}`); return; }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const rel = normalizeRelative(path.join(relative, child.name));
      if (entries.length >= policy.maxEntries) { incompleteReasons.push(`entry_limit:${policy.maxEntries}`); break; }
      if (child.isDirectory()) {
        if (excluded.has(child.name.toLowerCase())) {
          entries.push({ path: `${rel}/`, canonicalIdentity: normalizeRelative(path.join(root, rel)), classification: 'excluded_directory', gitState: null, size: null, modifiedAt: null, mode: null, contentHash: null, captureStatus: 'excluded', reason: 'policy_excluded_directory' });
        } else await walk(path.join(directory, child.name), rel);
        continue;
      }
      if (!child.isFile()) continue;
      const absolute = path.join(directory, child.name);
      try {
        const stat = await fs.stat(absolute);
        let contentHash: string | null = null;
        let captureStatus: RepositorySnapshotEntry['captureStatus'] = 'captured';
        let reason: string | null = null;
        if (SECRET_NAME.test(child.name)) { captureStatus = 'metadata_only'; reason = 'secret_content'; }
        else if (stat.size > policy.maxFileBytes) { captureStatus = 'metadata_only'; reason = 'file_size_limit'; }
        else {
          const bytes = await fs.readFile(absolute);
          if (bytes.subarray(0, 8_192).includes(0)) { captureStatus = 'metadata_only'; reason = 'binary_content'; }
          else contentHash = createHash(HASH).update(bytes).digest('hex');
        }
        entries.push({ path: rel, canonicalIdentity: normalizeRelative(realpathWithFallback(absolute)), classification: classify(rel), gitState: gitStates.get(rel) ?? null, size: stat.size, modifiedAt: stat.mtimeMs, mode: stat.mode, contentHash, captureStatus, reason });
      } catch { entries.push({ path: rel, canonicalIdentity: normalizeRelative(absolute), classification: classify(rel), gitState: gitStates.get(rel) ?? null, size: null, modifiedAt: null, mode: null, contentHash: null, captureStatus: 'unavailable', reason: 'read_error' }); incompleteReasons.push(`unreadable:${rel}`); }
    }
  }
  await walk(root);
  const capturedPaths = new Set(entries.map((entry) => entry.path.replace(/\/$/, '')));
  for (const [gitPath, gitState] of gitStates) {
    if (capturedPaths.has(gitPath)) continue;
    if (entries.length >= policy.maxEntries) { incompleteReasons.push(`entry_limit:${policy.maxEntries}`); break; }
    entries.push({ path: gitPath, canonicalIdentity: normalizeRelative(path.join(root, gitPath)), classification: classify(gitPath), gitState, size: null, modifiedAt: null, mode: null, contentHash: null, captureStatus: 'unavailable', reason: 'path_missing_at_capture' });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const stableEntries = entries.map(({ modifiedAt: _modifiedAt, ...entry }) => entry);
  const indexDigest = digest(stagedPaths);
  const workingTreeDigest = digest({ dirtyPaths, untrackedPaths, entries: stableEntries });
  const stateDigest = digest({ workspaceId: descriptor.id, repositoryRoot: descriptor.repositoryRoot ?? null, vcsKind: descriptor.vcsKind, branch, headCommit, upstream, indexDigest, workingTreeDigest, capturePolicyDigest, incompleteReasons: uniqueSorted(incompleteReasons) });
  return { descriptor, policy, capturePolicyDigest, branch, headCommit, upstream, stagedPaths, dirtyPaths, untrackedPaths, entries, incompleteReasons: uniqueSorted(incompleteReasons), indexDigest, workingTreeDigest, stateDigest };
}

interface Deps {
  db: Db;
  getJob(jobId: string): JobRecord | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  appendJobEvent(command: { jobId: string; attemptId: string; generation: number; type: string; payload?: Record<string, unknown> | null; producer: string; idempotencyKey: string }): { applied: boolean; duplicate: boolean; conflict?: string };
}

export function createRepositorySnapshotAuthority(deps: Deps): RepositorySnapshotAuthority {
  const { db } = deps;
  const rowToRecord = (row: Record<string, unknown>): RepositorySnapshotRecord => {
    const list = (sql: string) => (db.prepare(sql).all(row.snapshot_id) as Array<{ relative_path: string }>).map((item) => item.relative_path);
    return {
      id: String(row.snapshot_id), workspaceId: String(row.workspace_id), jobId: String(row.job_id), attemptId: String(row.attempt_id), generation: Number(row.generation),
      repositoryRoot: row.repository_root === null ? null : String(row.repository_root), vcsKind: row.vcs_kind as 'git' | 'none', branch: row.branch === null ? null : String(row.branch), headCommit: row.head_commit === null ? null : String(row.head_commit), upstream: row.upstream === null ? null : String(row.upstream),
      indexDigest: String(row.index_digest), workingTreeDigest: String(row.working_tree_digest), capturePolicyDigest: String(row.capture_policy_digest), incomplete: Number(row.incomplete) === 1,
      incompleteReasons: JSON.parse(String(row.incomplete_reasons_json)) as string[], previousSnapshotId: row.previous_snapshot_id === null ? null : String(row.previous_snapshot_id), stateDigest: String(row.state_digest), capturedAt: Number(row.captured_at),
      stagedPaths: list("SELECT relative_path FROM repository_snapshot_entries WHERE snapshot_id=? AND instr(COALESCE(git_state,''),'staged')>0 ORDER BY relative_path"),
      dirtyPaths: list("SELECT relative_path FROM repository_snapshot_entries WHERE snapshot_id=? AND instr(COALESCE(git_state,''),'dirty')>0 ORDER BY relative_path"),
      untrackedPaths: list("SELECT relative_path FROM repository_snapshot_entries WHERE snapshot_id=? AND git_state='untracked' ORDER BY relative_path"),
    };
  };
  const getSnapshot = (snapshotId: string) => {
    const row = db.prepare('SELECT * FROM repository_snapshots WHERE snapshot_id=?').get(snapshotId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  };
  const entriesFor = (snapshotId: string): RepositorySnapshotEntry[] => (db.prepare('SELECT * FROM repository_snapshot_entries WHERE snapshot_id=? ORDER BY relative_path').all(snapshotId) as Array<Record<string, unknown>>).map((row) => ({
    path: String(row.relative_path), canonicalIdentity: String(row.canonical_identity), classification: String(row.classification), gitState: row.git_state === null ? null : String(row.git_state), size: row.size === null ? null : Number(row.size), modifiedAt: row.modified_at === null ? null : Number(row.modified_at), mode: row.mode === null ? null : Number(row.mode), contentHash: row.content_hash === null ? null : String(row.content_hash), captureStatus: row.capture_status as RepositorySnapshotEntry['captureStatus'], reason: row.reason === null ? null : String(row.reason),
  }));
  const descriptorFor = (workspaceId: string) => db.prepare('SELECT * FROM workspace_descriptors WHERE workspace_id=?').get(workspaceId) as Record<string, unknown> | undefined;
  const mapDescriptor = (row: Record<string, unknown>): WorkspaceDescriptor => ({
    id: String(row.workspace_id), requestedPath: String(row.requested_path), canonicalPath: String(row.canonical_path), portablePath: String(row.portable_path),
    pathKind: row.path_kind as WorkspaceDescriptor['pathKind'], platform: row.platform as NodeJS.Platform, exists: Number(row.exists_flag) === 1,
    ...(row.repository_root === null ? {} : { repositoryRoot: String(row.repository_root) }),
    ...(row.git_directory === null ? {} : { gitDirectory: String(row.git_directory) }),
    ...(row.git_common_directory === null ? {} : { gitCommonDirectory: String(row.git_common_directory) }),
    ...(row.outer_repository_root === null ? {} : { outerRepositoryRoot: String(row.outer_repository_root) }),
    vcsKind: row.vcs_kind as 'git' | 'none', trustPolicyDigest: String(row.trust_policy_digest),
  });
  const rootFor = (snapshot: RepositorySnapshotRecord): string => {
    const descriptor = descriptorFor(snapshot.workspaceId);
    if (!descriptor) throw new RepositorySnapshotAuthorityError('WORKSPACE_NOT_FOUND', 'Snapshot workspace descriptor is missing');
    return String(snapshot.repositoryRoot ?? descriptor.canonical_path);
  };
  const stale = async (snapshot: RepositorySnapshotRecord) => {
    const descriptor = descriptorFor(snapshot.workspaceId);
    if (!descriptor) return true;
    const row = db.prepare('SELECT capture_policy_json FROM repository_snapshots WHERE snapshot_id=?').get(snapshot.id) as { capture_policy_json: string };
    return (await gatherState(String(descriptor.canonical_path), JSON.parse(row.capture_policy_json) as RepositoryCapturePolicy)).stateDigest !== snapshot.stateDigest;
  };
  const assertActiveAuthority = (input: { jobId: string; attemptId: string; generation: number; fenceToken: string }): void => {
    const job = deps.getJob(input.jobId);
    const attempt = deps.getAttempt(input.attemptId);
    const now = Date.now();
    if (!job || !attempt || attempt.jobId !== job.id || attempt.generation !== input.generation || attempt.fenceToken !== input.fenceToken || attempt.leaseExpiresAt === null || attempt.leaseExpiresAt <= now || ['succeeded','failed','cancelled','timed_out','crashed','unknown'].includes(attempt.status)) {
      throw new RepositorySnapshotAuthorityError('STALE_REPOSITORY_SNAPSHOT_AUTHORITY', 'Attempt generation or fence no longer owns repository capture');
    }
  };

  return {
    async captureSnapshot(input) {
      const eventKey = digest({ jobId: input.jobId, attemptId: input.attemptId, generation: input.generation, requestedPath: input.requestedPath, previous: input.previousSnapshotId ?? null });
      try { assertActiveAuthority(input); }
      catch (error) {
        if (error instanceof RepositorySnapshotAuthorityError) deps.appendJobEvent({ jobId: input.jobId, attemptId: input.attemptId, generation: input.generation, type: 'repository.snapshot_rejected_stale', payload: null, producer: input.producer, idempotencyKey: `repository-capture-stale:${eventKey}` });
        throw error;
      }
      const descriptor = await resolveWorkspace(input.requestedPath);
      deps.appendJobEvent({ jobId: input.jobId, attemptId: input.attemptId, generation: input.generation, type: 'repository.workspace_resolved', payload: { workspaceId: descriptor.id, vcsKind: descriptor.vcsKind }, producer: input.producer, idempotencyKey: `repository-workspace:${input.attemptId}:${input.generation}:${descriptor.id}` });
      deps.appendJobEvent({ jobId: input.jobId, attemptId: input.attemptId, generation: input.generation, type: 'repository.snapshot_capture_started', payload: null, producer: input.producer, idempotencyKey: `repository-capture-started:${eventKey}` });
      const state = await gatherState(input.requestedPath, input.policy, descriptor);
      const snapshotId = `repository_snapshot_${randomBytes(16).toString('hex')}`;
      const capturedAt = Date.now();
      const persist = db.transaction(() => {
        assertActiveAuthority(input);
        if (input.previousSnapshotId) {
          const previous = getSnapshot(input.previousSnapshotId);
          if (!previous || previous.jobId !== input.jobId || previous.attemptId !== input.attemptId || previous.generation !== input.generation) throw new RepositorySnapshotAuthorityError('INVALID_REPOSITORY_SNAPSHOT_ANCESTRY', 'Previous snapshot is outside the active Attempt lineage');
          const latest = db.prepare('SELECT snapshot_id FROM repository_snapshots WHERE attempt_id=? AND generation=? ORDER BY captured_at DESC, rowid DESC LIMIT 1').get(input.attemptId, input.generation) as { snapshot_id: string } | undefined;
          if (latest && latest.snapshot_id !== input.previousSnapshotId) throw new RepositorySnapshotAuthorityError('INVALID_REPOSITORY_SNAPSHOT_ANCESTRY', 'Previous snapshot is not the current lineage head');
        }
        const d = state.descriptor;
        db.prepare(`INSERT OR IGNORE INTO workspace_descriptors (workspace_id,requested_path,canonical_path,portable_path,path_kind,platform,exists_flag,repository_root,git_directory,git_common_directory,outer_repository_root,vcs_kind,trust_policy_digest,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id,d.requestedPath,d.canonicalPath,d.portablePath,d.pathKind,d.platform,d.exists?1:0,d.repositoryRoot??null,d.gitDirectory??null,d.gitCommonDirectory??null,d.outerRepositoryRoot??null,d.vcsKind,d.trustPolicyDigest,capturedAt);
        db.prepare(`INSERT INTO repository_snapshots (snapshot_id,workspace_id,job_id,attempt_id,generation,repository_root,vcs_kind,branch,head_commit,upstream,index_digest,working_tree_digest,capture_policy_digest,capture_policy_json,incomplete,incomplete_reasons_json,previous_snapshot_id,state_digest,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(snapshotId,d.id,input.jobId,input.attemptId,input.generation,d.repositoryRoot??null,d.vcsKind,state.branch,state.headCommit,state.upstream,state.indexDigest,state.workingTreeDigest,state.capturePolicyDigest,JSON.stringify(state.policy),state.incompleteReasons.length?1:0,JSON.stringify(state.incompleteReasons),input.previousSnapshotId??null,state.stateDigest,capturedAt);
        const insert = db.prepare(`INSERT INTO repository_snapshot_entries (snapshot_id,relative_path,canonical_identity,classification,git_state,size,modified_at,mode,content_hash,capture_status,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        for (const entry of state.entries) insert.run(snapshotId,entry.path,entry.canonicalIdentity,entry.classification,entry.gitState,entry.size,entry.modifiedAt,entry.mode,entry.contentHash,entry.captureStatus,entry.reason);
        db.prepare('UPDATE tasks SET repository_snapshot_id=COALESCE(repository_snapshot_id,?) WHERE id=?').run(snapshotId,input.jobId);
        db.prepare('UPDATE runs SET repository_snapshot_id=COALESCE(repository_snapshot_id,?) WHERE attempt_id=? AND generation=?').run(snapshotId,input.attemptId,input.generation);
      }).immediate;
      try { persist(); }
      catch (error) {
        if (error instanceof RepositorySnapshotAuthorityError && error.code === 'STALE_REPOSITORY_SNAPSHOT_AUTHORITY') deps.appendJobEvent({ jobId: input.jobId, attemptId: input.attemptId, generation: input.generation, type: 'repository.snapshot_rejected_stale', payload: null, producer: input.producer, idempotencyKey: `repository-capture-stale:${eventKey}` });
        throw error;
      }
      deps.appendJobEvent({ jobId: input.jobId, attemptId: input.attemptId, generation: input.generation, type: 'repository.snapshot_captured', payload: { snapshotId, stateDigest: state.stateDigest, workspaceId: state.descriptor.id }, producer: input.producer, idempotencyKey: `repository-captured:${snapshotId}` });
      if (state.incompleteReasons.length) deps.appendJobEvent({ jobId: input.jobId, attemptId: input.attemptId, generation: input.generation, type: 'repository.snapshot_incomplete', payload: { snapshotId, reasons: state.incompleteReasons }, producer: input.producer, idempotencyKey: `repository-incomplete:${snapshotId}` });
      return getSnapshot(snapshotId)!;
    },
    getSnapshot,
    getWorkspace(workspaceId) { const row = descriptorFor(workspaceId); return row ? mapDescriptor(row) : undefined; },
    getAttemptSnapshot(jobId, attemptId) {
      const row = db.prepare(`SELECT s.* FROM runs r JOIN repository_snapshots s ON s.snapshot_id=r.repository_snapshot_id WHERE r.task_id=? AND r.attempt_id=?`).get(jobId, attemptId) as Record<string, unknown> | undefined;
      return row ? rowToRecord(row) : undefined;
    },
    getEntry(snapshotId, relativePath) {
      if (!getSnapshot(snapshotId)) return undefined;
      return entriesFor(snapshotId).find((entry) => entry.path === normalizeRelative(relativePath));
    },
    compareSnapshots(baseId, currentId) {
      const base = getSnapshot(baseId); const current = getSnapshot(currentId);
      if (!base || !current || base.workspaceId !== current.workspaceId) throw new RepositorySnapshotAuthorityError('SNAPSHOT_NOT_COMPARABLE', 'Snapshots must exist in the same workspace');
      const a = new Map(entriesFor(baseId).map((entry) => [entry.path, entry])); const b = new Map(entriesFor(currentId).map((entry) => [entry.path, entry]));
      const added = [...b.keys()].filter((key) => !a.has(key)); const removed = [...a.keys()].filter((key) => !b.has(key));
      const changed = [...a.keys()].filter((key) => b.has(key) && digest(a.get(key)) !== digest(b.get(key)));
      deps.appendJobEvent({ jobId: current.jobId, attemptId: current.attemptId, generation: current.generation, type: 'repository.snapshot_compared', payload: { baseId, currentId, added: added.length, removed: removed.length, changed: changed.length }, producer: 'repository-snapshot', idempotencyKey: `repository-compared:${baseId}:${currentId}` });
      return { baseId, currentId, added, removed, changed };
    },
    async inventory(snapshotId, options = {}) {
      const snapshot = getSnapshot(snapshotId); if (!snapshot) throw new RepositorySnapshotAuthorityError('SNAPSHOT_NOT_FOUND', 'Repository snapshot not found');
      const all = entriesFor(snapshotId); const start = options.cursor ? Math.max(0, all.findIndex((entry) => entry.path === options.cursor) + 1) : 0; const limit = Math.max(1, Math.min(5_000, options.limit ?? 200)); const entries = all.slice(start, start + limit); const truncated = start + entries.length < all.length;
      return { snapshotId, stateDigest: snapshot.stateDigest, entries, nextCursor: truncated ? entries[entries.length - 1]?.path ?? null : null, truncated, stale: await stale(snapshot) };
    },
    async readFile(snapshotId, relativePath, options = {}) {
      const snapshot = getSnapshot(snapshotId); if (!snapshot) throw new RepositorySnapshotAuthorityError('SNAPSHOT_NOT_FOUND', 'Repository snapshot not found');
      const entry = entriesFor(snapshotId).find((candidate) => candidate.path === normalizeRelative(relativePath)); if (!entry || entry.captureStatus !== 'captured') throw new RepositorySnapshotAuthorityError('SNAPSHOT_PATH_NOT_READABLE', 'Path content is not captured by this snapshot policy');
      const root = rootFor(snapshot); const absolute = realpathWithFallback(path.join(root, relativePath)); if (!isWithin(absolute, root)) throw new RepositorySnapshotAuthorityError('PATH_OUTSIDE_WORKSPACE', 'Path resolves outside the snapshot workspace');
      const policy = isPathAllowed(absolute, 'read', root); if (!policy.allowed) throw new RepositorySnapshotAuthorityError('PATH_NOT_ALLOWED', policy.violation?.message ?? 'Path is not allowed');
      const bytes = await fs.readFile(absolute); const text = bytes.toString('utf8'); const offset = Math.max(0, options.offset ?? 0); const limit = Math.max(1, Math.min(1_000_000, options.limit ?? (text.length || 1))); const page = text.slice(offset, offset + limit);
      return { snapshotId, stateDigest: snapshot.stateDigest, path: entry.path, canonicalIdentity: entry.canonicalIdentity, size: bytes.length, modifiedAt: (await fs.stat(absolute)).mtimeMs, fullContentHash: createHash(HASH).update(bytes).digest('hex'), pageContentHash: createHash(HASH).update(page).digest('hex'), fullFileHash: true, offset, limit, content: page, truncated: offset + page.length < text.length, capturedAt: snapshot.capturedAt, encoding: bytes.subarray(0,8192).includes(0) ? 'binary' : 'utf8', stale: await stale(snapshot) };
    },
    async search(snapshotId, query, options = {}) {
      const snapshot = getSnapshot(snapshotId); if (!snapshot) throw new RepositorySnapshotAuthorityError('SNAPSHOT_NOT_FOUND', 'Repository snapshot not found');
      if (!query) throw new RepositorySnapshotAuthorityError('INVALID_SEARCH_QUERY', 'Lexical search query must not be empty');
      const limit = Math.max(1, Math.min(1_000, options.limit ?? 100)); const matches: Array<{path:string;line:number;column:number;text:string}> = []; let truncated = false; const root = rootFor(snapshot);
      outer: for (const entry of entriesFor(snapshotId)) {
        if (entry.captureStatus !== 'captured' || !entry.contentHash || options.include && !options.include.test(entry.path) || options.exclude?.test(entry.path)) continue;
        const absolute = realpathWithFallback(path.join(root, entry.path)); if (!isWithin(absolute, root)) continue;
        const lines = (await fs.readFile(absolute, 'utf8')).split(/\r?\n/);
        for (let line = 0; line < lines.length; line++) { const column = lines[line].indexOf(query); if (column < 0) continue; if (matches.length >= limit) { truncated = true; break outer; } matches.push({ path: entry.path, line: line + 1, column: column + 1, text: lines[line].slice(0, 500) }); }
      }
      return { snapshotId, stateDigest: snapshot.stateDigest, matches, truncated, stale: await stale(snapshot) };
    },
    discoverInstructions(snapshotId) {
      if (!getSnapshot(snapshotId)) throw new RepositorySnapshotAuthorityError('SNAPSHOT_NOT_FOUND', 'Repository snapshot not found');
      return entriesFor(snapshotId).filter((entry) => entry.classification === 'instruction').map((entry, index) => ({ path: entry.path, contentHash: entry.contentHash, scope: path.posix.dirname(entry.path), precedence: index, trust: 'repository' as const, snapshotId }));
    },
  };
}
