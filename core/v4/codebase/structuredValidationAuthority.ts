/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { Db } from '../daemon/db/connection';
import type { AttemptRecord, JobRecord } from '../daemon/jobEngine';
import type { JobProofAuthority } from '../daemon/jobProofAuthority';
import { scrubString } from '../logger/redact';
import { McpCredentialFilter } from '../mcp/credentialFilter';
import { isWithin, realpathWithFallback } from '../sandboxFs';
import type { RepositorySnapshotAuthority, RepositorySnapshotRecord } from './repositorySnapshotAuthority';

export type ValidationKind = 'test' | 'build';
export type ValidationScope = 'focused' | 'full';
export type ValidationRunState =
  | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  | 'environment_failed' | 'unknown';

export interface StructuredValidationPlan {
  kind: ValidationKind;
  command: string;
  workingDirectory: string;
  scope: ValidationScope;
  outputPaths?: string[];
}

export interface ValidationEnvironment {
  platform: string;
  architecture: string;
  nodeVersion: string;
  npmVersion: string;
  toolVersions?: Record<string, string>;
  variables?: Record<string, string>;
}

export interface ValidationExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ValidationOutputArtifact {
  path: string;
  sha256: string;
  byteCount: number;
}

export interface StructuredValidationRun {
  runId: string;
  kind: ValidationKind;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  toolCallId: string;
  effectId: string;
  executionNodeId: string | null;
  repositorySnapshotId: string;
  sourceStateDigest: string;
  command: string;
  workingDirectory: string;
  environmentFingerprint: string;
  environment: ValidationEnvironment;
  scope: ValidationScope;
  state: ValidationRunState;
  startedAt: number;
  completedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  parseState: 'pending' | 'parsed' | 'unparsed';
  resultingSnapshotId: string | null;
  sourceMutations: string[];
  rawLogEvidenceId: string | null;
  claimIds: string[];
  artifactIds: string[];
  passedCount?: number | null;
  failedCount?: number | null;
  skippedCount?: number | null;
  failedTestIds?: string[];
  outputArtifacts?: ValidationOutputArtifact[];
  outputHashes?: Record<string, string>;
  packageIdentity?: Record<string, unknown> | null;
  warnings?: string[];
  reproducibility?: Record<string, unknown>;
}

export interface ValidationArtifactRecord {
  artifactId: string;
  runId: string;
  kind: 'log' | 'build_output';
  relativePath: string | null;
  sha256: string;
  byteCount: number;
  mediaType: string;
  compression: 'gzip' | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface ValidationDiagnosticRecord {
  diagnosticId: string;
  runId: string;
  repositorySnapshotId: string;
  tool: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  code: string | null;
  createdAt: number;
}

export interface ValidationDiscovery {
  snapshotId: string;
  sources: Array<{ kind: 'manifest' | 'lockfile' | 'workflow' | 'instruction'; path: string }>;
  commands: Array<{ command: string; kind: ValidationKind; source: string }>;
}

export interface StructuredValidationAuthority {
  start(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    repositorySnapshotId: string; toolCallId: string; effectId: string;
    plan: StructuredValidationPlan; environment: ValidationEnvironment; producer: string;
    now?: number;
  }): StructuredValidationRun;
  complete(input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
    runId: string; execution: ValidationExecutionResult;
    rawOutput?: { stdout: string; stderr: string };
    producer: string; now?: number;
  }): Promise<{ run: StructuredValidationRun; diagnostics: ValidationDiagnosticRecord[] }>;
  getRun(runId: string): StructuredValidationRun | undefined;
  getArtifact(artifactId: string): ValidationArtifactRecord | undefined;
  readLogArtifact(artifactId: string): string;
  listDiagnostics(runId: string): ValidationDiagnosticRecord[];
  assess(runId: string, input: {
    repositorySnapshotId: string; requiredScope?: ValidationScope;
  }): Promise<{ usable: boolean; reasons: string[] }>;
  discover(snapshotId: string, explicitCommands?: Array<{ command: string; kind: ValidationKind }>): Promise<ValidationDiscovery>;
}

export class StructuredValidationAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StructuredValidationAuthorityError';
  }
}

export function structuredValidationPlanForShell(
  command: string,
  workingDirectory: string,
): StructuredValidationPlan | null {
  const normalized = command.trim();
  const testCommand = /(?:^|\s)(?:npm\s+(?:run\s+)?test(?::[^\s]+)?|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|vitest|jest|pytest|cargo\s+test|go\s+test)(?:\s|$)/i;
  if (testCommand.test(normalized)) {
    const focused = /(?:--run\s+\S+|\.(?:test|spec)\.[cm]?[jt]sx?\b|pytest\s+\S+)/i.test(normalized);
    return { kind: 'test', command: normalized, workingDirectory, scope: focused ? 'focused' : 'full' };
  }
  const buildCommand = /(?:^|\s)(?:npm\s+run\s+(?:build|typecheck|lint)|pnpm\s+(?:run\s+)?(?:build|typecheck|lint)|yarn\s+(?:run\s+)?(?:build|typecheck|lint)|tsc|cargo\s+build|go\s+build)(?:\s|$)/i;
  if (!buildCommand.test(normalized)) return null;
  const producesBuildOutput = /(?:^|\s)(?:npm\s+run\s+build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|cargo\s+build|go\s+build)(?:\s|$)/i.test(normalized);
  return {
    kind: 'build', command: normalized, workingDirectory, scope: 'full',
    ...(producesBuildOutput ? { outputPaths: ['dist', 'build', 'target'] } : {}),
  };
}

interface Deps {
  db: Db;
  repository: RepositorySnapshotAuthority;
  proof: JobProofAuthority;
  getJob(jobId: string): JobRecord | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  appendJobEvent(command: {
    jobId: string; attemptId: string; generation: number; type: string;
    payload?: Record<string, unknown> | null; producer: string; idempotencyKey: string;
  }): { applied: boolean; duplicate: boolean; conflict?: string };
}

const HASH = 'sha256';
const credentialFilter = new McpCredentialFilter();
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g; // eslint-disable-line no-control-regex
const id = (prefix: string): string => `${prefix}_${randomBytes(16).toString('hex')}`;
const sha256 = (value: string | Buffer): string => createHash(HASH).update(value).digest('hex');
const normalizeRelative = (value: string): string => value.split(path.sep).join('/').replace(/^\.\//, '');

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function sanitizeLog(value: string): string {
  const withoutAnsi = value.replace(ANSI_RE, '');
  const labelled = withoutAnsi.replace(
    /\b(credential|api[_-]?key|token|password|secret)(\s*[=:]\s*)([^\s,;]{6,})/gi,
    '$1$2[REDACTED]',
  );
  return credentialFilter.redact(scrubString(labelled));
}

function terminal(status: string): boolean {
  return ['completed', 'succeeded', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown', 'dead_letter'].includes(status);
}

function executionState(result: ValidationExecutionResult): ValidationRunState {
  if (result.cancelled) return 'cancelled';
  if (result.timedOut) return 'timed_out';
  if (/\b(?:ENOENT|EACCES|EPERM|command not found|not recognized as an internal|unable to load native|MODULE_NOT_FOUND)\b/i.test(result.stderr)) {
    return 'environment_failed';
  }
  return result.exitCode === 0 ? 'succeeded' : 'failed';
}

function parseTestResult(output: string): {
  parsed: boolean; passed: number | null; failed: number | null; skipped: number | null; failedIds: string[];
} {
  const count = (label: string): number | null => {
    const match = output.match(new RegExp(`(?:^|\\s)(\\d+)\\s+${label}\\b`, 'im'));
    return match ? Number(match[1]) : null;
  };
  const passed = count('passed');
  const failed = count('failed');
  const skipped = count('skipped');
  const failedIds = [...output.matchAll(/^\s*(?:FAIL|×|✗)\s+(.+)$/gim)].map((match) => match[1].trim()).slice(0, 500);
  const parsed = passed !== null || failed !== null || skipped !== null;
  return {
    parsed,
    passed: parsed ? passed ?? 0 : null,
    failed: parsed ? failed ?? 0 : null,
    skipped: parsed ? skipped ?? 0 : null,
    failedIds,
  };
}

function diagnosticTool(command: string): string {
  const first = command.trim().split(/\s+/)[0];
  return first || 'validation';
}

function parseDiagnostics(
  runId: string,
  snapshotId: string,
  command: string,
  output: string,
  now: number,
): ValidationDiagnosticRecord[] {
  const records: ValidationDiagnosticRecord[] = [];
  const pattern = /^(.*?):(\d+):(\d+)\s+(?:(error|warning|info)\s+)?([A-Z]+\d+):\s*(.+)$/gim;
  for (const match of output.matchAll(pattern)) {
    records.push({
      diagnosticId: id('diagnostic'), runId, repositorySnapshotId: snapshotId,
      tool: diagnosticTool(command), severity: (match[4]?.toLowerCase() ?? 'error') as ValidationDiagnosticRecord['severity'],
      message: sanitizeLog(match[6]), path: normalizeRelative(match[1]), line: Number(match[2]),
      column: Number(match[3]), endLine: null, endColumn: null, code: match[5], createdAt: now,
    });
  }
  return records;
}

function rowToArtifact(row: Record<string, unknown>): ValidationArtifactRecord {
  return {
    artifactId: String(row.artifact_id), runId: String(row.run_id),
    kind: row.kind as ValidationArtifactRecord['kind'],
    relativePath: row.relative_path === null ? null : String(row.relative_path),
    sha256: String(row.sha256), byteCount: Number(row.byte_count), mediaType: String(row.media_type),
    compression: row.compression === null ? null : row.compression as 'gzip',
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>, createdAt: Number(row.created_at),
  };
}

function rowToDiagnostic(row: Record<string, unknown>): ValidationDiagnosticRecord {
  return {
    diagnosticId: String(row.diagnostic_id), runId: String(row.run_id),
    repositorySnapshotId: String(row.repository_snapshot_id), tool: String(row.tool),
    severity: row.severity as ValidationDiagnosticRecord['severity'], message: String(row.message),
    path: row.relative_path === null ? null : String(row.relative_path),
    line: row.start_line === null ? null : Number(row.start_line),
    column: row.start_column === null ? null : Number(row.start_column),
    endLine: row.end_line === null ? null : Number(row.end_line),
    endColumn: row.end_column === null ? null : Number(row.end_column),
    code: row.code === null ? null : String(row.code), createdAt: Number(row.created_at),
  };
}

export function createStructuredValidationAuthority(deps: Deps): StructuredValidationAuthority {
  const { db } = deps;

  const assertAuthority = (input: {
    jobId: string; attemptId: string; generation: number; fenceToken: string;
  }): void => {
    const job = deps.getJob(input.jobId);
    const attempt = deps.getAttempt(input.attemptId);
    if (!job || !attempt || attempt.jobId !== job.id || job.activeAttemptId !== attempt.id
      || terminal(job.status) || terminal(attempt.status) || attempt.generation !== input.generation
      || attempt.fenceToken !== input.fenceToken || attempt.leaseExpiresAt === null
      || attempt.leaseExpiresAt <= Date.now()) {
      throw new StructuredValidationAuthorityError(
        'STALE_VALIDATION_AUTHORITY',
        'Attempt generation or fence no longer owns this validation record',
      );
    }
  };

  const rootFor = (snapshot: RepositorySnapshotRecord): string => {
    const workspace = deps.repository.getWorkspace(snapshot.workspaceId);
    if (!workspace) throw new StructuredValidationAuthorityError('WORKSPACE_NOT_FOUND', 'Validation workspace is unavailable');
    return realpathWithFallback(snapshot.repositoryRoot ?? workspace.canonicalPath);
  };

  const getRun = (runId: string): StructuredValidationRun | undefined => {
    const row = db.prepare('SELECT * FROM validation_runs WHERE run_id=?').get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const common: StructuredValidationRun = {
      runId: String(row.run_id), kind: row.kind as ValidationKind, jobId: String(row.job_id),
      attemptId: String(row.attempt_id), generation: Number(row.generation), fenceToken: String(row.fence_token),
      toolCallId: String(row.tool_call_id), effectId: String(row.effect_id),
      executionNodeId: row.execution_node_id === null ? null : String(row.execution_node_id),
      repositorySnapshotId: String(row.repository_snapshot_id), sourceStateDigest: String(row.source_state_digest),
      command: String(row.command), workingDirectory: String(row.working_directory),
      environmentFingerprint: String(row.environment_fingerprint),
      environment: JSON.parse(String(row.environment_json)) as ValidationEnvironment,
      scope: row.scope as ValidationScope, state: row.state as ValidationRunState,
      startedAt: Number(row.started_at), completedAt: row.completed_at === null ? null : Number(row.completed_at),
      exitCode: row.exit_code === null ? null : Number(row.exit_code), timedOut: Number(row.timed_out) === 1,
      cancelled: Number(row.cancelled) === 1, parseState: row.parse_state as StructuredValidationRun['parseState'],
      resultingSnapshotId: row.resulting_snapshot_id === null ? null : String(row.resulting_snapshot_id),
      sourceMutations: JSON.parse(String(row.source_mutations_json)) as string[],
      rawLogEvidenceId: row.raw_log_evidence_id === null ? null : String(row.raw_log_evidence_id),
      claimIds: JSON.parse(String(row.claim_ids_json)) as string[],
      artifactIds: JSON.parse(String(row.artifact_ids_json)) as string[],
    };
    if (common.kind === 'test') {
      const detail = db.prepare('SELECT * FROM test_run_details WHERE run_id=?').get(runId) as Record<string, unknown>;
      common.passedCount = detail.passed_count === null ? null : Number(detail.passed_count);
      common.failedCount = detail.failed_count === null ? null : Number(detail.failed_count);
      common.skippedCount = detail.skipped_count === null ? null : Number(detail.skipped_count);
      common.failedTestIds = JSON.parse(String(detail.failed_test_ids_json)) as string[];
    } else {
      const detail = db.prepare('SELECT * FROM build_run_details WHERE run_id=?').get(runId) as Record<string, unknown>;
      common.outputArtifacts = JSON.parse(String(detail.output_artifacts_json)) as ValidationOutputArtifact[];
      common.outputHashes = JSON.parse(String(detail.output_hashes_json)) as Record<string, string>;
      common.packageIdentity = detail.package_identity_json === null
        ? null : JSON.parse(String(detail.package_identity_json)) as Record<string, unknown>;
      common.warnings = JSON.parse(String(detail.warnings_json)) as string[];
      common.reproducibility = JSON.parse(String(detail.reproducibility_json)) as Record<string, unknown>;
    }
    return common;
  };

  const getArtifact = (artifactId: string): ValidationArtifactRecord | undefined => {
    const row = db.prepare('SELECT * FROM validation_artifacts WHERE artifact_id=?').get(artifactId) as Record<string, unknown> | undefined;
    return row ? rowToArtifact(row) : undefined;
  };

  const listDiagnostics = (runId: string): ValidationDiagnosticRecord[] => (
    db.prepare('SELECT * FROM validation_diagnostics WHERE run_id=? ORDER BY created_at,diagnostic_id').all(runId) as Array<Record<string, unknown>>
  ).map(rowToDiagnostic);

  const outputFiles = async (
    root: string,
    requested: readonly string[],
  ): Promise<Array<{ relative: string; absolute: string; bytes: Buffer }>> => {
    const files: Array<{ relative: string; absolute: string; bytes: Buffer }> = [];
    const visit = async (absolute: string): Promise<void> => {
      const resolved = realpathWithFallback(absolute);
      if (!isWithin(resolved, root) || resolved === root) {
        throw new StructuredValidationAuthorityError('OUTPUT_OUTSIDE_WORKSPACE', 'Build output resolves outside the repository workspace');
      }
      let stat;
      try { stat = await fs.stat(resolved); } catch { return; }
      if (stat.isDirectory()) {
        for (const entry of (await fs.readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (files.length >= 5_000) throw new StructuredValidationAuthorityError('OUTPUT_LIMIT', 'Build output file limit exceeded');
          await visit(path.join(resolved, entry.name));
        }
      } else if (stat.isFile()) {
        const relative = normalizeRelative(path.relative(root, resolved));
        files.push({ relative, absolute: resolved, bytes: await fs.readFile(resolved) });
      }
    };
    for (const requestedPath of requested) {
      const absolute = path.resolve(root, requestedPath);
      if (!isWithin(absolute, root) || absolute === root) {
        throw new StructuredValidationAuthorityError('OUTPUT_OUTSIDE_WORKSPACE', 'Build output path is outside the repository workspace');
      }
      await visit(absolute);
    }
    return files.sort((a, b) => a.relative.localeCompare(b.relative));
  };

  const authority: StructuredValidationAuthority = {
    start(input) {
      assertAuthority(input);
      const snapshot = deps.repository.getSnapshot(input.repositorySnapshotId);
      if (!snapshot || snapshot.jobId !== input.jobId || snapshot.attemptId !== input.attemptId
        || snapshot.generation !== input.generation) {
        throw new StructuredValidationAuthorityError('SNAPSHOT_BINDING_MISMATCH', 'Validation source snapshot does not match the active Attempt');
      }
      const tool = db.prepare(
        'SELECT state,side_effect_id FROM tool_calls WHERE tool_call_id=? AND attempt_id=? AND generation=?',
      ).get(input.toolCallId, input.attemptId, input.generation) as { state: string; side_effect_id: string | null } | undefined;
      if (!tool || tool.state !== 'started' || tool.side_effect_id !== input.effectId) {
        throw new StructuredValidationAuthorityError('TOOL_CALL_BINDING_MISMATCH', 'Validation must bind the active shell ToolCall and Effect');
      }
      const root = rootFor(snapshot);
      const workingDirectory = realpathWithFallback(path.resolve(input.plan.workingDirectory));
      if (!isWithin(workingDirectory, root) && workingDirectory !== root) {
        throw new StructuredValidationAuthorityError('WORKING_DIRECTORY_OUTSIDE_WORKSPACE', 'Validation working directory is outside the repository workspace');
      }
      const environmentFingerprint = fingerprint(input.environment);
      const existing = db.prepare(
        'SELECT run_id FROM validation_runs WHERE attempt_id=? AND generation=? AND tool_call_id=? AND kind=?',
      ).get(input.attemptId, input.generation, input.toolCallId, input.plan.kind) as { run_id: string } | undefined;
      if (existing) {
        const record = getRun(existing.run_id)!;
        if (record.repositorySnapshotId !== input.repositorySnapshotId
          || record.command !== input.plan.command || record.workingDirectory !== workingDirectory
          || record.environmentFingerprint !== environmentFingerprint || record.scope !== input.plan.scope) {
          throw new StructuredValidationAuthorityError('VALIDATION_IDEMPOTENCY_CONFLICT', 'Validation ToolCall was already bound to different inputs');
        }
        if (record.kind === 'build') {
          const outputPaths = db.prepare('SELECT declared_output_paths_json FROM build_run_details WHERE run_id=?')
            .get(record.runId) as { declared_output_paths_json: string };
          if (fingerprint(JSON.parse(outputPaths.declared_output_paths_json)) !== fingerprint(input.plan.outputPaths ?? [])) {
            throw new StructuredValidationAuthorityError('VALIDATION_IDEMPOTENCY_CONFLICT', 'Validation ToolCall was already bound to different inputs');
          }
        }
        return record;
      }
      const runId = id(input.plan.kind === 'test' ? 'test_run' : 'build_run');
      const now = input.now ?? Date.now();
      const executionNode = db.prepare(
        `SELECT n.node_id
           FROM execution_graph_nodes n
           JOIN execution_node_attempts x ON x.node_id=n.node_id
          WHERE n.job_id=? AND x.attempt_id=? AND x.generation=? AND x.state='running'
          ORDER BY x.started_at DESC,x.node_execution_id DESC LIMIT 1`,
      ).get(input.jobId, input.attemptId, input.generation) as { node_id: string } | undefined;
      const claim = deps.proof.createClaim({
        jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        category: 'observed', statement: `${input.plan.kind} validation completed for snapshot ${snapshot.id}`,
        required: false, repositorySnapshotId: snapshot.id, now,
      });
      db.transaction(() => {
        db.prepare(
          `INSERT INTO validation_runs (
             run_id,kind,job_id,attempt_id,generation,fence_token,tool_call_id,effect_id,execution_node_id,
             repository_snapshot_id,source_state_digest,command,working_directory,
             environment_fingerprint,environment_json,scope,state,started_at,claim_ids_json
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?)`,
        ).run(
          runId, input.plan.kind, input.jobId, input.attemptId, input.generation, input.fenceToken,
          input.toolCallId, input.effectId, executionNode?.node_id ?? null, snapshot.id, snapshot.stateDigest, input.plan.command,
          workingDirectory, environmentFingerprint, JSON.stringify(stableValue(input.environment)),
          input.plan.scope, now, JSON.stringify([claim.claimId]),
        );
        if (input.plan.kind === 'test') {
          db.prepare('INSERT INTO test_run_details (run_id) VALUES (?)').run(runId);
        } else {
          db.prepare('INSERT INTO build_run_details (run_id,declared_output_paths_json) VALUES (?,?)')
            .run(runId, JSON.stringify(input.plan.outputPaths ?? []));
        }
      }).immediate();
      deps.appendJobEvent({
        jobId: input.jobId, attemptId: input.attemptId, generation: input.generation,
        type: `validation.${input.plan.kind}.started`,
        payload: { runId, snapshotId: snapshot.id, scope: input.plan.scope, environmentFingerprint },
        producer: input.producer, idempotencyKey: `validation-started:${runId}`,
      });
      return getRun(runId)!;
    },

    async complete(input) {
      assertAuthority(input);
      const current = getRun(input.runId);
      if (!current) throw new StructuredValidationAuthorityError('VALIDATION_NOT_FOUND', 'Validation record was not found');
      if (current.jobId !== input.jobId || current.attemptId !== input.attemptId
        || current.generation !== input.generation || current.fenceToken !== input.fenceToken) {
        throw new StructuredValidationAuthorityError('VALIDATION_BINDING_MISMATCH', 'Validation completion does not match its producing Attempt');
      }
      if (current.state !== 'running') return { run: current, diagnostics: listDiagnostics(current.runId) };

      const now = input.now ?? Date.now();
      const snapshot = deps.repository.getSnapshot(current.repositorySnapshotId)!;
      const root = rootFor(snapshot);
      const state = executionState(input.execution);
      const combined = `${input.execution.stdout}${input.execution.stderr ? `\n${input.execution.stderr}` : ''}`;
      const rawCombined = input.rawOutput
        ? `${input.rawOutput.stdout}${input.rawOutput.stderr ? `\n${input.rawOutput.stderr}` : ''}`
        : combined;
      const sanitized = sanitizeLog(rawCombined);
      const compressed = gzipSync(Buffer.from(sanitized, 'utf8'));
      const logArtifactId = id('validation_artifact');
      const artifactIds = [logArtifactId];
      const parsedTest = current.kind === 'test' ? parseTestResult(combined) : null;
      const outputArtifacts: ValidationOutputArtifact[] = [];
      const outputHashes: Record<string, string> = {};
      let packageIdentity: Record<string, unknown> | null = null;
      const warnings = [...combined.matchAll(/^\s*(?:warning|warn)[:\s]+(.+)$/gim)]
        .map((match) => sanitizeLog(match[1])).slice(0, 500);

      if (current.kind === 'build' && state === 'succeeded') {
        const detail = db.prepare('SELECT declared_output_paths_json FROM build_run_details WHERE run_id=?')
          .get(current.runId) as { declared_output_paths_json: string };
        const requested = JSON.parse(detail.declared_output_paths_json) as string[];
        for (const output of await outputFiles(root, requested)) {
          const hash = sha256(output.bytes);
          const artifactId = id('validation_artifact');
          outputArtifacts.push({ path: output.relative, sha256: hash, byteCount: output.bytes.length });
          outputHashes[output.relative] = hash;
          artifactIds.push(artifactId);
          db.prepare(
            `INSERT INTO validation_artifacts
               (artifact_id,run_id,kind,relative_path,sha256,byte_count,media_type,compression,content_blob,metadata_json,created_at)
             VALUES (?,?,'build_output',?,?,?,?,NULL,NULL,?,?)`,
          ).run(artifactId, current.runId, output.relative, hash, output.bytes.length,
            'application/octet-stream', JSON.stringify({ capturedFrom: output.relative }), now);
        }
        try {
          const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
          packageIdentity = { name: manifest.name ?? null, version: manifest.version ?? null };
        } catch { /* package identity is optional */ }
      }

      db.prepare(
        `INSERT INTO validation_artifacts
           (artifact_id,run_id,kind,relative_path,sha256,byte_count,media_type,compression,content_blob,metadata_json,created_at)
         VALUES (?,?,'log',NULL,?,?,'text/plain; charset=utf-8','gzip',?,'{}',?)`,
      ).run(logArtifactId, current.runId, sha256(sanitized), Buffer.byteLength(sanitized), compressed, now);

      let resultingSnapshotId: string | null = null;
      let sourceMutations: string[] = [];
      const inventory = await deps.repository.inventory(snapshot.id, { limit: 1 });
      if (inventory.stale) {
        const descendant = await deps.repository.captureSnapshot({
          jobId: current.jobId, attemptId: current.attemptId, generation: current.generation,
          fenceToken: current.fenceToken, requestedPath: root, previousSnapshotId: snapshot.id,
          producer: input.producer,
        });
        resultingSnapshotId = descendant.id;
        const comparison = deps.repository.compareSnapshots(snapshot.id, descendant.id);
        const allChanges = [...comparison.added, ...comparison.removed, ...comparison.changed];
        const declaredOutputs = current.kind === 'build'
          ? (db.prepare('SELECT declared_output_paths_json FROM build_run_details WHERE run_id=?')
            .get(current.runId) as { declared_output_paths_json: string })
          : null;
        const outputPrefixes = declaredOutputs
          ? (JSON.parse(declaredOutputs.declared_output_paths_json) as string[]).map((item) => normalizeRelative(item).replace(/\/$/, ''))
          : [];
        sourceMutations = [...new Set(allChanges.filter((changed) => !outputPrefixes.some(
          (prefix) => changed === prefix || changed === `${prefix}/` || changed.startsWith(`${prefix}/`),
        )))].sort();
      }

      const parseState: StructuredValidationRun['parseState'] = current.kind === 'test'
        ? parsedTest!.parsed ? 'parsed' : 'unparsed'
        : outputArtifacts.length > 0 ? 'parsed' : 'unparsed';
      const semanticallyVerified = current.kind === 'test'
        ? state === 'succeeded' && parsedTest!.parsed
          && (parsedTest!.failed ?? 0) === 0 && sourceMutations.length === 0
        : state === 'succeeded' && outputArtifacts.length > 0 && sourceMutations.length === 0;

      const evidence = deps.proof.recordEvidence({
        jobId: current.jobId, attemptId: current.attemptId, generation: current.generation,
        fenceToken: current.fenceToken, effectId: current.effectId,
        repositorySnapshotId: snapshot.id,
        source: `validation.${current.kind}`, producer: input.producer, observedAt: now,
        coverage: semanticallyVerified ? 'full' : parseState === 'parsed' ? 'partial' : 'unknown',
        verificationResult: semanticallyVerified ? 'verified' : state === 'failed' ? 'failed' : 'unknown',
        payload: {
          runId: current.runId, repositorySnapshotId: snapshot.id, sourceStateDigest: snapshot.stateDigest,
          environmentFingerprint: current.environmentFingerprint, executionNodeId: current.executionNodeId,
          scope: current.scope, state,
          exitCode: input.execution.exitCode, parseState, logArtifactId, artifactIds,
          resultingSnapshotId, sourceMutations,
        }, now,
      });
      const claimState = semanticallyVerified ? 'verified' : state === 'failed' ? 'failed' : 'unknown';
      for (const claimId of current.claimIds) {
        deps.proof.checkClaim({
          claimId, attemptId: current.attemptId, generation: current.generation,
          evidenceIds: [evidence.evidenceId], state: claimState, now,
        });
      }

      const diagnostics = parseDiagnostics(current.runId, snapshot.id, current.command, combined, now);
      if (sourceMutations.length > 0) {
        diagnostics.push({
          diagnosticId: id('diagnostic'), runId: current.runId, repositorySnapshotId: snapshot.id,
          tool: diagnosticTool(current.command), severity: 'warning',
          message: 'Validation changed repository source; the result cannot verify the input snapshot',
          path: sourceMutations[0] ?? null, line: null, column: null, endLine: null, endColumn: null,
          code: 'VALIDATION_SOURCE_MUTATION', createdAt: now,
        });
      }
      for (const diagnostic of diagnostics) {
        db.prepare(
          `INSERT INTO validation_diagnostics (
             diagnostic_id,run_id,repository_snapshot_id,tool,severity,message,relative_path,
             start_line,start_column,end_line,end_column,code,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          diagnostic.diagnosticId, diagnostic.runId, diagnostic.repositorySnapshotId,
          diagnostic.tool, diagnostic.severity, diagnostic.message, diagnostic.path,
          diagnostic.line, diagnostic.column, diagnostic.endLine, diagnostic.endColumn,
          diagnostic.code, diagnostic.createdAt,
        );
      }

      db.prepare(
        `UPDATE validation_runs SET state=?,completed_at=?,exit_code=?,timed_out=?,cancelled=?,
           parse_state=?,resulting_snapshot_id=?,source_mutations_json=?,raw_log_evidence_id=?,artifact_ids_json=?
         WHERE run_id=? AND state='running'`,
      ).run(
        state, now, input.execution.exitCode, input.execution.timedOut ? 1 : 0,
        input.execution.cancelled ? 1 : 0, parseState, resultingSnapshotId,
        JSON.stringify(sourceMutations), evidence.evidenceId, JSON.stringify(artifactIds), current.runId,
      );
      if (current.kind === 'test') {
        db.prepare(
          `UPDATE test_run_details SET passed_count=?,failed_count=?,skipped_count=?,failed_test_ids_json=? WHERE run_id=?`,
        ).run(parsedTest!.passed, parsedTest!.failed, parsedTest!.skipped, JSON.stringify(parsedTest!.failedIds), current.runId);
      } else {
        db.prepare(
          `UPDATE build_run_details SET output_artifacts_json=?,output_hashes_json=?,package_identity_json=?,
             warnings_json=?,reproducibility_json=? WHERE run_id=?`,
        ).run(
          JSON.stringify(outputArtifacts), JSON.stringify(outputHashes), packageIdentity ? JSON.stringify(packageIdentity) : null,
          JSON.stringify(warnings), JSON.stringify({ environmentFingerprint: current.environmentFingerprint, sourceStateDigest: current.sourceStateDigest }),
          current.runId,
        );
      }
      deps.appendJobEvent({
        jobId: current.jobId, attemptId: current.attemptId, generation: current.generation,
        type: `validation.${current.kind}.completed`,
        payload: { runId: current.runId, state, snapshotId: snapshot.id, evidenceId: evidence.evidenceId, parseState },
        producer: input.producer, idempotencyKey: `validation-completed:${current.runId}`,
      });
      return { run: getRun(current.runId)!, diagnostics: listDiagnostics(current.runId) };
    },

    getRun,
    getArtifact,
    readLogArtifact(artifactId) {
      const row = db.prepare('SELECT kind,compression,content_blob FROM validation_artifacts WHERE artifact_id=?')
        .get(artifactId) as { kind: string; compression: string | null; content_blob: Buffer | null } | undefined;
      if (!row || row.kind !== 'log' || !row.content_blob) {
        throw new StructuredValidationAuthorityError('LOG_ARTIFACT_NOT_FOUND', 'Validation log artifact was not found');
      }
      const bytes = row.compression === 'gzip' ? gunzipSync(row.content_blob) : row.content_blob;
      return bytes.toString('utf8');
    },
    listDiagnostics,

    async assess(runId, input) {
      const run = getRun(runId);
      if (!run) return { usable: false, reasons: ['run_not_found'] };
      const reasons: string[] = [];
      if (run.repositorySnapshotId !== input.repositorySnapshotId) reasons.push('snapshot_mismatch');
      if (run.state !== 'succeeded') reasons.push('run_not_succeeded');
      if (run.parseState !== 'parsed') reasons.push('unparsed_result');
      if (run.sourceMutations.length > 0) reasons.push('source_mutated');
      if (input.requiredScope === 'full' && run.scope !== 'full') reasons.push('scope_too_narrow');
      const referenceSnapshotId = run.resultingSnapshotId ?? run.repositorySnapshotId;
      const reference = deps.repository.getSnapshot(referenceSnapshotId);
      if (!reference) reasons.push('snapshot_unavailable');
      else if ((await deps.repository.inventory(reference.id, { limit: 1 })).stale) reasons.push('source_changed');
      if (run.kind === 'build') {
        const snapshot = deps.repository.getSnapshot(run.repositorySnapshotId);
        if (!snapshot) reasons.push('snapshot_unavailable');
        else {
          const root = rootFor(snapshot);
          for (const artifact of run.outputArtifacts ?? []) {
            try {
              const absolute = realpathWithFallback(path.resolve(root, artifact.path));
              if (!isWithin(absolute, root) || sha256(await fs.readFile(absolute)) !== artifact.sha256) {
                reasons.push('artifact_changed');
                break;
              }
            } catch {
              reasons.push('artifact_changed');
              break;
            }
          }
          if ((run.outputArtifacts ?? []).length === 0) reasons.push('build_artifact_missing');
        }
      }
      const claimStates = deps.proof.listClaims(run.jobId)
        .filter((claim) => run.claimIds.includes(claim.claimId)).map((claim) => claim.state);
      if (claimStates.length === 0 || claimStates.some((state) => state !== 'verified')) reasons.push('claim_not_verified');
      return { usable: reasons.length === 0, reasons: [...new Set(reasons)] };
    },

    async discover(snapshotId, explicitCommands = []) {
      const snapshot = deps.repository.getSnapshot(snapshotId);
      if (!snapshot) throw new StructuredValidationAuthorityError('SNAPSHOT_NOT_FOUND', 'Repository snapshot was not found');
      const inventory = await deps.repository.inventory(snapshotId, { limit: 10_000 });
      const sources: ValidationDiscovery['sources'] = [];
      const commands: ValidationDiscovery['commands'] = [];
      const addCommand = (command: string, kind: ValidationKind, source: string): void => {
        const normalized = command.trim();
        if (!normalized || commands.some((item) => item.command === normalized && item.kind === kind)) return;
        commands.push({ command: normalized, kind, source });
      };
      for (const entry of inventory.entries) {
        const lower = entry.path.toLowerCase();
        let sourceKind: ValidationDiscovery['sources'][number]['kind'] | null = null;
        if (entry.path === 'package.json') sourceKind = 'manifest';
        else if (/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(entry.path)) sourceKind = 'lockfile';
        else if (lower.startsWith('.github/workflows/') && /\.ya?ml$/i.test(entry.path)) sourceKind = 'workflow';
        else if (/^(?:AGENTS|AIDEN|PROJECT|INSTRUCTIONS|CONTRIBUTING)\.md$/i.test(path.posix.basename(entry.path))) sourceKind = 'instruction';
        if (!sourceKind) continue;
        sources.push({ kind: sourceKind, path: entry.path });
        if (entry.captureStatus !== 'captured') continue;
        const read = await deps.repository.readFile(snapshotId, entry.path, { limit: 512_000 });
        const content = typeof read.content === 'string' ? read.content : '';
        if (sourceKind === 'manifest' && entry.path === 'package.json') {
          try {
            const manifest = JSON.parse(content) as { scripts?: Record<string, string> };
            for (const script of Object.keys(manifest.scripts ?? {}).sort()) {
              const kind: ValidationKind = script === 'test' || script.startsWith('test:') ? 'test' : 'build';
              addCommand(script === 'test' ? 'npm test' : `npm run ${script}`, kind, entry.path);
            }
          } catch { /* invalid manifests remain discoverable sources */ }
        } else if (sourceKind === 'workflow') {
          for (const match of content.matchAll(/^\s*-?\s*run:\s*(.+?)\s*$/gim)) {
            const command = match[1].replace(/^['"]|['"]$/g, '');
            addCommand(command, /(?:^|\s)(?:test|vitest|jest)(?:\s|$)/i.test(command) ? 'test' : 'build', entry.path);
          }
        } else if (sourceKind === 'instruction') {
          for (const match of content.matchAll(/`((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[^`\r\n]+)`/gi)) {
            const command = match[1].trim();
            addCommand(command, /(?:^|\s)(?:test|vitest|jest)(?:\s|$)/i.test(command) ? 'test' : 'build', entry.path);
          }
        }
      }
      for (const explicit of explicitCommands) addCommand(explicit.command, explicit.kind, 'explicit');
      return {
        snapshotId,
        sources: sources.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind)),
        commands,
      };
    },
  };
  return authority;
}
