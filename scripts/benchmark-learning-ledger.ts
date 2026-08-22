import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';

import { runMigrations } from '../core/v4/daemon/db/migrations';
import { createLearningAuthority } from '../core/v4/learning/learningAuthority';
import type { LearningScope } from '../core/v4/learning/types';

const ENTRY_COUNT = 100_000;
const QUERY_RUNS = 30;
const OWNER_ID = 'benchmark_owner';
const TARGET_WORKSPACE = 'benchmark_workspace_3';
const TARGET_SCOPE: LearningScope = {
  kind: 'REPOSITORY',
  key: 'benchmark_repository_3',
  ownerId: OWNER_ID,
  workspaceId: TARGET_WORKSPACE,
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const percentile = (values: number[], quantile: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
};
const elapsed = (started: number): number => Number((performance.now() - started).toFixed(2));

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'aiden-learning-benchmark-'));
  const databasePath = join(root, 'learning-benchmark.db');
  const db = new Database(databasePath);
  let finalReport: Record<string, unknown> | undefined;
  const heapSamples: number[] = [process.memoryUsage().heapUsed];
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(
      `INSERT INTO learning_sources (
         source_id,dedupe_key,source_kind,source_identity,source_revision,independent_key,
         owner_id,workspace_id,verification_state,source_digest,metadata_json,occurred_at,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'learning_source_benchmark', digest('benchmark-source'), 'SYSTEM_POLICY', 'synthetic-benchmark', '1',
      'synthetic-benchmark', OWNER_ID, null, 'verified', digest('synthetic-benchmark-source'), '{}',
      1_700_000_000_000, 1_700_000_000_000,
    );

    const insertVersion = db.prepare(
      'INSERT INTO learning_content_versions (version_id,entry_id,content,content_digest,created_at) VALUES (?,?,?,?,?)',
    );
    const insertEntry = db.prepare(
      `INSERT INTO learning_entries (
         entry_id,entry_key,scope_kind,scope_key,owner_id,workspace_id,learning_type,subject_key,
         confidence,lifecycle,current_version_id,content,content_digest,eligible,source_count,
         state_version,expires_at,created_at,updated_at,deleted_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO learning_events (
         event_id,entry_id,event_type,source_id,version_id,entry_version,entry_key,scope_kind,scope_key,
         owner_id,workspace_id,learning_type,subject_key,confidence,lifecycle,eligible,source_count,
         expires_at,content_digest,related_entry_id,reason_code,metadata_json,idempotency_key,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO learning_fts
        (entry_id,owner_id,workspace_id,scope_kind,scope_key,learning_type,subject_key,content)
       VALUES (?,?,?,?,?,?,?,?)`,
    );

    const ingestStarted = performance.now();
    db.transaction(() => {
      for (let index = 0; index < ENTRY_COUNT; index += 1) {
        const entryId = `learning_benchmark_${String(index).padStart(6, '0')}`;
        const workspaceIndex = index % 10;
        const workspaceId = `benchmark_workspace_${workspaceIndex}`;
        const scopeKey = `benchmark_repository_${workspaceIndex}`;
        const pairIndex = Math.floor(index / 2);
        const isConflict = index < 2_000;
        const relatedEntryId = isConflict
          ? `learning_benchmark_${String(index % 2 === 0 ? index + 1 : index - 1).padStart(6, '0')}`
          : null;
        const lifecycle = isConflict ? 'CONFLICTED'
          : index % 29 === 0 ? 'DELETED'
            : index % 23 === 0 ? 'ARCHIVED'
              : index % 19 === 0 ? 'STALE'
                : 'ACTIVE';
        const confidence = index % 7 === 0 ? 'TRUSTED' : index % 3 === 0 ? 'CORROBORATED' : 'OBSERVED';
        const expired = index % 31 === 0;
        const eligible = lifecycle === 'ACTIVE' && !expired ? 1 : 0;
        const content = lifecycle === 'DELETED'
          ? null
          : `Synthetic release verification lesson ${index} for repository ${scopeKey} with deterministic evidence ${pairIndex}.`;
        const contentDigest = content === null ? null : digest(content);
        const versionId = content === null ? null : `learning_content_benchmark_${String(index).padStart(6, '0')}`;
        const entryKey = digest(`${OWNER_ID}\0${workspaceId}\0REPOSITORY\0${scopeKey}\0VERIFIED_PROCEDURE_LESSON\0lesson.${index}\0${contentDigest ?? ''}`);
        const createdAt = 1_700_000_000_000 + index;
        if (content !== null && versionId !== null && contentDigest !== null) {
          insertVersion.run(versionId, entryId, content, contentDigest, createdAt);
        }
        insertEntry.run(
          entryId, entryKey, 'REPOSITORY', scopeKey, OWNER_ID, workspaceId,
          'VERIFIED_PROCEDURE_LESSON', `lesson.${index}`, confidence, lifecycle,
          versionId, content, contentDigest, eligible, 1, 1,
          expired ? createdAt - 1 : null, createdAt, createdAt,
          lifecycle === 'DELETED' ? createdAt : null,
        );
        insertEvent.run(
          `learning_event_benchmark_${String(index).padStart(6, '0')}`, entryId,
          isConflict ? 'CONFLICTED' : lifecycle === 'DELETED' ? 'DELETED' : 'CAPTURED',
          'learning_source_benchmark', versionId, 1, entryKey, 'REPOSITORY', scopeKey, OWNER_ID, workspaceId,
          'VERIFIED_PROCEDURE_LESSON', `lesson.${index}`, confidence, lifecycle, eligible, 1,
          expired ? createdAt - 1 : null, contentDigest, relatedEntryId,
          isConflict ? 'incompatible_verified_observations' : null,
          '{}', `benchmark:${index}`, createdAt,
        );
        if (eligible === 1 && content !== null) {
          insertFts.run(entryId, OWNER_ID, workspaceId, 'REPOSITORY', scopeKey,
            'VERIFIED_PROCEDURE_LESSON', `lesson.${index}`, content);
        }
      }
    }).immediate();
    const ingestMs = elapsed(ingestStarted);
    heapSamples.push(process.memoryUsage().heapUsed);

    const authority = createLearningAuthority({ db, enabled: true, now: () => 1_800_000_000_000 });
    const retrievalDurations: number[] = [];
    let expectedIds: string[] | undefined;
    for (let run = 0; run < QUERY_RUNS; run += 1) {
      const started = performance.now();
      const result = authority.retrieve({
        query: 'release verification deterministic evidence',
        scopes: [TARGET_SCOPE],
        limit: 20,
        maxChars: 2_000,
      });
      retrievalDurations.push(performance.now() - started);
      const ids = result.items.map((entry) => entry.id);
      if (ids.length > 20 || result.context.length > 2_000) {
        throw new Error('Learning retrieval exceeded its result or context bound');
      }
      if (expectedIds && JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
        throw new Error('Learning retrieval order was not deterministic');
      }
      expectedIds = ids;
    }
    heapSamples.push(process.memoryUsage().heapUsed);

    const filterStarted = performance.now();
    const scopedEligible = (db.prepare(
      `SELECT COUNT(*) AS count FROM learning_entries
        WHERE owner_id=? AND workspace_id=? AND scope_kind=? AND scope_key=? AND eligible=1`,
    ).get(OWNER_ID, TARGET_WORKSPACE, 'REPOSITORY', TARGET_SCOPE.key) as { count: number }).count;
    const scopeFilterMs = elapsed(filterStarted);

    const deleteTarget = authority.list({ scopes: [TARGET_SCOPE] }).find((entry) => entry.eligible);
    if (!deleteTarget) throw new Error('Synthetic benchmark did not create a deletable target');
    const deleteStarted = performance.now();
    authority.delete({ entryId: deleteTarget.id, expectedVersion: deleteTarget.version, reason: 'synthetic benchmark cleanup' });
    const deleteMs = elapsed(deleteStarted);
    const deletedFtsCount = (db.prepare('SELECT COUNT(*) AS count FROM learning_fts WHERE entry_id=?')
      .get(deleteTarget.id) as { count: number }).count;
    if (deletedFtsCount !== 0) throw new Error('Deleted Learning entry remained in FTS');

    const rebuildStarted = performance.now();
    const rebuild = authority.rebuild();
    const rebuildMs = elapsed(rebuildStarted);
    heapSamples.push(process.memoryUsage().heapUsed);
    const afterRebuild = authority.retrieve({
      query: 'release verification deterministic evidence', scopes: [TARGET_SCOPE], limit: 20, maxChars: 2_000,
    });
    if (afterRebuild.items.some((entry) => entry.id === deleteTarget.id)) {
      throw new Error('Projection rebuild resurrected deleted benchmark content');
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    const databaseBytes = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter((path) => existsSync(path))
      .reduce((total, path) => total + statSync(path).size, 0);

    finalReport = {
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      entries: ENTRY_COUNT,
      databasePath,
      databaseBytes,
      sampledHeap: {
        initialBytes: heapSamples[0],
        maximumBytes: Math.max(...heapSamples),
        samples: heapSamples.length,
      },
      ingestMs,
      rebuildMs,
      ftsQuery: {
        runs: QUERY_RUNS,
        p50Ms: Number(percentile(retrievalDurations, 0.5).toFixed(2)),
        p95Ms: Number(percentile(retrievalDurations, 0.95).toFixed(2)),
        topK: afterRebuild.items.length,
        contextChars: afterRebuild.context.length,
        deterministic: true,
      },
      scopeFilter: { milliseconds: scopeFilterMs, eligibleEntries: scopedEligible },
      deleteIndexRemovalMs: deleteMs,
      rebuild,
      boundedRetrievalScanLimit: 80,
      syntheticDatabaseRemoved: true,
    };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
}

main();
