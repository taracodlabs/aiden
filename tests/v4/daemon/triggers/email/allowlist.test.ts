/**
 * v4.5 Phase 4a — allowlist tests.
 */
import { describe, it, expect } from 'vitest';
import { compileSenderAllowlist } from '../../../../../core/v4/daemon/triggers/email/allowlist';

describe('compileSenderAllowlist', () => {
  it('empty list → rejects everything (Q-P4-1 default)', () => {
    const a = compileSenderAllowlist([]);
    expect(a.isAllowed('alice@example.com')).toBe(false);
    expect(a.isAllowed('anyone@anything')).toBe(false);
    expect(a.size()).toBe(0);
  });

  it('exact address match', () => {
    const a = compileSenderAllowlist(['alice@example.com']);
    expect(a.isAllowed('alice@example.com')).toBe(true);
    expect(a.isAllowed('bob@example.com')).toBe(false);
  });

  it('case-insensitive', () => {
    const a = compileSenderAllowlist(['Alice@Example.COM']);
    expect(a.isAllowed('ALICE@example.com')).toBe(true);
  });

  it('domain wildcard *@example.com', () => {
    const a = compileSenderAllowlist(['*@example.com']);
    expect(a.isAllowed('alice@example.com')).toBe(true);
    expect(a.isAllowed('bob@example.com')).toBe(true);
    expect(a.isAllowed('alice@other.com')).toBe(false);
  });

  it('local-part wildcard alerts-*@example.com', () => {
    const a = compileSenderAllowlist(['alerts-*@example.com']);
    expect(a.isAllowed('alerts-1@example.com')).toBe(true);
    expect(a.isAllowed('alerts-prod@example.com')).toBe(true);
    expect(a.isAllowed('alice@example.com')).toBe(false);
  });

  it('multiple entries — any match wins', () => {
    const a = compileSenderAllowlist(['alice@example.com', '*@taracod.com']);
    expect(a.isAllowed('alice@example.com')).toBe(true);
    expect(a.isAllowed('anyone@taracod.com')).toBe(true);
    expect(a.isAllowed('bob@elsewhere.com')).toBe(false);
  });

  it('rejects empty / whitespace senders', () => {
    const a = compileSenderAllowlist(['*@example.com']);
    expect(a.isAllowed('')).toBe(false);
    expect(a.isAllowed('   ')).toBe(false);
  });
});
