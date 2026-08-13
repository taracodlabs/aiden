/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/browserState.ts — v4.3 Phase 1: Page-state observer.
 *
 * Per-agent-session observer that captures structured browser-page
 * state before and after every browser tool action. The captured
 * states embed on the tool result as a `browserState` sidecar; Phase 5
 * will use the sidecar to classify "tool succeeded but UI did nothing"
 * cases that currently look identical to genuine success.
 *
 * Three production rules from the consult shape this module:
 *
 *   - **Element refs are leases, not identifiers.** ElementLease defined
 *     here, validated in Phase 2 — carries snapshot_id + frame_id +
 *     visible_text_hash + bbox so mismatches signal "DOM changed since
 *     we took this ref".
 *
 *   - **Frame_id is part of the contract.** Iframe blindness is a real
 *     gap; BrowserStateSnapshot carries frame_id + frame_tree_hash so
 *     cross-frame DOM churn is observable.
 *
 *   - **Never equate tool success with UI progress.** ActionResult
 *     includes progress_score + maybe_noop + needs_verifier; a tool
 *     returning success:true AND maybe_noop:true is the structural
 *     signal for "click executed but nothing changed".
 *
 * **Default ON** as of v4.3 Phase 6 — set `AIDEN_BROWSER_DEPTH=0`
 * to disable. Symmetric with v4.2 Phase 6's TCE flip. When disabled,
 * `captureState()` returns null and the HOC wrapper
 * (`tools/v4/browser/_observer.ts`) skips snapshot work entirely.
 * Zero behavioural change vs v4.2.5 when disabled.
 *
 * Pure module — types + class + helpers. No I/O on the disabled path;
 * two `page.evaluate()` calls per action when enabled (URL + title +
 * innerText hash + recursive iframe URL walk). Latency ~5-15ms per
 * snapshot; observer overhead per action ~10-30ms total.
 *
 * Reference notes: the snapshot shape (URL/title/dom_hash/frame_id)
 * mirrors a pattern seen in a comparable reference system; the
 * ElementLease shape was contributed by a downstream consult. Aiden
 * keeps the typing clean and the implementation Aiden-shaped.
 */

import crypto from 'node:crypto';

// ── Public types ────────────────────────────────────────────────────────────

/** Per-frame state captured at a single instant. */
export interface BrowserStateSnapshot {
  /** Raw page URL — exact string from `page.url()`. */
  url:             string;
  /**
   * URL with hash + common tracking params stripped, trailing slash
   * normalised. Used for "real navigation happened" detection
   * (separate from `url` so tracking-param-only changes can be
   * distinguished from meaningful navigation).
   */
  normalized_url:  string;
  /** `<title>` text. */
  title:           string;
  /**
   * sha256(document.body.innerText.slice(0, 5000)) hex. Cheap DOM-
   * change signal. Truncation keeps hash cost bounded for large
   * pages; the first 5KB of visible text changes meaningfully on
   * almost every real UI transition.
   */
  dom_text_hash:   string;
  /**
   * Frame identifier — `'main'` for the top-level page. Phase 1
   * always emits `'main'`; Phase 2+ extends when ElementLease
   * records cross-frame element refs.
   */
  frame_id:        string;
  /**
   * sha256 over recursive iframe URLs (top-level + nested). Detects
   * iframe injection / churn (login iframes, 3rd-party payment
   * iframes, etc.) without needing per-frame snapshots.
   */
  frame_tree_hash: string;
  /** Wallclock timestamp at capture. */
  ts:              number;
}

/**
 * Per-element lease — defined in Phase 1, validated in Phase 2.
 *
 * Carries everything needed to detect "this ref is no longer valid":
 *   - snapshot_id mismatch → DOM changed since lease
 *   - visible_text_hash mismatch → element content drifted
 *   - bbox change → element moved (or was re-rendered at a new location)
 *   - frame_id mismatch → iframe context changed
 *
 * Phase 1 only defines the shape. Phase 2 wires up the lease lifecycle
 * (create → validate → invalidate) and the stale-ref-retry-once flow.
 */
export interface ElementLease {
  /** Model-facing identifier (e.g. `@e1`). Stable for the lease lifetime. */
  ref:               string;
  /** Equals BrowserStateSnapshot.ts at lease creation. */
  snapshot_id:       number;
  /** Page URL at lease time. */
  url:               string;
  /** Frame the element lives in. */
  frame_id:          string;
  /** ARIA role (`button`, `textbox`, `link`, etc.). */
  role:              string;
  /** Accessible name (ARIA label or textContent). */
  name:              string;
  /** Resolved CSS selector as fallback when ARIA matching fails. */
  css_path:          string;
  /** Bounding box at lease time. */
  bbox:              { x: number; y: number; w: number; h: number };
  /** sha256 of element.textContent at lease time. */
  visible_text_hash: string;
  /**
   * v4.12 B2.1 — submit/commit-like element (input[type=submit|image],
   * button[type=submit], or a typeless <button> inside a <form>). Feeds the
   * destructive-action guard so a stale submit is never blind-retried.
   */
  submit:            boolean;
  form_id?:          string;
  /** Bounded form/control state captured with the same snapshot lease. Password
   * values are never populated. */
  control?: {
    type: string;
    required: boolean;
    disabled: boolean;
    value: string;
    checked: boolean | null;
    options: Array<{ value: string; label: string; selected: boolean }>;
    validationMessage: string;
    formId: string | null;
    autocomplete: string;
  };
}

/**
 * Result of one browser action with full observer context. Embedded
 * as the `browserState` sidecar on the tool result envelope when
 * TCE is enabled (default ON; opt-out via AIDEN_BROWSER_DEPTH=0);
 * absent when disabled.
 */
export interface ActionResult {
  /** State at action start (null when capture failed / disabled). */
  pre_state:        BrowserStateSnapshot | null;
  /** State at action end (null when capture failed / disabled). */
  post_state:       BrowserStateSnapshot | null;
  /**
   * 0.0 (no change detected) to 1.0 (clear navigation). Derived from
   * which evidence strings fired. See `computeProgressScore` for the
   * heuristic table.
   */
  progress_score:   number;
  /**
   * Strings naming what changed:
   *   - `url_changed`              raw URL differs
   *   - `normalized_url_changed`   normalised URL differs (strips tracking)
   *   - `title_changed`            page title differs
   *   - `dom_hash_changed`         body text hash differs
   *   - `frame_tree_changed`       iframe tree differs (injection / churn)
   * Empty array ⇒ maybe_noop.
   */
  evidence:         string[];
  /** True when pre and post are identical across all fields. */
  maybe_noop:       boolean;
  /**
   * Hint for Phase 5 — when true, verifier should run a stricter
   * check even if the tool returned success:true. Set when
   * `maybe_noop` OR `progress_score < 0.3`.
   */
  needs_verifier:   boolean;
  /**
   * v4.3 Phase 2 — present when the HOC attempted a stale-ref retry.
   *
   * The observer HOC (`tools/v4/browser/_observer.ts`) attempts ONE
   * automatic retry when an interactive browser tool fails with a
   * resolution-class error (element not found / not visible / not
   * attached / timeout / target closed). The retry uses the same
   * args, on the hypothesis that the page was mid-render or a SPA
   * route change settled between the original attempt and the retry.
   *
   * Phase 5 classifier reads `succeeded` to map a failed-retry case
   * to the `stale_ref` FailureCategory. The `state_delta` field is
   * purely diagnostic — it captures what changed in the page state
   * between the original attempt and the resnapshot (URL change,
   * DOM hash change, etc.).
   *
   * Absent when:
   *   - The flag was opt'd out (AIDEN_BROWSER_DEPTH=0)
   *   - The tool is not in `STALE_REF_RETRYABLE` (only browser_click /
   *     browser_type / browser_fill qualify)
   *   - The tool succeeded on the first attempt
   *   - The tool failed but the error didn't match a stale-ref pattern
   *     (e.g. "Permission denied" — clearly not a transient race)
   */
  staleRefRetry?: {
    /** False when a re-resolve+retry was deliberately NOT attempted (see `suppressed`). */
    attempted:    boolean;
    succeeded:    boolean;
    /** The first stale-ref pattern that matched (short string). */
    reason:       string;
    /** Evidence between pre and resnapshot — same shape as `evidence`. */
    state_delta:  string[];
    /**
     * v4.12 B2.1 — why a re-resolve+retry was suppressed (when `attempted:false`):
     *   'already-done'  the expected outcome already happened (no retry needed)
     *   'destructive'   committing action whose target is gone — never blind-retried
     *   'ambiguous'     re-snapshot found >1 signature match (escalate to vision, B2.2)
     *   'gone'          no confident signature match after re-snapshot
     */
    suppressed?:  'already-done' | 'destructive' | 'ambiguous' | 'gone';
    /** v4.12 B2.1 — true when the retry used semantic re-resolution (not same-args replay). */
    reResolved?:  boolean;
  };
  /**
   * v4.3 Phase 3 — present when the observer detected a manual
   * blocker on the page (CAPTCHA / login / 2FA / verification /
   * consent). Phase 2's stale-ref retry is structurally suppressed
   * when this field is set — the agent should surface the blocker
   * to the user, not retry automatically. Phase 5's failure
   * classifier maps `blocker` presence to `manual_blocker` category.
   *
   * Import-cycle note: the shape mirrors `BlockerSurface` in
   * `tools/v4/browser/browserBlocker.ts`. Declared structurally
   * here so the core/v4 module stays independent of tools/v4.
   * Shape MUST stay in lockstep — any field added there needs the
   * mirror update here.
   */
  blocker?: {
    kind:       'captcha' | 'login' | '2fa' | 'verification' | 'consent';
    subtype?:   string;
    url:        string;
    confidence: number;
    evidence:   string[];
    message:    string;
  };
}

// ── Phase 4 — Multi-tab state ──────────────────────────────────────────────

/**
 * v4.3 Phase 4 — per-tab metadata captured by the observer's lazy
 * reconciliation pass.
 *
 * Minimal core fields + lightweight Phase 1+3 derived state. Heavier
 * fields are deliberately deferred:
 *   - `purpose` (research / source / form / auth / payment) — needs
 *     goal inference; defer to Phase 5+ with task graph.
 *   - `dirty` (unsaved form input, active upload, modal open) — needs
 *     DOM mutation + XHR tracking; defer.
 *   - `pending_dialogs[]` — needs CDP supervisor; defer.
 *
 * Reconciliation strategy: polling via `pwSnapshotTabs()` on every
 * `BrowserState.captureState()` call when enabled. No event listeners
 * — the source of truth is whatever `context.pages()` returns RIGHT
 * NOW. Closed tabs are removed from the map on the next reconciliation
 * cycle (their Page object isn't in the bridge's enumeration anymore).
 */
export interface TabMetadata {
  /** Stable identifier — bridge-assigned via WeakMap. */
  tab_id:       string;
  /** Current page URL. */
  url:          string;
  /** Current `<title>` text. */
  title:        string;
  /** True when this tab is the one the next tool action will target. */
  is_active:    boolean;
  /** Tab that opened this one (window.open / target=_blank). Null for initial tab. */
  opener_id:    string | null;
  /** Wallclock ms when this tab was first observed. */
  created_ts:   number;
  /** Wallclock ms of the most recent reconciliation that saw this tab. */
  last_seen_ts: number;
  /**
   * Most recent dom_text_hash captured for this tab. Only updated when
   * the tab is the active one (captureState uses the bridge's
   * `_activePage` for its snapshot). Stale for background tabs — the
   * cross-tab query "is this tab still on the same page" is best-effort.
   */
  last_snapshot_hash?: string;
  /**
   * Last detected manual blocker on this tab (from Phase 3). Captured
   * when the tab was active and detection fired. Cleared when a later
   * action on the same tab produces a no-blocker result. Cross-tab
   * queries can ask "is there a pending 2FA prompt on any tab".
   *
   * Structural type (mirrors `BlockerSurface` in
   * `tools/v4/browser/browserBlocker.ts`) — same lockstep contract as
   * ActionResult.blocker above.
   */
  last_blocker?: {
    kind:       'captcha' | 'login' | '2fa' | 'verification' | 'consent';
    subtype?:   string;
    url:        string;
    confidence: number;
  };
}

// ── Helpers (exported for tests + ElementLease lifecycle in Phase 2) ───────

const SHORT_TEXT_HASH_CAP = 5000;

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_eid', 'mc_cid', '_ga', 'ref', '_hsenc', '_hsmi',
  'igshid', 'msclkid', 'yclid',
]);

/**
 * Stable sha256 over a string. Hex-encoded. Truncated input — caller
 * is responsible for slicing to a sensible bound.
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Strip hash + common tracking params + trailing slash. Pure helper;
 * exported for tests + ElementLease URL normalization.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // unparseable — return as-is rather than crashing
  }
  url.hash = '';
  const next = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) next.append(k, v);
  }
  url.search = next.toString();
  let out = url.toString();
  // Drop trailing slash on the path component when query is empty.
  if (out.endsWith('/') && !url.search && url.pathname === '/') {
    out = out.slice(0, -1);
  }
  return out;
}

// ── Snapshot-pair evidence + score ─────────────────────────────────────────

const PROGRESS_WEIGHTS: ReadonlyArray<[string, number]> = [
  ['url_changed',            0.8],
  ['normalized_url_changed', 0.7],
  ['dom_hash_changed',       0.6],
  ['frame_tree_changed',     0.5],
  ['title_changed',          0.4],
];

function computeEvidence(
  pre:  BrowserStateSnapshot,
  post: BrowserStateSnapshot,
): string[] {
  const evidence: string[] = [];
  if (pre.url             !== post.url)             evidence.push('url_changed');
  if (pre.normalized_url  !== post.normalized_url)  evidence.push('normalized_url_changed');
  if (pre.title           !== post.title)           evidence.push('title_changed');
  if (pre.dom_text_hash   !== post.dom_text_hash)   evidence.push('dom_hash_changed');
  if (pre.frame_tree_hash !== post.frame_tree_hash) evidence.push('frame_tree_changed');
  return evidence;
}

function computeProgressScore(evidence: ReadonlyArray<string>): number {
  let score = 0;
  for (const [name, weight] of PROGRESS_WEIGHTS) {
    if (evidence.includes(name) && weight > score) score = weight;
  }
  return score;
}

// ── BrowserState class ─────────────────────────────────────────────────────

const NEEDS_VERIFIER_THRESHOLD = 0.3;

export interface BrowserStateOptions {
  /**
   * Override the env-var gate. Default: read `process.env.AIDEN_BROWSER_DEPTH`
   * at construct time; **state-aware browser depth is ON by default**
   * as of v4.3 Phase 6. Set `AIDEN_BROWSER_DEPTH=0` to disable. Any
   * other value (unset, `'1'`, junk) enables — strict-`'0'` opt-out
   * keeps the contract unambiguous.
   */
  enabled?: boolean;
}

/**
 * Per-agent-session observer. Lifecycle matches the playwrightBridge's
 * persistent context. Reads AIDEN_BROWSER_DEPTH at construction; all
 * methods short-circuit when disabled.
 */
export class BrowserState {
  private readonly enabled:    boolean;
  private snapshotCounter:     number = 0;
  /**
   * Lazily-loaded bridge function. Importing playwrightBridge at module
   * load would force Chromium probing for any consumer of this module;
   * the lazy load means tests + the disabled path don't pay that cost.
   */
  private bridgeLoader?: () => Promise<{
    pwSnapshotHash: () => Promise<{
      ok: boolean;
      url?: string;
      title?: string;
      dom_text_hash?: string;
      frame_tree_hash?: string;
      error?: string;
    }>;
    /**
     * v4.3 Phase 4 — multi-tab enumeration. Optional on the loader
     * shape so older test fixtures that only stub pwSnapshotHash
     * keep working (Phase 4 reconciliation no-ops when absent).
     */
    pwSnapshotTabs?: () => Promise<{
      ok: boolean;
      tabs?: Array<{
        tab_id:    string;
        url:       string;
        title:     string;
        is_active: boolean;
        opener_id: string | null;
      }>;
      error?: string;
    }>;
  }>;
  /** v4.3 Phase 4 — per-tab metadata. Keyed by stable tab_id. */
  private tabs:        Map<string, TabMetadata> = new Map();
  /** v4.3 Phase 4 — id of the currently-focused tab. */
  private activeTabId: string | null = null;

  constructor(opts: BrowserStateOptions = {}) {
    // v4.3 Phase 6 — state-aware browser depth is ON by default.
    // Strict `'0'` opt-out semantic: env var must be literally the
    // string `'0'` to disable; everything else (unset, `'1'`, empty
    // string, junk) enables. Mirrors v4.2 Phase 6's TCE flip exactly.
    // The opts.enabled override still wins when explicitly passed
    // by callers (test fixtures, embedded usage).
    // v4.5 Phase 8a — route through runtimeToggles singleton so
    // /browser-depth slash-command flips and config.yaml overrides
    // take effect on the next constructed BrowserState. Explicit
    // opts.enabled still wins for test fixtures.
    if (typeof opts.enabled === 'boolean') {
      this.enabled = opts.enabled;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const rt = require('./runtimeToggles') as typeof import('./runtimeToggles');
        this.enabled = rt.getRuntimeToggles().isEnabled('browser_depth');
      } catch {
        this.enabled = process.env.AIDEN_BROWSER_DEPTH !== '0';
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Inject a bridge loader for tests. Production code uses the default
   * `() => import('../playwrightBridge')` loader set by `createBrowserState`.
   */
  setBridgeLoader(loader: NonNullable<BrowserState['bridgeLoader']>): void {
    this.bridgeLoader = loader;
  }

  /**
   * Capture current page state. Returns null when:
   *   - opt'd out (AIDEN_BROWSER_DEPTH=0)
   *   - bridge loader missing
   *   - underlying pwSnapshotHash fails (browser not open, page error, etc.)
   *
   * Never throws — observer must not break the inner tool execute.
   */
  async captureState(): Promise<BrowserStateSnapshot | null> {
    if (!this.enabled) return null;
    if (!this.bridgeLoader) return null;
    let raw: Awaited<ReturnType<NonNullable<BrowserState['bridgeLoader']>>>;
    try {
      raw = await this.bridgeLoader();
    } catch {
      return null;
    }
    let result: Awaited<ReturnType<typeof raw.pwSnapshotHash>>;
    try {
      result = await raw.pwSnapshotHash();
    } catch {
      return null;
    }
    if (!result.ok) return null;

    this.snapshotCounter += 1;
    const url   = result.url   ?? '';
    const title = result.title ?? '';
    const snapshot: BrowserStateSnapshot = {
      url,
      normalized_url:  normalizeUrl(url),
      title,
      dom_text_hash:   result.dom_text_hash   ?? '',
      frame_id:        'main',
      frame_tree_hash: result.frame_tree_hash ?? '',
      ts:              this.snapshotCounter,
    };

    // v4.3 Phase 4 — reconcile the tabs map. Lazy: runs after the
    // snapshot is built so a captureState failure (bridge ok:false)
    // skips reconciliation entirely. Never throws.
    await this.reconcileTabs(snapshot.dom_text_hash);

    return snapshot;
  }

  // ── v4.3 Phase 4 — multi-tab state API ─────────────────────────────────

  /**
   * Reconcile the tabs map against the bridge's current page set.
   * Adds newly-observed tabs, updates `last_seen_ts` (and
   * `last_snapshot_hash` for the active tab), removes tabs absent
   * from the bridge's enumeration. Sets `activeTabId`.
   *
   * Called from `captureState()` after a successful snapshot. Public
   * for tests + future v4.4 multi-tab dispatch flows.
   *
   * No-op when:
   *   - disabled (opt-out via AIDEN_BROWSER_DEPTH=0)
   *   - bridge loader missing pwSnapshotTabs (older test fixtures)
   *   - bridge returns ok:false (browser closed, page error)
   *
   * Never throws — observer must not break the inner tool execute.
   */
  async reconcileTabs(activeSnapshotHash?: string): Promise<void> {
    if (!this.enabled) return;
    if (!this.bridgeLoader) return;
    let raw: Awaited<ReturnType<NonNullable<BrowserState['bridgeLoader']>>>;
    try {
      raw = await this.bridgeLoader();
    } catch {
      return;
    }
    if (!raw.pwSnapshotTabs) return;
    let result: NonNullable<Awaited<ReturnType<NonNullable<typeof raw.pwSnapshotTabs>>>>;
    try {
      result = await raw.pwSnapshotTabs();
    } catch {
      return;
    }
    if (!result.ok || !result.tabs) return;

    const now = Date.now();
    const seenIds = new Set<string>();
    let activeId: string | null = null;
    for (const t of result.tabs) {
      seenIds.add(t.tab_id);
      if (t.is_active) activeId = t.tab_id;
      const existing = this.tabs.get(t.tab_id);
      if (existing) {
        existing.url       = t.url;
        existing.title     = t.title;
        existing.is_active = t.is_active;
        existing.opener_id = t.opener_id;
        existing.last_seen_ts = now;
        if (t.is_active && activeSnapshotHash) {
          existing.last_snapshot_hash = activeSnapshotHash;
        }
      } else {
        const fresh: TabMetadata = {
          tab_id:       t.tab_id,
          url:          t.url,
          title:        t.title,
          is_active:    t.is_active,
          opener_id:    t.opener_id,
          created_ts:   now,
          last_seen_ts: now,
        };
        if (t.is_active && activeSnapshotHash) {
          fresh.last_snapshot_hash = activeSnapshotHash;
        }
        this.tabs.set(t.tab_id, fresh);
      }
    }
    // Drop closed tabs — anything in the map that wasn't in this
    // reconciliation pass.
    for (const id of [...this.tabs.keys()]) {
      if (!seenIds.has(id)) this.tabs.delete(id);
    }
    this.activeTabId = activeId;
  }

  /**
   * Update the active tab's `last_blocker` field. Called by the HOC
   * after Phase 3 detection — pass the BlockerSurface to record, or
   * null to clear (e.g. a later action on the same tab succeeded
   * without blocker text). No-op when disabled or when there's no
   * active tab.
   */
  updateActiveTabBlocker(
    blocker: TabMetadata['last_blocker'] | null,
  ): void {
    if (!this.enabled || !this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    if (blocker === null) {
      delete tab.last_blocker;
    } else {
      tab.last_blocker = blocker;
    }
  }

  /**
   * Read-only view of the tabs map. Returns a defensive shallow-clone
   * array. Order is the bridge-reported order (which typically tracks
   * Playwright's internal target ordering — first-opened first).
   */
  getTabs(): TabMetadata[] {
    return [...this.tabs.values()].map((t) => ({ ...t }));
  }

  /** Convenience: the tab marked is_active, or null when none. */
  getActiveTab(): TabMetadata | null {
    if (!this.activeTabId) return null;
    const tab = this.tabs.get(this.activeTabId);
    return tab ? { ...tab } : null;
  }

  /** Lookup a tab by id. Returns null when not in the map. */
  getTab(tabId: string): TabMetadata | null {
    const tab = this.tabs.get(tabId);
    return tab ? { ...tab } : null;
  }

  /**
   * Build the ActionResult sidecar from a pair of snapshots. Returns
   * null when either snapshot is null (disabled or capture failed) —
   * caller should skip embedding the sidecar entirely in that case.
   */
  buildActionResult(input: {
    pre:  BrowserStateSnapshot | null;
    post: BrowserStateSnapshot | null;
  }): ActionResult | null {
    if (!input.pre || !input.post) return null;
    const evidence       = computeEvidence(input.pre, input.post);
    const progress_score = computeProgressScore(evidence);
    const maybe_noop     = evidence.length === 0;
    const needs_verifier = maybe_noop || progress_score < NEEDS_VERIFIER_THRESHOLD;
    return {
      pre_state:      input.pre,
      post_state:     input.post,
      progress_score,
      evidence,
      maybe_noop,
      needs_verifier,
    };
  }

  /**
   * v4.3 Phase 2 — compute evidence-array delta between two snapshots.
   * Public so the observer HOC can record `state_delta` on a
   * stale-ref retry without re-deriving from `buildActionResult`
   * (which expects a pair representing one action, not a pair across
   * a failed attempt + resnapshot).
   *
   * Returns the same set of evidence strings produced by
   * `buildActionResult`: `url_changed`, `normalized_url_changed`,
   * `title_changed`, `dom_hash_changed`, `frame_tree_changed`.
   * Returns `[]` when either snapshot is null.
   */
  computeStateDelta(
    pre:  BrowserStateSnapshot | null,
    post: BrowserStateSnapshot | null,
  ): string[] {
    if (!pre || !post) return [];
    return computeEvidence(pre, post);
  }

  /** Public for tests + ElementLease text-hash construction in Phase 2. */
  normalizeUrl(raw: string): string {
    return normalizeUrl(raw);
  }

  /** Public for tests + ElementLease visible_text_hash construction. */
  hashText(text: string): string {
    return sha256Hex(text.slice(0, SHORT_TEXT_HASH_CAP));
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Default factory. Constructs a BrowserState wired to the production
 * playwrightBridge. One instance is shared across all browser tool
 * wrappers in `tools/v4/browser/_observer.ts`.
 */
export function createBrowserState(options: BrowserStateOptions = {}): BrowserState {
  const bs = new BrowserState(options);
  bs.setBridgeLoader(() => import('../playwrightBridge'));
  return bs;
}

// ── v4.12 B1.1 — a11y snapshot → ElementLease store ─────────────────────────
//
// The ElementLease lifecycle the type was designed for ("Phase 2"). The in-page
// DOM walk (playwrightBridge.pwAxSnapshot) extracts RAW per-element data; the
// SEMANTICS below (role mapping, accessible-name precedence, @eN assignment)
// live here so they're unit-testable — page.evaluate code can't import helpers.

/** Raw per-element data extracted in-page by pwAxSnapshot (no semantics applied). */
export interface AxRawDescriptor {
  tag:            string;
  roleAttr:       string;
  inputType:      string;
  ariaLabel:      string;
  labelledByText: string;
  textContent:    string;
  placeholder:    string;
  alt:            string;
  title:          string;
  css_path:       string;
  bbox:           { x: number; y: number; w: number; h: number };
  frame_id:       string;
  /** v4.12 B2.1 — submit/commit-like (set by the in-page walk). */
  submit:         boolean;
  required?: boolean;
  disabled?: boolean;
  value?: string;
  checked?: boolean | null;
  options?: Array<{ value: string; label: string; selected: boolean }>;
  validationMessage?: string;
  formId?: string | null;
  autocomplete?: string;
}

const AX_NAME_CAP = 200;

/** ARIA role for a descriptor: an explicit role attr wins, else map by tag/type. */
export function axRoleFor(d: Pick<AxRawDescriptor, 'tag' | 'roleAttr' | 'inputType'>): string {
  if (d.roleAttr) return d.roleAttr;
  switch (d.tag) {
    case 'a':        return 'link';
    case 'button':   return 'button';
    case 'select':   return 'combobox';
    case 'textarea': return 'textbox';
    case 'input':
      if (d.inputType === 'checkbox') return 'checkbox';
      if (d.inputType === 'radio')    return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(d.inputType)) return 'button';
      return 'textbox';
    default:         return d.tag === 'a' ? 'link' : 'generic';
  }
}

/**
 * Accessible name via the pragmatic precedence chain:
 * aria-label → aria-labelledby text → textContent → placeholder → alt → title.
 * Whitespace-collapsed and capped (the full ACCNAME algorithm is deferred).
 */
export function accessibleName(
  d: Pick<AxRawDescriptor, 'ariaLabel' | 'labelledByText' | 'textContent' | 'placeholder' | 'alt' | 'title'>,
): string {
  const pick = d.ariaLabel || d.labelledByText || d.textContent || d.placeholder || d.alt || d.title || '';
  return pick.trim().replace(/\s+/g, ' ').slice(0, AX_NAME_CAP);
}

/**
 * Per-process store of the most recent snapshot's leases, keyed by `@eN`.
 * Refreshed on every browser_snapshot — refs are stable within a snapshot; a
 * fresh snapshot reassigns. Reuses the existing ElementLease type + sha256Hex.
 */
export class LeaseStore {
  private leases = new Map<string, ElementLease>();
  private snapshotId = 0;

  /** Replace the store from a fresh snapshot's descriptors (document order → @e1…@eN). */
  refresh(snapshotId: number, url: string, descriptors: AxRawDescriptor[]): ElementLease[] {
    this.leases.clear();
    this.snapshotId = snapshotId;
    const out: ElementLease[] = [];
    descriptors.forEach((d, i) => {
      const lease: ElementLease = {
        ref:               `@e${i + 1}`,
        snapshot_id:       snapshotId,
        url,
        frame_id:          d.frame_id,
        role:              axRoleFor(d),
        name:              accessibleName(d),
        css_path:          d.css_path,
        bbox:              d.bbox,
        visible_text_hash: sha256Hex(d.textContent.slice(0, SHORT_TEXT_HASH_CAP)),
        submit:            d.submit === true,
        ...(d.formId ? { form_id: String(d.formId).slice(0, 500) } : {}),
        ...((d.tag === 'input' || d.tag === 'textarea' || d.tag === 'select'
          || d.roleAttr === 'textbox' || d.roleAttr === 'checkbox'
          || d.roleAttr === 'radio' || d.roleAttr === 'combobox') ? {
          control: {
            type: d.inputType || (d.tag === 'textarea' ? 'textarea' : d.tag === 'select' ? 'select' : d.roleAttr || d.tag),
            required: d.required === true,
            disabled: d.disabled === true,
            value: d.inputType === 'password' ? '' : String(d.value ?? '').slice(0, 2_000),
            checked: typeof d.checked === 'boolean' ? d.checked : null,
            options: (d.options ?? []).slice(0, 200).map((option) => ({
              value: String(option.value).slice(0, 500),
              label: String(option.label).slice(0, 500),
              selected: option.selected === true,
            })),
            validationMessage: String(d.validationMessage ?? '').slice(0, 500),
            formId: d.formId ? String(d.formId).slice(0, 500) : null,
            autocomplete: String(d.autocomplete ?? '').slice(0, 200),
          },
        } : {}),
      };
      this.leases.set(lease.ref, lease);
      out.push(lease);
    });
    return out;
  }

  get(ref: string): ElementLease | undefined { return this.leases.get(ref); }
  all(): ElementLease[] { return [...this.leases.values()]; }
  get currentSnapshotId(): number { return this.snapshotId; }
  invalidate(): void { this.leases.clear(); this.snapshotId = 0; }
}

export interface StructuredFormProjection {
  formId: string;
  fields: Array<{
    ref: string; label: string; role: string; type: string; required: boolean; disabled: boolean;
    value: string; checked: boolean | null;
    options: Array<{ value: string; label: string; selected: boolean }>;
    validationMessage: string; autocomplete: string;
  }>;
  submitRefs: string[];
}

/** Project structured forms from the same snapshot-scoped leases used for
 * browser actions. This is perception only and never submits a form. */
export function projectStructuredForms(leases: readonly ElementLease[]): StructuredFormProjection[] {
  const forms = new Map<string, StructuredFormProjection>();
  for (const lease of leases) {
    const formId = lease.control?.formId ?? lease.form_id ?? (lease.submit ? 'unscoped' : null);
    if (!formId && !lease.control) continue;
    const key = formId ?? 'unscoped';
    let form = forms.get(key);
    if (!form) {
      form = { formId: key, fields: [], submitRefs: [] };
      forms.set(key, form);
    }
    if (lease.submit) form.submitRefs.push(lease.ref);
    if (lease.control) form.fields.push({
      ref: lease.ref, label: lease.name, role: lease.role, type: lease.control.type,
      required: lease.control.required, disabled: lease.control.disabled, value: lease.control.value,
      checked: lease.control.checked, options: lease.control.options,
      validationMessage: lease.control.validationMessage, autocomplete: lease.control.autocomplete,
    });
  }
  return [...forms.values()];
}

// ── v4.12 B2.1 — semantic re-resolution + destructive guard ─────────────────

/**
 * Curated destructive/committing verbs (whole-word, case-insensitive). Err
 * INCLUSIVE: a false positive only costs a surfaced staleness (safe); a false
 * negative risks a double-submit (the danger). Used by isDestructiveAction.
 */
const DESTRUCTIVE_VERBS: readonly string[] = [
  'buy', 'purchase', 'pay', 'checkout', 'order', 'place order', 'submit', 'send',
  'post', 'publish', 'confirm', 'delete', 'remove', 'transfer', 'withdraw',
  'subscribe', 'accept', 'agree', 'continue to payment', 'complete order', 'sign up',
];

/**
 * v4.12 B2.1 — would this action COMMIT something? Drives the guard that forbids
 * blind re-resolve+retry of a stale destructive action (a vanished commit button
 * may mean the action already succeeded → retrying risks a double-submit).
 *
 *   - `type`/`fill` are NEVER destructive (editing a field doesn't commit).
 *   - `click` is destructive when the element is submit-like OR its accessible
 *     name contains a destructive verb (whole-word).
 */
export function isDestructiveAction(
  lease: Pick<ElementLease, 'name' | 'submit'>,
  actionKind: 'click' | 'fill',
): boolean {
  if (actionKind !== 'click') return false;
  if (lease.submit) return true;
  const name = (lease.name || '').toLowerCase();
  if (!name) return false;
  return DESTRUCTIVE_VERBS.some((verb) =>
    new RegExp(`\\b${verb.replace(/\s+/g, '\\s+')}\\b`).test(name),
  );
}

/**
 * v4.12 B5.2 — pre-classify a browser action for the approval engine (mirrors
 * shell_exec's classifyCommand). Destructive click → 'dangerous' tier so the
 * existing approval gate confirms (manual) / denies (smart) it before it runs.
 * Returns undefined for non-destructive actions (default caution applies).
 *
 * Target resolution: ref → the stored lease (role/name/submit); CSS/text click
 * → treat the target string as the element name for verb matching. type/fill
 * are never destructive (editing a field doesn't commit), so they're skipped.
 */
/**
 * v4.12 B5.3 — local-first: localhost / loopback / LAN / .local / file: are
 * LEGITIMATE (the user develops locally). NOT blocked — used only to exempt
 * local navigation from the secret-URL exfil flag.
 */
export function isLocalUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') return true;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test')) return true;
  if (h === '::1' || h.startsWith('127.')) return true;
  if (/^10\./.test(h)) return true;                       // private A
  if (/^192\.168\./.test(h)) return true;                 // private C
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;  // private B
  if (/^169\.254\./.test(h)) return true;                 // link-local
  return false;
}

/** Query keys that signal an embedded credential/token (drops the over-broad bare `key`). */
const SECRET_QUERY_KEY = /^(?:access[_-]?token|auth|api[_-]?key|apikey|token|password|passwd|secret|sig|signature|session|credential|accesskey)$/i;

/** v4.12 B5.3 — does this URL embed a credential/token (userinfo, cred query param, or sk-/Bearer)? */
export function isSecretBearingUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return true; // userinfo creds
  for (const [k] of u.searchParams) { if (SECRET_QUERY_KEY.test(k)) return true; }
  return /sk-[A-Za-z0-9_-]{20,}|bearer\s+[A-Za-z0-9._-]{20,}/i.test(url);
}

export function classifyBrowserAction(
  toolName: string,
  args: Record<string, unknown>,
  opts: { attached?: boolean; leaseStore?: Pick<LeaseStore, 'get'> } = {},
): { tier: 'dangerous'; reason: string } | undefined {
  // B5.3 — navigating an EXTERNAL secret-bearing URL is possible credential
  // exfiltration → confirm. Local URLs (dev) are never flagged or blocked.
  if (toolName === 'browser_navigate') {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) return undefined;
    if (!isLocalUrl(url) && isSecretBearingUrl(url)) {
      return {
        tier: 'dangerous',
        reason: 'Navigating to an external URL that embeds a credential/token — possible secret exfiltration. Confirm before the browser sends it.',
      };
    }
    // B3.2a — attached to the user's REAL browser: be conservative. Confirm ANY
    // external navigation (not just secret-bearing), since it's a live
    // authenticated session. Local URLs (dev) are still never flagged.
    if (opts.attached && !isLocalUrl(url)) {
      return {
        tier: 'dangerous',
        reason: 'Navigating your REAL browser to an external URL. Confirm before it leaves the local/known origin in your live session.',
      };
    }
    return undefined;
  }

  if (toolName !== 'browser_click') return undefined; // type/fill never commit

  const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
  let lease: Pick<ElementLease, 'name' | 'submit'> | undefined;
  if (ref) {
    lease = (opts.leaseStore ?? getLeaseStore()).get(ref);
  } else {
    const target = typeof args.target === 'string'
      ? args.target
      : typeof args.selector === 'string' ? args.selector : '';
    if (target) lease = { name: target, submit: false }; // verb-match the visible target text
  }

  if (lease && isDestructiveAction(lease, 'click')) {
    return {
      tier: 'dangerous',
      reason: `Destructive browser action — "${lease.name || 'submit'}" looks like a committing action (submit / purchase / delete / send / pay). Confirm before it runs on the live page.`,
    };
  }
  return undefined;
}

/**
 * v4.12 B4.2a — classify a JS dialog for the approval path. NOT classifyBrowserAction
 * (a dialog isn't a tool call) — but reuses the RiskTier shape + the DESTRUCTIVE_VERBS set so a
 * "Delete?" confirm is gated like a destructive click.
 *
 *   - beforeunload          → dangerous (accepting discards unsaved page state).
 *   - confirm/prompt whose message hits a destructive verb → dangerous.
 *   - everything else        → caution.
 */
export function classifyDialog(
  type: string,
  message: string,
): { tier: 'safe' | 'caution' | 'dangerous'; reason: string } {
  if (type === 'beforeunload') {
    return { tier: 'dangerous', reason: 'Leaving the page may discard unsaved changes.' };
  }
  const msg = (message || '').toLowerCase();
  if ((type === 'confirm' || type === 'prompt') && msg) {
    const hit = DESTRUCTIVE_VERBS.some((verb) =>
      new RegExp(`\\b${verb.replace(/\s+/g, '\\s+')}\\b`).test(msg),
    );
    if (hit) return { tier: 'dangerous', reason: `Dialog looks destructive: "${message.slice(0, 80)}".` };
  }
  return { tier: 'caution', reason: `${type} dialog: "${(message || '').slice(0, 80)}".` };
}

export type SignatureMatch =
  | { status: 'unique'; match: ElementLease }
  | { status: 'gone' }
  | { status: 'ambiguous'; count: number };

/**
 * v4.12 B2.1 — re-resolve a stale lease against fresh snapshot candidates by its
 * SEMANTIC SIGNATURE. Confident match = exactly one candidate with the same
 * role + accessible name + frame_id. visible_text_hash is a confidence filter
 * (when several share role+name+frame, prefer the text-hash match); bbox is the
 * final tiebreak (nearest). 0 → gone; >1 unresolved → ambiguous.
 */
export function matchLeaseBySignature(old: ElementLease, candidates: ElementLease[]): SignatureMatch {
  const sameSig = candidates.filter(
    (c) => c.frame_id === old.frame_id && c.role === old.role && c.name === old.name,
  );
  if (sameSig.length === 0) return { status: 'gone' };
  if (sameSig.length === 1) return { status: 'unique', match: sameSig[0] };

  // Tie-break 1: identical visible_text_hash.
  const byHash = sameSig.filter((c) => c.visible_text_hash === old.visible_text_hash);
  if (byHash.length === 1) return { status: 'unique', match: byHash[0] };
  const pool = byHash.length > 1 ? byHash : sameSig;

  // Tie-break 2: nearest bbox (centre distance), but only if it's unambiguously closest.
  const dist = (c: ElementLease) => {
    const dx = (c.bbox.x + c.bbox.w / 2) - (old.bbox.x + old.bbox.w / 2);
    const dy = (c.bbox.y + c.bbox.h / 2) - (old.bbox.y + old.bbox.h / 2);
    return dx * dx + dy * dy;
  };
  const sorted = [...pool].sort((a, b) => dist(a) - dist(b));
  if (sorted.length >= 2 && dist(sorted[0]) === dist(sorted[1])) return { status: 'ambiguous', count: pool.length };
  return { status: 'unique', match: sorted[0] };
}

const _leaseStores = new Map<string, LeaseStore>();
/** Lease store scoped to one durable browser session; legacy callers share the default store. */
export function getLeaseStore(browserSessionId = 'legacy'): LeaseStore {
  let store = _leaseStores.get(browserSessionId);
  if (!store) {
    store = new LeaseStore();
    _leaseStores.set(browserSessionId, store);
  }
  return store;
}

export function clearLeaseStore(browserSessionId: string): void {
  const store = _leaseStores.get(browserSessionId);
  store?.invalidate();
  _leaseStores.delete(browserSessionId);
}

/** Model-facing snapshot listing, grouped by frame: `@e1 button "Sign in"`. */
export function formatAxSnapshot(leases: ElementLease[]): string {
  if (leases.length === 0) return 'No interactive elements found on the current page.';
  const byFrame = new Map<string, ElementLease[]>();
  for (const l of leases) {
    const g = byFrame.get(l.frame_id) ?? [];
    g.push(l);
    byFrame.set(l.frame_id, g);
  }
  const lines: string[] = [];
  for (const [frame, group] of byFrame) {
    lines.push(`${frame}:`);
    for (const l of group) lines.push(`  ${l.ref} ${l.role} ${l.name ? `"${l.name}"` : '(no name)'}`);
  }
  return lines.join('\n');
}
