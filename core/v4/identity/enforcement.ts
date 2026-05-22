/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/enforcement.ts — v4.9.0 Slice 8.
 *
 * Wires the "context missing" event from Slices 6 + 7 into an
 * observable + tunable layer. Default mode is `'warn'` — every
 * fall-through path that today silently no-ops now logs a single
 * warning per kind (deduplicated by a small in-process cooldown) and
 * increments a telemetry counter. `'strict'` mode throws so a dev
 * shaking down a new code path can find missing `runWithContext`
 * frames; `'silent'` mode is the production knob for callers that
 * legitimately operate outside the daemon (CLI one-shots, scripts).
 *
 * Read from env at module load:
 *   AIDEN_CONTEXT_ENFORCEMENT             — default 'warn'
 *   AIDEN_CONTEXT_ENFORCEMENT_TOOL        — per-kind override
 *   AIDEN_CONTEXT_ENFORCEMENT_LLM
 *   AIDEN_CONTEXT_ENFORCEMENT_HTTP_OUTBOUND
 *   AIDEN_CONTEXT_ENFORCEMENT_SUBPROCESS
 *   AIDEN_CONTEXT_ENFORCEMENT_MEMORY_WRITE
 *   AIDEN_CONTEXT_ENFORCEMENT_HOOK
 */

export type EnforcementMode = 'strict' | 'warn' | 'silent';
export type EnforcementKind =
  | 'tool' | 'llm' | 'http_outbound' | 'subprocess' | 'memory_write' | 'hook';

const VALID: ReadonlySet<EnforcementMode> = new Set(['strict', 'warn', 'silent']);

function readMode(envVal: string | undefined, fallback: EnforcementMode): EnforcementMode {
  if (!envVal) return fallback;
  const v = envVal.toLowerCase();
  return VALID.has(v as EnforcementMode) ? (v as EnforcementMode) : fallback;
}

function kindEnvKey(kind: EnforcementKind): string {
  return `AIDEN_CONTEXT_ENFORCEMENT_${kind.toUpperCase()}`;
}

/** Resolve the effective mode for a kind. Re-reads env per call so test envs work. */
export function getEnforcementMode(kind: EnforcementKind): EnforcementMode {
  const global = readMode(process.env.AIDEN_CONTEXT_ENFORCEMENT, 'warn');
  return readMode(process.env[kindEnvKey(kind)], global);
}

/**
 * Telemetry counter `context_missing_total{kind}` — incremented on
 * every report regardless of mode. Exposed via the daemon's
 * `/metrics` endpoint (Slice 3 + the existing telemetry surface).
 */
const _counters: Record<string, number> = Object.create(null);
export function getContextMissingCounter(kind: EnforcementKind): number {
  return _counters[kind] ?? 0;
}
export function getAllContextMissingCounters(): Record<string, number> {
  return { ..._counters };
}
export function _resetContextMissingCountersForTests(): void {
  for (const k of Object.keys(_counters)) delete _counters[k];
}

/** Warn-mode dedup so a tight loop with no context doesn't spam. */
const _lastWarnAt: Record<string, number> = Object.create(null);
const WARN_DEDUP_MS = 30_000;

export class ContextMissingError extends Error {
  readonly kind: EnforcementKind;
  constructor(kind: EnforcementKind, hint?: string) {
    super(`[context-enforcement] ${kind}: no ambient ExecutionContext` + (hint ? ` (${hint})` : ''));
    this.name = 'ContextMissingError';
    this.kind = kind;
  }
}

export interface ReportSinks {
  /** Optional logger.warn-style callback; if absent and mode='warn', we noop the log side. */
  warn?: (msg: string) => void;
}

/**
 * Record a "context missing" event. Behaviour per resolved mode:
 *   'strict' — throws ContextMissingError
 *   'warn'   — increments counter; logs via sinks.warn (dedup'd)
 *   'silent' — increments counter only
 */
export function reportMissingContext(
  kind:  EnforcementKind,
  hint?: string,
  sinks: ReportSinks = {},
): void {
  _counters[kind] = (_counters[kind] ?? 0) + 1;
  const mode = getEnforcementMode(kind);
  if (mode === 'strict') {
    throw new ContextMissingError(kind, hint);
  }
  if (mode === 'warn') {
    const now = Date.now();
    if ((now - (_lastWarnAt[kind] ?? 0)) > WARN_DEDUP_MS) {
      _lastWarnAt[kind] = now;
      if (sinks.warn) {
        try { sinks.warn(`[context-enforcement] ${kind} missing context` + (hint ? ` (${hint})` : '')); }
        catch { /* noop */ }
      }
    }
  }
  // silent: counter only.
}
