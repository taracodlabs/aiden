/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/dangerousPatterns.ts — Aiden v4.0.0
 *
 * Catalog of regex patterns flagged as `caution` or `dangerous`. Used
 * by `ApprovalEngine` (smart mode) to short-circuit tool calls and by
 * the `shell_exec` wrapper (Phase 9 wiring) to attach `riskTier` /
 * `reason` to every approval request.
 *
 * Curated subset (~25) of Hermes's 47 dangerous patterns
 * (`tools/approval.py::DANGEROUS_PATTERNS`) plus v3 C7 PowerShell-
 * specific patterns from `core/toolRegistry.ts::DENIED_COMMANDS`.
 * Hermes patterns deferred to v4.1: gateway-lifecycle, kill-via-pgrep
 * substitution, sed in-place /etc edits, git destructive ops, heredoc
 * script execution, chmod-then-exec two-step, find-exec/find-delete.
 *
 * Status: PHASE 9.
 */

export type RiskTier = 'safe' | 'caution' | 'dangerous';

export interface DangerPattern {
  /** Stable identifier (used in logs / approval keys). */
  name: string;
  /** Regex matched against the full command/path string. */
  regex: RegExp;
  /** Risk tier the match contributes. */
  tier: 'caution' | 'dangerous';
  /** Human description shown in the approval prompt. */
  description: string;
}

export const DANGEROUS_PATTERNS: readonly DangerPattern[] = [
  // ── Filesystem destruction (Hermes parity) ────────────────────
  { name: 'recursive_delete', regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i, tier: 'dangerous', description: 'recursive delete' },
  { name: 'delete_root', regex: /\brm\s+(-[^\s]*\s+)*\/(?:\s|$)/, tier: 'dangerous', description: 'delete pointing at root' },
  { name: 'mkfs', regex: /\bmkfs\b/i, tier: 'dangerous', description: 'filesystem format' },
  { name: 'dd_overwrite', regex: /\bdd\s+.*if=/i, tier: 'dangerous', description: 'block device write' },
  { name: 'fork_bomb', regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, tier: 'dangerous', description: 'fork bomb' },
  { name: 'block_device_write', regex: />\s*\/dev\/sd/, tier: 'dangerous', description: 'write to block device' },
  { name: 'find_delete', regex: /\bfind\b.*(-delete\b|-exec\s+(\/\S*\/)?rm\b)/, tier: 'dangerous', description: 'find -delete / -exec rm' },

  // ── Permission changes ────────────────────────────────────────
  { name: 'chmod_world_writable', regex: /\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b/, tier: 'caution', description: 'world/other-writable permissions' },
  { name: 'chown_root_recursive', regex: /\bchown\s+(-[^\s]*)?R\s+root|\bchown\s+--recursive\b.*root/i, tier: 'dangerous', description: 'recursive chown to root' },

  // ── SQL destruction ───────────────────────────────────────────
  { name: 'drop_table', regex: /\bDROP\s+(TABLE|DATABASE)\b/i, tier: 'dangerous', description: 'SQL DROP TABLE/DATABASE' },
  { name: 'truncate_table', regex: /\bTRUNCATE\s+(TABLE\s+)?\w/i, tier: 'dangerous', description: 'SQL TRUNCATE' },
  { name: 'delete_no_where', regex: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, tier: 'dangerous', description: 'SQL DELETE without WHERE' },

  // ── Pipe-to-shell / remote code exec ──────────────────────────
  { name: 'curl_pipe_shell', regex: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i, tier: 'dangerous', description: 'pipe remote content to shell' },
  { name: 'bash_subshell_curl', regex: /\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b/i, tier: 'dangerous', description: 'execute remote script via process substitution' },
  { name: 'eval_input', regex: /\beval\s+["']?\$/, tier: 'dangerous', description: 'eval of variable input' },
  { name: 'shell_dash_c', regex: /\b(bash|sh|zsh|ksh)\s+-[^\s]*c(\s+|$)/, tier: 'caution', description: 'shell command via -c/-lc flag' },

  // ── System / lifecycle ────────────────────────────────────────
  { name: 'kill_all', regex: /\bkill\s+-9\s+-1\b/, tier: 'dangerous', description: 'kill all processes' },
  { name: 'pkill_force', regex: /\bpkill\s+-9\b/, tier: 'caution', description: 'force kill processes' },
  { name: 'systemctl_disable', regex: /\bsystemctl\s+(-[^\s]+\s+)*(stop|restart|disable|mask)\b/i, tier: 'caution', description: 'stop/restart system service' },
  { name: 'pkill_aiden', regex: /\b(pkill|killall)\b.*\b(aiden|gateway|hermes)\b/i, tier: 'dangerous', description: 'kill aiden/gateway process (self-termination)' },

  // ── Sensitive write targets ───────────────────────────────────
  { name: 'write_etc', regex: />\s*\/etc\//, tier: 'dangerous', description: 'overwrite system config' },
  { name: 'tee_etc', regex: /\btee\b.*\/etc\//, tier: 'dangerous', description: 'overwrite system file via tee' },
  { name: 'write_ssh', regex: />\s*~?\/?\.ssh\//, tier: 'dangerous', description: 'write to .ssh directory' },
  { name: 'cp_to_etc', regex: /\b(cp|mv|install)\b[^|]*\s\/etc\//, tier: 'dangerous', description: 'copy/move file into /etc/' },

  // ── v3 C7 — PowerShell-specific ───────────────────────────────
  { name: 'powershell_iex', regex: /\b(iex|Invoke-Expression)\s*\(?/i, tier: 'dangerous', description: 'PowerShell Invoke-Expression / iex' },
  { name: 'powershell_encoded', regex: /\bpowershell\b.*-(enc|encodedcommand)\s/i, tier: 'dangerous', description: 'PowerShell encoded command' },
  { name: 'remove_item_users', regex: /Remove-Item\b.*[Cc]:[/\\][Uu]sers[/\\]/i, tier: 'dangerous', description: 'PowerShell Remove-Item under C:\\Users' },
  { name: 'remove_item_windows', regex: /Remove-Item\b.*[Cc]:[/\\][Ww]indows[/\\]/i, tier: 'dangerous', description: 'PowerShell Remove-Item under C:\\Windows' },
  { name: 'remove_item_program', regex: /Remove-Item\b.*[Cc]:[/\\][Pp]rogram/i, tier: 'dangerous', description: 'PowerShell Remove-Item under Program Files' },
];

export function detectDangerousPatterns(input: string): DangerPattern[] {
  const out: DangerPattern[] = [];
  for (const p of DANGEROUS_PATTERNS) {
    if (p.regex.test(input)) out.push(p);
  }
  return out;
}

/** `dangerous` if any match has tier='dangerous', otherwise `caution`,
 *  otherwise `safe`. */
export function highestTier(matches: readonly DangerPattern[]): RiskTier {
  if (matches.length === 0) return 'safe';
  if (matches.some((m) => m.tier === 'dangerous')) return 'dangerous';
  return 'caution';
}

/** Convenience: scan an input string and return a tier + reasons. */
export function classifyCommand(input: string): {
  tier: RiskTier;
  matches: DangerPattern[];
  reason?: string;
} {
  const matches = detectDangerousPatterns(input);
  const tier = highestTier(matches);
  const reason = matches[0]?.description;
  return { tier, matches, reason };
}
