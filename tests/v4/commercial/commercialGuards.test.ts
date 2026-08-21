import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

function run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('commercial repository guards', () => {
  it('allows the private commercial origin', () => {
    const result = run('verify-commercial-remote.mjs', ['origin', 'https://github.com/taracodlabs/aiden-pro.git']);
    expect(result.status).toBe(0);
  });

  it('rejects HTTPS and SSH pushes to the public Community repository', () => {
    for (const url of ['https://github.com/taracodlabs/aiden.git', 'git@github.com:taracodlabs/aiden.git']) {
      const result = run('verify-commercial-remote.mjs', ['community', url]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('push rejected');
    }
  });

  it('requires the exact deliberate Community-maintenance override', () => {
    const denied = run('verify-commercial-remote.mjs', ['community', 'https://github.com/taracodlabs/aiden.git'], {
      AIDEN_COMMUNITY_MAINTENANCE_PUSH: 'yes',
    });
    expect(denied.status).toBe(1);
    const allowed = run('verify-commercial-remote.mjs', ['community', 'https://github.com/taracodlabs/aiden.git'], {
      AIDEN_COMMUNITY_MAINTENANCE_PUSH: 'I_UNDERSTAND_THIS_PUSH_TARGETS_COMMUNITY',
    });
    expect(allowed.status).toBe(0);
  });

  it('rejects normal publication from the commercial workspace', () => {
    const result = run('verify-commercial-publish.mjs');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('publication rejected');
    expect(result.stderr).toContain('aiden-runtime');
  });
});

