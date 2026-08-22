import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createLearningAuthority } from '../../../core/v4/learning/learningAuthority';
import { snapshotLearningReadiness } from '../../../core/v4/learning/readiness';

describe('Learning Doctor readiness', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('treats an empty migrated ledger as healthy and remains read-only', () => {
    const before = db.totalChanges;
    const snapshot = snapshotLearningReadiness({ db, entitled: true });
    expect(snapshot).toMatchObject({
      ready: true, entitled: true, tablesReady: true, ftsReady: true,
      projectionConsistent: true, privacyHealthy: true, entries: 0, eligibleEntries: 0,
    });
    expect(db.totalChanges).toBe(before);
  });

  it('detects projection and privacy leakage without silently repairing it', () => {
    const authority = createLearningAuthority({ db, enabled: true, now: () => 100 });
    const entry = authority.capture({
      scope: { kind: 'USER_GLOBAL', key: 'owner', ownerId: 'owner', workspaceId: null },
      type: 'USER_PREFERENCE', subjectKey: 'style', content: 'Prefer concise answers.',
      source: { kind: 'USER_EXPLICIT', identity: 'input_1', revision: '1', independentKey: 'input_1' },
    }).entry;
    const deleted = authority.delete({ entryId: entry.id, expectedVersion: entry.version, reason: 'privacy' });
    db.prepare('UPDATE learning_entries SET content=? WHERE entry_id=?').run('leaked plaintext', deleted.id);
    const before = db.totalChanges;
    const snapshot = snapshotLearningReadiness({ db, entitled: true });
    expect(snapshot.ready).toBe(false);
    expect(snapshot.privacyHealthy).toBe(false);
    expect(snapshot.repairable).toBe(true);
    expect(db.totalChanges).toBe(before);
  });

  it('reports entitlement separately while keeping the stored ledger manageable', () => {
    expect(snapshotLearningReadiness({ db, entitled: false })).toMatchObject({
      ready: false, entitled: false, tablesReady: true, privacyHealthy: true,
      detail: expect.stringMatching(/inspect|export|delete/i),
    });
  });

  it('reports an expired FTS projection as repairable without changing it', () => {
    const authority = createLearningAuthority({ db, enabled: true, now: () => 100 });
    authority.capture({
      scope: { kind: 'USER_GLOBAL', key: 'owner', ownerId: 'owner', workspaceId: null },
      type: 'USER_PREFERENCE', subjectKey: 'temporary', content: 'Temporary preference.', expiresAt: 101,
      source: { kind: 'USER_EXPLICIT', identity: 'input_expiry', revision: '1', independentKey: 'input_expiry' },
    });
    const before = db.totalChanges;
    const snapshot = snapshotLearningReadiness({ db, entitled: true, now: () => 102 });
    expect(snapshot).toMatchObject({ ready: false, retrievalHealthy: false, repairable: true });
    expect(db.totalChanges).toBe(before);
  });
});
