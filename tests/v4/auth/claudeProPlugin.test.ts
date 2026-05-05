import { describe, it, expect, vi } from 'vitest';
import type { OAuthUserAgent } from '../../../core/v4/auth/providerAuth';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const claudePro = require('../../../plugins/aiden-plugin-claude-pro/index.js');

function fakeUa(promptReturns: string): OAuthUserAgent & {
  log: ReturnType<typeof vi.fn>;
  openBrowser: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
    openBrowser: vi.fn(async () => {}),
    prompt: vi.fn(async () => promptReturns),
    sleep: vi.fn(async () => {}),
  } as any;
}

function fakeAuth(overrides: Partial<any> = {}) {
  return {
    runCopyPasteFlow: vi.fn(async () => ({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresInSeconds: 3600,
      extras: {},
    })),
    runDeviceCodeFlow: vi.fn(),
    refreshTokens: vi.fn(async () => ({
      accessToken: 'AT2',
      refreshToken: 'RT2',
      expiresInSeconds: 3600,
    })),
    generatePkce: vi.fn(),
    ...overrides,
  };
}

describe('aiden-plugin-claude-pro: provider shape', () => {
  it('24. provider exposes the right id, displayName, and runtime descriptor', () => {
    const auth = fakeAuth();
    const provider = claudePro.buildProvider(auth);
    expect(provider.id).toBe('claude-pro');
    expect(provider.displayName).toBe('Claude Pro / Max');
    expect(provider.defaultModels).toEqual(
      expect.arrayContaining(['claude-opus-4-7', 'claude-sonnet-4-6']),
    );
    const desc = provider.describeRuntime!();
    expect(desc.apiMode).toBe('anthropic_messages');
    expect(desc.baseUrl).toBe('https://api.anthropic.com');
    expect(desc.headerPrefix).toBe('Bearer ');
  });

  it('25. constants match the values pulled from the Hermes audit', () => {
    expect(claudePro.CLAUDE_PRO.clientId).toBe(
      '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    );
    expect(claudePro.CLAUDE_PRO.authUrl).toBe(
      'https://claude.ai/oauth/authorize',
    );
    expect(claudePro.CLAUDE_PRO.tokenUrl).toBe(
      'https://platform.claude.com/v1/oauth/token',
    );
    expect(claudePro.CLAUDE_PRO.fallbackTokenUrls).toContain(
      'https://console.anthropic.com/v1/oauth/token',
    );
    expect(claudePro.CLAUDE_PRO.scope).toContain('user:inference');
  });
});

describe('aiden-plugin-claude-pro: login() UX + flow', () => {
  it('26. prints the 5-step instructions and trims the pasted code', async () => {
    const auth = fakeAuth();
    const provider = claudePro.buildProvider(auth);
    const ua = fakeUa('  AUTHCODE#STATE  \n');
    const r = await provider.login(ua);
    expect(r.accessToken).toBe('AT');

    // Captured runCopyPasteFlow received a promptable user agent of its own;
    // we verify the *outer* ua got the 5-step prompts via log() calls.
    const logs = ua.log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logs).toContain('1. Open the URL above in your browser');
    expect(logs).toContain('2. Sign in to Claude');
    expect(logs).toContain('3. Authorise Aiden');
    expect(logs).toContain('4. Copy the code shown after redirect');
    expect(logs).toContain('5. Paste it back here');

    // The inner runCopyPasteFlow was called with a wrapping ua. When that
    // ua.prompt is invoked, it should trim and pass to outer ua.prompt.
    const innerCfg = auth.runCopyPasteFlow.mock.calls[0][0];
    const innerUa = auth.runCopyPasteFlow.mock.calls[0][1];
    expect(innerCfg.clientId).toBe(
      '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    );
    expect(innerCfg.extraHeaders['User-Agent']).toMatch(
      /^aiden-cli\/\S+ \(external, cli\)$/,
    );
    // Drive the inner ua's prompt to confirm trimming.
    const trimmed = await innerUa.prompt('q');
    expect(trimmed).toBe('AUTHCODE#STATE');
  });

  it('27. surfaces "Authed as <email>" when the token response carries an account hint', async () => {
    const auth = fakeAuth({
      runCopyPasteFlow: vi.fn(async () => ({
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresInSeconds: 3600,
        extras: { account: 'shiva@example.com' },
      })),
    });
    const provider = claudePro.buildProvider(auth);
    const ua = fakeUa('CODE');
    await provider.login(ua);
    const logs = ua.log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logs).toContain('Authed as shiva@example.com');
  });

  it('28. flow failure produces a thrown error with retry guidance', async () => {
    const auth = fakeAuth({
      runCopyPasteFlow: vi.fn(async () => {
        throw new Error('Token exchange failed: HTTP 400: invalid_grant');
      }),
    });
    const provider = claudePro.buildProvider(auth);
    const ua = fakeUa('OLD-EXPIRED-CODE');
    await expect(provider.login(ua)).rejects.toThrow(
      /\/auth login claude-pro/,
    );
  });

  it('29. refresh() delegates to refreshTokens with the right config', async () => {
    const auth = fakeAuth();
    const provider = claudePro.buildProvider(auth);
    const r = await provider.refresh('OLD-RT');
    expect(r.accessToken).toBe('AT2');
    const refreshCfg = auth.refreshTokens.mock.calls[0][1];
    expect(refreshCfg.tokenUrl).toBe(
      'https://platform.claude.com/v1/oauth/token',
    );
    expect(refreshCfg.fallbackTokenUrls).toContain(
      'https://console.anthropic.com/v1/oauth/token',
    );
    expect(refreshCfg.clientId).toBe(
      '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    );
    expect(refreshCfg.extraHeaders['User-Agent']).toMatch(/aiden-cli/);
  });
});
