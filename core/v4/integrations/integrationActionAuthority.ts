/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import {
  currentJobExecutionContext,
  currentPreparedDurableToolCall,
  type JobExecutionContext,
} from '../daemon/jobExecutionContext';
import type { ConnectedAccountAuthority } from './connectedAccountAuthority';
import type { IntegrationActionSchemaAuthority } from './integrationActionSchemaAuthority';
import type { IntegrationProviderRegistry } from './providerRegistry';
import type { SecretAuthority } from './secretAuthority';
import {
  IntegrationProviderError,
  type ActionDiscoveryPage,
  type ConnectedAccountRecord,
  type IntegrationActionDescriptor,
  type IntegrationErrorCategory,
  type IntegrationExecutionResult,
  type IntegrationProviderHealth,
  type IntegrationToolkitDescriptor,
  type ProviderConnectionResult,
  type ProviderConnectionStart,
} from './types';

interface ConnectionRow {
  connection_id: string;
  provider_id: string;
  toolkit_id: string;
  owner_id: string;
  workspace_id: string;
  label: string | null;
  state: string;
  authorization_url: string | null;
  user_code: string | null;
  expires_at: number | null;
  reconnect_account_id: string | null;
}

interface ReceiptRow {
  receipt_id: string;
  provider_id: string;
  toolkit_id: string;
  action_id: string;
  account_id: string;
  schema_version: string;
  provider_action_version: string;
  request_id: string;
  idempotency_key: string;
  reconciliation_json: string;
  job_id: string | null;
  attempt_id: string | null;
  generation: number | null;
  tool_call_id: string | null;
  effect_id: string | null;
  state: string;
  external_ref: string | null;
  result_digest: string | null;
  error_category: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

export interface IntegrationActionInput {
  providerId: string;
  toolkitId: string;
  actionId: string;
  schemaVersion: string;
  providerActionVersion: string;
  accountId?: string;
  ownerId: string;
  workspaceId: string;
  input: Record<string, unknown>;
  requestId: string;
  signal?: AbortSignal;
}

export interface ProjectedIntegrationResult {
  outcome: 'succeeded' | 'failed' | 'unknown';
  externalRef?: string;
  content: {
    untrustedExternalContent: true;
    data: unknown;
    verification?: 'verified' | 'failed' | 'unknown';
  };
}

const SENSITIVE_KEY = /(?:^|_)(?:api_?key|access_?token|refresh_?token|token|secret|password|authorization|credential)(?:$|_)/i;
const SENSITIVE_TEXT = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+)/gi;
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g;
const HAS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function requireBoundedIdentity(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !SAFE_IDENTITY.test(value)) {
    throw new IntegrationProviderError('invalid_input', `${label} is invalid`);
  }
  return value;
}

function requireBoundedOpaqueText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || HAS_CONTROL_CHARACTER.test(value)) {
    throw new IntegrationProviderError('invalid_input', `${label} is invalid`);
  }
  return value;
}

function boundedDisplayText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new IntegrationProviderError('invalid_input', `${label} is invalid`);
  const normalized = value
    .replace(ANSI_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > maximum) {
    throw new IntegrationProviderError('invalid_input', `${label} is invalid`);
  }
  return normalized;
}

function boundedOptionalDisplayText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new IntegrationProviderError('invalid_input', `${label} is invalid`);
  const normalized = value
    .replace(ANSI_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length > maximum) throw new IntegrationProviderError('invalid_input', `${label} is invalid`);
  return normalized;
}

function schemaBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new IntegrationProviderError('invalid_input', 'Provider action schema must be bounded JSON');
  }
}

function normalizeActionDescriptor(
  action: IntegrationActionDescriptor,
  expected: { providerId: string; toolkitId: string },
): IntegrationActionDescriptor {
  if (!action || typeof action !== 'object') {
    throw new IntegrationProviderError('invalid_input', 'Provider returned an invalid action');
  }
  const providerId = requireBoundedIdentity(action.providerId, 'Provider action provider identity');
  const toolkitId = requireBoundedIdentity(action.toolkitId, 'Provider action toolkit identity');
  if (providerId !== expected.providerId || toolkitId !== expected.toolkitId) {
    throw new IntegrationProviderError('schema_drift', 'Provider returned an action outside the requested identity');
  }
  const actionId = requireBoundedIdentity(action.actionId, 'Provider action identity');
  const schemaVersion = requireBoundedIdentity(action.schemaVersion, 'Provider schema version');
  const providerActionVersion = requireBoundedIdentity(
    action.providerActionVersion,
    'Provider action version',
  );
  if (providerActionVersion.toLowerCase() === 'latest') {
    throw new IntegrationProviderError('invalid_input', 'Provider action version must be immutable');
  }
  if (action.operation !== 'read' && action.operation !== 'mutation') {
    throw new IntegrationProviderError('invalid_input', 'Provider action operation is invalid');
  }
  if (action.risk !== 'safe' && action.risk !== 'caution' && action.risk !== 'dangerous') {
    throw new IntegrationProviderError('invalid_input', 'Provider action risk is invalid');
  }
  if (!action.inputSchema || typeof action.inputSchema !== 'object' || Array.isArray(action.inputSchema)) {
    throw new IntegrationProviderError('invalid_input', 'Provider action input schema is invalid');
  }
  if (action.outputSchema !== undefined
      && (!action.outputSchema || typeof action.outputSchema !== 'object' || Array.isArray(action.outputSchema))) {
    throw new IntegrationProviderError('invalid_input', 'Provider action output schema is invalid');
  }
  if (schemaBytes(action.inputSchema) > 64_000
      || (action.outputSchema !== undefined && schemaBytes(action.outputSchema) > 64_000)) {
    throw new IntegrationProviderError('invalid_input', 'Provider action schema exceeds the Aiden size limit');
  }
  return {
    providerId,
    toolkitId,
    actionId,
    label: boundedDisplayText(action.label, 'Provider action label', 256),
    description: boundedDisplayText(action.description, 'Provider action description', 2_000),
    schemaVersion,
    providerActionVersion,
    operation: action.operation,
    risk: action.risk,
    inputSchema: structuredClone(action.inputSchema),
    ...(action.outputSchema ? { outputSchema: structuredClone(action.outputSchema) } : {}),
    supportsIdempotency: action.supportsIdempotency === true,
    supportsReadback: action.supportsReadback === true,
    supportsReconciliation: action.supportsReconciliation === true,
  };
}

function normalizeDiscoveryPage(
  page: ActionDiscoveryPage,
  expected: { providerId: string; toolkitId: string },
): ActionDiscoveryPage {
  if (!page || typeof page !== 'object' || !Array.isArray(page.actions) || page.actions.length > 100) {
    throw new IntegrationProviderError('invalid_input', 'Provider returned an invalid action page');
  }
  const actions = page.actions.map((action) => normalizeActionDescriptor(action, expected));
  const nextCursor = page.nextCursor === undefined
    ? undefined
    : requireBoundedOpaqueText(page.nextCursor, 'Provider discovery cursor', 2_048);
  return { actions, ...(nextCursor ? { nextCursor } : {}) };
}

function normalizeConnectionResult(
  value: ProviderConnectionResult,
  expectedConnectionId: string,
): ProviderConnectionResult {
  if (!value || typeof value !== 'object') {
    throw new IntegrationProviderError('invalid_input', 'Provider returned an invalid connected account');
  }
  const connectionId = requireBoundedOpaqueText(value.connectionId, 'Provider connection identity', 512);
  if (connectionId !== expectedConnectionId) {
    throw new IntegrationProviderError('invalid_input', 'Provider completed a different connection identity');
  }
  const providerAccountRef = requireBoundedOpaqueText(
    value.providerAccountRef,
    'Provider account reference',
    2_048,
  );
  const providerUserRef = value.providerUserRef === undefined
    ? undefined
    : requireBoundedOpaqueText(value.providerUserRef, 'Provider user reference', 2_048);
  const hostedAuthRef = value.hostedAuthRef === undefined
    ? undefined
    : requireBoundedOpaqueText(value.hostedAuthRef, 'Hosted authorization reference', 2_048);
  if (!Array.isArray(value.scopes) || value.scopes.length > 100) {
    throw new IntegrationProviderError('invalid_input', 'Provider account scopes are invalid');
  }
  const scopes = [...new Set(value.scopes.map((scope) => (
    boundedDisplayText(scope, 'Provider account scope', 256)
  )))].sort();
  if (value.secretValue !== undefined
      && (typeof value.secretValue !== 'string' || value.secretValue.length === 0 || value.secretValue.length > 256_000)) {
    throw new IntegrationProviderError('invalid_input', 'Provider account credential is invalid');
  }
  return {
    connectionId,
    providerAccountRef,
    ...(providerUserRef ? { providerUserRef } : {}),
    label: boundedOptionalDisplayText(value.label, 'Provider account label', 256),
    scopes,
    ...(hostedAuthRef ? { hostedAuthRef } : {}),
    ...(value.secretValue !== undefined ? { secretValue: value.secretValue } : {}),
  };
}

function normalizeProviderHealth(value: IntegrationProviderHealth): IntegrationProviderHealth {
  const states = new Set(['healthy', 'degraded', 'unavailable', 'not_configured']);
  if (!value || typeof value !== 'object' || !states.has(value.state)
      || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0) {
    throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned invalid health state');
  }
  const detail = value.detail === undefined
    ? undefined
    : boundedDisplayText(value.detail, 'Provider health detail', 500);
  return { state: value.state, checkedAt: value.checkedAt, ...(detail ? { detail } : {}) };
}

function normalizeToolkits(
  value: IntegrationToolkitDescriptor[],
): IntegrationToolkitDescriptor[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned invalid app metadata');
  }
  const seen = new Set<string>();
  return value.map((toolkit) => {
    if (!toolkit || typeof toolkit !== 'object') {
      throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned invalid app metadata');
    }
    const toolkitId = requireBoundedIdentity(toolkit.toolkitId, 'Provider toolkit identity');
    if (seen.has(toolkitId)) {
      throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned duplicate app identity');
    }
    seen.add(toolkitId);
    return {
      toolkitId,
      label: boundedDisplayText(toolkit.label, 'Provider toolkit label', 256),
      connectionRequired: toolkit.connectionRequired === true,
    };
  });
}

function normalizeExecutionResult(value: IntegrationExecutionResult): IntegrationExecutionResult {
  if (!value || typeof value !== 'object'
      || (value.outcome !== 'succeeded' && value.outcome !== 'failed' && value.outcome !== 'unknown')) {
    throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned an invalid result');
  }
  const externalRef = value.externalRef === undefined
    ? undefined
    : requireBoundedOpaqueText(value.externalRef, 'Provider result reference', 2_048);
  let result: unknown;
  if (value.result !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value.result);
    } catch {
      throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned an invalid result');
    }
    if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
      throw new IntegrationProviderError('provider_unavailable', 'Integration provider result exceeds the Aiden size limit');
    }
    result = structuredClone(value.result);
  }
  const allowedCategories = new Set<IntegrationErrorCategory>([
    'auth_expired', 'permission_denied', 'account_not_found', 'account_selection_required',
    'action_not_found', 'schema_drift', 'rate_limited', 'provider_unavailable', 'timeout',
    'outcome_unknown', 'cancelled', 'invalid_input', 'verification_failed',
  ]);
  if (value.errorCategory !== undefined && !allowedCategories.has(value.errorCategory)) {
    throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned an invalid error category');
  }
  const safeMessage = value.safeMessage === undefined
    ? undefined
    : boundedDisplayText(value.safeMessage, 'Provider result message', 2_000);
  const retryAfterMs = value.retryAfterMs === undefined ? undefined : Number(value.retryAfterMs);
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 86_400_000)) {
    throw new IntegrationProviderError('provider_unavailable', 'Integration provider returned an invalid retry interval');
  }
  return {
    outcome: value.outcome,
    ...(value.reconciliationOutcome === 'occurred'
      || value.reconciliationOutcome === 'did_not_occur'
      || value.reconciliationOutcome === 'unknown'
      ? { reconciliationOutcome: value.reconciliationOutcome }
      : {}),
    ...(externalRef ? { externalRef } : {}),
    ...(value.result !== undefined ? { result } : {}),
    ...(value.errorCategory ? { errorCategory: value.errorCategory } : {}),
    ...(safeMessage ? { safeMessage } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function validateAuthorizationUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > 4_096) {
    throw new IntegrationProviderError('invalid_input', 'Connection authorization URL is invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new IntegrationProviderError('invalid_input', 'Connection authorization URL is invalid');
  }
  const localLoopback = parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]');
  if ((parsed.protocol !== 'https:' && !localLoopback) || parsed.username || parsed.password) {
    throw new IntegrationProviderError('invalid_input', 'Connection authorization URL is not allowed');
  }
  return parsed.toString();
}

function rejectPreDispatchCancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new IntegrationProviderError('cancelled', 'Integration action was cancelled before dispatch');
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
}

function containsSecretShape(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object') return false;
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((item) => containsSecretShape(item, depth + 1));
  return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => SENSITIVE_KEY.test(key) || containsSecretShape(child, depth + 1));
}

export function validateIntegrationInput(value: Record<string, unknown>): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 'Integration action input must be valid bounded JSON';
  }
  if (Buffer.byteLength(serialized, 'utf8') > 64_000) {
    return 'Integration action input exceeds the Aiden size limit';
  }
  return containsSecretShape(value)
    ? 'Integration action input must not contain credentials or secret-shaped fields'
    : null;
}

function matchesSchemaType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  return typeof value === type;
}

function validateSchemaValue(schema: unknown, value: unknown, path = 'input', depth = 0): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 8) return null;
  const spec = schema as Record<string, unknown>;
  const types = typeof spec.type === 'string'
    ? [spec.type]
    : Array.isArray(spec.type) ? spec.type.filter((entry): entry is string => typeof entry === 'string') : [];
  if (types.length && !types.some((type) => matchesSchemaType(value, type))) {
    return `${path} must be ${types.join(' or ')}`;
  }
  if (Array.isArray(spec.enum) && !spec.enum.some((candidate) => Object.is(candidate, value))) {
    return `${path} must use an allowed value`;
  }
  if (typeof value === 'string') {
    if (typeof spec.minLength === 'number' && [...value].length < spec.minLength) return `${path} is too short`;
    if (typeof spec.maxLength === 'number' && [...value].length > spec.maxLength) return `${path} is too long`;
  }
  if (typeof value === 'number') {
    if (typeof spec.minimum === 'number' && value < spec.minimum) return `${path} is below the allowed minimum`;
    if (typeof spec.maximum === 'number' && value > spec.maximum) return `${path} exceeds the allowed maximum`;
  }
  if (Array.isArray(value)) {
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) return `${path} has too few items`;
    if (typeof spec.maxItems === 'number' && value.length > spec.maxItems) return `${path} has too many items`;
    if (spec.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateSchemaValue(spec.items, value[index], `${path}[${index}]`, depth + 1);
        if (error) return error;
      }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(spec.required)
      ? spec.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) {
      if (!(key in record) || record[key] === undefined || record[key] === null) return `${path}.${key} is required`;
    }
    const properties = spec.properties && typeof spec.properties === 'object' && !Array.isArray(spec.properties)
      ? spec.properties as Record<string, unknown> : {};
    if (spec.additionalProperties === false) {
      const unknown = Object.keys(record).find((key) => !(key in properties));
      if (unknown) return `${path}.${unknown} is not allowed`;
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in record) || record[key] === undefined) continue;
      const error = validateSchemaValue(childSchema, record[key], `${path}.${key}`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

interface ProjectionBudget { nodes: number; characters: number }

export function sanitizeIntegrationValue(
  value: unknown,
  depth = 0,
  budget: ProjectionBudget = { nodes: 512, characters: 50_000 },
  sensitiveValues: readonly string[] = [],
): unknown {
  if (budget.nodes <= 0 || budget.characters <= 0) return '[truncated]';
  budget.nodes -= 1;
  if (typeof value === 'string') {
    let redacted = value.replace(SENSITIVE_TEXT, '[redacted]');
    for (const sensitive of sensitiveValues) {
      if (sensitive.length >= 4) redacted = redacted.split(sensitive).join('[redacted]');
    }
    const length = Math.max(0, Math.min(8_000, budget.characters));
    const projected = [...redacted].slice(0, length).join('');
    budget.characters -= projected.length;
    return projected;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeIntegrationValue(item, depth + 1, budget, sensitiveValues));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, child]) => {
      const safeKey = key.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 256) || '[field]';
      return [
        safeKey,
        SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeIntegrationValue(child, depth + 1, budget, sensitiveValues),
      ];
    }));
  }
  return String(value).slice(0, 2_000);
}

export function normalizeIntegrationError(error: unknown): IntegrationProviderError {
  if (error instanceof IntegrationProviderError) return error;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = Number(record.status ?? record.statusCode ?? (record.response as { status?: unknown } | undefined)?.status);
  const code = String(record.code ?? (record.cause as { code?: unknown } | undefined)?.code ?? '').toUpperCase();
  let category: IntegrationErrorCategory = 'provider_unavailable';
  if (status === 408 || status === 504 || code.includes('TIMEOUT') || code.includes('TIMEDOUT')) category = 'timeout';
  else if (status === 401) category = 'auth_expired';
  else if (status === 403) category = 'permission_denied';
  else if (status === 404) category = 'action_not_found';
  else if (status === 409 || status === 422) category = 'schema_drift';
  else if (status === 429) category = 'rate_limited';
  const retryAfter = Number(record.retryAfterMs ?? (record.response as { retryAfterMs?: unknown } | undefined)?.retryAfterMs);
  return new IntegrationProviderError(category, `Integration ${category.replace(/_/g, ' ')}`, {
    ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterMs: retryAfter } : {}),
  });
}

export class IntegrationActionAuthority {
  readonly db: Db;
  readonly providers: IntegrationProviderRegistry;
  readonly accounts: ConnectedAccountAuthority;
  readonly schemas: IntegrationActionSchemaAuthority;
  readonly secrets: SecretAuthority;

  constructor(options: {
    db: Db;
    providers: IntegrationProviderRegistry;
    accounts: ConnectedAccountAuthority;
    schemas: IntegrationActionSchemaAuthority;
    secrets: SecretAuthority;
  }) {
    this.db = options.db;
    this.providers = options.providers;
    this.accounts = options.accounts;
    this.schemas = options.schemas;
    this.secrets = options.secrets;
  }

  async configureProvider(input: {
    providerId: string; ownerId: string; workspaceId: string; credential: string;
  }): Promise<void> {
    const providerId = requireBoundedIdentity(input.providerId, 'Provider identity', 64);
    const ownerId = requireBoundedIdentity(input.ownerId, 'Owner identity');
    const workspaceId = requireBoundedIdentity(input.workspaceId, 'Workspace identity');
    if (typeof input.credential !== 'string' || !input.credential.trim() || input.credential.length > 256_000) {
      throw new IntegrationProviderError('invalid_input', 'Provider credential is invalid');
    }
    this.providers.require(providerId);
    const existing = this.db.prepare(
      'SELECT secret_handle FROM integration_provider_credentials WHERE provider_id=? AND workspace_id=? AND owner_id=?',
    ).get(providerId, workspaceId, ownerId) as { secret_handle: string } | undefined;
    const now = Date.now();
    if (existing) {
      await this.secrets.replace(existing.secret_handle, input.credential, { ownerId, workspaceId });
      this.db.prepare(
        `UPDATE integration_provider_credentials SET status='active',updated_at=?
         WHERE provider_id=? AND workspace_id=? AND owner_id=?`,
      ).run(now, providerId, workspaceId, ownerId);
      return;
    }
    const secretHandle = await this.secrets.create({
      namespace: { providerId, ownerId, workspaceId },
      label: `${providerId} provider credential`,
      value: input.credential,
      now,
    });
    try {
      this.db.prepare(
        `INSERT INTO integration_provider_credentials
           (provider_id,workspace_id,owner_id,secret_handle,status,created_at,updated_at)
         VALUES (?,?,?,?, 'active',?,?)`,
      ).run(providerId, workspaceId, ownerId, secretHandle, now, now);
    } catch (error) {
      await this.secrets.delete(secretHandle, { ownerId, workspaceId }).catch(() => undefined);
      throw error;
    }
  }

  async providerHealth(input: { providerId: string; ownerId: string; workspaceId: string }) {
    const providerId = requireBoundedIdentity(input.providerId, 'Provider identity', 64);
    const ownerId = requireBoundedIdentity(input.ownerId, 'Owner identity');
    const workspaceId = requireBoundedIdentity(input.workspaceId, 'Workspace identity');
    const provider = this.providers.require(providerId);
    const providerCredential = await this.resolveProviderCredential({ providerId, ownerId, workspaceId })
      .catch(() => undefined);
    try {
      return normalizeProviderHealth(await provider.health({ providerCredential }));
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async listToolkits(input: { providerId: string; ownerId: string; workspaceId: string }) {
    const providerId = requireBoundedIdentity(input.providerId, 'Provider identity', 64);
    const ownerId = requireBoundedIdentity(input.ownerId, 'Owner identity');
    const workspaceId = requireBoundedIdentity(input.workspaceId, 'Workspace identity');
    const provider = this.providers.require(providerId);
    const providerCredential = await this.resolveProviderCredential({ providerId, ownerId, workspaceId })
      .catch(() => undefined);
    try {
      return normalizeToolkits(await provider.listToolkits({ providerCredential }));
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
  }

  async initiateConnection(input: {
    providerId: string; toolkitId: string; ownerId: string; workspaceId: string; label?: string;
    reconnectAccountId?: string;
  }) {
    const providerId = requireBoundedIdentity(input.providerId, 'Provider identity', 64);
    const toolkitId = requireBoundedIdentity(input.toolkitId, 'Toolkit identity');
    const ownerId = requireBoundedIdentity(input.ownerId, 'Owner identity');
    const workspaceId = requireBoundedIdentity(input.workspaceId, 'Workspace identity');
    const label = input.label === undefined
      ? undefined
      : boundedOptionalDisplayText(input.label, 'Connected account label', 120);
    const reconnectAccountId = input.reconnectAccountId === undefined
      ? undefined
      : requireBoundedIdentity(input.reconnectAccountId, 'Connected account identity', 256);
    if (reconnectAccountId) {
      const account = this.accounts.requireInScope(reconnectAccountId, { ownerId, workspaceId });
      if (account.providerId !== providerId || account.toolkitId !== toolkitId) {
        throw new IntegrationProviderError('invalid_input', 'Reconnect does not match the connected app authority');
      }
    }
    const provider = this.providers.require(providerId);
    const providerCredential = await this.resolveProviderCredential({ providerId, ownerId, workspaceId })
      .catch(() => undefined);
    let start: ProviderConnectionStart;
    try {
      start = await provider.initiateConnection({
        toolkitId,
        ownerId,
        workspaceId,
        label,
        providerCredential,
      });
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    const connectionId = requireBoundedOpaqueText(start.connectionId, 'Provider connection identity', 512);
    if (start.state !== 'pending' && start.state !== 'completed') {
      throw new IntegrationProviderError('invalid_input', 'Provider connection state is invalid');
    }
    const authorizationUrl = validateAuthorizationUrl(start.authorizationUrl);
    const userCode = start.userCode === undefined
      ? undefined
      : requireBoundedOpaqueText(start.userCode, 'Provider connection user code', 256);
    const expiresAt = start.expiresAt === undefined ? undefined : Number(start.expiresAt);
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) {
      throw new IntegrationProviderError('invalid_input', 'Provider connection expiry is invalid');
    }
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO integration_connection_sessions
         (connection_id,provider_id,toolkit_id,owner_id,workspace_id,label,state,
          authorization_url,user_code,expires_at,created_at,updated_at,reconnect_account_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      connectionId, providerId, toolkitId, ownerId, workspaceId,
      label ?? null, start.state, null, null,
      expiresAt ?? null, now, now, reconnectAccountId ?? null,
    );
    return {
      connectionId,
      state: start.state,
      ...(authorizationUrl ? { authorizationUrl } : {}),
      ...(userCode ? { userCode } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }

  async completeConnection(input: { connectionId: string; ownerId: string; workspaceId: string }): Promise<ConnectedAccountRecord> {
    const connectionId = requireBoundedOpaqueText(input.connectionId, 'Provider connection identity', 512);
    const ownerId = requireBoundedIdentity(input.ownerId, 'Owner identity');
    const workspaceId = requireBoundedIdentity(input.workspaceId, 'Workspace identity');
    const row = this.db.prepare('SELECT * FROM integration_connection_sessions WHERE connection_id=?')
      .get(connectionId) as ConnectionRow | undefined;
    if (!row || row.owner_id !== ownerId || row.workspace_id !== workspaceId) {
      throw new IntegrationProviderError('account_not_found', 'Connection is not available in this scope');
    }
    if (row.state === 'completed') {
      const accountId = this.db.prepare(
        'SELECT completed_account_id FROM integration_connection_sessions WHERE connection_id=?',
      ).pluck().get(connectionId) as string | undefined;
      if (accountId) return this.accounts.require(accountId);
    }
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.db.prepare(
        "UPDATE integration_connection_sessions SET state='expired',updated_at=? WHERE connection_id=?",
      ).run(Date.now(), row.connection_id);
      throw new IntegrationProviderError('auth_expired', 'Connection authorization expired; reconnect the account');
    }
    const provider = this.providers.require(row.provider_id);
    const providerCredential = await this.resolveProviderCredential({
      providerId: row.provider_id, ownerId: row.owner_id, workspaceId: row.workspace_id,
    }).catch(() => undefined);
    let completed: ProviderConnectionResult;
    try {
      completed = normalizeConnectionResult(
        await provider.completeConnection({ connectionId: row.connection_id, providerCredential }),
        row.connection_id,
      );
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    const existingAccountId = this.db.prepare(
      `SELECT account_id FROM connected_accounts
       WHERE provider_id=? AND provider_account_ref=? AND workspace_id=? AND owner_id=?`,
    ).pluck().get(
      row.provider_id, completed.providerAccountRef, row.workspace_id, row.owner_id,
    ) as string | undefined;
    if (row.reconnect_account_id && existingAccountId && row.reconnect_account_id !== existingAccountId) {
      throw new IntegrationProviderError('invalid_input', 'Reconnect resolved to a different existing connected account');
    }
    const targetAccountId = row.reconnect_account_id ?? existingAccountId ?? null;
    const targetAccount = targetAccountId
      ? this.accounts.requireInScope(targetAccountId, { ownerId: row.owner_id, workspaceId: row.workspace_id })
      : null;
    if (targetAccount && (targetAccount.providerId !== row.provider_id || targetAccount.toolkitId !== row.toolkit_id)) {
      throw new IntegrationProviderError('invalid_input', 'Reconnect does not match the connected app authority');
    }
    let secretHandle: string | null = null;
    if (completed.secretValue) {
      secretHandle = await this.secrets.create({
        namespace: {
          providerId: row.provider_id, ownerId: row.owner_id, workspaceId: row.workspace_id,
          ...(targetAccountId ? { accountId: targetAccountId } : {}),
        },
        label: `${row.toolkit_id} account credential`,
        value: completed.secretValue,
      });
    }
    try {
      const account = this.db.transaction(() => {
        const resolved = targetAccount
          ? this.accounts.reactivate({
              accountId: targetAccount.accountId,
              providerId: row.provider_id,
              toolkitId: row.toolkit_id,
              ownerId: row.owner_id,
              workspaceId: row.workspace_id,
              label: completed.label || row.label || targetAccount.label,
              providerAccountRef: completed.providerAccountRef,
              providerUserRef: completed.providerUserRef ?? null,
              secretHandle,
              hostedAuthRef: completed.hostedAuthRef ?? null,
              scopes: completed.scopes,
            })
          : this.accounts.create({
          providerId: row.provider_id,
          toolkitId: row.toolkit_id,
          ownerId: row.owner_id,
          workspaceId: row.workspace_id,
          label: completed.label || row.label || row.toolkit_id,
          providerAccountRef: completed.providerAccountRef,
          providerUserRef: completed.providerUserRef ?? null,
          secretHandle,
          hostedAuthRef: completed.hostedAuthRef ?? null,
          scopes: completed.scopes,
        });
        this.db.prepare(
          `UPDATE integration_connection_sessions
           SET state='completed',completed_account_id=?,updated_at=? WHERE connection_id=?`,
        ).run(resolved.accountId, Date.now(), row.connection_id);
        return resolved;
      }).immediate();
      if (targetAccount?.secretHandle && secretHandle && targetAccount.secretHandle !== secretHandle) {
        await this.secrets.delete(targetAccount.secretHandle, {
          ownerId: row.owner_id, workspaceId: row.workspace_id,
        }).catch(() => undefined);
      }
      return account;
    } catch (error) {
      if (secretHandle) await this.secrets.delete(secretHandle, {
        ownerId: row.owner_id, workspaceId: row.workspace_id,
      }).catch(() => undefined);
      throw error;
    }
  }

  async refreshAccount(input: { accountId: string; ownerId: string; workspaceId: string }): Promise<ConnectedAccountRecord> {
    const account = this.accounts.requireInScope(input.accountId, input);
    if (account.status === 'revoked') {
      throw new IntegrationProviderError('account_not_found', 'Connected account is revoked and must be reconnected');
    }
    const provider = this.providers.require(account.providerId);
    const credentials = await this.resolveCredentials(account);
    try {
      const health = await provider.refreshAccount({ providerAccountRef: account.providerAccountRef, credentials });
      return this.accounts.updateHealth({ ...input, ...health });
    } catch (error) {
      const normalized = normalizeIntegrationError(error);
      if (normalized.category === 'auth_expired') {
        return this.accounts.updateHealth({ ...input, status: 'expired', health: 'expired' });
      }
      if (normalized.category === 'permission_denied') {
        return this.accounts.updateHealth({ ...input, status: 'degraded', health: 'insufficient_scope' });
      }
      this.accounts.updateHealth({ ...input, status: 'degraded', health: 'degraded' });
      throw normalized;
    }
  }

  async disconnect(input: { accountId: string; ownerId: string; workspaceId: string }): Promise<ConnectedAccountRecord> {
    const account = this.accounts.require(input.accountId);
    if (account.ownerId !== input.ownerId || account.workspaceId !== input.workspaceId) {
      throw new IntegrationProviderError('account_not_found', 'Connected account is not available in this scope');
    }
    const provider = this.providers.require(account.providerId);
    const credentials = await this.resolveCredentials(account);
    const revoked = this.accounts.revoke(account.accountId, input);
    let localCleanupFailed = false;
    if (account.secretHandle) {
      try {
        await this.secrets.revoke(account.secretHandle, input);
        await this.secrets.delete(account.secretHandle, input);
      } catch {
        localCleanupFailed = true;
      }
    }
    try {
      await provider.revokeAccount({ providerAccountRef: account.providerAccountRef, credentials });
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    if (localCleanupFailed) {
      throw new IntegrationProviderError(
        'provider_unavailable',
        'Connected account was revoked, but local credential cleanup requires attention',
      );
    }
    return revoked;
  }

  async discoverActions(input: {
    providerId: string; toolkitId: string; cursor?: string; limit: number;
    ownerId?: string; workspaceId?: string;
  }) {
    const providerId = requireBoundedIdentity(input.providerId, 'Provider identity', 64);
    const toolkitId = requireBoundedIdentity(input.toolkitId, 'Toolkit identity');
    const cursor = input.cursor === undefined
      ? undefined
      : requireBoundedOpaqueText(input.cursor, 'Provider discovery cursor', 2_048);
    if (!Number.isFinite(input.limit)) {
      throw new IntegrationProviderError('invalid_input', 'Provider discovery limit is invalid');
    }
    const provider = this.providers.require(providerId);
    const providerCredential = await this.resolveProviderCredential({
      providerId,
      ownerId: requireBoundedIdentity(input.ownerId ?? 'local-user', 'Owner identity'),
      workspaceId: requireBoundedIdentity(input.workspaceId ?? 'default', 'Workspace identity'),
    }).catch(() => undefined);
    let rawPage: ActionDiscoveryPage;
    try {
      rawPage = await provider.discoverActions({
        toolkitId,
        cursor,
        limit: Math.max(1, Math.min(100, Math.trunc(input.limit))),
        providerCredential,
      });
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    const page = normalizeDiscoveryPage(rawPage, { providerId: provider.id, toolkitId });
    for (const action of page.actions) {
      this.schemas.pin(action);
    }
    return page;
  }

  async executeRead(input: IntegrationActionInput): Promise<ProjectedIntegrationResult> {
    rejectPreDispatchCancellation(input.signal);
    const resolved = await this.resolveExecution(input, 'read');
    rejectPreDispatchCancellation(input.signal);
    const executionContext = currentJobExecutionContext();
    let result: IntegrationExecutionResult;
    try {
      result = normalizeExecutionResult(await resolved.provider.execute({
        ...this.providerRequest(input, resolved.account),
        credentials: resolved.credentials,
      }));
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    this.assertAccountAuthority(resolved.account, executionContext, input.signal, {
      afterDispatch: true,
      mutationOutcomeUnknown: false,
      externalRef: result.externalRef,
    });
    const projected = this.project(result, resolved.credentials);
    this.recordEvidence(
      input, resolved.account, resolved.action, result, 'unknown', 'partial', false, undefined, resolved.credentials,
    );
    return projected;
  }

  async executeMutation(input: IntegrationActionInput): Promise<ProjectedIntegrationResult> {
    rejectPreDispatchCancellation(input.signal);
    const resolved = await this.resolveExecution(input, 'mutation');
    rejectPreDispatchCancellation(input.signal);
    const idempotencyKey = this.mutationIdempotencyKey(input);
    const existing = this.receiptForExecution(
      input.providerId, resolved.account.accountId, input.requestId, idempotencyKey,
    );
    if (existing) {
      if (existing.state === 'unknown' || existing.state === 'reconciling') {
        throw new IntegrationProviderError('outcome_unknown', 'Prior mutation outcome requires reconciliation', {
          externalRef: existing.external_ref ?? undefined,
        });
      }
      if (existing.state === 'verified' || existing.state === 'succeeded') {
        return this.reconcile({ receiptId: existing.receipt_id });
      }
      throw new IntegrationProviderError('outcome_unknown', 'Mutation receipt already exists and cannot be replayed');
    }
    const providerRequest = {
      ...this.providerRequest(input, resolved.account, idempotencyKey),
      credentials: resolved.credentials,
    };
    const reconciliationData = resolved.provider.reconciliationData?.(providerRequest) ?? {};
    const reconciliationError = validateIntegrationInput(reconciliationData);
    if (reconciliationError || Buffer.byteLength(JSON.stringify(reconciliationData), 'utf8') > 8_000) {
      throw new IntegrationProviderError('invalid_input', 'Provider reconciliation identity is invalid');
    }
    const receipt = this.prepareReceipt(input, resolved.account, idempotencyKey, reconciliationData);
    this.updateReceipt(receipt.receipt_id, { state: 'dispatched' });
    const executionContext = currentJobExecutionContext();
    let result: IntegrationExecutionResult;
    try {
      result = normalizeExecutionResult(await resolved.provider.execute({
        ...providerRequest,
      }));
    } catch (error) {
      const normalized = normalizeIntegrationError(error);
      const rejectedBeforePhysicalDispatch = normalized.safeDetail === 'aiden_pre_dispatch_authority';
      if (!rejectedBeforePhysicalDispatch) {
        this.assertAccountAuthority(resolved.account, executionContext, input.signal, {
          afterDispatch: true,
          mutationOutcomeUnknown: true,
          externalRef: normalized.externalRef,
        });
      }
      const uncertain = !rejectedBeforePhysicalDispatch && (normalized.category === 'cancelled'
        || normalized.category === 'timeout'
        || normalized.category === 'provider_unavailable'
        || !(error instanceof IntegrationProviderError));
      const terminalError = uncertain
        ? new IntegrationProviderError(
            'outcome_unknown',
            'Integration mutation outcome is unknown after dispatch',
            { externalRef: normalized.externalRef, retryAfterMs: normalized.retryAfterMs, cause: normalized },
          )
        : normalized;
      this.updateReceipt(receipt.receipt_id, {
        state: terminalError.category === 'outcome_unknown' ? 'unknown' : 'failed',
        externalRef: terminalError.externalRef ?? null,
        errorCategory: terminalError.category,
        settled: terminalError.category !== 'outcome_unknown',
      });
      throw terminalError;
    }
    this.assertAccountAuthority(resolved.account, executionContext, input.signal, {
      afterDispatch: true,
      mutationOutcomeUnknown: true,
      externalRef: result.externalRef,
    });
    if (result.outcome !== 'succeeded') {
      const category = result.errorCategory ?? (result.outcome === 'unknown' ? 'outcome_unknown' : 'provider_unavailable');
      this.updateReceipt(receipt.receipt_id, {
        state: result.outcome === 'unknown' ? 'unknown' : 'failed',
        externalRef: result.externalRef ?? null,
        errorCategory: category,
        settled: result.outcome !== 'unknown',
      });
      throw new IntegrationProviderError(category, result.safeMessage ?? 'Integration mutation did not complete', {
        externalRef: result.externalRef,
        retryAfterMs: result.retryAfterMs,
      });
    }
    this.updateReceipt(receipt.receipt_id, {
      state: 'succeeded', externalRef: result.externalRef ?? null, resultDigest: digest(result.result),
    });
    const readback = await resolved.provider.readback({
      ...this.providerRequest(input, resolved.account, idempotencyKey),
      credentials: resolved.credentials,
      externalRef: result.externalRef,
      executionResult: result.result,
    }).then(normalizeExecutionResult).catch((error) => {
      const normalized = normalizeIntegrationError(error);
      if (normalized.safeDetail === 'aiden_pre_dispatch_authority') {
        throw new IntegrationProviderError(
          'outcome_unknown', 'Integration mutation completed but readback authority changed',
          {
            externalRef: result.externalRef,
            safeDetail: 'aiden_post_dispatch_authority',
            cause: normalized,
          },
        );
      }
      return {
        outcome: 'unknown' as const,
        errorCategory: normalized.category,
        safeMessage: 'Readback was unavailable',
      };
    });
    this.assertAccountAuthority(resolved.account, executionContext, input.signal, {
      afterDispatch: true,
      mutationOutcomeUnknown: true,
      externalRef: result.externalRef,
    });
    const verification = readback.outcome === 'succeeded'
      ? 'verified' as const
      : readback.outcome === 'failed' ? 'failed' as const : 'unknown' as const;
    if (verification === 'verified') {
      this.updateReceipt(receipt.receipt_id, { state: 'verified', settled: true });
    } else {
      this.updateReceipt(receipt.receipt_id, {
        state: verification === 'unknown' ? 'unknown' : 'succeeded',
        errorCategory: readback.errorCategory ?? 'verification_failed',
        settled: verification === 'failed',
      });
    }
    this.recordEvidence(
      input, resolved.account, resolved.action, readback,
      verification, verification === 'unknown' ? 'unknown' : 'full', true, undefined, resolved.credentials,
    );
    const projected = this.project(result, resolved.credentials);
    return { ...projected, content: { ...projected.content, verification } };
  }

  async reconcile(input: { receiptId: string }): Promise<ProjectedIntegrationResult> {
    const receipt = this.receipt(input.receiptId);
    if (!receipt) throw new IntegrationProviderError('outcome_unknown', 'Integration receipt is not available');
    const context = currentJobExecutionContext();
    if (context && receipt.job_id && context.jobId !== receipt.job_id) {
      throw new IntegrationProviderError('permission_denied', 'Integration receipt belongs to a different Job');
    }
    const account = this.accounts.require(receipt.account_id);
    const provider = this.providers.require(receipt.provider_id);
    const action = this.schemas.requireExact({
      providerId: receipt.provider_id,
      toolkitId: receipt.toolkit_id,
      actionId: receipt.action_id,
      schemaVersion: receipt.schema_version,
      providerActionVersion: receipt.provider_action_version,
    });
    const credentials = await this.resolveCredentials(account);
    const executionContext = currentJobExecutionContext();
    this.assertAccountAuthority(account, executionContext, undefined, {
      afterDispatch: false,
      mutationOutcomeUnknown: true,
      externalRef: receipt.external_ref ?? undefined,
    });
    this.updateReceipt(receipt.receipt_id, { state: 'reconciling' });
    let result: IntegrationExecutionResult;
    try {
      result = normalizeExecutionResult(await provider.reconcile({
        toolkitId: receipt.toolkit_id,
        actionId: receipt.action_id,
        schemaVersion: receipt.schema_version,
        providerActionVersion: receipt.provider_action_version,
        providerAccountRef: account.providerAccountRef,
        providerUserRef: account.providerUserRef ?? undefined,
        input: this.receiptReconciliationData(receipt),
        idempotencyKey: receipt.idempotency_key,
        credentials,
        externalRef: receipt.external_ref ?? undefined,
        authorizeDispatch: this.authorizeAccountDispatch(account),
      }));
    } catch (error) {
      const normalized = normalizeIntegrationError(error);
      if (normalized.safeDetail === 'aiden_pre_dispatch_authority') {
        if (!this.executionAuthorityLost(executionContext)) {
          this.updateReceipt(receipt.receipt_id, {
            state: 'unknown', errorCategory: normalized.category, settled: false,
          });
        }
        throw new IntegrationProviderError('outcome_unknown', 'Integration mutation outcome remains unknown', {
          externalRef: receipt.external_ref ?? normalized.externalRef,
          safeDetail: 'aiden_post_dispatch_authority',
          cause: normalized,
        });
      }
      this.assertAccountAuthority(account, executionContext, undefined, {
        afterDispatch: true,
        mutationOutcomeUnknown: true,
        externalRef: receipt.external_ref ?? normalized.externalRef,
      });
      this.updateReceipt(receipt.receipt_id, {
        state: 'unknown',
        errorCategory: normalized.category,
        settled: false,
      });
      throw new IntegrationProviderError('outcome_unknown', 'Integration mutation outcome remains unknown', {
        externalRef: receipt.external_ref ?? normalized.externalRef,
        retryAfterMs: normalized.retryAfterMs,
        cause: normalized,
      });
    }
    this.assertAccountAuthority(account, executionContext, undefined, {
      afterDispatch: true,
      mutationOutcomeUnknown: true,
      externalRef: result.externalRef ?? receipt.external_ref ?? undefined,
    });
    const reconciliationOutcome = result.outcome === 'succeeded'
      ? 'occurred' as const
      : result.reconciliationOutcome === 'did_not_occur'
        ? 'did_not_occur' as const
        : 'unknown' as const;
    this.recordDurableEffectReconciliation(receipt, result, reconciliationOutcome);
    if (reconciliationOutcome === 'occurred') {
      this.updateReceipt(receipt.receipt_id, {
        state: 'verified', externalRef: result.externalRef ?? receipt.external_ref,
        resultDigest: digest(result.result), settled: true,
      });
      this.recordEvidence({
        providerId: receipt.provider_id, toolkitId: receipt.toolkit_id, actionId: receipt.action_id,
        schemaVersion: receipt.schema_version, providerActionVersion: receipt.provider_action_version,
        accountId: receipt.account_id, ownerId: account.ownerId, workspaceId: account.workspaceId,
        input: {}, requestId: receipt.request_id,
      }, account, action, result, 'verified', 'full', true, 'reconciliation', credentials, receipt.effect_id);
    } else {
      this.updateReceipt(receipt.receipt_id, {
        state: reconciliationOutcome === 'did_not_occur' ? 'not_applied' : 'unknown',
        errorCategory: result.errorCategory ?? null,
        settled: reconciliationOutcome === 'did_not_occur',
      });
      this.recordEvidence({
        providerId: receipt.provider_id, toolkitId: receipt.toolkit_id, actionId: receipt.action_id,
        schemaVersion: receipt.schema_version, providerActionVersion: receipt.provider_action_version,
        accountId: receipt.account_id, ownerId: account.ownerId, workspaceId: account.workspaceId,
        input: {}, requestId: receipt.request_id,
      }, account, action, result,
      reconciliationOutcome === 'did_not_occur' ? 'failed' : 'unknown',
      reconciliationOutcome === 'did_not_occur' ? 'full' : 'unknown',
      true, 'reconciliation', credentials, receipt.effect_id);
    }
    return this.project(result, credentials);
  }

  receiptFor(providerId: string, accountId: string, requestId: string): {
    receiptId: string;
    state: string;
    externalRef: string | null;
  } | null {
    const row = (this.db.prepare(
      `SELECT * FROM integration_action_receipts
       WHERE provider_id=? AND account_id=? AND request_id=?
       ORDER BY created_at DESC,receipt_id DESC LIMIT 1`,
    ).get(providerId, accountId, requestId) as ReceiptRow | undefined) ?? null;
    return row ? { receiptId: row.receipt_id, state: row.state, externalRef: row.external_ref } : null;
  }

  private receiptForRow(providerId: string, accountId: string, idempotencyKey: string): ReceiptRow | null {
    return (this.db.prepare(
      'SELECT * FROM integration_action_receipts WHERE provider_id=? AND account_id=? AND idempotency_key=?',
    ).get(providerId, accountId, idempotencyKey) as ReceiptRow | undefined) ?? null;
  }

  private receiptForExecution(
    providerId: string,
    accountId: string,
    requestId: string,
    idempotencyKey: string,
  ): ReceiptRow | null {
    const context = currentJobExecutionContext();
    if (!context) return this.receiptForRow(providerId, accountId, idempotencyKey);
    return (this.db.prepare(
      `SELECT * FROM integration_action_receipts
       WHERE provider_id=? AND account_id=? AND job_id=? AND request_id=?
       ORDER BY created_at DESC,receipt_id DESC LIMIT 1`,
    ).get(providerId, accountId, context.jobId, requestId) as ReceiptRow | undefined) ?? null;
  }

  private receipt(receiptId: string): ReceiptRow | null {
    return (this.db.prepare('SELECT * FROM integration_action_receipts WHERE receipt_id=?')
      .get(receiptId) as ReceiptRow | undefined) ?? null;
  }

  private async resolveExecution(input: IntegrationActionInput, operation: 'read' | 'mutation') {
    requireBoundedIdentity(input.providerId, 'Provider identity', 64);
    requireBoundedIdentity(input.toolkitId, 'Toolkit identity');
    requireBoundedIdentity(input.actionId, 'Action identity');
    requireBoundedIdentity(input.schemaVersion, 'Action schema version');
    const providerActionVersion = requireBoundedIdentity(input.providerActionVersion, 'Provider action version');
    if (providerActionVersion.toLowerCase() === 'latest') {
      throw new IntegrationProviderError('invalid_input', 'Provider action version must be immutable');
    }
    if (input.accountId) requireBoundedIdentity(input.accountId, 'Connected account identity', 256);
    requireBoundedIdentity(input.ownerId, 'Owner identity');
    requireBoundedIdentity(input.workspaceId, 'Workspace identity');
    const inputError = validateIntegrationInput(input.input);
    if (inputError) throw new IntegrationProviderError('invalid_input', inputError);
    requireBoundedOpaqueText(input.requestId, 'Request identity', 256);
    const provider = this.providers.require(input.providerId);
    const providerCredential = await this.resolveProviderCredential(input).catch(() => undefined);
    let health: IntegrationProviderHealth;
    try {
      health = normalizeProviderHealth(await provider.health({ providerCredential }));
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    if (health.state === 'unavailable' || health.state === 'not_configured') {
      throw new IntegrationProviderError('provider_unavailable', health.detail ?? 'Integration provider is unavailable');
    }
    const account = this.accounts.resolve(input);
    let rawPage: ActionDiscoveryPage;
    try {
      rawPage = await provider.discoverActions({
        toolkitId: input.toolkitId, limit: 100, providerCredential,
      });
    } catch (error) {
      throw normalizeIntegrationError(error);
    }
    const page = normalizeDiscoveryPage(rawPage, { providerId: provider.id, toolkitId: input.toolkitId });
    const current = page.actions.find((action) => action.actionId === input.actionId);
    if (!current) throw new IntegrationProviderError('action_not_found', 'Integration action is not available');
    if (current.schemaVersion !== input.schemaVersion || current.providerActionVersion !== input.providerActionVersion) {
      throw new IntegrationProviderError('schema_drift', 'Integration action version changed; rediscover and approve the current action');
    }
    this.schemas.pin(current);
    const action = this.schemas.requireExact(input);
    if (action.operation !== operation) {
      throw new IntegrationProviderError('permission_denied', `A ${action.operation} action cannot use the ${operation} execution path`);
    }
    const schemaError = validateSchemaValue(action.inputSchema, input.input);
    if (schemaError) throw new IntegrationProviderError('invalid_input', schemaError);
    const credentials = await this.resolveCredentials(account);
    const currentAccount = this.accounts.resolve({
      providerId: input.providerId,
      toolkitId: input.toolkitId,
      accountId: account.accountId,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
    });
    const context = currentJobExecutionContext();
    if (context) {
      this.accounts.bindJob({
        jobId: context.jobId,
        attemptId: context.attemptId,
        generation: context.generation,
        account: currentAccount,
      });
    }
    return { provider, account: currentAccount, action, credentials };
  }

  private providerRequest(
    input: IntegrationActionInput,
    account: ConnectedAccountRecord,
    idempotencyKey = input.requestId,
  ) {
    return {
      toolkitId: input.toolkitId,
      actionId: input.actionId,
      schemaVersion: input.schemaVersion,
      providerActionVersion: input.providerActionVersion,
      providerAccountRef: account.providerAccountRef,
      providerUserRef: account.providerUserRef ?? undefined,
      input: structuredClone(input.input),
      idempotencyKey,
      signal: input.signal,
      authorizeDispatch: this.authorizeAccountDispatch(account, input.signal),
    };
  }

  private authorizeAccountDispatch(account: ConnectedAccountRecord, signal?: AbortSignal): () => void {
    const context = currentJobExecutionContext();
    return () => this.assertAccountAuthority(account, context, signal, {
      afterDispatch: false,
      mutationOutcomeUnknown: false,
    });
  }

  private assertAccountAuthority(
    account: ConnectedAccountRecord,
    context: JobExecutionContext | undefined,
    signal: AbortSignal | undefined,
    options: {
      afterDispatch: boolean;
      mutationOutcomeUnknown: boolean;
      externalRef?: string;
    },
  ): void {
    const authorityLost = this.executionAuthorityLost(context, signal);
    if (authorityLost) {
      const postDispatchUnknown = options.afterDispatch && options.mutationOutcomeUnknown;
      throw new IntegrationProviderError(
        postDispatchUnknown ? 'outcome_unknown' : 'cancelled',
        postDispatchUnknown
          ? 'Integration result arrived after execution authority changed; reconciliation is required'
          : `Integration execution authority changed ${options.afterDispatch ? 'before result acceptance' : 'before provider dispatch'}`,
        {
          externalRef: options.externalRef,
          safeDetail: options.afterDispatch ? 'aiden_post_dispatch_authority' : 'aiden_pre_dispatch_authority',
        },
      );
    }
    try {
      this.accounts.assertStillActionable(account);
    } catch (error) {
      const postDispatchUnknown = options.afterDispatch && options.mutationOutcomeUnknown;
      throw new IntegrationProviderError(
        postDispatchUnknown ? 'outcome_unknown' : 'account_not_found',
        postDispatchUnknown
          ? 'Connected account changed after provider dispatch; reconciliation is required'
          : `Connected account changed or was revoked ${options.afterDispatch ? 'before result acceptance' : 'before dispatch'}`,
        {
          externalRef: options.externalRef,
          safeDetail: options.afterDispatch ? 'aiden_post_dispatch_authority' : 'aiden_pre_dispatch_authority',
          cause: error,
        },
      );
    }
  }

  private executionAuthorityLost(
    context: JobExecutionContext | undefined,
    signal?: AbortSignal,
  ): boolean {
    if (signal?.aborted || context?.signal?.aborted) return true;
    if (!context) return false;
    const job = context.engine.getJob(context.jobId);
    const attempt = context.engine.getAttempt(context.attemptId);
    return !job || !attempt || job.status !== 'running' || job.activeAttemptId !== context.attemptId
      || attempt.status !== 'running' || attempt.generation !== context.generation
      || attempt.fenceToken !== context.fenceToken
      || (attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt <= Date.now());
  }

  private async resolveProviderCredential(input: { providerId: string; ownerId: string; workspaceId: string }): Promise<string> {
    const row = this.db.prepare(
      `SELECT secret_handle FROM integration_provider_credentials
       WHERE provider_id=? AND workspace_id=? AND owner_id=? AND status='active'`,
    ).get(input.providerId, input.workspaceId, input.ownerId) as { secret_handle: string } | undefined;
    if (!row) throw new IntegrationProviderError('provider_unavailable', 'Integration provider is not configured');
    return this.secrets.resolve(row.secret_handle, input);
  }

  private async resolveCredentials(account: ConnectedAccountRecord): Promise<{ provider?: string; account?: string }> {
    const credentials: { provider?: string; account?: string } = {};
    credentials.provider = await this.resolveProviderCredential(account).catch(() => undefined);
    if (account.secretHandle) credentials.account = await this.secrets.resolve(account.secretHandle, account);
    return credentials;
  }

  private mutationIdempotencyKey(input: IntegrationActionInput): string {
    const prepared = currentPreparedDurableToolCall();
    if (prepared?.effectId) return prepared.effectId;
    const context = currentJobExecutionContext();
    return context ? `${context.jobId}:${input.requestId}` : input.requestId;
  }

  private prepareReceipt(
    input: IntegrationActionInput,
    account: ConnectedAccountRecord,
    idempotencyKey: string,
    reconciliationData: Record<string, unknown>,
  ): ReceiptRow {
    const context = currentJobExecutionContext();
    const prepared = currentPreparedDurableToolCall();
    const receiptId = `receipt_${randomBytes(18).toString('base64url')}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO integration_action_receipts
         (receipt_id,provider_id,toolkit_id,action_id,account_id,schema_version,
          provider_action_version,request_id,idempotency_key,reconciliation_json,
          job_id,attempt_id,generation,tool_call_id,effect_id,
          state,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`,
    ).run(
      receiptId, input.providerId, input.toolkitId, input.actionId, account.accountId,
      input.schemaVersion, input.providerActionVersion, input.requestId, idempotencyKey,
      JSON.stringify(canonical(reconciliationData)),
      context?.jobId ?? null, context?.attemptId ?? null, context?.generation ?? null,
      prepared?.toolCallId ?? null, prepared?.effectId ?? null, now, now,
    );
    return this.receipt(receiptId)!;
  }

  private receiptReconciliationData(receipt: ReceiptRow): Record<string, unknown> {
    try {
      const parsed = JSON.parse(receipt.reconciliation_json);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private updateReceipt(receiptId: string, update: {
    state: string;
    externalRef?: string | null;
    resultDigest?: string | null;
    errorCategory?: string | null;
    settled?: boolean;
  }): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE integration_action_receipts
       SET state=?,external_ref=COALESCE(?,external_ref),result_digest=COALESCE(?,result_digest),
           error_category=?,updated_at=?,settled_at=CASE WHEN ? THEN ? ELSE settled_at END
       WHERE receipt_id=?`,
    ).run(
      update.state, update.externalRef ?? null, update.resultDigest ?? null,
      update.errorCategory ?? null, now, update.settled ? 1 : 0, now, receiptId,
    );
  }

  private recordEvidence(
    input: IntegrationActionInput,
    account: ConnectedAccountRecord,
    action: IntegrationActionDescriptor,
    result: IntegrationExecutionResult,
    verification: 'verified' | 'failed' | 'unknown',
    coverage: 'full' | 'partial' | 'unknown',
    required: boolean,
    suffix = action.operation === 'mutation' ? 'readback' : undefined,
    credentials?: { provider?: string; account?: string },
    effectIdOverride?: string | null,
  ): unknown | null {
    const context = currentJobExecutionContext();
    if (!context) return null;
    const prepared = currentPreparedDurableToolCall();
    const source = `integration.${input.providerId}.${input.toolkitId}.${input.actionId}${suffix ? `.${suffix}` : ''}`;
    const claim = required ? context.engine.proof.createClaim({
      jobId: context.jobId,
      attemptId: context.attemptId,
      generation: context.generation,
      category: 'contract',
      statement: `${input.providerId}/${input.toolkitId}/${input.actionId} matches fresh readback`,
      required: true,
    }) : null;
    const observedAt = Date.now();
    const evidence = context.engine.proof.recordEvidence({
      jobId: context.jobId,
      attemptId: context.attemptId,
      generation: context.generation,
      fenceToken: context.fenceToken,
      effectId: effectIdOverride ?? prepared?.effectId ?? null,
      source,
      producer: context.producer,
      observedAt,
      freshUntil: observedAt + 60_000,
      coverage,
      verificationResult: verification,
      payload: {
        providerId: input.providerId,
        toolkitId: input.toolkitId,
        actionId: input.actionId,
        schemaVersion: input.schemaVersion,
        providerActionVersion: input.providerActionVersion,
        accountId: account.accountId,
        externalRef: result.externalRef ?? null,
        result: sanitizeIntegrationValue(
          result.result,
          0,
          { nodes: 512, characters: 50_000 },
          [credentials?.provider, credentials?.account].filter((value): value is string => Boolean(value)),
        ),
      },
    });
    if (claim) context.engine.proof.checkClaim({
      claimId: claim.claimId,
      attemptId: context.attemptId,
      generation: context.generation,
      evidenceIds: [evidence.evidenceId],
      state: verification,
    });
    return evidence;
  }

  private recordDurableEffectReconciliation(
    receipt: ReceiptRow,
    result: IntegrationExecutionResult,
    outcome: 'occurred' | 'did_not_occur' | 'unknown',
  ): void {
    if (!receipt.effect_id) return;
    const context = currentJobExecutionContext();
    if (!context || !receipt.job_id || context.jobId !== receipt.job_id) return;
    const job = context.engine.getJob(receipt.job_id);
    if (!job) throw new IntegrationProviderError('outcome_unknown', 'Integration Job authority is unavailable');
    const reconciliation = context.engine.recordEffectReconciliation({
      effectId: receipt.effect_id,
      expectedJobStateVersion: job.stateVersion,
      outcome,
      confidence: outcome === 'unknown' ? 'low' : 'high',
      evidence: {
        receiptId: receipt.receipt_id,
        providerId: receipt.provider_id,
        toolkitId: receipt.toolkit_id,
        actionId: receipt.action_id,
        accountId: receipt.account_id,
        externalRef: result.externalRef ?? receipt.external_ref,
        resultDigest: result.result === undefined ? null : digest(result.result),
      },
      retryRecommendation: outcome === 'unknown' ? 'human_review' : 'do_not_retry',
      humanResolutionRequired: outcome === 'unknown',
      producer: context.producer,
      idempotencyKey: `integration-receipt:${receipt.receipt_id}:${outcome}`,
    });
    if (!reconciliation.applied && !reconciliation.duplicate) {
      this.updateReceipt(receipt.receipt_id, {
        state: 'unknown', errorCategory: 'outcome_unknown', settled: false,
      });
      throw new IntegrationProviderError('outcome_unknown', 'Integration reconciliation lost durable Job authority');
    }
  }

  private project(
    result: IntegrationExecutionResult,
    credentials?: { provider?: string; account?: string },
  ): ProjectedIntegrationResult {
    return {
      outcome: result.outcome,
      ...(result.externalRef ? { externalRef: result.externalRef } : {}),
      content: {
        untrustedExternalContent: true,
        data: sanitizeIntegrationValue(
          result.result ?? result.safeMessage ?? null,
          0,
          { nodes: 512, characters: 50_000 },
          [credentials?.provider, credentials?.account].filter((value): value is string => Boolean(value)),
        ),
      },
    };
  }
}
