/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it, vi } from 'vitest';

import { normalizeA2aAgentCard } from '../../../core/v4/a2a/protocol';
import {
  createSdkA2aRemoteClient,
  discoverSdkA2aAgentCard,
} from '../../../core/v4/a2a/sdkClient';
import { buildBoundedReadOnlyPayload } from '../../../core/v4/a2a/security';

const CARD = {
  name: 'SDK fixture', description: 'Controlled JSON-RPC fixture.', version: '1.0.0',
  supportedInterfaces: [{
    url: 'https://fixture.example.test/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '',
  }],
  capabilities: { streaming: false, pushNotifications: false, extensions: [] },
  securitySchemes: {}, securityRequirements: [], defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'], signatures: [],
  skills: [{
    id: 'read', name: 'Read', description: 'Read bounded input.', tags: ['read-only'], examples: [],
    inputModes: ['application/json'], outputModes: ['application/json'], securityRequirements: [],
  }],
};

const PAYLOAD = buildBoundedReadOnlyPayload({
  objective: 'Read fixture', data: { value: 1 }, requestedCapabilities: ['read:structured-input'],
});

describe('official A2A SDK client boundary', () => {
  it('discovers the pinned Agent Card through the official resolver with bounded same-origin authority', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://fixture.example.test/.well-known/agent-card.json');
      expect(new Headers(init?.headers).get('A2A-Version')).toBe('1.0');
      expect(init?.redirect).toBe('manual');
      return new Response(JSON.stringify(CARD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const card = await discoverSdkA2aAgentCard('https://fixture.example.test', {
      fetchImpl,
      ssrfProtection: { check: async () => ({ blocked: false }) },
    });

    expect(card).toMatchObject({
      name: 'SDK fixture',
      endpoint: 'https://fixture.example.test/a2a',
      protocolVersion: '1.0',
      binding: 'JSONRPC',
      mutationEnabled: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks discovery redirects, oversized cards, and unapproved advertised origins', async () => {
    const safeNetwork = { check: async () => ({ blocked: false }) };
    await expect(discoverSdkA2aAgentCard('https://fixture.example.test', {
      ssrfProtection: safeNetwork,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://redirect.example.test/.well-known/agent-card.json' },
      }),
    })).rejects.toThrow(/redirect.*blocked/i);

    await expect(discoverSdkA2aAgentCard('https://fixture.example.test', {
      ssrfProtection: safeNetwork,
      maxCardBytes: 128,
      fetchImpl: async () => new Response(JSON.stringify(CARD), { status: 200 }),
    })).rejects.toThrow(/response.*limit/i);

    await expect(discoverSdkA2aAgentCard('https://fixture.example.test', {
      ssrfProtection: safeNetwork,
      fetchImpl: async () => new Response(JSON.stringify({
        ...CARD,
        supportedInterfaces: [{
          ...CARD.supportedInterfaces[0],
          url: 'https://unapproved.example.test/a2a',
        }],
      }), { status: 200 }),
    })).rejects.toThrow(/advertised endpoint origin.*approved/i);
  });

  it('uses the pinned v1.0 JSON-RPC wire shape with an explicitly read-only message', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number; method: string; params: { message?: { metadata?: Record<string, unknown> } };
      };
      expect(request.method).toBe('SendMessage');
      expect(request.params.message?.metadata).toMatchObject({ readOnly: true, skillId: 'read' });
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: {
          task: {
            id: 'remote-sdk-1', contextId: 'context-sdk-1',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{
              artifactId: 'artifact-sdk-1', name: 'result.json', description: '',
              parts: [{ data: { ok: true }, mediaType: 'application/json', filename: 'result.json' }],
              metadata: {}, extensions: [],
            }],
            history: [], metadata: {},
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = await createSdkA2aRemoteClient(normalizeA2aAgentCard(CARD), {
      fetchImpl,
      ssrfProtection: { check: async () => ({ blocked: false }) },
    });
    const observed = await client.sendReadOnly({ messageId: 'message-sdk-1', skillId: 'read', payload: PAYLOAD });
    expect(observed).toMatchObject({ remoteTaskId: 'remote-sdk-1', state: 'completed' });
    expect(observed.artifacts).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed before egress when DNS or endpoint policy rejects the target', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = await createSdkA2aRemoteClient(normalizeA2aAgentCard(CARD), {
      fetchImpl,
      ssrfProtection: { check: async () => ({ blocked: true, reason: 'resolved to private address' }) },
    });
    await expect(client.sendReadOnly({ messageId: 'message-blocked', skillId: 'read', payload: PAYLOAD }))
      .rejects.toThrow(/network policy.*private/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks redirects and declared oversized responses instead of following remote endpoint drift', async () => {
    const normalized = normalizeA2aAgentCard(CARD);
    const redirectClient = await createSdkA2aRemoteClient(normalized, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/a2a' } }),
      ssrfProtection: { check: async () => ({ blocked: false }) },
    });
    await expect(redirectClient.sendReadOnly({ messageId: 'message-redirect', skillId: 'read', payload: PAYLOAD }))
      .rejects.toThrow(/redirect.*blocked/i);

    const largeClient = await createSdkA2aRemoteClient(normalized, {
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } }),
      ssrfProtection: { check: async () => ({ blocked: false }) },
    });
    await expect(largeClient.sendReadOnly({ messageId: 'message-large', skillId: 'read', payload: PAYLOAD }))
      .rejects.toThrow(/response.*limit/i);
  });

  it('bounds an undeclared response body while it is consumed', async () => {
    const normalized = normalizeA2aAgentCard(CARD);
    const client = await createSdkA2aRemoteClient(normalized, {
      maxResponseBytes: 512,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: {
            task: {
              id: 'remote-undeclared-large', contextId: 'context-undeclared-large',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [{
                artifactId: 'large-artifact', name: 'large.txt', description: '',
                parts: [{ text: 'x'.repeat(2_048), mediaType: 'text/plain', filename: 'large.txt' }],
                metadata: {}, extensions: [],
              }],
              history: [], metadata: {},
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      ssrfProtection: { check: async () => ({ blocked: false }) },
    });

    await expect(client.sendReadOnly({ messageId: 'message-undeclared-large', skillId: 'read', payload: PAYLOAD }))
      .rejects.toThrow(/response.*limit/i);
  });

  it('rejects excessive remote artifact parts before projecting them locally', async () => {
    const normalized = normalizeA2aAgentCard(CARD);
    const client = await createSdkA2aRemoteClient(normalized, {
      maxArtifactParts: 2,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: {
            task: {
              id: 'remote-many-parts', contextId: 'context-many-parts',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [{
                artifactId: 'many-parts', name: 'result.txt', description: '',
                parts: [
                  { text: 'one', mediaType: 'text/plain', filename: 'one.txt' },
                  { text: 'two', mediaType: 'text/plain', filename: 'two.txt' },
                  { text: 'three', mediaType: 'text/plain', filename: 'three.txt' },
                ],
                metadata: {}, extensions: [],
              }],
              history: [], metadata: {},
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      ssrfProtection: { check: async () => ({ blocked: false }) },
    });

    await expect(client.sendReadOnly({ messageId: 'message-many-parts', skillId: 'read', payload: PAYLOAD }))
      .rejects.toThrow(/artifact part.*limit/i);
  });
});
