import { describe, it, expect } from 'vitest';

import { validateProviderKey } from '../../../cli/v4/keyValidator';

/** Build a fake fetch that records calls and returns a canned Response. */
function fakeFetch(handler: (url: string, init: RequestInit) => Partial<Response>): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const partial = handler(String(url), init);
    return {
      ok: (partial.status ?? 200) < 300,
      status: 200,
      ...partial,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const FAKE_KEY = 'sk-test-NEVER-LEAK-ME-12345';

describe('keyValidator', () => {
  it('Anthropic 200 → valid', async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ status: 200 }));
    const r = await validateProviderKey('anthropic', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(true);
    expect(calls[0].url).toContain('api.anthropic.com');
    expect(calls[0].init.method).toBe('POST');
    // Reason (if any) must not contain the key.
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Anthropic 401 → invalid with reason "Invalid API key"', async () => {
    const { fetch: f } = fakeFetch(() => ({ status: 401 }));
    const r = await validateProviderKey('anthropic', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Invalid API key');
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Groq 200 → valid', async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ status: 200 }));
    const r = await validateProviderKey('groq', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(true);
    expect(calls[0].url).toContain('api.groq.com');
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Groq 401 → invalid', async () => {
    const { fetch: f } = fakeFetch(() => ({ status: 401 }));
    const r = await validateProviderKey('groq', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Invalid API key');
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Together 200 → valid', async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ status: 200 }));
    const r = await validateProviderKey('together', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(true);
    expect(calls[0].url).toContain('api.together.xyz');
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Together 401 → invalid', async () => {
    const { fetch: f } = fakeFetch(() => ({ status: 401 }));
    const r = await validateProviderKey('together', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('Invalid API key');
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Gemini 200 with key in query string', async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ status: 200 }));
    const r = await validateProviderKey('gemini', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(true);
    expect(calls[0].url).toContain('generativelanguage.googleapis.com');
    // Query string carries the key.
    expect(calls[0].url).toContain(`?key=${encodeURIComponent(FAKE_KEY)}`);
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Network timeout → invalid with timeout reason', async () => {
    // Fetch that aborts when the AbortController fires.
    const f = (async (_url: string, init: RequestInit = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as { name?: string }).name = 'AbortError';
            reject(err);
          });
        }
        // Simulate immediate abort by triggering it on next tick.
        // The validator's internal 8s timer would do this normally;
        // we shortcut via a microtask abort.
        queueMicrotask(() => {
          if (signal && !signal.aborted) {
            // Manually fire abort to short-circuit the test.
            (signal as unknown as { dispatchEvent?: (e: Event) => void }).dispatchEvent?.(
              new Event('abort'),
            );
          }
        });
      });
    }) as unknown as typeof fetch;

    // To deterministically trigger the AbortError path, call a fetch that
    // throws an AbortError directly.
    const f2 = (async () => {
      const err = new Error('The operation was aborted');
      (err as { name?: string }).name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    const r = await validateProviderKey('openai', FAKE_KEY, undefined, f2);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/timed out|abort/i);
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
    void f; // silence unused
  });

  it('Network error (TypeError) → invalid with descriptive reason', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await validateProviderKey('openai', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/Network error/);
    expect(r.reason).toMatch(/ECONNREFUSED/);
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Unknown providerId → skipped', async () => {
    const { fetch: f } = fakeFetch(() => ({ status: 200 }));
    const r = await validateProviderKey('not-a-real-provider', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/no validation endpoint/);
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('chatgpt-plus → skipped with OAuth reason', async () => {
    const { fetch: f } = fakeFetch(() => ({ status: 200 }));
    const r = await validateProviderKey('chatgpt-plus', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/OAuth/i);
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Ollama 200 on /api/tags → valid', async () => {
    const { fetch: f, calls } = fakeFetch(() => ({ status: 200 }));
    const r = await validateProviderKey('ollama', '', undefined, f);
    expect(r.valid).toBe(true);
    expect(calls[0].url).toContain('/api/tags');
  });

  it('Custom endpoint with baseUrl 200 → valid; 401 → invalid', async () => {
    const ok = fakeFetch(() => ({ status: 200 }));
    const okRes = await validateProviderKey('custom', FAKE_KEY, 'https://api.example.com/v1', ok.fetch);
    expect(okRes.valid).toBe(true);
    expect(ok.calls[0].url).toBe('https://api.example.com/v1/models');

    const bad = fakeFetch(() => ({ status: 401 }));
    const badRes = await validateProviderKey('custom', FAKE_KEY, 'https://api.example.com/v1', bad.fetch);
    expect(badRes.valid).toBe(false);
    expect(badRes.reason).toBe('Invalid API key');
    expect(badRes.reason ?? '').not.toContain(FAKE_KEY);
  });

  it('Other non-2xx (500) → invalid with status in reason', async () => {
    const { fetch: f } = fakeFetch(() => ({ status: 500 }));
    const r = await validateProviderKey('openai', FAKE_KEY, undefined, f);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/500/);
    expect(r.reason ?? '').not.toContain(FAKE_KEY);
  });
});
