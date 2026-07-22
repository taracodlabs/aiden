import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  isUnresolvedCredentialPlaceholder,
  persistManagedCredential,
  resolveApiCredential,
} from '../../../providers/v4/credentialAuthority';
import { resolveAidenPaths } from '../../../core/v4/paths';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function home(): Promise<ReturnType<typeof resolveAidenPaths>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-credential-'));
  roots.push(root);
  return resolveAidenPaths({ rootOverride: root });
}

describe('effective credential authority', () => {
  it('treats unresolved placeholders as missing', async () => {
    expect(isUnresolvedCredentialPlaceholder('${GROQ_API_KEY}')).toBe(true);
    const resolved = await resolveApiCredential({
      providerId: 'groq',
      envVar: 'GROQ_API_KEY',
      registryEndpoint: 'https://example.invalid/v1',
      config: { get: () => '${GROQ_API_KEY}', getRaw: () => '${GROQ_API_KEY}' },
      env: {},
    });
    expect(resolved.apiKey).toBeNull();
    expect(resolved.effective.configured).toBe(false);
  });

  it('does not let an older process value shadow the newly persisted credential', async () => {
    const paths = await home();
    await fs.writeFile(paths.envFile, 'GROQ_API_KEY=new-persisted-key\n', 'utf8');
    const resolved = await resolveApiCredential({
      providerId: 'groq',
      envVar: 'GROQ_API_KEY',
      registryEndpoint: 'https://example.invalid/v1',
      config: { get: () => 'old-shell-key', getRaw: () => '${GROQ_API_KEY}' },
      paths,
      env: { GROQ_API_KEY: 'old-shell-key' },
    });
    expect(resolved.apiKey).toBe('new-persisted-key');
    expect(resolved.effective.credentialSource).toBe('managed_environment');
    expect(resolved.effective.conflicts).toEqual([
      { preferred: 'managed_environment', shadowed: 'process_environment' },
    ]);
  });

  it('gives an explicit invocation override deterministic precedence', async () => {
    const resolved = await resolveApiCredential({
      providerId: 'groq',
      envVar: 'GROQ_API_KEY',
      registryEndpoint: 'https://example.invalid/v1',
      override: 'override-key',
      config: { get: () => 'config-key', getRaw: () => 'config-key' },
      env: { GROQ_API_KEY: 'env-key' },
    });
    expect(resolved.apiKey).toBe('override-key');
    expect(resolved.effective.credentialSource).toBe('explicit_override');
  });

  it('uses stable non-secret fingerprints', () => {
    expect(credentialFingerprint('secret-value')).toBe(credentialFingerprint('secret-value'));
    expect(credentialFingerprint('secret-value')).not.toContain('secret-value');
  });

  it('atomically persists and immediately resolves a managed credential', async () => {
    const paths = await home();
    const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'older-process-value' };
    const credential = ['fixture', 'managed', 'credential'].join('-');

    const persisted = await persistManagedCredential({
      paths,
      envVar: 'GROQ_API_KEY',
      credential,
      env,
    });

    expect(persisted.credentialFingerprint).toBe(credentialFingerprint(credential));
    expect(persisted.credentialSource).toBe('managed_environment');
    expect(env.GROQ_API_KEY).toBe(credential);
    const resolved = await resolveApiCredential({
      providerId: 'groq',
      envVar: 'GROQ_API_KEY',
      registryEndpoint: 'https://example.invalid/v1',
      paths,
      env,
    });
    expect(resolved.apiKey).toBe(credential);
    expect(resolved.effective.credentialSource).toBe('managed_environment');
  });

  it('rejects an empty managed credential without creating the file', async () => {
    const paths = await home();
    await expect(persistManagedCredential({
      paths,
      envVar: 'GROQ_API_KEY',
      credential: '   ',
      env: {},
    })).rejects.toMatchObject({ code: 'credential_missing' });
    await expect(fs.access(paths.envFile)).rejects.toBeDefined();
  });

  it('does not expose a credential when the atomic write cannot complete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-credential-blocked-'));
    roots.push(root);
    const blockingFile = path.join(root, 'not-a-directory');
    await fs.writeFile(blockingFile, 'blocked', 'utf8');
    const paths = resolveAidenPaths({ rootOverride: path.join(blockingFile, 'home') });
    const env: NodeJS.ProcessEnv = {};

    await expect(persistManagedCredential({
      paths,
      envVar: 'GROQ_API_KEY',
      credential: 'fixture-credential',
      env,
    })).rejects.toMatchObject({ code: 'credential_write_failed' });
    expect(env.GROQ_API_KEY).toBeUndefined();
  });
});
