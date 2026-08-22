import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createLearningAuthority } from '../../../../core/v4/learning/learningAuthority';
import type { LearningScope } from '../../../../core/v4/learning/types';
import { runLearningSubcommand } from '../../../../cli/v4/commands/learning';

describe('aiden learning CLI', () => {
  let root: string;
  let dbPath: string;
  let entryId: string;
  let entryVersion: number;
  let output: string[];
  const scope: LearningScope = {
    kind: 'REPOSITORY', key: 'repo_cli', ownerId: 'owner_cli', workspaceId: 'workspace_cli',
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-learning-cli-'));
    dbPath = path.join(root, 'daemon', 'daemon.db');
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    runMigrations(db);
    const entry = createLearningAuthority({ db, enabled: true }).capture({
      scope,
      type: 'USER_PREFERENCE',
      subjectKey: 'response.style',
      content: 'Use concise release summaries.',
      source: { kind: 'USER_EXPLICIT', identity: 'input_cli', revision: '1', independentKey: 'input_cli' },
    }).entry;
    entryId = entry.id;
    entryVersion = entry.version;
    db.close();
    output = [];
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  const run = (action: string, args: string[]) => runLearningSubcommand(action, args, {
    dbPath,
    scopes: [scope],
    defaultScope: scope,
    enabled: true,
    writeOut: (value) => { output.push(value); },
    writeErr: (value) => { output.push(value); },
  });

  it('lists, shows, reviews, and exports scoped records as stable JSON', async () => {
    expect(await run('list', ['--json'])).toBe(0);
    expect(JSON.parse(output.join(''))).toEqual([expect.objectContaining({ id: entryId, content: 'Use concise release summaries.' })]);
    output = [];
    expect(await run('show', [entryId, '--json'])).toBe(0);
    expect(JSON.parse(output.join('')).entry.id).toBe(entryId);
    output = [];
    expect(await run('review', [entryId, '--json'])).toBe(0);
    expect(JSON.parse(output.join('')).history).toHaveLength(1);
    output = [];
    expect(await run('export', ['--json'])).toBe(0);
    expect(JSON.parse(output.join('')).sources[0]).toMatchObject({ kind: 'USER_EXPLICIT', identity: 'input_cli' });
  });

  it('archives, hard-deletes with explicit confirmation, and rebuilds derived projections', async () => {
    expect(await run('archive', [entryId, '--version', String(entryVersion), '--reason', 'no longer useful', '--json'])).toBe(0);
    const archived = JSON.parse(output.join(''));
    expect(archived.lifecycle).toBe('ARCHIVED');
    output = [];
    expect(await run('delete', [entryId, '--version', String(archived.version), '--yes', '--reason', 'privacy request', '--json'])).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ lifecycle: 'DELETED', content: null });
    output = [];
    expect(await run('rebuild', ['--json'])).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ entries: 1, indexed: 0 });
  });

  it('requires an exact state version and explicit confirmation for hard deletion', async () => {
    expect(await run('delete', [entryId, '--version', String(entryVersion)])).toBe(2);
    expect(output.join('')).toMatch(/--yes/i);
    output = [];
    expect(await run('archive', [entryId, '--version', '999', '--json'])).toBe(1);
    expect(output.join('')).toMatch(/version conflict/i);
  });

  it('accepts --state-version so the root --version flag remains package metadata', async () => {
    expect(await run('archive', [entryId, '--state-version', String(entryVersion), '--json'])).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ lifecycle: 'ARCHIVED', version: entryVersion + 1 });
  });
});
