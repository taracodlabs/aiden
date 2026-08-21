/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { computeExternalCodingCapabilityDigest } from './capability';
import {
  ExternalCodingProviderError,
  type ExternalCodingAgentProvider,
  type ExternalCodingProviderSelection,
} from './provider';

export class ExternalCodingProviderRegistry {
  private readonly providers = new Map<string, ExternalCodingAgentProvider>();

  register(provider: ExternalCodingAgentProvider): void {
    const id = provider.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
      throw new ExternalCodingProviderError('INVALID_PROVIDER_ID', `Invalid coding provider identity: ${provider.id}`);
    }
    if (this.providers.has(id)) {
      throw new ExternalCodingProviderError('PROVIDER_ALREADY_REGISTERED', `Coding provider is already registered: ${id}`);
    }
    this.providers.set(id, provider);
  }

  get(id: string): ExternalCodingAgentProvider | undefined {
    return this.providers.get(id.trim().toLowerCase());
  }

  require(id: string): ExternalCodingAgentProvider {
    const provider = this.get(id);
    if (!provider) throw new ExternalCodingProviderError('PROVIDER_NOT_REGISTERED', `Coding provider is not registered: ${id}`);
    return provider;
  }

  list(): readonly ExternalCodingAgentProvider[] {
    return [...this.providers.values()];
  }

  async select(id: string): Promise<ExternalCodingProviderSelection> {
    const provider = this.require(id);
    const detection = await provider.detect();
    if (!detection.available || !detection.executable) {
      throw new ExternalCodingProviderError('PROVIDER_UNAVAILABLE', detection.reason ?? `Coding provider is unavailable: ${id}`);
    }
    const [health, version, capability] = await Promise.all([
      provider.health(),
      provider.version(),
      provider.capabilities(),
    ]);
    if (!health.healthy) throw new ExternalCodingProviderError('PROVIDER_UNHEALTHY', health.detail);
    if (!version.supported) {
      throw new ExternalCodingProviderError(
        'UNSUPPORTED_PROVIDER_VERSION',
        `Coding provider ${provider.id} version ${version.raw} is not supported`,
      );
    }
    const computed = computeExternalCodingCapabilityDigest({
      schemaVersion: 1,
      capabilityId: capability.capabilityId,
      providerId: capability.providerId,
      providerVersion: capability.providerVersion,
      protocolMode: capability.protocolMode,
      protocolVersion: capability.protocolVersion,
      supportedFeatures: capability.supportedFeatures,
      runtimeCompatibility: capability.runtimeCompatibility,
    });
    if (capability.providerId !== provider.id || computed !== capability.capabilityDigest) {
      throw new ExternalCodingProviderError('INVALID_CAPABILITY_SNAPSHOT', 'Coding provider capability snapshot is invalid');
    }
    return { provider, detection, health, version, capability };
  }
}

