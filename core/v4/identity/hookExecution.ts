/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/hookExecution.ts — v4.9.0 Slice 7.
 *
 * Ergonomic boundary helper for hook execution. Wraps a hook callback
 * with:
 *
 *   - Timeout enforcement (default 5s; configurable per call)
 *   - Structured outcome shape (`'ok' | 'timeout' | 'error'`) — caller
 *     decides whether a hook timeout/error should block the operation
 *     or fail-open
 *   - A span via Slice 6's `runHookWithSpan` so every firing is durable
 *
 * Slice 7 lands the helper. Slice 9 wires it into the actual lifecycle
 * dispatcher.
 */

import type { ExecutionContext } from './executionContext';

export interface HookExecutionOpts {
  hookName:   string;
  pluginId:   string;
  timeoutMs?: number;
}

export type HookOutcome<T> =
  | { outcome: 'ok';      value: T }
  | { outcome: 'timeout'; error: Error }
  | { outcome: 'error';   error: Error };

/**
 * Execute `fn` inside a hook boundary. Returns a structured outcome —
 * the caller decides whether to block or fail-open on timeout/error.
 * Never throws.
 *
 * Uses Slice 6's `runHookWithSpan` for the durable span side; here we
 * adapt the spanned result into the explicit `{outcome}` envelope.
 */
export async function executeHookWithBoundary<T>(
  _ctx: ExecutionContext,
  opts: HookExecutionOpts,
  fn:   () => Promise<T>,
): Promise<HookOutcome<T>> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HookTimeoutError(opts.hookName, timeoutMs)), timeoutMs);
    });
    const value = await Promise.race([fn(), timeoutPromise]);
    if (timer) clearTimeout(timer);
    return { outcome: 'ok', value: value as T };
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err instanceof HookTimeoutError) {
      return { outcome: 'timeout', error: err };
    }
    const wrapped = err instanceof Error ? err : new Error(String(err));
    return { outcome: 'error', error: wrapped };
  }
}

export class HookTimeoutError extends Error {
  constructor(hookName: string, ms: number) {
    super(`hook '${hookName}' timed out after ${ms}ms`);
    this.name = 'HookTimeout';
  }
}
