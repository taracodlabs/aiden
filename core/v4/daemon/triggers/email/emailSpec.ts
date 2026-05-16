/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/emailSpec.ts — v4.5 Phase 4a.
 *
 * Typed spec for source='email' triggers, stored in
 * triggers.spec_json. Parse + validation + defaults.
 *
 * Required:
 *   - name
 *   - imap.{host, user, password}
 *   - allowedSenders (at least one entry) — Q-P4-1 (a) reject-all
 *     default; users opt in to specific senders. Glob-style patterns
 *     supported (see allowlist.ts).
 *
 * Password handling: stored RAW in spec_json. daemon.db is chmod 600
 * on POSIX (see db/connection.ts since Phase 3). Encryption-at-rest
 * deferred to v4.6+ per Q-P4-4 (a). aiden trigger show deliberately
 * omits the password.
 */

export type AttachmentPolicy = 'skip' | 'inline-text' | 'save-to-tmp';

export interface EmailImapConfig {
  host:           string;
  port:           number;          // default 993
  user:           string;
  password:       string;          // raw — see file header
  tls:            boolean;         // default true
  authTimeoutMs:  number;          // default 10_000
}

export interface EmailSpec {
  name:                    string;
  imap:                    EmailImapConfig;
  mailbox:                 string;                 // default 'INBOX'
  pollIntervalMs:          number;                 // default 15_000
  allowedSenders:          string[];               // REQUIRED, ≥1 entry
  allowedSubjectPatterns?: string[];               // optional regex strings
  maxBodyBytes:            number;                 // default 1_048_576
  promptTemplate?:         string;                 // Phase 5 wire
  deliverOnly:             boolean;                // Phase 4a stub
  attachmentPolicy:        AttachmentPolicy;       // default 'skip'
}

export const DEFAULT_EMAIL_SPEC: Omit<EmailSpec, 'name' | 'imap' | 'allowedSenders'> = {
  mailbox:           'INBOX',
  pollIntervalMs:    15_000,
  maxBodyBytes:      1_048_576,
  deliverOnly:       false,
  attachmentPolicy:  'skip',
};

export const DEFAULT_IMAP: Omit<EmailImapConfig, 'host' | 'user' | 'password'> = {
  port:           993,
  tls:            true,
  authTimeoutMs:  10_000,
};

export function parseEmailSpec(raw: string | Record<string, unknown>): EmailSpec {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('EmailSpec: input must be an object');
  }
  const o = obj as Record<string, unknown>;

  const name = typeof o.name === 'string' && o.name.length > 0 ? o.name : '';
  if (!name) throw new Error('EmailSpec: name required');

  const imapRaw = (o.imap && typeof o.imap === 'object') ? o.imap as Record<string, unknown> : {};
  const imap: EmailImapConfig = {
    host:          requireStr(imapRaw.host, 'imap.host'),
    user:          requireStr(imapRaw.user, 'imap.user'),
    password:      requireStr(imapRaw.password, 'imap.password'),
    port:          sanitizeNum(imapRaw.port, DEFAULT_IMAP.port, 1),
    tls:           typeof imapRaw.tls === 'boolean' ? imapRaw.tls : DEFAULT_IMAP.tls,
    authTimeoutMs: sanitizeNum(imapRaw.authTimeoutMs, DEFAULT_IMAP.authTimeoutMs, 1_000),
  };

  const allowedSenders = Array.isArray(o.allowedSenders)
    ? (o.allowedSenders as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  if (allowedSenders.length === 0) {
    throw new Error('EmailSpec: allowedSenders required (at least one --allow-sender entry). Use "*@your-domain.com" for a whole domain.');
  }

  const allowedSubjectPatterns = Array.isArray(o.allowedSubjectPatterns)
    ? (o.allowedSubjectPatterns as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  if (allowedSubjectPatterns) {
    // Compile-test each pattern at parse time so bad regexes surface early.
    for (const p of allowedSubjectPatterns) {
      try { new RegExp(p); }
      catch (e) { throw new Error(`EmailSpec: allowedSubjectPatterns has invalid regex ${JSON.stringify(p)}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  return {
    name,
    imap,
    mailbox:                typeof o.mailbox === 'string' && o.mailbox.length > 0 ? o.mailbox : DEFAULT_EMAIL_SPEC.mailbox,
    pollIntervalMs:         sanitizeNum(o.pollIntervalMs, DEFAULT_EMAIL_SPEC.pollIntervalMs, 1_000),
    allowedSenders,
    allowedSubjectPatterns,
    maxBodyBytes:           sanitizeNum(o.maxBodyBytes, DEFAULT_EMAIL_SPEC.maxBodyBytes, 1_024),
    promptTemplate:         typeof o.promptTemplate === 'string' ? o.promptTemplate : undefined,
    deliverOnly:            typeof o.deliverOnly === 'boolean' ? o.deliverOnly : DEFAULT_EMAIL_SPEC.deliverOnly,
    attachmentPolicy:       sanitizeAttachmentPolicy(o.attachmentPolicy),
  };
}

function requireStr(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`EmailSpec: ${label} required (non-empty string)`);
  }
  return v;
}

function sanitizeNum(v: unknown, fallback: number, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) return fallback;
  return v;
}

function sanitizeAttachmentPolicy(v: unknown): AttachmentPolicy {
  if (v === 'skip' || v === 'inline-text' || v === 'save-to-tmp') return v;
  return DEFAULT_EMAIL_SPEC.attachmentPolicy;
}
