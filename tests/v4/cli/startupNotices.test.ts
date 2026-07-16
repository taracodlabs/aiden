import { describe, expect, it } from 'vitest';

import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import {
  buildAuthenticationNotice,
  buildLocalRuntimeNotice,
  buildNoProviderNotice,
  buildProviderFallbackNotice,
  buildProviderResolutionNotice,
  buildSavedModelNotice,
  commandIsRegisteredOrVerified,
  prepareStartupNotices,
  renderStartupNoticeLines,
  startupNoticeVisibleWidth,
  type StartupNotice,
} from '../../../cli/v4/startupNotices';
import { ProviderError } from '../../../providers/v4/errors';

function registry(): CommandRegistry {
  const reg = new CommandRegistry();
  for (const name of ['auth', 'doctor', 'model', 'mcp', 'plugins']) {
    reg.register({
      name,
      description: name,
      category: 'system',
      handler: async () => undefined,
    });
  }
  return reg;
}

function notice(partial: Partial<StartupNotice>): StartupNotice {
  return {
    id: partial.id ?? 'n',
    severity: partial.severity ?? 'action',
    title: partial.title ?? 'Notice',
    detail: partial.detail,
    command: partial.command,
    source: partial.source ?? 'system',
    blocking: partial.blocking ?? false,
    dedupeKey: partial.dedupeKey ?? partial.id ?? 'n',
  };
}

describe('startup notices', () => {
  it('keeps healthy provider/model state silent', () => {
    expect(prepareStartupNotices([], registry())).toEqual([]);
  });

  it('builds one actionable no-provider notice with a verified command', () => {
    const prepared = prepareStartupNotices([buildNoProviderNotice()], registry());
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      severity: 'blocking',
      source: 'provider',
      command: '/model',
      blocking: true,
    });
  });

  it('redacts missing-key and OAuth details before rendering', () => {
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz123456 token=abcdefghijklmnopqrstuvwxyz';
    const prepared = prepareStartupNotices([
      buildAuthenticationNotice({
        providerId: 'groq',
        state: 'missing-api-key',
        detail: `No key: ${secret}`,
      }),
    ], registry());
    const text = renderStartupNoticeLines(prepared, { columns: 100 }).join('\n');
    expect(text).toContain('groq credential required');
    expect(text).toContain('/auth status');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(text).not.toContain('token=abcdefghijklmnopqrstuvwxyz');
  });

  it('distinguishes expired OAuth from first-time authorization', () => {
    const first = buildAuthenticationNotice({ providerId: 'chatgpt-plus', state: 'oauth-required' });
    const expired = buildAuthenticationNotice({ providerId: 'chatgpt-plus', state: 'oauth-expired' });
    expect(first.title).toContain('authorization required');
    expect(first.command).toBe('/auth login chatgpt-plus');
    expect(expired.title).toContain('session expired');
    expect(expired.command).toBe('/auth refresh chatgpt-plus');
  });

  it('renders saved model available as informational and unavailable fallback as one action', () => {
    const info = buildSavedModelNotice({
      savedModel: 'saved-a',
      activeModel: 'saved-a',
      available: true,
    });
    const fallback = buildSavedModelNotice({
      savedModel: 'saved-a',
      activeModel: 'fallback-b',
      available: false,
      fallbackActive: true,
    });
    expect(info?.severity).toBe('info');
    expect(fallback).toMatchObject({
      severity: 'action',
      command: '/model',
      source: 'model',
    });
    expect(fallback?.title).toContain('Saved model unavailable');
    expect(fallback?.detail).toContain('fallback-b');
  });

  it('marks unavailable saved model without fallback as blocking', () => {
    const n = buildSavedModelNotice({
      savedModel: 'missing-model',
      activeModel: undefined,
      available: false,
      fallbackActive: false,
    });
    expect(n).toMatchObject({ severity: 'blocking', blocking: true, command: '/model' });
  });

  it('classifies local runtime and local missing-model states without download actions', () => {
    const service = buildLocalRuntimeNotice({ state: 'service-unreachable', providerId: 'ollama' });
    const missing = buildLocalRuntimeNotice({ state: 'model-missing', providerId: 'ollama', modelId: 'gemma4:e4b' });
    expect(service.title).toContain('runtime unavailable');
    expect(service.command).toBe('/doctor');
    expect(missing.detail).toContain('gemma4:e4b');
    expect(`${missing.title} ${missing.detail}`).not.toMatch(/download|pull/i);
  });

  it('states provider fallback truth without duplicating the original issue', () => {
    const prepared = prepareStartupNotices([
      buildProviderFallbackNotice({
        requestedProvider: 'groq',
        requestedModel: 'llama-a',
        activeProvider: 'ollama',
        activeModel: 'gemma-b',
        reason: '401 Bearer abcdefghijklmnopqrstuvwxyz123456',
      }),
      buildProviderFallbackNotice({
        requestedProvider: 'groq',
        requestedModel: 'llama-a',
        activeProvider: 'ollama',
        activeModel: 'gemma-b',
        reason: 'same',
      }),
    ], registry());
    expect(prepared).toHaveLength(1);
    expect(prepared[0].detail).toContain('groq/llama-a');
    expect(prepared[0].detail).toContain('ollama/gemma-b');
    expect(prepared[0].detail).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('orders blocking, auth, model, mcp, plugin, then info notices', () => {
    const prepared = prepareStartupNotices([
      notice({ id: 'info', severity: 'info', source: 'system', dedupeKey: 'info' }),
      notice({ id: 'plugin', source: 'plugin', command: '/plugins grant x', dedupeKey: 'plugin' }),
      notice({ id: 'mcp', source: 'mcp', command: '/mcp auth github', dedupeKey: 'mcp' }),
      notice({ id: 'model', source: 'model', command: '/model', dedupeKey: 'model' }),
      notice({ id: 'auth', source: 'authentication', command: '/auth status', dedupeKey: 'auth' }),
      notice({ id: 'block', severity: 'blocking', blocking: true, source: 'provider', command: '/model', dedupeKey: 'block' }),
    ], registry());
    expect(prepared.map((n) => n.id)).toEqual(['block', 'auth', 'model', 'mcp', 'plugin', 'info']);
  });

  it('bounds wide, medium, narrow, and minimal rendering', () => {
    const notices = prepareStartupNotices([
      notice({
        id: 'long',
        source: 'authentication',
        title: 'Provider reconnect required for an extremely long provider name',
        detail: 'Reconnect before normal use can continue',
        command: '/auth refresh provider-with-long-name',
        dedupeKey: 'long',
      }),
    ], registry());
    for (const columns of [120, 80, 48, 24]) {
      const lines = renderStartupNoticeLines(notices, { columns });
      for (const line of lines) {
        expect(startupNoticeVisibleWidth(line), line).toBeLessThanOrEqual(Math.max(1, columns - 2));
      }
    }
  });

  it('rejects displayed commands that are not registered or verified', () => {
    const reg = registry();
    expect(commandIsRegisteredOrVerified('/model', reg)).toBe(true);
    expect(commandIsRegisteredOrVerified('/mcp auth github', reg)).toBe(true);
    expect(commandIsRegisteredOrVerified('/mcp bogus github', reg)).toBe(false);
    expect(commandIsRegisteredOrVerified('/mcp auth', reg)).toBe(false);
    expect(commandIsRegisteredOrVerified('/plugins grant local-plugin', reg)).toBe(true);
    expect(commandIsRegisteredOrVerified('/plugins nope local-plugin', reg)).toBe(false);
    expect(commandIsRegisteredOrVerified('/plugins grant', reg)).toBe(false);
    expect(commandIsRegisteredOrVerified('/missing now', reg)).toBe(false);
  });

  it('throws when a notice references an unregistered command', () => {
    expect(() => prepareStartupNotices([
      notice({ id: 'bad', command: '/missing now', dedupeKey: 'bad' }),
    ], registry())).toThrow(/unregistered startup notice command/);
  });

  it('uses cautious wording for unknown state', () => {
    const n = notice({
      id: 'unknown',
      severity: 'warning',
      source: 'provider',
      title: 'Could not confirm provider status',
      command: '/doctor',
    });
    const text = renderStartupNoticeLines(prepareStartupNotices([n], registry()), { columns: 80 }).join('\n');
    expect(text).toContain('Could not confirm');
    expect(text).not.toMatch(/missing credentials|unavailable model/i);
  });

  it('uses structured provider errors before compatibility message matching', () => {
    const n = buildProviderResolutionNotice(
      'chatgpt-plus',
      new ProviderError('request failed', 'chatgpt-plus', 401, {
        message: 'refresh token expired',
      }),
    );
    expect(n.title).toContain('Could not confirm chatgpt-plus authentication');
    expect(n.command).toBe('/doctor');
    expect(n.detail).toBeUndefined();
  });

  it('keeps generic and secret-bearing provider messages unknown', () => {
    const n = buildProviderResolutionNotice(
      'groq',
      new Error('401 upstream failure access_token=abcdefghijklmnopqrstuvwxyz123456'),
    );
    const text = renderStartupNoticeLines(prepareStartupNotices([n], registry()), { columns: 100 }).join('\n');
    expect(n.title).toContain('Could not confirm groq authentication');
    expect(n.command).toBe('/doctor');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(text).not.toMatch(/credential required|session expired/i);
  });

  it('uses narrow compatibility patterns only for known resolver messages', () => {
    expect(buildProviderResolutionNotice('groq', new Error('No API key found for groq'))).toMatchObject({
      title: 'groq credential required',
      command: '/auth status',
    });
    expect(buildProviderResolutionNotice('chatgpt-plus', new Error('chatgpt-plus requires OAuth login'))).toMatchObject({
      title: 'chatgpt-plus authorization required',
      command: '/auth login chatgpt-plus',
    });
    expect(buildProviderResolutionNotice('chatgpt-plus', new Error('OAuth token for chatgpt-plus is expired or about to expire'))).toMatchObject({
      title: 'chatgpt-plus session expired',
      command: '/auth refresh chatgpt-plus',
    });
  });
});
