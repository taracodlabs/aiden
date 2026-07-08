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
 * Curated catalogue (~25) of POSIX + PowerShell destructive patterns,
 * including v3 C7 PowerShell-specific entries lifted from
 * `core/toolRegistry.ts::DENIED_COMMANDS`. Patterns deferred to v4.1:
 * gateway-lifecycle, kill-via-pgrep substitution, sed in-place /etc
 * edits, git destructive ops, heredoc script execution, chmod-then-exec
 * two-step, find-exec/find-delete.
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
  // ── Filesystem destruction ────────────────────
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
  { name: 'pkill_aiden', regex: /\b(pkill|killall)\b.*\b(aiden|gateway)\b/i, tier: 'dangerous', description: 'kill aiden/gateway process (self-termination)' },

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

// ── Read-only command allowlist (v4.14.6) ────────────────────────────────────
//
// `shell_exec` is a `dangerous` floor because it runs arbitrary commands. But a
// plain read-only search/inspect command (rg, grep, ls, cat, …) mutates nothing
// and never needs an approval prompt. `isReadOnlyCommand` proves a command is
// read-only so the tool layer can treat it like `file_read`. It is deliberately
// CONSERVATIVE: anything it cannot prove read-only falls back to normal approval.

/** Basename-matched (case-insensitive, .exe-stripped) commands that only read. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // search / text-read
  'rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'ag',
  'cat', 'type', 'head', 'tail', 'nl', 'wc', 'cut', 'uniq', 'comm',
  // filesystem-inspect
  'ls', 'dir', 'tree', 'find', 'stat', 'file', 'realpath', 'basename', 'dirname',
  'pwd', 'which', 'where',
  // PowerShell read-only cmdlets
  'get-content', 'get-childitem', 'select-string', 'get-item', 'measure-object',
]);

// Metacharacters that could redirect to a file, chain another command, spawn a
// substitution, or background a job — any of these disqualifies the fast-path.
// (Bare `<` input-redirect is intentionally allowed — it only reads a file.)
const UNSAFE_META = /(?:>>?|<\(|>\(|\$\(|[;&\x60\n])/;
// `find` flags that let it run or delete arbitrary things.
const FIND_SIDE_EFFECTS = /\s-(?:delete|exec|execdir|ok|okdir|fprintf?|fls)\b/;

/** Remove fully-literal quoted spans so a `|`/`>` INSIDE a quoted search pattern
 *  (e.g. `rg 'foo|bar'`) can't be mistaken for a pipe/redirect. Double-quoted
 *  spans are stripped ONLY when they contain no `$`/backtick, so a command
 *  substitution hidden in double quotes still trips UNSAFE_META. */
function stripLiterals(cmd: string): string {
  return cmd
    .replace(/'[^']*'/g, ' ')                  // single-quoted → fully literal
    .replace(/"(?:[^"$\x60\\]|\\.)*"/g, ' ');  // double-quoted w/o $ or backtick
}

function leadingToken(stage: string): string | null {
  const first = stage.trim().split(/\s+/)[0] ?? '';
  const base = first.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  return base || null;
}

/**
 * True when `command` is a genuinely read-only shell invocation — a single
 * command or a pipeline where EVERY stage leads with a known read-only command,
 * with no output redirection, chaining, backgrounding, or command substitution,
 * and no dangerous/caution pattern anywhere. Conservative by construction: if it
 * cannot prove read-only, it returns false (→ normal approval).
 */
export function isReadOnlyCommand(command: string): boolean {
  const raw = command.trim();
  if (!raw) return false;
  const bare = stripLiterals(raw);
  if (UNSAFE_META.test(bare)) return false;               // redirect / chain / subst / background
  if (classifyCommand(raw).tier !== 'safe') return false; // any dangerous/caution pattern
  for (const stage of bare.split('|')) {
    const lead = leadingToken(stage);
    if (!lead || !READ_ONLY_COMMANDS.has(lead)) return false;
    if (lead === 'find' && FIND_SIDE_EFFECTS.test(raw)) return false;
  }
  return true;
}
