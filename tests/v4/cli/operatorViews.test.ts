/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { approvals, attempts, effects, evidence, job as jobView, jobs, proof } from '../../../cli/v4/commands/operatorViews';
import type { JobEngine, JobRecord } from '../../../core/v4/daemon/jobEngine';

function setup(args: string[] = []) {
  let output = '';
  const stdout = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const display = new Display({
    stdout: stdout as unknown as NodeJS.WriteStream,
    skin: new SkinEngine({ forceMono: true }),
  });
  const job: JobRecord = {
    id: 'job_1', status: 'completed', stateVersion: 3, activeAttemptId: null,
    rootJobId: 'job_1', parentJobId: null, sessionId: 'session_1', goal: 'read a file',
    entryPoint: 'repl', source: 'user', terminalAt: 30,
    terminalOutcome: 'verified', finishReason: 'complete', nextEventSequence: 5,
  };
  const snapshot = {
    job,
    attempts: [{
      rowId: 1, id: 'attempt_1', jobId: 'job_1', status: 'completed',
      attemptNumber: 1, generation: 2, stateVersion: 2, leaseId: null,
      leaseOwner: null, leaseExpiresAt: null, leaseHeartbeatAt: null,
      fenceToken: 'fence_1', recoveryOfAttemptId: null,
    }],
    children: [], inputs: [], waits: [],
    approvals: [{ approval_id: 'approval_1', state: 'denied', risk_level: 'high' }],
    effects: [{ effect_id: 'effect_1', effect_state: 'unknown', kind: 'filesystem', retry_safety: 'unsafe' }],
    evidence: [{ evidence_id: 'evidence_1', verification_result: 'verified', coverage: 'full', source: 'file_readback' }],
    claims: [{ claim_id: 'claim_1' }],
    verdict: { outcome: 'verified', reason: 'file read confirmed' }, budgets: [], events: [],
  };
  const engine = {
    getJob: (id: string) => id === job.id ? job : null,
    listJobs: () => [job],
    listChildContracts: () => [],
    projection: { rebuild: () => snapshot },
  } as unknown as JobEngine;
  return {
    context: {
      args, rawArgs: args.join(' '), display, registry: new CommandRegistry(),
      jobEngine: engine,
      session: { getSessionId: () => 'session_1' },
    },
    output: () => output,
  };
}

describe('durable operator views', () => {
  it('lists durable Jobs without creating a second state source', async () => {
    const h = setup();
    await jobs.handler(h.context as never);
    expect(h.output()).toContain('job_1 · completed · verified');
  });

  it('shows Attempts, Effects, approvals, evidence, and verdict from one rebuild', async () => {
    const h = setup(['job_1']);
    await jobs.handler(h.context as never);
    expect(h.output()).toContain('attempts    1');
    expect(h.output()).toContain('effects     1');
    expect(h.output()).toContain('approvals   1');
    expect(h.output()).toContain('evidence    1');
    expect(h.output()).toContain('attempt_1 · completed · gen 2');
  });

  it('shows proof from durable claims, evidence, and verdict', async () => {
    const h = setup(['job_1']);
    await proof.handler(h.context as never);
    expect(h.output()).toContain('claims    1');
    expect(h.output()).toContain('verdict   verified');
    expect(h.output()).toContain('file read confirmed');
  });

  it('shows exact approval identity and durable decision state', async () => {
    const h = setup(['job_1']);
    await approvals.handler(h.context as never);
    expect(h.output()).toContain('approval_1 · denied · high · job job_1');
  });

  it('supports a singular Job detail view', async () => {
    const h = setup(['job_1']);
    await jobView.handler(h.context as never);
    expect(h.output()).toContain('◆ Job job_1');
    expect(h.output()).toContain('goal        read a file');
  });

  it('renders worker assignments from durable child contracts', async () => {
    const h = setup(['job_1']);
    const engine = h.context.jobEngine as unknown as {
      getJob: (id: string) => JobRecord | null;
      listChildContracts: () => Array<{
        childJobId: string; workerId: string; resultStatus: string | null;
      }>;
    };
    const child: JobRecord = {
      id: 'job_child', status: 'running', stateVersion: 1, activeAttemptId: 'attempt_child',
      rootJobId: 'job_1', parentJobId: 'job_1', sessionId: 'session_1',
      goal: 'validate Windows', entryPoint: 'worker', source: 'parent', terminalAt: null,
      terminalOutcome: null, finishReason: null, nextEventSequence: 1,
    };
    const originalGetJob = engine.getJob;
    engine.getJob = (id) => id === child.id ? child : originalGetJob(id);
    engine.listChildContracts = () => [{
      childJobId: child.id, workerId: 'worker-windows', resultStatus: null,
    }];

    await jobView.handler(h.context as never);

    expect(h.output()).toContain('workers');
    expect(h.output()).toContain('worker-windows · running · validate Windows');
  });

  it('projects Attempts, Effects, and evidence from the same durable snapshot', async () => {
    const attemptHarness = setup(['job_1']);
    await attempts.handler(attemptHarness.context as never);
    expect(attemptHarness.output()).toContain('attempt_1 · completed · attempt 1 · gen 2');

    const effectHarness = setup(['job_1']);
    await effects.handler(effectHarness.context as never);
    expect(effectHarness.output()).toContain('effect_1 · unknown · filesystem · retry unsafe');

    const evidenceHarness = setup(['job_1']);
    await evidence.handler(evidenceHarness.context as never);
    expect(evidenceHarness.output()).toContain('evidence_1 · verified · full · file_readback');
  });

  it('degrades honestly when durable Job state is unavailable', async () => {
    const h = setup();
    delete (h.context as { jobEngine?: JobEngine }).jobEngine;
    await jobs.handler(h.context as never);
    expect(h.output()).toContain('Durable Job state is unavailable');
  });
});
