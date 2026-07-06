/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/providerDecision.ts — the single source of truth for WHY this session
 * is on the provider + model it's on.
 *
 * One record, populated once at the boot resolution seam (cli/v4/aidenCLI.ts):
 * which provider+model won, where the original pick came from, whether it was
 * an explicit `--provider`/`--model` flag, and — if a resolve-time fallback
 * happened — the durable reason plus every provider that was tried. It is hung
 * on AgentRuntime for the live session AND persisted to disk, so a later,
 * separate `aiden doctor` process can tell the same honest story instead of the
 * reason being a one-time boot whisper.
 *
 * Read in three places: the boot lines, doctor's Setup group, and (future)
 * `/model` diagnostics.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from './paths';

/** Which precedence case produced the (provider, model) pair. Mirrors
 *  providerBootSelector's BootSelection.source + the Case-6 hardcoded fallback. */
export type BootSource =
  | 'cli-flag'
  | 'persisted-config'
  | 'auto-priority'
  | 'cli-flag-partial'
  | 'config-partial'
  | 'hardcoded-fallback';

/** One provider we tried to resolve this boot, and whether/why it worked. */
export interface ProviderAttempt {
  providerId: string;
  ok:         boolean;
  /** Failure reason when ok=false (e.g. "OAuth token … expired", "Model … not found"). */
  reason?:    string;
}

/** The durable answer to "why this provider+model, and what got skipped?" */
export interface ProviderDecision {
  /** Final provider actually in use this session. */
  provider: string;
  /** Final model actually in use this session. */
  model:    string;
  /** Where the ORIGINAL pick came from (before any resolve-time fallback). */
  source:   BootSource;
  /** The originally-requested provider — present only when a fallback changed it. */
  requestedProvider?: string;
  /** True when the original pick came from an explicit `--provider`/`--model` flag. */
  requestedExplicit:  boolean;
  /** When a fallback happened, the durable reason the requested provider failed
   *  (carries any fix command the resolver embedded, e.g. `/auth refresh …`). */
  fallbackReason?:    string;
  /** Every provider tried this boot, in order, with per-attempt outcome. */
  attempts: ProviderAttempt[];
}

/** True when a boot source was an explicit CLI flag (full or partial). */
export function isExplicitSource(source: BootSource): boolean {
  return source === 'cli-flag' || source === 'cli-flag-partial';
}

/** Path to the persisted decision (one per aiden root). */
function decisionPath(paths: AidenPaths): string {
  return path.join(paths.root, 'provider-decision.json');
}

/** Persist the decision (best-effort — a write failure must never block boot;
 *  the live AgentRuntime copy stays authoritative for this session). */
export function writeProviderDecision(paths: AidenPaths, decision: ProviderDecision): void {
  try {
    writeFileSync(decisionPath(paths), JSON.stringify(decision, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Read the last persisted decision, or null when absent / unreadable. */
export function readProviderDecision(paths: AidenPaths): ProviderDecision | null {
  try {
    const raw = readFileSync(decisionPath(paths), 'utf8');
    const d = JSON.parse(raw) as ProviderDecision;
    if (d && typeof d.provider === 'string' && typeof d.model === 'string' && Array.isArray(d.attempts)) {
      return d;
    }
    return null;
  } catch {
    return null;
  }
}

/** Friendly, plain-words label for where a pick came from. */
export function sourceLabel(s: BootSource): string {
  switch (s) {
    case 'cli-flag':           return 'from --provider/--model';
    case 'cli-flag-partial':   return 'from a --provider/--model flag';
    case 'persisted-config':   return 'from config.yaml';
    case 'config-partial':     return 'from config.yaml';
    case 'auto-priority':      return 'auto-picked (first authed provider)';
    case 'hardcoded-fallback': return 'legacy default (no authed providers)';
    default:                   return String(s);
  }
}

/**
 * A one-line provenance summary for the doctor Setup row + boot lines. Honest
 * about explicit-vs-default: an explicit `--provider` that failed is never
 * mislabelled as a "default" fallback. The fallback reason (with any fix
 * command) is included verbatim.
 */
export function describeOrigin(d: ProviderDecision): string {
  const fellBack = !!d.requestedProvider && d.requestedProvider !== d.provider;
  if (!fellBack) return sourceLabel(d.source);
  const why = d.fallbackReason ? ` — ${d.fallbackReason}` : '';
  return d.requestedExplicit
    ? `you asked for ${d.requestedProvider}; it failed${why}; fell back to ${d.provider}`
    : `${d.requestedProvider} unavailable${why}; fell back to ${d.provider}`;
}
