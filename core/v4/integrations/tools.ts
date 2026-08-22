/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ToolHandler, ToolRegistry } from '../toolRegistry';
import type { IntegrationActionAuthority, IntegrationActionInput } from './integrationActionAuthority';
import { validateIntegrationInput } from './integrationActionAuthority';
import { ConnectedAccountSelectionError } from './connectedAccountAuthority';
import type { IntegrationResolver } from './integrationResolver';

const identityProperties = {
  provider_id: { type: 'string', description: 'Exact integration provider id' },
  toolkit_id: { type: 'string', description: 'Exact provider toolkit id' },
  action_id: { type: 'string', description: 'Exact provider action id' },
  schema_version: { type: 'string', description: 'Pinned Aiden action schema version' },
  provider_action_version: { type: 'string', description: 'Pinned provider action version' },
  account_id: { type: 'string', description: 'Exact connected account id; required when multiple accounts exist' },
  input: { type: 'object', description: 'Action input. Credentials and secret-shaped fields are forbidden.' },
  request_id: { type: 'string', description: 'Stable request identity for durable execution and reconciliation' },
};

const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function identityError(value: unknown, label: string, maximum = 128): string | null {
  return typeof value !== 'string' || value.length === 0 || value.length > maximum || !SAFE_IDENTITY.test(value)
    ? `${label} is invalid`
    : null;
}

function opaqueTextError(value: unknown, label: string, maximum: number): string | null {
  return typeof value !== 'string' || value.length === 0 || value.length > maximum
      || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? `${label} is invalid`
    : null;
}

export function validateExactActionArguments(args: Readonly<Record<string, unknown>>): string | null {
  const checks: Array<string | null> = [
    identityError(args.provider_id, 'provider identity', 64),
    identityError(args.toolkit_id, 'toolkit identity'),
    identityError(args.action_id, 'action identity'),
    identityError(args.schema_version, 'action schema version'),
    identityError(args.provider_action_version, 'provider action version'),
    args.account_id === undefined ? null : identityError(args.account_id, 'connected account identity', 256),
    opaqueTextError(args.request_id, 'request identity', 256),
  ];
  if (typeof args.provider_action_version === 'string' && args.provider_action_version.toLowerCase() === 'latest') {
    checks.push('provider action version must be immutable');
  }
  const identity = checks.find((error): error is string => Boolean(error));
  if (identity) return identity;
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    return 'action input must be an object';
  }
  const input = args.input as Record<string, unknown>;
  return validateIntegrationInput(input);
}

export interface IntegrationToolScope {
  ownerId: string;
  workspaceId: string;
}

export function makeIntegrationResolveTool(
  resolver: IntegrationResolver,
  scope: IntegrationToolScope = { ownerId: 'local-user', workspaceId: 'default' },
): ToolHandler {
  return {
    schema: {
      name: 'app_resolve',
      description: 'Resolve one app, connected account and a small versioned action set without executing anything.',
      inputSchema: {
        type: 'object',
        properties: {
          provider_id: { type: 'string', description: 'Exact integration provider id' },
          toolkit_id: { type: 'string', description: 'Exact app/toolkit id' },
          account_id: { type: 'string', description: 'Exact connected account id when already selected' },
          intent: { type: 'string', description: 'Short description of the requested app operation' },
          action_ids: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          max_actions: { type: 'number', minimum: 1, maximum: 12 },
        },
        required: ['provider_id', 'toolkit_id', 'intent'],
      },
    },
    category: 'network',
    mutates: false,
    riskTier: 'safe',
    toolset: 'apps',
    validateArguments(args) {
      const identity = identityError(args.provider_id, 'provider identity', 64)
        ?? identityError(args.toolkit_id, 'toolkit identity')
        ?? (args.account_id === undefined ? null : identityError(args.account_id, 'connected account identity', 256))
        ?? opaqueTextError(args.intent, 'app intent', 2_000);
      if (identity) return identity;
      if (Array.isArray(args.action_ids)) {
        if (args.action_ids.length > 12) return 'action selection exceeds the Aiden limit';
        for (const actionId of args.action_ids) {
          const error = identityError(actionId, 'action identity');
          if (error) return error;
        }
      }
      return null;
    },
    async execute(args) {
      try {
        const resolved = await resolver.resolve({
          providerId: String(args.provider_id ?? ''),
          toolkitId: String(args.toolkit_id ?? ''),
          ownerId: scope.ownerId,
          workspaceId: scope.workspaceId,
          ...(typeof args.account_id === 'string' && args.account_id ? { accountId: args.account_id } : {}),
          intent: String(args.intent ?? ''),
          ...(Array.isArray(args.action_ids)
            ? { actionIds: args.action_ids.filter((value): value is string => typeof value === 'string').slice(0, 12) }
            : {}),
          maxActions: Number.isFinite(Number(args.max_actions)) ? Number(args.max_actions) : 6,
        });
        return {
          providerId: resolved.providerId,
          toolkitId: resolved.toolkitId,
          account: { accountId: resolved.account.accountId, label: resolved.account.label, health: resolved.account.health },
          actions: resolved.actions.map((action) => ({
            actionId: action.actionId,
            label: action.label,
            description: action.description,
            schemaVersion: action.schemaVersion,
            providerActionVersion: action.providerActionVersion,
            operation: action.operation,
            risk: action.risk,
            inputSchema: action.inputSchema,
          })),
          discovery: resolved.discovery,
          untrustedExternalContent: true,
        };
      } catch (error) {
        if (error instanceof ConnectedAccountSelectionError && error.candidates.length > 0) {
          return {
            selectionRequired: true,
            message: 'Select an exact connected account before execution.',
            accounts: error.candidates,
          };
        }
        throw error;
      }
    },
  };
}

function parse(
  args: Record<string, unknown>,
  context: { signal?: AbortSignal },
  scope: IntegrationToolScope,
): IntegrationActionInput {
  return {
    providerId: String(args.provider_id ?? ''),
    toolkitId: String(args.toolkit_id ?? ''),
    actionId: String(args.action_id ?? ''),
    schemaVersion: String(args.schema_version ?? ''),
    providerActionVersion: String(args.provider_action_version ?? ''),
    ...(typeof args.account_id === 'string' && args.account_id ? { accountId: args.account_id } : {}),
    ownerId: scope.ownerId,
    workspaceId: scope.workspaceId,
    input: args.input && typeof args.input === 'object' && !Array.isArray(args.input)
      ? args.input as Record<string, unknown>
      : {},
    requestId: String(args.request_id ?? ''),
    signal: context.signal,
  };
}

export function makeIntegrationReadTool(
  authority: IntegrationActionAuthority,
  scope: IntegrationToolScope = { ownerId: 'local-user', workspaceId: 'default' },
): ToolHandler {
  return {
    schema: {
      name: 'app_read',
      description: 'Run one exact versioned read-only action through a selected connected account.',
      inputSchema: {
        type: 'object', properties: identityProperties,
        required: ['provider_id', 'toolkit_id', 'action_id', 'schema_version', 'provider_action_version', 'input', 'request_id'],
      },
    },
    category: 'network',
    mutates: false,
    riskTier: 'safe',
    toolset: 'apps',
    validateArguments(args) {
      return validateExactActionArguments(args);
    },
    execute(args, context) {
      return authority.executeRead(parse(args, context, scope));
    },
  };
}

export function makeIntegrationMutationTool(
  authority: IntegrationActionAuthority,
  scope: IntegrationToolScope = { ownerId: 'local-user', workspaceId: 'default' },
): ToolHandler {
  const handler: ToolHandler = {
    schema: {
      name: 'app_action',
      description: 'Run one exact versioned mutating app action after durable exact-action approval.',
      inputSchema: {
        type: 'object', properties: identityProperties,
        required: ['provider_id', 'toolkit_id', 'action_id', 'schema_version', 'provider_action_version', 'input', 'request_id'],
      },
    },
    category: 'network',
    mutates: true,
    riskTier: 'caution',
    toolset: 'apps',
    validateArguments(args) {
      return validateExactActionArguments(args);
    },
    effectContract: {
      classification: 'reconcilable_mutation',
      kind: 'integration.action',
      retrySafety: 'reconcile_before_retry',
      idempotencySupported: false,
      reconciliationSupported: true,
      verificationSupported: true,
      approvalRequirement: 'always',
      sensitiveFields: ['input'],
      redactionRules: ['digest_arguments', 'omit_sensitive_values'],
      target(args) {
        const parts = ['provider_id', 'toolkit_id', 'action_id', 'account_id']
          .map((key) => typeof args[key] === 'string' ? args[key] : '')
          .filter(Boolean);
        return parts.join('/').slice(0, 512) || null;
      },
      reconciliationData(args) {
        return {
          providerId: String(args.provider_id ?? ''),
          toolkitId: String(args.toolkit_id ?? ''),
          actionId: String(args.action_id ?? ''),
          accountId: typeof args.account_id === 'string' ? args.account_id : undefined,
          schemaVersion: String(args.schema_version ?? ''),
          providerActionVersion: String(args.provider_action_version ?? ''),
          requestId: String(args.request_id ?? ''),
        };
      },
    },
    execute(args, context) {
      return authority.executeMutation(parse(args, context, scope));
    },
    buildPreview(args) {
      const target = ['provider_id', 'toolkit_id', 'action_id', 'account_id']
        .map((key) => typeof args[key] === 'string' ? args[key] : '')
        .filter(Boolean).join('/');
      return {
        tool: 'app_action',
        args,
        riskTier: 'caution',
        sideEffects: [{ type: 'app_control', action: String(args.action_id ?? 'action'), target }],
        detectedRisks: ['External account mutation requires fresh readback or reconciliation'],
        summary: `Would run ${target || 'an external app action'} after exact approval`,
      };
    },
  };
  return handler;
}

export function registerIntegrationTools(
  registry: ToolRegistry,
  authority: IntegrationActionAuthority,
  scope: IntegrationToolScope = { ownerId: 'local-user', workspaceId: 'default' },
  resolver?: IntegrationResolver,
): void {
  if (resolver) registry.register(makeIntegrationResolveTool(resolver, scope));
  registry.register(makeIntegrationReadTool(authority, scope));
  registry.register(makeIntegrationMutationTool(authority, scope));
}
