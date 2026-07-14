/**
 * Phase 18 Task 4 — setup wizard OAuth integration tests.
 *
 * The wizard's `kind: 'pro'` path now runs the real OAuth flow via
 * OAuthProviderRuntime. These tests stub the plugin's buildProvider to
 * return a synthetic OAuthProvider so we never touch network or load
 * the real ChatGPT plugin (its OAuth fixtures are tested separately in
 * subscriptionPlugin.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runSetupWizard, PROVIDERS } from '../../../cli/v4/setupWizard';
import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  loadTokens,
} from '../../../core/v4/auth/tokenStore';
import { Display } from '../../../cli/v4/display';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-wizard-oauth-'));
  process.env.AIDEN_TOKEN_KEY = 'test-key';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
});

/**
 * Stub the plugin's buildProvider to return a synthetic OAuthProvider so
 * the wizard exercises the OAuthProviderRuntime path end-to-end without
 * any real plugin code or network. Patches Node's require cache for the
 * given module path.
 */
function stubPluginBuildProvider(
  pluginRelPath: string,
  providerSpec: {
    id: string;
    displayName: string;
    defaultModels: string[];
    loginResult: any;
  },
): () => void {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const absPath = path.resolve(repoRoot, pluginRelPath);
  // Pre-load + stash original.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const original = require(absPath);
  const stubbed = {
    ...original,
    buildProvider: () => ({
      id: providerSpec.id,
      displayName: providerSpec.displayName,
      defaultModels: providerSpec.defaultModels,
      async login() {
        return providerSpec.loginResult;
      },
      async refresh() {
        return providerSpec.loginResult;
      },
      describeRuntime() {
        return { apiMode: 'anthropic_messages', baseUrl: 'http://stub' };
      },
    }),
  };
  // Patch the cache.
  require.cache[require.resolve(absPath)]!.exports = stubbed;
  return () => {
    require.cache[require.resolve(absPath)]!.exports = original;
  };
}

function fakePrompts(answers: {
  providerIndex?: number;
  confirm?: boolean;
  pasteCode?: string;
}) {
  return {
    async choose(_q: string, _choices: string[]) {
      return answers.providerIndex ?? 1;
    },
    async input(_q: string, _opts?: any) {
      return answers.pasteCode ?? '';
    },
    async confirm(_q: string, def?: boolean) {
      return answers.confirm ?? def ?? false;
    },
  };
}

/**
 * Phase 30.2.1: scripted prompts for OAuth-decline / OAuth-fail tests.
 * The wizard now loops back to provider pick on these paths instead of
 * returning oauth-skipped/oauth-failed, so tests need a queue to feed
 * a follow-up "pick a different provider" answer that terminates the
 * outer loop deterministically.
 */
function scriptedPrompts(answers: {
  choose: number[];
  input?: string[];
  confirm?: boolean[];
}) {
  const choose = [...answers.choose];
  const input = [...(answers.input ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  return {
    async choose(_q: string, _choices: string[]) {
      if (choose.length === 0) throw new Error('scriptedPrompts.choose: queue empty');
      return choose.shift()!;
    },
    async input(_q: string, _opts?: any) {
      return input.shift() ?? '';
    },
    async confirm(_q: string, _def?: boolean) {
      return confirm.shift() ?? false;
    },
  };
}

const subscriptionProviderIndex = PROVIDERS.findIndex((p) => p.id === 'chatgpt-plus') + 1;

describe('setup wizard — OAuth provider integration (kind: pro)', () => {
  it('46. user picks chatgpt-plus → device-code login → config + tokens persisted', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    const restore = stubPluginBuildProvider(
      'plugins/aiden-plugin-chatgpt-plus/index.js',
      {
        id: 'chatgpt-plus',
        displayName: 'ChatGPT Plus',
        defaultModels: ['gpt-5'],
        loginResult: {
          accessToken: 'gpt-AT',
          refreshToken: 'gpt-RT',
          expiresInSeconds: 7200,
          extras: { email: 'user@example.com' },
        },
      },
    );

    try {
      const result = await runSetupWizard({
        paths,
        display: new Display(),
        // Phase 30.2.1: chatgpt-plus moved to index [10] in the reordered list.
        prompts: fakePrompts({ providerIndex: subscriptionProviderIndex, confirm: true }),
        skipValidation: true,
      });
      expect(result.status).toBe('configured');
      expect(result.config?.model.provider).toBe('chatgpt-plus');
      const tokens = await loadTokens(paths, 'chatgpt-plus');
      expect(tokens?.accessToken).toBe('gpt-AT');
      expect(tokens?.account).toBe('user@example.com');
    } finally {
      restore();
    }
  });

});
