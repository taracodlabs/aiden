/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/_argTokens.ts — shared quote-aware arg tokenizer.
 *
 * The slash registry's `splitArgs` is whitespace-only (`split(/\s+/)`),
 * so quoted arguments with internal spaces — e.g. a Windows path like
 * `"C:\Users\me\Obsidian Vault\Aiden"` — get shredded into multiple
 * tokens with the quote chars left attached. Commands that accept such
 * values (`/cron`, `/memory vault link`) tokenize `ctx.rawArgs` with this
 * helper instead: `"..."` / `'...'` collapse to a single token and the
 * surrounding quote chars are stripped.
 */

/**
 * Split `raw` on whitespace, treating `"..."` and `'...'` as a single
 * token (internal spaces preserved, surrounding quotes removed). A quote
 * inside the other quote style is taken literally.
 */
export function tokenize(raw: string): string[] {
  const out: string[] = [];
  const s = raw ?? '';
  let cur  = '';
  let inDQ = false;
  let inSQ = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !inSQ) { inDQ = !inDQ; continue; }
    if (ch === "'" && !inDQ) { inSQ = !inSQ; continue; }
    if (!inDQ && !inSQ && /\s/.test(ch)) {
      if (cur.length > 0) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
