import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createLearningAuthority } from '../../../core/v4/learning/learningAuthority';
import {
  capturePresenceFeedbackLearning,
  captureRecoveryLearning,
  captureSkillOutcomeLearning,
} from '../../../core/v4/learning/sourceAdapters';

describe('Learning source adapters preserve existing authorities', () => {
  let db: Database.Database;
  const now = 100;
  const scope = { kind: 'REPOSITORY' as const, key: 'repo_1', ownerId: 'owner_1', workspaceId: 'workspace_1' };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });
  afterEach(() => db.close());

  const seedEvidence = (suffix: string) => {
    const jobId = `job_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const evidenceId = `evidence_${suffix}`;
    db.prepare(`INSERT INTO tasks (id,title,goal,status,created_at,updated_at,session_id,terminal_outcome)
      VALUES (?,?,?,?,?,?,?,?)`).run(jobId, 'Task', 'Goal', 'completed', now, now, 'session', 'verified');
    db.prepare(`INSERT INTO job_evidence
      (evidence_id,job_id,attempt_id,generation,source,producer,captured_at,observed_at,
       integrity_sha256,coverage,verification_result,payload_json,late)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
      evidenceId, jobId, attemptId, 1, 'test', 'test', now, now,
      suffix.padEnd(64, '0').slice(0, 64), 'complete', 'verified', '{}',
    );
    db.prepare(`INSERT INTO job_verdicts (job_id,attempt_id,generation,verdict,summary_json,finalized_at)
      VALUES (?,?,?,?,?,?)`).run(jobId, attemptId, 1, 'verified', '{}', now);
    return { jobId, attemptId, evidenceId, generation: 1 };
  };

  it('records exact Presence feedback without changing Presence policy', () => {
    db.prepare(`INSERT INTO presence_items
      (presence_id,dedupe_key,source_kind,source_identity,source_revision,source_digest,initiator,
       workspace_id,owner_id,category,priority,state,title,summary,reason_code,reason_text,payload_json,
       first_observed_at,last_observed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'presence_1', 'dedupe_1', 'job', 'job_1', '1', 'digest', 'USER', 'workspace_1', 'owner_1',
      'information', 20, 'active', 'Status', 'Summary', 'status', 'Status', '{}', now, now, now, now,
    );
    db.prepare(`INSERT INTO presence_item_events
      (event_id,presence_id,event_type,reason_json,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?)`).run('presence_event_feedback', 'presence_1', 'feedback', '{"kind":"helpful"}', 'feedback:1', now);
    const ledger = createLearningAuthority({ db, enabled: true, now: () => now });
    const entry = capturePresenceFeedbackLearning({
      authority: ledger, scope, eventId: 'presence_event_feedback', presenceId: 'presence_1',
      feedback: 'helpful', content: 'Presence item was helpful.',
    }).entry;
    expect(entry).toMatchObject({ type: 'PRESENCE_FEEDBACK', confidence: 'TRUSTED' });
    expect(db.prepare('SELECT priority,state FROM presence_items WHERE presence_id=?').get('presence_1'))
      .toEqual({ priority: 20, state: 'active' });
  });

  it('projects verified SkillOutcome reliability without replacing its sidecar authority', () => {
    const evidence = seedEvidence('skill');
    const ledger = createLearningAuthority({ db, enabled: true, now: () => now });
    const entry = captureSkillOutcomeLearning({
      authority: ledger, scope, skillName: 'systematic-debugging', outcomeIdentity: 'outcome_1',
      content: 'systematic-debugging succeeded for repository diagnosis.', ...evidence,
    }).entry;
    expect(entry).toMatchObject({ type: 'SKILL_RELIABILITY', confidence: 'OBSERVED' });
    expect(db.prepare('SELECT source_kind,skill_name FROM learning_sources').get())
      .toEqual({ source_kind: 'SKILL_OUTCOME', skill_name: 'systematic-debugging' });
  });

  it('requires verified Evidence before projecting a Recovery lesson', () => {
    const evidence = seedEvidence('recovery');
    const ledger = createLearningAuthority({ db, enabled: true, now: () => now });
    const entry = captureRecoveryLearning({
      authority: ledger, scope, recoveryId: 'recovery_1', content: 'Reopen SQLite after closing active statements.',
      ...evidence,
    }).entry;
    expect(entry).toMatchObject({ type: 'RECOVERY_LESSON', confidence: 'OBSERVED' });
    expect(() => captureRecoveryLearning({
      authority: ledger, scope, recoveryId: 'orphan_recovery', content: 'Unverified recovery advice.',
      jobId: 'missing', attemptId: 'missing', generation: 1, evidenceId: 'missing',
    })).toThrow(/valid durable source/i);
  });
});
