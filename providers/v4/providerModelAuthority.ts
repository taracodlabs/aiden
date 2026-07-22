import type { ModelEntry } from './modelCatalog';
import { findModel, listModelsForProvider } from './modelCatalog';
import { getProviderEntry } from './registry';
import {
  PROVIDER_MODEL_POLICIES,
  type ProviderModelPolicy,
} from './providerPolicies';

export type ModelVerification = 'curated' | 'live' | 'unverified' | 'verified';

export interface ResolveModelOptions {
  providerId: string;
  modelId: string;
  verification?: ModelVerification;
  liveModelIds?: readonly string[];
  allowUnverified?: boolean;
}

export interface ResolvedModelSelection {
  model: ModelEntry;
  verification: ModelVerification;
  metadataSource: 'curated' | 'synthetic';
}

function syntheticModel(providerId: string, modelId: string): ModelEntry {
  const provider = getProviderEntry(providerId);
  return {
    id: modelId,
    displayName: modelId,
    providerId,
    contextLength: 128_000,
    supportsToolCalling: provider?.supportsToolCalling ?? false,
    supportsVision: false,
    supportsReasoning: false,
    isDefault: false,
    tier: 'standard',
    notes: 'Provider-confirmed model; curated metadata is not available.',
  };
}

export function providerModelPolicy(providerId: string): ProviderModelPolicy | undefined {
  return PROVIDER_MODEL_POLICIES[providerId];
}

export function providerMainDefault(providerId: string): string | undefined {
  return providerModelPolicy(providerId)?.mainDefault
    ?? listModelsForProvider(providerId).find((model) => model.isDefault)?.id;
}

export function providerAuxiliaryDefault(providerId: string): string | undefined {
  return providerModelPolicy(providerId)?.auxiliaryDefault;
}

export function modelDeprecation(
  providerId: string,
  modelId: string,
): { shutdownDate: string; replacements: readonly string[] } | undefined {
  return providerModelPolicy(providerId)?.deprecated?.[modelId];
}

export function isAutomaticModelCandidate(providerId: string, modelId: string, now = Date.now()): boolean {
  const deprecated = modelDeprecation(providerId, modelId);
  if (!deprecated) return true;
  const shutdown = Date.parse(`${deprecated.shutdownDate}T00:00:00Z`);
  if (!Number.isFinite(shutdown)) return false;
  const imminentWindowMs = 45 * 24 * 60 * 60 * 1000;
  return shutdown - now > imminentWindowMs;
}

export function resolveModelSelection(options: ResolveModelOptions): ResolvedModelSelection | null {
  const live = options.liveModelIds;
  const liveConfirmed = live?.includes(options.modelId) ?? false;
  if (live && !liveConfirmed && !options.allowUnverified && options.verification !== 'unverified') {
    return null;
  }

  const curated = findModel(options.providerId, options.modelId);
  const verification = liveConfirmed
    ? 'live'
    : options.verification
      ?? (curated ? 'curated' : options.allowUnverified ? 'unverified' : undefined);
  if (!verification) return null;

  return {
    model: curated ?? syntheticModel(options.providerId, options.modelId),
    verification,
    metadataSource: curated ? 'curated' : 'synthetic',
  };
}

export function chooseAutomaticModel(
  providerId: string,
  liveModelIds?: readonly string[],
  now = Date.now(),
): string | undefined {
  const preferred = providerMainDefault(providerId);
  if (liveModelIds && liveModelIds.length > 0) {
    if (preferred && liveModelIds.includes(preferred) && isAutomaticModelCandidate(providerId, preferred, now)) {
      return preferred;
    }
    return liveModelIds.find((id) => isAutomaticModelCandidate(providerId, id, now));
  }
  if (preferred && isAutomaticModelCandidate(providerId, preferred, now)) return preferred;
  return listModelsForProvider(providerId).find(
    (model) => isAutomaticModelCandidate(providerId, model.id, now),
  )?.id;
}
