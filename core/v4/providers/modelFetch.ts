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

import { MODEL_CATALOG, type ModelEntry } from '../../../providers/v4/modelCatalog';

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
}

export interface FetchModelsResult {
  models: FetchedModel[];
  /** Where the list came from. */
  source: 'live' | 'fallback';
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
}

const DEFAULT_TIMEOUT_MS = 5000;

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
    }));
  return { models, source: 'fallback', reason };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

interface RawModel { id: string; name?: string; display_name?: string; context_length?: number }

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
      };
    })
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.displayName.localeCompare(b.displayName));
}

async function fetchAnthropic(o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const res = await withTimeout(o.fetchImpl('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
  }), o.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { data?: RawModel[] };
  return body.data ?? [];
}

async function fetchOpenAICompat(url: string, o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const res = await withTimeout(o.fetchImpl(url, {
    headers: { Authorization: `Bearer ${o.apiKey}` },
  }), o.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { data?: RawModel[] };
  return body.data ?? [];
}

async function fetchGemini(o: Required<Pick<FetchOptions, 'apiKey' | 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(o.apiKey)}`;
  const res = await withTimeout(o.fetchImpl(url), o.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number }> };
  // Gemini ids come back as "models/gemini-2.0-flash" — strip the prefix.
  return (body.models ?? []).map((m) => ({
    id: m.name.replace(/^models\//, ''),
    display_name: m.displayName,
    context_length: m.inputTokenLimit,
  }));
}

async function fetchOllama(baseUrl: string, o: Required<Pick<FetchOptions, 'timeoutMs' | 'fetchImpl'>>): Promise<RawModel[]> {
  const res = await withTimeout(o.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`), o.timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json() as { models?: Array<{ name: string; size?: number }> };
  return (body.models ?? []).map((m) => ({ id: m.name, display_name: m.name }));
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

  try {
    let raws: RawModel[];
    switch (opts.providerId) {
      case 'anthropic':
        if (!apiKey) return fallbackFor('anthropic', 'no API key');
        raws = await fetchAnthropic({ apiKey, timeoutMs, fetchImpl });
        break;
      case 'openai':
        if (!apiKey) return fallbackFor('openai', 'no API key');
        raws = await fetchOpenAICompat('https://api.openai.com/v1/models', { apiKey, timeoutMs, fetchImpl });
        break;
      case 'groq':
        if (!apiKey) return fallbackFor('groq', 'no API key');
        raws = await fetchOpenAICompat('https://api.groq.com/openai/v1/models', { apiKey, timeoutMs, fetchImpl });
        break;
      case 'openrouter':
        // OpenRouter exposes /models without auth, but auth gives the user's
        // available subset — we use the public list to populate the picker.
        raws = await fetchOpenAICompat('https://openrouter.ai/api/v1/models', { apiKey: apiKey || 'anon', timeoutMs, fetchImpl });
        break;
      case 'requesty':
        if (!apiKey) return fallbackFor('requesty', 'no API key');
        raws = await fetchOpenAICompat('https://router.requesty.ai/v1/models', { apiKey, timeoutMs, fetchImpl });
        break;
      case 'gemini':
        if (!apiKey) return fallbackFor('gemini', 'no API key');
        raws = await fetchGemini({ apiKey, timeoutMs, fetchImpl });
        break;
      case 'ollama':
        raws = await fetchOllama(opts.baseUrl ?? 'http://localhost:11434', { timeoutMs, fetchImpl });
        break;
      default:
        // Every other provider — together, nvidia, deepseek, mistral, custom,
        // claude-pro, chatgpt-plus, etc. — uses the curated catalog.
        return fallbackFor(opts.providerId);
    }
    const models = normalise(opts.providerId, raws);
    if (models.length === 0) return fallbackFor(opts.providerId, 'empty live response');
    return { models, source: 'live' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fallbackFor(opts.providerId, reason);
  }
}
