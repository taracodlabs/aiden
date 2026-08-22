/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import {
  CAPABILITY_PROTOCOL_VERSION,
  type CapabilityIdentity,
  type ChildCapabilityMessage,
  type HostCapabilityMessage,
} from './types';

const CHILD_TYPES = new Set(['HELLO', 'BROKER_REQUEST', 'PROGRESS', 'EVIDENCE_CLAIM', 'RESULT', 'ERROR']);
const TERMINAL_TYPES = new Set(['RESULT', 'ERROR']);
const encoder = new TextEncoder();
const BROKER_OPERATIONS = new Set(['filesystem.read', 'filesystem.list', 'filesystem.write', 'artifact.create']);
const BASE_FIELDS = ['type', 'sequence', 'invocationId', 'identity'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identityEquals(left: unknown, right: CapabilityIdentity): boolean {
  if (!record(left)) return false;
  return left.capabilityId === right.capabilityId
    && left.version === right.version
    && left.manifestVersion === right.manifestVersion
    && left.protocolVersion === right.protocolVersion
    && left.digest === right.digest;
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const allowed = new Set([...BASE_FIELDS, ...fields]);
  return Object.keys(value).every((field) => allowed.has(field));
}

function validChildShape(value: Record<string, unknown>): boolean {
  switch (value.type) {
    case 'HELLO':
      return onlyFields(value, ['protocolVersion', 'nonce'])
        && Number.isSafeInteger(value.protocolVersion)
        && typeof value.nonce === 'string' && value.nonce.length >= 12 && value.nonce.length <= 256;
    case 'BROKER_REQUEST':
      return onlyFields(value, ['requestId', 'operation', 'resource', 'arguments', 'effectId'])
        && typeof value.requestId === 'string' && /^request_[A-Za-z0-9_.:-]{1,120}$/u.test(value.requestId)
        && typeof value.operation === 'string' && BROKER_OPERATIONS.has(value.operation)
        && typeof value.resource === 'string' && value.resource.length > 0 && value.resource.length <= 4_096
        && record(value.arguments)
        && (value.effectId === undefined || typeof value.effectId === 'string');
    case 'PROGRESS':
      return onlyFields(value, ['message'])
        && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 500;
    case 'EVIDENCE_CLAIM':
      return onlyFields(value, ['claimId', 'category', 'statement', 'references'])
        && typeof value.claimId === 'string' && /^claim_[A-Za-z0-9_.:-]{1,120}$/u.test(value.claimId)
        && typeof value.category === 'string' && value.category.length > 0 && value.category.length <= 100
        && typeof value.statement === 'string' && value.statement.length > 0 && value.statement.length <= 2_000
        && (value.references === undefined || (Array.isArray(value.references)
          && value.references.length <= 32
          && value.references.every((item) => typeof item === 'string' && item.length <= 512)));
    case 'RESULT':
      return onlyFields(value, ['output']) && 'output' in value;
    case 'ERROR':
      return onlyFields(value, ['code', 'message', 'outcome'])
        && typeof value.code === 'string' && /^[a-z0-9_.-]{1,100}$/u.test(value.code)
        && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 2_000
        && (value.outcome === 'failed' || value.outcome === 'unknown');
    default:
      return false;
  }
}

export type ProtocolRejectCode =
  | 'message_too_large'
  | 'message_flood'
  | 'malformed_json'
  | 'invalid_message'
  | 'unexpected_message'
  | 'protocol_mismatch'
  | 'identity_mismatch'
  | 'invocation_mismatch'
  | 'nonce_mismatch'
  | 'stale_sequence'
  | 'terminal';

export type ProtocolAcceptResult =
  | { ok: true; message: ChildCapabilityMessage }
  | { ok: false; code: ProtocolRejectCode; error: string };

export class CapabilityProtocolGuard {
  private messageCount = 0;
  private nextSequence = 0;
  private helloAccepted = false;
  private terminal = false;

  constructor(private readonly options: {
    identity: CapabilityIdentity;
    invocationId: string;
    nonce: string;
    maxMessageBytes: number;
    maxMessages: number;
  }) {}

  accept(line: string): ProtocolAcceptResult {
    if (this.terminal) return { ok: false, code: 'terminal', error: 'protocol already reached terminal state' };
    if (encoder.encode(line).byteLength > this.options.maxMessageBytes) {
      return { ok: false, code: 'message_too_large', error: 'capability message exceeds byte limit' };
    }
    if (this.messageCount >= this.options.maxMessages) {
      return { ok: false, code: 'message_flood', error: 'capability message count exceeds limit' };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { return { ok: false, code: 'malformed_json', error: 'capability message is not valid JSON' }; }
    if (!record(parsed) || typeof parsed.type !== 'string' || !CHILD_TYPES.has(parsed.type)) {
      return { ok: false, code: 'invalid_message', error: 'capability message type is invalid' };
    }
    if (!validChildShape(parsed)) {
      return { ok: false, code: 'invalid_message', error: 'capability message does not match its strict schema' };
    }
    this.messageCount += 1;
    if (parsed.invocationId !== this.options.invocationId) {
      return { ok: false, code: 'invocation_mismatch', error: 'capability invocation identity mismatch' };
    }
    if (!identityEquals(parsed.identity, this.options.identity)) {
      return { ok: false, code: 'identity_mismatch', error: 'capability immutable identity mismatch' };
    }
    if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence !== this.nextSequence) {
      return { ok: false, code: 'stale_sequence', error: 'capability message sequence is stale or out of order' };
    }
    if (!this.helloAccepted) {
      if (parsed.type !== 'HELLO') return { ok: false, code: 'unexpected_message', error: 'HELLO must be the first child message' };
      if (parsed.protocolVersion !== CAPABILITY_PROTOCOL_VERSION) return { ok: false, code: 'protocol_mismatch', error: 'capability protocol version mismatch' };
      if (parsed.nonce !== this.options.nonce) return { ok: false, code: 'nonce_mismatch', error: 'capability handshake nonce mismatch' };
      this.helloAccepted = true;
    } else if (parsed.type === 'HELLO') {
      return { ok: false, code: 'unexpected_message', error: 'duplicate capability handshake' };
    }
    this.nextSequence += 1;
    if (TERMINAL_TYPES.has(parsed.type)) this.terminal = true;
    return { ok: true, message: parsed as unknown as ChildCapabilityMessage };
  }
}

export function encodeCapabilityMessage(message: HostCapabilityMessage, maxMessageBytes: number): string {
  const line = `${JSON.stringify(message)}\n`;
  if (encoder.encode(line).byteLength > maxMessageBytes) throw new Error('Host capability message exceeds byte limit');
  return line;
}
