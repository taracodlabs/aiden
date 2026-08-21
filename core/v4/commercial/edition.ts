/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type ProductEdition = 'community' | 'pro' | 'team' | 'enterprise';

export const COMMERCIAL_CAPABILITIES = [
  'automation.create',
  'automation.unlimited',
  'presence.active',
  'learning.enabled',
  'relay.remote',
  'workflow.premium',
  'team.shared',
] as const;

export type CommercialCapability = (typeof COMMERCIAL_CAPABILITIES)[number];

/** Safety and trust capabilities are never commercial gates. */
export const ALWAYS_AVAILABLE_CAPABILITIES = [
  'safety.truthful_failure',
  'safety.cancellation',
  'safety.approvals',
  'safety.protected_paths',
  'safety.evidence',
  'safety.verification',
  'safety.proof',
  'safety.data_export',
  'safety.security_updates',
] as const;

export type SafetyCapability = (typeof ALWAYS_AVAILABLE_CAPABILITIES)[number];
export type ProductCapability = CommercialCapability | SafetyCapability;

export interface EditionSnapshot {
  edition: ProductEdition;
  grants: readonly CommercialCapability[];
}

export class EditionAuthority {
  private readonly grants: ReadonlySet<string>;

  constructor(readonly snapshot: EditionSnapshot) {
    this.grants = new Set(snapshot.grants);
  }

  can(capability: ProductCapability | string): boolean {
    if ((ALWAYS_AVAILABLE_CAPABILITIES as readonly string[]).includes(capability)) return true;
    if (!(COMMERCIAL_CAPABILITIES as readonly string[]).includes(capability)) return false;
    return this.grants.has(capability);
  }
}

