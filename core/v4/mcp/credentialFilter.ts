/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/credentialFilter.ts — Aiden v4.0.0 (Phase 11)
 *
 * Security boundary for stdio MCP subprocesses + log redaction.
 *
 * Two responsibilities:
 *
 *   1. `buildEnv()` — produce the environment passed to `spawn()`. We
 *      allowlist a small set of safe baseline variables, accept explicit
 *      key/value pairs from the user, and pass through any extra names
 *      the user explicitly allowlists. AIDEN_* vars are never inherited
 *      unless explicitly allowlisted, even if they show up in safe-env
 *      patterns. Token-shaped values are stripped from inherited vars.
 *
 *   2. `redact()` — replace credential-shaped substrings with
 *      `[REDACTED]` before they hit logs or LLM context.
 *
 * Hermes reference: tools/mcp_tool.py::_build_safe_env, _sanitize_error.
 *
 * Status: PHASE 11.
 */

const SAFE_ENV_KEYS = Object.freeze([
  // POSIX/general
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'TZ',
  // Temp dirs
  'TMPDIR',
  'TEMP',
  'TMP',
  // Node
  'NODE_PATH',
  // Windows
  'USERNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
] as const);

/**
 * Patterns that look like credentials. Order roughly by specificity —
 * more-specific tokens (`sk-ant-...`) run before broader ones (`Bearer ...`)
 * so the labelled forms don't get double-substituted.
 *
 * Each entry's regex is `g` so a single string with multiple tokens has
 * them all replaced in one pass.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  // Anthropic
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  // OpenAI legacy + project
  /sk-proj-[A-Za-z0-9\-_]{20,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  // Groq
  /gsk_[A-Za-z0-9]{40,}/g,
  // Together
  /tgp_v[12]_[A-Za-z0-9\-_]{20,}/g,
  // GitHub PAT (classic + fine-grained)
  /ghp_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  // Slack
  /xox[baprs]-[A-Za-z0-9\-]{10,}/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Generic Bearer header
  /\bBearer\s+[A-Za-z0-9\-_.~+/=]+/gi,
  // Generic key=/token=/password=/secret=
  /\b(?:token|api[_-]?key|password|secret)=[^\s&,;"']{6,}/gi,
]);

/**
 * Token-shaped value detector. If an inherited env var looks like a
 * secret we strip it from the spawn env. Conservative — any value that
 * matches one of the credential patterns above counts.
 */
function looksLikeToken(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(value);
  });
}

export interface BuildEnvOptions {
  /** Explicit key/value overrides (always added, never stripped). */
  explicit?: Record<string, string>;
  /** Extra env var names to inherit from `process.env`. */
  allowlist?: string[];
  /** Inject a different env source — only used for tests. */
  source?: NodeJS.ProcessEnv;
}

export class McpCredentialFilter {
  /** Snapshot of the safe-env list — exposed for tests/diagnostics. */
  readonly safeEnvKeys: ReadonlyArray<string> = SAFE_ENV_KEYS;

  buildEnv(opts: BuildEnvOptions = {}): Record<string, string> {
    const source = opts.source ?? process.env;
    const env: Record<string, string> = {};

    // 1. Inherit safe baseline vars from the source. Strip if value looks
    //    like a token (defends against weird shells exporting secrets to PATH).
    for (const key of SAFE_ENV_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.length > 0 && !looksLikeToken(value)) {
        env[key] = value;
      }
    }

    // 2. User allowlist (extra names) — but never AIDEN_* unless the
    //    user explicitly listed it AND it doesn't look like a token.
    if (opts.allowlist) {
      for (const key of opts.allowlist) {
        const value = source[key];
        if (typeof value !== 'string' || value.length === 0) continue;
        if (looksLikeToken(value)) continue;
        env[key] = value;
      }
    }

    // 3. Explicit overrides last — these are user-provided literal
    //    values and trust the caller. Never strip.
    if (opts.explicit) {
      for (const [k, v] of Object.entries(opts.explicit)) {
        env[k] = v;
      }
    }

    return env;
  }

  /** Replace credential-shaped substrings with `[REDACTED]`. */
  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const pattern of CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, '[REDACTED]');
    }
    return out;
  }
}
