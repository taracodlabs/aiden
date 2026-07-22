import type { ConfigManager } from '../../core/v4/config';
import type { AidenPaths } from '../../core/v4/paths';
import type { RuntimeResolver } from './runtimeResolver';
import type { ApiMode } from './types';
import type { EffectiveCredentialSource } from './credentialAuthority';
import type { ProviderReadinessErrorCategory } from './readinessErrors';
import { classifyReadinessError, isRetryableReadinessCategory } from './readinessErrors';
import { verifyRuntimeReadiness } from './readinessProbe';

export type ProviderReadinessState =
  | 'not_started'
  | 'provider_selected'
  | 'credential_saved'
  | 'credential_verified'
  | 'model_selected'
  | 'runtime_resolved'
  | 'plain_completion_verified'
  | 'tool_call_verified'
  | 'complete'
  | 'configured_unverified'
  | 'failed_retryable'
  | 'failed_requires_user_action';

export interface ProviderReadinessRecord {
  state: ProviderReadinessState;
  provider: string;
  model: string;
  endpointFingerprint: string | null;
  credentialSource: EffectiveCredentialSource | null;
  transportMode: ApiMode | null;
  plainCompletionStatus: 'not_started' | 'verified' | 'failed';
  streamingStatus: 'not_started' | 'verified' | 'failed';
  toolCallStatus: 'not_started' | 'verified' | 'failed';
  toolResultReplayStatus: 'not_started' | 'verified' | 'failed';
  structuredArgumentsStatus: 'not_started' | 'verified' | 'failed';
  verificationTimestamp: string | null;
  verificationErrorCategory: ProviderReadinessErrorCategory | null;
}

export function initialReadiness(provider: string, model: string): ProviderReadinessRecord {
  return {
    state: 'provider_selected',
    provider,
    model,
    endpointFingerprint: null,
    credentialSource: null,
    transportMode: null,
    plainCompletionStatus: 'not_started',
    streamingStatus: 'not_started',
    toolCallStatus: 'not_started',
    toolResultReplayStatus: 'not_started',
    structuredArgumentsStatus: 'not_started',
    verificationTimestamp: null,
    verificationErrorCategory: null,
  };
}

export async function persistProviderReadiness(
  config: ConfigManager,
  record: ProviderReadinessRecord,
): Promise<void> {
  config.set(`providers.${record.provider}.readiness`, record);
  await config.save();
}

export async function markConfiguredUnverified(
  config: ConfigManager,
  record: ProviderReadinessRecord,
): Promise<ProviderReadinessRecord> {
  const next = { ...record, state: 'configured_unverified' as const };
  await persistProviderReadiness(config, next);
  return next;
}

export async function runRuntimeReadinessTransaction(options: {
  paths: AidenPaths;
  config: ConfigManager;
  resolver: RuntimeResolver;
  providerId: string;
  modelId: string;
  modelVerification?: 'curated' | 'live' | 'unverified' | 'verified';
  apiKeyOverride?: string;
  baseUrlOverride?: string;
  signal?: AbortSignal;
}): Promise<ProviderReadinessRecord> {
  let record = initialReadiness(options.providerId, options.modelId);
  if (!options.config.usesPaths(options.paths)) {
    return {
      ...record,
      state: 'failed_requires_user_action',
      verificationTimestamp: new Date().toISOString(),
      verificationErrorCategory: 'configuration_conflict',
    };
  }
  record = { ...record, state: 'credential_saved' };
  await persistProviderReadiness(options.config, record);

  try {
    const resolution = await options.resolver.describe({
      providerId: options.providerId,
      modelId: options.modelId,
      config: options.config,
      paths: options.paths,
      apiKeyOverride: options.apiKeyOverride,
      baseUrlOverride: options.baseUrlOverride,
      modelVerification: options.modelVerification,
    });
    record = {
      ...record,
      state: 'credential_verified',
      endpointFingerprint: resolution.effectiveCredential?.endpointFingerprint ?? null,
      credentialSource: resolution.effectiveCredential?.credentialSource ?? null,
      transportMode: resolution.apiMode,
    };
    await persistProviderReadiness(options.config, record);
    record = { ...record, state: 'model_selected' };
    await persistProviderReadiness(options.config, record);

    const adapter = await options.resolver.resolve({
      providerId: options.providerId,
      modelId: options.modelId,
      config: options.config,
      paths: options.paths,
      apiKeyOverride: options.apiKeyOverride,
      baseUrlOverride: options.baseUrlOverride,
      modelVerification: options.modelVerification,
    });
    record = { ...record, state: 'runtime_resolved' };
    await persistProviderReadiness(options.config, record);
    const probe = await verifyRuntimeReadiness(adapter, { signal: options.signal });
    const timestamp = new Date().toISOString();
    if (probe.plainCompletion === 'verified') {
      record = {
        ...record,
        state: 'plain_completion_verified',
        plainCompletionStatus: 'verified',
        streamingStatus: probe.streaming,
        verificationTimestamp: timestamp,
      };
      options.config.set(`providers.${options.providerId}.modelVerification`, 'verified');
      await persistProviderReadiness(options.config, record);
    }
    if (probe.toolCall === 'verified') {
      record = {
        ...record,
        state: 'tool_call_verified',
        toolCallStatus: 'verified',
        toolResultReplayStatus: probe.toolResultReplay,
        structuredArgumentsStatus: probe.structuredArguments,
        verificationTimestamp: timestamp,
      };
      await persistProviderReadiness(options.config, record);
      record = { ...record, state: 'complete' };
      await persistProviderReadiness(options.config, record);
      return record;
    }

    const category = probe.errorCategory ?? 'unknown_provider_error';
    record = {
      ...record,
      state: isRetryableReadinessCategory(category)
        ? 'failed_retryable'
        : 'failed_requires_user_action',
      plainCompletionStatus: probe.plainCompletion,
      streamingStatus: probe.streaming,
      toolCallStatus: probe.toolCall,
      toolResultReplayStatus: probe.toolResultReplay,
      structuredArgumentsStatus: probe.structuredArguments,
      verificationTimestamp: timestamp,
      verificationErrorCategory: category,
    };
    await persistProviderReadiness(options.config, record);
    return record;
  } catch (error) {
    const classified = classifyReadinessError(error, 'configuration');
    record = {
      ...record,
      state: classified.retryable ? 'failed_retryable' : 'failed_requires_user_action',
      verificationTimestamp: new Date().toISOString(),
      verificationErrorCategory: classified.category,
    };
    await persistProviderReadiness(options.config, record);
    return record;
  }
}
