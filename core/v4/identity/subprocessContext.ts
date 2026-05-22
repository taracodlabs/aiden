/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/subprocessContext.ts — v4.9.0 Slice 7.
 *
 * AsyncLocalStorage does NOT cross subprocess boundaries; the child's
 * Node runtime has its own ALS instance. To preserve correlation, we
 * stamp the parent's ExecutionContext into the child's `env` block at
 * spawn time. The child reconstitutes via `readContextFromEnv` and
 * enters its own `runWithContext(ctx, fn)` frame on startup.
 *
 * Wire-format choice: ten env vars instead of one JSON-encoded blob.
 * Reasons:
 *   - Greppable in `ps -ef`-style output for forensics
 *   - Individual vars survive partial truncation by intermediate
 *     shells / sudo / containers that mangle long env values
 *   - The set is small + stable; no schema-version footgun
 *
 * The child's spanId is ALWAYS freshly minted — never reuse the
 * parent's spanId in the child, because the child's spans are
 * causally downstream and should chain via `parentSpanId`.
 */

import { newSpanId } from './ids';
import type { ExecutionContext, ExecutionSource } from './executionContext';

const ENV_PREFIX = 'AIDEN_';

/**
 * Build a child-process env block carrying the parent's context.
 * Caller spreads `baseEnv` first so AIDEN_* keys win — these are
 * never user-overridable from the parent invocation.
 */
export function spawnEnvWithContext(
  ctx:     ExecutionContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [`${ENV_PREFIX}DAEMON_ID`]:       ctx.daemonId,
    [`${ENV_PREFIX}INCARNATION_ID`]:  ctx.incarnationId,
    [`${ENV_PREFIX}RUN_ID`]:          ctx.runId,
    [`${ENV_PREFIX}TRACE_ID`]:        ctx.traceId,
    // Child's parent IS this span; child mints its own spanId on read.
    [`${ENV_PREFIX}PARENT_SPAN_ID`]:  ctx.spanId,
    [`${ENV_PREFIX}REQUEST_ID`]:      ctx.requestId ?? '',
    [`${ENV_PREFIX}SESSION_ID`]:      ctx.sessionId ?? '',
    [`${ENV_PREFIX}SOURCE`]:          ctx.source,
    [`${ENV_PREFIX}ATTEMPT`]:         String(ctx.attempt),
    [`${ENV_PREFIX}TRIGGER_ID`]:      ctx.triggerId ?? '',
  };
}

const VALID_SOURCES: ReadonlySet<ExecutionSource> = new Set<ExecutionSource>([
  'cli', 'api', 'webhook', 'cron', 'email', 'folder', 'subagent', 'unknown',
]);

/**
 * Reconstruct an ExecutionContext from env vars. Returns `null` when
 * any of the three required fields (daemonId, incarnationId, runId)
 * are absent — child wasn't spawned with context.
 *
 * The child's `spanId` is ALWAYS freshly minted; the parent's spanId
 * becomes the child's `parentSpanId`. `source` falls back to
 * `'subagent'` (the most common child case) if the env didn't carry it.
 */
export function readContextFromEnv(env: NodeJS.ProcessEnv = process.env): ExecutionContext | null {
  const daemonId      = env[`${ENV_PREFIX}DAEMON_ID`];
  const incarnationId = env[`${ENV_PREFIX}INCARNATION_ID`];
  const runId         = env[`${ENV_PREFIX}RUN_ID`];
  if (!daemonId || !incarnationId || !runId) return null;
  const sourceRaw = env[`${ENV_PREFIX}SOURCE`] ?? 'subagent';
  const source = (VALID_SOURCES.has(sourceRaw as ExecutionSource)
    ? (sourceRaw as ExecutionSource)
    : 'subagent');
  const attemptRaw = env[`${ENV_PREFIX}ATTEMPT`] ?? '1';
  const attempt = Number.parseInt(attemptRaw, 10);
  const ctx: ExecutionContext = {
    daemonId,
    incarnationId,
    runId,
    traceId:      env[`${ENV_PREFIX}TRACE_ID`] ?? '',
    spanId:       newSpanId(),
    parentSpanId: env[`${ENV_PREFIX}PARENT_SPAN_ID`] || undefined,
    source,
    attempt:      Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
  };
  const req = env[`${ENV_PREFIX}REQUEST_ID`];      if (req) ctx.requestId = req;
  const sess = env[`${ENV_PREFIX}SESSION_ID`];     if (sess) ctx.sessionId = sess;
  const trig = env[`${ENV_PREFIX}TRIGGER_ID`];     if (trig) ctx.triggerId = trig;
  return ctx;
}
