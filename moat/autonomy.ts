/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/autonomy.ts — v4.12.1 Pillar 2: the autonomy dial.
 *
 * THREE user-facing levels (not four — too many named levels users can't
 * tell apart is theater). A level is a PRESET that expands into an explicit
 * POLICY OBJECT the runtime stores and acts on — not just a mode string:
 *
 *   Observer  — read-only, never mutates.
 *   Assistant — acts, asks at risk boundaries. THE DEFAULT.
 *   Partner   — acts freely INSIDE a bounded scope (workspace writes auto);
 *               destructive + external-send + out-of-scope still ask.
 *
 * `--yolo` is a SEPARATE dev bypass (ApprovalMode 'off'), NOT a dial level —
 * it means "fewer prompts," never "smart autonomy," and it can NEVER bypass
 * the hard-block floor below.
 *
 * `decideAutonomy` GENERALISES the daemon's `DaemonApprovalPolicy` tier-gate
 * (safe-only/caution-ok/dangerous-ok) into one resolver shared by REPL,
 * daemon, and subagents — not a parallel system. Outcome is `allow | ask |
 * deny`; each context interprets `ask`: REPL → prompt the user, daemon →
 * its policy, subagent → escalate to the parent (never a silent deny).
 *
 * SAFETY FLOORS the dial EXTENDS but can NEVER weaken (each a scar-lesson):
 *   • Hard-block set — catastrophic, no-recovery patterns — is denied even at
 *     Partner and even at --yolo (checked before the 'off' short-circuit).
 *   • Destructive (dangerous / irreversible) ALWAYS asks, even at Partner.
 *   • The autonomy POLICY FILE (config.yaml) is a sensitive write target: the
 *     agent must not rewrite its own policy to bypass the gate — blocked via
 *     file path AND shell back-door (tee/sed/redirect/cp/mv).
 *   • Reads always allowed. Budgets (BE.1) are orthogonal and always enforced.
 */

import type { ApprovalRequest, RiskTier } from './approvalEngine';
import { detectDangerousPatterns } from './dangerousPatterns';

// ── Levels ───────────────────────────────────────────────────────────────────

export type AutonomyLevel = 'Observer' | 'Assistant' | 'Partner';

/** Ordered least→most permissive. Rank drives the tighten-only guard. */
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['Observer', 'Assistant', 'Partner'];

export function levelRank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

export function isAutonomyLevel(s: unknown): s is AutonomyLevel {
  return s === 'Observer' || s === 'Assistant' || s === 'Partner';
}

// ── The explicit policy object a level expands into ──────────────────────────

export interface AutonomyPolicy {
  level:                 AutonomyLevel;
  /** Absolute path roots writes may touch WITHOUT asking (Partner scope). */
  workspaceRoots:        string[];
  allowRead:             boolean;               // always true
  /** 'never' (Observer) | 'ask' (Assistant) | 'workspace' (Partner / subagent+). */
  allowWrite:            'never' | 'ask' | 'workspace';
  /** Arbitrary shell/code: 'never' (Observer) | 'ask' (everything else). */
  allowShell:            'never' | 'ask';
  /** Channel/email/webhook sends: 'never' (Observer/subagent) | 'ask'. */
  allowExternalMessages: 'never' | 'ask';
  /** Effect classes that ALWAYS require confirmation, even at Partner. */
  approvalRequiredFor:   string[];
  /** Catastrophic pattern ids denied even at --yolo (see HARD_BLOCK_PATTERNS). */
  hardBlock:             string[];
  /** Session-grant expiry (epoch ms) or null for the session's life. */
  expiry:                number | null;
}

/**
 * Expand a level into its policy object. `isSubagent` shifts the WRITE
 * dimension: a child cannot prompt, so at Assistant+ it auto-allows
 * write-under-workspace (and escalates the rest) rather than blocking —
 * this is the Pillar-3 unblock. External sends are stripped from children
 * (least-privilege).
 */
export function resolveAutonomyPolicy(
  level: AutonomyLevel,
  opts: { workspaceRoots?: string[]; expiry?: number | null; isSubagent?: boolean } = {},
): AutonomyPolicy {
  const workspaceRoots = (opts.workspaceRoots ?? []).map(normalizePath);
  const base: Omit<AutonomyPolicy, 'allowWrite' | 'allowShell' | 'allowExternalMessages'> = {
    level,
    workspaceRoots,
    allowRead: true,
    approvalRequiredFor: ['destructive', 'external_send', 'out_of_scope_write', 'shell'],
    hardBlock: HARD_BLOCK_PATTERNS.map((p) => p.name),
    expiry: opts.expiry ?? null,
  };
  if (level === 'Observer') {
    return { ...base, allowWrite: 'never', allowShell: 'never', allowExternalMessages: 'never' };
  }
  // Assistant / Partner.
  const allowWrite: AutonomyPolicy['allowWrite'] =
    opts.isSubagent ? 'workspace'                 // child: auto-allow scoped writes (can't ask)
    : level === 'Partner' ? 'workspace'
    : 'ask';                                        // Assistant parent: ask at the boundary
  return {
    ...base,
    allowWrite,
    allowShell: 'ask',
    // Least-privilege: children never send externally on their own — escalate.
    allowExternalMessages: opts.isSubagent ? 'never' : 'ask',
  };
}

// ── Back-compat + cross-context mappers ──────────────────────────────────────

/** Derive a level from the legacy ApprovalMode. 'off' is the yolo bypass, not
 *  a level, so it maps to the safe default for the dial's purposes. */
export function levelFromApprovalMode(mode: 'manual' | 'smart' | 'off'): AutonomyLevel {
  // manual + smart both "act, ask at boundary" → Assistant. off (yolo) is
  // handled separately by the engine; default the dial to Assistant.
  return 'Assistant';
}

/** Map a level onto the daemon's tier-gate policy. Daemon FLOOR stays
 *  safe-only unless a job spec pre-authorises (Observer/Assistant → safe-only;
 *  Partner → caution-ok). dangerous never auto in the daemon. */
export function daemonPolicyFromLevel(level: AutonomyLevel): 'safe-only' | 'caution-ok' | 'dangerous-ok' {
  return level === 'Partner' ? 'caution-ok' : 'safe-only';
}

// ── The generalized tier-gate ────────────────────────────────────────────────

export type AutonomyDecision = 'allow' | 'ask' | 'deny';

/** Tool-name / category classifiers (name-based today; effect-based once
 *  ToolEffects tagging lands — the resolver shape won't change). */
const EXTERNAL_SEND_TOOLS = new Set([
  'send_message', 'channel_send', 'message_send', 'send_email', 'email_send',
  'send_webhook', 'webhook_send',
]);
const SHELL_TOOLS = new Set(['shell_exec', 'execute_code', 'process_spawn']);

function isExternalSend(req: ApprovalRequest): boolean {
  if (EXTERNAL_SEND_TOOLS.has(req.toolName)) return true;
  if (req.effects?.externalSpend === true) return true;
  return false;
}
function isShell(req: ApprovalRequest): boolean {
  return SHELL_TOOLS.has(req.toolName) || req.category === 'execute';
}
function writePathOf(req: ApprovalRequest): string | null {
  const a = req.args;
  const raw = (typeof a.path === 'string' && a.path)
    || (typeof a.to === 'string' && a.to)
    || (typeof a.file === 'string' && a.file)
    || null;
  return raw ? normalizePath(raw) : null;
}
function isUnderWorkspace(p: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  const np = normalizePath(p);
  return roots.some((r) => np === r || np.startsWith(r.endsWith('/') ? r : r + '/'));
}

/**
 * Decide allow/ask/deny for ONE mutating call under a policy. This is the
 * generalisation of the daemon's `decideForPolicy` — same riskTier spine,
 * plus the workspace-scoped write grant and the destructive/external floors.
 *
 * (Read-category and the hard-block floor are handled by the ApprovalEngine
 * BEFORE this runs — this function only sees mutating, non-catastrophic calls.)
 */
export function decideAutonomy(policy: AutonomyPolicy, req: ApprovalRequest): AutonomyDecision {
  if (req.category === 'read') return 'allow';           // defensive; reads never gate

  // Observer: never mutates — deny outright (before any ask path).
  if (policy.level === 'Observer') return 'deny';

  // Destructive floor: dangerous / irreversible ALWAYS asks, even at Partner.
  if (req.riskTier === 'dangerous' || req.effects?.irreversible === true) return 'ask';

  // External-send floor: always asks; stripped (deny) for children.
  if (isExternalSend(req)) {
    return policy.allowExternalMessages === 'never' ? 'deny' : 'ask';
  }

  // Arbitrary shell/code: never auto (could rm -rf) — always asks.
  if (isShell(req)) {
    return policy.allowShell === 'never' ? 'deny' : 'ask';
  }

  // Ordinary write (file_write/patch/move, browser mutation, …).
  if (policy.allowWrite === 'workspace') {
    const p = writePathOf(req);
    if (p && isUnderWorkspace(p, policy.workspaceRoots)) return 'allow';   // in-scope → auto
    return 'ask';                                                          // out-of-scope / no path → ask
  }
  // Assistant parent (allowWrite 'ask'): ask at the boundary.
  return 'ask';
}

// ── Hard-block floor — TINY, catastrophic, non-bypassable (even at --yolo) ────

interface HardBlockPattern { name: string; regex: RegExp; description: string; }

/** Catastrophic, no-recovery operations. Denied at EVERY level incl. --yolo.
 *  Kept intentionally tiny: only irreversible whole-system destruction. */
export const HARD_BLOCK_PATTERNS: readonly HardBlockPattern[] = [
  { name: 'wipe_root_or_home', regex: /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*|--recursive)\s+(-[a-zA-Z]*\s+)*(\/(?:\s|$)|~(?:\/\s*)?$|~\s|\$HOME\b|[A-Za-z]:[\\/]?(?:\s|$))/i, description: 'recursive wipe of root / home' },
  { name: 'delete_root_slash', regex: /\brm\s+(-[^\s]*\s+)*\/(?:\s|$)/, description: 'rm pointed at filesystem root' },
  { name: 'mkfs', regex: /\bmkfs\b/i, description: 'format a filesystem' },
  { name: 'dd_to_device', regex: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i, description: 'dd overwrite of a raw block device' },
  { name: 'block_device_redirect', regex: />\s*\/dev\/(sd|nvme|disk|hd)/i, description: 'redirect over a raw block device' },
  { name: 'fork_bomb', regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, description: 'fork bomb' },
  { name: 'kill_all', regex: /\bkill\s+-9\s+-1\b/, description: 'kill every process' },
  { name: 'shutdown_reboot', regex: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, description: 'shut down / reboot the machine' },
  { name: 'sudo_password_pipe', regex: /\becho\b[^|\n]*\|\s*sudo\s+(-S|--stdin)\b/i, description: 'pipe a guessed password into sudo -S' },
];

/** Shell writes that would rewrite Aiden's OWN autonomy policy file. */
const POLICY_FILE_SHELL_PATTERNS: readonly RegExp[] = [
  // redirect / tee / sed -i / cp / mv / install targeting …/aiden/config.yaml
  /(>>?|\btee\b|\bsed\b\s+-[a-zA-Z]*i|\bcp\b|\bmv\b|\binstall\b)[^\n]*[\\/]aiden[\\/](?:[^\n]*[\\/])?config\.ya?ml/i,
  /[\\/]aiden[\\/](?:[^\n]*[\\/])?config\.ya?ml[^\n]*(>>?|\|\s*tee\b)/i,
];

/** True when a resolved path is Aiden's autonomy policy file. */
export function isPolicyFilePath(p: string): boolean {
  return /[\\/]aiden[\\/](?:[^\\/]*[\\/])?config\.ya?ml$/i.test(normalizePath(p));
}

export interface HardBlockResult { blocked: boolean; reason?: string; name?: string; }

/**
 * The universal, non-bypassable floor. Inspects a gated call's command
 * string (shell/code) AND its write path (file tools). Returns blocked with a
 * reason when it matches a catastrophic pattern OR would rewrite the policy
 * file. Called by the ApprovalEngine BEFORE the mode / yolo short-circuit.
 */
export function matchesHardBlock(req: ApprovalRequest): HardBlockResult {
  const a = req.args;
  const cmd = (typeof a.command === 'string' && a.command)
    || (typeof a.code === 'string' && a.code)
    || '';
  if (cmd) {
    for (const p of HARD_BLOCK_PATTERNS) {
      if (p.regex.test(cmd)) return { blocked: true, reason: p.description, name: p.name };
    }
    for (const re of POLICY_FILE_SHELL_PATTERNS) {
      if (re.test(cmd)) return { blocked: true, reason: 'attempt to rewrite the autonomy policy file via shell', name: 'policy_file_shell' };
    }
  }
  // File-tool write to the policy file (file_write/patch/move/delete).
  const p = writePathOf(req);
  if (p && isPolicyFilePath(p)) {
    return { blocked: true, reason: 'the autonomy policy file cannot be modified by the agent', name: 'policy_file_write' };
  }
  return { blocked: false };
}

// ── util ─────────────────────────────────────────────────────────────────────

/** Normalise separators + drop a trailing slash for stable comparisons. */
function normalizePath(p: string): string {
  const n = p.replace(/\\/g, '/');
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/** Re-export so callers can also run the shared danger catalogue if needed. */
export { detectDangerousPatterns };
