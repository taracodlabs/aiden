/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/reResolve.ts — v4.12 B2.1.
 *
 * Semantic re-resolution for a stale ref-based action (browser_click /
 * browser_type by @eN). Replaces the old same-args replay with, IN ORDER —
 * the order IS the safety design:
 *
 *   1. Outcome-already-happened check — if the page already shows strong
 *      progress (navigation / title change), the action took effect; success,
 *      no retry. (First line of defense against double-submit.)
 *   2. ★ Destructive guard — a stale COMMITTING action (isDestructiveAction)
 *      is NEVER blind re-resolved+retried; surface it instead. A vanished
 *      commit button may mean the action already succeeded.
 *   3. Re-snapshot + matchLeaseBySignature → unique match → retry ONCE via
 *      pwActByLease. 0 / ambiguous → surface.
 *
 * One-retry hard cap. Pure decision logic (matchLeaseBySignature /
 * isDestructiveAction) lives in core/v4/browserState; this module orchestrates.
 */
import {
  matchLeaseBySignature,
  isDestructiveAction,
  type ElementLease,
} from '../../../core/v4/browserState';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { pwAxSnapshot, pwActByLease } from '../../../core/playwrightBridge';

/** Strong, action-took-effect evidence (a weak dom_hash change is not enough). */
const STRONG_PROGRESS: ReadonlySet<string> = new Set(['url_changed', 'normalized_url_changed', 'title_changed']);

type Sidecar = {
  attempted:   boolean;
  succeeded:   boolean;
  reason:      string;
  state_delta: string[];
  suppressed?: 'already-done' | 'destructive' | 'ambiguous' | 'gone';
  reResolved?: boolean;
};

export interface ReResolveResult {
  sidecar: Sidecar;
  /** New canonical tool result, or null to keep the original failure. */
  result: Record<string, unknown> | null;
}

export interface ReResolveParams {
  ref:         string;
  actionKind:  'click' | 'fill';
  text?:       string;
  staleReason: string;
  /** Evidence between pre-action and the failed attempt (pre→between). */
  state_delta: string[];
  /** DI seams for tests. */
  snapshotFn?: typeof pwAxSnapshot;
  actFn?:      typeof pwActByLease;
}

export async function reResolveAndRetry(p: ReResolveParams): Promise<ReResolveResult> {
  const snapshotFn = p.snapshotFn ?? pwAxSnapshot;
  const actFn = p.actFn ?? pwActByLease;
  const store = currentBrowserLeaseStore();
  const oldLease = store.get(p.ref);
  const base = { reason: p.staleReason, state_delta: p.state_delta };

  // (1) Outcome already happened — treat as success, do not retry.
  if (p.state_delta.some((e) => STRONG_PROGRESS.has(e))) {
    return {
      sidecar: { attempted: false, succeeded: true, suppressed: 'already-done', ...base },
      result: { success: true, ref: p.ref, note: 'Target is gone but the page already shows the expected change — the action appears to have taken effect; not retried.' },
    };
  }

  // No signature to match (snapshot fully replaced) — surface as-is.
  if (!oldLease) {
    return { sidecar: { attempted: false, succeeded: false, suppressed: 'gone', ...base }, result: null };
  }

  // (2) ★ Destructive guard — never blind re-resolve+retry a committing action.
  if (isDestructiveAction(oldLease, p.actionKind)) {
    return {
      sidecar: { attempted: false, succeeded: false, suppressed: 'destructive', ...base },
      result: {
        success: false,
        ref: p.ref,
        error: `Did NOT auto-retry ${p.ref}: it looks like a committing action ("${oldLease.name || oldLease.role}") whose target is gone — it may have ALREADY succeeded. Run browser_snapshot and verify the outcome before retrying.`,
      },
    };
  }

  // (3) Re-snapshot + signature match → retry once.
  const snap = await snapshotFn();
  if (!snap.ok || !Array.isArray(snap.elements)) {
    return { sidecar: { attempted: false, succeeded: false, suppressed: 'gone', ...base }, result: null };
  }
  store.refresh(Date.now(), snap.url ?? oldLease.url, snap.elements as never[]);
  const m = matchLeaseBySignature(oldLease, store.all());

  if (m.status === 'gone') {
    return {
      sidecar: { attempted: false, succeeded: false, suppressed: 'gone', ...base },
      result: { success: false, ref: p.ref, error: `Re-resolve failed: element (role=${oldLease.role} name="${oldLease.name}") is no longer present after re-snapshot. Run browser_snapshot and retry.` },
    };
  }
  if (m.status === 'ambiguous') {
    return {
      sidecar: { attempted: false, succeeded: false, suppressed: 'ambiguous', ...base },
      result: { success: false, ref: p.ref, error: `Re-resolve ambiguous: ${m.count} elements now match role=${oldLease.role} name="${oldLease.name}". Run browser_snapshot and pick the right @eN.` },
    };
  }

  // Unique → retry once against the re-resolved element.
  const r = await actFn(m.match, p.actionKind === 'click' ? { kind: 'click' } : { kind: 'fill', text: p.text ?? '' });
  if (r.ok) {
    return {
      sidecar: { attempted: true, succeeded: true, reResolved: true, ...base },
      result: { success: true, ref: m.match.ref, reResolvedFrom: p.ref },
    };
  }
  return { sidecar: { attempted: true, succeeded: false, reResolved: true, ...base }, result: null };
}

export type { ElementLease };
