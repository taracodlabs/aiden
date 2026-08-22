import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createLearningAuthority } from '../../../core/v4/learning/learningAuthority';
import { migrateLegacyMemorySnapshot } from '../../../core/v4/learning/legacyMigration';
import type { MemorySnapshot } from '../../../core/v4/memoryProvider';

describe('selective legacy Memory migration', () => {
  let db: Database.Database;
  const scope = { kind: 'USER_GLOBAL' as const, key: 'owner_1', ownerId: 'owner_1', workspaceId: null };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('imports only provenance-tagged entries, is restart-idempotent, and leaves source text unchanged', () => {
    const sourceText = [
      '# User memory',
      '- [said] Prefer concise status reports.',
      '- [saw] This repository usually passes npm test.',
      '- [guess] The user may prefer dark mode.',
      '- Legacy untagged line must not be treated as explicit authority.',
    ].join('\n');
    const snapshot: MemorySnapshot = {
      memoryMd: '', userMd: sourceText, loadedAt: 1, isEmpty: false,
      files: { user: { content: sourceText, charCount: sourceText.length, charLimit: 20_000, path: 'USER.md' } },
    };
    const ledger = createLearningAuthority({ db, enabled: true, now: () => 100 });

    const first = migrateLegacyMemorySnapshot({ authority: ledger, snapshot, resolveScope: () => scope });
    const replay = migrateLegacyMemorySnapshot({ authority: ledger, snapshot, resolveScope: () => scope });

    expect(first).toMatchObject({ imported: 3, rejected: 1, duplicates: 0 });
    expect(replay).toMatchObject({ imported: 0, rejected: 1, duplicates: 3 });
    expect(snapshot.files?.user?.content).toBe(sourceText);
    const entries = ledger.list({ scopes: [scope] });
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.content?.includes('concise'))?.confidence).toBe('TRUSTED');
    expect(entries.filter((entry) => entry.confidence === 'CANDIDATE')).toHaveLength(2);
    expect(ledger.retrieve({ query: 'concise reports', scopes: [scope] }).items).toEqual([]);
  });
});
