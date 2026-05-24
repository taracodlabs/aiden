/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.5 SLICE 1.5 — provider-coverage regression test.
 *
 * THE bug class this prevents: Slice 1 wired curated-skills Step 4
 * only into the API-key wizard branch. Subscription OAuth providers
 * (claude-pro, chatgpt-plus) had their own success-exit at L882 that
 * bypassed Step 4 entirely — user found this in manual smoke when
 * ChatGPT Plus went straight to "All set!" with no curated offer.
 *
 * The unit tests in setupWizard.curated.test.ts cover the helper in
 * isolation; the existing setupWizard.test.ts covers per-provider
 * flow but only asserted up to renderSuccessScreen. NEITHER caught
 * the missing call site.
 *
 * This test parameterizes over the four provider types we shipped
 * and asserts EACH wizard branch invokes `finalizeWithCuratedStep`
 * before returning. The injection seam is `setFinalizeForTest` —
 * minimum-surface test hook, swaps the helper for a counting stub.
 *
 * If a future provider branch is added without wiring the helper,
 * this test fails with "<provider>: finalize fired 0 times".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  runSetupWizard,
  setFinalizeForTest,
  PROVIDERS,
  type PromptIO,
} from '../../../cli/v4/setupWizard';
import { resolveAidenPaths, type AidenPaths } from '../../../core/v4/paths';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { OAuthProvider } from '../../../core/v4/auth/providerAuth';

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-prov-cov-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
});

afterEach(async () => {
  setFinalizeForTest(null);   // restore the production helper
  await fs.rm(tmp, { recursive: true, force: true });
});

function scripted(answers: {
  choose?: number[];
  input?: string[];
  confirm?: boolean[];
}): PromptIO {
  const choose  = [...(answers.choose ?? [])];
  const input   = [...(answers.input ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  return {
    async choose(_q, _c, _d) {
      if (choose.length === 0) throw new Error('scripted choose ran out');
      return choose.shift()!;
    },
    async input() {
      if (input.length === 0) throw new Error('scripted input ran out');
      return input.shift()!;
    },
    async confirm() {
      if (confirm.length === 0) return false;
      return confirm.shift()!;
    },
  };
}

function sinkDisplay(): { display: Display; chunks: string[] } {
  const chunks: string[] = [];
  const stdout = {
    isTTY: false,
    write(s: string): boolean { chunks.push(s); return true; },
  } as unknown as NodeJS.WriteStream;
  const stderr = {
    isTTY: false,
    write(s: string): boolean { chunks.push(`STDERR:${s}`); return true; },
  } as unknown as NodeJS.WriteStream;
  return {
    display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout, stderr }),
    chunks,
  };
}

/** Minimal stub OAuthProvider for the oauthStub seam. */
const fakeOAuthProvider: OAuthProvider = {
  id:            'fake-oauth',
  displayName:   'Fake OAuth',
  defaultModels: ['fake-model-1'],
  async startLogin() { return { authUrl: 'https://example.com/auth' }; },
  async finishLogin() {
    return { accessToken: 'tok', refreshToken: 'ref', expiresAtMs: Date.now() + 3600_000 };
  },
  async refresh() {
    return { accessToken: 'tok2', refreshToken: 'ref2', expiresAtMs: Date.now() + 3600_000 };
  },
} as unknown as OAuthProvider;

const fakeTokens = { expiresAtMs: Date.now() + 3600_000, account: 'test@example.com' };

interface ProviderCase {
  id:             string;
  branch:         'oauth' | 'apikey';
  choose:         number[];
  input:          string[];
  confirm?:       boolean[];
  needsOAuthStub: boolean;
}

function caseFor(id: string): ProviderCase {
  const idx = PROVIDERS.findIndex((p) => p.id === id) + 1;
  if (idx === 0) throw new Error(`provider ${id} not found`);
  const provider = PROVIDERS[idx - 1];
  if (provider.kind === 'pro') {
    return {
      id,
      branch:         'oauth',
      choose:         [idx],
      input:          [],
      confirm:        [true],            // "Continue with X?" → yes
      needsOAuthStub: true,
    };
  }
  // API-key branch: choose provider, type API key, pick first model.
  const modelChooseCount = (provider.models?.length ?? 0) > 1 ? [1] : [];
  return {
    id,
    branch:         'apikey',
    choose:         [idx, ...modelChooseCount],
    input:          ['test-api-key-' + id],
    needsOAuthStub: false,
  };
}

const PROVIDER_CASES: ProviderCase[] = [
  caseFor('groq'),
  caseFor('anthropic'),
  caseFor('claude-pro'),
  caseFor('chatgpt-plus'),
];

describe('setupWizard — finalizeWithCuratedStep fires across ALL provider branches', () => {
  for (const cse of PROVIDER_CASES) {
    it(`${cse.id} (${cse.branch} branch) invokes finalizeWithCuratedStep before return`, async () => {
      let finalizeCalls = 0;
      let lastDeps: { paths: AidenPaths } | null = null;
      setFinalizeForTest(async (deps) => {
        finalizeCalls += 1;
        lastDeps = deps as never;
      });

      const { display } = sinkDisplay();
      const result = await runSetupWizard({
        paths,
        display,
        prompts: scripted({ choose: cse.choose, input: cse.input, confirm: cse.confirm }),
        skipValidation: true,
        ...(cse.needsOAuthStub ? { oauthStub: { provider: fakeOAuthProvider, tokens: fakeTokens } } : {}),
      });

      expect(result.status, `${cse.id} should reach configured state`).toBe('configured');
      expect(finalizeCalls, `${cse.id}: finalize fired ${finalizeCalls} times`).toBe(1);
      expect(lastDeps).not.toBeNull();
      // Helper must receive the same paths the wizard ran under — proves
      // the call site passed real deps, not a placeholder.
      expect(lastDeps!.paths.root).toBe(paths.root);
    });
  }

  it('verifies all four canonical provider types are covered', () => {
    // Honesty check: if a future PR drops a provider from PROVIDER_CASES
    // without explanation, this test reminds the next developer that
    // the coverage matrix is the regression layer.
    expect(PROVIDER_CASES).toHaveLength(4);
    const branches = new Set(PROVIDER_CASES.map((c) => c.branch));
    expect(branches.has('oauth')).toBe(true);
    expect(branches.has('apikey')).toBe(true);
  });
});
