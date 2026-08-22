/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_PROTOCOL_VERSION,
  CapabilityProtocolGuard,
  encodeCapabilityMessage,
  type CapabilityIdentity,
} from '../../../packages/capability-sdk/src';

const identity: CapabilityIdentity = {
  capabilityId: 'dev.taracod.workspace-summary',
  version: '1.0.0',
  manifestVersion: 1,
  protocolVersion: CAPABILITY_PROTOCOL_VERSION,
  digest: `sha256:${'b'.repeat(64)}`,
};

describe('Capability IPC contract', () => {
  it('accepts one exact handshake and monotonic child sequence', () => {
    const guard = new CapabilityProtocolGuard({
      identity,
      invocationId: 'inv_01JTEST000000000000000000',
      nonce: 'nonce_0123456789abcdef',
      maxMessageBytes: 4096,
      maxMessages: 8,
    });
    expect(guard.accept(JSON.stringify({
      type: 'HELLO', sequence: 0,
      invocationId: 'inv_01JTEST000000000000000000', identity,
      nonce: 'nonce_0123456789abcdef', protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    }))).toMatchObject({ ok: true });
    expect(guard.accept(JSON.stringify({
      type: 'PROGRESS', sequence: 1,
      invocationId: 'inv_01JTEST000000000000000000', identity,
      message: 'Reading granted files',
    }))).toMatchObject({ ok: true });
  });

  it.each([
    ['wrong protocol', { protocolVersion: 99 }],
    ['wrong invocation', { invocationId: 'inv_wrong' }],
    ['wrong digest', { identity: { ...identity, digest: `sha256:${'c'.repeat(64)}` } }],
  ])('rejects %s during handshake', (_name, replacement) => {
    const guard = new CapabilityProtocolGuard({
      identity, invocationId: 'inv_exact', nonce: 'nonce_exact_123456', maxMessageBytes: 4096, maxMessages: 8,
    });
    const message = {
      type: 'HELLO', sequence: 0, invocationId: 'inv_exact', identity,
      nonce: 'nonce_exact_123456', protocolVersion: CAPABILITY_PROTOCOL_VERSION,
      ...replacement,
    };
    expect(guard.accept(JSON.stringify(message))).toMatchObject({ ok: false });
  });

  it('rejects malformed, oversized, flooded and stale-sequence messages', () => {
    const guard = new CapabilityProtocolGuard({
      identity, invocationId: 'inv_exact', nonce: 'nonce_exact_123456', maxMessageBytes: 512, maxMessages: 2,
    });
    expect(guard.accept('{bad json')).toMatchObject({ ok: false, code: 'malformed_json' });
    expect(guard.accept('x'.repeat(513))).toMatchObject({ ok: false, code: 'message_too_large' });
    expect(guard.accept(JSON.stringify({
      type: 'HELLO', sequence: 0, invocationId: 'inv_exact', identity,
      nonce: 'nonce_exact_123456', protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    }))).toMatchObject({ ok: true });
    expect(guard.accept(JSON.stringify({
      type: 'PROGRESS', sequence: 1, invocationId: 'inv_exact', identity, message: 'one',
    }))).toMatchObject({ ok: true });
    expect(guard.accept(JSON.stringify({
      type: 'PROGRESS', sequence: 1, invocationId: 'inv_exact', identity, message: 'stale',
    }))).toMatchObject({ ok: false, code: 'message_flood' });
  });

  it('encodes one bounded JSONL frame without exposing host state', () => {
    const line = encodeCapabilityMessage({
      type: 'CANCEL', sequence: 2, invocationId: 'inv_exact', identity, reason: 'user_cancelled',
    }, 4096);
    expect(line.endsWith('\n')).toBe(true);
    expect(line).not.toMatch(/OPENAI|TOKEN|AIDEN_HOME/i);
  });

  it.each([
    ['missing broker resource', { type: 'BROKER_REQUEST', requestId: 'request_1', operation: 'filesystem.read', arguments: {} }],
    ['unknown broker operation', { type: 'BROKER_REQUEST', requestId: 'request_1', operation: 'process.spawn', resource: 'x', arguments: {} }],
    ['giant progress', { type: 'PROGRESS', message: 'x'.repeat(501) }],
    ['invalid evidence references', { type: 'EVIDENCE_CLAIM', claimId: 'claim_1', category: 'observed', statement: 'x', references: [1] }],
    ['unknown field', { type: 'PROGRESS', message: 'valid', hostPath: 'C:/secret' }],
  ])('rejects structurally invalid child message: %s', (_name, body) => {
    const guard = new CapabilityProtocolGuard({
      identity, invocationId: 'inv_exact', nonce: 'nonce_exact_123456', maxMessageBytes: 4096, maxMessages: 8,
    });
    expect(guard.accept(JSON.stringify({
      type: 'HELLO', sequence: 0, invocationId: 'inv_exact', identity,
      nonce: 'nonce_exact_123456', protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    }))).toMatchObject({ ok: true });
    expect(guard.accept(JSON.stringify({
      sequence: 1, invocationId: 'inv_exact', identity, ...body,
    }))).toMatchObject({ ok: false, code: 'invalid_message' });
  });
});
