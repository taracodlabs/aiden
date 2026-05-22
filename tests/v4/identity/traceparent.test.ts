/**
 * tests/v4/identity/traceparent.test.ts — v4.9.0 Slice 7.
 */
import { describe, it, expect } from 'vitest';
import {
  parseTraceparent,
  emitTraceparent,
  stripPrefix,
  validateExternalRequestId,
} from '../../../core/v4/identity/traceparent';

const VALID_TP = '00-aabbccddeeff00112233445566778899-1122334455667788-01';

describe('parseTraceparent — Slice 7', () => {
  it('parses a valid v00 header', () => {
    const r = parseTraceparent(VALID_TP)!;
    expect(r.traceId).toBe('aabbccddeeff00112233445566778899');
    expect(r.parentSpanId).toBe('1122334455667788');
    expect(r.flags).toBe(1);
  });

  it('rejects undefined / empty / wrong length', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('00-short-1122334455667788-01')).toBeNull();
    expect(parseTraceparent('a'.repeat(55))).toBeNull(); // wrong dash structure
  });

  it('rejects version != 00', () => {
    expect(parseTraceparent('01-aabbccddeeff00112233445566778899-1122334455667788-01')).toBeNull();
    expect(parseTraceparent('ff-aabbccddeeff00112233445566778899-1122334455667788-01')).toBeNull();
  });

  it('rejects all-zero traceId or spanId', () => {
    expect(parseTraceparent('00-00000000000000000000000000000000-1122334455667788-01')).toBeNull();
    expect(parseTraceparent('00-aabbccddeeff00112233445566778899-0000000000000000-01')).toBeNull();
  });

  it('rejects uppercase / non-hex', () => {
    expect(parseTraceparent('00-AABBCCDDEEFF00112233445566778899-1122334455667788-01')).toBeNull();
    expect(parseTraceparent('00-zzzzccddeeff00112233445566778899-1122334455667788-01')).toBeNull();
  });

  it('non-string input returns null', () => {
    expect(parseTraceparent(null as unknown as string)).toBeNull();
    expect(parseTraceparent(123 as unknown as string)).toBeNull();
  });

  it('flags decoded correctly (sampled / unsampled)', () => {
    expect(parseTraceparent('00-aabbccddeeff00112233445566778899-1122334455667788-00')!.flags).toBe(0);
    expect(parseTraceparent('00-aabbccddeeff00112233445566778899-1122334455667788-ff')!.flags).toBe(255);
  });
});

describe('emitTraceparent — Slice 7', () => {
  it('emits canonical W3C shape from typed Aiden IDs', () => {
    const tp = emitTraceparent(
      'trc_aabbccddeeff00112233445566778899',
      'spn_11223344556677880000000000000000',
      true,
    );
    expect(tp).toBe('00-aabbccddeeff00112233445566778899-1122334455667788-01');
  });

  it('honours sampled=false flag', () => {
    const tp = emitTraceparent('aabbccddeeff00112233445566778899', '1122334455667788', false);
    expect(tp.endsWith('-00')).toBe(true);
  });

  it('throws on malformed traceId / spanId', () => {
    expect(() => emitTraceparent('bad', '1122334455667788')).toThrow(/traceId/);
    // After stripping prefix the 16-hex contract still requires 16 chars
    expect(() => emitTraceparent('aabbccddeeff00112233445566778899', 'bad')).toThrow(/spanId/);
  });

  it('roundtrips via parseTraceparent', () => {
    const tp = emitTraceparent('aabbccddeeff00112233445566778899', '1122334455667788', true);
    const parsed = parseTraceparent(tp)!;
    expect(parsed.traceId).toBe('aabbccddeeff00112233445566778899');
    expect(parsed.parentSpanId).toBe('1122334455667788');
  });
});

describe('stripPrefix — Slice 7', () => {
  it('strips when present, leaves unchanged when absent', () => {
    expect(stripPrefix('trc_abc', 'trc_')).toBe('abc');
    expect(stripPrefix('abc', 'trc_')).toBe('abc');
  });
});

describe('validateExternalRequestId — Slice 7', () => {
  it('accepts 1-128 char ASCII printable', () => {
    expect(validateExternalRequestId('req-abc-123')).toBe('req-abc-123');
    expect(validateExternalRequestId('a'.repeat(128))).toBe('a'.repeat(128));
  });
  it('rejects null / empty / >128 / non-printable', () => {
    expect(validateExternalRequestId(undefined)).toBeNull();
    expect(validateExternalRequestId('')).toBeNull();
    expect(validateExternalRequestId('a'.repeat(129))).toBeNull();
    expect(validateExternalRequestId('hi\x00bye')).toBeNull();
    expect(validateExternalRequestId('hi\nbye')).toBeNull();
  });
});
