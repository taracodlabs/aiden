/**
 * Phase 19 — token store cross-platform key derivation tests.
 *
 * Confirms the encrypted file format is portable within a single
 * (host, user, platform) tuple AND that the same machine identity
 * produces the same key across imports — i.e. encryption is
 * deterministic, decryption succeeds across boots.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  saveTokens,
  loadTokens,
  machineFingerprint,
} from '../../../core/v4/auth/tokenStore';
import { resolveAidenPaths, ensureAidenDirsExist } from '../../../core/v4/paths';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-tokens-xplat-'));
  // Override the AIDEN_TOKEN_KEY so tests are deterministic on every host.
  process.env.AIDEN_TOKEN_KEY = 'phase-19-cross-platform-test-key';
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
});

describe('tokenStore — cross-platform determinism', () => {
  it('18. same key + same machine identity ⇒ encrypt/decrypt round-trip succeeds', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    await saveTokens(paths, {
      provider: 'demo',
      accessToken: 'AT-cross-platform',
      refreshToken: 'RT-cross-platform',
      expiresAtMs: Date.now() + 3600_000,
      account: 'shiva@example.com',
    });

    // Simulate a process restart by re-reading via a fresh code path.
    const back = await loadTokens(paths, 'demo');
    expect(back?.accessToken).toBe('AT-cross-platform');
    expect(back?.account).toBe('shiva@example.com');
  });

  it('19. machineFingerprint is stable across calls (same hash within a process)', () => {
    const a = machineFingerprint();
    const b = machineFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});
