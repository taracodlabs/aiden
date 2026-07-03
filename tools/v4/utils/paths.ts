/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/utils/paths.ts — shared path helpers for v4 file tools.
 *
 * `expandPath` mirrors the same `~`, `Desktop/`, drive-letter rules
 * from `tools/v4/files/fileRead.ts` so every write/move/copy tool
 * resolves paths the same way the read tools do. Pulled out so the
 * five write tools share one implementation.
 *
 * `isProtectedPath` is the deny-list every write tool consults
 * before touching disk. Phase 9 will swap this with the structured
 * approval engine; this is the minimum guarantee until then.
 */

import path from 'node:path';
import os from 'node:os';

const DENY_PATTERNS: RegExp[] = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.aws[\\/]/i,
  /[\\/]\.gnupg[\\/]/i,
  /[\\/]\.env(\.|$|\\|\/)/i,
  /credentials/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa\b/i,
  /id_ed25519\b/i,
  // v4.12.1 Pillar 2 — Aiden's own autonomy policy file. The agent must not
  // be able to rewrite its own approval policy to bypass the gate. (The
  // ApprovalEngine hard-block also covers this + the shell back-door.)
  /[\\/]aiden[\\/](?:[^\\/]*[\\/])?config\.ya?ml$/i,
];

export function isProtectedPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return DENY_PATTERNS.some((re) => re.test(norm));
}

export function expandPath(input: string, cwd: string): string {
  const home = os.homedir();
  let p = input;
  if (/^~[\\/]/i.test(p)) p = home + p.slice(1);
  else if (/^Desktop[\\/]?$/i.test(p)) p = path.join(home, 'Desktop');
  else if (/^Desktop[\\/]/i.test(p)) p = path.join(home, 'Desktop', p.slice(8));
  if (path.isAbsolute(p)) return p;
  if (/^[A-Z]:/i.test(p)) return p;
  return path.join(cwd, p);
}

/** Refuse to operate on filesystem roots / drive roots. */
export function isFilesystemRoot(p: string): boolean {
  const resolved = path.resolve(p);
  const parsed = path.parse(resolved);
  return resolved === parsed.root;
}
