import { describe, it, expect, vi } from 'vitest';
import type { OAuthUserAgent } from '../../../core/v4/auth/providerAuth';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const subscriptionPlugin = require('../../../plugins/aiden-plugin-chatgpt-plus/index.js');

function fakeUa(): OAuthUserAgent & {
  log: ReturnType<typeof vi.fn>;
  openBrowser: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    log: vi.fn(),
    openBrowser: vi.fn(async () => {}),
    prompt: vi.fn(async () => ''),
    sleep: vi.fn(async () => {}),
  } as any;
}

function fakeAuth(overrides: Partial<any> = {}) {
  return {
    runCopyPasteFlow: vi.fn(),
    runDeviceCodeFlow: vi.fn(async () => ({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresInSeconds: 3600,
      extras: {},
    })),
    refreshTokens: vi.fn(async () => ({
      accessToken: 'AT2',
      refreshToken: 'RT2',
      expiresInSeconds: 3600,
    })),
    generatePkce: vi.fn(),
    ...overrides,
  };
}

describe('aiden-plugin-chatgpt-plus: provider shape', () => {
  it('33. provider exposes the right id, displayName, runtime descriptor', () => {
    const provider = subscriptionPlugin.buildProvider(fakeAuth());
    expect(provider.id).toBe('chatgpt-plus');
    expect(provider.displayName).toBe('ChatGPT Plus');
    const desc = provider.describeRuntime!();
    expect(desc.apiMode).toBe('codex_responses');
    // Inference base URL is the chatgpt.com Codex endpoint, not api.openai.com.
    expect(desc.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
  });

  it('34. constants match the verified upstream values', () => {
    expect(subscriptionPlugin.SUBSCRIPTION_AUTH.clientId).toBe(
      'app_EMoamEEZ73f0CkXaXp7hrann',
    );
    expect(subscriptionPlugin.SUBSCRIPTION_AUTH.issuer).toBe('https://auth.openai.com');
    expect(subscriptionPlugin.SUBSCRIPTION_AUTH.baseUrl).toBe(
      'https://chatgpt.com/backend-api/codex',
    );
    expect(subscriptionPlugin.SUBSCRIPTION_AUTH.apiMode).toBe('codex_responses');
  });
});

describe('aiden-plugin-chatgpt-plus: UX helpers', () => {
  it('35. renderUserCodeBox produces a 3-line ASCII box around the code', () => {
    const lines = subscriptionPlugin.renderUserCodeBox('ABCD-1234');
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[0].endsWith('┐')).toBe(true);
    expect(lines[1]).toContain('ABCD-1234');
    expect(lines[1].startsWith('│')).toBe(true);
    expect(lines[1].endsWith('│')).toBe(true);
    expect(lines[2].startsWith('└')).toBe(true);
    // Top, middle, bottom all the same width.
    expect(lines[0].length).toBe(lines[1].length);
    expect(lines[1].length).toBe(lines[2].length);
  });

  it('36. formatRemaining produces "Mm Ss"', () => {
    expect(subscriptionPlugin.formatRemaining(0)).toBe('0m 0s');
    expect(subscriptionPlugin.formatRemaining(330_000)).toBe('5m 30s');
    expect(subscriptionPlugin.formatRemaining(60_000)).toBe('1m 0s');
  });

  it('37. buildPollingUa fires the "still waiting" reminder once after 5 min', async () => {
    const outer = fakeUa();
    let now = 0;
    const wrapped = subscriptionPlugin.buildPollingUa(
      outer,
      15 * 60 * 1000,
      () => now,
    );
    // Advance to 5 min - 1ms, sleep — no reminder yet.
    now = 5 * 60 * 1000 - 1;
    await wrapped.sleep(0);
    // Advance to 5 min, sleep — reminder fires.
    now = 5 * 60 * 1000;
    await wrapped.sleep(0);
    // Sleep again at 6 min — should NOT fire a second time.
    now = 6 * 60 * 1000;
    await wrapped.sleep(0);

    const reminderLines = outer.log.mock.calls
      .map((c) => c[0] as string)
      .filter((l) => /Still waiting/i.test(l));
    expect(reminderLines).toHaveLength(1);
    expect(reminderLines[0]).toMatch(/expires in/);
  });
});

describe('aiden-plugin-chatgpt-plus: login() flow', () => {
  it('38. delegates to runDeviceCodeFlow with the right config', async () => {
    const auth = fakeAuth();
    const provider = subscriptionPlugin.buildProvider(auth);
    const ua = fakeUa();
    const r = await provider.login(ua);
    expect(r.accessToken).toBe('AT');
    const cfg = auth.runDeviceCodeFlow.mock.calls[0][0];
    expect(cfg.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(cfg.issuer).toBe('https://auth.openai.com');
    expect(cfg.extraHeaders['User-Agent']).toMatch(/aiden-cli/);
  });

  it('39. boxed code rendering: flow log line "2. Enter the code: XYZ" rewritten with box', async () => {
    const auth = fakeAuth({
      runDeviceCodeFlow: vi.fn(async (_cfg: any, innerUa: OAuthUserAgent) => {
        // Drive the flow's own logging surface so we see what the plugin
        // does to the "Enter the code" line.
        innerUa.log('To continue:');
        innerUa.log('  1. Open: https://auth.openai.com/codex/device');
        innerUa.log('  2. Enter the code: ABCD-1234');
        return { accessToken: 'AT', refreshToken: null, expiresInSeconds: 0 };
      }),
    });
    const provider = subscriptionPlugin.buildProvider(auth);
    const ua = fakeUa();
    await provider.login(ua);
    const text = ua.log.mock.calls.map((c) => c[0] as string).join('\n');
    // Replacement happened: NOT "Enter the code: ABCD-1234" but boxed.
    expect(text).not.toContain('2. Enter the code: ABCD-1234');
    expect(text).toContain('Enter this code on that page');
    expect(text).toContain('ABCD-1234');
    expect(text).toMatch(/┌─+┐/);
  });

  it('40. timeout error appends "Code expired. Run /auth login chatgpt-plus to retry"', async () => {
    const auth = fakeAuth({
      runDeviceCodeFlow: vi.fn(async () => {
        throw new Error('Device-code login timed out (15 minutes)');
      }),
    });
    const provider = subscriptionPlugin.buildProvider(auth);
    const ua = fakeUa();
    await expect(provider.login(ua)).rejects.toThrow(
      /Code expired.*\/auth login chatgpt-plus/,
    );
  });

  it('41. non-timeout error gets the generic retry hint', async () => {
    const auth = fakeAuth({
      runDeviceCodeFlow: vi.fn(async () => {
        throw new Error('Device-code request failed: HTTP 503');
      }),
    });
    const provider = subscriptionPlugin.buildProvider(auth);
    const ua = fakeUa();
    await expect(provider.login(ua)).rejects.toThrow(
      /HTTP 503.*\/auth login chatgpt-plus/,
    );
  });

  it('42. "Authed as <email>" surfaces when token response carries account hint', async () => {
    const auth = fakeAuth({
      runDeviceCodeFlow: vi.fn(async () => ({
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresInSeconds: 3600,
        extras: { email: 'shiva@example.com' },
      })),
    });
    const provider = subscriptionPlugin.buildProvider(auth);
    const ua = fakeUa();
    await provider.login(ua);
    const text = ua.log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(text).toContain('Authed as shiva@example.com');
  });

  it('43. refresh() POSTs to /oauth/token with form-encoded body', async () => {
    const auth = fakeAuth();
    const provider = subscriptionPlugin.buildProvider(auth);
    await provider.refresh('OLD-RT');
    const cfg = auth.refreshTokens.mock.calls[0][1];
    expect(cfg.tokenUrl).toBe('https://auth.openai.com/oauth/token');
    expect(cfg.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(cfg.formEncoded).toBe(true);
    expect(cfg.extraHeaders['User-Agent']).toMatch(/aiden-cli/);
  });
});
