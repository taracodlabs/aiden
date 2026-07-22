/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/providers/modelFetch.ts — ONB1 slice 6.
 *
 * Live `/models` enumeration used by the onboarding model picker.
 * Six providers have first-class live-fetch implementations:
 *   - anthropic   GET  https://api.anthropic.com/v1/models
 *   - openai      GET  https://api.openai.com/v1/models
 *   - groq        GET  https://api.groq.com/openai/v1/models
 *   - openrouter  GET  https://openrouter.ai/api/v1/models
 *   - gemini      GET  https://generativelanguage.googleapis.com/v1beta/models
 *   - ollama      GET  http://localhost:11434/api/tags
 *
 * Every other provider falls through to the curated MODEL_CATALOG
 * static list (providers/v4/modelCatalog.ts).
 *
 * Behaviour contract:
 *   - 5-second hard timeout per request (configurable).
 *   - On any failure (network, non-2xx, malformed body) we return the
 *     static fallback with `{ source: 'fallback', reason }` so the
 *     picker can show the muted "Couldn't reach API" hint.
 *   - Results are sorted with "recommended" / default models first,
 *     then by display name.
 *   - No client-side cost-tier annotation — the curated catalog owns
 *     pricing where it's known; the picker shows "$" tiers from the
 *     fallback only.
 */

import { createHash } from 'node:crypto';
import { MODEL_CATALOG, type ModelEntry } from '../../../providers/v4/modelCatalog';
import { RequestLifecycle, requestDeadlines } from '../../../providers/v4/requestLifecycle';

export interface FetchedModel {
  /** Wire-format model id. */
  id: string;
  /** Human-friendly name. Falls back to `id`. */
  displayName: string;
  /** Optional context length, when the upstream response carries it. */
  contextLength?: number;
  /** True when the curated catalog marks this as the recommended default. */
  recommended?: boolean;
  /** Cost tier hint, '$' / '$$' / '$$$'. Only set on fallback rows. */
  tier?: '$' | '$$' | '$$$' | 'free';
  /** Model creator, distinct from the inference provider. */
  creator?: string;
  /** Inference host shown when it differs from the model creator. */
  hostedBy?: string;
  supportsToolCalling?: boolean;
  supportsStructuredOutput?: boolean;
  compatibleWithAgent?: boolean;
  incompatibilityReason?: string;
}

export interface FetchModelsResult {
  models: FetchedModel[];
  /** Where the list came from. */
  source: 'live' | 'last-known-good' | 'fallback';
  cacheStatus?: 'fresh' | 'cached' | 'last-known-good';
  /** When `source === 'fallback'`, the reason (timeout, 401, parse, etc.). */
  reason?: string;
}

export interface FetchOptions {
  /** Provider id (lowercase). */
  providerId: string;
  /** API key for providers that gate `/models` behind auth. */
  apiKey?: string;
  /** Override base URL (e.g. self-hosted Ollama on remote host). */
  baseUrl?: string;
  /** Hard timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Override fetch — tests inject a stub. */
  fetchImpl?: typeof fetch;
  includeIncompatible?: boolean;
  refresh?: boolean;
  cacheTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface DiscoveryCacheEntry {
  fetchedAt: number;
  models: FetchedModel[];
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

export function clearModelDiscoveryCache(): void {
  discoveryCache.clear();
}

function discoveryCacheKey(opts: FetchOptions): string {
  const credentialFingerprint = opts.apiKey
    ? createHash('sha256').update(opts.apiKey).digest('hex').slice(0, 16)
    : 'anonymous';
  return [
    opts.providerId,
    opts.baseUrl ?? '',
    credentialFingerprint,
    opts.includeIncompatible ? 'all' : 'compatible',
  ].join('|');
}

function tierFromPricing(p?: ModelEntry['pricing']): FetchedModel['tier'] {
  if (!p) return undefined;
  const avg = (p.inputPerM + p.outputPerM) / 2;
  if (avg <= 0) return 'free';
  if (avg < 2) return '$';
  if (avg < 10) return '$$';
  return '$$$';
}

function fallbackFor(providerId: string, reason?: string): FetchModelsResult {
  const entries = MODEL_CATALOG.filter((m) => m.providerId === providerId);
  const models = entries
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName))
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      contextLength: m.contextLength,
      recommended: m.isDefault,
      tier: tierFromPricing(m.pricing),
      creator: m.creator,
      hostedBy: m.hostedBy,
    }));
  return { models, source: 'fallback', reason };
}

interface RawProviderRoute {
  provider?: string;
  status?: string;
  context_length?: number;
  supports_tools?: boolean;
  supports_structured_output?: boolean;
}

function safeDiscoveryReason(error: unknown): string {
  const record = error && typeof error === 'object'
    ? error as { category?: string; code?: string; message?: string }
    : {};
  if (record.category?.endsWith('_timeout') || /timeout/i.test(record.message ?? '')) {
    return 'provider discovery timeout';
  }
  if (record.code === 'ENOTFOUND' || record.code === 'EAI_AGAIN') return 'provider hostname unavailable';
  if (error instanceof SyntaxError) return 'malformed model catalogue response';
  if (/^HTTP \d{3}$/.test(record.message ?? '')) return record.message!;
  return 'provider discovery unavailable';
}

interface RawModel {
  id: string;
  name?: string;
  display_name?: string;
  context_length?: number;
  type?: string;
  organization?: string;
  owned_by?: string;
  hosted_by?: string;
  supports_tools?: boolean;
  supports_structured_output?: boolean;
  compatible_with_agent?: boolean;
  incompatibility_reason?: string;
  providers?: RawProviderRoute[];
}

async function fetchJson(
  providerId: string,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; body: unknown }> {
  const lifecycle = new RequestLifecycle(providerId, requestDeadlines(timeoutMs));
  try {
    const response = await lifecycle.race(fetchImpl(url, { ...init, signal: lifecycle.signal }));
    lifecycle.markHeaders();
    const bodyText = await lifecycle.readText(response);
    const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
    return { response, body };
  } catch (error) {
    throw lifecycle.classify(error);
  } finally {
    lifecycle.cleanup();
  }
}

function normalise(providerId: string, raws: RawModel[]): FetchedModel[] {
  // Cross-reference the static catalog for recommended flags + display names
  // (live responses rarely include the friendly name).
  const cat = new Map(MODEL_CATALOG.filter((m) => m.providerId === providerId).map((m) => [m.id, m]));
  return raws
    .filter((m) => m && typeof m.id === 'string' && m.id.length > 0)
    .map((m) => {
      const c = cat.get(m.id);
      return {
        id: m.id,
        displayName: c?.displayName ?? m.display_name ?? m.name ?? m.id,
        contextLength: c?.contextLength ?? m.context_length,
        recommended: c?.isDefault,
        tier: tierFromPricing(c?.pricing),
        creator: c?.creator ?? m.organization ?? m.owned_by,
        hostedBy: c?.hostedBy ?? m.hosted_by,
        supportsToolCalling: m.supports_tools ?? c?.supportsToolCalling,
        supportsStructuredOutput: m.supports_structured_output,
        compatibleWithAgent: m.compatible_with_agent ?? true,
        incompatibilityReason: m.incompatibility_reason,
      };
    })
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.displayName.localeCompare(b.displayName));
}

async function fetchMessageApiModels(o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const { response, body } = await fetchJson('anthropic', 'https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
  }, o.timeoutMs, o.fetchImpl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (body as { data?: RawModel[] }).data ?? [];
}

async function fetchCompatibleModels(url: string, o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const { response, body } = await fetchJson('compatible', url, {
    headers: { Authorization: `Bearer ${o.apiKey}` },
  }, o.timeoutMs, o.fetchImpl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (body as { data?: RawModel[] }).data ?? [];
}

async function fetchTogetherModels(
  o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>,
  includeIncompatible: boolean,
): Promise<RawModel[]> {
  const { response, body } = await fetchJson(
    'together',
    'https://api.together.xyz/v1/models?dedicated=false',
    { headers: { Authorization: `Bearer ${o.apiKey}` } },
    o.timeoutMs,
    o.fetchImpl,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const list = Array.isArray(body) ? body as RawModel[] : [];
  return list.flatMap((model) => {
    const compatible = model.type === 'chat';
    if (!includeIncompatible && !compatible) return [];
    return [{
      ...model,
      compatible_with_agent: compatible,
      incompatibility_reason: compatible ? undefined : `not a chat model (${model.type ?? 'unknown type'})`,
    }];
  });
}

function classifyGroqModels(models: RawModel[], includeIncompatible: boolean): RawModel[] {
  return models.flatMap((model) => {
    const incompatibleFamily = /(?:whisper|orpheus|guard|compound)/i.test(model.id);
    if (!includeIncompatible && incompatibleFamily) return [];
    return [{
      ...model,
      compatible_with_agent: !incompatibleFamily,
      incompatibility_reason: incompatibleFamily
        ? 'not a general chat model with custom tool replay'
        : undefined,
    }];
  });
}

async function fetchHuggingFaceModels(
  o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>,
  includeIncompatible: boolean,
): Promise<RawModel[]> {
  const models = await fetchCompatibleModels('https://router.huggingface.co/v1/models', o);
  return models.flatMap((model) => {
    const liveRoutes = (model.providers ?? []).filter((route) => route.status === 'live');
    const toolRoute = liveRoutes.find((route) => route.supports_tools === true);
    const selectedRoute = toolRoute ?? liveRoutes[0];
    const compatible = !!toolRoute;
    if (!includeIncompatible && !compatible) return [];
    return [{
      ...model,
      context_length: selectedRoute?.context_length ?? model.context_length,
      hosted_by: selectedRoute?.provider,
      supports_tools: selectedRoute?.supports_tools ?? false,
      supports_structured_output: selectedRoute?.supports_structured_output,
      compatible_with_agent: compatible,
      incompatibility_reason: compatible
        ? undefined
        : liveRoutes.length === 0
          ? 'no live inference route'
          : 'tool calling not advertised by any live route',
    }];
  });
}

async function fetchGenerativeApiModels(o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(o.apiKey)}`;
  const { response, body } = await fetchJson('generative-api', url, undefined, o.timeoutMs, o.fetchImpl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = body as { models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number }> };
  // Gemini ids come back as "models/gemini-2.0-flash" — strip the prefix.
  return (parsed.models ?? []).map((m) => ({
    id: m.name.replace(/^models\//, ''),
    display_name: m.displayName,
    context_length: m.inputTokenLimit,
  }));
}

async function fetchLocalRuntimeModels(baseUrl: string, o: Required<Pick<FetchOptions, 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const { response, body } = await fetchJson(
    'local-runtime',
    `${baseUrl.replace(/\/+$/, '')}/api/tags`,
    undefined,
    o.timeoutMs,
    o.fetchImpl,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((body as { models?: Array<{ name: string; size?: number }> }).models ?? [])
    .map((m) => ({ id: m.name, display_name: m.name }));
}

/**
 * Fetch available models for `providerId`, falling back to the
 * curated catalog when the live endpoint is unreachable, the key is
 * missing, or the response is malformed.
 */
export async function fetchModels(opts: FetchOptions): Promise<FetchModelsResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? '';
  const cacheKey = discoveryCacheKey(opts);
  const cached = discoveryCache.get(cacheKey);
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!opts.refresh && cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
    return { models: cached.models, source: 'live', cacheStatus: 'cached' };
  }

  try {
    let raws: RawModel[];
    switch (opts.providerId) {
      case 'anthropic':
        if (!apiKey) return fallbackFor('anthropic', 'no API key');
        raws = await fetchMessageApiModels({ apiKey, timeoutMs, fetchImpl });
        break;
      case 'openai':
        if (!apiKey) return fallbackFor('openai', 'no API key');
        raws = await fetchCompatibleModels('https://api.openai.com/v1/models', { apiKey, timeoutMs, fetchImpl });
        break;
      case 'groq':
        if (!apiKey) return fallbackFor('groq', 'no API key');
        raws = classifyGroqModels(
          await fetchCompatibleModels('https://api.groq.com/openai/v1/models', { apiKey, timeoutMs, fetchImpl }),
          opts.includeIncompatible ?? false,
        );
        break;
      case 'together':
        if (!apiKey) return fallbackFor('together', 'no API key');
        raws = await fetchTogetherModels(
          { apiKey, timeoutMs, fetchImpl },
          opts.includeIncompatible ?? false,
        );
        break;
      case 'deepseek':
        if (!apiKey) return fallbackFor('deepseek', 'no API key');
        raws = await fetchCompatibleModels('https://api.deepseek.com/v1/models', { apiKey, timeoutMs, fetchImpl });
        break;
      case 'huggingface':
        if (!apiKey) return fallbackFor('huggingface', 'no API key');
        raws = await fetchHuggingFaceModels(
          { apiKey, timeoutMs, fetchImpl },
          opts.includeIncompatible ?? false,
        );
        break;
      case 'openrouter':
        // OpenRouter exposes /models without auth, but auth gives the user's
        // available subset — we use the public list to populate the picker.
        raws = await fetchCompatibleModels('https://openrouter.ai/api/v1/models', { apiKey: apiKey || 'anon', timeoutMs, fetchImpl });
        break;
      case 'gemini':
        if (!apiKey) return fallbackFor('gemini', 'no API key');
        raws = await fetchGenerativeApiModels({ apiKey, timeoutMs, fetchImpl });
        break;
      case 'ollama':
        raws = await fetchLocalRuntimeModels(opts.baseUrl ?? 'http://localhost:11434', { timeoutMs, fetchImpl });
        break;
      default:
        // Every other provider — together, nvidia, deepseek, mistral, custom,
        // chatgpt-plus, etc. — uses the curated catalog.
        return fallbackFor(opts.providerId);
    }
    const models = normalise(opts.providerId, raws);
    if (models.length === 0) return fallbackFor(opts.providerId, 'empty live response');
    discoveryCache.set(cacheKey, { fetchedAt: Date.now(), models });
    return { models, source: 'live', cacheStatus: 'fresh' };
  } catch (err) {
    const reason = safeDiscoveryReason(err);
    if (cached) {
      return {
        models: cached.models,
        source: 'last-known-good',
        cacheStatus: 'last-known-good',
        reason,
      };
    }
    return fallbackFor(opts.providerId, reason);
  }
}
