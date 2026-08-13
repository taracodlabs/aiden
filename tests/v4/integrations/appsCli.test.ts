/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAppsCli } from '../../../cli/v4/appsCli';
import { daemonDbPath } from '../../../core/v4/daemon/daemonConfig';
import type { SecretBackend } from '../../../core/v4/integrations/secretAuthority';

class TestBackend implements SecretBackend {
  readonly id = 'test';
  async protect(value: string) { return Buffer.from(`protected:${value}`).toString('base64'); }
  async unprotect(value: string) { return Buffer.from(value, 'base64').toString('utf8').slice('protected:'.length); }
  health() { return { available: true, protectedByOs: true, detail: 'test' }; }
}

let root: string;

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'aiden-apps-cli-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('apps CLI', () => {
  it('shows a truthful empty state when Composio is not configured', async () => {
    let output = '';
    const code = await runAppsCli({ action: 'list' }, {
      rootDir: root, cwd: root, write: (text) => { output += text; }, secretBackend: new TestBackend(),
    });
    expect(code).toBe(0);
    expect(output).toContain('Aiden Apps');
    expect(output).toContain('Composio');
    expect(output).toContain('Not configured');
  });

  it('stores a provider credential without echoing it or persisting plaintext in SQLite', async () => {
    let output = '';
    const secret = 'provider-key-private';
    const code = await runAppsCli({ action: 'configure', providerId: 'composio' }, {
      rootDir: root, cwd: root, write: (text) => { output += text; },
      readCredential: async () => secret, secretBackend: new TestBackend(),
    });
    expect(code).toBe(0);
    expect(output).not.toContain(secret);
    const bytes = await import('node:fs/promises').then((fs) => fs.readFile(daemonDbPath(root)));
    expect(bytes.toString('utf8')).not.toContain(secret);
  });

  it('connects, lists and disconnects one deterministic account without dead commands', async () => {
    let output = '';
    const write = (text: string) => { output += text; };
    const base = { rootDir: root, cwd: root, write, includeFake: true, secretBackend: new TestBackend() };
    const connect = await runAppsCli({ action: 'connect', providerId: 'fake', toolkitId: 'projects', label: 'Personal' }, base);
    expect(connect).toBe(0);
    const connectionId = output.match(/Connection:\s+(fake-connection-[a-f0-9]+)/)?.[1];
    expect(connectionId).toBeTruthy();
    output = '';
    expect(await runAppsCli({ action: 'complete', connectionId }, base)).toBe(0);
    const accountId = output.match(/Account:\s+(account_[A-Za-z0-9_-]+)/)?.[1];
    expect(accountId).toBeTruthy();
    output = '';
    expect(await runAppsCli({ action: 'accounts' }, base)).toBe(0);
    expect(output).toContain('Personal');
    output = '';
    expect(await runAppsCli({ action: 'disconnect', accountId, yes: true }, base)).toBe(0);
    expect(output).toContain('Disconnected');
  });

  it('does not disconnect without explicit confirmation', async () => {
    const confirm = vi.fn(async () => false);
    const code = await runAppsCli({ action: 'disconnect', accountId: 'account_missing' }, {
      rootDir: root, cwd: root, write: () => undefined, confirm,
      includeFake: true, secretBackend: new TestBackend(),
    });
    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});
