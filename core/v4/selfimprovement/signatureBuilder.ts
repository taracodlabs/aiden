/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/selfimprovement/signatureBuilder.ts — v4.6 Phase 3b.
 *
 * Builds a stable, deterministic signature string for a failed tool
 * call so equivalent failures collapse into one `failure_signatures`
 * row. The shape is:
 *
 *     <tool_name>:<failure_category>[:<args_hash_prefix>]
 *
 * The `args_hash_prefix` field is OPTIONAL. When the caller supplies
 * `args`, this module normalises them (strips volatile fields like
 * timestamps, run IDs, UUIDs, monotonic counters), serialises the
 * result deterministically, and takes the first 6 hex chars of a
 * SHA-256 digest. When `args` is omitted, the signature collapses to
 * `<tool>:<category>` only — same logical failure, broader grouping.
 *
 * Granularity trade-offs:
 *
 *   * Too granular ("every failure unique") → no aggregation; the
 *     `occurrences` column never increments past 1; operators can't
 *     see "this tool fails the same way over and over."
 *   * Too coarse ("only tool+category") → "file_read failed with
 *     `not_found`" groups EVERY missing file together; the operator
 *     can't tell which paths are sore points.
 *
 * The args-hash compromise: same tool + same category + same
 * normalized args → same signature (good); same tool + same category
 * + meaningfully different args → different signatures (also good).
 * Volatile fields are stripped BEFORE hashing so re-hashing on a
 * later turn produces the same signature even when only the
 * timestamp / call id changes.
 *
 * Volatile field list (`VOLATILE_KEYS`) — defensive; covers the
 * fields Aiden's tool layer tends to thread through args. Plugin
 * authors who emit custom volatile keys should pre-normalise before
 * calling this module.
 */

import crypto from 'node:crypto';

import type { FailureCategory } from '../failureClassifier';

// ── Public types ─────────────────────────────────────────────────────────

export interface BuildSignatureInput {
  toolName: string;
  category: FailureCategory;
  /**
   * Optional args object. When omitted the signature collapses to
   * `tool:category`. Plain objects, arrays, and primitives are
   * supported; circular references and non-JSON-serializable values
   * are tolerated (the normaliser substitutes `'[unserializable]'`).
   */
  args?: unknown;
}

export interface BuiltSignature {
  /** Canonical grouping key — used as the `failure_signatures.signature` column. */
  signature: string;
  /** First 6 hex chars of the normalized-args SHA256, or undefined when args were omitted. */
  argsHash?: string;
}

// ── Implementation ───────────────────────────────────────────────────────

/**
 * Keys whose values are stripped from the args object before hashing.
 * These are fields that DO change between otherwise-identical
 * failures (turn timestamps, run row ids, etc.) so leaving them in
 * would prevent any signature from ever grouping.
 *
 * The list is intentionally narrow — only fields Aiden's tool layer
 * is known to inject. Plugins emitting custom volatile keys must
 * pre-normalise their args before calling this module.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'ts',
  'requestId',
  'request_id',
  'runId',
  'run_id',
  'callId',
  'call_id',
  'sessionId',
  'session_id',
  'turnId',
  'turn_id',
  'eventId',
  'event_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  // Common UUID/idempotency-key names.
  'uuid',
  'idempotencyKey',
  'idempotency_key',
]);

/**
 * Deterministically stringify a value. Sorts object keys so
 * `{a:1, b:2}` and `{b:2, a:1}` produce identical bytes. Strips
 * volatile keys from any nested object before stringifying.
 *
 * Non-JSON-serialisable values (functions, symbols, circular refs)
 * collapse to the literal string `'[unserializable]'` so the hash
 * remains stable. Better-than-throwing is the right trade-off for
 * a write-through hot path.
 */
function deterministicStringify(value: unknown): string {
  const seen = new WeakSet();
  const visit = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'function' || t === 'symbol') return '[unserializable]';
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      return v.map(visit);
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) return '[circular]';
      seen.add(obj);
      const out: Record<string, unknown> = {};
      const keys = Object.keys(obj).filter((k) => !VOLATILE_KEYS.has(k));
      keys.sort();
      for (const k of keys) out[k] = visit(obj[k]);
      return out;
    }
    return '[unserializable]';
  };
  try {
    return JSON.stringify(visit(value));
  } catch {
    return '[unserializable]';
  }
}

/**
 * Build a failure signature. Pure function — no I/O, no side
 * effects. Safe to call on the hot path of every classified
 * failure; SHA-256 of a small JSON string is cheap (microseconds).
 */
export function buildFailureSignature(input: BuildSignatureInput): BuiltSignature {
  const base = `${input.toolName}:${input.category}`;
  if (input.args === undefined) {
    return { signature: base };
  }
  const normalized = deterministicStringify(input.args);
  // Empty / trivially-null args don't deserve a hash suffix —
  // collapse to the base signature so "args: {}" and "no args"
  // group together.
  if (normalized === 'null' || normalized === '{}' || normalized === '[]') {
    return { signature: base };
  }
  const digest = crypto.createHash('sha256').update(normalized).digest('hex');
  const argsHash = digest.slice(0, 6);
  return {
    signature: `${base}:${argsHash}`,
    argsHash,
  };
}
