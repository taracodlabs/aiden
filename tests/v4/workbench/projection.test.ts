import { describe, expect, it } from 'vitest';

import { projectWorkbenchJob, type WorkbenchJobProjectionReader } from '../../../core/v4/workbench/projection';

function fixture(overrides: Record<string, unknown> = {}): WorkbenchJobProjectionReader {
  const job = {
    id: 'job_1', status: 'running', stateVersion: 2, activeAttemptId: 'attempt_1',
    rootJobId: 'job_1', parentJobId: null, sessionId: 'session_1', goal: 'goal',
    entryPoint: 'workbench', source: 'workbench', workspaceId: 'workspace_1',
    terminalAt: null, terminalOutcome: null, finishReason: null, nextEventSequence: 3,
    repositorySnapshotId: 'snapshot_1', ...overrides,
  };
  const attempt = {
    rowId: 9, id: 'attempt_1', jobId: 'job_1', status: 'running', attemptNumber: 1,
    generation: 1, stateVersion: 2, leaseId: 'lease', leaseOwner: 'owner', leaseExpiresAt: 10,
    leaseHeartbeatAt: 5, fenceToken: 'fence', recoveryOfAttemptId: null, repositorySnapshotId: 'snapshot_1',
  };
  return {
    getJob: (id) => id === 'job_1' ? job : null,
    getAttempt: (id) => id === 'attempt_1' ? attempt : null,
    listAttempts: () => [attempt],
    listEvents: () => [
      { eventId: 2, jobSequence: 2, jobId: 'job_1', attemptId: 'attempt_1', type: 'running', payload: null, producer: 'test', generation: 1, idempotencyKey: '2', createdAt: 2 },
      { eventId: 1, jobSequence: 1, jobId: 'job_1', attemptId: 'attempt_1', type: 'admitted', payload: null, producer: 'test', generation: 1, idempotencyKey: '1', createdAt: 1 },
    ],
    listChildContracts: () => [{ childJobId: 'child_1' }],
    proof: {
      listClaims: () => [{ claimId: 'claim_1', jobId: 'job_1', attemptId: 'attempt_1', generation: 1, category: 'contract', statement: 'done', required: true, state: 'verified', repositorySnapshotId: null, sourceReferences: [], requiredValidation: [], requiredEvidenceCategories: [], effectIds: [] }],
      listEvidence: () => [{ evidenceId: 'evidence_1', jobId: 'job_1', attemptId: 'attempt_1', generation: 1, effectId: null, repositorySnapshotId: null, source: 'test', producer: 'test', capturedAt: 1, observedAt: 1, freshUntil: null, integritySha256: 'hash', coverage: 'full', verificationResult: 'verified', payload: {}, late: false }],
      getVerdict: () => null,
      exportJson: () => ({ approvals: [{ approval_id: 'approval_1' }], effects: [{ key: 'effect_1' }] }),
    },
  } as WorkbenchJobProjectionReader;
}

describe('canonical Workbench projection', () => {
  it('B1 binds exact Job, Attempt, run, generation, session, and workspace identity', () => {
    expect(projectWorkbenchJob(fixture(), { jobId: 'job_1', attemptId: 'attempt_1', runId: 9 })?.identity)
      .toEqual({ jobId: 'job_1', rootJobId: 'job_1', attemptId: 'attempt_1', runId: 9, generation: 1, sessionId: 'session_1', workspaceId: 'workspace_1' });
  });
  it('B2 rejects a mismatched run identity', () => expect(projectWorkbenchJob(fixture(), { jobId: 'job_1', attemptId: 'attempt_1', runId: 8 })).toBeNull());
  it('B3 rejects a mismatched Attempt identity', () => expect(projectWorkbenchJob(fixture(), { jobId: 'job_1', attemptId: 'other' })).toBeNull());
  it('B4 orders the Attempt timeline by durable Job sequence', () => expect(projectWorkbenchJob(fixture(), { jobId: 'job_1' })?.timeline.map((e) => e.jobSequence)).toEqual([1, 2]));
  it('B5 exposes the canonical event cursor', () => expect(projectWorkbenchJob(fixture(), { jobId: 'job_1' })?.eventCursor).toBe(2));
  it('B6 projects Worker children without making them success authorities', () => expect(projectWorkbenchJob(fixture(), { jobId: 'job_1' })?.workers).toEqual([{ childJobId: 'child_1' }]));
  it('B7 projects pending approval records', () => expect(projectWorkbenchJob(fixture(), { jobId: 'job_1' })?.approvals).toEqual([{ approval_id: 'approval_1' }]));
  it('B8 projects Evidence and Claims from Proof authority', () => {
    const value = projectWorkbenchJob(fixture(), { jobId: 'job_1' })!;
    expect(value.claims[0].claimId).toBe('claim_1');
    expect(value.evidence[0].evidenceId).toBe('evidence_1');
  });
  it('B9 never calls a completed Job verified without a Proof verdict', () => {
    const value = projectWorkbenchJob(fixture({ status: 'completed', terminalAt: 20, terminalOutcome: 'completed' }), { jobId: 'job_1' })!;
    expect(value.receipt).toMatchObject({ terminal: true, status: 'unknown' });
  });
  it('B10 maps a durable verified verdict to a verified receipt', () => {
    const reader = fixture({ status: 'completed', terminalAt: 20, terminalOutcome: 'completed' });
    reader.proof!.getVerdict = () => ({ jobId: 'job_1', attemptId: 'attempt_1', generation: 1, verdict: 'verified', summary: {}, finalizedAt: 20 });
    expect(projectWorkbenchJob(reader, { jobId: 'job_1' })?.receipt.status).toBe('verified');
  });
  it('B11 preserves partial and unknown Proof truth', () => {
    const reader = fixture({ status: 'completed', terminalAt: 20 });
    reader.proof!.getVerdict = () => ({ jobId: 'job_1', attemptId: 'attempt_1', generation: 1, verdict: 'partially_verified', summary: {}, finalizedAt: 20 });
    expect(projectWorkbenchJob(reader, { jobId: 'job_1' })?.receipt.status).toBe('partially_verified');
  });
  it('B12 returns null rather than inventing missing durable state', () => expect(projectWorkbenchJob(fixture(), { jobId: 'missing' })).toBeNull());
  it('B13 treats legacy unverified terminal states as terminal but never verified', () => {
    const value = projectWorkbenchJob(fixture({
      status: 'completed_unverified', terminalAt: 20, terminalOutcome: 'completed_unverified',
    }), { jobId: 'job_1' })!;
    expect(value.receipt).toMatchObject({ terminal: true, status: 'unknown' });
    expect(value.receipt.status).not.toBe('verified');
  });
  it.each([
    ['queued', 'queued', false],
    ['running', 'running', false],
    ['waiting', 'waiting', false],
    ['paused', 'paused', false],
    ['cancelling', 'cancelling', false],
    ['recovering', 'running', false],
    ['crashed', 'unknown', false],
    ['blocked', 'blocked', false],
    ['unknown', 'unknown', false],
    ['cancelled', 'cancelled', true],
    ['failed', 'failed', true],
    ['dead_letter', 'failed', true],
    ['verification_failed', 'failed', true],
    ['abandoned', 'unknown', true],
  ])('B14 maps durable Job state %s to %s without promotion', (jobStatus, expected, terminal) => {
    const value = projectWorkbenchJob(fixture({ status: jobStatus, terminalAt: terminal ? 20 : null }), { jobId: 'job_1' })!;
    expect(value.receipt).toMatchObject({ status: expected, terminal });
  });

  it('B15 translates an internal stale-fence conflict without hiding reconciliation truth', () => {
    const reader = fixture({ status: 'failed', terminalAt: 20, finishReason: 'error' });
    reader.listEvents = () => [{
      eventId: 3, jobSequence: 3, jobId: 'job_1', attemptId: 'attempt_1',
      type: 'dispatcher.completed',
      payload: { invocationError: 'DurableToolCallConflictError: stale_fence' },
      producer: 'daemon', generation: 1, idempotencyKey: '3', createdAt: 3,
    }];
    expect(projectWorkbenchJob(reader, { jobId: 'job_1' })?.receipt.summary)
      .toBe('Execution authority changed before verification. Review or reconcile the retained work before continuing.');
  });

  it('B16 translates verification_incomplete into an operator-safe incomplete result', () => {
    const reader = fixture({ status: 'unknown', terminalAt: 20, finishReason: 'verification_incomplete' });
    expect(projectWorkbenchJob(reader, { jobId: 'job_1' })?.receipt.summary)
      .toBe('Verification did not complete. Review the retained result before continuing.');
  });
});
