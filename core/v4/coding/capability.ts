/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type {
  ExternalCodingCapabilitySnapshot,
  ExternalCodingSupportedFeatures,
} from './types';

type CapabilityInput = Omit<ExternalCodingCapabilitySnapshot, 'schemaVersion' | 'capabilityDigest'> & {
  capabilityDigest?: undefined;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,191}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function freezeFeatures(input: ExternalCodingSupportedFeatures): ExternalCodingSupportedFeatures {
  return Object.freeze({ ...input });
}

export function computeExternalCodingCapabilityDigest(
  input: Omit<ExternalCodingCapabilitySnapshot, 'capabilityDigest' | 'capturedAt'>,
): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export function createExternalCodingCapabilitySnapshot(input: CapabilityInput): ExternalCodingCapabilitySnapshot {
  assertIdentifier(input.capabilityId, 'Capability identity');
  assertIdentifier(input.providerId, 'Provider identity');
  if (!input.providerVersion.trim() || !input.protocolVersion.trim()) throw new Error('Provider and protocol versions are required');
  const supportedFeatures = freezeFeatures(input.supportedFeatures);
  const runtimeCompatibility = Object.freeze({
    ...input.runtimeCompatibility,
    platforms: Object.freeze([...new Set(input.runtimeCompatibility.platforms)].sort()),
    ...(input.runtimeCompatibility.architecture
      ? { architecture: Object.freeze([...new Set(input.runtimeCompatibility.architecture)].sort()) }
      : {}),
  });
  const digestInput = {
    schemaVersion: 1 as const,
    capabilityId: input.capabilityId,
    providerId: input.providerId,
    providerVersion: input.providerVersion,
    protocolMode: input.protocolMode,
    protocolVersion: input.protocolVersion,
    supportedFeatures,
    runtimeCompatibility,
  };
  return Object.freeze({
    ...digestInput,
    capabilityDigest: computeExternalCodingCapabilityDigest(digestInput),
    capturedAt: input.capturedAt,
  });
}

