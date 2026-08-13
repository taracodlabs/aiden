/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';

import {
  IntegrationProviderError,
  type ActionDiscoveryPage,
  type IntegrationActionDescriptor,
  type IntegrationErrorCategory,
  type IntegrationExecutionRequest,
  type IntegrationExecutionResult,
  type IntegrationProvider,
  type IntegrationProviderHealth,
  type IntegrationReadbackRequest,
  type IntegrationToolkitDescriptor,
  type ProviderConnectionResult,
  type ProviderConnectionStart,
} from './types';

const BASE_ACTIONS: IntegrationActionDescriptor[] = [
  {
    providerId: 'fake', toolkitId: 'projects', actionId: 'get_project', label: 'Get project',
    description: 'Read one project', schemaVersion: '1', providerActionVersion: '2026-01-01',
    operation: 'read', risk: 'safe', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    supportsIdempotency: false, supportsReadback: true, supportsReconciliation: false,
  },
  {
    providerId: 'fake', toolkitId: 'projects', actionId: 'list_projects', label: 'List projects',
    description: 'List projects', schemaVersion: '1', providerActionVersion: '2026-01-01',
    operation: 'read', risk: 'safe', inputSchema: { type: 'object', properties: {} },
    supportsIdempotency: false, supportsReadback: false, supportsReconciliation: false,
  },
  {
    providerId: 'fake', toolkitId: 'projects', actionId: 'create_note', label: 'Create note',
    description: 'Create a note in a project', schemaVersion: '1', providerActionVersion: '2026-01-01',
    operation: 'mutation', risk: 'caution',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, text: { type: 'string' } }, required: ['projectId', 'text'] },
    supportsIdempotency: true, supportsReadback: true, supportsReconciliation: true,
  },
  {
    providerId: 'fake', toolkitId: 'projects', actionId: 'update_note', label: 'Update note',
    description: 'Update a note in a project', schemaVersion: '1', providerActionVersion: '2026-01-01',
    operation: 'mutation', risk: 'caution',
    inputSchema: { type: 'object', properties: { noteId: { type: 'string' }, text: { type: 'string' } }, required: ['noteId', 'text'] },
    supportsIdempotency: true, supportsReadback: true, supportsReconciliation: true,
  },
];

interface Note { noteId: string; projectId: string; text: string }

export class FakeIntegrationProvider implements IntegrationProvider {
  readonly id = 'fake';
  readonly label = 'Deterministic test provider';
  private readonly connections = new Map<string, { toolkitId: string; label: string; providerAccountRef?: string }>();
  private readonly accounts = new Set<string>();
  private readonly notes = new Map<string, Note>();
  private readonly idempotency = new Map<string, IntegrationExecutionResult>();
  private readonly unknownResults = new Map<string, IntegrationExecutionResult>();
  private failure: IntegrationErrorCategory | null = null;
  private schemaVersion = '1';
  private available = true;

  mutationCount(): number {
    return this.notes.size;
  }

  failNext(category: IntegrationErrorCategory): void {
    this.failure = category;
  }

  driftSchema(version = '2'): void {
    this.schemaVersion = version;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  async health(): Promise<IntegrationProviderHealth> {
    return {
      state: this.available ? 'healthy' : 'unavailable',
      checkedAt: Date.now(),
      ...(!this.available ? { detail: 'Provider unavailable' } : {}),
    };
  }

  async listToolkits(): Promise<IntegrationToolkitDescriptor[]> {
    return [{ toolkitId: 'projects', label: 'Projects', connectionRequired: true }];
  }

  async discoverActions(input: { toolkitId: string; cursor?: string; limit: number }): Promise<ActionDiscoveryPage> {
    if (input.toolkitId !== 'projects') throw new IntegrationProviderError('action_not_found', 'Toolkit is not available');
    const limit = Math.max(1, Math.min(100, input.limit));
    return {
      actions: BASE_ACTIONS.slice(0, limit).map((action) => ({ ...action, schemaVersion: this.schemaVersion })),
    };
  }

  async initiateConnection(input: { toolkitId: string; ownerId: string; label?: string }): Promise<ProviderConnectionStart> {
    if (input.toolkitId !== 'projects') throw new IntegrationProviderError('action_not_found', 'Toolkit is not available');
    const connectionId = `fake-connection-${randomBytes(8).toString('hex')}`;
    this.connections.set(connectionId, { toolkitId: input.toolkitId, label: input.label ?? `Projects account ${this.connections.size + 1}` });
    return { connectionId, state: 'pending', authorizationUrl: `https://example.invalid/connect/${connectionId}` };
  }

  async completeConnection(input: { connectionId: string }): Promise<ProviderConnectionResult> {
    const connection = this.connections.get(input.connectionId);
    if (!connection && !input.connectionId.startsWith('fake-connection-')) {
      throw new IntegrationProviderError('account_not_found', 'Connection is not available');
    }
    const providerAccountRef = connection?.providerAccountRef
      ?? `fake-account-${input.connectionId.slice('fake-connection-'.length)}`;
    if (connection) connection.providerAccountRef = providerAccountRef;
    this.accounts.add(providerAccountRef);
    return {
      connectionId: input.connectionId,
      providerAccountRef,
      label: connection?.label ?? '',
      scopes: ['projects:read', 'notes:write'],
      hostedAuthRef: input.connectionId,
    };
  }

  async refreshAccount(input: { providerAccountRef: string }) {
    if (!this.accounts.has(input.providerAccountRef)) {
      return { status: 'expired' as const, health: 'expired' as const };
    }
    return { status: 'active' as const, health: 'healthy' as const, scopes: ['projects:read', 'notes:write'] };
  }

  async revokeAccount(input: { providerAccountRef: string }): Promise<void> {
    this.accounts.delete(input.providerAccountRef);
  }

  reconciliationData(input: IntegrationExecutionRequest): Record<string, unknown> {
    if (input.actionId === 'create_note' && typeof input.input.projectId === 'string') {
      return { projectId: input.input.projectId };
    }
    if (input.actionId === 'update_note' && typeof input.input.noteId === 'string') {
      return { noteId: input.input.noteId };
    }
    return {};
  }

  async execute(input: IntegrationExecutionRequest): Promise<IntegrationExecutionResult> {
    this.assertRequest(input);
    input.authorizeDispatch?.();
    const cached = this.idempotency.get(input.idempotencyKey);
    if (cached) return structuredClone(cached);
    const failure = this.failure;
    this.failure = null;
    if (failure && failure !== 'outcome_unknown') {
      throw new IntegrationProviderError(
        failure,
        failure === 'rate_limited' ? 'Provider rate limit reached' : 'Provider request failed',
        failure === 'rate_limited' ? { retryAfterMs: 1_000 } : {},
      );
    }
    let result: IntegrationExecutionResult;
    if (input.actionId === 'list_projects') {
      result = { outcome: 'succeeded', result: [{ projectId: 'project-1', name: 'Example project' }] };
    } else if (input.actionId === 'get_project') {
      result = { outcome: 'succeeded', result: { projectId: input.input.projectId, name: 'Example project' } };
    } else if (input.actionId === 'create_note') {
      const noteId = `note-${randomBytes(6).toString('hex')}`;
      const note = { noteId, projectId: String(input.input.projectId), text: String(input.input.text) };
      this.notes.set(noteId, note);
      result = { outcome: 'succeeded', externalRef: noteId, result: note };
    } else if (input.actionId === 'update_note') {
      const noteId = String(input.input.noteId);
      const prior = this.notes.get(noteId);
      if (!prior) throw new IntegrationProviderError('action_not_found', 'Note is not available');
      const note = { ...prior, text: String(input.input.text) };
      this.notes.set(noteId, note);
      result = { outcome: 'succeeded', externalRef: noteId, result: note };
    } else {
      throw new IntegrationProviderError('action_not_found', 'Action is not available');
    }
    this.idempotency.set(input.idempotencyKey, result);
    if (failure === 'outcome_unknown') {
      this.unknownResults.set(input.idempotencyKey, result);
      throw new IntegrationProviderError('outcome_unknown', 'Provider response was lost', { externalRef: result.externalRef });
    }
    return structuredClone(result);
  }

  async readback(input: IntegrationReadbackRequest): Promise<IntegrationExecutionResult> {
    this.assertAccount(input.providerAccountRef);
    input.authorizeDispatch?.();
    if (input.actionId === 'create_note' || input.actionId === 'update_note') {
      const reference = input.externalRef ?? String((input.executionResult as { noteId?: unknown } | undefined)?.noteId ?? '');
      const note = this.notes.get(reference);
      return note
        ? { outcome: 'succeeded', externalRef: reference, result: structuredClone(note) }
        : { outcome: 'failed', errorCategory: 'verification_failed', safeMessage: 'Expected note was not found' };
    }
    return { outcome: 'succeeded', result: input.executionResult };
  }

  async reconcile(input: IntegrationReadbackRequest): Promise<IntegrationExecutionResult> {
    input.authorizeDispatch?.();
    return structuredClone(this.unknownResults.get(input.idempotencyKey)
      ?? { outcome: 'unknown', errorCategory: 'outcome_unknown', safeMessage: 'Provider outcome is still unknown' });
  }

  private assertRequest(input: IntegrationExecutionRequest): void {
    if (!this.available) throw new IntegrationProviderError('provider_unavailable', 'Provider is unavailable');
    this.assertAccount(input.providerAccountRef);
    if (input.schemaVersion !== this.schemaVersion || input.providerActionVersion !== '2026-01-01') {
      throw new IntegrationProviderError('schema_drift', 'Action schema changed; rediscover and approve the current action');
    }
    if (input.signal?.aborted) throw new IntegrationProviderError('cancelled', 'Integration action was cancelled');
  }

  private assertAccount(providerAccountRef: string): void {
    if (!this.accounts.has(providerAccountRef)) throw new IntegrationProviderError('auth_expired', 'Connected account is unavailable');
  }
}
