/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from '../paths';
import {
  COMMERCIAL_CAPABILITIES,
  EditionAuthority,
  type CommercialCapability,
  type ProductEdition,
} from './edition';
import { verifyEd25519Payload } from './signedPayload';

export type EntitlementState =
  | 'community'
  | 'trial'
  | 'active'
  | 'grace'
  | 'expired'
  | 'revoked'
  | 'unavailable';

export interface EntitlementClaim {
  product: 'aiden';
  accountId: string;
  edition: ProductEdition;
  capabilities: CommercialCapability[];
  issuedAt: string;
  expiresAt: string;
  offlineUntil?: string;
  deviceBinding?: string;
  trial?: boolean;
  revoked?: boolean;
}

export interface SignedEntitlement {
  claim: EntitlementClaim;
  signature: string;
}

export interface EntitlementSnapshot {
  state: EntitlementState;
  edition: ProductEdition;
  accountId?: string;
  capabilities: CommercialCapability[];
  issuedAt?: string;
  expiresAt?: string;
  offlineUntil?: string;
  reason?: string;
}

export interface EntitlementRefreshProvider {
  refresh(): Promise<SignedEntitlement | null>;
}

export interface EntitlementAuthorityOptions {
  paths: AidenPaths;
  publicKeyPem: string;
  product?: string;
  deviceBinding?: string;
  refreshProvider?: EntitlementRefreshProvider;
  now?: () => Date;
  cacheFile?: string;
}

export class EntitlementAuthority {
  private readonly now: () => Date;
  private readonly cacheFile: string;

  constructor(private readonly options: EntitlementAuthorityOptions) {
    this.now = options.now ?? (() => new Date());
    this.cacheFile = options.cacheFile ?? path.join(options.paths.root, 'commercial', 'entitlement.json');
  }

  async snapshot(): Promise<EntitlementSnapshot> {
    const signed = await this.readCache();
    if (!signed) {
      return { state: 'community', edition: 'community', capabilities: [] };
    }
    return this.evaluate(signed);
  }

  async refresh(): Promise<EntitlementSnapshot> {
    if (!this.options.refreshProvider) {
      const current = await this.snapshot();
      return current.state === 'community'
        ? { ...current, state: 'unavailable', reason: 'entitlement service unavailable' }
        : current;
    }
    try {
      const signed = await this.options.refreshProvider.refresh();
      if (!signed) return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'no entitlement returned' };
      const result = this.evaluate(signed);
      if (!['active', 'trial', 'grace'].includes(result.state)) return result;
      await this.writeCache(signed);
      return result;
    } catch (error) {
      const cached = await this.snapshot();
      if (cached.state === 'active' || cached.state === 'trial' || cached.state === 'grace') return cached;
      return {
        state: 'unavailable', edition: 'community', capabilities: [],
        reason: error instanceof Error ? error.message : 'entitlement service unavailable',
      };
    }
  }

  editionAuthority(snapshot: EntitlementSnapshot): EditionAuthority {
    return new EditionAuthority({ edition: snapshot.edition, grants: snapshot.capabilities });
  }

  evaluate(signed: SignedEntitlement): EntitlementSnapshot {
    if (!verifyEd25519Payload(signed.claim, signed.signature, this.options.publicKeyPem)) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'invalid entitlement signature' };
    }
    const claim = signed.claim;
    if (claim.product !== (this.options.product ?? 'aiden')) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'wrong entitlement product' };
    }
    if (this.options.deviceBinding && claim.deviceBinding && claim.deviceBinding !== this.options.deviceBinding) {
      return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'wrong device binding' };
    }
    if (claim.revoked) {
      return { state: 'revoked', edition: 'community', capabilities: [], accountId: claim.accountId };
    }
    const capabilities = claim.capabilities.filter((capability): capability is CommercialCapability =>
      (COMMERCIAL_CAPABILITIES as readonly string[]).includes(capability));
    const now = this.now().getTime();
    const expiresAt = Date.parse(claim.expiresAt);
    const offlineUntil = claim.offlineUntil ? Date.parse(claim.offlineUntil) : Number.NaN;
    const base = {
      edition: claim.edition,
      accountId: claim.accountId,
      capabilities,
      issuedAt: claim.issuedAt,
      expiresAt: claim.expiresAt,
      ...(claim.offlineUntil ? { offlineUntil: claim.offlineUntil } : {}),
    };
    if (!Number.isFinite(expiresAt)) return { state: 'unavailable', edition: 'community', capabilities: [], reason: 'invalid entitlement expiry' };
    if (now <= expiresAt) return { ...base, state: claim.edition === 'community' ? 'community' : claim.trial ? 'trial' : 'active' };
    if (Number.isFinite(offlineUntil) && now <= offlineUntil) return { ...base, state: 'grace' };
    return { ...base, state: 'expired', capabilities: [] };
  }

  private async readCache(): Promise<SignedEntitlement | null> {
    try {
      return JSON.parse(await fs.readFile(this.cacheFile, 'utf8')) as SignedEntitlement;
    } catch {
      return null;
    }
  }

  private async writeCache(value: SignedEntitlement): Promise<void> {
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const temp = `${this.cacheFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, this.cacheFile);
  }
}
