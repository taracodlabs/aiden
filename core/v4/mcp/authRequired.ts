/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/authRequired.ts — v4.14: the typed `auth_required` tool result.
 *
 * DESIGN NORTH STAR: auth is RUNTIME infrastructure, not setup-only. A token
 * can die mid-task. The worst bug is an autonomous job hitting expired auth,
 * refresh failing, a RAW 401 coming back, the model reading it as transient,
 * and writing "done" when the remote action never happened — a fake-success,
 * the exact disease verify-before-done exists to kill.
 *
 * So an unrecoverable auth failure must be a TYPED, first-class RESULT the
 * runtime understands — never a raw exception the model can misread. This
 * module defines that result. It carries `success: false` so the per-tool
 * verifier (core/v4/verifier.ts) flags it `failed`, and a structured
 * `auth_required` envelope the failure classifier (core/v4/failureClassifier.ts)
 * reads to return a NON-RECOVERABLE `auth` category. Because the failure is on a
 * mutating tool and verifier-!ok, decideTaskVerdict (core/v4/taskVerification.ts)
 * returns `verification_failed` — the task cannot reach `completed`; it surfaces
 * "needs reauth for <provider>" instead. Same shape as the `sandbox_violation`
 * typed envelope; provider-agnostic.
 */

import type { ToolCallResult } from '../../../providers/v4/types';

/** The structured auth-failure envelope. `retryable` is always false — an auth
 *  wall never clears on a blind retry; the user must re-authorize. */
export interface McpAuthRequiredEnvelope {
  error:       'auth_required';
  /** Which connection needs re-auth (the MCP server / provider name). */
  provider:    string;
  /** Short machine/human reason (token revoked, refresh failed, expired…). */
  reason:      string;
  /** ALWAYS false — never blind-retry an auth wall. */
  retryable:   false;
  /** Exact next action for the user (e.g. "Run /mcp auth github"). */
  reauth_hint: string;
}

/** The tool result the runtime returns instead of a raw 401. */
export interface AuthRequiredToolResult {
  success:       false;
  /** Human string — starts with `auth_required:` and names the provider. */
  error:         string;
  auth_required: McpAuthRequiredEnvelope;
}

/** Build the typed auth-required result for a provider that needs re-auth. */
export function buildMcpAuthRequiredResult(
  provider:    string,
  reason:      string,
  reauthHint:  string,
): AuthRequiredToolResult {
  return {
    success: false,
    error:   `auth_required: needs reauth for ${provider} — ${reason}`,
    auth_required: {
      error:       'auth_required',
      provider,
      reason,
      retryable:   false,
      reauth_hint: reauthHint,
    },
  };
}

/**
 * Read the `auth_required` envelope from a tool result, or null when absent.
 * Defensive — an unexpected shape yields null, never a throw. Used by the
 * failure classifier so ANY tool returning this envelope is classified as a
 * non-recoverable auth wall.
 */
export function readAuthRequired(result: ToolCallResult): McpAuthRequiredEnvelope | null {
  const inner = result.result;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  const env = (inner as { auth_required?: unknown }).auth_required;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const e = env as Record<string, unknown>;
  if (e.error !== 'auth_required' || typeof e.provider !== 'string') return null;
  return {
    error:       'auth_required',
    provider:    e.provider,
    reason:      typeof e.reason === 'string' ? e.reason : '',
    retryable:   false,
    reauth_hint: typeof e.reauth_hint === 'string' ? e.reauth_hint : '',
  };
}
