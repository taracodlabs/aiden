/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

import { RequestLifecycle, requestDeadlines } from '../../../providers/v4/requestLifecycle';
/**
 * core/v4/providers/probe.ts — ONB1 slice 7.
 *
 * Three-step connection validator run after the user enters an API
 * key during the onboarding flow. Replaces the wizard's single
 * `validateProviderKey` round-trip with discrete probes so the user
 * sees exactly which capability fails:
 *
 *   Step 1  Sending test request    → key + auth header accepted
 *   Step 2  Verifying model access  → chosen model is reachable
 *   Step 3  Checking tool calls     → tool_use is supported
 *
 * Each step returns a `ProbeStepResult` independently; the runner
 * stops on the first failure. The error envelope is categorised so
 * the UX can branch: auth → "key was rejected"; rate-limit → "wait
 * or try another provider"; model-not-found → "model not on this
 * key's allow-list"; network → "couldn't reach API".
 *
 * No client-side cost: each probe uses the cheapest call available
 * (max_tokens=1, GET /models, or a no-op tool-definition send).
 */

export type ProbeCategory =
  | 'auth'
  | 'rate-limit'
  | 'model-not-found'
  | 'tool-unsupported'
  | 'network'
  | 'unknown';

export interface ProbeStepResult {
  step: 'auth' | 'model' | 'tools';
  ok: boolean;
  /** When ok=false. */
  category?: ProbeCategory;
  /** When ok=false — human-readable, never embeds the apiKey. */
  reason?: string;
  /** When rate-limited, suggested seconds to wait (parsed from Retry-After). */
  retryAfterSec?: number;
}

export interface ProbeOptions {
  providerId: string;
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  /** Hard per-step timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Test injection. */
  fetchImpl?: typeof fetch;
}

export interface ProbeResult {
  ok: boolean;
  steps: ProbeStepResult[];
}

const DEFAULT_TIMEOUT_MS = 8000;

function classifyStatus(status: number, retryAfter?: string | null): { category: ProbeCategory; reason: string; retryAfterSec?: number } {
  if (status === 401 || status === 403) return { category: 'auth', reason: 'API key rejected' };
  if (status === 404) return { category: 'model-not-found', reason: 'Model not on this key\'s allow-list' };
  if (status === 429) {
    const sec = retryAfter ? parseInt(retryAfter, 10) : undefined;
    return { category: 'rate-limit', reason: 'Rate-limited by provider', retryAfterSec: Number.isFinite(sec ?? NaN) ? sec : undefined };
  }
  if (status >= 500) return { category: 'network', reason: `Upstream error (HTTP ${status})` };
  return { category: 'unknown', reason: `HTTP ${status}` };
}

function classifyError(err: unknown): { category: ProbeCategory; reason: string } {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'TIMEOUT' || e.name === 'AbortError') return { category: 'network', reason: 'Request timed out' };
    const msg = e.message ?? String(err);
    return { category: 'network', reason: msg.length > 160 ? msg.slice(0, 157) + '...' : msg };
  }
  return { category: 'unknown', reason: String(err) };
}

interface ProbeRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

/**
 * Step 1 — key works. Cheapest GET we can issue per provider; for
 * Anthropic we POST a 1-token /v1/messages because they don't expose
 * a no-auth /models for keys without billing.
 */
function buildAuthRequest(o: ProbeOptions): ProbeRequest | null {
  const apiKey = o.apiKey;
  switch (o.providerId) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'openai':
      return { url: 'https://api.openai.com/v1/models', method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } };
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/models', method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } };
    case 'openrouter':
      return { url: 'https://openrouter.ai/api/v1/auth/key', method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } };
    case 'gemini':
      return { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, method: 'GET', headers: {} };
    case 'together':
      return { url: 'https://api.together.xyz/v1/models', method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } };
    case 'nvidia':
      return { url: 'https://integrate.api.nvidia.com/v1/models', method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } };
    case 'ollama': {
      const root = (o.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
      return { url: `${root}/api/tags`, method: 'GET', headers: {} };
    }
    case 'custom_openai': {
      const root = (o.baseUrl ?? '').replace(/\/+$/, '');
      if (!root) return null;
      return { url: `${root}/models`, method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } };
    }
    default:
      return null;
  }
}

/**
 * Step 2 — model access. Re-uses the models list from step 1 when
 * possible (single GET), but issues a 1-token completion when the
 * provider's /models is incomplete (Anthropic returns paginated;
 * Ollama returns local tags only). The runner caches the step-1
 * body so step 2 doesn't double-fetch.
 */
function buildModelCheckRequest(o: ProbeOptions): ProbeRequest | null {
  switch (o.providerId) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': o.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: o.modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      };
    default:
      // For OpenAI-compatible providers we trust the /models list parsed
      // in step 1. The runner short-circuits and just checks membership.
      return null;
  }
}

function buildToolCheckRequest(o: ProbeOptions): ProbeRequest | null {
  switch (o.providerId) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: o.modelId,
          max_tokens: 1,
          tools: [{ name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } }],
          messages: [{ role: 'user', content: 'noop' }],
        }),
      };
    case 'openai':
    case 'groq':
    case 'openrouter':
    case 'together':
    case 'nvidia':
    case 'custom':
    case 'custom_openai':
      return {
        url: o.providerId === 'openai'
          ? 'https://api.openai.com/v1/chat/completions'
          : o.providerId === 'groq'
            ? 'https://api.groq.com/openai/v1/chat/completions'
            : o.providerId === 'openrouter'
              ? 'https://openrouter.ai/api/v1/chat/completions'
              : o.providerId === 'together'
                ? 'https://api.together.xyz/v1/chat/completions'
                : o.providerId === 'custom_openai' || o.providerId === 'custom'
                  ? `${(o.baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`
                  : 'https://integrate.api.nvidia.com/v1/chat/completions',
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: o.modelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'noop' }],
          tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
        }),
      };
    default:
      // Local (Ollama) and providers without tool_use support — skip.
      return null;
  }
}

async function runRequest(req: ProbeRequest, o: ProbeOptions): Promise<{ status: number; bodyText: string; retryAfter: string | null }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lifecycle = new RequestLifecycle(o.providerId, requestDeadlines(timeoutMs));
  try {
    const res = await lifecycle.race(fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: lifecycle.signal,
    }));
    lifecycle.markHeaders();
    const retryAfter = res.headers.get('retry-after');
    const bodyText = await lifecycle.readText(res);
    return { status: res.status, bodyText, retryAfter };
  } catch (error) {
    throw lifecycle.classify(error);
  } finally {
    lifecycle.cleanup();
  }
}

/**
 * Run the 3-step probe. Stops on first failure and returns the
 * partial trace so the UX can render which step turned red.
 */
export async function runProbe(o: ProbeOptions): Promise<ProbeResult> {
  const steps: ProbeStepResult[] = [];

  // Step 1 — auth
  const authReq = buildAuthRequest(o);
  let modelsBody = '';
  if (!authReq) {
    steps.push({ step: 'auth', ok: false, category: 'unknown', reason: 'No probe endpoint for this provider' });
    return { ok: false, steps };
  }
  try {
    const r = await runRequest(authReq, o);
    if (r.status >= 200 && r.status < 300) {
      steps.push({ step: 'auth', ok: true });
      modelsBody = r.bodyText;
    } else {
      const cls = classifyStatus(r.status, r.retryAfter);
      steps.push({ step: 'auth', ok: false, ...cls });
      return { ok: false, steps };
    }
  } catch (err) {
    steps.push({ step: 'auth', ok: false, ...classifyError(err) });
    return { ok: false, steps };
  }

  // Step 2 — model access
  const modelReq = buildModelCheckRequest(o);
  if (modelReq) {
    // Provider needs a real completion call (e.g. Anthropic).
    try {
      const r = await runRequest(modelReq, o);
      if (r.status >= 200 && r.status < 300) {
        steps.push({ step: 'model', ok: true });
      } else {
        const cls = classifyStatus(r.status, r.retryAfter);
        steps.push({ step: 'model', ok: false, ...cls });
        return { ok: false, steps };
      }
    } catch (err) {
      steps.push({ step: 'model', ok: false, ...classifyError(err) });
      return { ok: false, steps };
    }
  } else {
    // OpenAI-compatible: check membership in the /models body from step 1.
    // Providers disagree on the envelope: OpenAI/Groq wrap the list in
    // `{ data: [...] }`, while Together returns a bare top-level array.
    // Accept either shape — assuming `.data` made the probe report
    // "not in this key's catalog" for EVERY Together model.
    let found = false;
    try {
      const body = JSON.parse(modelsBody) as { data?: Array<{ id: string }> } | Array<{ id: string }>;
      const list = Array.isArray(body) ? body : body.data;
      found = Array.isArray(list) && list.some((m) => m.id === o.modelId);
    } catch { /* malformed body — treat as unknown */ }
    if (found) {
      steps.push({ step: 'model', ok: true });
    } else {
      steps.push({ step: 'model', ok: false, category: 'model-not-found', reason: `Model '${o.modelId}' not in this key's catalog` });
      return { ok: false, steps };
    }
  }

  // Step 3 — tool support
  const toolReq = buildToolCheckRequest(o);
  if (!toolReq) {
    steps.push({ step: 'tools', ok: true });
    return { ok: true, steps };
  }
  try {
    const r = await runRequest(toolReq, o);
    if (r.status >= 200 && r.status < 300) {
      steps.push({ step: 'tools', ok: true });
      return { ok: true, steps };
    }
    // 400 with a body that mentions tools is the typical "model doesn't
    // support tool_use" signature — we categorise as tool-unsupported
    // rather than generic auth.
    if (r.status === 400 && /tool/i.test(r.bodyText)) {
      steps.push({ step: 'tools', ok: false, category: 'tool-unsupported', reason: 'Model does not support tool calls' });
    } else {
      const cls = classifyStatus(r.status, r.retryAfter);
      steps.push({ step: 'tools', ok: false, ...cls });
    }
    return { ok: false, steps };
  } catch (err) {
    steps.push({ step: 'tools', ok: false, ...classifyError(err) });
    return { ok: false, steps };
  }
}
