/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * This file is mounted read-only into the capability container. Keep it free
 * from Aiden host imports: the child receives protocol data, never host
 * authorities.
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Identity = {
  capabilityId: string; version: string; manifestVersion: number; protocolVersion: number; digest: string;
};
type HostMessage = {
  type: string; sequence: number; invocationId: string; identity: Identity;
  nonce?: string; protocolVersion?: number; tool?: string; input?: JsonValue;
  requestId?: string; ok?: boolean; value?: JsonValue; error?: { code: string; message: string }; reason?: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing capability runtime configuration: ${name}`);
  return value;
}

const identity = JSON.parse(Buffer.from(requiredEnvironment('AIDEN_CAPABILITY_IDENTITY_B64'), 'base64url').toString('utf8')) as Identity;
const invocationId = requiredEnvironment('AIDEN_CAPABILITY_INVOCATION_ID');
const nonce = requiredEnvironment('AIDEN_CAPABILITY_NONCE');
const entrypoint = requiredEnvironment('AIDEN_CAPABILITY_ENTRYPOINT');
const maxMessageBytes = Math.max(1_024, Number(process.env.AIDEN_CAPABILITY_MAX_MESSAGE_BYTES ?? 32_768));
let childSequence = 0;
let hostSequence = 0;
let invoked = false;
let terminal = false;
const controller = new AbortController();
const pending = new Map<string, { resolve(value: JsonValue): void; reject(error: Error): void }>();

function sameIdentity(value: Identity): boolean {
  return value?.capabilityId === identity.capabilityId
    && value.version === identity.version
    && value.manifestVersion === identity.manifestVersion
    && value.protocolVersion === identity.protocolVersion
    && value.digest === identity.digest;
}

function send(type: string, fields: Record<string, unknown> = {}): void {
  if (terminal && type !== 'ERROR') return;
  const line = `${JSON.stringify({ type, sequence: childSequence++, invocationId, identity, ...fields })}\n`;
  if (Buffer.byteLength(line, 'utf8') > maxMessageBytes) throw new Error('Capability child message exceeds byte limit');
  process.stdout.write(line);
}

function terminateError(code: string, message: string, outcome: 'failed' | 'unknown' = 'failed'): void {
  if (terminal) return;
  send('ERROR', { code, message: message.slice(0, 2_000), outcome });
  terminal = true;
  process.exitCode = 1;
}

async function invoke(tool: string, input: JsonValue): Promise<void> {
  try {
    // Keep native dynamic import when this trusted runner is compiled to
    // CommonJS. TypeScript otherwise rewrites import() to require(), and
    // require() cannot load a file: URL inside the container.
    const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;
    const loaded = await importModule(pathToFileURL(entrypoint).href);
    const moduleValue = (loaded.default ?? loaded) as { tools?: Record<string, unknown> };
    const implementation = moduleValue.tools?.[tool];
    if (typeof implementation !== 'function') throw new Error(`Capability tool is not implemented: ${tool}`);
    const output = await (implementation as (value: JsonValue, context: unknown) => Promise<JsonValue>)(input, {
      invocationId,
      signal: controller.signal,
      progress(message: string) {
        if (typeof message !== 'string' || message.length === 0 || message.length > 500) throw new Error('Progress message is invalid');
        send('PROGRESS', { message });
      },
      claimEvidence(claim: { claimId: string; category: string; statement: string; references?: string[] }) {
        if (!claim || typeof claim.claimId !== 'string' || typeof claim.category !== 'string' || typeof claim.statement !== 'string') {
          throw new Error('Evidence claim is invalid');
        }
        send('EVIDENCE_CLAIM', {
          claimId: claim.claimId, category: claim.category, statement: claim.statement,
          ...(claim.references ? { references: claim.references } : {}),
        });
      },
      broker(request: { requestId: string; operation: string; resource: string; arguments?: Record<string, JsonValue> }) {
        if (!request || typeof request.requestId !== 'string' || pending.has(request.requestId)) {
          return Promise.reject(new Error('Broker request identity is invalid or already pending'));
        }
        return new Promise<JsonValue>((resolve, reject) => {
          pending.set(request.requestId, { resolve, reject });
          send('BROKER_REQUEST', {
            requestId: request.requestId, operation: request.operation, resource: request.resource,
            arguments: request.arguments ?? {},
          });
        });
      },
    });
    if (controller.signal.aborted) throw new Error('Capability invocation was cancelled');
    send('RESULT', { output: output ?? null });
    terminal = true;
  } catch (error) {
    terminateError(controller.signal.aborted ? 'cancelled' : 'execution_failed', error instanceof Error ? error.message : String(error));
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error('Capability invocation terminated'));
    pending.clear();
    setTimeout(() => process.stdin.destroy(), 0).unref?.();
  }
}

send('HELLO', { protocolVersion: identity.protocolVersion, nonce });

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on('line', (line) => {
  if (terminal) return;
  if (Buffer.byteLength(line, 'utf8') > maxMessageBytes) return terminateError('host_message_too_large', 'Host message exceeds byte limit');
  let message: HostMessage;
  try { message = JSON.parse(line) as HostMessage; }
  catch { return terminateError('malformed_host_message', 'Host message is not valid JSON'); }
  if (message.invocationId !== invocationId || !sameIdentity(message.identity) || message.sequence !== hostSequence++) {
    return terminateError('host_identity_mismatch', 'Host protocol identity or sequence mismatch');
  }
  if (message.type === 'HELLO') {
    if (message.nonce !== nonce || message.protocolVersion !== identity.protocolVersion || hostSequence !== 1) {
      terminateError('host_handshake_mismatch', 'Host handshake mismatch');
    }
    return;
  }
  if (message.type === 'INVOKE') {
    if (invoked || hostSequence !== 2 || typeof message.tool !== 'string') return terminateError('duplicate_invoke', 'Capability invocation is invalid');
    invoked = true;
    void invoke(message.tool, message.input ?? null);
    return;
  }
  if (message.type === 'BROKER_RESULT' && typeof message.requestId === 'string') {
    const waiter = pending.get(message.requestId);
    if (!waiter) return terminateError('unexpected_broker_result', 'Broker result has no pending request');
    pending.delete(message.requestId);
    if (message.ok) waiter.resolve(message.value ?? null);
    else waiter.reject(new Error(message.error?.message ?? 'Broker request denied'));
    return;
  }
  if (message.type === 'CANCEL') {
    controller.abort(message.reason ?? 'cancelled');
    return;
  }
  if (message.type === 'SHUTDOWN') {
    controller.abort('shutdown');
    lines.close();
    return;
  }
  terminateError('unexpected_host_message', `Unexpected host message: ${message.type}`);
});

lines.on('close', () => {
  if (!terminal) terminateError('host_disconnected', 'Host protocol stream closed', invoked ? 'unknown' : 'failed');
});

process.on('uncaughtException', (error) => terminateError('uncaught_exception', error.message, invoked ? 'unknown' : 'failed'));
process.on('unhandledRejection', (error) => terminateError('unhandled_rejection', error instanceof Error ? error.message : String(error), invoked ? 'unknown' : 'failed'));
