/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ComposioIntegrationProvider,
  type ComposioClientPort,
} from '../../../core/v4/integrations/composioProvider';

function clientFixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client: ComposioClientPort = {
    toolkits: {
      async get() {
        return { items: [{ slug: 'github', name: 'GitHub' }, { slug: 'gmail', name: 'Gmail' }] };
      },
    },
    authConfigs: {
      async list(query) {
        calls.push({ method: 'authConfigs.list', args: [query] });
        return { items: [{ id: `auth-${query.toolkit}`, toolkit: { slug: query.toolkit }, isComposioManaged: true }] };
      },
    },
    connectedAccounts: {
      async link(userId, authConfigId, options) {
        calls.push({ method: 'connectedAccounts.link', args: [userId, authConfigId, options] });
        return { id: 'connection-1', redirectUrl: 'https://example.invalid/connect' };
      },
      async waitForConnection(id) {
        calls.push({ method: 'connectedAccounts.waitForConnection', args: [id] });
        return { id: 'connected-1', userId: 'aiden:owner-a', status: 'ACTIVE', scopes: ['repo'] };
      },
      async get(id) {
        return { id, userId: 'aiden:owner-a', status: 'ACTIVE', scopes: ['repo'] };
      },
      async delete(id) {
        calls.push({ method: 'connectedAccounts.delete', args: [id] });
      },
    },
    tools: {
      async getRawComposioTools(query) {
        calls.push({ method: 'tools.getRawComposioTools', args: [query] });
        return { items: [
          {
            slug: 'GITHUB_LIST_ISSUES', name: 'List issues', description: 'List repository issues',
            toolkit: { slug: 'github' }, version: '20260801_00',
            inputParameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
          },
          {
            slug: 'GITHUB_CREATE_ISSUE', name: 'Create issue', description: 'Create a repository issue',
            toolkit: { slug: 'github' }, version: '20260801_00',
            inputParameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } } },
          },
          {
            slug: 'GITHUB_GET_ISSUE', name: 'Get issue', description: 'Read one repository issue',
            toolkit: { slug: 'github' }, version: '20260802_00',
            inputParameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } } },
          },
          {
            slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', description: 'Read mailbox messages',
            toolkit: { slug: 'gmail' }, version: '20260801_00', inputParameters: { type: 'object' },
          },
          {
            slug: 'GMAIL_SEND_EMAIL', name: 'Send email', description: 'Send mail',
            toolkit: { slug: 'gmail' }, version: '20260801_00', inputParameters: { type: 'object' },
          },
          {
            slug: 'GMAIL_GET_DRAFT', name: 'Get draft', description: 'Read one mail draft',
            toolkit: { slug: 'gmail' }, version: '20260803_00', inputParameters: { type: 'object' },
          },
          {
            slug: 'GMAIL_CREATE_EMAIL_DRAFT', name: 'Create draft', description: 'Create a mail draft',
            toolkit: { slug: 'gmail' }, version: '20260801_00', inputParameters: { type: 'object' },
          },
        ] };
      },
      async execute(slug, body, options) {
        calls.push({ method: 'tools.execute', args: [slug, body, options] });
        if (slug === 'GMAIL_GET_DRAFT') return { successful: true, data: { id: 'draft-1' } };
        return { successful: true, data: { id: 'issue-7', number: 7, title: 'Exact title' } };
      },
    },
  };
  return { client, calls };
}

describe('ComposioIntegrationProvider', () => {
  it('is optional and reports not configured without loading the SDK', async () => {
    const factory = vi.fn();
    const provider = new ComposioIntegrationProvider({ clientFactory: factory });
    expect(await provider.health()).toMatchObject({ state: 'not_configured' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('discovers only the bounded GitHub and Gmail action policy with exact versions', async () => {
    const { client } = clientFixture();
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    const github = await provider.discoverActions({ toolkitId: 'github', limit: 50, providerCredential: 'project-key' });
    expect(github.actions.map((action) => action.actionId)).toEqual([
      'GITHUB_CREATE_ISSUE', 'GITHUB_GET_ISSUE', 'GITHUB_LIST_ISSUES',
    ]);
    expect(github.actions.find((action) => action.actionId === 'GITHUB_CREATE_ISSUE')).toMatchObject({
      operation: 'mutation', providerActionVersion: '20260801_00', supportsReadback: true,
    });

    const gmail = await provider.discoverActions({ toolkitId: 'gmail', limit: 50, providerCredential: 'project-key' });
    expect(gmail.actions.map((action) => action.actionId)).toEqual([
      'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_FETCH_EMAILS', 'GMAIL_GET_DRAFT',
    ]);
    expect(gmail.actions.map((action) => action.actionId)).not.toContain('GMAIL_SEND_EMAIL');
  });

  it('normalizes oversized vendor schemas into a bounded model-safe definition', async () => {
    const { client } = clientFixture();
    const properties = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [
      `field_${index}`,
      { type: 'string', description: 'x'.repeat(5_000), default: `private-default-${index}` },
    ]));
    client.tools.getRawComposioTools = vi.fn(async () => ({ items: [{
      slug: 'GITHUB_GET_REPOSITORY', name: 'Get repository', description: 'read',
      version: '20260801_00', toolkit: { slug: 'github' },
      input_parameters: { type: 'object', properties, required: ['field_0'] },
    }] }));
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });

    const page = await provider.discoverActions({ toolkitId: 'github', limit: 50, providerCredential: 'project-key' });
    const schema = page.actions[0].inputSchema;
    expect(Object.keys(schema.properties as Record<string, unknown>).length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(schema), 'utf8')).toBeLessThanOrEqual(64_000);
    expect(JSON.stringify(schema)).not.toContain('private-default');
    expect((schema.required as string[])).toContain('field_0');
  });

  it('creates multi-account hosted OAuth links and retains exact user/account identities', async () => {
    const { client, calls } = clientFixture();
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    const start = await provider.initiateConnection({
      toolkitId: 'github', ownerId: 'owner-a', label: 'Work', providerCredential: 'project-key',
    });
    expect(start).toMatchObject({ connectionId: 'connection-1', state: 'pending' });
    expect(calls.find((call) => call.method === 'connectedAccounts.link')?.args).toEqual([
      'aiden:owner-a', 'auth-github', { alias: 'Work', allowMultiple: true },
    ]);
    const account = await provider.completeConnection({ connectionId: start.connectionId, providerCredential: 'project-key' });
    expect(account).toMatchObject({
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a', hostedAuthRef: 'connected-1',
    });
  });

  it('executes with an explicit account, user, action and provider version and forwards cancellation', async () => {
    const { client, calls } = clientFixture();
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    const signal = new AbortController().signal;
    const result = await provider.execute({
      toolkitId: 'github', actionId: 'GITHUB_CREATE_ISSUE',
      schemaVersion: 'schema-fixture', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a',
      input: { owner: 'taracodlabs', repo: 'aiden', title: 'Fixture' },
      idempotencyKey: 'issue-1', credentials: { provider: 'project-key' }, signal,
    });
    expect(result).toMatchObject({ outcome: 'succeeded', externalRef: 'issue-7' });
    expect(calls.find((call) => call.method === 'tools.execute')?.args).toEqual([
      'GITHUB_CREATE_ISSUE',
      {
        userId: 'aiden:owner-a', connectedAccountId: 'connected-1', version: '20260801_00',
        arguments: { owner: 'taracodlabs', repo: 'aiden', title: 'Fixture' },
      },
      { signal },
    ]);
  });

  it('uses the independently pinned readback action version for GitHub and Gmail mutations', async () => {
    const { client, calls } = clientFixture();
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    await provider.discoverActions({ toolkitId: 'github', limit: 50, providerCredential: 'project-key' });
    const github = await provider.readback({
      toolkitId: 'github', actionId: 'GITHUB_CREATE_ISSUE',
      schemaVersion: 'schema-fixture', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a',
      input: { owner: 'taracodlabs', repo: 'aiden' }, idempotencyKey: 'issue-readback',
      credentials: { provider: 'project-key' }, externalRef: '7', executionResult: { number: 7 },
    });
    expect(github.outcome).toBe('succeeded');
    expect(calls.find((call) => call.method === 'tools.execute' && call.args[0] === 'GITHUB_GET_ISSUE')?.args[1])
      .toMatchObject({ version: '20260802_00', arguments: { owner: 'taracodlabs', repo: 'aiden', issue_number: 7 } });

    await provider.discoverActions({ toolkitId: 'gmail', limit: 50, providerCredential: 'project-key' });
    await provider.readback({
      toolkitId: 'gmail', actionId: 'GMAIL_CREATE_EMAIL_DRAFT',
      schemaVersion: 'schema-fixture', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a',
      input: {}, idempotencyKey: 'draft-readback', credentials: { provider: 'project-key' },
      externalRef: 'draft-1', executionResult: { draftId: 'draft-1' },
    });
    expect(calls.find((call) => call.method === 'tools.execute' && call.args[0] === 'GMAIL_GET_DRAFT')?.args[1])
      .toMatchObject({ version: '20260803_00', arguments: { draft_id: 'draft-1' } });
  });

  it('retains bounded GitHub mutation and readback identity for response-loss reconciliation', async () => {
    const { client } = clientFixture();
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    await provider.discoverActions({ toolkitId: 'github', limit: 50, providerCredential: 'project-key' });
    expect(provider.reconciliationData({
      toolkitId: 'github', actionId: 'GITHUB_CREATE_ISSUE',
      schemaVersion: 'schema-fixture', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a',
      input: { owner: 'taracodlabs', repo: 'aiden', title: 'Exact title' },
      idempotencyKey: 'issue-reconcile', credentials: { provider: 'project-key' },
    })).toEqual({
      owner: 'taracodlabs', repo: 'aiden', title: 'Exact title',
      readbackProviderActionVersion: '20260802_00',
    });
  });

  it('uses persisted readback identity to reconcile after provider reconstruction', async () => {
    const { client, calls } = clientFixture();
    const first = new ComposioIntegrationProvider({ clientFactory: async () => client });
    await first.discoverActions({ toolkitId: 'github', limit: 50, providerCredential: 'project-key' });
    const reconciliationData = first.reconciliationData({
      toolkitId: 'github', actionId: 'GITHUB_CREATE_ISSUE',
      schemaVersion: 'schema-fixture', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a',
      input: { owner: 'taracodlabs', repo: 'aiden', title: 'Exact title' },
      idempotencyKey: 'issue-reconcile-restart', credentials: { provider: 'project-key' },
    });

    const reopened = new ComposioIntegrationProvider({ clientFactory: async () => client });
    await expect(reopened.reconcile({
      toolkitId: 'github', actionId: 'GITHUB_CREATE_ISSUE',
      schemaVersion: 'schema-fixture', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a',
      input: reconciliationData, idempotencyKey: 'issue-reconcile-restart',
      credentials: { provider: 'project-key' }, externalRef: '7',
    })).resolves.toMatchObject({ outcome: 'succeeded', externalRef: 'issue-7' });
    expect(calls.find((call) => call.method === 'tools.execute' && call.args[0] === 'GITHUB_GET_ISSUE')?.args[1])
      .toMatchObject({ version: '20260802_00' });
  });

  it('does not verify a consequential mutation when fresh readback disagrees', async () => {
    const { client } = clientFixture();
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    await provider.discoverActions({ toolkitId: 'github', limit: 50, providerCredential: 'project-key' });
    client.tools.execute = vi.fn(async () => ({
      successful: true, data: { id: 'issue-7', number: 7, title: 'Different title' },
    }));

    await expect(provider.readback({
      toolkitId: 'github', actionId: 'GITHUB_CREATE_ISSUE',
      schemaVersion: 'schema-fixture', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a',
      input: { owner: 'taracodlabs', repo: 'aiden', title: 'Expected title' },
      idempotencyKey: 'issue-mismatch', credentials: { provider: 'project-key' },
      externalRef: '7', executionResult: { number: 7 },
    })).resolves.toMatchObject({ outcome: 'failed', errorCategory: 'verification_failed' });
  });

  it('fails closed when account or pinned provider version identity is absent', async () => {
    const { client } = clientFixture();
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    await expect(provider.execute({
      toolkitId: 'github', actionId: 'GITHUB_CREATE_ISSUE', schemaVersion: 'schema',
      providerActionVersion: '', providerAccountRef: '', input: {}, idempotencyKey: 'bad',
      credentials: { provider: 'project-key' },
    })).rejects.toMatchObject({ category: 'invalid_input' });
  });

  it('treats an interrupted mutation after dispatch as unknown while reads remain cancellable', async () => {
    const { client } = clientFixture();
    client.tools.execute = vi.fn(async () => { throw new Error('socket closed'); });
    const provider = new ComposioIntegrationProvider({ clientFactory: async () => client });
    const controller = new AbortController();
    controller.abort();
    const base = {
      toolkitId: 'github', schemaVersion: 'schema', providerActionVersion: '20260801_00',
      providerAccountRef: 'connected-1', providerUserRef: 'aiden:owner-a', input: {},
      idempotencyKey: 'cancelled', credentials: { provider: 'project-key' }, signal: controller.signal,
    };

    await expect(provider.execute({ ...base, actionId: 'GITHUB_CREATE_ISSUE' }))
      .rejects.toMatchObject({ category: 'outcome_unknown' });
    await expect(provider.execute({ ...base, actionId: 'GITHUB_GET_REPOSITORY' }))
      .rejects.toMatchObject({ category: 'cancelled' });
  });
});
