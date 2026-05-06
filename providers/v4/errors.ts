/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/errors.ts — Aiden v4.0.0
 *
 * Error taxonomy for provider adapters. Adapters throw these so callers
 * (AidenAgent, fallback strategies, future provider chain) can distinguish
 * retryable transport failures from permanent request bugs.
 *
 * Status: PHASE 3.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly providerName: string,
    public readonly statusCode?: number,
    public readonly raw?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Thrown when an in-flight request exceeds `timeoutMs`. Always retryable. */
export class ProviderTimeoutError extends ProviderError {
  constructor(providerName: string, timeoutMs: number) {
    super(
      `Provider ${providerName} timed out after ${timeoutMs}ms`,
      providerName,
      undefined,
      undefined,
      true,
    );
    this.name = 'ProviderTimeoutError';
  }
}

/** Thrown after retries are exhausted on HTTP 429. Caller may pause and retry. */
export class ProviderRateLimitError extends ProviderError {
  constructor(providerName: string, raw?: unknown) {
    super(
      `Provider ${providerName} rate limited`,
      providerName,
      429,
      raw,
      true,
    );
    this.name = 'ProviderRateLimitError';
  }
}
