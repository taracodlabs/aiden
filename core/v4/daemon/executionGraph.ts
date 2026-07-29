/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { Db } from './db/connection';

export type ExecutionNodeKind =
  | 'planning' | 'tool' | 'verification' | 'approval' | 'wait'
  | 'child_job' | 'aggregation' | 'reconciliation' | 'finalization' | 'coding_step';
export type ExecutionNodeState = 'pending' | 'runnable' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'superseded';

export type CodingPlanReferenceKind =
  | 'inspected_file' | 'source_reference' | 'change_record' | 'test_run'
  | 'build_run' | 'diagnostic' | 'git_effect' | 'claim' | 'evidence';

export interface CodingPlanReference {
  kind: CodingPlanReferenceKind;
  id?: string | null;
  snapshotId?: string | null;
  path?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}

export type CodingPlanStepState = 'pending' | 'active' | 'blocked' | 'completed' | 'failed' | 'superseded' | 'cancelled';

export interface CodingPlanStepDefinition {
  stepId: string;
  label: string;
  repositorySnapshotId: string;
  dependsOn?: readonly string[];
  requiresVerification?: boolean;
  references?: readonly CodingPlanReference[];
}

export interface CodingPlanStepRecord {
  stepId: string;
  label: string;
  state: CodingPlanStepState;
  repositorySnapshotId: string;
  dependsOn: string[];
  requiresVerification: boolean;
  references: CodingPlanReference[];
  filesInspected: string[];
  sourceReferences: Array<{ snapshotId: string; path: string; lineStart: number; lineEnd: number }>;
  outputRef: string | null;
  verificationRef: string | null;
  stateVersion: number;
}

export interface CodingPlanRecord {
  graphId: string;
  jobId: string;
  goal: string;
  planDigest: string;
  state: string;
  version: number;
  steps: CodingPlanStepRecord[];
  currentRepositorySnapshotId: string | null;
  repositoryDriftDetected: boolean;
  unverifiedClaimIds: string[];
  remainingStepIds: string[];
}

export interface ExecutionNodeDefinition {
  nodeId: string;
  kind: ExecutionNodeKind;
  dependsOn?: readonly string[];
  label?: string | null;
  inputRef?: string | null;
  requiresVerification?: boolean;
}

export interface ExecutionGraphNode {
  nodeId: string;
  kind: ExecutionNodeKind;
  state: ExecutionNodeState;
  dependsOn: string[];
  outputRef: string | null;
  verificationRef: string | null;
  stateVersion: number;
}

export interface ExecutionGraphEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface GraphTransitionResult {
  applied: boolean;
  duplicate?: boolean;
  conflict?: 'not_found' | 'state_version' | 'stale_fence' | 'illegal_transition' | 'terminal_job' | 'verification_required';
}

interface GraphAuthority {
  create(command: {
    jobId: string; planDigest: string; nodes: readonly ExecutionNodeDefinition[];
    producer: string; idempotencyKey: string; now?: number;
  }): { graphId: string; version: number; duplicate: boolean };
  edit(command: {
    jobId: string; expectedVersion: number; nodes?: readonly ExecutionNodeDefinition[];
    edges?: readonly { from: string; to: string }[]; producer: string; idempotencyKey: string; now?: number;
  }): { version: number; duplicate: boolean };
  schedule(command: AuthorityCommand): string[];
  claim(command: AuthorityCommand & { nodeId: string }): GraphTransitionResult;
  complete(command: AuthorityCommand & {
    nodeId: string; state: 'succeeded' | 'failed' | 'cancelled';
    outputRef?: string | null; verificationRef?: string | null;
  }): GraphTransitionResult;
  recover(command: AuthorityCommand): string[];
  settle(jobId: string, state: 'completed' | 'failed' | 'cancelled', producer: string, idempotencyKey: string, now?: number): GraphTransitionResult;
  nodes(jobId: string): ExecutionGraphNode[];
  events(jobId: string): ExecutionGraphEvent[];
  createCodingPlan(command: {
    jobId: string; planDigest: string; steps: readonly CodingPlanStepDefinition[];
    producer: string; idempotencyKey: string; now?: number;
  }): { graphId: string; version: number; duplicate: boolean };
  getCodingPlan(jobId: string): CodingPlanRecord | null;
  addNodeReferences(command: AuthorityCommand & {
    nodeId: string; references: readonly CodingPlanReference[];
  }): GraphTransitionResult;
  retireNode(command: AuthorityCommand & {
    nodeId: string; state: 'blocked' | 'superseded' | 'cancelled'; reason?: string | null;
  }): GraphTransitionResult;
}

interface AuthorityCommand {
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  producer: string;
  idempotencyKey: string;
  now?: number;
}

interface GraphRow { graph_id: string; job_id: string; plan_digest: string; state: string; version: number; next_event_sequence: number }
interface NodeRow {
  node_id: string; node_key: string; graph_id: string; job_id: string; kind: ExecutionNodeKind;
  state: ExecutionNodeState; output_ref: string | null; verification_ref: string | null;
  label: string | null; input_ref: string | null;
  requires_verification: number; state_version: number; created_at: number;
  ordinal: number;
}

const TERMINAL_JOBS = new Set(['cancelled', 'completed', 'failed', 'dead_letter', 'completed_unverified', 'verification_failed', 'abandoned']);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateDefinitions(nodes: readonly ExecutionNodeDefinition[], extraEdges: readonly { from: string; to: string }[] = []): void {
  const ids = new Set(nodes.map((node) => node.nodeId));
  if (ids.size !== nodes.length || [...ids].some((id) => !id || id.length > 160)) {
    throw new Error('Execution graph node identities must be unique and bounded');
  }
  const edges = [
    ...nodes.flatMap((node) => (node.dependsOn ?? []).map((from) => ({ from, to: node.nodeId }))),
    ...extraEdges,
  ];
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error('Execution graph edge references an unknown node');
    if (edge.from === edge.to) throw new Error('Execution graph cycle detected');
  }
  const incoming = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const next = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (visited !== ids.size) throw new Error('Execution graph cycle detected');
}

export function createExecutionGraphAuthority(db: Db): GraphAuthority {
  const graphFor = (jobId: string): GraphRow | undefined => db.prepare(
    'SELECT graph_id, job_id, plan_digest, state, version, next_event_sequence FROM execution_graphs WHERE job_id = ?',
  ).get(jobId) as GraphRow | undefined;
  const physicalNodeId = (graphId: string, nodeKey: string): string => `node_${digest(`${graphId}\0${nodeKey}`)}`;
  const appendEvent = (graph: GraphRow, type: string, payload: Record<string, unknown>, producer: string, idempotencyKey: string, now: number): boolean => {
    const duplicate = db.prepare(
      'SELECT 1 FROM execution_graph_events WHERE graph_id = ? AND idempotency_key = ?',
    ).get(graph.graph_id, idempotencyKey);
    if (duplicate) return false;
    db.prepare(
      `INSERT INTO execution_graph_events
         (graph_id, graph_sequence, job_id, type, payload_json, producer, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(graph.graph_id, graph.next_event_sequence, graph.job_id, type, JSON.stringify(payload), producer, idempotencyKey, now);
    db.prepare('UPDATE execution_graphs SET next_event_sequence = next_event_sequence + 1, updated_at = ? WHERE graph_id = ?')
      .run(now, graph.graph_id);
    graph.next_event_sequence += 1;
    return true;
  };
  const authority = (command: AuthorityCommand): { graph: GraphRow; ok: boolean; terminal: boolean } => {
    const graph = graphFor(command.jobId);
    if (!graph) throw new Error('Execution graph not found');
    const row = db.prepare(
      `SELECT t.status AS job_status, t.active_attempt_id,
              r.status AS attempt_status, r.generation, r.fence_token,
              r.lease_owner, r.lease_expires_at
         FROM tasks t LEFT JOIN runs r ON r.attempt_id = ?
        WHERE t.id = ?`,
    ).get(command.attemptId, command.jobId) as {
      job_status: string; active_attempt_id: string | null; attempt_status: string | null;
      generation: number | null; fence_token: string | null; lease_owner: string | null; lease_expires_at: number | null;
    } | undefined;
    const terminal = !row || TERMINAL_JOBS.has(row.job_status) || graph.state === 'cancelled' || graph.state === 'completed';
    const now = command.now ?? Date.now();
    const ok = !terminal && row.active_attempt_id === command.attemptId
      && row.generation === command.generation && row.fence_token === command.fenceToken
      && row.lease_owner !== null && row.lease_expires_at !== null && row.lease_expires_at > now;
    return { graph, ok, terminal };
  };
  const loadDefinitions = (graph: GraphRow, additions: readonly ExecutionNodeDefinition[] = [], edges: readonly { from: string; to: string }[] = []): ExecutionNodeDefinition[] => {
    const current = db.prepare(
      `SELECT n.node_key, n.kind, n.label, n.input_ref, n.requires_verification,
              e.from_node_id
         FROM execution_graph_nodes n
         LEFT JOIN execution_graph_edges e ON e.to_node_id = n.node_id
        WHERE n.graph_id = ? ORDER BY n.ordinal`,
    ).all(graph.graph_id) as Array<{
      node_key: string; kind: ExecutionNodeKind; label: string | null; input_ref: string | null;
      requires_verification: number; from_node_id: string | null;
    }>;
    const physicalToKey = new Map((db.prepare(
      'SELECT node_id, node_key FROM execution_graph_nodes WHERE graph_id = ?',
    ).all(graph.graph_id) as Array<{ node_id: string; node_key: string }>).map((row) => [row.node_id, row.node_key]));
    const byId = new Map<string, ExecutionNodeDefinition>();
    for (const row of current) {
      const existing = byId.get(row.node_key) ?? {
        nodeId: row.node_key, kind: row.kind, label: row.label, inputRef: row.input_ref,
        requiresVerification: row.requires_verification === 1, dependsOn: [],
      };
      if (row.from_node_id) (existing.dependsOn as string[]).push(physicalToKey.get(row.from_node_id)!);
      byId.set(row.node_key, existing);
    }
    for (const node of additions) byId.set(node.nodeId, { ...node, dependsOn: [...(node.dependsOn ?? [])] });
    for (const edge of edges) {
      const target = byId.get(edge.to);
      if (!target) continue;
      target.dependsOn = [...(target.dependsOn ?? []), edge.from];
    }
    return [...byId.values()];
  };

  const validateReference = (jobId: string, reference: CodingPlanReference): CodingPlanReference => {
    const snapshotId = reference.snapshotId ?? null;
    const relativePath = reference.path?.split('\\').join('/').replace(/^\.\//, '') ?? null;
    const normalized = {
      kind: reference.kind,
      id: reference.id ?? null,
      snapshotId,
      path: relativePath,
      lineStart: reference.lineStart ?? null,
      lineEnd: reference.lineEnd ?? null,
    } satisfies CodingPlanReference;
    if (snapshotId) {
      const snapshot = db.prepare('SELECT job_id FROM repository_snapshots WHERE snapshot_id=?').get(snapshotId) as { job_id: string } | undefined;
      if (!snapshot || snapshot.job_id !== jobId) throw new Error('Coding plan reference snapshot does not belong to the Job');
    }
    if (reference.kind === 'inspected_file' || reference.kind === 'source_reference') {
      if (!snapshotId || !relativePath) throw new Error('Coding plan source references require a snapshot and path');
      const entry = db.prepare(
        'SELECT capture_status FROM repository_snapshot_entries WHERE snapshot_id=? AND relative_path=?',
      ).get(snapshotId, relativePath) as { capture_status: string } | undefined;
      if (!entry || entry.capture_status !== 'captured') throw new Error('Coding plan source reference is not captured by the snapshot');
      if (reference.kind === 'source_reference' && (
        normalized.lineStart === null || normalized.lineEnd === null
        || normalized.lineStart < 1 || normalized.lineEnd < normalized.lineStart
      )) throw new Error('Coding plan source reference requires a valid line range');
      return normalized;
    }
    if (!normalized.id) throw new Error(`Coding plan ${reference.kind} reference requires an identity`);
    const checks: Record<Exclude<CodingPlanReferenceKind, 'inspected_file' | 'source_reference'>, { sql: string; params: unknown[] }> = {
      change_record: { sql: 'SELECT 1 FROM repository_change_records WHERE change_id=? AND job_id=?', params: [normalized.id, jobId] },
      test_run: { sql: "SELECT 1 FROM validation_runs WHERE run_id=? AND job_id=? AND kind='test'", params: [normalized.id, jobId] },
      build_run: { sql: "SELECT 1 FROM validation_runs WHERE run_id=? AND job_id=? AND kind='build'", params: [normalized.id, jobId] },
      diagnostic: { sql: 'SELECT 1 FROM validation_diagnostics d JOIN validation_runs r ON r.run_id=d.run_id WHERE d.diagnostic_id=? AND r.job_id=?', params: [normalized.id, jobId] },
      git_effect: { sql: 'SELECT 1 FROM git_effect_operations WHERE operation_id=? AND job_id=?', params: [normalized.id, jobId] },
      claim: { sql: 'SELECT 1 FROM job_claims WHERE claim_id=? AND job_id=?', params: [normalized.id, jobId] },
      evidence: { sql: 'SELECT 1 FROM job_evidence WHERE evidence_id=? AND job_id=?', params: [normalized.id, jobId] },
    };
    const check = checks[reference.kind];
    if (!db.prepare(check.sql).get(...check.params)) throw new Error(`Coding plan ${reference.kind} reference does not belong to the Job`);
    return normalized;
  };

  const insertReferences = (
    graph: GraphRow,
    nodeKey: string,
    references: readonly CodingPlanReference[],
    now: number,
  ): void => {
    const nodeId = physicalNodeId(graph.graph_id, nodeKey);
    for (const input of references) {
      const reference = validateReference(graph.job_id, input);
      const referenceKey = `graphref_${digest(JSON.stringify({ nodeId, ...reference }))}`;
      db.prepare(
        `INSERT OR IGNORE INTO execution_graph_node_references
           (reference_key,graph_id,node_id,reference_kind,reference_id,repository_snapshot_id,
            relative_path,line_start,line_end,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        referenceKey, graph.graph_id, nodeId, reference.kind, reference.id ?? null,
        reference.snapshotId ?? null, reference.path ?? null, reference.lineStart ?? null,
        reference.lineEnd ?? null, now,
      );
    }
  };

  const referencesFor = (nodeId: string): CodingPlanReference[] => (
    db.prepare(
      `SELECT reference_kind,reference_id,repository_snapshot_id,relative_path,line_start,line_end
         FROM execution_graph_node_references WHERE node_id=? ORDER BY reference_kind,reference_key`,
    ).all(nodeId) as Array<{
      reference_kind: CodingPlanReferenceKind; reference_id: string | null;
      repository_snapshot_id: string | null; relative_path: string | null;
      line_start: number | null; line_end: number | null;
    }>
  ).map((row) => ({
    kind: row.reference_kind, id: row.reference_id, snapshotId: row.repository_snapshot_id,
    path: row.relative_path, lineStart: row.line_start, lineEnd: row.line_end,
  }));

  const createTx = db.transaction((command: Parameters<GraphAuthority['create']>[0]) => {
    const existing = graphFor(command.jobId);
    if (existing) {
      if (existing.plan_digest !== command.planDigest) throw new Error('Execution graph already exists with a different plan digest');
      return { graphId: existing.graph_id, version: existing.version, duplicate: true };
    }
    validateDefinitions(command.nodes);
    const job = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(command.jobId);
    if (!job) throw new Error('Execution graph Job not found');
    const now = command.now ?? Date.now();
    const graphId = `graph_${digest(command.jobId)}`;
    db.prepare(
      `INSERT INTO execution_graphs
         (graph_id, job_id, plan_digest, state, version, next_event_sequence, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 1, 1, ?, ?)`,
    ).run(graphId, command.jobId, command.planDigest, now, now);
    const graph = graphFor(command.jobId)!;
    for (const [ordinal, node] of command.nodes.entries()) {
      db.prepare(
        `INSERT INTO execution_graph_nodes
           (node_id, node_key, graph_id, job_id, kind, state, label, input_ref,
            requires_verification, ordinal, state_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        physicalNodeId(graphId, node.nodeId), node.nodeId, graphId, command.jobId, node.kind,
        node.label ?? null, node.inputRef ?? null, node.requiresVerification ? 1 : 0, ordinal, now, now,
      );
    }
    for (const node of command.nodes) {
      for (const dependency of node.dependsOn ?? []) {
        db.prepare(
          'INSERT INTO execution_graph_edges (graph_id, from_node_id, to_node_id, created_at) VALUES (?, ?, ?, ?)',
        ).run(graphId, physicalNodeId(graphId, dependency), physicalNodeId(graphId, node.nodeId), now);
      }
    }
    appendEvent(graph, 'graph.created', { planDigest: command.planDigest, nodeCount: command.nodes.length }, command.producer, command.idempotencyKey, now);
    return { graphId, version: 1, duplicate: false };
  }).immediate;

  const editTx = db.transaction((command: Parameters<GraphAuthority['edit']>[0]) => {
    const graph = graphFor(command.jobId);
    if (!graph) throw new Error('Execution graph not found');
    if (graph.state !== 'active') throw new Error('Execution graph is terminal');
    const duplicate = db.prepare('SELECT 1 FROM execution_graph_events WHERE graph_id = ? AND idempotency_key = ?')
      .get(graph.graph_id, command.idempotencyKey);
    if (duplicate) return { version: graph.version, duplicate: true };
    if (graph.version !== command.expectedVersion) throw new Error('Execution graph version changed concurrently');
    const definitions = loadDefinitions(graph, command.nodes ?? [], command.edges ?? []);
    validateDefinitions(definitions);
    const now = command.now ?? Date.now();
    const ordinalBase = (db.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM execution_graph_nodes WHERE graph_id = ?')
      .get(graph.graph_id) as { next: number }).next;
    for (const [offset, node] of (command.nodes ?? []).entries()) {
      if (db.prepare('SELECT 1 FROM execution_graph_nodes WHERE graph_id = ? AND node_key = ?').get(graph.graph_id, node.nodeId)) {
        throw new Error(`Execution graph node already exists: ${node.nodeId}`);
      }
      db.prepare(
        `INSERT INTO execution_graph_nodes
           (node_id, node_key, graph_id, job_id, kind, state, label, input_ref,
            requires_verification, ordinal, state_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        physicalNodeId(graph.graph_id, node.nodeId), node.nodeId, graph.graph_id, command.jobId,
        node.kind, node.label ?? null, node.inputRef ?? null, node.requiresVerification ? 1 : 0, ordinalBase + offset, now, now,
      );
    }
    const allEdges = [
      ...(command.nodes ?? []).flatMap((node) => (node.dependsOn ?? []).map((from) => ({ from, to: node.nodeId }))),
      ...(command.edges ?? []),
    ];
    for (const edge of allEdges) {
      db.prepare('INSERT INTO execution_graph_edges (graph_id, from_node_id, to_node_id, created_at) VALUES (?, ?, ?, ?)')
        .run(graph.graph_id, physicalNodeId(graph.graph_id, edge.from), physicalNodeId(graph.graph_id, edge.to), now);
    }
    db.prepare('UPDATE execution_graphs SET version = version + 1, updated_at = ? WHERE graph_id = ? AND version = ?')
      .run(now, graph.graph_id, graph.version);
    appendEvent(graph, 'graph.edited', {
      addedNodes: (command.nodes ?? []).map((node) => node.nodeId), edges: allEdges,
    }, command.producer, command.idempotencyKey, now);
    return { version: graph.version + 1, duplicate: false };
  }).immediate;

  return {
    create: createTx,
    edit: editTx,
    createCodingPlan(command) {
      if (command.steps.length === 0) throw new Error('Coding plan requires at least one step');
      const definitions: ExecutionNodeDefinition[] = command.steps.map((step) => {
        const snapshot = db.prepare('SELECT job_id FROM repository_snapshots WHERE snapshot_id=?')
          .get(step.repositorySnapshotId) as { job_id: string } | undefined;
        if (!snapshot || snapshot.job_id !== command.jobId) throw new Error('Coding plan step snapshot does not belong to the Job');
        for (const reference of step.references ?? []) validateReference(command.jobId, reference);
        return {
          nodeId: step.stepId, kind: 'coding_step', label: step.label,
          inputRef: `repository_snapshot:${step.repositorySnapshotId}`,
          dependsOn: step.dependsOn, requiresVerification: step.requiresVerification,
        };
      });
      const now = command.now ?? Date.now();
      const createPlan = db.transaction(() => {
        const result = createTx({
          jobId: command.jobId, planDigest: command.planDigest, nodes: definitions,
          producer: command.producer, idempotencyKey: command.idempotencyKey, now,
        });
        const graph = graphFor(command.jobId)!;
        if (!result.duplicate) {
          for (const step of command.steps) insertReferences(graph, step.stepId, step.references ?? [], now);
        }
        return result;
      });
      return createPlan.immediate();
    },
    getCodingPlan(jobId) {
      const graph = graphFor(jobId);
      if (!graph) return null;
      const job = db.prepare('SELECT goal FROM tasks WHERE id=?').get(jobId) as { goal: string } | undefined;
      if (!job) return null;
      const rows = db.prepare(
        "SELECT * FROM execution_graph_nodes WHERE graph_id=? AND kind='coding_step' ORDER BY ordinal",
      ).all(graph.graph_id) as NodeRow[];
      if (rows.length === 0) return null;
      const edges = db.prepare(
        `SELECT source.node_key AS source_key,target.node_key AS target_key
           FROM execution_graph_edges edge
           JOIN execution_graph_nodes source ON source.node_id=edge.from_node_id
           JOIN execution_graph_nodes target ON target.node_id=edge.to_node_id
          WHERE edge.graph_id=? ORDER BY source.node_key`,
      ).all(graph.graph_id) as Array<{ source_key: string; target_key: string }>;
      const projectState = (state: ExecutionNodeState): CodingPlanStepState => {
        if (state === 'running') return 'active';
        if (state === 'succeeded') return 'completed';
        if (state === 'failed') return 'failed';
        if (state === 'blocked') return 'blocked';
        if (state === 'cancelled') return 'cancelled';
        if (state === 'superseded') return 'superseded';
        return 'pending';
      };
      const steps = rows.map((row): CodingPlanStepRecord => {
        const references = referencesFor(row.node_id);
        const repositorySnapshotId = row.input_ref?.startsWith('repository_snapshot:')
          ? row.input_ref.slice('repository_snapshot:'.length)
          : references.find((reference) => reference.snapshotId)?.snapshotId ?? '';
        return {
          stepId: row.node_key, label: row.label ?? row.node_key, state: projectState(row.state),
          repositorySnapshotId,
          dependsOn: edges.filter((edge) => edge.target_key === row.node_key).map((edge) => edge.source_key),
          requiresVerification: row.requires_verification === 1, references,
          filesInspected: references.filter((reference) => reference.kind === 'inspected_file' && reference.path).map((reference) => reference.path!),
          sourceReferences: references.filter((reference) => (
            reference.kind === 'source_reference' && reference.snapshotId && reference.path
            && reference.lineStart !== null && reference.lineStart !== undefined
            && reference.lineEnd !== null && reference.lineEnd !== undefined
          )).map((reference) => ({
            snapshotId: reference.snapshotId!, path: reference.path!,
            lineStart: reference.lineStart!, lineEnd: reference.lineEnd!,
          })),
          outputRef: row.output_ref, verificationRef: row.verification_ref, stateVersion: row.state_version,
        };
      });
      const currentSnapshot = db.prepare(
        `SELECT snapshot_id,state_digest FROM repository_snapshots WHERE job_id=?
          ORDER BY captured_at DESC,rowid DESC LIMIT 1`,
      ).get(jobId) as { snapshot_id: string; state_digest: string } | undefined;
      const unverifiedClaims = db.prepare(
        "SELECT claim_id FROM job_claims WHERE job_id=? AND state<>'verified' ORDER BY created_at,claim_id",
      ).all(jobId) as Array<{ claim_id: string }>;
      return {
        graphId: graph.graph_id, jobId, goal: job.goal, planDigest: graph.plan_digest,
        state: graph.state, version: graph.version, steps,
        currentRepositorySnapshotId: currentSnapshot?.snapshot_id ?? null,
        repositoryDriftDetected: currentSnapshot !== undefined
          && steps.some((step) => {
            const source = db.prepare('SELECT state_digest FROM repository_snapshots WHERE snapshot_id=?')
              .get(step.repositorySnapshotId) as { state_digest: string } | undefined;
            return source === undefined || source.state_digest !== currentSnapshot.state_digest;
          }),
        unverifiedClaimIds: unverifiedClaims.map((claim) => claim.claim_id),
        remainingStepIds: steps.filter((step) => !['completed', 'superseded', 'cancelled'].includes(step.state)).map((step) => step.stepId),
      };
    },
    addNodeReferences(command) {
      const result = authority(command);
      if (result.terminal) return { applied: false, conflict: 'terminal_job' };
      if (!result.ok) return { applied: false, conflict: 'stale_fence' };
      const node = db.prepare('SELECT * FROM execution_graph_nodes WHERE graph_id=? AND node_key=?')
        .get(result.graph.graph_id, command.nodeId) as NodeRow | undefined;
      if (!node) return { applied: false, conflict: 'not_found' };
      const duplicate = db.prepare(
        'SELECT 1 FROM execution_graph_events WHERE graph_id=? AND idempotency_key=?',
      ).get(result.graph.graph_id, command.idempotencyKey);
      if (duplicate) return { applied: false, duplicate: true };
      if (node.kind !== 'coding_step' || ['succeeded', 'failed', 'cancelled', 'superseded'].includes(node.state)) {
        return { applied: false, conflict: 'illegal_transition' };
      }
      for (const reference of command.references) validateReference(command.jobId, reference);
      const now = command.now ?? Date.now();
      const tx = db.transaction(() => {
        insertReferences(result.graph, command.nodeId, command.references, now);
        appendEvent(result.graph, 'graph.node_references_added', {
          nodeId: command.nodeId, referenceKinds: command.references.map((reference) => reference.kind),
          attemptId: command.attemptId, generation: command.generation,
        }, command.producer, command.idempotencyKey, now);
      });
      tx.immediate();
      return { applied: true };
    },
    retireNode(command) {
      const result = authority(command);
      if (result.terminal) return { applied: false, conflict: 'terminal_job' };
      if (!result.ok) return { applied: false, conflict: 'stale_fence' };
      const node = db.prepare('SELECT * FROM execution_graph_nodes WHERE graph_id=? AND node_key=?')
        .get(result.graph.graph_id, command.nodeId) as NodeRow | undefined;
      if (!node) return { applied: false, conflict: 'not_found' };
      const duplicate = db.prepare(
        'SELECT 1 FROM execution_graph_events WHERE graph_id=? AND idempotency_key=?',
      ).get(result.graph.graph_id, command.idempotencyKey);
      if (duplicate) return { applied: false, duplicate: true };
      if (node.kind !== 'coding_step' || ['succeeded', 'failed', 'cancelled', 'superseded'].includes(node.state)) {
        return { applied: false, conflict: 'illegal_transition' };
      }
      const now = command.now ?? Date.now();
      const tx = db.transaction(() => {
        db.prepare(
          'UPDATE execution_graph_nodes SET state=?,state_version=state_version+1,updated_at=? WHERE node_id=?',
        ).run(command.state, now, node.node_id);
        db.prepare(
          "UPDATE execution_node_attempts SET state=?,completed_at=? WHERE node_id=? AND state='running'",
        ).run(command.state, now, node.node_id);
        appendEvent(result.graph, `graph.node_${command.state}`, {
          nodeId: command.nodeId, reason: command.reason ?? null,
          attemptId: command.attemptId, generation: command.generation,
        }, command.producer, command.idempotencyKey, now);
      });
      tx.immediate();
      return { applied: true };
    },
    schedule(command) {
      const result = authority(command);
      if (result.terminal || !result.ok) return [];
      const blocked = db.prepare(
        `SELECT DISTINCT n.node_id, n.node_key
           FROM execution_graph_nodes n
           JOIN execution_graph_edges e ON e.to_node_id = n.node_id
           JOIN execution_graph_nodes dependency ON dependency.node_id = e.from_node_id
          WHERE n.graph_id = ? AND n.state = 'pending'
            AND dependency.state IN ('failed','cancelled','blocked','superseded')
          ORDER BY n.ordinal`,
      ).all(result.graph.graph_id) as Array<{ node_id: string; node_key: string }>;
      const rows = db.prepare(
        `SELECT n.node_id, n.node_key
           FROM execution_graph_nodes n
          WHERE n.graph_id = ? AND n.state = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM execution_graph_edges e
              JOIN execution_graph_nodes dependency ON dependency.node_id = e.from_node_id
              WHERE e.to_node_id = n.node_id AND dependency.state <> 'succeeded'
            )
          ORDER BY n.ordinal`,
      ).all(result.graph.graph_id) as Array<{ node_id: string; node_key: string }>;
      if (rows.length === 0 && blocked.length === 0) return [];
      const now = command.now ?? Date.now();
      const tx = db.transaction(() => {
        for (const row of blocked) {
          db.prepare("UPDATE execution_graph_nodes SET state = 'blocked', state_version = state_version + 1, updated_at = ? WHERE node_id = ? AND state = 'pending'")
            .run(now, row.node_id);
        }
        for (const row of rows) {
          db.prepare("UPDATE execution_graph_nodes SET state = 'runnable', state_version = state_version + 1, updated_at = ? WHERE node_id = ? AND state = 'pending'")
            .run(now, row.node_id);
        }
        appendEvent(result.graph, 'graph.nodes_scheduled', {
          runnableNodeIds: rows.map((row) => row.node_key),
          blockedNodeIds: blocked.map((row) => row.node_key),
        }, command.producer, command.idempotencyKey, now);
      });
      tx.immediate();
      return rows.map((row) => row.node_key);
    },
    claim(command) {
      const result = authority(command);
      if (result.terminal) return { applied: false, conflict: 'terminal_job' };
      if (!result.ok) return { applied: false, conflict: 'stale_fence' };
      const node = db.prepare(
        'SELECT * FROM execution_graph_nodes WHERE graph_id = ? AND node_key = ?',
      ).get(result.graph.graph_id, command.nodeId) as NodeRow | undefined;
      if (!node) return { applied: false, conflict: 'not_found' };
      if (node.state !== 'runnable') return { applied: false, conflict: 'illegal_transition' };
      const now = command.now ?? Date.now();
      const executionId = `nodeexec_${digest(`${node.node_id}\0${command.attemptId}\0${command.generation}`)}`;
      const tx = db.transaction(() => {
        db.prepare("UPDATE execution_graph_nodes SET state = 'running', state_version = state_version + 1, updated_at = ? WHERE node_id = ? AND state = 'runnable'")
          .run(now, node.node_id);
        db.prepare(
          `INSERT INTO execution_node_attempts
             (node_execution_id, graph_id, node_id, job_id, attempt_id, generation, state, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        ).run(executionId, result.graph.graph_id, node.node_id, command.jobId, command.attemptId, command.generation, now);
        appendEvent(result.graph, 'graph.node_started', {
          nodeId: command.nodeId, nodeExecutionId: executionId, attemptId: command.attemptId, generation: command.generation,
        }, command.producer, command.idempotencyKey, now);
      });
      tx.immediate();
      return { applied: true };
    },
    complete(command) {
      const result = authority(command);
      if (result.terminal) return { applied: false, conflict: 'terminal_job' };
      if (!result.ok) return { applied: false, conflict: 'stale_fence' };
      const node = db.prepare(
        'SELECT * FROM execution_graph_nodes WHERE graph_id = ? AND node_key = ?',
      ).get(result.graph.graph_id, command.nodeId) as NodeRow | undefined;
      if (!node) return { applied: false, conflict: 'not_found' };
      if (node.state !== 'running') return { applied: false, conflict: 'illegal_transition' };
      if (command.state === 'succeeded' && node.requires_verification === 1 && !command.verificationRef) {
        return { applied: false, conflict: 'verification_required' };
      }
      const execution = db.prepare(
        `SELECT node_execution_id FROM execution_node_attempts
          WHERE node_id = ? AND attempt_id = ? AND generation = ? AND state = 'running'`,
      ).get(node.node_id, command.attemptId, command.generation) as { node_execution_id: string } | undefined;
      if (!execution) return { applied: false, conflict: 'stale_fence' };
      const now = command.now ?? Date.now();
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE execution_graph_nodes SET state = ?, output_ref = ?, verification_ref = ?,
                  state_version = state_version + 1, updated_at = ? WHERE node_id = ? AND state = 'running'`,
        ).run(command.state, command.outputRef ?? null, command.verificationRef ?? null, now, node.node_id);
        db.prepare(
          `UPDATE execution_node_attempts SET state = ?, output_ref = ?, verification_ref = ?, completed_at = ?
            WHERE node_execution_id = ? AND state = 'running'`,
        ).run(command.state, command.outputRef ?? null, command.verificationRef ?? null, now, execution.node_execution_id);
        appendEvent(result.graph, `graph.node_${command.state}`, {
          nodeId: command.nodeId, nodeExecutionId: execution.node_execution_id,
          outputRef: command.outputRef ?? null, verificationRef: command.verificationRef ?? null,
          attemptId: command.attemptId, generation: command.generation,
        }, command.producer, command.idempotencyKey, now);
      });
      tx.immediate();
      return { applied: true };
    },
    recover(command) {
      const result = authority(command);
      if (result.terminal || !result.ok) return [];
      const rows = db.prepare(
        `SELECT n.node_id, n.node_key, x.node_execution_id
           FROM execution_graph_nodes n
           JOIN execution_node_attempts x ON x.node_id = n.node_id
          WHERE n.graph_id = ? AND n.state = 'running'
            AND (x.attempt_id <> ? OR x.generation <> ?) AND x.state = 'running'
          ORDER BY n.ordinal`,
      ).all(result.graph.graph_id, command.attemptId, command.generation) as Array<{
        node_id: string; node_key: string; node_execution_id: string;
      }>;
      if (rows.length === 0) return [];
      const now = command.now ?? Date.now();
      const tx = db.transaction(() => {
        for (const row of rows) {
          db.prepare("UPDATE execution_graph_nodes SET state = 'pending', state_version = state_version + 1, updated_at = ? WHERE node_id = ? AND state = 'running'")
            .run(now, row.node_id);
          db.prepare("UPDATE execution_node_attempts SET state = 'crashed', completed_at = ? WHERE node_execution_id = ? AND state = 'running'")
            .run(now, row.node_execution_id);
        }
        appendEvent(result.graph, 'graph.recovered', { resetNodeIds: rows.map((row) => row.node_key) }, command.producer, command.idempotencyKey, now);
      });
      tx.immediate();
      return rows.map((row) => row.node_key);
    },
    settle(jobId, state, producer, idempotencyKey, now = Date.now()) {
      const graph = graphFor(jobId);
      if (!graph) return { applied: false, conflict: 'not_found' };
      if (graph.state === state) return { applied: false, duplicate: true };
      if (graph.state !== 'active') return { applied: false, conflict: 'illegal_transition' };
      if (state === 'completed') {
        const unfinished = db.prepare(
          "SELECT 1 FROM execution_graph_nodes WHERE graph_id = ? AND state NOT IN ('succeeded','superseded') LIMIT 1",
        ).get(graph.graph_id);
        if (unfinished) return { applied: false, conflict: 'illegal_transition' };
      }
      const nodeState = state === 'cancelled' ? 'cancelled' : 'blocked';
      const tx = db.transaction(() => {
        db.prepare('UPDATE execution_graphs SET state = ?, version = version + 1, updated_at = ? WHERE graph_id = ? AND state = \'active\'')
          .run(state, now, graph.graph_id);
        if (state !== 'completed') {
          db.prepare("UPDATE execution_graph_nodes SET state = ?, state_version = state_version + 1, updated_at = ? WHERE graph_id = ? AND state IN ('pending','runnable','running')")
            .run(nodeState, now, graph.graph_id);
          db.prepare("UPDATE execution_node_attempts SET state = ?, completed_at = ? WHERE graph_id = ? AND state = 'running'")
            .run(nodeState, now, graph.graph_id);
        }
        appendEvent(graph, `graph.${state}`, {}, producer, idempotencyKey, now);
      });
      tx.immediate();
      return { applied: true };
    },
    nodes(jobId) {
      const graph = graphFor(jobId);
      if (!graph) return [];
      const rows = db.prepare('SELECT * FROM execution_graph_nodes WHERE graph_id = ? ORDER BY ordinal')
        .all(graph.graph_id) as NodeRow[];
      const edges = db.prepare(
        `SELECT source.node_key AS source_key, target.node_key AS target_key
           FROM execution_graph_edges edge
           JOIN execution_graph_nodes source ON source.node_id = edge.from_node_id
           JOIN execution_graph_nodes target ON target.node_id = edge.to_node_id
          WHERE edge.graph_id = ? ORDER BY source.node_key`,
      ).all(graph.graph_id) as Array<{ source_key: string; target_key: string }>;
      return rows.map((row) => ({
        nodeId: row.node_key, kind: row.kind, state: row.state,
        dependsOn: edges.filter((edge) => edge.target_key === row.node_key).map((edge) => edge.source_key),
        outputRef: row.output_ref, verificationRef: row.verification_ref, stateVersion: row.state_version,
      }));
    },
    events(jobId) {
      const graph = graphFor(jobId);
      if (!graph) return [];
      const rows = db.prepare(
        'SELECT graph_sequence, type, payload_json, created_at FROM execution_graph_events WHERE graph_id = ? ORDER BY graph_sequence',
      ).all(graph.graph_id) as Array<{ graph_sequence: number; type: string; payload_json: string; created_at: number }>;
      return rows.map((row) => ({
        sequence: row.graph_sequence, type: row.type,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>, createdAt: row.created_at,
      }));
    },
  };
}

export type ExecutionGraphAuthority = ReturnType<typeof createExecutionGraphAuthority>;
