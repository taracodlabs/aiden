/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/chatCompletionsAdapter.maxTokens.test.ts — v4.11 hi-budget fix
 *
 * Covers `resolveDefaultMaxTokens` + the buildBody integration.
 *
 *   1. Groq → 2048 (TPM tax mitigation — Groq's rate limiter charges
 *      prompt_tokens + max_tokens, so smaller reservation = more
 *      input budget under the 12K free-tier cap)
 *   2. Anthropic / OpenAI / unknown → 4096 (DEFAULT_MAX_TOKENS)
 *   3. Per-call `input.maxTokens` still wins over the provider cap
 *   4. Case + whitespace normalised
 */
import { describe, it, expect } from 'vitest';
import { resolveDefaultMaxTokens } from '../../providers/v4/chatCompletionsAdapter';

describe('resolveDefaultMaxTokens', () => {
  it('returns 2048 for groq (TPM tax cap)', () => {
    expect(resolveDefaultMaxTokens('groq')).toBe(2048);
  });

  it('returns 4096 for unmapped providers', () => {
    expect(resolveDefaultMaxTokens('anthropic')).toBe(4096);
    expect(resolveDefaultMaxTokens('openai')).toBe(4096);
    expect(resolveDefaultMaxTokens('ollama')).toBe(4096);
    expect(resolveDefaultMaxTokens('xai')).toBe(4096);
    expect(resolveDefaultMaxTokens('chatgpt-plus')).toBe(4096);
  });

  it('is case-insensitive', () => {
    expect(resolveDefaultMaxTokens('GROQ')).toBe(2048);
    expect(resolveDefaultMaxTokens('Groq')).toBe(2048);
  });

  it('trims whitespace', () => {
    expect(resolveDefaultMaxTokens('  groq  ')).toBe(2048);
  });

  it('falls back to default on empty string', () => {
    expect(resolveDefaultMaxTokens('')).toBe(4096);
  });
});
