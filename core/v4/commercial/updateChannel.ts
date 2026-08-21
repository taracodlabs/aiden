/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ProductEdition } from './edition';
import { verifyEd25519Payload } from './signedPayload';

export type ProductUpdateChannel = 'community-stable' | 'pro-stable' | 'pro-preview';

export interface UpdateMetadata {
  version: string;
  edition: ProductEdition;
  channel: ProductUpdateChannel;
  artifact: string;
  sha256: string;
  minimumRuntime: string;
  releaseNotesUrl: string;
}

export interface SignedUpdateMetadata {
  metadata: UpdateMetadata;
  signature: string;
}

export function verifyUpdateMetadata(input: {
  signed: SignedUpdateMetadata;
  expectedChannel: ProductUpdateChannel;
  publicKeyPem: string;
}): { ok: true; metadata: UpdateMetadata } | { ok: false; reason: string } {
  const { metadata, signature } = input.signed;
  if (metadata.channel !== input.expectedChannel) return { ok: false, reason: 'wrong update channel' };
  if (!/^[a-f0-9]{64}$/i.test(metadata.sha256)) return { ok: false, reason: 'invalid artifact digest' };
  if (!verifyEd25519Payload(metadata, signature, input.publicKeyPem)) return { ok: false, reason: 'invalid update signature' };
  return { ok: true, metadata };
}

