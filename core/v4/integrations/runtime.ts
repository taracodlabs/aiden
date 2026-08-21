/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Db } from '../daemon/db/connection';
import type { ToolRegistry } from '../toolRegistry';
import { ComposioIntegrationProvider, type ComposioClientFactory } from './composioProvider';
import { ConnectedAccountAuthority } from './connectedAccountAuthority';
import { FakeIntegrationProvider } from './fakeProvider';
import { IntegrationActionAuthority } from './integrationActionAuthority';
import { IntegrationActionSchemaAuthority } from './integrationActionSchemaAuthority';
import { IntegrationProviderRegistry } from './providerRegistry';
import { IntegrationResolver } from './integrationResolver';
import { SecretAuthority, type SecretBackend } from './secretAuthority';
import { registerIntegrationTools, type IntegrationToolScope } from './tools';
import { IntegrationTriggerBoundary } from './triggerBoundary';

export function integrationLocalScope(cwd = process.cwd()): IntegrationToolScope {
  const absolute = path.resolve(cwd);
  const canonical = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  return {
    ownerId: 'local-user',
    workspaceId: `workspace_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`,
  };
}

export interface IntegrationRuntime {
  scope: IntegrationToolScope;
  providers: IntegrationProviderRegistry;
  accounts: ConnectedAccountAuthority;
  schemas: IntegrationActionSchemaAuthority;
  secrets: SecretAuthority;
  actions: IntegrationActionAuthority;
  resolver: IntegrationResolver;
  triggers: IntegrationTriggerBoundary;
  fakeProvider?: FakeIntegrationProvider;
}

export function createIntegrationRuntime(options: {
  db: Db;
  rootDir: string;
  toolRegistry?: ToolRegistry;
  scope?: IntegrationToolScope;
  includeFake?: boolean;
  clientFactory?: ComposioClientFactory;
  secretBackend?: SecretBackend;
  /** Reuse an already-created secret authority when the host also exposes
   * provider setup. This keeps one credential authority per process. */
  secrets?: SecretAuthority;
}): IntegrationRuntime {
  const scope = options.scope ?? integrationLocalScope();
  const providers = new IntegrationProviderRegistry();
  providers.register(new ComposioIntegrationProvider({ clientFactory: options.clientFactory }));
  let fakeProvider: FakeIntegrationProvider | undefined;
  if (options.includeFake === true || process.env.AIDEN_INTEGRATION_FAKE === '1') {
    fakeProvider = new FakeIntegrationProvider();
    providers.register(fakeProvider);
  }
  const accounts = new ConnectedAccountAuthority({ db: options.db });
  const schemas = new IntegrationActionSchemaAuthority({ db: options.db });
  const secrets = options.secrets ?? new SecretAuthority({
    db: options.db,
    rootDir: path.join(options.rootDir, 'secrets'),
    backend: options.secretBackend,
  });
  const actions = new IntegrationActionAuthority({ db: options.db, providers, accounts, schemas, secrets });
  const resolver = new IntegrationResolver({
    accounts,
    provider: (providerId) => providers.require(providerId),
    discover: (input) => actions.discoverActions(input),
  });
  const triggers = new IntegrationTriggerBoundary({ db: options.db, accounts });
  if (options.toolRegistry) registerIntegrationTools(options.toolRegistry, actions, scope, resolver);
  return {
    scope, providers, accounts, schemas, secrets, actions, resolver, triggers,
    ...(fakeProvider ? { fakeProvider } : {}),
  };
}
