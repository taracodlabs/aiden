/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — the typed `auth_required` anti-fake-success chain, end to end:
 *   build → verifier flags failed → classifier marks NON-RECOVERABLE auth →
 *   decideTaskVerdict blocks `completed` ("needs reauth for <provider>").
 * Plus the regression contrast: a RAW auth string (no envelope) classifies as
 * `other`/recoverable — the exact fake-success hole the typed result closes.
 */
import { describe, it, expect } from 'vitest';

import { buildMcpAuthRequiredResult, readAuthRequired } from '../../../core/v4/mcp/authRequired';
import { defaultVerifier } from '../../../core/v4/verifier';
import { buildDefaultClassifier } from '../../../core/v4/failureClassifier';
import { decideTaskVerdict } from '../../../core/v4/taskVerification';
import type { ToolCallResult } from '../../../providers/v4/types';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';

const TOOL = 'mcp_github_create_issue';
const authRes = () => buildMcpAuthRequiredResult('github', 'token revoked', 'Run /mcp auth github');
const asToolResult = (): ToolCallResult => ({ id: '1', name: TOOL, result: authRes() } as ToolCallResult);

// ── the typed result ─────────────────────────────────────────────────────────
describe('buildMcpAuthRequiredResult / readAuthRequired', () => {
  it('builds a success:false result with a structured, non-retryable envelope', () => {
    const r = authRes();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^auth_required: needs reauth for github/);
    expect(r.auth_required).toEqual({
      error: 'auth_required', provider: 'github', reason: 'token revoked',
      retryable: false, reauth_hint: 'Run /mcp auth github',
    });
  });
  it('reads the envelope back and returns null for non-auth results', () => {
    expect(readAuthRequired(asToolResult())?.provider).toBe('github');
    expect(readAuthRequired({ id: '2', name: 'x', result: { success: true } } as ToolCallResult)).toBeNull();
    expect(readAuthRequired({ id: '3', name: 'x', result: 'plain string' } as ToolCallResult)).toBeNull();
  });
});

// ── the chain: verifier → classifier ─────────────────────────────────────────
describe('auth_required — verifier + classifier', () => {
  it('the verifier flags the typed result as failed (success:false)', () => {
    const v = defaultVerifier(TOOL, {}, asToolResult());
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
  });

  it('the classifier marks it NON-RECOVERABLE auth (never blind-retry an auth wall)', () => {
    const v = defaultVerifier(TOOL, {}, asToolResult());
    const c = buildDefaultClassifier().classify(v, TOOL, {}, asToolResult());
    expect(c?.category).toBe('auth');
    expect(c?.recoverable).toBe(false);
    expect(c?.matchedPattern).toBe('auth_required');
    expect(c?.reason).toContain('github');
    expect(c?.recoveryHint?.action).toBe('request_user_action');
  });

  it('REGRESSION: a raw "needs re-authorization" string (no envelope) is NOT robustly caught → recoverable', () => {
    // This is the pre-fix hole: the raw throw matched no AUTH_PATTERN and fell
    // through to `other`/recoverable — a blind-retry-the-auth-wall / fake-success
    // vector. The typed envelope above closes it.
    const raw: ToolCallResult = { id: '9', name: TOOL, error: 'MCP server "github" needs re-authorization — run /mcp auth github' } as ToolCallResult;
    const v = defaultVerifier(TOOL, {}, raw);
    const c = buildDefaultClassifier().classify(v, TOOL, {}, raw);
    expect(c?.category).not.toBe('auth');
    expect(c?.recoverable).toBe(true);
  });
});

// ── the guarantee: a task cannot complete on an auth-failed side effect ───────
describe('auth_required — verify-before-done blocks completion', () => {
  const mutatingEntry = (): HonestyTraceEntry => ({
    name: TOOL,
    handlerMutates: true, // MCP tools register mutates:true
    result: authRes(),
    verification: defaultVerifier(TOOL, {}, asToolResult()),
  } as HonestyTraceEntry);

  it('a mutating auth-failed side effect → verification_failed, NOT completed', () => {
    const d = decideTaskVerdict([mutatingEntry()]);
    expect(d.verdict).toBe('verification_failed');
    expect(d.verdict).not.toBe('completed');
    expect(d.failures[0].tool).toBe(TOOL);
    expect(d.failures[0].reason).toContain('needs reauth for github');
  });

  it('surfaces the provider so the runtime can say "needs reauth for <provider>"', () => {
    const d = decideTaskVerdict([mutatingEntry()]);
    expect(d.failures.map((f) => f.reason).join(' ')).toMatch(/needs reauth for github/);
  });

  it('a successful mutating side effect still completes (no false blocking)', () => {
    const okEntry: HonestyTraceEntry = {
      name: TOOL, handlerMutates: true,
      result: { success: true, id: 42 },
      verification: { ok: true, confidence: 1, code: 'ok' },
    } as HonestyTraceEntry;
    expect(decideTaskVerdict([okEntry]).verdict).toBe('completed');
  });
});
