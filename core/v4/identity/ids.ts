/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/ids.ts — v4.9.0 Slice 4.
 *
 * UUIDv7 generation per RFC 9562 §5.7 + typed-prefix wrappers.
 *
 * UUIDv7 lays a millisecond timestamp in the top 48 bits, so lexicographic
 * sort == time sort. That property is the reason we picked v7 over v4:
 * `runs.id`-style auto-increment is wedded to one SQLite file; UUIDv7
 * gives us a globally-unique, time-orderable id we can correlate across
 * the daemon DB, the structured log, future remote sinks, and crash
 * reports without needing a central counter.
 *
 * Aiden generates UUIDv7 locally so identifier behavior does not depend on
 * an external implementation. The 16-byte layout follows RFC 9562 §5.7:
 *
 *     0                   1                   2                   3
 *     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *    |                           unix_ts_ms                          |
 *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *    |          unix_ts_ms           |  ver  |       rand_a          |
 *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *    |var|                        rand_b                             |
 *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *    |                            rand_b                             |
 *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *
 *   - 48 bits unix_ts_ms (big-endian)
 *   - 4 bits version = 0b0111 (UUIDv7)
 *   - 12 bits rand_a (random)
 *   - 2 bits variant = 0b10 (RFC 4122)
 *   - 62 bits rand_b (random)
 *
 * Output canonical hex with dashes (e.g. `01919c34-8e21-7c8c-bcd7-...`).
 * That's then base32-cased for prefixed IDs — keeps the output URL-safe
 * and short while preserving the millisecond ordering at the prefix.
 */

import { randomBytes } from 'node:crypto';

/**
 * Allowed prefixes. Adding a new ID kind means adding the prefix here
 * and the helper. `parseId` validates against this set so a stray
 * `xyz_...` string can't masquerade as one of ours.
 */
export const ID_PREFIXES = [
  'dmn',  // daemon identity (persists across incarnations)
  'inc',  // single daemon process incarnation
  'trg',  // trigger event
  'run',  // agent run (one turn or daemon-fired job)
  'att',  // v4.9.0 Slice 5 — execution attempt within a run
  'trc',  // trace (top-level correlation across runs/spans)
  'spn',  // span (sub-unit of a trace)
  'req',  // external request id (e.g. webhook delivery)
  'tool', // tool invocation
  'mem',  // memory write
  'hook', // hook firing (legacy generic id)
  'hsub', // v4.9.0 Slice 12a — hook subscription
  'hexec',// v4.9.0 Slice 12a — hook execution (subprocess invocation)
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const PREFIX_SET: ReadonlySet<string> = new Set(ID_PREFIXES);

/**
 * Generate one UUIDv7 byte buffer.
 * Exported for tests; consumers should use `newUuidV7()` or one of the
 * typed helpers below.
 */
export function uuidv7Bytes(now: number = Date.now()): Uint8Array {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(`uuidv7Bytes: invalid timestamp ${now}`);
  }
  const buf = randomBytes(16);
  // 48-bit timestamp, big-endian, into bytes 0-5.
  // JS bitwise ops are 32-bit, so split into high/low halves first.
  const tsHi = Math.floor(now / 0x1_0000_0000); // top 16 of the 48-bit ts
  const tsLo = now >>> 0;                       // bottom 32
  buf[0] = (tsHi >>> 8) & 0xff;
  buf[1] = tsHi & 0xff;
  buf[2] = (tsLo >>> 24) & 0xff;
  buf[3] = (tsLo >>> 16) & 0xff;
  buf[4] = (tsLo >>> 8) & 0xff;
  buf[5] = tsLo & 0xff;
  // Version 0b0111 in the top nibble of byte 6.
  buf[6] = (buf[6] & 0x0f) | 0x70;
  // Variant 0b10 in the top 2 bits of byte 8.
  buf[8] = (buf[8] & 0x3f) | 0x80;
  return buf;
}

/** Format 16 bytes as canonical UUID string with dashes. */
function bytesToUuidString(buf: Uint8Array): string {
  const hex = Buffer.from(buf).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Strip dashes; canonical UUID → 32-char lowercase hex. */
function bytesToCompact(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

/** One fresh UUIDv7 in canonical dashed form. */
export function newUuidV7(): string {
  return bytesToUuidString(uuidv7Bytes());
}

/** One fresh UUIDv7 in compact (dashless lowercase hex) form. */
export function newUuidV7Compact(): string {
  return bytesToCompact(uuidv7Bytes());
}

/**
 * Build a typed ID: `<prefix>_<compactHex>`. The compact form keeps the
 * output URL-safe and shorter than the canonical dashed form, while
 * preserving the millisecond-ordered prefix.
 */
function makeId(prefix: IdPrefix): string {
  return `${prefix}_${newUuidV7Compact()}`;
}

export const newDaemonId      = (): string => makeId('dmn');
export const newIncarnationId = (): string => makeId('inc');
export const newTriggerId     = (): string => makeId('trg');
export const newRunId         = (): string => makeId('run');
export const newAttemptId     = (): string => makeId('att');
export const newTraceId       = (): string => makeId('trc');
export const newSpanId        = (): string => makeId('spn');
export const newRequestId     = (): string => makeId('req');
export const newToolCallId    = (): string => makeId('tool');
export const newMemoryId      = (): string => makeId('mem');
export const newHookId        = (): string => makeId('hook');
export const newHookSubId     = (): string => makeId('hsub');
export const newHookExecId    = (): string => makeId('hexec');

export interface ParsedId {
  prefix: IdPrefix;
  uuid:   string;   // 32-char compact hex (no dashes)
}

/**
 * Parse a prefixed ID. Returns `null` if the prefix is unknown or the
 * UUID payload is malformed. Never throws — callers are expected to
 * branch on `null` (think "trusted input boundary check, not parse-or-die").
 *
 * Accepts both compact (no dashes) and canonical (with dashes) UUID
 * forms in the payload — the typed helpers emit compact, but
 * deserialised IDs from external sources (logs, env vars, query strings)
 * could carry either shape.
 */
export function parseId(s: string): ParsedId | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const idx = s.indexOf('_');
  if (idx <= 0) return null;
  const prefix = s.slice(0, idx);
  if (!PREFIX_SET.has(prefix)) return null;
  let payload = s.slice(idx + 1);
  // Strip dashes if the caller passed canonical form.
  if (payload.includes('-')) payload = payload.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(payload)) return null;
  return { prefix: prefix as IdPrefix, uuid: payload.toLowerCase() };
}

/**
 * Type guard — `true` when `s` is a well-formed typed ID with the
 * expected prefix. Cheap; used at API boundaries.
 */
export function isIdWithPrefix(s: string, prefix: IdPrefix): boolean {
  const parsed = parseId(s);
  return parsed !== null && parsed.prefix === prefix;
}
