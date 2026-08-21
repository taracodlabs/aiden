/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomUUID } from 'node:crypto';

import type { AidenPaths } from '../paths';
import type { SessionStore } from '../sessionStore';
import {
  OAuthProviderRuntime,
  type OAuthProviderRegistry,
} from '../auth/providerAuth';
import { loadTokens } from '../auth/tokenStore';
import type { RuntimeResolver, ConfigProvider } from '../../../providers/v4/runtimeResolver';
import type { ProviderRegistryEntry } from '../../../providers/v4/registry';
import type { ModelEntry } from '../../../providers/v4/modelCatalog';
import {
  runRuntimeReadinessTransaction,
  type ProviderReadinessRecord,
} from '../../../providers/v4/providerReadiness';

export type ProviderAuthKind = 'oauth' | 'api_key' | 'local' | 'device_code' | 'subscription' | 'none';
export type ProviderSetupAction = 'connect' | 'disconnect' | 'replaceCredential' | 'test' | 'refreshModels';
export type ProviderConnectionState = 'connected' | 'not_configured' | 'needs_attention' | 'local_ready' | 'local_unavailable';

export interface ProviderSetupConfig extends ConfigProvider {
  getValue<T = unknown>(key: string, fallback?: T): T | undefined;
  set(key: string, value: unknown): void;
  save(): Promise<void>;
  usesPaths?(paths: AidenPaths): boolean;
}

export interface ProviderSetupSecretAuthority {
  backendHealth(): { backend: string; available: boolean; protectedByOs: boolean; detail: string };
  health(handle: string): { exists: boolean; status?: string; backend?: string; available: boolean; protectedByOs: boolean };
  create(input: {
    namespace: { providerId: string; workspaceId: string; ownerId: string };
    label: string;
    value: string;
  }): Promise<string>;
  resolve(handle: string, scope: { workspaceId: string; ownerId: string }): Promise<string>;
  replace(handle: string, value: string, scope: { workspaceId: string; ownerId: string }): Promise<void>;
  delete(handle: string, scope: { workspaceId: string; ownerId: string }): Promise<void>;
}

export interface WorkbenchProviderModel {
  id: string;
  displayName: string;
  contextLength?: number;
  supportsToolCalling?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  available: boolean;
}

export interface WorkbenchProviderProjection {
  id: string;
  displayName: string;
  description: string;
  authKinds: ProviderAuthKind[];
  requiredFields: string[];
  actions: ProviderSetupAction[];
  connectionState: ProviderConnectionState;
  configured: boolean;
  healthy: boolean;
  credentialHint?: string;
  account?: string;
  models: WorkbenchProviderModel[];
  currentModel: string | null;
  default: boolean;
  detail?: string;
}

export interface WorkbenchProviderSnapshot {
  providers: WorkbenchProviderProjection[];
  defaultSelection: { providerId: string; modelId: string } | null;
  sessionSelection: { sessionId: string; providerId: string; modelId: string } | null;
  secretStorage: { backend: string; available: boolean; protectedByOs: boolean; detail: string };
}

export interface WorkbenchAuthSession {
  authSessionId: string;
  providerId: string;
  method: 'oauth' | 'device_code';
  state: 'starting' | 'waiting_for_user' | 'connected' | 'failed' | 'expired';
  createdAt: number;
  expiresAt: number;
  verificationUri?: string;
  userCode?: string;
  account?: string;
  detail?: string;
}

interface SessionBindingStore {
  ensureSession(id: string, options?: { providerId?: string; modelId?: string }): unknown;
  getSession(id: string): { providerId: string | null; modelId: string | null } | null;
  updateSession(id: string, updates: { providerId?: string | null; modelId?: string | null }): void;
}

type ReadinessProbe = (input: {
  paths: AidenPaths;
  config: ProviderSetupConfig;
  resolver: RuntimeResolver;
  providerId: string;
  modelId: string;
  apiKeyOverride?: string;
  signal?: AbortSignal;
}) => Promise<ProviderReadinessRecord>;

export interface WorkbenchProviderSetupAuthority {
  snapshot(sessionId?: string): Promise<WorkbenchProviderSnapshot>;
  connectApiKey(input: { providerId: string; modelId: string; credential: string }): Promise<WorkbenchProviderProjection>;
  replaceCredential(input: { providerId: string; modelId: string; credential: string }): Promise<WorkbenchProviderProjection>;
  disconnect(providerId: string): Promise<WorkbenchProviderProjection>;
  test(input: { providerId: string; modelId: string; credential?: string; signal?: AbortSignal }): Promise<WorkbenchProviderProjection>;
  refreshModels(providerId: string): Promise<WorkbenchProviderProjection>;
  setSessionModel(input: { sessionId: string; providerId: string; modelId: string }): Promise<{ sessionId: string; providerId: string; modelId: string }>;
  setDefaultModel(input: { providerId: string; modelId: string }): Promise<{ providerId: string; modelId: string }>;
  startOAuth(providerId: string): Promise<WorkbenchAuthSession>;
  authSession(authSessionId: string): WorkbenchAuthSession | null;
}

const CREDENTIAL_HANDLE_KEY = (providerId: string) => `providers.${providerId}.credentialHandle`;
const CREDENTIAL_HINT_KEY = (providerId: string) => `providers.${providerId}.credentialHint`;

function authKinds(entry: ProviderRegistryEntry): ProviderAuthKind[] {
  if (entry.oauth) {
    return entry.id === 'chatgpt-plus'
      ? ['oauth', 'device_code', 'subscription']
      : ['oauth'];
  }
  if (entry.apiMode === 'ollama_prompt_tools') return ['local'];
  if (entry.apiKeyEnvVar) return ['api_key'];
  return ['none'];
}

function actions(entry: ProviderRegistryEntry): ProviderSetupAction[] {
  if (entry.apiMode === 'ollama_prompt_tools') return ['test', 'refreshModels'];
  if (entry.oauth) return ['connect', 'disconnect', 'test', 'refreshModels'];
  if (entry.apiKeyEnvVar) return ['connect', 'disconnect', 'replaceCredential', 'test', 'refreshModels'];
  return ['test', 'refreshModels'];
}

function projectModel(model: ModelEntry): WorkbenchProviderModel {
  return {
    id: model.id,
    displayName: model.displayName,
    contextLength: model.contextLength,
    supportsToolCalling: model.supportsToolCalling,
    supportsVision: model.supportsVision,
    supportsReasoning: model.supportsReasoning,
    available: true,
  };
}

function maskedHint(value: string): string {
  const suffix = [...value.trim()].slice(-4).join('');
  return suffix ? `••••${suffix}` : '••••';
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:sk|gsk|key|token|secret)[-_][A-Za-z0-9._-]{4,}/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function readinessHealthy(record: ProviderReadinessRecord | undefined): boolean {
  return record?.state === 'complete'
    && record.plainCompletionStatus === 'verified'
    && record.toolCallStatus === 'verified';
}

export function createSecureProviderCredentialResolver(input: {
  secrets: ProviderSetupSecretAuthority;
  scope: { ownerId: string; workspaceId: string };
}) {
  return async (request: { providerId: string; config?: ConfigProvider }) => {
    const handle = request.config?.get(CREDENTIAL_HANDLE_KEY(request.providerId));
    if (!handle) return null;
    const health = input.secrets.health(handle);
    if (!health.exists || health.status === 'revoked' || !health.available) return null;
    return { apiKey: await input.secrets.resolve(handle, input.scope) };
  };
}

export function createWorkbenchProviderSetupAuthority(options: {
  paths: AidenPaths;
  config: ProviderSetupConfig;
  resolver: RuntimeResolver;
  secrets: ProviderSetupSecretAuthority;
  secretScope: { ownerId: string; workspaceId: string };
  sessionStore?: SessionStore | SessionBindingStore;
  oauthRegistry?: OAuthProviderRegistry;
  openBrowser?: (url: string) => Promise<void>;
  probe?: ReadinessProbe;
  now?: () => number;
  idFactory?: () => string;
}): WorkbenchProviderSetupAuthority {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const probe = options.probe ?? (runRuntimeReadinessTransaction as unknown as ReadinessProbe);
  const authSessions = new Map<string, WorkbenchAuthSession>();
  const localModels = new Map<string, ModelEntry[]>();

  const entry = (providerId: string): ProviderRegistryEntry => {
    const found = options.resolver.listProviders().find((provider) => provider.id === providerId);
    if (!found) throw new Error(`Unknown provider '${providerId}'`);
    return found;
  };

  const models = (providerId: string): ModelEntry[] => localModels.get(providerId) ?? options.resolver.listModels(providerId);

  const requireModel = async (providerId: string, modelId: string, apiKeyOverride?: string): Promise<void> => {
    const selected = models(providerId).find((model) => model.id === modelId);
    if (!selected) throw new Error(`Model '${modelId}' is not available for '${providerId}'`);
    await options.resolver.describe({
      providerId,
      modelId,
      config: options.config,
      paths: options.paths,
      ...(apiKeyOverride ? { apiKeyOverride } : {}),
    });
  };

  const project = async (providerId: string): Promise<WorkbenchProviderProjection> => {
    const provider = entry(providerId);
    const handle = options.config.get(CREDENTIAL_HANDLE_KEY(providerId));
    const hint = options.config.get(CREDENTIAL_HINT_KEY(providerId));
    const readiness = options.config.getValue<ProviderReadinessRecord>(`providers.${providerId}.readiness`);
    const oauth = provider.oauth ? await loadTokens(options.paths, provider.oauth.providerId) : null;
    const envConfigured = Boolean(provider.apiKeyEnvVar && process.env[provider.apiKeyEnvVar]);
    const inlineConfigured = Boolean(options.config.get(`providers.${providerId}.apiKey`));
    const secureConfigured = Boolean(handle && options.secrets.health(handle).exists);
    const configured = provider.apiMode === 'ollama_prompt_tools'
      ? localModels.has(providerId)
      : Boolean(oauth || secureConfigured || envConfigured || inlineConfigured);
    const healthy = readinessHealthy(readiness)
      || (provider.apiMode === 'ollama_prompt_tools' && (localModels.get(providerId)?.length ?? 0) > 0);
    const defaultProvider = options.config.get('model.provider');
    const currentModel = defaultProvider === providerId ? options.config.get('model.modelId') ?? null : null;
    let connectionState: ProviderConnectionState = 'not_configured';
    if (provider.apiMode === 'ollama_prompt_tools') {
      connectionState = healthy ? 'local_ready' : 'local_unavailable';
    } else if (configured && healthy) connectionState = 'connected';
    else if (configured) connectionState = 'needs_attention';
    return {
      id: provider.id,
      displayName: provider.displayName,
      description: provider.description,
      authKinds: authKinds(provider),
      requiredFields: provider.apiKeyEnvVar ? ['apiKey'] : [],
      actions: actions(provider),
      connectionState,
      configured,
      healthy,
      ...(hint ? { credentialHint: hint } : {}),
      ...(oauth?.account ? { account: oauth.account } : {}),
      models: models(providerId).map(projectModel),
      currentModel,
      default: defaultProvider === providerId,
      ...(readiness?.verificationErrorCategory
        ? { detail: readiness.verificationErrorCategory.replace(/_/g, ' ') }
        : {}),
    };
  };

  const persistCredential = async (input: { providerId: string; credential: string }): Promise<void> => {
    const provider = entry(input.providerId);
    if (!provider.apiKeyEnvVar || provider.oauth || provider.apiMode === 'ollama_prompt_tools') {
      throw new Error(`${provider.displayName} does not accept an API key in Workbench`);
    }
    const credential = input.credential.trim();
    if (!credential || credential.length > 256_000) throw new Error('API key is required');
    const current = options.config.get(CREDENTIAL_HANDLE_KEY(provider.id));
    if (current) await options.secrets.replace(current, credential, options.secretScope);
    else {
      const handle = await options.secrets.create({
        namespace: { providerId: provider.id, ...options.secretScope },
        label: `${provider.displayName} API credential`,
        value: credential,
      });
      options.config.set(CREDENTIAL_HANDLE_KEY(provider.id), handle);
    }
    options.config.set(CREDENTIAL_HINT_KEY(provider.id), maskedHint(credential));
    await options.config.save();
  };

  const test = async (input: { providerId: string; modelId: string; credential?: string; signal?: AbortSignal }) => {
    await requireModel(input.providerId, input.modelId, input.credential);
    await probe({
      paths: options.paths,
      config: options.config,
      resolver: options.resolver,
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.credential ? { apiKeyOverride: input.credential } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return project(input.providerId);
  };

  const connectApiKey = async (input: { providerId: string; modelId: string; credential: string }) => {
    await requireModel(input.providerId, input.modelId, input.credential);
    await probe({
      paths: options.paths,
      config: options.config,
      resolver: options.resolver,
      providerId: input.providerId,
      modelId: input.modelId,
      apiKeyOverride: input.credential,
    });
    await persistCredential(input);
    return project(input.providerId);
  };

  return {
    async snapshot(sessionId) {
      const defaultProvider = options.config.get('model.provider');
      const defaultModel = options.config.get('model.modelId');
      const session = sessionId && options.sessionStore ? options.sessionStore.getSession(sessionId) : null;
      return {
        providers: await Promise.all(options.resolver.listProviders().map((provider) => project(provider.id))),
        defaultSelection: defaultProvider && defaultModel
          ? { providerId: defaultProvider, modelId: defaultModel }
          : null,
        sessionSelection: sessionId && session?.providerId && session.modelId
          ? { sessionId, providerId: session.providerId, modelId: session.modelId }
          : null,
        secretStorage: options.secrets.backendHealth(),
      };
    },
    connectApiKey,
    replaceCredential: connectApiKey,
    async disconnect(providerId) {
      const provider = entry(providerId);
      if (provider.oauth && options.oauthRegistry) {
        await options.oauthRegistry.runtimeFor(provider.oauth.providerId, options.paths)?.logout();
      }
      const handle = options.config.get(CREDENTIAL_HANDLE_KEY(providerId));
      if (handle) await options.secrets.delete(handle, options.secretScope);
      options.config.set(CREDENTIAL_HANDLE_KEY(providerId), null);
      options.config.set(CREDENTIAL_HINT_KEY(providerId), null);
      options.config.set(`providers.${providerId}.readiness`, null);
      await options.config.save();
      return project(providerId);
    },
    test,
    async refreshModels(providerId) {
      const provider = entry(providerId);
      if (provider.apiMode === 'ollama_prompt_tools') {
        const inventory = await options.resolver.getLocalModelInventory({ forceRefresh: true });
        if (inventory.source === 'live') {
          localModels.set(providerId, inventory.models.map((model) => ({
            id: model.id,
            displayName: model.displayName || model.id,
            providerId,
            contextLength: model.contextLength ?? 8_192,
            supportsToolCalling: true,
            supportsVision: false,
            supportsReasoning: false,
            isDefault: false,
            tier: 'standard',
          })));
        } else localModels.delete(providerId);
      }
      return project(providerId);
    },
    async setSessionModel(input) {
      if (!input.sessionId.trim()) throw new Error('Session identity is required');
      await requireModel(input.providerId, input.modelId);
      if (!options.sessionStore) throw new Error('Durable session model switching is unavailable');
      options.sessionStore.ensureSession(input.sessionId);
      options.sessionStore.updateSession(input.sessionId, { providerId: input.providerId, modelId: input.modelId });
      return { ...input };
    },
    async setDefaultModel(input) {
      await requireModel(input.providerId, input.modelId);
      options.config.set('model.provider', input.providerId);
      options.config.set('model.modelId', input.modelId);
      await options.config.save();
      return { ...input };
    },
    async startOAuth(providerId) {
      const provider = entry(providerId);
      const oauth = provider.oauth && options.oauthRegistry?.runtimeFor(provider.oauth.providerId, options.paths);
      if (!provider.oauth || !oauth) throw new Error(`${provider.displayName} has no available Workbench OAuth flow`);
      const createdAt = now();
      const authSessionId = `auth_${idFactory().replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
      const session: WorkbenchAuthSession = {
        authSessionId,
        providerId,
        method: provider.id === 'chatgpt-plus' ? 'device_code' : 'oauth',
        state: 'starting',
        createdAt,
        expiresAt: createdAt + 15 * 60_000,
      };
      authSessions.set(authSessionId, session);
      const update = (next: Partial<WorkbenchAuthSession>) => Object.assign(session, next);
      void oauth.login({
        log(line) {
          const code = /^\s*│\s*([A-Z0-9-]{4,})\s*│\s*$/.exec(line)?.[1];
          if (code) update({ userCode: code, state: 'waiting_for_user' });
        },
        async openBrowser(url) {
          update({ verificationUri: url, state: 'waiting_for_user' });
          await options.openBrowser?.(url);
        },
        async prompt() { throw new Error('This OAuth flow requires an interactive browser response'); },
        async sleep(ms) { await new Promise<void>((resolve) => setTimeout(resolve, ms)); },
      }).then((tokens) => {
        update({ state: 'connected', ...(tokens.account ? { account: tokens.account } : {}), detail: 'Connected' });
      }).catch((error) => {
        update({ state: now() >= session.expiresAt ? 'expired' : 'failed', detail: safeDetail(error) });
      });
      return { ...session };
    },
    authSession(authSessionId) {
      const session = authSessions.get(authSessionId);
      if (!session) return null;
      if (session.state !== 'connected' && session.state !== 'failed' && now() >= session.expiresAt) {
        session.state = 'expired';
      }
      return { ...session };
    },
  };
}
