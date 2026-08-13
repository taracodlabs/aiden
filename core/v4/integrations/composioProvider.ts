/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import {
  IntegrationProviderError,
  type ActionDiscoveryPage,
  type ConnectedAccountHealth,
  type ConnectedAccountStatus,
  type IntegrationActionDescriptor,
  type IntegrationExecutionRequest,
  type IntegrationExecutionResult,
  type IntegrationProvider,
  type IntegrationProviderHealth,
  type IntegrationReadbackRequest,
  type IntegrationToolkitDescriptor,
  type ProviderConnectionResult,
  type ProviderConnectionStart,
} from './types';

interface ComposioPage<T> {
  items?: T[];
  data?: T[];
  nextCursor?: string | null;
  next_cursor?: string | null;
}

interface ComposioToolkit {
  slug?: string;
  name?: string;
}

interface ComposioAuthConfig {
  id?: string;
  status?: string;
  toolkit?: { slug?: string } | string;
  toolkitSlug?: string;
  isComposioManaged?: boolean;
  is_composio_managed?: boolean;
}

interface ComposioConnectedAccount {
  id?: string;
  userId?: string;
  user_id?: string;
  status?: string;
  scopes?: string[];
  label?: string;
}

interface ComposioRawTool {
  slug?: string;
  name?: string;
  description?: string;
  version?: string;
  toolkit?: { slug?: string } | string;
  toolkitSlug?: string;
  toolkit_slug?: string;
  inputParameters?: Record<string, unknown>;
  input_parameters?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  outputParameters?: Record<string, unknown>;
  output_parameters?: Record<string, unknown>;
}

export interface ComposioClientPort {
  toolkits: {
    get(input?: Record<string, unknown>): Promise<ComposioPage<ComposioToolkit> | ComposioToolkit[]>;
  };
  authConfigs: {
    list(input: Record<string, unknown>): Promise<ComposioPage<ComposioAuthConfig> | ComposioAuthConfig[]>;
  };
  connectedAccounts: {
    link(userId: string, authConfigId: string, options: Record<string, unknown>): Promise<{
      id?: string;
      redirectUrl?: string;
      redirect_url?: string;
      status?: string;
    }>;
    waitForConnection(id: string): Promise<ComposioConnectedAccount>;
    get(id: string): Promise<ComposioConnectedAccount>;
    delete(id: string): Promise<unknown>;
  };
  tools: {
    getRawComposioTools(input: Record<string, unknown>): Promise<ComposioPage<ComposioRawTool> | ComposioRawTool[]>;
    execute(
      slug: string,
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

export type ComposioClientFactory = (apiKey: string) => Promise<ComposioClientPort>;

interface AllowedAction {
  operation: 'read' | 'mutation';
  risk: 'safe' | 'caution';
  supportsReadback: boolean;
  readbackActionId?: string;
}

const TOOLKITS: Record<string, { label: string; actions: Record<string, AllowedAction> }> = {
  github: {
    label: 'GitHub',
    actions: {
      GITHUB_GET_REPOSITORY: { operation: 'read', risk: 'safe', supportsReadback: false },
      GITHUB_GET_REPOS: { operation: 'read', risk: 'safe', supportsReadback: false },
      GITHUB_LIST_ISSUES: { operation: 'read', risk: 'safe', supportsReadback: false },
      GITHUB_LIST_REPOSITORY_ISSUES: { operation: 'read', risk: 'safe', supportsReadback: false },
      GITHUB_GET_ISSUE: { operation: 'read', risk: 'safe', supportsReadback: false },
      GITHUB_CREATE_ISSUE: {
        operation: 'mutation', risk: 'caution', supportsReadback: true,
        readbackActionId: 'GITHUB_GET_ISSUE',
      },
    },
  },
  gmail: {
    label: 'Gmail',
    actions: {
      GMAIL_FETCH_EMAILS: { operation: 'read', risk: 'safe', supportsReadback: false },
      GMAIL_GET_EMAILS: { operation: 'read', risk: 'safe', supportsReadback: false },
      GMAIL_LIST_EMAILS: { operation: 'read', risk: 'safe', supportsReadback: false },
      GMAIL_GET_MESSAGE: { operation: 'read', risk: 'safe', supportsReadback: false },
      GMAIL_GET_DRAFT: { operation: 'read', risk: 'safe', supportsReadback: false },
      GMAIL_CREATE_DRAFT: {
        operation: 'mutation', risk: 'caution', supportsReadback: true,
        readbackActionId: 'GMAIL_GET_DRAFT',
      },
      GMAIL_CREATE_EMAIL_DRAFT: {
        operation: 'mutation', risk: 'caution', supportsReadback: true,
        readbackActionId: 'GMAIL_GET_DRAFT',
      },
    },
  },
};

function asItems<T>(value: ComposioPage<T> | T[]): T[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.data)) return value.data;
  return [];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function schemaDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const MAX_SCHEMA_PROPERTIES = 64;
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_TEXT = 512;
const MAX_SCHEMA_ALTERNATIVES = 16;

interface SchemaBudget {
  properties: number;
  nodes: number;
}

function boundedText(value: unknown, max = MAX_SCHEMA_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}

function boundedPrimitive(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string') return boundedText(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value === null) return null;
  return undefined;
}

/**
 * Projects vendor JSON Schema into a bounded, model-safe subset. Defaults,
 * examples, extensions, and other provider payloads are deliberately omitted.
 */
function normalizeVendorSchema(
  value: unknown,
  budget: SchemaBudget = { properties: MAX_SCHEMA_PROPERTIES, nodes: MAX_SCHEMA_NODES },
  depth = 0,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || depth > MAX_SCHEMA_DEPTH || budget.nodes <= 0) {
    return {};
  }
  budget.nodes -= 1;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  const type = source.type;
  if (typeof type === 'string') {
    const safeType = boundedText(type, 32);
    if (safeType) result.type = safeType;
  } else if (Array.isArray(type)) {
    const safeTypes = type.slice(0, 8)
      .map((entry) => boundedText(entry, 32))
      .filter((entry): entry is string => Boolean(entry));
    if (safeTypes.length) result.type = safeTypes;
  }

  const title = boundedText(source.title, 128);
  if (title) result.title = title;
  const description = boundedText(source.description);
  if (description) result.description = description;
  const format = boundedText(source.format, 64);
  if (format) result.format = format;
  const pattern = boundedText(source.pattern);
  if (pattern) result.pattern = pattern;

  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const) {
    const number = source[key];
    if (typeof number === 'number' && Number.isFinite(number)) result[key] = number;
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'] as const) {
    const number = source[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) result[key] = number;
  }
  if (typeof source.uniqueItems === 'boolean') result.uniqueItems = source.uniqueItems;
  if (typeof source.additionalProperties === 'boolean') result.additionalProperties = source.additionalProperties;

  if (Array.isArray(source.enum)) {
    const values = source.enum.slice(0, 64)
      .map(boundedPrimitive)
      .filter((entry): entry is string | number | boolean | null => entry !== undefined);
    if (values.length) result.enum = values;
  }

  if (source.items && typeof source.items === 'object' && !Array.isArray(source.items)) {
    result.items = normalizeVendorSchema(source.items, budget, depth + 1);
  }

  const retainedProperties: string[] = [];
  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [rawName, definition] of Object.entries(source.properties as Record<string, unknown>)) {
      if (budget.properties <= 0) break;
      const name = boundedText(rawName, 128);
      if (!name || name !== rawName.trim()) continue;
      budget.properties -= 1;
      retainedProperties.push(name);
      properties[name] = normalizeVendorSchema(definition, budget, depth + 1);
    }
    if (retainedProperties.length) result.properties = properties;
  }

  if (Array.isArray(source.required) && retainedProperties.length) {
    const allowed = new Set(retainedProperties);
    const required = source.required
      .map((entry) => boundedText(entry, 128))
      .filter((entry): entry is string => Boolean(entry) && allowed.has(entry))
      .slice(0, MAX_SCHEMA_PROPERTIES);
    if (required.length) result.required = [...new Set(required)];
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (!Array.isArray(source[key])) continue;
    const alternatives = source[key]
      .slice(0, MAX_SCHEMA_ALTERNATIVES)
      .map((entry) => normalizeVendorSchema(entry, budget, depth + 1));
    if (alternatives.length) result[key] = alternatives;
  }

  return result;
}

function toolkitSlug(value: ComposioRawTool): string {
  if (typeof value.toolkit === 'string') return value.toolkit.toLowerCase();
  return (value.toolkit?.slug ?? value.toolkitSlug ?? value.toolkit_slug ?? '').toLowerCase();
}

function safeStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const record = error as Record<string, unknown>;
  const response = record.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : {};
  return Number(record.status ?? record.statusCode ?? response.status) || 0;
}

function providerError(error: unknown): IntegrationProviderError {
  if (error instanceof IntegrationProviderError) return error;
  const status = safeStatus(error);
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = String(record.code ?? (record.cause as { code?: unknown } | undefined)?.code ?? '').toUpperCase();
  if (status === 408 || status === 504 || code.includes('TIMEOUT') || code.includes('TIMEDOUT')) {
    return new IntegrationProviderError('timeout', 'Composio request timed out');
  }
  if (status === 401) return new IntegrationProviderError('auth_expired', 'Composio authentication expired');
  if (status === 403) return new IntegrationProviderError('permission_denied', 'Composio permission was denied');
  if (status === 404) return new IntegrationProviderError('action_not_found', 'Composio resource was not found');
  if (status === 409 || status === 422) return new IntegrationProviderError('schema_drift', 'Composio action schema changed');
  if (status === 429) {
    const retryAfterMs = Number(record.retryAfterMs ?? record.retry_after_ms);
    return new IntegrationProviderError('rate_limited', 'Composio rate limit reached', {
      ...(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    });
  }
  return new IntegrationProviderError('provider_unavailable', 'Composio is unavailable', { cause: error });
}

function requireCredential(value: string | undefined): string {
  if (!value?.trim()) throw new IntegrationProviderError('provider_unavailable', 'Composio is not configured');
  return value;
}

function normalizeExecutionResult(value: unknown): IntegrationExecutionResult {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const successful = record.successful ?? record.success;
  const data = record.data ?? record.result ?? value;
  if (successful === false) {
    return {
      outcome: 'failed',
      errorCategory: safeStatus(record.error) === 429 ? 'rate_limited' : 'provider_unavailable',
      safeMessage: 'Composio action failed',
    };
  }
  const dataRecord = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const candidate = dataRecord.id ?? dataRecord.draftId ?? dataRecord.draft_id
    ?? dataRecord.messageId ?? dataRecord.message_id ?? dataRecord.number;
  return {
    outcome: 'succeeded',
    ...(candidate !== undefined && candidate !== null ? { externalRef: String(candidate) } : {}),
    result: data,
  };
}

function normalizeAccountState(status: string | undefined): {
  status: ConnectedAccountStatus;
  health: ConnectedAccountHealth;
} {
  switch ((status ?? '').toUpperCase()) {
    case 'ACTIVE':
    case 'CONNECTED':
      return { status: 'active', health: 'healthy' };
    case 'EXPIRED':
      return { status: 'expired', health: 'expired' };
    case 'REVOKED':
    case 'DISABLED':
      return { status: 'revoked', health: 'revoked' };
    case 'INITIATED':
    case 'PENDING':
      return { status: 'connecting', health: 'unknown' };
    default:
      return { status: 'degraded', health: 'degraded' };
  }
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'result', 'issue', 'draft', 'message']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return { ...record, ...(nested as Record<string, unknown>) };
    }
  }
  return record;
}

function verificationFailure(message: string, unknown = false): IntegrationExecutionResult {
  return {
    outcome: unknown ? 'unknown' : 'failed',
    errorCategory: 'verification_failed',
    safeMessage: message,
  };
}

async function defaultClientFactory(apiKey: string): Promise<ComposioClientPort> {
  const moduleName = '@composio/core';
  const loaded = await import(moduleName) as unknown as {
    Composio?: new (options: { apiKey: string }) => ComposioClientPort;
    default?: { Composio?: new (options: { apiKey: string }) => ComposioClientPort };
  };
  const Constructor = loaded.Composio ?? loaded.default?.Composio;
  if (!Constructor) throw new IntegrationProviderError('provider_unavailable', 'Composio SDK is unavailable');
  return new Constructor({ apiKey });
}

export class ComposioIntegrationProvider implements IntegrationProvider {
  readonly id = 'composio';
  readonly label = 'Composio';
  private readonly clientFactory: ComposioClientFactory;
  private readonly clients = new Map<string, Promise<ComposioClientPort>>();
  private readonly actionVersions = new Map<string, string>();

  constructor(options: { clientFactory?: ComposioClientFactory } = {}) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  async health(input: { providerCredential?: string } = {}): Promise<IntegrationProviderHealth> {
    if (!input.providerCredential?.trim()) {
      return { state: 'not_configured', checkedAt: Date.now(), detail: 'Composio credential is not configured' };
    }
    try {
      await (await this.client(input.providerCredential)).toolkits.get({ limit: 1 });
      return { state: 'healthy', checkedAt: Date.now() };
    } catch (error) {
      const normalized = providerError(error);
      return {
        state: normalized.category === 'auth_expired' || normalized.category === 'permission_denied'
          ? 'degraded' : 'unavailable',
        checkedAt: Date.now(), detail: normalized.message,
      };
    }
  }

  async listToolkits(input: { providerCredential?: string } = {}): Promise<IntegrationToolkitDescriptor[]> {
    requireCredential(input.providerCredential);
    try {
      const available = asItems(await (await this.client(input.providerCredential!)).toolkits.get({ limit: 100 }));
      const ids = new Set(available.map((item) => (item.slug ?? '').toLowerCase()));
      return Object.entries(TOOLKITS)
        .filter(([toolkitId]) => ids.has(toolkitId))
        .map(([toolkitId, policy]) => ({ toolkitId, label: policy.label, connectionRequired: true }));
    } catch (error) {
      throw providerError(error);
    }
  }

  async discoverActions(input: {
    toolkitId: string;
    cursor?: string;
    limit: number;
    providerCredential?: string;
  }): Promise<ActionDiscoveryPage> {
    const toolkitId = input.toolkitId.toLowerCase();
    const policy = TOOLKITS[toolkitId];
    if (!policy) return { actions: [] };
    const credential = requireCredential(input.providerCredential);
    try {
      const rawPage = await (await this.client(credential)).tools.getRawComposioTools({
        toolkits: [toolkitId],
        limit: Math.max(1, Math.min(100, input.limit)),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const actions = asItems(rawPage)
        .filter((tool) => !toolkitSlug(tool) || toolkitSlug(tool) === toolkitId)
        .flatMap((tool): IntegrationActionDescriptor[] => {
          const actionId = boundedText(tool.slug, 128)?.toUpperCase() ?? '';
          const allowed = policy.actions[actionId];
          const providerActionVersion = boundedText(tool.version, 128) ?? '';
          const vendorInputSchema = tool.inputParameters ?? tool.input_parameters ?? tool.parameters;
          if (!allowed || !actionId || !providerActionVersion || !vendorInputSchema) return [];
          const inputSchema = normalizeVendorSchema(vendorInputSchema);
          const vendorOutputSchema = tool.outputParameters ?? tool.output_parameters;
          const outputSchema = vendorOutputSchema ? normalizeVendorSchema(vendorOutputSchema) : undefined;
          this.actionVersions.set(this.actionVersionKey(credential, toolkitId, actionId), providerActionVersion);
          return [{
            providerId: this.id,
            toolkitId,
            actionId,
            label: boundedText(tool.name, 128) || actionId,
            description: boundedText(tool.description, 1_000) || boundedText(tool.name, 128) || actionId,
            schemaVersion: schemaDigest(inputSchema),
            providerActionVersion,
            operation: allowed.operation,
            risk: allowed.risk,
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            supportsIdempotency: false,
            supportsReadback: allowed.supportsReadback,
            supportsReconciliation: allowed.supportsReadback,
          }];
        })
        .sort((left, right) => left.actionId.localeCompare(right.actionId));
      const page = rawPage as ComposioPage<ComposioRawTool>;
      const nextCursor = boundedText(page.nextCursor ?? page.next_cursor, 2_048);
      return { actions, ...(nextCursor ? { nextCursor } : {}) };
    } catch (error) {
      throw providerError(error);
    }
  }

  async initiateConnection(input: {
    toolkitId: string;
    ownerId: string;
    workspaceId?: string;
    label?: string;
    providerCredential?: string;
  }): Promise<ProviderConnectionStart> {
    const toolkitId = input.toolkitId.toLowerCase();
    if (!TOOLKITS[toolkitId]) throw new IntegrationProviderError('invalid_input', 'Toolkit is not supported');
    const credential = requireCredential(input.providerCredential);
    try {
      const client = await this.client(credential);
      const configs = asItems(await client.authConfigs.list({
        toolkit: toolkitId, isComposioManaged: true, limit: 50,
      }));
      const config = configs.find((candidate) => {
        const candidateToolkit = typeof candidate.toolkit === 'string'
          ? candidate.toolkit : candidate.toolkit?.slug ?? candidate.toolkitSlug;
        const managed = candidate.isComposioManaged ?? candidate.is_composio_managed ?? true;
        return candidate.id && candidateToolkit?.toLowerCase() === toolkitId
          && managed && candidate.status?.toUpperCase() !== 'DISABLED';
      });
      if (!config?.id) throw new IntegrationProviderError('provider_unavailable', 'No hosted authentication configuration is available');
      const link = await client.connectedAccounts.link(`aiden:${input.ownerId}`, config.id, {
        alias: input.label?.trim() || TOOLKITS[toolkitId].label,
        allowMultiple: true,
      });
      if (!link.id) throw new IntegrationProviderError('provider_unavailable', 'Composio did not return a connection identity');
      const authorizationUrl = link.redirectUrl ?? link.redirect_url;
      return {
        connectionId: link.id,
        state: link.status?.toUpperCase() === 'ACTIVE' ? 'completed' : 'pending',
        ...(authorizationUrl ? { authorizationUrl } : {}),
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  async completeConnection(input: {
    connectionId: string;
    providerCredential?: string;
  }): Promise<ProviderConnectionResult> {
    const credential = requireCredential(input.providerCredential);
    try {
      const account = await (await this.client(credential)).connectedAccounts.waitForConnection(input.connectionId);
      if (!account.id) throw new IntegrationProviderError('account_not_found', 'Connected account identity is unavailable');
      const state = normalizeAccountState(account.status);
      if (state.status !== 'active') throw new IntegrationProviderError('auth_expired', 'Connected account is not active');
      return {
        connectionId: input.connectionId,
        providerAccountRef: account.id,
        providerUserRef: account.userId ?? account.user_id,
        label: account.label?.trim() || 'Connected account',
        scopes: Array.isArray(account.scopes) ? [...account.scopes] : [],
        hostedAuthRef: account.id,
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  async refreshAccount(input: {
    providerAccountRef: string;
    credentials?: { provider?: string; account?: string };
  }): Promise<{ status: ConnectedAccountStatus; health: ConnectedAccountHealth; scopes?: string[] }> {
    const credential = requireCredential(input.credentials?.provider);
    try {
      const account = await (await this.client(credential)).connectedAccounts.get(input.providerAccountRef);
      return { ...normalizeAccountState(account.status), scopes: Array.isArray(account.scopes) ? [...account.scopes] : [] };
    } catch (error) {
      throw providerError(error);
    }
  }

  async revokeAccount(input: {
    providerAccountRef: string;
    credentials?: { provider?: string; account?: string };
  }): Promise<void> {
    const credential = requireCredential(input.credentials?.provider);
    try {
      await (await this.client(credential)).connectedAccounts.delete(input.providerAccountRef);
    } catch (error) {
      throw providerError(error);
    }
  }

  reconciliationData(input: IntegrationExecutionRequest): Record<string, unknown> {
    const toolkitId = input.toolkitId.toLowerCase();
    const policy = TOOLKITS[toolkitId]?.actions[input.actionId.toUpperCase()];
    const credential = input.credentials?.provider;
    const readbackProviderActionVersion = policy?.readbackActionId && credential
      ? this.actionVersions.get(this.actionVersionKey(credential, toolkitId, policy.readbackActionId))
      : undefined;
    const readbackIdentity = readbackProviderActionVersion
      ? { readbackProviderActionVersion }
      : {};
    if (toolkitId !== 'github') return readbackIdentity;
    const owner = boundedText(input.input.owner, 256);
    const repo = boundedText(input.input.repo, 256);
    const title = boundedText(input.input.title, 1_000);
    return owner && repo
      ? { owner, repo, ...(title ? { title } : {}), ...readbackIdentity }
      : readbackIdentity;
  }

  async execute(input: IntegrationExecutionRequest): Promise<IntegrationExecutionResult> {
    const policy = this.requireExecutionIdentity(input);
    try {
      const client = await this.client(input.credentials!.provider!);
      input.authorizeDispatch?.();
      const value = await client.tools.execute(
        input.actionId,
        {
          userId: input.providerUserRef,
          connectedAccountId: input.providerAccountRef,
          version: input.providerActionVersion,
          arguments: structuredClone(input.input),
        },
        { signal: input.signal },
      );
      const result = normalizeExecutionResult(value);
      if (result.outcome !== 'succeeded' && policy.operation === 'mutation') {
        return { ...result, outcome: 'unknown', errorCategory: 'outcome_unknown' };
      }
      return result;
    } catch (error) {
      if (input.signal?.aborted) {
        if (policy.operation === 'mutation') {
          throw new IntegrationProviderError('outcome_unknown', 'Integration mutation outcome is unknown after cancellation');
        }
        throw new IntegrationProviderError('cancelled', 'Integration action was cancelled');
      }
      const normalized = providerError(error);
      if (normalized.safeDetail === 'aiden_pre_dispatch_authority') throw normalized;
      if (policy.operation === 'mutation'
          && !['auth_expired', 'permission_denied', 'account_not_found', 'invalid_input'].includes(normalized.category)) {
        throw new IntegrationProviderError('outcome_unknown', 'Integration mutation outcome is unknown', {
          retryAfterMs: normalized.retryAfterMs, cause: normalized,
        });
      }
      throw normalized;
    }
  }

  async readback(input: IntegrationReadbackRequest): Promise<IntegrationExecutionResult> {
    return this.performReadback(input);
  }

  async reconcile(input: IntegrationReadbackRequest): Promise<IntegrationExecutionResult> {
    const persistedVersion = boundedText(input.input.readbackProviderActionVersion, 128);
    return this.performReadback(
      input,
      persistedVersion && persistedVersion.toLowerCase() !== 'latest' ? persistedVersion : undefined,
    );
  }

  private async performReadback(
    input: IntegrationReadbackRequest,
    persistedReadbackVersion?: string,
  ): Promise<IntegrationExecutionResult> {
    const policy = this.requireExecutionIdentity(input);
    if (!policy.readbackActionId) {
      return { outcome: 'unknown', errorCategory: 'verification_failed', safeMessage: 'Fresh readback is unavailable' };
    }
    const readbackInput = this.readbackInput(input);
    if (!readbackInput) {
      return { outcome: 'unknown', errorCategory: 'verification_failed', safeMessage: 'Readback identity is unavailable' };
    }
    try {
      const readbackVersion = this.actionVersions.get(this.actionVersionKey(
        input.credentials!.provider!, input.toolkitId, policy.readbackActionId,
      )) ?? persistedReadbackVersion;
      if (!readbackVersion) {
        return { outcome: 'unknown', errorCategory: 'schema_drift', safeMessage: 'Pinned readback action version is unavailable' };
      }
      const client = await this.client(input.credentials!.provider!);
      input.authorizeDispatch?.();
      const value = await client.tools.execute(
        policy.readbackActionId,
        {
          userId: input.providerUserRef,
          connectedAccountId: input.providerAccountRef,
          version: readbackVersion,
          arguments: readbackInput,
        },
        { signal: input.signal },
      );
      const result = normalizeExecutionResult(value);
      if (result.outcome !== 'succeeded') return result;
      return this.verifyReadback(input, result);
    } catch (error) {
      const normalized = providerError(error);
      return { outcome: 'unknown', errorCategory: normalized.category, safeMessage: normalized.message };
    }
  }

  private async client(credential: string): Promise<ComposioClientPort> {
    const key = createHash('sha256').update(credential).digest('hex');
    let client = this.clients.get(key);
    if (!client) {
      client = this.clientFactory(credential).catch((error) => {
        this.clients.delete(key);
        throw error;
      });
      this.clients.set(key, client);
    }
    return client;
  }

  private actionVersionKey(credential: string, toolkitId: string, actionId: string): string {
    return `${createHash('sha256').update(credential).digest('hex')}:${toolkitId.toLowerCase()}:${actionId.toUpperCase()}`;
  }

  private requireExecutionIdentity(input: IntegrationExecutionRequest): AllowedAction {
    const toolkitId = input.toolkitId.toLowerCase();
    const policy = TOOLKITS[toolkitId]?.actions[input.actionId.toUpperCase()];
    requireCredential(input.credentials?.provider);
    if (!policy) throw new IntegrationProviderError('action_not_found', 'Integration action is not allowed');
    if (!input.providerAccountRef?.trim() || !input.providerUserRef?.trim()) {
      throw new IntegrationProviderError('invalid_input', 'Exact connected account and user identities are required');
    }
    if (!input.providerActionVersion?.trim() || input.providerActionVersion === 'latest') {
      throw new IntegrationProviderError('invalid_input', 'An exact provider action version is required');
    }
    if (!input.schemaVersion?.trim()) {
      throw new IntegrationProviderError('invalid_input', 'An exact action schema version is required');
    }
    return policy;
  }

  private readbackInput(input: IntegrationReadbackRequest): Record<string, unknown> | null {
    const result = input.executionResult && typeof input.executionResult === 'object'
      ? input.executionResult as Record<string, unknown> : {};
    if (input.toolkitId.toLowerCase() === 'github') {
      const owner = input.input.owner;
      const repo = input.input.repo;
      const number = result.number ?? result.issue_number ?? input.externalRef;
      if (typeof owner !== 'string' || typeof repo !== 'string' || number === undefined) return null;
      return { owner, repo, issue_number: number };
    }
    if (input.toolkitId.toLowerCase() === 'gmail') {
      const draftId = result.id ?? result.draftId ?? result.draft_id ?? input.externalRef;
      return draftId === undefined ? null : { draft_id: draftId };
    }
    return null;
  }

  private verifyReadback(
    input: IntegrationReadbackRequest,
    result: IntegrationExecutionResult,
  ): IntegrationExecutionResult {
    const actual = resultRecord(result.result);
    const toolkitId = input.toolkitId.toLowerCase();
    if (toolkitId === 'github') {
      const expectedResult = resultRecord(input.executionResult);
      const expectedNumber = expectedResult.number ?? expectedResult.issue_number ?? input.externalRef;
      const actualNumber = actual.number ?? actual.issue_number;
      if (expectedNumber !== undefined) {
        if (actualNumber === undefined) return verificationFailure('Fresh issue identity was unavailable', true);
        if (String(actualNumber) !== String(expectedNumber)) return verificationFailure('Fresh issue identity did not match');
      }
      if (typeof input.input.title === 'string') {
        if (typeof actual.title !== 'string') return verificationFailure('Fresh issue title was unavailable', true);
        if (actual.title !== input.input.title) return verificationFailure('Fresh issue title did not match');
      }
    } else if (toolkitId === 'gmail') {
      const expectedResult = resultRecord(input.executionResult);
      const expectedId = expectedResult.id ?? expectedResult.draftId ?? expectedResult.draft_id ?? input.externalRef;
      const actualId = actual.id ?? actual.draftId ?? actual.draft_id;
      if (expectedId !== undefined) {
        if (actualId === undefined) return verificationFailure('Fresh draft identity was unavailable', true);
        if (String(actualId) !== String(expectedId)) return verificationFailure('Fresh draft identity did not match');
      }
    }
    return result;
  }
}
