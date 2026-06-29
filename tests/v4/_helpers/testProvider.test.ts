import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getTestProvider,
  withRateLimitFallback,
  isRateLimitError,
} from './testProvider';

// Snapshot the relevant env keys before each test so we can clear and
// restore them deterministically.
const TRACKED_KEYS = [
  'GROQ_API_KEY',
  'GROQ_API_KEY_2',
  'GROQ_API_KEY_3',
  'TOGETHER_API_KEY',
  'GROQ_TEST_MODEL',
  'TOGETHER_TEST_MODEL',
];

describe('testProvider helper', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = {};
    for (const k of TRACKED_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TRACKED_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  // ── getTestProvider ─────────────────────────────────────────────

  it('returns groq when GROQ_API_KEY is set', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_primary';
    const p = await getTestProvider();
    expect(p).not.toBeNull();
    expect(p!.source).toBe('groq');
    expect(p!.providerId).toBe('groq');
    expect(p!.modelId).toBe('llama-3.3-70b-versatile');
  });

  it('returns groq2 when only GROQ_API_KEY_2 is set', async () => {
    process.env.GROQ_API_KEY_2 = 'gsk_test_secondary';
    const p = await getTestProvider();
    expect(p).not.toBeNull();
    expect(p!.source).toBe('groq2');
    expect(p!.providerId).toBe('groq');
  });

  it('returns groq3 when only GROQ_API_KEY_3 is set', async () => {
    process.env.GROQ_API_KEY_3 = 'gsk_test_tertiary';
    const p = await getTestProvider();
    expect(p).not.toBeNull();
    expect(p!.source).toBe('groq3');
  });

  it('returns together when only TOGETHER_API_KEY is set', async () => {
    process.env.TOGETHER_API_KEY = 'tk_test_together';
    const p = await getTestProvider();
    expect(p).not.toBeNull();
    expect(p!.source).toBe('together');
    expect(p!.providerId).toBe('together');
    // Together default model is openai/gpt-oss-120b (Tier-0 accessible;
    // replaced Qwen3-235B-…-tput, which is gated behind a higher build tier).
    expect(p!.modelId).toBe('openai/gpt-oss-120b');
  });

  it('returns null when no keys are set', async () => {
    const p = await getTestProvider();
    expect(p).toBeNull();
  });

  it('preferTogether prioritises together over groq', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_primary';
    process.env.TOGETHER_API_KEY = 'tk_test_together';
    const p = await getTestProvider({ preferTogether: true });
    expect(p!.source).toBe('together');
  });

  it('modelHint overrides default for groq tier', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_primary';
    const p = await getTestProvider({ modelHint: 'llama-3.1-8b-instant' });
    expect(p!.modelId).toBe('llama-3.1-8b-instant');
  });

  it('GROQ_TEST_MODEL env var overrides the default', async () => {
    process_env_set('GROQ_API_KEY', 'gsk_test_primary');
    process_env_set('GROQ_TEST_MODEL', 'llama-3.1-8b-instant');
    const p = await getTestProvider();
    expect(p!.modelId).toBe('llama-3.1-8b-instant');
  });

  // ── withRateLimitFallback ───────────────────────────────────────

  it('returns null when given a null initialProvider', async () => {
    const result = await withRateLimitFallback(async () => 'never', null);
    expect(result).toBeNull();
  });

  it('passes through fn result on first-try success', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_primary';
    const initial = await getTestProvider();
    const result = await withRateLimitFallback(
      async (p) => `${p.source}-ok`,
      initial,
    );
    expect(result).toBe('groq-ok');
  });

  it('retries on 429-shaped error and succeeds on second tier', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_primary';
    process.env.GROQ_API_KEY_2 = 'gsk_test_secondary';
    const initial = await getTestProvider();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let calls = 0;
    const result = await withRateLimitFallback(async (p) => {
      calls += 1;
      if (p.source === 'groq') {
        const err = new Error('Provider groq returned 429: rate limit exceeded');
        throw err;
      }
      return `${p.source}-ok`;
    }, initial);

    expect(calls).toBe(2);
    expect(result).toBe('groq2-ok');
    log.mockRestore();
  });

  it('retries through all tiers and returns null when every provider rate-limits', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_primary';
    process.env.GROQ_API_KEY_2 = 'gsk_test_secondary';
    process.env.GROQ_API_KEY_3 = 'gsk_test_tertiary';
    process.env.TOGETHER_API_KEY = 'tk_test_together';
    const initial = await getTestProvider();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await withRateLimitFallback(async () => {
      const err = new Error('429 Too Many Requests');
      throw err;
    }, initial);

    expect(result).toBeNull();
    log.mockRestore();
  });

  it('propagates non-rate-limit errors immediately', async () => {
    process.env.GROQ_API_KEY = 'gsk_test_primary';
    process.env.GROQ_API_KEY_2 = 'gsk_test_secondary';
    const initial = await getTestProvider();

    let calls = 0;
    await expect(
      withRateLimitFallback(async () => {
        calls += 1;
        throw new Error('logic bug — invalid argument schema');
      }, initial),
    ).rejects.toThrow(/logic bug/);

    expect(calls).toBe(1);
  });

  // ── isRateLimitError ────────────────────────────────────────────

  it('isRateLimitError matches 429, rate limit, ProviderRateLimitError', () => {
    expect(isRateLimitError(new Error('429: too many requests'))).toBe(true);
    expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('rate-limit hit'))).toBe(true);
    expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true);

    const named = new Error('boom');
    named.name = 'ProviderRateLimitError';
    expect(isRateLimitError(named)).toBe(true);

    const flagged: any = new Error('something');
    flagged.rateLimit = true;
    expect(isRateLimitError(flagged)).toBe(true);

    expect(isRateLimitError(new Error('500 server error'))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

// Tiny helper to keep the env-mutation lines visually consistent.
function process_env_set(k: string, v: string): void {
  process.env[k] = v;
}
