/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/automatedSender.ts — v4.5 Phase 4a.
 *
 * Detects mail from automated systems (noreply addresses, bounce
 * notifications, mailing-list digests, calendar invites, etc.).
 *
 * Used at TWO points:
 *   1. INGRESS — mark UID seen + skip (don't kick off an agent turn
 *      to "respond" to a bounce notification).
 *   2. OUTBOUND — any future auto-reply path (Phase 5+) MUST NEVER
 *      reply to a sender flagged automated. This is the canonical
 *      defense against mail loops (the gateway's notification system
 *      bounces our reply, we reply to the bounce, ...).
 *
 * Two signal sources combined:
 *   - Substring match on the From / Reply-To address (noreply, etc.)
 *   - RFC headers: Auto-Submitted, Precedence, X-Auto-Response-Suppress,
 *     List-Unsubscribe.
 */

/** Address substrings — case-insensitive — that signal automated. */
export const NOREPLY_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'notifications@',
  'automated@',
  'auto-confirm',
  'auto-reply',
  'automailer',
]);

interface RfcHeaderRule {
  header: string;
  test:   (value: string) => boolean;
}

/** RFC headers that signal bulk/automated mail. */
export const AUTOMATED_HEADERS: ReadonlyArray<RfcHeaderRule> = Object.freeze([
  { header: 'Auto-Submitted',           test: (v) => v.toLowerCase() !== 'no' },
  { header: 'Precedence',               test: (v) => ['bulk', 'list', 'junk'].includes(v.toLowerCase()) },
  { header: 'X-Auto-Response-Suppress', test: (v) => v.length > 0 },
  { header: 'List-Unsubscribe',         test: (v) => v.length > 0 },
]);

/**
 * Return true when the sender appears to be an automated system.
 *
 * - `fromAddress` is the bare address (e.g. 'noreply@github.com'),
 *   NOT a display-name-decorated form. Caller should extract via
 *   mailparser's `parsed.from?.value[0]?.address`.
 * - `headers` is a case-INSENSITIVE map. mailparser provides
 *   `parsed.headers` as a Map with lowercased keys; pass that
 *   normalized to `Record<string, string>` (multi-value headers
 *   pick the first value).
 */
export function isAutomatedSender(
  fromAddress: string,
  headers:     Record<string, string>,
): boolean {
  const addr = (fromAddress ?? '').toLowerCase();
  for (const p of NOREPLY_PATTERNS) if (addr.includes(p)) return true;
  for (const r of AUTOMATED_HEADERS) {
    // Match case-insensitively against both the exact-case header
    // name and the lowercased form so callers don't have to remember
    // mailparser's specific quirk.
    const v = headers[r.header] ?? headers[r.header.toLowerCase()];
    if (typeof v === 'string' && v.length > 0 && r.test(v)) return true;
  }
  return false;
}
