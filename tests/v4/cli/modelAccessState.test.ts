import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeProviderAccessProbe } from '../../../cli/v4/commands/model';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { saveTokens } from '../../../core/v4/auth/tokenStore';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(root: string, readinessState: string) {
  return {
    paths: resolveAidenPaths({ rootOverride: root }),
    config: {
      getValue: () => ({ state: readinessState }),
      get: () => undefined,
    },
  } as never;
}

describe('model picker provider access truth', () => {
  it('does not report verified readiness when the persisted OAuth token is expired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-auth-state-'));
    roots.push(root);
    const paths = resolveAidenPaths({ rootOverride: root });
    const ctx = context(root, 'complete');
    await saveTokens(paths, {
      provider: 'chatgpt-plus',
      accessToken: 'fixture-token',
      expiresAtMs: Date.now() - 1,
    });

    await expect(makeProviderAccessProbe(ctx)('chatgpt-plus')).resolves.toBe('authentication_expired');
  });

  it('distinguishes valid authentication from verified and failed readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-auth-state-'));
    roots.push(root);
    const paths = resolveAidenPaths({ rootOverride: root });
    await saveTokens(paths, {
      provider: 'chatgpt-plus',
      accessToken: 'fixture-token',
      expiresAtMs: Date.now() + 60_000,
    });
    const make = (state: string) => makeProviderAccessProbe({
      paths,
      config: { getValue: () => ({ state }), get: () => undefined },
    } as never)('chatgpt-plus');

    await expect(make('credential_verified')).resolves.toBe('authentication_valid');
    await expect(make('complete')).resolves.toBe('readiness_verified');
    await expect(make('failed_requires_user_action')).resolves.toBe('readiness_failed');
  });
});
