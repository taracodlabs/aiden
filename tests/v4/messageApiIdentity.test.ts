import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MessageApiAdapter } from '../../providers/v4/messageApiAdapter';
import { VERSION } from '../../core/version';
import { getProviderEntry } from '../../providers/v4/registry';
import { findModel } from '../../providers/v4/modelCatalog';
import { PRO_PLUGIN_DIRS } from '../../cli/v4/auth/loadProvider';

/**
 * Teeth for Slice 1 — the CLI-impersonation removal. The audit proved the
 * impersonation fingerprint (a foreign-CLI user-agent + `x-app: cli`) leaked
 * onto the plain API-key path, so these assertions run against the API-key
 * adapter, not an OAuth one. `as unknown` on the options lets one test compile
 * both before and after the `authMode` field is removed, so the RED is a real
 * assertion failure on today's code, not a type error.
 */
function makeResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const apiKeyOpts = {
  apiKey: 'sk-ant-test',
  model: 'claude-haiku-4-5-20251001',
  providerName: 'anthropic',
  maxRetries: 1,
} as unknown as ConstructorParameters<typeof MessageApiAdapter>[0];

const userMsg = (content: string): { role: 'user'; content: string } => ({ role: 'user', content });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Anthropic API-key requests carry an honest Aiden identity (no CLI impersonation)', () => {
  it('sends an honest, dynamic user-agent: aiden/<version>', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new MessageApiAdapter(apiKeyOpts).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['user-agent']).toBe(`aiden/${VERSION}`);
    expect(headers['user-agent']).toMatch(/^aiden\/\d+\.\d+\.\d+/);
  });

  it('carries no x-app: cli billing fingerprint', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new MessageApiAdapter(apiKeyOpts).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-app']).toBeUndefined();
  });

  // Full wire-header capture — the deterministic half of the P0 smoke. Asserts
  // exactly what goes on the wire, which a bundle string-grep cannot prove.
  it('full header capture: exact honest identity + no impersonation fingerprint', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new MessageApiAdapter(apiKeyOpts).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['user-agent']).toBe(`aiden/${VERSION}`);   // dynamic, from core/version
    expect(headers['x-app']).toBeUndefined();                  // no billing fingerprint
    expect(headers['anthropic-beta']).toBeUndefined();         // no OAuth beta flags
    expect(headers['x-api-key']).toBe('sk-ant-test');          // API-key auth
    expect(headers['Authorization']).toBeUndefined();          // never a bearer OAuth token
    // No foreign-CLI fingerprint substring in ANY header value (explicit needle).
    const allValues = Object.values(headers).join('\n').toLowerCase();
    expect(allValues).not.toContain('claude-cli');
  });

  it('does not inject a spoofed CLI identity block — system stays a flat string', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new MessageApiAdapter(apiKeyOpts).call({
      messages: [{ role: 'system', content: 'be brief' }, userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // A flat string exactly equal to the caller's prompt proves no identity
    // prefix block was injected ahead of it.
    expect(typeof body.system).toBe('string');
    expect(body.system).toBe('be brief');
  });

  it('regression: still calls tools and keeps tool names raw (no mcp_ prefix)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } }],
        stop_reason: 'tool_use',
      }),
    );
    const result = await new MessageApiAdapter(apiKeyOpts).call({
      messages: [userMsg('go')],
      tools: [{ name: 'web_search', description: 's', inputSchema: { type: 'object', properties: {} } }],
    });
    expect(result.toolCalls[0].name).toBe('web_search');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools[0].name).toBe('web_search');
  });

  it('regression: still streams delta → done on the API-key path', async () => {
    const sse =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    fetchMock.mockResolvedValueOnce(
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const evts: Array<{ type: string }> = [];
    for await (const e of new MessageApiAdapter(apiKeyOpts).callStream({ messages: [userMsg('hi')], tools: [] })) {
      evts.push(e);
    }
    expect(evts.some((e) => e.type === 'delta')).toBe(true);
    expect(evts[evts.length - 1].type).toBe('done');
  });

  it('regression: still reports a 401 as a fail-fast error', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('unauthorized', { status: 401 }));
    await expect(
      new MessageApiAdapter(apiKeyOpts).call({ messages: [userMsg('hi')], tools: [] }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('The removed subscription-OAuth provider is gone (unresolvable + not offered)', () => {
  it('claude-pro is not a resolvable provider', () => {
    expect(getProviderEntry('claude-pro')).toBeUndefined();
  });

  it('claude-pro has no models in the catalog', () => {
    expect(findModel('claude-pro', 'claude-opus-4-7')).toBeUndefined();
  });

  it('the OAuth picker / /auth do not offer claude-pro, but chatgpt-plus is untouched', () => {
    expect(PRO_PLUGIN_DIRS['claude-pro']).toBeUndefined();
    expect(PRO_PLUGIN_DIRS['chatgpt-plus']).toBe('aiden-plugin-chatgpt-plus');
  });
});

describe('The legitimate Aiden/Taracod product identity is preserved (not scrubbed)', () => {
  const repoRoot = join(__dirname, '..', '..');
  it('defaultSoul.ts still identifies Aiden as built by Taracod', () => {
    const soul = readFileSync(join(repoRoot, 'cli', 'v4', 'defaultSoul.ts'), 'utf8');
    expect(soul).toMatch(/\bAiden\b/);
    expect(soul).toMatch(/Taracod/);
  });
});
