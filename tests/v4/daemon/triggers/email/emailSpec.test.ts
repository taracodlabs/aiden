/**
 * v4.5 Phase 4a — emailSpec parse tests.
 */
import { describe, it, expect } from 'vitest';
import { parseEmailSpec, DEFAULT_EMAIL_SPEC } from '../../../../../core/v4/daemon/triggers/email/emailSpec';

const MIN: Parameters<typeof parseEmailSpec>[0] = {
  name: 'r',
  imap: { host: 'imap.example.com', user: 'u', password: 'p' },
  allowedSenders: ['*@example.com'],
};

describe('parseEmailSpec', () => {
  it('happy path with defaults filled in', () => {
    const s = parseEmailSpec(MIN);
    expect(s.mailbox).toBe('INBOX');
    expect(s.pollIntervalMs).toBe(15_000);
    expect(s.imap.port).toBe(993);
    expect(s.imap.tls).toBe(true);
    expect(s.allowedSenders).toEqual(['*@example.com']);
    expect(s.attachmentPolicy).toBe('skip');
    expect(s.deliverOnly).toBe(false);
  });

  it('throws when name missing', () => {
    expect(() => parseEmailSpec({ ...MIN, name: undefined } as any)).toThrow(/name/i);
  });

  it('throws when imap.host missing', () => {
    expect(() => parseEmailSpec({ ...MIN, imap: { user: 'u', password: 'p' } } as any)).toThrow(/imap\.host/i);
  });

  it('throws when imap.password missing', () => {
    expect(() => parseEmailSpec({ ...MIN, imap: { host: 'x', user: 'u' } } as any)).toThrow(/imap\.password/i);
  });

  it('throws when allowedSenders is empty (Q-P4-1)', () => {
    expect(() => parseEmailSpec({ ...MIN, allowedSenders: [] })).toThrow(/allowedSenders/i);
  });

  it('throws when allowedSubjectPatterns has an invalid regex', () => {
    expect(() => parseEmailSpec({ ...MIN, allowedSubjectPatterns: ['('] })).toThrow(/invalid regex/i);
  });

  it('attachmentPolicy validation falls back to default for junk', () => {
    expect(parseEmailSpec({ ...MIN, attachmentPolicy: 'bogus' as any }).attachmentPolicy).toBe('skip');
  });

  it('round-trips through JSON', () => {
    const s = parseEmailSpec(JSON.stringify(MIN));
    expect(s.name).toBe('r');
  });
});
