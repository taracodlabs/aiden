/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Bounded read-only egress and hostile artifact validation for A2A.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { scrubString } from '../logger/redact';

const DEFAULT_INPUT_BYTES = 256 * 1024;
const DEFAULT_ARTIFACT_BYTES = 4 * 1024 * 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INJECTION = /ignore (?:all |the )?(?:previous|prior) instructions|system prompt|developer message|execute (?:this|the) command|reveal (?:secrets|credentials)/i;

export interface BoundedReadOnlyPayload {
  serialized: string;
  byteLength: number;
  capabilities: string[];
  mutationAllowed: false;
}

export function buildBoundedReadOnlyPayload(input: {
  objective: string;
  data: unknown;
  requestedCapabilities: string[];
  maxBytes?: number;
}): BoundedReadOnlyPayload {
  const capabilities = [...new Set(input.requestedCapabilities)]
    .filter((value) => /^read:[a-z0-9._-]+$/i.test(value))
    .slice(0, 32);
  if (capabilities.length !== input.requestedCapabilities.length) {
    throw new Error('A2A v4.27 accepts only explicit read capabilities');
  }
  const serialized = scrubString(JSON.stringify({
    objective: input.objective.slice(0, 8_192),
    data: input.data,
    capabilities,
    mutationAllowed: false,
  }));
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > (input.maxBytes ?? DEFAULT_INPUT_BYTES)) throw new Error('A2A read-only request exceeds byte budget');
  return { serialized, byteLength, capabilities, mutationAllowed: false };
}

export interface RemoteArtifactInput {
  artifactKey: string;
  name: string;
  mediaType?: string | null;
  bytes: Buffer;
}

export type RemoteArtifactValidation =
  | {
      accepted: true;
      artifactKey: string;
      safeName: string;
      declaredMediaType: string | null;
      detectedMediaType: 'text/plain' | 'application/json';
      byteLength: number;
      contentDigest: string;
      untrustedText: boolean;
      bytes: Buffer;
    }
  | {
      accepted: false;
      artifactKey: string;
      reason: string;
      byteLength: number;
      contentDigest: string;
    };

function reject(input: RemoteArtifactInput, reason: string): RemoteArtifactValidation {
  return {
    accepted: false,
    artifactKey: input.artifactKey,
    reason,
    byteLength: input.bytes.byteLength,
    contentDigest: createHash('sha256').update(input.bytes).digest('hex'),
  };
}

function safeArtifactName(name: string): string | null {
  if (!name || name.length > 255 || name.includes('\0') || path.isAbsolute(name)) return null;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.includes('/') || normalized === '.' || normalized === '..' || WINDOWS_RESERVED.test(normalized)) return null;
  return normalized;
}

function activeOrExecutable(bytes: Buffer, text: string): boolean {
  if (bytes.subarray(0, 2).toString('ascii') === 'MZ') return true;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true;
  if (bytes.subarray(0, 2).toString('ascii') === 'PK') return true;
  return /^\s*(?:<!doctype\s+html|<html|<svg|<script)/i.test(text);
}

export function validateRemoteArtifact(
  input: RemoteArtifactInput,
  options: { maxBytes?: number } = {},
): RemoteArtifactValidation {
  const digest = createHash('sha256').update(input.bytes).digest('hex');
  if (!input.artifactKey || input.artifactKey.length > 512) return reject(input, 'invalid remote artifact identity');
  if (input.bytes.byteLength > (options.maxBytes ?? DEFAULT_ARTIFACT_BYTES)) return reject(input, 'artifact exceeds byte limit');
  const safeName = safeArtifactName(input.name);
  if (!safeName) return reject(input, 'artifact name is unsafe');
  const text = input.bytes.toString('utf8');
  if (activeOrExecutable(input.bytes, text)) return reject(input, 'active, executable, or archive content is not accepted');

  let detected: 'text/plain' | 'application/json' = 'text/plain';
  if (safeName.toLowerCase().endsWith('.json') || input.mediaType === 'application/json') {
    try { JSON.parse(text); detected = 'application/json'; } catch { return reject(input, 'declared JSON is malformed or mismatched'); }
  }
  const declared = input.mediaType ?? null;
  const allowedDeclared = declared === null || declared === detected
    || (declared === 'text/plain' && detected === 'text/plain');
  if (!allowedDeclared) return reject(input, 'declared media type does not match safe content');
  if (text.includes('\uFFFD')) return reject(input, 'artifact is not valid bounded UTF-8 text');
  return {
    accepted: true,
    artifactKey: input.artifactKey,
    safeName,
    declaredMediaType: declared,
    detectedMediaType: detected,
    byteLength: input.bytes.byteLength,
    contentDigest: digest,
    untrustedText: INJECTION.test(text),
    bytes: Buffer.from(input.bytes),
  };
}
