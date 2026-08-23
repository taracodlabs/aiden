/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/v4/capabilities/processHost', () => ({
  DockerCapabilityProcessHost: class {
    probe() {
      return { available: true, mechanism: 'docker' as const, image: 'test-image' };
    }
  },
}));

import { runCapabilitiesCli } from '../../../cli/v4/capabilitiesCli';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

let root = '';
let db: Database.Database;
let output = '';
let errors = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capabilities-cli-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  output = '';
  errors = '';
});
afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

const options = () => ({
  aidenRoot: root,
  aidenVersion: '4.20.0',
  workspaceRoot: root,
  ownerId: 'owner_1',
  db,
  write: (text: string) => { output += text; },
  writeError: (text: string) => { errors += text; },
});

describe('capabilities CLI', () => {
  it('supports install, explicit permission review, list, inspect, health and disable as JSON', async () => {
    expect(await runCapabilitiesCli({ action: 'install', target: path.resolve('capabilities/samples/workspace-summary'), json: true }, options())).toBe(0);
    const installed = JSON.parse(output) as { record: { manifest: { id: string; version: string } } };
    output = '';
    expect(await runCapabilitiesCli({ action: 'activate', target: `${installed.record.manifest.id}@${installed.record.manifest.version}`, json: true }, options())).toBe(1);
    expect(JSON.parse(output).error).toMatch(/permission review/i);
    output = '';
    expect(await runCapabilitiesCli({
      action: 'activate', target: `${installed.record.manifest.id}@${installed.record.manifest.version}`,
      acceptPermissions: true, json: true,
    }, options())).toBe(0);
    output = '';
    expect(await runCapabilitiesCli({ action: 'list', json: true }, options())).toBe(0);
    expect(JSON.parse(output)).toEqual([expect.objectContaining({ capabilityId: installed.record.manifest.id })]);
    output = '';
    expect(await runCapabilitiesCli({ action: 'test', target: installed.record.manifest.id, json: true }, options())).toBe(0);
    expect(JSON.parse(output)).toEqual({ healthy: true, reasons: [] });
    output = '';
    expect(await runCapabilitiesCli({ action: 'disable', target: installed.record.manifest.id, json: true }, options())).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ enabled: false });
    expect(errors).toBe('');
  });

  it('does not include installed host paths in structured output', async () => {
    await runCapabilitiesCli({ action: 'install', target: path.resolve('capabilities/samples/workspace-summary'), json: true }, options());
    expect(output).not.toContain('installPath');
    expect(output).not.toContain(path.join(root, 'capabilities'));
  });
});
