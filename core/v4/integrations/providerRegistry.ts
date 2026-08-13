/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { IntegrationProvider } from './types';

export class IntegrationProviderRegistry {
  private readonly providers = new Map<string, IntegrationProvider>();

  register(provider: IntegrationProvider): void {
    const id = provider.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
      throw new Error(`Invalid integration provider id: ${provider.id}`);
    }
    if (this.providers.has(id)) throw new Error(`Integration provider already registered: ${id}`);
    this.providers.set(id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id.trim().toLowerCase());
  }

  get(id: string): IntegrationProvider | undefined {
    return this.providers.get(id.trim().toLowerCase());
  }

  require(id: string): IntegrationProvider {
    const provider = this.get(id);
    if (!provider) throw new Error(`Integration provider is not available: ${id}`);
    return provider;
  }

  list(): IntegrationProvider[] {
    return [...this.providers.values()];
  }
}
