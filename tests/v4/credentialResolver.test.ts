import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  CredentialResolver,
  defaultAuthJsonPath,
  type AuthJsonShape,
} from '../../providers/v4/credentialResolver';
import { ProviderError } from '../../providers/v4/errors';

let tmpDir: string;
let authPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cred-'));
  authPath = path.join(tmpDir, 'auth.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeAuth(shape: AuthJsonShape): Promise<void> {
  await fs.writeFile(authPath, JSON.stringify(shape, null, 2), 'utf8');
}

describe('CredentialResolver', () => {
  it('1. loadCredentials returns null when auth.json does not exist', async () => {
    const resolver = new CredentialResolver(authPath);
    const result = await resolver.loadCredentials('anthropic_messages');
    expect(result).toBeNull();
  });

  it('2. loadCredentials parses an api_key entry correctly', async () => {
    await writeAuth({
      anthropic_messages: { type: 'api_key', apiKey: 'sk-ant-123' },
    });
    const resolver = new CredentialResolver(authPath);
    const result = await resolver.loadCredentials('anthropic_messages');
    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe('sk-ant-123');
    expect(result!.oauthToken).toBeUndefined();
    expect(result!.oauthRefreshable).toBe(false);
  });

  it('3. loadCredentials parses an OAuth entry with expiresAt', async () => {
    const expiresAtIso = '2030-01-01T00:00:00.000Z';
    await writeAuth({
      anthropic_messages: {
        type: 'oauth',
        oauthToken: 'oa-tok-xyz',
        refreshToken: 'rt-456',
        expiresAt: expiresAtIso,
      },
    });
    const resolver = new CredentialResolver(authPath);
    const result = await resolver.loadCredentials('anthropic_messages');
    expect(result!.oauthToken).toBe('oa-tok-xyz');
    expect(result!.oauthRefreshable).toBe(true);
    expect(result!.expiresAt!.toISOString()).toBe(expiresAtIso);
  });

  it('4. saveCredentials creates the file + parent directory', async () => {
    const nested = path.join(tmpDir, 'deeper', 'auth.json');
    const resolver = new CredentialResolver(nested);
    await resolver.saveCredentials('anthropic_messages', {
      apiKey: 'sk-saved',
      oauthRefreshable: false,
    });
    const raw = await fs.readFile(nested, 'utf8');
    const parsed = JSON.parse(raw) as AuthJsonShape;
    expect(parsed.anthropic_messages?.type).toBe('api_key');
    expect(parsed.anthropic_messages?.apiKey).toBe('sk-saved');
  });

  it('5. saveCredentials sets file mode 0o600 on POSIX (skipped on Windows)', async () => {
    const resolver = new CredentialResolver(authPath);
    await resolver.saveCredentials('anthropic_messages', {
      apiKey: 'sk-test',
      oauthRefreshable: false,
    });
    if (process.platform === 'win32') return;
    const stat = await fs.stat(authPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('6. round-trip: save then load returns the same data', async () => {
    const resolver = new CredentialResolver(authPath);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h ahead
    await resolver.saveCredentials('anthropic_messages', {
      oauthToken: 'tok',
      oauthRefreshable: true,
      expiresAt,
    });
    const loaded = await resolver.loadCredentials('anthropic_messages');
    expect(loaded!.oauthToken).toBe('tok');
    expect(loaded!.expiresAt!.getTime()).toBe(expiresAt.getTime());
  });

  it('7. saving one mode preserves other modes already stored', async () => {
    await writeAuth({
      codex_responses: { type: 'api_key', apiKey: 'sk-codex' },
    });
    const resolver = new CredentialResolver(authPath);
    await resolver.saveCredentials('anthropic_messages', {
      apiKey: 'sk-ant',
      oauthRefreshable: false,
    });
    const both = JSON.parse(await fs.readFile(authPath, 'utf8')) as AuthJsonShape;
    expect(both.codex_responses?.apiKey).toBe('sk-codex');
    expect(both.anthropic_messages?.apiKey).toBe('sk-ant');
  });

  it('8. malformed JSON throws a clear error (does not swallow)', async () => {
    await fs.writeFile(authPath, '{not valid json', 'utf8');
    const resolver = new CredentialResolver(authPath);
    await expect(resolver.loadCredentials('anthropic_messages')).rejects.toThrow(/malformed/);
  });

  it('9. refreshIfNeeded returns unchanged when expiresAt > 5 min away', async () => {
    const resolver = new CredentialResolver(authPath);
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const result = await resolver.refreshIfNeeded({
      oauthToken: 'still-good',
      oauthRefreshable: true,
      expiresAt: future,
    });
    expect(result.oauthToken).toBe('still-good');
    expect(result.expiresAt!.getTime()).toBe(future.getTime());
  });

  it('10. refreshIfNeeded triggers refreshHook when expiresAt within 5 min', async () => {
    await writeAuth({
      anthropic_messages: {
        type: 'oauth',
        oauthToken: 'old-tok',
        refreshToken: 'rt-456',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const resolver = new CredentialResolver(authPath);
    let hookCalled = false;
    resolver.setRefreshHook(async () => {
      hookCalled = true;
      return {
        oauthToken: 'new-tok',
        oauthRefreshable: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
    });
    const refreshed = await resolver.getCredentialsForMode('anthropic_messages');
    expect(hookCalled).toBe(true);
    expect(refreshed.oauthToken).toBe('new-tok');
  });

  it('11. refreshIfNeeded throws ProviderError when hook fails', async () => {
    await writeAuth({
      anthropic_messages: {
        type: 'oauth',
        oauthToken: 'old',
        refreshToken: 'rt',
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    const resolver = new CredentialResolver(authPath);
    resolver.setRefreshHook(async () => {
      throw new Error('refresh endpoint 401');
    });
    await expect(resolver.getCredentialsForMode('anthropic_messages')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('12. getCredentialsForMode throws ProviderError when no credentials exist', async () => {
    const resolver = new CredentialResolver(authPath);
    await expect(resolver.getCredentialsForMode('anthropic_messages')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('13. saveCredentials rejects unmanaged apiModes (chat_completions, ollama_prompt_tools)', async () => {
    const resolver = new CredentialResolver(authPath);
    await expect(
      resolver.saveCredentials('chat_completions', { apiKey: 'k', oauthRefreshable: false }),
    ).rejects.toThrow(/does not manage credentials/);
  });

  it('14. initiateOAuthFlow throws Phase-13 stub error', async () => {
    const resolver = new CredentialResolver(authPath);
    await expect(resolver.initiateOAuthFlow('anthropic_messages')).rejects.toThrow(/Phase 13/);
  });

  it('15. defaultAuthJsonPath resolves to platform-appropriate location', () => {
    const p = defaultAuthJsonPath();
    expect(p.endsWith('auth.json')).toBe(true);
    // Tracks the real per-platform resolver (resolveAidenPaths): macOS
    // ~/Library/Application Support/aiden, Linux XDG ~/.config/aiden (or legacy
    // ~/.aiden), Windows %LOCALAPPDATA%\aiden. The cross-platform invariant is
    // the trailing `aiden/auth.json` — NOT a hardcoded `.aiden`, which only held
    // on legacy Linux and wrongly failed on macOS + XDG Linux.
    expect(p.replace(/\\/g, '/').toLowerCase()).toMatch(/(^|\/)aiden\/auth\.json$/);
  });
});
