/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.11 — artifact registry tests. Covers the store (create/get/list +
 * session filter) against a real better-sqlite3 handle + the v15
 * migration, and the pure capture gate (verifier-ok + tool-success →
 * register; failed/unverified/non-file → skip).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import {
  createArtifactStore,
  extractFileArtifact,
  captureArtifactFromTrace,
  type ArtifactStore,
} from '../../../core/v4/daemon/artifactStore';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

let tmp: string;
let db: Database.Database;
let store: ArtifactStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-artifacts-'));
  db = new Database(path.join(tmp, 'daemon.db'));
  runMigrations(db);
  store = createArtifactStore({ db });
});

afterEach(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('ArtifactStore.create / get', () => {
  it('inserts a row and round-trips the provenance fields', () => {
    const id = store.create({
      path: '/ws/report.md', kind: 'file', tool: 'file_write', action: 'create',
      sessionId: 'sess-1', runId: 42, taskId: 'task_abc', bytes: 1234, preview: 'hello',
    });
    expect(id).toMatch(/^art_[a-f0-9]+$/);
    const row = store.get(id)!;
    expect(row).not.toBeNull();
    expect(row.path).toBe('/ws/report.md');
    expect(row.kind).toBe('file');
    expect(row.tool).toBe('file_write');
    expect(row.action).toBe('create');
    expect(row.sessionId).toBe('sess-1');
    expect(row.runId).toBe(42);
    expect(row.taskId).toBe('task_abc');
    expect(row.bytes).toBe(1234);
    expect(row.preview).toBe('hello');
    expect(row.createdAt).toBeGreaterThan(0);
  });

  it('get returns null for an unknown id', () => {
    expect(store.get('art_nope')).toBeNull();
  });

  it('tolerates null provenance (no run/task/bytes/preview)', () => {
    const id = store.create({ path: '/x', kind: 'file', tool: 'file_write', action: 'create', sessionId: 's' });
    const row = store.get(id)!;
    expect(row.runId).toBeNull();
    expect(row.taskId).toBeNull();
    expect(row.bytes).toBeNull();
    expect(row.preview).toBeNull();
  });
});

describe('ArtifactStore.listRecent', () => {
  it('returns newest-first by createdAt', async () => {
    const a = store.create({ path: '/a', kind: 'file', tool: 'file_write', action: 'create', sessionId: 's' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create({ path: '/b', kind: 'file', tool: 'file_write', action: 'create', sessionId: 's' });
    expect(store.listRecent().map((x) => x.id)).toEqual([b, a]);
  });

  it('filters by sessionId; omitting it lists across ALL sessions (/artifacts all)', () => {
    store.create({ path: '/a', kind: 'file', tool: 'file_write', action: 'create', sessionId: 'sess-A' });
    store.create({ path: '/b', kind: 'file', tool: 'file_write', action: 'create', sessionId: 'sess-B' });
    store.create({ path: '/c', kind: 'file', tool: 'file_write', action: 'create', sessionId: 'sess-A' });
    expect(store.listRecent({ sessionId: 'sess-A' }).length).toBe(2);
    expect(store.listRecent().length).toBe(3); // cross-session
  });
});

describe('extractFileArtifact', () => {
  it('file_write success → file/create with bytes', () => {
    expect(extractFileArtifact('file_write', { success: true, path: '/x', bytes: 10 }))
      .toEqual({ path: '/x', kind: 'file', action: 'create', bytes: 10 });
  });
  it('file_patch success → file/overwrite', () => {
    expect(extractFileArtifact('file_patch', { success: true, path: '/x' })?.action).toBe('overwrite');
  });
  it('file_move/file_copy read the destination (`to`)', () => {
    expect(extractFileArtifact('file_move', { success: true, from: '/a', to: '/b' }))
      .toMatchObject({ path: '/b', action: 'move' });
    expect(extractFileArtifact('file_copy', { success: true, from: '/a', to: '/b' }))
      .toMatchObject({ path: '/b', action: 'copy' });
  });
  it('skill_manage success → skill kind', () => {
    expect(extractFileArtifact('skill_manage', { success: true, path: '/skills/x' })?.kind).toBe('skill');
  });
  it('non-file tools → null', () => {
    expect(extractFileArtifact('file_read', { success: true, path: '/x' })).toBeNull();
    expect(extractFileArtifact('shell_exec', { success: true, stdout: 'x' })).toBeNull();
    expect(extractFileArtifact('file_list', { success: true })).toBeNull();
  });
  it('failed tool result (success!==true) → null', () => {
    expect(extractFileArtifact('file_write', { success: false, path: '/x', error: 'EACCES' })).toBeNull();
    expect(extractFileArtifact('file_write', { path: '/x' })).toBeNull(); // no success flag
  });
  it('missing/blank path → null', () => {
    expect(extractFileArtifact('file_write', { success: true })).toBeNull();
    expect(extractFileArtifact('file_write', { success: true, path: '  ' })).toBeNull();
  });
});

describe('captureArtifactFromTrace — the verifier-ok gate', () => {
  const ok = { success: true, path: '/x', bytes: 5 };

  it('verifier-ok + tool-success → registers', () => {
    expect(captureArtifactFromTrace({ name: 'file_write', result: ok, verification: { ok: true } }))
      .toMatchObject({ path: '/x', action: 'create' });
  });

  it('no verification stamp + tool-success → registers (silent success)', () => {
    expect(captureArtifactFromTrace({ name: 'file_write', result: ok }))
      .toMatchObject({ path: '/x' });
  });

  it('verifier flagged failed → NOT registered (the gate)', () => {
    expect(captureArtifactFromTrace({ name: 'file_write', result: ok, verification: { ok: false } }))
      .toBeNull();
  });

  it('tool reported failure → NOT registered', () => {
    expect(captureArtifactFromTrace({ name: 'file_write', result: { success: false, path: '/x' } }))
      .toBeNull();
  });
});

describe('capture round-trip (gate → store)', () => {
  it('a verifier-ok file_write is captured and listable; a failed one is not', () => {
    const sessionId = 'sess-rt';
    const trace = [
      { name: 'file_write', result: { success: true, path: '/ws/good.md', bytes: 3 }, verification: { ok: true } },
      { name: 'file_write', result: { success: true, path: '/ws/bad.md' }, verification: { ok: false } }, // verifier-failed
      { name: 'file_read',  result: { success: true, path: '/ws/x.md' } },                                 // not a producer
    ];
    for (const t of trace) {
      const a = captureArtifactFromTrace(t);
      if (a) store.create({ path: a.path, kind: a.kind, tool: t.name, action: a.action, sessionId, bytes: a.bytes });
    }
    const rows = store.listRecent({ sessionId });
    expect(rows.map((r) => r.path)).toEqual(['/ws/good.md']); // only the verifier-ok write
  });
});
