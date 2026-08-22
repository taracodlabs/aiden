/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityInstaller } from '../../../core/v4/capabilities/installer';
import { CapabilityManagementAuthority } from '../../../core/v4/capabilities/management';
import { createCapabilityStore } from '../../../core/v4/capabilities/store';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { capabilityDoctorResults } from '../../../cli/v4/doctor';

let root = '';
let db: Database.Database;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-capability-doctor-'));
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Capability doctor projection', () => {
  it('reports stale staging honestly without deleting it', async () => {
    const store = createCapabilityStore(db);
    const installer = new CapabilityInstaller({
      aidenRoot: root,
      store,
      aidenVersion: '4.20.0',
      nodeVersion: '22.23.1',
    });
    const stale = path.join(root, 'capabilities', '.staging', 'interrupted-install');
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(stale, 'partial'), 'partial', 'utf8');
    const authority = new CapabilityManagementAuthority({
      store,
      installer,
      processHost: {
        probe: () => ({
          available: false,
          mechanism: 'docker' as const,
          image: 'node:test',
          reason: 'daemon unavailable',
        }),
        run: async () => { throw new Error('not used'); },
      },
      scopeId: 'workspace_1',
      ownerId: 'owner_1',
      workspaceId: 'workspace_1',
    });

    const projection = await authority.doctor();

    expect(projection).toMatchObject({
      broker: 'ready',
      sandbox: { available: false, mechanism: 'docker', reason: 'daemon unavailable' },
      installed: 0,
      active: 0,
      stagingPending: 1,
    });
    await expect(fs.stat(stale)).resolves.toBeTruthy();
  });

  it('renders separate broker, physical sandbox, registry and staging checks', () => {
    const rows = capabilityDoctorResults({
      broker: 'ready',
      sandbox: { available: false, mechanism: 'docker', image: 'node:test', reason: 'daemon unavailable' },
      installed: 2,
      active: 1,
      healthy: 1,
      degraded: 1,
      permissionUpdates: 1,
      stagingPending: 1,
    });

    expect(rows.map((row) => row.name)).toEqual([
      'capability broker',
      'capability sandbox',
      'capability registry',
      'capability health',
      'permission updates',
      'capability staging',
    ]);
    expect(rows.find((row) => row.name === 'capability sandbox')).toMatchObject({ passed: false });
    expect(rows.find((row) => row.name === 'capability staging')).toMatchObject({ passed: false });
    expect(rows.every((row) => row.group === 'Capabilities')).toBe(true);
  });
});
