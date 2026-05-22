/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/traceparent.ts — v4.9.0 Slice 7.
 *
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) parse +
 * emit for the `traceparent` HTTP header. We DO NOT swap Aiden's
 * typed-prefix `trc_<uuidv7>` ID; instead, an inbound trace's 32-hex
 * traceId is stored alongside in `spans.external_trace_id` /
 * `runs.external_trace_id` (schema v10). That gives us debuggable
 * typed IDs internally while still letting an external caller
 * correlate via W3C-standard headers.
 *
 *   traceparent: 00-<32hex traceId>-<16hex spanId>-<2hex flags>
 *
 * Total length: 4 + 32 + 16 + 2 + 3 dashes = 55 chars exactly.
 */

export interface ParsedTraceparent {
  /** 32 lowercase hex chars. */
  traceId:      string;
  /** 16 lowercase hex chars — the upstream span this trace point belongs to. */
  parentSpanId: string;
  /** Per spec, bit 0 (`0x01`) is "sampled". Other bits reserved. */
  flags:        number;
}

const RE_HEX_32 = /^[0-9a-f]{32}$/;
const RE_HEX_16 = /^[0-9a-f]{16}$/;
const RE_HEX_2  = /^[0-9a-f]{2}$/;
const ZERO_TRACE = '00000000000000000000000000000000';
const ZERO_SPAN  = '0000000000000000';

/**
 * Parse a `traceparent` header. Returns `null` on ANY validation
 * failure — caller decides whether to log + generate fresh or fail.
 *
 * Per spec: a vendor MUST NOT propagate an invalid header. We follow
 * the "ignore + start fresh" recommendation so a malformed upstream
 * doesn't poison Aiden's trace.
 */
export function parseTraceparent(header: string | undefined | null): ParsedTraceparent | null {
  if (!header || typeof header !== 'string') return null;
  if (header.length !== 55) return null;
  const parts = header.split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, parentSpanId, flagsHex] = parts;
  if (version !== '00') return null;
  if (!RE_HEX_32.test(traceId))     return null;
  if (!RE_HEX_16.test(parentSpanId)) return null;
  if (!RE_HEX_2.test(flagsHex))      return null;
  if (traceId === ZERO_TRACE)        return null;
  if (parentSpanId === ZERO_SPAN)    return null;
  const flags = parseInt(flagsHex, 16);
  if (!Number.isFinite(flags))       return null;
  return { traceId, parentSpanId, flags };
}

/**
 * Emit a `traceparent` header from Aiden ID components. The caller
 * strips the typed prefix (`trc_` / `spn_`) and converts the dashless
 * 32-char compact form to the W3C shape. (Aiden's compact UUIDv7 IS
 * 32 lowercase hex chars, so it's directly W3C-compatible after the
 * prefix is removed.)
 *
 * `sampled` defaults to `true` — we want downstream services to record
 * the trace by default. Set to false for low-priority work.
 */
export function emitTraceparent(traceIdHex: string, spanIdHex: string, sampled: boolean = true): string {
  const t = stripPrefix(traceIdHex, 'trc_');
  const s = stripPrefix(spanIdHex, 'spn_');
  if (!RE_HEX_32.test(t)) {
    throw new Error(`emitTraceparent: traceId must be 32 hex chars (got ${t.length})`);
  }
  // W3C spans are 16 hex; Aiden's span_id compact form is 32. Take
  // the first 16 — UUIDv7's first 16 chars carry the ms timestamp +
  // version + half of randomness, so collisions across one trace are
  // astronomical.
  const s16 = s.length === 16 ? s : s.slice(0, 16);
  if (!RE_HEX_16.test(s16)) {
    throw new Error(`emitTraceparent: spanId must be 16 hex chars (got ${s16.length})`);
  }
  const flags = sampled ? '01' : '00';
  return `00-${t}-${s16}-${flags}`;
}

/** Strip the Aiden typed prefix (`trc_` / `spn_`) if present. */
export function stripPrefix(id: string, prefix: 'trc_' | 'spn_' | 'run_' | 'inc_' | 'dmn_'): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * Validate an external `X-Request-Id` style header. Per the project
 * rule "don't poison indexes": max 128 chars, ASCII printable only.
 * Returns the value if safe, `null` if it should be dropped + a
 * fresh id generated.
 */
export function validateExternalRequestId(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 128) return null;
  if (!/^[\x20-\x7E]+$/.test(raw)) return null;
  return raw;
}
