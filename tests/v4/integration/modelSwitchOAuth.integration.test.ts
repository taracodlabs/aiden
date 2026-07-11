import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import { saveTokens } from '../../../core/v4/auth/tokenStore';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';
import { ChatSession } from '../../../cli/v4/chatSession';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-oauth-int-'));
  process.env.AIDEN_TOKEN_KEY = 'test-key-oauth-integration';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_TOKEN_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

/**
 * Phase 21 #5 reopen — /model switch must thread `paths` through to
 * RuntimeResolver so the entry.oauth fast-path fires. The bug:
 * chatSession.setProvider() called resolver.resolve({ providerId,
 * modelId }) without paths; the resolver's OAuth fast-path is gated on
 * options.paths; the gate skipped and the chain fell to the legacy
 * credentialResolver/auth.json path.
 *
 * These integration tests EXERCISE THE ACTUAL CALL CHAIN
 * (chatSession.setProvider → resolver.resolve → tokenStore lookup) so a
 * future caller that strips `paths` again is caught loudly.
 */
describe('Phase 21 #5 — /model switch OAuth call-chain integration', () => {
  function makeChatSession(opts: {
    paths: ReturnType<typeof resolveAidenPaths>;
    resolverImpl: { resolve: (o: any) => Promise<any> };
  }) {
    // Build a minimal ChatSession just to exercise setProvider().
    // Most fields are intentionally undefined — setProvider doesn't read
    // them, but ChatSession's constructor accepts the options bag whole.
    const stub: any = {
      // Phase v4.1.2-bug2: chatSession.setProvider now also calls
      // agent.setActiveModel(...) so the prompt's Runtime slot stays
      // in lockstep with the routed provider. Stub it as a no-op.
      agent: { setProvider: () => undefined, setActiveModel: () => true },
      display: { write() {}, success() {}, warn() {}, info() {}, dim() {} },
      commandRegistry: { exec: () => Promise.resolve({}) },
      callbacks: {},
      sessionManager: {
        startSession: () => ({ id: 's', titleHint: '', createdAt: Date.now() }),
        recordTurn: () => undefined,
        recordTitle: () => undefined,
      },
      auxiliaryClient: {},
      approvalEngine: { resetSession: () => undefined },
      toolRegistry: { list: () => [] },
      skillLoader: { reload: () => Promise.resolve() },
      resolver: opts.resolverImpl,
      config: { getValue: () => undefined, get: () => undefined },
      initialProviderId: 'chatgpt-plus',
      initialModelId: 'gpt-5',
      paths: opts.paths,
    };
    return new ChatSession(stub);
  }

  it('1. /model switch to chatgpt-plus with token in tokenStore → resolver receives paths and reads bearer', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await saveTokens(paths, {
      provider: 'chatgpt-plus',
      accessToken: 'oai-real-bearer',
      refreshToken: null,
      expiresAtMs: Date.now() + 60 * 60_000,
    });

    // Capture the options forwarded to runtimeResolver.resolve so we
    // verify paths actually arrives.
    const captured: { call?: any } = {};
    const realResolver = new RuntimeResolver(
      new CredentialResolver(path.join(tmpRoot, 'auth.json')),
    );
    const wrappingResolver = {
      async resolve(o: any) {
        captured.call = o;
        // Use describe() to walk the same credential chain without
        // instantiating an adapter — sufficient to prove the fast-path
        // fired and returned the bearer.
        const r = await realResolver.describe(o);
        return r;
      },
    };

    const session = makeChatSession({ paths, resolverImpl: wrappingResolver });
    await session.setProvider('chatgpt-plus', 'gpt-5');

    expect(captured.call?.paths).toBeDefined();
    expect(captured.call.paths.root).toBe(paths.root);
    // The bearer came from tokenStore (not auth.json)
    const description = await realResolver.describe({
      providerId: 'chatgpt-plus',
      modelId: 'gpt-5',
      paths,
    });
    expect(description.apiKey).toBe('oai-real-bearer');
  });

  it('2. /model switch to chatgpt-plus WITHOUT a stored token → error references tokenStore path, not auth.json', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    // Intentionally no saveTokens call.

    const realResolver = new RuntimeResolver(
      new CredentialResolver(path.join(tmpRoot, 'auth.json')),
    );

    // describe() throws synchronously when paths is provided AND
    // entry.oauth is set AND no token is on disk — runtimeResolver line
    // 244-249 surfaces "X requires OAuth login. Run /auth login X".
    await expect(
      realResolver.describe({
        providerId: 'chatgpt-plus',
        modelId: 'gpt-5',
        paths,
      }),
    ).rejects.toThrow(/chatgpt-plus requires OAuth login/);

    // Crucially: the error message references the OAuth flow,
    // NOT the deprecated auth.json path.
    try {
      await realResolver.describe({
        providerId: 'chatgpt-plus',
        modelId: 'gpt-5',
        paths,
      });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('auth.json');
      expect(msg).toContain('/auth login chatgpt-plus');
    }
  });

});
