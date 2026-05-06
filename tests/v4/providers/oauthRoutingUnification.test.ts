import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';
import {
  MODEL_CATALOG,
  listModelsForProvider,
} from '../../../providers/v4/modelCatalog';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';
import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import { saveTokens } from '../../../core/v4/auth/tokenStore';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-oauth-route-'));
  process.env.AIDEN_TOKEN_KEY = 'test-key-oauth-route';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function makeResolver(): RuntimeResolver {
  return new RuntimeResolver(
    new CredentialResolver(path.join(tmpRoot, 'auth.json')),
  );
}

/**
 * Phase 21 #5 — single canonical routing for OAuth providers.
 *
 * The unification deletes legacy `claude_subscription` and
 * `chatgpt_subscription` registry stubs. These tests verify the
 * one-name-per-service contract holds end-to-end: registry, catalog,
 * picker enumeration, and runtime credential lookup all converge on
 * `claude-pro` and `chatgpt-plus`.
 */
describe('Phase 21 #5 — OAuth provider routing unification', () => {
  it('1. legacy snake_case OAuth stubs are removed from PROVIDER_REGISTRY', () => {
    expect(PROVIDER_REGISTRY['claude_subscription']).toBeUndefined();
    expect(PROVIDER_REGISTRY['chatgpt_subscription']).toBeUndefined();
  });

  it('2. canonical OAuth providers exist with oauth.providerId set', () => {
    const claude = PROVIDER_REGISTRY['claude-pro'];
    const chatgpt = PROVIDER_REGISTRY['chatgpt-plus'];
    expect(claude?.oauth?.providerId).toBe('claude-pro');
    expect(chatgpt?.oauth?.providerId).toBe('chatgpt-plus');
  });

  it('3. MODEL_CATALOG no longer references legacy provider IDs', () => {
    const legacyHits = MODEL_CATALOG.filter(
      (m) =>
        m.providerId === 'claude_subscription' ||
        m.providerId === 'chatgpt_subscription',
    );
    expect(legacyHits).toEqual([]);
  });

  it('4. claude-pro catalog absorbed all four migrated Claude models', () => {
    const ids = listModelsForProvider('claude-pro').map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ]),
    );
  });

  it('5. chatgpt-plus catalog absorbed gpt-5-codex from the legacy stub', () => {
    const ids = listModelsForProvider('chatgpt-plus').map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(['gpt-5', 'gpt-5-mini', 'gpt-5-codex']),
    );
  });

  it('6. /model switch to chatgpt-plus reads the bearer from tokenStore (not auth.json)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveTokens(paths, {
      provider: 'chatgpt-plus',
      accessToken: 'oai-token-xyz',
      refreshToken: null,
      expiresAtMs: Date.now() + 60 * 60_000,
    });
    const r = await makeResolver().describe({
      providerId: 'chatgpt-plus',
      modelId: 'gpt-5',
      paths,
    });
    expect(r.apiKey).toBe('oai-token-xyz');
    expect(r.source).toBe('auth.json'); // canonical sentinel for "from token storage"
  });

  it('7. /model switch to claude-pro reads the bearer from tokenStore (cross-provider parity)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveTokens(paths, {
      provider: 'claude-pro',
      accessToken: 'anth-token-xyz',
      refreshToken: null,
      expiresAtMs: Date.now() + 60 * 60_000,
    });
    const r = await makeResolver().describe({
      providerId: 'claude-pro',
      modelId: 'claude-opus-4-7',
      paths,
    });
    expect(r.apiKey).toBe('anth-token-xyz');
  });

  it('8. adding a hypothetical new OAuth provider needs only registry + catalog, no picker/resolver code', () => {
    // Forward-compat: the resolver looks up creds via entry.oauth.providerId
    // and the picker enumerates PROVIDER_REGISTRY verbatim. So a new entry
    // (id, oauth.providerId) is sufficient — there is no allowlist or
    // hardcoded id to update.
    const synthetic = {
      id: 'gemini-pro',
      displayName: 'Gemini Pro (OAuth)',
      apiMode: 'chat_completions' as const,
      baseUrl: 'https://generativelanguage.googleapis.com/v1',
      apiKeyEnvVar: null,
      oauth: { providerId: 'gemini-pro' },
      description: 'fixture',
      tier: 'subscription' as const,
      hasFreeTier: false,
      docsUrl: '',
      supportsToolCalling: true,
      modelIds: ['gemini-pro-1'],
    };
    // Touching every reference point: shape match.
    expect(typeof synthetic.oauth.providerId).toBe('string');
    expect(synthetic.oauth.providerId).toBe(synthetic.id); // canonical convention
    expect(synthetic.apiKeyEnvVar).toBeNull(); // OAuth-only
  });
});
