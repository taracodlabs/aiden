/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type IntegrationOperation = 'read' | 'mutation';
export type IntegrationRisk = 'safe' | 'caution' | 'dangerous';
export type IntegrationProviderHealthState = 'healthy' | 'degraded' | 'unavailable' | 'not_configured';
export type ConnectedAccountStatus = 'connecting' | 'active' | 'degraded' | 'expired' | 'revoked';
export type ConnectedAccountHealth =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'insufficient_scope'
  | 'expired'
  | 'revoked';

export type IntegrationErrorCategory =
  | 'auth_expired'
  | 'permission_denied'
  | 'account_not_found'
  | 'account_selection_required'
  | 'action_not_found'
  | 'schema_drift'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'timeout'
  | 'outcome_unknown'
  | 'cancelled'
  | 'invalid_input'
  | 'verification_failed';

export class IntegrationProviderError extends Error {
  readonly category: IntegrationErrorCategory;
  readonly retryAfterMs?: number;
  readonly externalRef?: string;
  readonly safeDetail?: string;

  constructor(
    category: IntegrationErrorCategory,
    message: string,
    options: { retryAfterMs?: number; externalRef?: string; safeDetail?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'IntegrationProviderError';
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
    this.category = category;
    this.retryAfterMs = options.retryAfterMs;
    this.externalRef = options.externalRef;
    this.safeDetail = options.safeDetail;
  }
}

export interface IntegrationProviderHealth {
  state: IntegrationProviderHealthState;
  checkedAt: number;
  detail?: string;
}

export interface IntegrationToolkitDescriptor {
  toolkitId: string;
  label: string;
  connectionRequired: boolean;
}

export interface IntegrationActionDescriptor {
  providerId: string;
  toolkitId: string;
  actionId: string;
  label: string;
  description: string;
  schemaVersion: string;
  providerActionVersion: string;
  operation: IntegrationOperation;
  risk: IntegrationRisk;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  supportsIdempotency: boolean;
  supportsReadback: boolean;
  supportsReconciliation: boolean;
}

export interface ActionDiscoveryPage {
  actions: IntegrationActionDescriptor[];
  nextCursor?: string;
}

export interface ProviderConnectionStart {
  connectionId: string;
  state: 'pending' | 'completed';
  authorizationUrl?: string;
  userCode?: string;
  expiresAt?: number;
}

export interface ProviderConnectionResult {
  connectionId: string;
  providerAccountRef: string;
  providerUserRef?: string;
  label: string;
  scopes: string[];
  hostedAuthRef?: string;
  secretValue?: string;
}

export interface IntegrationExecutionRequest {
  toolkitId: string;
  actionId: string;
  schemaVersion: string;
  providerActionVersion: string;
  providerAccountRef: string;
  providerUserRef?: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
  /** Resolved only inside the trusted provider adapter. Never persist or return it. */
  credentials?: { provider?: string; account?: string };
  /** Aiden-owned final authority fence. Providers invoke it immediately before physical dispatch. */
  authorizeDispatch?: () => void;
}

export interface IntegrationExecutionResult {
  outcome: 'succeeded' | 'failed' | 'unknown';
  /** Explicit reconciliation truth. Absence never implies that an Effect did not occur. */
  reconciliationOutcome?: 'occurred' | 'did_not_occur' | 'unknown';
  externalRef?: string;
  result?: unknown;
  errorCategory?: IntegrationErrorCategory;
  safeMessage?: string;
  retryAfterMs?: number;
}

export interface IntegrationReadbackRequest extends IntegrationExecutionRequest {
  externalRef?: string;
  executionResult?: unknown;
}

export interface IntegrationProvider {
  readonly id: string;
  readonly label: string;
  health(input?: { providerCredential?: string }): Promise<IntegrationProviderHealth>;
  listToolkits(input?: { providerCredential?: string }): Promise<IntegrationToolkitDescriptor[]>;
  discoverActions(input: {
    toolkitId: string;
    cursor?: string;
    limit: number;
    providerCredential?: string;
  }): Promise<ActionDiscoveryPage>;
  initiateConnection(input: {
    toolkitId: string;
    ownerId: string;
    workspaceId?: string;
    label?: string;
    providerCredential?: string;
  }): Promise<ProviderConnectionStart>;
  completeConnection(input: { connectionId: string; providerCredential?: string }): Promise<ProviderConnectionResult>;
  refreshAccount(input: { providerAccountRef: string; credentials?: { provider?: string; account?: string } }): Promise<{
    status: ConnectedAccountStatus;
    health: ConnectedAccountHealth;
    scopes?: string[];
  }>;
  revokeAccount(input: { providerAccountRef: string; credentials?: { provider?: string; account?: string } }): Promise<void>;
  reconciliationData?(input: IntegrationExecutionRequest): Record<string, unknown>;
  execute(input: IntegrationExecutionRequest): Promise<IntegrationExecutionResult>;
  readback(input: IntegrationReadbackRequest): Promise<IntegrationExecutionResult>;
  reconcile(input: IntegrationReadbackRequest): Promise<IntegrationExecutionResult>;
}

export interface ConnectedAccountRecord {
  accountId: string;
  providerId: string;
  toolkitId: string;
  ownerId: string;
  workspaceId: string;
  label: string;
  providerAccountRef: string;
  providerUserRef: string | null;
  secretHandle: string | null;
  hostedAuthRef: string | null;
  status: ConnectedAccountStatus;
  health: ConnectedAccountHealth;
  scopes: string[];
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  revokedAt: number | null;
}

export interface IntegrationTriggerEvent {
  providerId: string;
  toolkitId: string;
  accountId: string;
  triggerId: string;
  cursor: string;
  observedAt: number;
  payload: unknown;
  untrustedContent: true;
}
