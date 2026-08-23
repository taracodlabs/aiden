/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ProductEdition = 'community' | 'pro' | 'team' | 'enterprise';

export const COMMERCIAL_CAPABILITIES = [
  'automation.create',
  'automation.unlimited',
  'presence.active',
  'learning.enabled',
  'capability.sdk',
  'skill.intelligence',
  'mcp.external',
  'a2a.preview',
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

export function buildEditionAuthority(edition: ProductEdition): EditionAuthority {
  return new EditionAuthority({
    edition,
    grants: edition === 'community' ? [] : [...COMMERCIAL_CAPABILITIES],
  });
}

/** Resolve the installed build edition from the authoritative package manifest. */
export function detectProductEdition(startDirectory: string = __dirname): ProductEdition {
  let directory = startDirectory;
  for (let depth = 0; depth < 7; depth += 1) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; private?: boolean };
        if (parsed.name === 'aiden-runtime') return parsed.private === true ? 'pro' : 'community';
      } catch {
        // Keep walking until the installed Aiden manifest is found.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return 'community';
}

