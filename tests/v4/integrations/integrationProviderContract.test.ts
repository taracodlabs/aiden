/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  ComposioIntegrationProvider,
  type ComposioClientPort,
} from '../../../core/v4/integrations/composioProvider';
import { FakeIntegrationProvider } from '../../../core/v4/integrations/fakeProvider';
import type { IntegrationProvider } from '../../../core/v4/integrations/types';

interface ContractCase {
  name: string;
  provider: IntegrationProvider;
  credential?: string;
  toolkitId: string;
  readActionId: string;
  readInput: Record<string, unknown>;
}

function composioCase(): ContractCase {
  let active = true;
  const client: ComposioClientPort = {
    toolkits: { get: async () => ({ items: [{ slug: 'github', name: 'GitHub' }] }) },
    authConfigs: {
      list: async () => ({
        items: [{ id: 'auth-github', toolkit: { slug: 'github' }, isComposioManaged: true }],
      }),
    },
    connectedAccounts: {
      link: async () => ({ id: 'connection-contract', redirectUrl: 'https://example.invalid/connect' }),
      waitForConnection: async () => ({
        id: 'account-contract', userId: 'aiden:contract', status: 'ACTIVE', scopes: ['repo:read'],
      }),
      get: async () => ({
        id: 'account-contract', userId: 'aiden:contract', status: active ? 'ACTIVE' : 'REVOKED', scopes: ['repo:read'],
      }),
      delete: async () => { active = false; },
    },
    tools: {
      // The pinned SDK returns an array here, not a cursor-bearing page.
      getRawComposioTools: async () => [{
        slug: 'GITHUB_GET_REPOSITORY',
        name: 'Get repository',
        description: 'Read repository metadata',
        toolkit: { slug: 'github' },
        version: '20260801_00',
        inputParameters: {
          type: 'object',
          properties: { owner: { type: 'string' }, repo: { type: 'string' } },
          required: ['owner', 'repo'],
        },
      }],
      execute: async () => ({ successful: true, data: { name: 'aiden', private: false } }),
    },
  };
  return {
    name: 'mocked Composio adapter',
    provider: new ComposioIntegrationProvider({ clientFactory: async () => client }),
    credential: 'contract-credential',
    toolkitId: 'github',
    readActionId: 'GITHUB_GET_REPOSITORY',
    readInput: { owner: 'taracodlabs', repo: 'aiden' },
  };
}

function fakeCase(): ContractCase {
  return {
    name: 'deterministic provider',
    provider: new FakeIntegrationProvider(),
    toolkitId: 'projects',
    readActionId: 'get_project',
    readInput: { projectId: 'project-1' },
  };
}

describe.each([fakeCase, composioCase])('IntegrationProvider common contract', (makeCase) => {
  it('supports bounded discovery, exact execution identity, health and revocation', async () => {
    const testCase = makeCase();
    const health = await testCase.provider.health({ providerCredential: testCase.credential });
    expect(health.state).toBe('healthy');

    const toolkits = await testCase.provider.listToolkits({ providerCredential: testCase.credential });
    expect(toolkits.some((toolkit) => toolkit.toolkitId === testCase.toolkitId)).toBe(true);

    const page = await testCase.provider.discoverActions({
      toolkitId: testCase.toolkitId,
      limit: 10,
      providerCredential: testCase.credential,
    });
    expect(page.actions.length).toBeGreaterThan(0);
    expect(page.actions.length).toBeLessThanOrEqual(10);
    const action = page.actions.find((candidate) => candidate.actionId === testCase.readActionId)!;
    expect(action).toBeDefined();
    expect(action.operation).toBe('read');
    expect(action.schemaVersion).toBeTruthy();
    expect(action.providerActionVersion).toBeTruthy();

    const started = await testCase.provider.initiateConnection({
      toolkitId: testCase.toolkitId,
      ownerId: 'contract',
      label: 'Personal',
      providerCredential: testCase.credential,
    });
    const account = await testCase.provider.completeConnection({
      connectionId: started.connectionId,
      providerCredential: testCase.credential,
    });
    const result = await testCase.provider.execute({
      toolkitId: testCase.toolkitId,
      actionId: action.actionId,
      schemaVersion: action.schemaVersion,
      providerActionVersion: action.providerActionVersion,
      providerAccountRef: account.providerAccountRef,
      providerUserRef: account.providerUserRef,
      input: testCase.readInput,
      idempotencyKey: `contract:${testCase.provider.id}`,
      credentials: { provider: testCase.credential },
    });
    expect(result.outcome).toBe('succeeded');
    expect((await testCase.provider.refreshAccount({
      providerAccountRef: account.providerAccountRef,
      credentials: { provider: testCase.credential },
    })).status).toBe('active');

    await testCase.provider.revokeAccount({
      providerAccountRef: account.providerAccountRef,
      credentials: { provider: testCase.credential },
    });
    expect((await testCase.provider.refreshAccount({
      providerAccountRef: account.providerAccountRef,
      credentials: { provider: testCase.credential },
    })).status).not.toBe('active');
  });
});
