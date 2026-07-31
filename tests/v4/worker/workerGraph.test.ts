/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bindRun, createWorkerFixture, recordResult, type WorkerFixture } from './fixture';

describe('Worker execution-graph references', () => {
  let fixture: WorkerFixture | undefined;
  const make = () => (fixture = createWorkerFixture());
  afterEach(() => fixture?.db.close());

  it('places an assignment and run beneath the parent graph with an exact child Attempt reference', () => {
    const current = make();
    const { assignment, run } = bindRun(current);
    expect(current.engine.graph.nodes(current.parent.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: assignment.executionGraphNodeId, kind: 'worker_assignment' }),
      expect.objectContaining({ nodeId: run.executionGraphNodeId, kind: 'worker_run', dependsOn: [assignment.executionGraphNodeId] }),
    ]));
    expect(current.engine.graph.workerReferences(current.parent.jobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: run.executionGraphNodeId, kind: 'worker_run', id: run.workerRunId }),
      expect.objectContaining({ nodeId: run.executionGraphNodeId, kind: 'child_attempt', id: current.child.attemptId, generation: current.childAuthority.childGeneration }),
    ]));
  });

  it('adds an accepted result reference without completing the graph or parent Job', () => {
    const current = make();
    const { run, result } = recordResult(current);
    expect(current.engine.graph.workerReferences(current.parent.jobId)).toContainEqual(expect.objectContaining({
      nodeId: run.executionGraphNodeId, kind: 'worker_result', id: result.workerResultId,
    }));
    expect(current.engine.graph.nodes(current.parent.jobId).find((node) => node.nodeId === run.executionGraphNodeId)?.state)
      .toBe('pending');
    expect(current.engine.getJob(current.parent.jobId)?.status).toBe('queued');
  });

  it('rejects graph linkage from a stale parent fence', () => {
    const current = make();
    const records = bindRun(current);
    expect(current.engine.graph.attachWorkerResultReference({
      ...current.parentAuthority,
      parentGeneration: current.parentAuthority.parentGeneration + 1,
      workerRunNodeId: records.run.executionGraphNodeId!,
      workerResultId: 'worker_result_stale_graph',
      producer: 'test', idempotencyKey: 'stale-worker-graph', now: 30,
    })).toMatchObject({ applied: false, conflict: 'stale_fence' });
  });
});
