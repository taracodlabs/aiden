/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/keyValidator.ts — Aiden v4.0.0 (Phase 14a fix)
 *
 * Validates API keys against provider HTTP endpoints before the setup
 * wizard saves them. Each provider has a lightweight "list models" or
 * "whoami" endpoint that returns 401/403 on a bad key.
 *
 * Security rule: NEVER include the API key value (or any fragment of it)
 * in returned `reason` strings, log lines, or thrown errors. The key is
 * passed through to the request only.
 */

export interface ValidationResult {
  valid: boolean;
  /** Human-readable reason. Never contains the apiKey value. */
  reason?: string;
  /** True if this provider has no validation endpoint (or is OAuth-only). */
  skipped?: boolean;
  skipReason?: string;
}

const TIMEOUT_MS = 8_000;

/** Map non-2xx HTTP status to a result. Never embeds the apiKey. */
function classifyStatus(status: number): ValidationResult {
  if (status >= 200 && status < 300) return { valid: true };
  if (status === 401 || status === 403) {
    return { valid: false, reason: 'Invalid API key' };
  }
  return { valid: false, reason: `Validation endpoint returned ${status}` };
}

/** Extract a safe network-error description; strip anything that could leak the key. */
function networkErrorReason(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as { name?: string; message?: string; code?: string };
    if (anyErr.name === 'AbortError') return 'Network error: request timed out after 8s';
    const code = anyErr.code ? ` (${anyErr.code})` : '';
    const msg = anyErr.message ?? String(err);
    // Defensive: cap message length so a chatty error can't smuggle anything large.
    const trimmed = msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
    return `Network error: ${trimmed}${code}`;
  }
  return `Network error: ${String(err)}`;
}

interface RequestSpec {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

/** Build the per-provider request spec. Returns null for skipped providers. */
function buildRequest(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): RequestSpec | { skip: true; skipReason: string } | null {
  switch (providerId) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      };
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'groq':
      return {
        url: 'https://api.groq.com/openai/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/auth/key',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'together':
      return {
        url: 'https://api.together.xyz/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'gemini':
      return {
        // Key in query string per Google convention.
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        method: 'GET',
        headers: {},
      };
    case 'deepseek':
      return {
        url: 'https://api.deepseek.com/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'mistral':
      return {
        url: 'https://api.mistral.ai/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'zai':
      return {
        url: 'https://api.z.ai/api/paas/v4/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'kimi':
      return {
        url: 'https://api.moonshot.cn/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'nvidia':
      return {
        url: 'https://integrate.api.nvidia.com/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'huggingface':
      return {
        url: 'https://huggingface.co/api/whoami-v2',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'vercel':
      return {
        url: 'https://ai-gateway.vercel.sh/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'custom': {
      const root = (baseUrl ?? '').replace(/\/+$/, '');
      if (!root) {
        // No baseUrl — can't validate. Caller should always provide one for custom.
        return { skip: true, skipReason: 'no baseUrl provided for custom endpoint' };
      }
      return {
        url: `${root}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    }
    case 'ollama': {
      const root = (baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
      return {
        url: `${root}/api/tags`,
        method: 'GET',
        headers: {},
      };
    }
    case 'minimax':
      return { skip: true, skipReason: 'auth method varies; will be verified on first call' };
    case 'nous':
      return { skip: true, skipReason: 'subscription auth method TBD' };
    case 'claude-pro':
      return { skip: true, skipReason: 'OAuth-only, lands v4.1' };
    case 'chatgpt-plus':
      return { skip: true, skipReason: 'OAuth-only, lands v4.1' };
    default:
      return null;
  }
}

/**
 * Validate an API key against the provider's auth-checking endpoint.
 *
 * @param providerId  See PROVIDERS in setupWizard.ts.
 * @param apiKey      Raw key string. Never logged.
 * @param baseUrl     Override for `custom`/`ollama`. Optional otherwise.
 * @param fetchImpl   Injectable fetch (defaults to globalThis.fetch).
 */
export async function validateProviderKey(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
  fetchImpl?: typeof fetch,
): Promise<ValidationResult> {
  const spec = buildRequest(providerId, apiKey, baseUrl);

  if (spec === null) {
    return {
      valid: true,
      skipped: true,
      skipReason: `no validation endpoint configured for ${providerId}`,
    };
  }
  if ('skip' in spec) {
    return { valid: true, skipped: true, skipReason: spec.skipReason };
  }

  const f = fetchImpl ?? (globalThis.fetch as typeof fetch);
  if (!f) {
    return { valid: false, reason: 'Network error: fetch is not available in this runtime' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await f(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
      signal: ctrl.signal,
    });
    return classifyStatus(res.status);
  } catch (err) {
    return { valid: false, reason: networkErrorReason(err) };
  } finally {
    clearTimeout(timer);
  }
}
