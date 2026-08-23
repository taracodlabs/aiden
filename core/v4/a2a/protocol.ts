/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Pinned, binding-neutral A2A card boundary. Agent Cards advertise remote
 * capability; they never grant local authority or terminalize a local Job.
 */

import { createHash } from 'node:crypto';
import { AgentCard, verifyAgentCardSignature } from '@a2a-js/sdk';

export const A2A_PROTOCOL_VERSION = '1.0' as const;
export const A2A_JSONRPC_BINDING = 'JSONRPC' as const;

const MAX_CARD_BYTES = 256 * 1024;
const MAX_SKILLS = 128;
const MAX_STRING = 16 * 1024;
const MAX_COLLECTION = 512;
const MAX_DEPTH = 20;

export interface NormalizedA2aSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

export interface NormalizedA2aAgentCard {
  name: string;
  description: string;
  agentVersion: string;
  endpoint: string;
  binding: typeof A2A_JSONRPC_BINDING;
  protocolVersion: typeof A2A_PROTOCOL_VERSION;
  streaming: boolean;
  pushNotifications: boolean;
  skills: NormalizedA2aSkill[];
  securityRequirements: unknown[];
  signatureState: 'unsigned' | 'present_unverified' | 'verified';
  identityKeyDigest: string | null;
  cardDigest: string;
  mutationEnabled: false;
  raw: Record<string, unknown>;
}

export interface NormalizeA2aAgentCardOptions {
  /** Explicitly limited to controlled local conformance fixtures. */
  allowLoopbackHttp?: boolean;
  /** Set only after an independent JWS verifier succeeds. */
  verifiedIdentityKeyDigest?: string;
}

type AgentCardKeyResolver = Parameters<typeof verifyAgentCardSignature>[0];
export type A2aAgentCardVerificationKey = Awaited<ReturnType<AgentCardKeyResolver>>;

export interface A2aAgentCardVerificationKeyRecord {
  key: A2aAgentCardVerificationKey;
  /** SHA-256 of the independently trusted public-key representation. */
  keyDigest: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

export function digestA2aValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function assertBounded(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new Error('A2A Agent Card exceeds maximum nesting depth');
  if (typeof value === 'string' && value.length > MAX_STRING) throw new Error('A2A Agent Card string is too large');
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION) throw new Error('A2A Agent Card collection is too large');
    value.forEach((entry) => assertBounded(entry, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION) throw new Error('A2A Agent Card object is too large');
    entries.forEach(([key, entry]) => {
      if (key.length > 256) throw new Error('A2A Agent Card key is too large');
      assertBounded(entry, depth + 1);
    });
  }
}

function isLoopback(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function isPrivateOrMetadata(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopback(h) || h === '0.0.0.0' || h === '::' || h.endsWith('.local')) return true;
  const octets = h.split('.').map(Number);
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 0;
  }
  return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
}

export function validateA2aEndpoint(raw: string, allowLoopbackHttp = false): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('A2A Agent Card endpoint is malformed'); }
  if (url.username || url.password) throw new Error('A2A endpoint must not contain credentials');
  if (url.protocol !== 'https:') {
    if (!(allowLoopbackHttp && url.protocol === 'http:' && isLoopback(url.hostname))) {
      throw new Error('A2A endpoint must use HTTPS (HTTP is limited to explicit loopback fixtures)');
    }
  }
  if (isPrivateOrMetadata(url.hostname) && !(allowLoopbackHttp && isLoopback(url.hostname))) {
    throw new Error('A2A endpoint resolves to a private, local, or metadata address');
  }
  url.hash = '';
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  return url.toString().replace(/\/$/, '');
}

function strings(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.slice(0, 512));
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`A2A Agent Card ${key} is required`);
  return value;
}

export function normalizeA2aAgentCard(
  value: unknown,
  options: NormalizeA2aAgentCardOptions = {},
): NormalizedA2aAgentCard {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CARD_BYTES) throw new Error('A2A Agent Card exceeds size limit');
  assertBounded(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A2A Agent Card must be an object');
  const card = value as Record<string, unknown>;
  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const selected = interfaces.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const record = candidate as Record<string, unknown>;
    return String(record.protocolBinding ?? '').toUpperCase() === A2A_JSONRPC_BINDING
      && record.protocolVersion === A2A_PROTOCOL_VERSION;
  }) as Record<string, unknown> | undefined;
  if (!selected) {
    const version = interfaces.find((candidate) => candidate && typeof candidate === 'object'
      && String((candidate as Record<string, unknown>).protocolBinding ?? '').toUpperCase() === A2A_JSONRPC_BINDING);
    if (version) throw new Error(`Unsupported A2A protocol version: ${String((version as Record<string, unknown>).protocolVersion)}`);
    throw new Error('A2A Agent Card does not advertise the required JSONRPC binding');
  }
  const endpoint = validateA2aEndpoint(requiredString(selected, 'url'), options.allowLoopbackHttp === true);
  const rawSkills = Array.isArray(card.skills) ? card.skills : [];
  if (rawSkills.length > MAX_SKILLS) throw new Error('A2A Agent Card advertises too many skills');
  const skills = rawSkills.map((candidate): NormalizedA2aSkill => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('A2A Agent Card contains a malformed skill');
    }
    const skill = candidate as Record<string, unknown>;
    return {
      id: requiredString(skill, 'id').slice(0, 256),
      name: requiredString(skill, 'name').slice(0, 512),
      description: typeof skill.description === 'string' ? skill.description.slice(0, 4_096) : '',
      tags: strings(skill.tags),
      inputModes: strings(skill.inputModes),
      outputModes: strings(skill.outputModes),
    };
  });
  const signatures = Array.isArray(card.signatures) ? card.signatures : [];
  const verifiedDigest = options.verifiedIdentityKeyDigest;
  if (verifiedDigest && !/^[a-f0-9]{64}$/i.test(verifiedDigest)) throw new Error('A2A verified identity key digest is invalid');
  const capabilities = card.capabilities && typeof card.capabilities === 'object'
    ? card.capabilities as Record<string, unknown>
    : {};
  return {
    name: requiredString(card, 'name').slice(0, 512),
    description: typeof card.description === 'string' ? card.description.slice(0, 8_192) : '',
    agentVersion: requiredString(card, 'version').slice(0, 128),
    endpoint,
    binding: A2A_JSONRPC_BINDING,
    protocolVersion: A2A_PROTOCOL_VERSION,
    streaming: capabilities.streaming === true,
    pushNotifications: capabilities.pushNotifications === true,
    skills,
    securityRequirements: Array.isArray(card.securityRequirements) ? card.securityRequirements.slice(0, 64) : [],
    signatureState: verifiedDigest ? 'verified' : signatures.length > 0 ? 'present_unverified' : 'unsigned',
    identityKeyDigest: verifiedDigest ?? null,
    cardDigest: digestA2aValue(card),
    mutationEnabled: false,
    raw: card,
  };
}

/**
 * Verify one signed card through the official A2A SDK without fetching a key
 * from an untrusted `jku`. The caller owns key retrieval and trust policy; this
 * boundary only accepts the exact resolved key and binds its digest into the
 * normalized external identity.
 */
export async function verifyAndNormalizeA2aAgentCard(
  value: unknown,
  resolveTrustedKey: (kid: string, jku?: string) => Promise<A2aAgentCardVerificationKeyRecord>,
  options: Omit<NormalizeA2aAgentCardOptions, 'verifiedIdentityKeyDigest'> = {},
): Promise<NormalizedA2aAgentCard> {
  const card = AgentCard.fromJSON(value);
  if (card.signatures.length !== 1) {
    throw new Error('A2A v4.27 signed trust requires exactly one Agent Card signature');
  }
  let resolvedDigest: string | null = null;
  const verifier = verifyAgentCardSignature(async (kid, jku) => {
    const resolved = await resolveTrustedKey(kid, jku);
    if (!/^[a-f0-9]{64}$/i.test(resolved.keyDigest)) {
      throw new Error('A2A trusted Agent Card key digest is invalid');
    }
    resolvedDigest = resolved.keyDigest.toLowerCase();
    return resolved.key;
  });
  await verifier(card);
  if (!resolvedDigest) throw new Error('A2A Agent Card signature did not resolve a trusted key');
  return normalizeA2aAgentCard(AgentCard.toJSON(card), {
    ...options,
    verifiedIdentityKeyDigest: resolvedDigest,
  });
}
