/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/allowlist.ts — v4.5 Phase 4a.
 *
 * Compiles a per-trigger sender allowlist into a fast matcher.
 * Glob syntax supported:
 *   - Exact:    user@example.com
 *   - Domain:   *@example.com
 *   - Prefix:   alerts-*@example.com
 *   - Both:     *-alerts-*@*.example.com
 *
 * Allowlist semantics:
 *   - Default (empty list) = REJECT all. Trigger is functional only
 *     after at least one --allow-sender is registered. This matches
 *     the explicit-over-implicit security posture.
 *   - Applied AFTER the automated-sender filter (we never trust
 *     `noreply@<allowed-domain>`).
 *   - Case-insensitive (RFC 5321: local-part is technically case-
 *     sensitive, but in practice IS not).
 */

export interface SenderAllowlist {
  /** True when `from` matches at least one allowlist entry. */
  isAllowed(fromAddress: string): boolean;
  /** Diagnostic — number of entries compiled. */
  size(): number;
}

/**
 * Compile a list of address-pattern strings into a matcher.
 * Empty list → matcher rejects every address (the explicit-allow
 * default per Q-P4-1).
 */
export function compileSenderAllowlist(patterns: ReadonlyArray<string>): SenderAllowlist {
  if (patterns.length === 0) {
    return {
      isAllowed: () => false,
      size:      () => 0,
    };
  }
  const regexes: RegExp[] = patterns
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
    .map(patternToRegex);
  return {
    isAllowed(fromAddress: string): boolean {
      const addr = (fromAddress ?? '').trim().toLowerCase();
      if (!addr) return false;
      for (const re of regexes) if (re.test(addr)) return true;
      return false;
    },
    size: () => regexes.length,
  };
}

/**
 * Convert a sender glob pattern into a case-insensitive RegExp
 * anchored at both ends. Only `*` is supported (matches zero or
 * more characters that are NOT a separator we care about — but
 * since email addresses don't have hierarchical separators like
 * filesystems do, `*` is greedy across the whole local-part or
 * domain). Escape every other regex meta-char.
 */
function patternToRegex(pat: string): RegExp {
  // Escape regex specials except `*`, then convert `*` to `.*`.
  const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}
