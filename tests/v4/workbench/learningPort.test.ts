import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildEditionAuthority } from '../../../core/v4/commercial/edition';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createLearningAuthority } from '../../../core/v4/learning/learningAuthority';
import { createWorkbenchLearningPort } from '../../../core/v4/workbench/learningPort';

describe('Workbench Learning privacy port', () => {
  let db: Database.Database;
  const scope = { kind: 'WORKSPACE' as const, key: 'workspace_1', ownerId: 'owner_1', workspaceId: 'workspace_1' };
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => db.close());

  it('records explicit Remember actions and projects inspectable evidence/history groups', () => {
    const authority = createLearningAuthority({ db, enabled: true, now: () => 100 });
    const port = createWorkbenchLearningPort({
      authority, edition: buildEditionAuthority('pro'), scopes: [scope], defaultScope: scope,
    });
    const remembered = port.remember({
      content: 'Prefer concise Workbench summaries.', subjectKey: 'workbench.summary',
      type: 'USER_PREFERENCE', scopeKind: 'WORKSPACE', idempotencyKey: 'remember_1',
    });
    expect(remembered).toMatchObject({ confidence: 'TRUSTED', lifecycle: 'ACTIVE' });
    expect(port.snapshot()).toMatchObject({ enabled: true, counts: { trusted: 1, needsReview: 0, conflicts: 0, archived: 0 } });
    expect(port.review(remembered.id)).toMatchObject({
      entry: { id: remembered.id },
      history: [expect.objectContaining({ type: 'CAPTURED' })],
      sources: [expect.objectContaining({ kind: 'USER_EXPLICIT' })],
    });
    expect(port.export()).toMatchObject({
      events: [expect.objectContaining({ entryId: remembered.id, type: 'CAPTURED' })],
      versions: [expect.objectContaining({ entryId: remembered.id, content: 'Prefer concise Workbench summaries.' })],
    });
  });

  it('enforces the active Workbench scope and retains inspect/export/archive/delete after entitlement expiry', () => {
    const enabled = createLearningAuthority({ db, enabled: true, now: () => 100 });
    const entry = enabled.capture({
      scope, type: 'USER_PREFERENCE', subjectKey: 'style', content: 'Use compact tables.',
      source: { kind: 'USER_EXPLICIT', identity: 'input_1', revision: '1', independentKey: 'input_1' },
    }).entry;
    enabled.capture({
      scope: { ...scope, key: 'workspace_2', workspaceId: 'workspace_2' },
      type: 'USER_PREFERENCE', subjectKey: 'other', content: 'Other workspace only.',
      source: { kind: 'USER_EXPLICIT', identity: 'input_2', revision: '1', independentKey: 'input_2' },
    });
    const disabled = createLearningAuthority({ db, enabled: false, now: () => 101 });
    const port = createWorkbenchLearningPort({
      authority: disabled, edition: buildEditionAuthority('community'), scopes: [scope], defaultScope: scope,
    });
    expect(port.snapshot().trusted).toHaveLength(1);
    expect(port.export().entries).toHaveLength(1);
    expect(() => port.remember({
      content: 'New capture', subjectKey: 'new', type: 'USER_PREFERENCE',
      scopeKind: 'WORKSPACE', idempotencyKey: 'remember_2',
    })).toThrow(/requires Aiden Pro/i);
    const archived = port.archive({ entryId: entry.id, expectedVersion: entry.version, reason: 'user choice' });
    const deleted = port.delete({ entryId: entry.id, expectedVersion: archived.version, reason: 'privacy request' });
    expect(deleted).toMatchObject({ lifecycle: 'DELETED', content: null });
    expect(port.export()).toMatchObject({ versions: [], events: expect.arrayContaining([
      expect.objectContaining({ entryId: entry.id, type: 'DELETED', contentDigest: expect.any(String) }),
    ]) });
    expect(() => port.review('missing')).toThrow(/not found|scope/i);
  });
});
