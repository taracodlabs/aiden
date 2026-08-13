/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/_observer.ts — v4.3 Phase 1 + 2: shared BrowserState
 * observer + stale-ref retry HOC for browser ToolHandlers.
 *
 * One BrowserState lives per server process (lifecycle matches the
 * persistent playwrightBridge context). Every browser tool wraps its
 * ToolHandler in `withBrowserState(...)` so the observer's pre/post
 * snapshot capture happens automatically.
 *
 * Phase 1 — observer captures pre/post snapshots and embeds them as
 * a `browserState` sidecar on the tool result when
 * browser depth is enabled (default ON; opt-out via
 * AIDEN_BROWSER_DEPTH=0). No-op when disabled.
 *
 * Phase 2 — stale-ref recovery. When an interactive browser tool
 * (browser_click / browser_type / browser_fill) returns a
 * resolution-class failure (`element not found`, `not visible`,
 * `not attached`, `timeout`, `target closed`), the HOC resnapshots
 * and retries the inner execute ONCE with the same args. The retry
 * logic is reactive only — no preflight tax on success paths. The
 * retry attempt + outcome lands on `ActionResult.staleRefRetry`
 * for Phase 5's classifier to consume.
 *
 * The one-retry hard cap is the consult-derived non-negotiable: a
 * second retry doesn't help (the cause isn't transient) and starts
 * looking like agent thrashing. If the retry fails, the original
 * failure result is preserved — same error message, but with the
 * `staleRefRetry: { attempted: true, succeeded: false, ... }`
 * sidecar so the classifier can recognise the pattern.
 */

import { createHash } from 'node:crypto';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ActionResult } from '../../../core/v4/browserState';
import { createBrowserState, normalizeUrl } from '../../../core/v4/browserState';
import { detectBlocker, type BlockerSurface } from './browserBlocker';
import { pwClose, pwSnapshot } from '../../../core/playwrightBridge';
import { reResolveAndRetry } from './reResolve';
import {
  currentBrowserExecutionScope,
  runWithAuthorizedBrowserSession,
} from '../../../core/v4/browser/browserExecutionScope';
import { currentPreparedDurableToolCall } from '../../../core/v4/daemon/jobExecutionContext';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { BrowserAuthorityError } from '../../../core/v4/browser/browserSessionAuthority';
import { classifyBrowserError, classifyBrowserResult } from '../../../core/v4/browser/browserErrors';

/**
 * Shared observer — one instance per server process. The HOC closes
 * over this reference so all 9 browser tools share the same snapshot
 * counter and gating decision.
 *
 * Tests can construct their own BrowserState with a stubbed bridge
 * loader and call `withBrowserState(handler, customState)` directly.
 */
export const browserState = createBrowserState();
const sessionBrowserStates = new Map<string, typeof browserState>();

export function clearBrowserObservationSession(browserSessionId: string): void {
  sessionBrowserStates.delete(browserSessionId);
}

function scopedBrowserState(defaultState: typeof browserState): typeof browserState {
  if (defaultState !== browserState) return defaultState;
  const sessionId = currentBrowserExecutionScope()?.session.browserSessionId;
  if (!sessionId) return defaultState;
  let state = sessionBrowserStates.get(sessionId);
  if (!state) {
    // Durable Browser Sessions cannot opt out of observe/verify authority.
    // The environment gate remains available only for legacy non-Job calls.
    state = createBrowserState({ enabled: true });
    sessionBrowserStates.set(sessionId, state);
  }
  return state;
}

function snapshotDigest(snapshot: ActionResult['pre_state']): string | null {
  if (!snapshot) return null;
  return createHash('sha256').update(JSON.stringify({
    url: snapshot.normalized_url,
    title: snapshot.title,
    dom: snapshot.dom_text_hash,
    frames: snapshot.frame_tree_hash,
  })).digest('hex');
}

function boundedResultEvidence(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as Record<string, unknown>;
  const allowed = ['url', 'title', 'verified', 'filename', 'size', 'bytes', 'sha256', 'value', 'checked', 'files'];
  const projected: Record<string, unknown> = {};
  for (const key of allowed) {
    const item = value[key];
    if (typeof item === 'string') projected[key] = item.slice(0, 2_000);
    else if (typeof item === 'number' || typeof item === 'boolean') projected[key] = item;
    else if (Array.isArray(item)) projected[key] = item.slice(0, 20).map((entry) => String(entry).slice(0, 500));
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

async function executeWithCancellation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Browser operation cancelled');
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      void pwClose();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Browser operation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    removeAbortListener?.();
  }
}

// ── Phase 2 — stale-ref retry primitives ─────────────────────────────

/**
 * Interactive browser tools that operate on a selector. Stale-ref
 * retry only fires for these — other tools either don't take a
 * selector (browser_navigate, browser_close, browser_get_url) or
 * are read-only (browser_extract, browser_screenshot, browser_scroll).
 */
export const STALE_REF_RETRYABLE: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_type',
  'browser_fill',
]);

/**
 * Error-message patterns that indicate a resolution-class failure
 * (DOM lookup failed BEFORE any side-effect-producing action fired).
 * Phase 2 retries only on these — never on action-failure messages
 * (network errors, permission denials, etc.).
 *
 * The patterns are case-insensitive substrings; one match is enough.
 * False positives are tolerable — retry-once costs ~200ms and produces
 * the same result on the second attempt. False negatives miss the
 * common transient-race case, so bias toward sensitivity.
 */
export const STALE_REF_PATTERNS: ReadonlyArray<RegExp> = [
  /element not found/i,
  /not visible/i,
  /not attached/i,
  /detached from the DOM/i,
  /target closed/i,
  /timeout \d+ms exceeded/i,
];

/**
 * Check if a tool result represents a resolution-class failure.
 * Returns the matched pattern (as a short string) when stale, null
 * otherwise. Pure helper, exported for tests.
 */
export function detectStaleRefError(result: unknown): string | null {
  if (
    result === null || result === undefined || typeof result !== 'object'
  ) return null;
  const r = result as { success?: unknown; error?: unknown };
  if (r.success !== false) return null;
  if (typeof r.error !== 'string' || r.error.length === 0) return null;
  for (const pattern of STALE_REF_PATTERNS) {
    if (pattern.test(r.error)) {
      return pattern.source;
    }
  }
  return null;
}

/**
 * Test whether a tool result represents success. Used by the HOC to
 * decide whether the retry "succeeded" and should become canonical.
 */
function isSuccessResult(result: unknown): boolean {
  if (
    result === null || result === undefined || typeof result !== 'object'
  ) return false;
  return (result as { success?: unknown }).success === true;
}

// ── HOC ──────────────────────────────────────────────────────────────

/**
 * Wrap a browser ToolHandler so its execute() captures pre/post
 * BrowserStateSnapshots when browser depth is enabled (default ON;
 * opt-out via AIDEN_BROWSER_DEPTH=0), embedding the
 * resulting ActionResult on the tool's return value as a
 * `browserState` sidecar field. Phase 2 extends this with reactive
 * stale-ref retry for interactive tools.
 *
 * Contract guarantees:
 *   - Inner execute() always runs. Observer failure never breaks
 *     the tool — pre/post capture wrapped in try/catch via
 *     BrowserState.captureState (which never throws).
 *   - When disabled, the inner result is returned verbatim — no
 *     wrapping, no allocation, identical to v4.2.5.
 *   - When enabled, the inner result is shallow-spread into a new
 *     object with `browserState` added. The inner `success` field
 *     (and every other field) passes through unchanged.
 *   - When the inner result is not a plain object (defensive — should
 *     never happen for well-formed tools), the inner result is
 *     returned verbatim. The observer cannot synthesise a result.
 *   - Phase 2 retry: only for interactive tools that returned a
 *     resolution-class failure. ONE retry hard cap. If retry
 *     succeeds, retry result is canonical. If retry fails, the
 *     ORIGINAL failure is canonical (richer error context). Either
 *     way the `staleRefRetry` sidecar is attached.
 *
 * Optional `state` arg lets tests inject a custom BrowserState
 * instance with a stubbed bridge loader.
 */
/**
 * v4.3 Phase 3 — page-text fetcher used by the HOC's manual-blocker
 * detection. Defaults to `pwSnapshot` (the existing Playwright bridge
 * helper). Tests inject a stub to drive detection without launching
 * a browser; the disabled path never calls this.
 */
export type PageTextFetcher = () => Promise<{ ok: boolean; text?: string; error?: string }>;

const defaultPageTextFetcher: PageTextFetcher = () => pwSnapshot();

export function withBrowserState(
  handler: ToolHandler,
  state:   typeof browserState = browserState,
  /**
   * Optional page-text fetcher. Production code uses pwSnapshot;
   * tests inject a stub returning canned text for the blocker
   * detection tier. The fetcher is called ONCE per action when
   * browser depth is enabled — disabled path skips entirely.
   */
  pageTextFetcher: PageTextFetcher = defaultPageTextFetcher,
): ToolHandler {
  return {
    ...handler,
    async execute(args, ctx) {
      return runWithAuthorizedBrowserSession(ctx.signal, async () => {
        const activeState = scopedBrowserState(state);
        const observerEnabled = activeState.isEnabled();
        const pre = observerEnabled ? await activeState.captureState() : null;
        const scope = currentBrowserExecutionScope();
        const prepared = currentPreparedDurableToolCall();
        let session = scope?.authority.getSession(scope.session.browserSessionId);
        if (scope && session?.state === 'reconciling'
          && session.recoveryState === 'fresh_observation_required'
          && session.controlledTabId && pre) {
          scope.authority.recordObservation(scope.binding, {
            tabId: session.controlledTabId,
            url: pre.url,
            title: pre.title,
            stateDigest: snapshotDigest(pre)!,
            informationDigest: pre.dom_text_hash,
            byteLength: Buffer.byteLength(JSON.stringify(pre)),
          });
          session = scope.authority.getSession(scope.session.browserSessionId);
        }
        if (scope && handler.schema.name === 'browser_navigate' && typeof (args as Record<string, unknown>)?.url === 'string') {
          const target = normalizeUrl(String((args as Record<string, unknown>).url));
          if (!scope.authority.canRepeatNavigation(scope.binding, target)) {
            throw new BrowserAuthorityError('NO_PROGRESS', `Browser session already observed ${target}`);
          }
        }
        const receipt = scope?.authority.beginAction(scope.binding, {
          toolCallId: prepared?.toolCallId ?? null,
          effectId: prepared?.effectId ?? null,
          tabId: session?.controlledTabId ?? null,
          actionType: handler.schema.name,
          args: (args ?? {}) as Record<string, unknown>,
          preStateDigest: snapshotDigest(pre),
        });
        if (scope && receipt) scope.authority.markActionDispatched(scope.binding, receipt.actionId);
        let result: unknown;
        try {
          result = await executeWithCancellation(() => handler.execute(args, ctx), ctx.signal);
        } catch (error) {
          const typedError = classifyBrowserError(error, handler.schema.name);
          if (scope && receipt) {
            scope.authority.completeAction(scope.binding, receipt.actionId, {
              outcome: handler.mutates ? 'unknown' : 'failed',
              commandOk: false,
              semanticOk: handler.mutates ? null : false,
              postStateDigest: null,
              verification: { error: error instanceof Error ? error.name : 'Error' },
              evidencePayload: null,
              errorCode: handler.mutates && typedError.code !== 'ACTION_CANCELLED'
                ? 'ACTION_UNKNOWN'
                : typedError.code,
            });
          }
          throw error;
        }

        if (!observerEnabled) {
          const successful = isSuccessResult(result);
          const typedFailure = classifyBrowserResult(result, handler.schema.name);
          if (scope && receipt) {
            scope.authority.completeAction(scope.binding, receipt.actionId, {
              outcome: handler.mutates ? 'returned' : successful ? 'verified' : 'failed',
              commandOk: successful,
              semanticOk: handler.mutates ? null : successful,
              postStateDigest: null,
              verification: { observer: 'disabled', successful },
              evidencePayload: null,
              errorCode: typedFailure?.code ?? (successful ? null : 'UNEXPECTED_PAGE_STATE'),
            });
          }
          if (handler.mutates === true && successful) currentBrowserLeaseStore().invalidate();
          return typedFailure && result && typeof result === 'object' && !Array.isArray(result)
            ? { ...(result as object), errorCode: typedFailure.code }
            : result;
        }

      // v4.3 Phase 3 — manual-blocker detection. Runs on every
      // browser-tool result when enabled. Uses the configured
      // page-text fetcher (pwSnapshot in production). Detection
      // never breaks the inner tool — pwSnapshot is wrapped in
      // try/catch via the fetcher itself; failures produce no
      // blocker and no observer sidecar field.
      //
      // The detected blocker is BOTH embedded on the result sidecar
      // (Phase 5 + chat layer consumers) AND used to suppress
      // Phase 2's stale-ref retry below. Pause-and-surface contract
      // (Q-CDP5) — never auto-action a blocker.
      let blocker: BlockerSurface | undefined;
      try {
        const snap = await pageTextFetcher();
        if (snap.ok && snap.text) {
          const url = (result as { url?: string } | null)?.url ?? '';
          const detected = detectBlocker({ text: snap.text, url });
          if (detected) blocker = detected;
        }
      } catch { /* detection never breaks the inner tool */ }

      // v4.3 Phase 4 — propagate blocker (or its absence) to the
      // active tab's metadata in BrowserState. Cross-tab queries can
      // then ask "is there a pending blocker on any tab" without
      // re-running detection. No-op when state is disabled or when
      // the tabs map has no active entry (the reconciliation in
      // captureState above sets activeTabId).
      try {
        activeState.updateActiveTabBlocker(blocker
          ? {
              kind:       blocker.kind,
              subtype:    blocker.subtype,
              url:        blocker.url,
              confidence: blocker.confidence,
            }
          : null,
        );
      } catch { /* defensive — tab updates never break the inner tool */ }

      // v4.3 Phase 2 — stale-ref retry. Reactive: fires only after a
      // resolution-class failure on an interactive tool. One retry
      // hard cap. Safe because the resolution-class errors fire
      // BEFORE any DOM event is dispatched, so retry can't double-act.
      //
      // v4.3 Phase 3 suppression: skip the retry when a manual
      // blocker is present (`!blocker` gate). A blocker means the
      // page is asking for human action — retrying the same tool
      // call against a sign-in wall or 2FA prompt won't help and
      // looks like agent thrashing.
      let staleRefRetry: NonNullable<ActionResult['staleRefRetry']> | undefined;
      if (
        pre && !blocker &&
        STALE_REF_RETRYABLE.has(handler.schema.name)
      ) {
        const staleReason = detectStaleRefError(result);
        if (staleReason !== null) {
          // Resnapshot — the "between" state. We use it for the
          // diagnostic state_delta. The retry fires unconditionally
          // (per Q-P2-3 single-signal rule): even when DOM hash
          // hasn't changed, a transient race condition (element
          // attached one tick after the original timeout) is the
          // common case the retry catches.
          const between = await activeState.captureState();
          const state_delta = activeState.computeStateDelta(pre, between);

          // v4.12 B2.1 — ref-based single-target actions (browser_click /
          // browser_type) get SEMANTIC re-resolution: outcome-already-happened
          // check → destructive guard → re-snapshot + signature match → retry
          // once. CSS/text actions (and multi-ref browser_fill) keep the
          // existing same-args replay below.
          const argRecord = (args ?? {}) as Record<string, unknown>;
          const ref = typeof argRecord.ref === 'string' ? argRecord.ref.trim() : '';
          const name = handler.schema.name;
          const singleRef = ref !== '' && (name === 'browser_click' || name === 'browser_type');

          if (singleRef) {
            const rr = await reResolveAndRetry({
              ref,
              actionKind: name === 'browser_click' ? 'click' : 'fill',
              text: name === 'browser_type' ? String(argRecord.text ?? '') : undefined,
              staleReason,
              state_delta,
            });
            staleRefRetry = rr.sidecar;
            if (rr.result !== null) result = rr.result;
          } else {
            // Existing same-args retry — safe by the "error fires before the DOM
            // event" invariant (no element identity shift to double-act on).
            const retryResult = await executeWithCancellation(() => handler.execute(args, ctx), ctx.signal);
            const retryOk = isSuccessResult(retryResult);
            staleRefRetry = { attempted: true, succeeded: retryOk, reason: staleReason, state_delta };
            if (retryOk) result = retryResult;
          }
        }
      }

      // Closing a durable browser surface must not recreate a page merely to
      // observe it. The close result itself carries semantic verification.
      const post = handler.schema.name === 'browser_close'
        ? null
        : await activeState.captureState();
      const observerMeta = activeState.buildActionResult({ pre, post });
      const successful = isSuccessResult(result);
      const typedFailure = classifyBrowserResult(result, handler.schema.name);
      if (scope && receipt) {
        const mutates = handler.mutates === true;
        const explicitlyVerified = Boolean(
          result && typeof result === 'object' && (result as { verified?: unknown }).verified === true,
        );
        const semanticOk = successful && (!mutates || explicitlyVerified || observerMeta?.maybe_noop === false);
        const outcome = !successful ? 'failed'
          : mutates && !explicitlyVerified && observerMeta?.maybe_noop !== false ? 'returned'
          : 'verified';
        scope.authority.completeAction(scope.binding, receipt.actionId, {
          outcome,
          commandOk: successful,
          semanticOk: mutates && observerMeta === null ? null : semanticOk,
          postStateDigest: snapshotDigest(post),
          verification: observerMeta ? {
            progressScore: observerMeta.progress_score,
            evidence: observerMeta.evidence,
            maybeNoop: observerMeta.maybe_noop,
            blocker: blocker?.kind ?? null,
          } : { observer: 'unavailable' },
          evidencePayload: post ? {
            observation: {
              url: post.normalized_url,
              title: post.title,
              stateDigest: snapshotDigest(post),
              progressScore: observerMeta?.progress_score ?? 0,
            },
            result: boundedResultEvidence(result),
          } : null,
          errorCode: typedFailure?.code ?? (successful ? null : 'UNEXPECTED_PAGE_STATE'),
        });
        const controlledTabId = scope.authority.getSession(scope.session.browserSessionId)?.controlledTabId;
        if (controlledTabId && post) {
          scope.authority.recordObservation(scope.binding, {
            tabId: controlledTabId,
            url: post.url,
            title: post.title,
            stateDigest: snapshotDigest(post)!,
            informationDigest: post.dom_text_hash,
            byteLength: Buffer.byteLength(JSON.stringify(post)),
          });
        }
      }
      if (handler.mutates === true && successful) currentBrowserLeaseStore().invalidate();
      if (scope && blocker) {
        scope.authority.requireUserControl(
          scope.binding,
          `${blocker.kind}${blocker.subtype ? `:${blocker.subtype}` : ''}`,
        );
      }
      if (
        observerMeta &&
        result !== null && result !== undefined &&
        typeof result === 'object' && !Array.isArray(result)
      ) {
        const sidecar: ActionResult = {
          ...observerMeta,
          ...(staleRefRetry && { staleRefRetry }),
          ...(blocker && { blocker }),
        };
        return {
          ...(result as object),
          ...(typedFailure ? { errorCode: typedFailure.code } : {}),
          browserState: sidecar,
        };
      }
      return result;
      });
    },
  };
}
