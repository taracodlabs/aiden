/**
 * v4.5 Phase 4a — automatedSender tests.
 */
import { describe, it, expect } from 'vitest';
import {
  isAutomatedSender,
  NOREPLY_PATTERNS,
  AUTOMATED_HEADERS,
} from '../../../../../core/v4/daemon/triggers/email/automatedSender';

describe('isAutomatedSender — address-based detection', () => {
  it('flags noreply@*', () => {
    expect(isAutomatedSender('noreply@github.com', {})).toBe(true);
  });

  it('flags no-reply variant', () => {
    expect(isAutomatedSender('no-reply@example.com', {})).toBe(true);
  });

  it('flags mailer-daemon', () => {
    expect(isAutomatedSender('mailer-daemon@gmail.com', {})).toBe(true);
  });

  it('flags postmaster', () => {
    expect(isAutomatedSender('postmaster@example.org', {})).toBe(true);
  });

  it('flags bounce@*', () => {
    expect(isAutomatedSender('bounce-abc@m.linkedin.com', {})).toBe(true);
  });

  it('flags notifications@*', () => {
    expect(isAutomatedSender('notifications@github.com', {})).toBe(true);
  });

  it('case-insensitive', () => {
    expect(isAutomatedSender('NoReply@Example.COM', {})).toBe(true);
  });

  it('does NOT flag legitimate addresses', () => {
    expect(isAutomatedSender('alice@example.com', {})).toBe(false);
    expect(isAutomatedSender('bob.smith@taracod.com', {})).toBe(false);
  });
});

describe('isAutomatedSender — RFC header detection', () => {
  it('Auto-Submitted: anything-but-no → automated', () => {
    expect(isAutomatedSender('alice@example.com', { 'auto-submitted': 'auto-replied' })).toBe(true);
  });

  it('Auto-Submitted: no → NOT automated', () => {
    expect(isAutomatedSender('alice@example.com', { 'auto-submitted': 'no' })).toBe(false);
  });

  it('Precedence: bulk → automated', () => {
    expect(isAutomatedSender('alice@example.com', { Precedence: 'bulk' })).toBe(true);
  });

  it('Precedence: list → automated', () => {
    expect(isAutomatedSender('alice@example.com', { precedence: 'list' })).toBe(true);
  });

  it('Precedence: normal → NOT automated', () => {
    expect(isAutomatedSender('alice@example.com', { precedence: 'normal' })).toBe(false);
  });

  it('List-Unsubscribe header present → automated', () => {
    expect(isAutomatedSender('alice@example.com', { 'list-unsubscribe': '<mailto:u@example.com>' })).toBe(true);
  });

  it('X-Auto-Response-Suppress present → automated', () => {
    expect(isAutomatedSender('alice@example.com', { 'x-auto-response-suppress': 'all' })).toBe(true);
  });
});

describe('isAutomatedSender — constants exported', () => {
  it('NOREPLY_PATTERNS is non-empty', () => {
    expect(NOREPLY_PATTERNS.length).toBeGreaterThan(5);
  });
  it('AUTOMATED_HEADERS has 4 rules', () => {
    expect(AUTOMATED_HEADERS.length).toBe(4);
  });
});
