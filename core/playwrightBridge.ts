// ============================================================
// core/playwrightBridge.ts — Centralised Playwright session
// ============================================================
// Single persistent browser context shared across all tool calls
// within a server session.  All browser tools route through here
// instead of duplicating context/page management in toolRegistry.
//
// Environment variables:
//   AIDEN_BROWSER_HEADLESS=true   run headless (default: false / headed)
//   AIDEN_BROWSER_TIMEOUT=15000   default navigation timeout in ms
// ============================================================

import path   from 'path'
import fs     from 'fs'
import crypto from 'crypto'
import { findSystemBrowserExecutable, NO_SYSTEM_BROWSER_ERROR } from './browserExecutable'
import { resolveUserPath } from './v4/paths'
import { resolveRuntimeStorageRoot, runtimeArtifactDirectory } from './v4/runtimeStorage'
import { clearLeaseStore } from './v4/browserState'
import { getTabRegistry, type TabMeta } from './v4/browser/tabRegistry'
import { clearDialogSupervisors, getDialogSupervisor, type DialogRecord, type FileEventRecord } from './v4/browser/dialogState'
import {
  currentBrowserExecutionScope,
  type BrowserExecutionScope,
} from './v4/browser/browserExecutionScope'

// ── Lazy-import Playwright so the server boots even if playwright
//    is not installed (tools will return a clear error message).
let _chromium: any = null
async function getChromium(): Promise<any> {
  if (!_chromium) {
    const pw  = await import('playwright')
    _chromium = pw.chromium
  }
  return _chromium
}

// ── Singleton state ──────────────────────────────────────────
let _browserContext: any = null
let _activePage:     any = null
let _idleTimer:      any = null

// ── v4.12 B3.1 — attach-don't-own (CDP) ──────────────────────
// 'owned'    → Aiden spawns + owns a Chromium (launchPersistentContext). Today's default.
// 'attached' → Aiden connectOverCDP to the USER'S real Chrome. The user owns it;
//              Aiden NEVER closes their tabs/browser and controls only a dedicated
//              tab it creates. B3.2a: actions run, but ONLY on the controlled tab
//              (assertControlledTab) and through B5's confirm guards.
let _mode:           'owned' | 'attached' = 'owned'
let _cdpBrowser:     any = null     // the connectOverCDP Browser (attached)
let _cdpEndpoint:    string | null = null
let _controlledPage: any = null     // Aiden's OWN tab in the attached context (only tab Aiden may close)
const _sessionPages = new Map<string, any>()
const _pageScopes = new WeakMap<object, BrowserExecutionScope>()

const IDLE_MS         = 5 * 60 * 1000                                  // 5 min
const NAV_TIMEOUT     = parseInt(process.env.AIDEN_BROWSER_TIMEOUT ?? '15000', 10)
const HEADLESS        = process.env.AIDEN_BROWSER_HEADLESS === 'true'

// ── Phase v4.1-subagent — Browser mutex ──────────────────────
// One global browser context lives in this module. Subagent fanout
// can spin up N parallel agents — if two of them claim the browser
// at the same instant they'd collide on `_activePage` (one navigates
// while the other reads, racing on URL state).
//
// The mutex is a single-slot async lock: callers `await
// pwAcquire()`, do their work, then call the returned `release()`.
// First arrival runs immediately; subsequent arrivals queue. Because
// every browser tool already calls `ensureContext` / `ensurePage`
// first, the mutex wraps the whole tool body — release is idempotent
// so callers can call it from a `finally`.
//
// Common path (no contention) costs one extra microtask. A queued
// subagent waits exactly as long as the holder takes — no busy
// loops, no timers.

let _browserBusy: boolean = false
const _browserWaiters: Array<() => void> = []

/** Public observability — number of waiters currently queued plus
 *  the holder (if any). Used by subagent diagnostics; not part of
 *  the tool path. */
export function pwQueueDepth(): number {
  return _browserWaiters.length + (_browserBusy ? 1 : 0)
}

// Optional logger sink — wired by callers that want queue / grant
// events captured. The bridge keeps a default no-op so tests + the
// main agent runtime don't need to wire one. Logger must be silent
// in stdio-MCP mode (caller's responsibility to pass an mcp-stdio
// logger if applicable).
type PwLogger = {
  info: (msg: string, ctx?: Record<string, unknown>) => void
}
let _pwLogger: PwLogger | null = null
export function setPwLogger(logger: PwLogger | null): void {
  _pwLogger = logger
}

/** Higher-order helper — wrap any browser-claiming code in this so
 *  all callers queue on the same mutex. Tag identifies the caller
 *  in the queued/granted log lines.
 *
 *  Integration plan: subagent fanout (Phase v4.1-subagent) wraps its
 *  per-subagent browser tool dispatch with `withPwLock` so two
 *  subagents claiming the browser concurrently queue. The existing
 *  public pw* functions in this module are left as direct callers
 *  for now — the v3 single-loop path has no contention and the
 *  primitive can be added file-by-file as fanout flushes out the
 *  hot paths. The smoke for v4.1-subagent tests `pwAcquire` /
 *  `withPwLock` directly. */
export async function withPwLock<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  const queued = _browserWaiters.length + (_browserBusy ? 1 : 0)
  if (queued > 0 && _pwLogger) {
    _pwLogger.info('browser mutex: queued', { tag, depth: queued })
  }
  const release = await pwAcquire()
  if (_pwLogger) {
    _pwLogger.info('browser mutex: granted', { tag })
  }
  try {
    return await fn()
  } finally {
    release()
  }
}

/** Acquire the browser mutex. The returned `release` is idempotent —
 *  multiple calls are no-ops. Always call from a `finally` so a
 *  thrown tool body never strands the lock. */
export async function pwAcquire(): Promise<() => void> {
  if (!_browserBusy) {
    _browserBusy = true
    return makeRelease()
  }
  return new Promise((resolve) => {
    _browserWaiters.push(() => {
      _browserBusy = true
      resolve(makeRelease())
    })
  })
}

function makeRelease(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    _browserBusy = false
    const next = _browserWaiters.shift()
    // Defer to a microtask so the releasing call chain finishes
    // before the next claimant starts — keeps stack depth bounded
    // under deeply queued fanouts.
    if (next) queueMicrotask(next)
  }
}

export function resolveBrowserProfileDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolveUserPath(env.AIDEN_BROWSER_PROFILE_DIR)
    ?? path.join(
      resolveUserPath(env.AIDEN_USER_DATA)
        ?? resolveUserPath(env.AIDEN_HOME)
        ?? resolveRuntimeStorageRoot(env),
      'browser-profile',
    )
}

function getBrowserProfileDir(): string {
  const dir = resolveBrowserProfileDirectory()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function resetIdleTimer(): void {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(async () => {
    if (_mode === 'attached') {
      // NEVER close the user's browser. Idle → DETACH (disconnect), Chrome stays.
      console.log('[Browser] Idle — detaching from attached browser (your Chrome is left running)')
      await pwDetach()
      return
    }
    if (_browserContext) {
      console.log('[Browser] Closing idle browser after 5 min inactivity')
      try { await _browserContext.close() } catch {}
      _browserContext = null
      _activePage     = null
    }
  }, IDLE_MS)
}

async function ensureContext(): Promise<any> {
  if (_mode === 'attached') {
    if (!_browserContext) {
      throw new Error('Attached browser context is gone — re-attach with /browser attach.')
    }
    resetIdleTimer()
    return _browserContext
  }
  if (!_browserContext) {
    const chromium  = await getChromium()
    const executablePath = findSystemBrowserExecutable()
    if (!executablePath) throw new Error(NO_SYSTEM_BROWSER_ERROR)
    const profile   = getBrowserProfileDir()
    console.log(`[Browser] Launching — profile: ${profile}  headless: ${HEADLESS}`)
    _browserContext = await chromium.launchPersistentContext(profile, {
      headless: HEADLESS,
      executablePath,
      viewport: { width: 1280, height: 720 },
    })
    // B4.1 — owned mode: Aiden owns the browser, so existing + new pages are Aiden's.
    wireContext(_browserContext, 'aiden')
  }
  resetIdleTimer()
  return _browserContext
}

async function ensurePage(): Promise<any> {
  const ctx = await ensureContext()
  const scope = currentBrowserExecutionScope()
  if (scope) {
    let page = _sessionPages.get(scope.session.browserSessionId)
    if (!page || page.isClosed()) {
      page = await ctx.newPage()
      _sessionPages.set(scope.session.browserSessionId, page)
    }
    _activePage = page
    if (_mode === 'attached') _controlledPage = page
    bindPageToScope(page, scope, 'aiden', null, true)
    wireDialogHandler(page)
    return page
  }
  if (_mode === 'attached') {
    // ★ NEVER grab a user tab — Aiden controls only its OWN created tab.
    if (!_controlledPage || _controlledPage.isClosed()) {
      _controlledPage = await ctx.newPage()
      getTabRegistry().track(_controlledPage, 'aiden', null) // explicit: Aiden-created
    }
    _activePage = _controlledPage
    getTabRegistry().markControlled(_controlledPage)
    wireDialogHandler(_controlledPage)
    return _controlledPage
  }
  const pages  = ctx.pages() as any[]
  if (!_activePage || _activePage.isClosed()) {
    const blank  = pages.find((p: any) => p.url() === 'about:blank')
    _activePage  = blank ?? await ctx.newPage()
    getTabRegistry().track(_activePage, 'aiden', null)
  }
  getTabRegistry().markControlled(_activePage)
  wireDialogHandler(_activePage)
  return _activePage
}

/**
 * v4.12 B3.2a — defense-in-depth: in attached mode an action may ONLY run on
 * Aiden's dedicated controlled tab, never a user tab. Every attached action
 * calls this on the page it is about to act on; if targeting ever drifted off
 * the controlled tab we refuse rather than touch the user's browser.
 */
export function assertControlledTab(page: any): void {
  if (_mode === 'attached' && page !== _controlledPage) {
    throw new Error('Refusing to act: target is not Aiden\'s controlled tab (attached mode protects your other tabs).')
  }
}

// ── v4.12 B4.1 — live tab registry wiring ────────────────────
// The registry is fed by context.on('page') / page.on('close') so membership,
// createdBy classification, and opener chains are captured LIVE (not rebuilt at
// snapshot time). Classification: owned mode → everything is Aiden's; attached
// mode → new pages are the USER'S unless their opener roots at an Aiden tab.

const _closeWired = new WeakSet<object>()
function wirePageClose(page: any): void {
  if (!page || typeof page !== 'object' || _closeWired.has(page)) return
  _closeWired.add(page)
  try { page.on('close', () => {
    const scope = page && typeof page === 'object' ? _pageScopes.get(page) : undefined
    const meta = getTabRegistry().get(page)
    if (scope && meta) {
      try {
        if (scope.authority.canCloseTab(scope.binding, meta.tab_id)) {
          scope.authority.markTabClosed(scope.binding, meta.tab_id)
        }
      } catch { /* stale Attempt or teardown */ }
      _sessionPages.delete(scope.session.browserSessionId)
    }
    getTabRegistry().remove(page)
  }) } catch { /* mock/teardown */ }
}

function bindPageToScope(
  page: any,
  scope: BrowserExecutionScope,
  createdBy: 'aiden' | 'user',
  openerId: string | null,
  controlled: boolean,
): TabMeta {
  const registry = getTabRegistry()
  const meta = registry.track(page, createdBy, openerId, scope.session.browserSessionId)
  _pageScopes.set(page, scope)
  if (controlled) registry.markControlled(page, scope.session.browserSessionId)
  scope.authority.bindTab(scope.binding, {
    tabId: meta.tab_id,
    createdBy: meta.createdBy,
    controlled,
    openerTabId: meta.opener_id,
    url: typeof page.url === 'function' ? page.url() : '',
    title: meta.title,
  })
  wirePageClose(page)
  return meta
}

// B4.2a — register the dialog/file-event supervisor on a page (idempotent).
const _dialogWired = new WeakSet<object>()
function wireDialogHandler(page: any): void {
  if (!page || typeof page !== 'object' || _dialogWired.has(page)) return
  _dialogWired.add(page)
  const sessionId = getTabRegistry().get(page)?.browserSessionId ?? 'legacy'
  const sup = getDialogSupervisor(sessionId)
  try { page.on('dialog', (d: any) => { void sup.handle(d) }) } catch { /* mock */ }
  // PASSIVE: record file-chooser / download — never auto-fulfill.
  try { page.on('filechooser', (fc: any) => { sup.recordFileEvent('filechooser', (() => { try { return fc.element ? 'file input' : 'chooser' } catch { return 'chooser' } })()) }) } catch { /* mock */ }
  try { page.on('download', (dl: any) => { sup.recordFileEvent('download', (() => { try { return dl.suggestedFilename() as string } catch { return 'download' } })()) }) } catch { /* mock */ }
}

async function handleNewPage(page: any): Promise<void> {
  const reg = getTabRegistry()
  if (reg.has(page)) return // already tracked (Aiden's explicit newPage, or seeded at attach)
  let createdBy: 'aiden' | 'user' = _mode === 'attached' ? 'user' : 'aiden'
  let openerId: string | null = null
  let openerScope: BrowserExecutionScope | undefined
  try {
    const opener = await page.opener()
    if (opener) {
      openerScope = _pageScopes.get(opener)
      const om = reg.get(opener)
      if (om) {
        openerId = om.tab_id
        // ★ opener-rooted popup: a window.open from an Aiden tab is Aiden's
        // (covers OAuth/payment/login popups) — never a genuine user tab.
        if (om.createdBy === 'aiden') createdBy = 'aiden'
      }
    }
  } catch { /* opener() unsupported on mock / detached */ }
  if (openerScope) {
    bindPageToScope(page, openerScope, createdBy, openerId, false)
    wireDialogHandler(page)
  } else {
    reg.track(page, createdBy, openerId)
    wirePageClose(page)
  }
}

/** Seed the registry for a freshly-acquired context + subscribe to new pages. */
function wireContext(ctx: any, existingAs: 'aiden' | 'user'): void {
  const reg = getTabRegistry()
  reg.clear()
  try {
    for (const pg of (ctx.pages() as any[])) { reg.track(pg, existingAs, null); wirePageClose(pg) }
  } catch { /* mock */ }
  try { ctx.on('page', (pg: any) => { void handleNewPage(pg) }) } catch { /* mock */ }
}

/** Refresh live url/title/origin onto each tracked tab and return the list. */
async function refreshTabMeta(): Promise<void> {
  const reg = getTabRegistry()
  for (const [pg, m] of reg.entries()) {
    try {
      const u = typeof pg === 'object' && pg && typeof (pg as any).url === 'function' ? (pg as any).url() as string : ''
      m.url = u
      try { m.origin = u ? new URL(u).origin : '' } catch { m.origin = '' }
      if ((pg as any).title) { try { m.title = await (pg as any).title() as string } catch { /* closed */ } }
    } catch { /* page gone */ }
  }
}

// ── v4.12 B3.1 — attach / detach / status ────────────────────

/**
 * Attach to the user's real Chrome over CDP. Connects to an existing
 * remote-debugging endpoint (the user launched it), uses their existing
 * context, and creates a DEDICATED Aiden tab to control. Read-only in B3.1.
 */
export async function pwAttach(endpoint: string): Promise<{ ok: boolean; endpoint?: string; controlledTabUrl?: string; error?: string }> {
  const available = await checkPwAvailable()
  if (!available) return { ok: false, error: PLAYWRIGHT_MISSING_ERROR }
  try {
    const chromium = await getChromium()
    const browser  = await chromium.connectOverCDP(endpoint)
    const contexts = browser.contexts() as any[]
    const ctx      = contexts[0] ?? (await browser.newContext())
    // Switching from owned → close the owned context first (it's Aiden's own, safe).
    if (_mode === 'owned' && _browserContext) {
      try { await _browserContext.close() } catch {}
    }
    _cdpBrowser     = browser
    _cdpEndpoint    = endpoint
    _browserContext = ctx
    _mode           = 'attached'
    // B4.1 — existing pages are the USER'S; subscribe so popups classify live.
    wireContext(ctx, 'user')
    _controlledPage = await ctx.newPage()  // Aiden's OWN tab — never a user tab
    getTabRegistry().track(_controlledPage, 'aiden', null)
    getTabRegistry().markControlled(_controlledPage)
    wireDialogHandler(_controlledPage)
    _activePage     = _controlledPage
    resetIdleTimer()
    return { ok: true, endpoint, controlledTabUrl: _controlledPage.url() }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

/**
 * Detach (kill switch): disconnect from the user's Chrome. Closes ONLY Aiden's
 * own tab (guarded), then disconnects — on a CDP connection browser.close()
 * DISCONNECTS, it does NOT terminate the user's Chrome. Never touches user tabs.
 */
export async function pwDetach(): Promise<void> {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
  if (_mode !== 'attached') return
  // ★ Close ONLY an Aiden-created controlled tab — NEVER a user-designated one.
  if (_controlledPage && getTabRegistry().canClose(_controlledPage) && !_controlledPage.isClosed()) {
    try { await _controlledPage.close() } catch {}
  }
  if (_cdpBrowser) {
    try { await _cdpBrowser.close() } catch {}  // CDP: disconnect only; Chrome stays
  }
  _cdpBrowser = null; _cdpEndpoint = null; _controlledPage = null
  _browserContext = null; _activePage = null; _mode = 'owned'
  getTabRegistry().clear()
  _sessionPages.clear()
  clearDialogSupervisors()
  console.log('[Browser] Detached — your Chrome is left running')
}

/**
 * v4.12 B3.2b — /browser stop: interrupt the in-flight action but STAY attached.
 * Closes Aiden's controlled tab so any pending Playwright op on it rejects
 * immediately ("Target closed"), then recreates a fresh blank controlled tab.
 * Keeps the CDP connection / context / mode intact (unlike detach).
 *
 * NOT mutex-guarded — it runs concurrently with the stuck action so it can
 * preempt; the action's `finally` frees the mutex once its op rejects.
 */
export async function pwStop(): Promise<{ stopped: boolean; reason?: string }> {
  if (_mode !== 'attached') return { stopped: false, reason: 'not attached' }
  const old = _controlledPage
  // ★ Interrupt by closing the tab — but ONLY if it's Aiden's own. A user tab is
  // never closed; we just move control to a fresh Aiden tab (the user tab stays).
  if (old && getTabRegistry().canClose(old) && !old.isClosed()) {
    try { await old.close() } catch {}  // interrupt: pending ops on this page reject
  }
  // Stay attached — recreate a fresh controlled tab for the next action.
  if (_browserContext) {
    _controlledPage = await _browserContext.newPage()
    getTabRegistry().track(_controlledPage, 'aiden', null)
    getTabRegistry().markControlled(_controlledPage)
    wireDialogHandler(_controlledPage)
    _activePage = _controlledPage
  }
  console.log('[Browser] Stopped current action — fresh tab ready, still attached')
  return { stopped: true }
}

/** Current attach state for /browser status. */
export function pwBrowserStatus(): { mode: 'owned' | 'attached'; endpoint: string | null; controlledTabUrl: string | null } {
  return {
    mode: _mode,
    endpoint: _cdpEndpoint,
    controlledTabUrl: _controlledPage && !_controlledPage.isClosed() ? (_controlledPage.url() as string) : null,
  }
}

// ── v4.12 B4.1 — first-class multi-tab ops ───────────────────

/** List all tracked tabs (live url/title), with createdBy + controlled flags. */
export async function pwListTabs(): Promise<{ ok: boolean; tabs: TabMeta[]; error?: string }> {
  try {
    await ensurePage() // ensure the context + controlled tab are seeded
    await refreshTabMeta()
    const scope = currentBrowserExecutionScope()
    return { ok: true, tabs: getTabRegistry().list(scope?.session.browserSessionId) }
  } catch (e: any) { return { ok: false, tabs: [], error: e.message } }
}

/**
 * Switch which tab Aiden controls. Aiden's OWN tabs (incl. opener-rooted popups)
 * switch freely. A genuine USER tab requires `userDesignated:true` — set only by
 * the user-initiated `/browser control <tab_id>` (tier 2). Aiden can NEVER
 * unilaterally take control of a user tab.
 */
export async function pwSwitchControl(
  tabId: string,
  opts: { userDesignated?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const reg = getTabRegistry()
  const page = reg.pageById(tabId) as any
  if (!page) return { ok: false, error: `No such tab: ${tabId}` }
  if (page.isClosed && page.isClosed()) return { ok: false, error: `Tab ${tabId} is closed` }
  const meta = reg.get(page)!
  const scope = currentBrowserExecutionScope()
  if (scope && meta.browserSessionId !== scope.session.browserSessionId) {
    return { ok: false, error: `Tab ${tabId} does not belong to this browser session` }
  }
  if (meta.createdBy === 'user' && !opts.userDesignated) {
    return {
      ok: false,
      error: `Tab ${tabId} is one of YOUR tabs. Aiden won't take control of it on its own — run "/browser control ${tabId}" to designate it explicitly.`,
    }
  }
  _controlledPage = page
  _activePage = page
  reg.markControlled(page, scope?.session.browserSessionId ?? null)
  if (scope) scope.authority.setControlledTab(scope.binding, tabId)
  return { ok: true }
}

/** Open a new Aiden-created (controllable + closeable) tab; optionally navigate it. */
export async function pwOpenTab(url?: string): Promise<{ ok: boolean; tab_id?: string; error?: string }> {
  const available = await checkPwAvailable()
  if (!available) return { ok: false, error: PLAYWRIGHT_MISSING_ERROR }
  const release = await pwAcquire()
  try {
    const ctx = await ensureContext()
    const page = await ctx.newPage()
    const scope = currentBrowserExecutionScope()
    const meta = scope
      ? bindPageToScope(page, scope, 'aiden', null, false)
      : getTabRegistry().track(page, 'aiden', null) // explicit: Aiden-created
    wirePageClose(page)
    wireDialogHandler(page)
    if (url) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }) } catch { /* surfaced via list */ } }
    return { ok: true, tab_id: meta.tab_id }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

/**
 * Close a tab. ★ Close-guard: ONLY Aiden-created tabs are closeable — a user tab
 * is NEVER closed, even if it is the currently-controlled (user-designated) tab.
 */
export async function pwCloseTab(tabId: string): Promise<{ ok: boolean; error?: string }> {
  const reg = getTabRegistry()
  const page = reg.pageById(tabId) as any
  if (!page) return { ok: false, error: `No such tab: ${tabId}` }
  if (!reg.canClose(page)) {
    return { ok: false, error: `Refusing to close ${tabId}: it is one of YOUR tabs. Aiden only closes tabs it opened.` }
  }
  const scope = currentBrowserExecutionScope()
  const meta = reg.get(page)
  if (scope && meta?.browserSessionId !== scope.session.browserSessionId) {
    return { ok: false, error: `Tab ${tabId} does not belong to this browser session` }
  }
  if (scope && !scope.authority.canCloseTab(scope.binding, tabId)) {
    return { ok: false, error: `Refusing to close ${tabId}: it is not owned by this browser session` }
  }
  try { if (!(page.isClosed && page.isClosed())) await page.close() } catch (e: any) { return { ok: false, error: e.message } }
  reg.remove(page)
  if (page === _controlledPage) { _controlledPage = null; _activePage = null } // next action re-seeds
  return { ok: true }
}

// ── v4.12 B4.2a — dialog + file-event accessors / actions ────

/** Current parked dialog (awaiting a browser_dialog response), or null. */
function activeDialogSupervisor() {
  return getDialogSupervisor(currentBrowserExecutionScope()?.session.browserSessionId ?? 'legacy')
}
export function pwDialogPending(): DialogRecord | null { return activeDialogSupervisor().getPending() }
/** Recently fired+settled dialogs (some close before the next snapshot). */
export function pwDialogRecent(): DialogRecord[] { return activeDialogSupervisor().getRecent() }
/** Passively recorded file-chooser / download events (never auto-fulfilled). */
export function pwFileEvents(): FileEventRecord[] { return activeDialogSupervisor().getFileEvents() }
/** Risk tier of the parked dialog — used by the executor's B5.2 gate on accept. */
export function pwDialogPendingTier(): 'safe' | 'caution' | 'dangerous' | null { return activeDialogSupervisor().pendingTier() }
/** Pre-arm a prompt response so the NEXT action's prompt accepts with this text. */
export function pwSetPromptResponse(text: string | null): void { activeDialogSupervisor().setPromptResponse(text) }

/** Respond to the parked dialog (browser_dialog tool). */
export async function pwRespondDialog(
  action: 'accept' | 'dismiss' | 'respond',
  text?: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await activeDialogSupervisor().respond(action, text)
  return { ok: r.ok, error: r.error }
}

/**
 * Consent-gated upload: set files on a file input. The browser_upload tool that
 * calls this is mutating + dangerous → the executor's B5.2 gate approves it
 * BEFORE we ever touch the user's filesystem. The file-chooser EVENT stays
 * passive (record only) — this is the explicit, approved action.
 */
export async function pwUpload(selector: string, paths: string[]): Promise<{
  ok: boolean; files?: string[]; verified?: boolean; error?: string;
}> {
  const available = await checkPwAvailable()
  if (!available) return { ok: false, error: PLAYWRIGHT_MISSING_ERROR }
  const release = await pwAcquire()
  try {
    const page = await ensurePage()
    assertControlledTab(page)
    const locator = page.locator(selector).first()
    await locator.setInputFiles(paths)
    const files = await locator.evaluate((input: any) =>
      Array.from(input.files ?? []).map((file: any) => String(file.name)),
    ) as string[]
    const expected = paths.map((item) => path.basename(item))
    const verified = expected.length === files.length && expected.every((item, index) => item === files[index])
    return verified
      ? { ok: true, files, verified: true }
      : { ok: false, files, verified: false, error: 'Uploaded file selection did not match the requested files' }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

// ── Exported helpers ─────────────────────────────────────────

// ── Playwright availability check ────────────────────────────────────────────
let _pwAvailable: boolean | null = null
const PLAYWRIGHT_MISSING_ERROR =
  'Browser capability unavailable: Playwright is not installed. Reinstall aiden-runtime or install the optional browser capability.'

export async function pwBrowserAvailability(): Promise<{
  ok: boolean;
  playwright: boolean;
  executablePath?: string;
  error?: string;
}> {
  if (!(await checkPwAvailable())) {
    return { ok: false, playwright: false, error: PLAYWRIGHT_MISSING_ERROR }
  }
  const executablePath = findSystemBrowserExecutable()
  if (!executablePath) {
    return { ok: false, playwright: true, error: NO_SYSTEM_BROWSER_ERROR }
  }
  return { ok: true, playwright: true, executablePath }
}

export async function pwDownload(selector: string): Promise<{
  ok: boolean; path?: string; filename?: string; size?: number; sha256?: string;
  verified?: boolean; error?: string;
}> {
  activeDialogSupervisor().arm()
  const release = await pwAcquire()
  try {
    const page = await ensurePage()
    assertControlledTab(page)
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: NAV_TIMEOUT }),
      page.locator(selector).first().click({ timeout: 5000 }),
    ])
    const suggested = String(download.suggestedFilename?.() ?? 'download.bin')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 160) || 'download.bin'
    const directory = runtimeArtifactDirectory('downloads')
    fs.mkdirSync(directory, { recursive: true })
    const destination = path.join(directory, `${Date.now()}_${suggested}`)
    await download.saveAs(destination)
    const bytes = fs.readFileSync(destination)
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    return {
      ok: true, path: destination, filename: suggested, size: bytes.length,
      sha256, verified: fs.existsSync(destination),
    }
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) }
  } finally { release() }
}
async function checkPwAvailable(): Promise<boolean> {
  if (_pwAvailable !== null) return _pwAvailable
  try {
    await import('playwright')
    _pwAvailable = true
    console.log('[Browser] playwright available')
  } catch {
    _pwAvailable = false
    console.warn(`[Browser] ${PLAYWRIGHT_MISSING_ERROR}`)
  }
  return _pwAvailable
}

/** Navigate to a URL, reusing the active page (opens blank tab if needed). */
export async function pwNavigate(url: string): Promise<{ ok: boolean; url: string; error?: string }> {
  activeDialogSupervisor().arm()
  const available = await checkPwAvailable()
  if (!available) {
    return { ok: false, url, error: PLAYWRIGHT_MISSING_ERROR }
  }
  const release = await pwAcquire() // B3.2b — serialize Aiden's own ops
  try {
    let page: any
    if (currentBrowserExecutionScope()) {
      page = await ensurePage()
    } else if (_mode === 'attached') {
      // ★ B3.2a — in attached mode navigate ONLY Aiden's controlled tab.
      // NEVER scan ctx.pages() (that's the user's context → would grab a user tab).
      page = await ensurePage()
    } else {
      const ctx    = await ensureContext()
      const pages  = ctx.pages() as any[]
      const blank  = pages.find((p: any) => p.url() === 'about:blank')
      page = blank ?? await ctx.newPage()
    }
    assertControlledTab(page)
    _activePage = page
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    return { ok: true, url: page.url() }
  } catch (e: any) { return { ok: false, url, error: e.message } }
  finally { release() }
}

/** Take a full-page screenshot in Aiden's artifact storage. Returns the file path. */
export async function pwScreenshot(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const page   = await ensurePage()
    const dir    = runtimeArtifactDirectory('screenshots')
    fs.mkdirSync(dir, { recursive: true })
    const file   = path.join(dir, `screenshot_${Date.now()}.png`)
    await page.screenshot({ path: file, fullPage: false })
    return { ok: true, path: file }
  } catch (e: any) { return { ok: false, error: e.message } }
}

/**
 * v4.12 B2.2b — in-memory screenshot for vision (browser_see). Returns the PNG
 * as base64; NO disk write (the on-disk path is browser_screenshot's job) so
 * page captures of logged-in/sensitive pages don't linger on disk (B5-aligned).
 */
export async function pwScreenshotBuffer(): Promise<{ ok: boolean; base64?: string; error?: string }> {
  const available = await checkPwAvailable()
  if (!available) return { ok: false, error: PLAYWRIGHT_MISSING_ERROR }
  const release = await pwAcquire()
  try {
    const page = await ensurePage()
    const buf  = await page.screenshot({ fullPage: false })
    return { ok: true, base64: Buffer.from(buf).toString('base64') }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

/** Click an element by CSS selector or text.  Pass 'first_result' for search-result shortcuts. */
export async function pwClick(target: string): Promise<{ ok: boolean; error?: string }> {
  activeDialogSupervisor().arm()
  const release = await pwAcquire() // B3.2b — serialize Aiden's own ops
  try {
    const page   = await ensurePage()
    assertControlledTab(page)
    const tryClick = async (sel: string): Promise<boolean> => {
      try {
        await page.waitForSelector(sel, { state: 'visible', timeout: 5000 })
        await page.locator(sel).first().click({ timeout: 5000 })
        return true
      } catch { return false }
    }
    const clicked = (await tryClick(target)) || (await tryClick(`text=${target}`))
    if (!clicked) return { ok: false, error: `Element not found or not visible: "${target}"` }
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

/** Click the first organic search result on Google / YouTube / DuckDuckGo / Bing. */
export async function pwClickFirstResult(): Promise<{ ok: boolean; url?: string; error?: string }> {
  activeDialogSupervisor().arm()
  const release = await pwAcquire() // B3.2b — serialize Aiden's own ops
  try {
    const page       = await ensurePage()
    assertControlledTab(page)
    const currentUrl = page.url() as string

    type SiteConfig = { selectors: string[]; navPattern?: RegExp }
    const SITES: { pattern: RegExp; cfg: SiteConfig }[] = [
      {
        pattern: /youtube\.com\/results/,
        cfg: { selectors: ['a#video-title', 'ytd-video-renderer a[href*="/watch"]', 'ytd-rich-item-renderer a#thumbnail'], navPattern: /youtube\.com\/watch/ },
      },
      {
        pattern: /google\.com\/search/,
        cfg: { selectors: ['div.g h3 a', 'div#search a[href]:not([href*="google.com/search"])', 'h3.LC20lb'] },
      },
      {
        pattern: /duckduckgo\.com/,
        cfg: { selectors: ['article[data-testid="result"] h2 a', 'a.result__a', 'ol.react-results--main li a[data-testid="result-title-a"]'] },
      },
      {
        pattern: /bing\.com\/search/,
        cfg: { selectors: ['li.b_algo h2 a', '#b_results .b_algo a'] },
      },
    ]

    const match = SITES.find(s => s.pattern.test(currentUrl))
    if (!match) return { ok: false, error: `first_result not supported for ${currentUrl}` }

    let locator: any = null
    for (const sel of match.cfg.selectors) {
      try {
        await page.waitForSelector(sel, { state: 'visible', timeout: 8000 })
        locator = page.locator(sel).first()
        break
      } catch { /* try next */ }
    }
    if (!locator) return { ok: false, error: `No result selector appeared on ${currentUrl}` }

    if (match.cfg.navPattern) {
      await Promise.all([
        page.waitForURL(match.cfg.navPattern, { timeout: 12000 }),
        locator.click({ timeout: 5000 }),
      ])
    } else {
      await locator.click({ timeout: 5000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
    }
    return { ok: true, url: page.url() }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

/** Type text into the specified selector (defaults to first input). */
export async function pwType(selector: string, text: string): Promise<{
  ok: boolean; value?: string; verified?: boolean; error?: string;
}> {
  activeDialogSupervisor().arm()
  const release = await pwAcquire() // B3.2b — serialize Aiden's own ops
  try {
    const page = await ensurePage()
    assertControlledTab(page)
    await page.waitForSelector(selector, { state: 'visible', timeout: 5000 }).catch(() => {})
    const locator = page.locator(selector).first()
    await locator.fill(text)
    const value = await locator.inputValue()
    if (value !== text) return { ok: false, value, verified: false, error: 'Input value did not match after fill' }
    return { ok: true, value, verified: true }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

export async function pwSetControl(command: {
  selector: string;
  operation: 'check' | 'uncheck' | 'radio' | 'select' | 'choose' | 'autocomplete';
  value?: string;
}): Promise<{
  ok: boolean; verified?: boolean; value?: string; checked?: boolean; error?: string;
}> {
  activeDialogSupervisor().arm()
  const release = await pwAcquire()
  try {
    const page = await ensurePage()
    assertControlledTab(page)
    const locator = page.locator(command.selector).first()
    await locator.waitFor({ state: 'visible', timeout: 5000 })
    if (command.operation === 'check' || command.operation === 'radio') {
      await locator.check({ timeout: 5000 })
      const checked = await locator.isChecked()
      return checked ? { ok: true, verified: true, checked } : { ok: false, verified: false, checked, error: 'Control was not checked' }
    }
    if (command.operation === 'uncheck') {
      await locator.uncheck({ timeout: 5000 })
      const checked = await locator.isChecked()
      return !checked ? { ok: true, verified: true, checked } : { ok: false, verified: false, checked, error: 'Control remained checked' }
    }
    const value = command.value ?? ''
    if (command.operation === 'select') {
      const selected = await locator.selectOption({ label: value }).catch(() => locator.selectOption(value))
      const actual = await locator.inputValue()
      const verified = selected.length > 0 && (actual === value || selected.includes(actual))
      return verified ? { ok: true, verified: true, value: actual } : { ok: false, verified: false, value: actual, error: 'Selected option did not match' }
    }
    if (command.operation === 'autocomplete') {
      await locator.fill(value)
      const option = page.getByRole('option', { name: value, exact: true }).first()
      await option.click({ timeout: 5000 })
      const actual = await locator.inputValue()
      return actual ? { ok: true, verified: true, value: actual } : { ok: false, verified: false, value: actual, error: 'Autocomplete selection was not retained' }
    }
    await locator.click({ timeout: 5000 })
    const option = page.getByRole('option', { name: value, exact: true }).first()
    await option.click({ timeout: 5000 })
    const selected = await option.getAttribute('aria-selected').catch(() => null)
    const verified = selected === null || selected === 'true'
    return verified ? { ok: true, verified: true, value } : { ok: false, verified: false, value, error: 'Custom option did not become selected' }
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) }
  } finally { release() }
}

/** Scroll the page or a specific element. */
export async function pwScroll(
  direction: 'up' | 'down' | 'top' | 'bottom',
  amount: number,
  selector?: string,
): Promise<{ ok: boolean; error?: string }> {
  activeDialogSupervisor().arm()
  const release = await pwAcquire() // B3.2b — serialize Aiden's own ops
  try {
    const page = await ensurePage()
    assertControlledTab(page)

    if (selector) {
      await page.waitForSelector(selector, { state: 'visible', timeout: 5000 }).catch(() => {})
      if (direction === 'top') {
        await page.evaluate((sel: string) => {
          // eslint-disable-next-line no-undef
          const el = (globalThis as any).document.querySelector(sel); if (el) el.scrollTop = 0
        }, selector)
      } else if (direction === 'bottom') {
        await page.evaluate((sel: string) => {
          // eslint-disable-next-line no-undef
          const el = (globalThis as any).document.querySelector(sel)
          if (el) el.scrollTop = el.scrollHeight
        }, selector)
      } else {
        const delta = direction === 'up' ? -amount : amount
        await page.evaluate(({ sel, dy }: { sel: string; dy: number }) => {
          // eslint-disable-next-line no-undef
          const el = (globalThis as any).document.querySelector(sel)
          if (el) el.scrollBy(0, dy)
        }, { sel: selector, dy: delta })
      }
    } else {
      if (direction === 'top') {
        await page.evaluate(() => (globalThis as any).window.scrollTo(0, 0))
      } else if (direction === 'bottom') {
        await page.evaluate(() => (globalThis as any).window.scrollTo(0, (globalThis as any).document.body.scrollHeight))
      } else {
        const delta = direction === 'up' ? -amount : amount
        await page.evaluate((dy: number) => (globalThis as any).window.scrollBy(0, dy), delta)
      }
    }
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

/** Extract visible text from the current page body (first 3 000 chars). */
export async function pwSnapshot(): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const page = await ensurePage()
    // eslint-disable-next-line no-undef
    const text = await page.evaluate(() => (globalThis as any).document.body.innerText) as string
    return { ok: true, text: text.slice(0, 3000) }
  } catch (e: any) { return { ok: false, error: e.message } }
}

/**
 * v4.3 Phase 1 — structured page-state snapshot used by the BrowserState
 * observer. Captures URL + title + body-text hash + recursive iframe-tree
 * hash in a single in-page evaluate. Truncates body innerText to 5 000
 * chars before hashing so cost stays bounded for large pages.
 *
 * Cross-origin iframe srcs are surfaced (URL is visible); attempting to
 * read `iframe.contentDocument` on a cross-origin frame throws — the
 * recursive walker catches and skips, recording only the iframe's src.
 *
 * Returns `ok: false` when the browser is closed or evaluate fails.
 * Caller (BrowserState.captureState) treats `ok: false` as "snapshot
 * unavailable, embed no sidecar this call".
 */
export async function pwSnapshotHash(): Promise<{
  ok:               boolean;
  url?:             string;
  title?:           string;
  dom_text_hash?:   string;
  frame_tree_hash?: string;
  error?:           string;
}> {
  try {
    const page  = await ensurePage()
    const url   = page.url() as string
    const title = await page.title() as string
    // eslint-disable-next-line no-undef
    const data  = await page.evaluate(() => {
      const doc = (globalThis as any).document
      const text = (doc?.body?.innerText ?? '') as string
      // Recursive iframe URL walk. Cross-origin iframes throw on
      // contentDocument access — catch and record just the src.
      const urls: string[] = []
      function walk(d: any): void {
        try {
          const iframes = Array.from(d.querySelectorAll('iframe')) as any[]
          for (const f of iframes) {
            urls.push(String(f.src ?? ''))
            try { if (f.contentDocument) walk(f.contentDocument) } catch { /* cross-origin */ }
          }
        } catch { /* defensive */ }
      }
      walk(doc)
      return { text, frame_urls: urls.join('|') }
    }) as { text: string; frame_urls: string }

    const dom_text_hash   = crypto.createHash('sha256').update(data.text.slice(0, 5000)).digest('hex')
    const frame_tree_hash = crypto.createHash('sha256').update(data.frame_urls).digest('hex')

    return { ok: true, url, title, dom_text_hash, frame_tree_hash }
  } catch (e: any) { return { ok: false, error: e.message } }
}

/**
 * v4.12 B1.1 — accessibility-tree snapshot. A single in-page DOM walk that
 * enumerates INTERACTIVE elements (button / a[href] / input / textarea /
 * select / [role=...] / [tabindex] / contenteditable), visible-filtered, in
 * document order. For each it extracts RAW data only — tag/role-attr/input-type,
 * the accessible-name source parts (aria-label, aria-labelledby text, text,
 * placeholder, alt, title), a css_path fallback, and the bbox. B4.2b: every
 * frame in page.frames() is extracted via Frame.evaluate (tagged frame-N by its
 * index), so CROSS-ORIGIN OOPIFs are now visible too — the old contentDocument
 * walk threw on cross-origin and skipped them. Bounded by MAX_FRAMES / depth.
 *
 * Semantics (role mapping, accessible-name precedence, @eN assignment) live in
 * core/v4/browserState.ts where they're unit-testable — this fn stays a dumb
 * extractor because page.evaluate code cannot import module helpers.
 */
export async function pwAxSnapshot(): Promise<{ ok: boolean; url?: string; elements?: any[]; error?: string }> {
  const available = await checkPwAvailable()
  if (!available) return { ok: false, error: PLAYWRIGHT_MISSING_ERROR }
  const release = await pwAcquire()
  try {
    const page = await ensurePage()
    const url  = page.url() as string

    // B4.2b — per-frame element extraction (no in-page iframe recursion). Runs in
    // EACH frame's context via Frame.evaluate, which works cross-origin (OOPIFs) —
    // the old contentDocument walk threw on cross-origin and skipped them.
    // eslint-disable-next-line no-undef
    const extract = () => {
      const SEL = [
        'button', 'a[href]', 'input', 'textarea', 'select',
        '[role=button]', '[role=link]', '[role=textbox]', '[role=checkbox]',
        '[role=radio]', '[role=tab]', '[role=menuitem]', '[role=combobox]',
        '[tabindex]', '[contenteditable=""]', '[contenteditable=true]',
      ].join(', ')

      function cssPath(el: any): string {
        if (el.id) return `#${(globalThis as any).CSS?.escape ? (globalThis as any).CSS.escape(el.id) : el.id}`
        const parts: string[] = []
        let node: any = el
        for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
          const tag = node.tagName.toLowerCase()
          if (node.id) { parts.unshift(`#${node.id}`); break }
          let i = 1
          let sib = node.previousElementSibling
          while (sib) { if (sib.tagName === node.tagName) i += 1; sib = sib.previousElementSibling }
          parts.unshift(`${tag}:nth-of-type(${i})`)
          node = node.parentElement
        }
        return parts.join(' > ')
      }

      function visible(el: any): boolean {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const s = (globalThis as any).getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none'
      }

      function labelledByText(el: any, doc: any): string {
        const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        if (ids.length > 0) {
          return ids.map((id: string) => (doc.getElementById(id)?.textContent || '').trim()).join(' ').trim()
        }
        const labels = Array.from(el.labels || []) as any[]
        return labels.map((label: any) => {
          const copy = label.cloneNode(true)
          for (const control of Array.from(copy.querySelectorAll('input, textarea, select, button')) as any[]) {
            control.remove()
          }
          return String(copy.textContent || '').trim()
        }).filter(Boolean).join(' ').trim()
      }

      const doc = (globalThis as any).document
      const out: any[] = []
      let els: any[] = []
      try { els = Array.from(doc.querySelectorAll(SEL)) } catch { return out }
      for (const el of els) {
        try {
          if (!visible(el)) continue
          const r = el.getBoundingClientRect()
          const tag = el.tagName.toLowerCase()
          const itype = (el.getAttribute('type') || '').toLowerCase()
          const submit =
            (tag === 'input' && (itype === 'submit' || itype === 'image')) ||
            (tag === 'button' && (itype === 'submit' || (itype === '' && !!el.closest('form'))))
          out.push({
            tag,
            roleAttr:       el.getAttribute('role') || '',
            inputType:      itype,
            submit,
            required:        el.required === true || el.getAttribute('aria-required') === 'true',
            disabled:        el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            value:           itype === 'password' ? '' : String(el.value ?? el.textContent ?? '').slice(0, 2000),
            checked:         typeof el.checked === 'boolean' ? el.checked : null,
            options:         tag === 'select' ? Array.from(el.options || []).slice(0, 200).map((option: any) => ({
              value: String(option.value ?? '').slice(0, 500),
              label: String(option.label ?? option.textContent ?? '').trim().slice(0, 500),
              selected: option.selected === true,
            })) : [],
            validationMessage: String(el.validationMessage ?? '').slice(0, 500),
            formId:          el.form ? String(el.form.id || el.form.getAttribute('name') || cssPath(el.form)).slice(0, 500) : null,
            autocomplete:    String(el.getAttribute('autocomplete') || '').slice(0, 200),
            ariaLabel:      el.getAttribute('aria-label') || '',
            labelledByText: labelledByText(el, doc),
            textContent:    (el.textContent || '').trim().slice(0, 1000),
            placeholder:    el.getAttribute('placeholder') || '',
            alt:            el.getAttribute('alt') || '',
            title:          el.getAttribute('title') || '',
            css_path:       cssPath(el),
            bbox:           { x: r.x, y: r.y, w: r.width, h: r.height },
          })
        } catch { /* per-element defensive */ }
      }
      return out
    }

    // ★ UNIFIED ADDRESSING: frame_id is the index into page.frames() — the SAME
    // scheme scopeForFrame resolves, so a lease in frame N acts in frame N.
    // Bounded DAG (count + depth) so ad-heavy pages can't blow up the snapshot.
    const frames = page.frames() as any[]
    const elements: any[] = []
    let scanned = 0
    for (let i = 0; i < frames.length && scanned < MAX_FRAMES; i += 1) {
      const f = frames[i]
      if (frameDepth(f) > MAX_FRAME_DEPTH) continue
      scanned += 1
      let descs: any[] = []
      try { descs = await f.evaluate(extract) as any[] } catch { continue } // detached/blocked → skip
      const frameId = i === 0 ? 'main' : `frame-${i}`
      for (const d of descs) { d.frame_id = frameId; elements.push(d) }
    }

    return { ok: true, url, elements }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

/**
 * v4.12 B1.2 — act on an element by its lease (from browser_snapshot's @eN).
 * Resolution: getByRole(role,{name}) PRIMARY (exact), frame-scoped via
 * scopeForFrame (B4.2b: the lease's frame_id → the matching page.frames() Frame,
 * cross-origin OOPIFs included); page.locator(css_path) FALLBACK when the
 * role/name match is empty or ambiguous (count ≠ 1).
 *
 * Structural `lease` param (role/name/css_path/frame_id) — not the ElementLease
 * type — so the bridge doesn't import core/v4 (avoids a cycle with browserState).
 */
export interface LeaseTarget {
  ref?:      string;
  role:      string;
  name:      string;
  css_path:  string;
  frame_id:  string;
}

// B4.2b — bounded frame DAG so ad-heavy pages can't blow up the snapshot.
const MAX_FRAMES = 30
const MAX_FRAME_DEPTH = 2

/** Nesting depth of a Playwright Frame (main = 0, iframe-in-main = 1, …). */
function frameDepth(frame: any): number {
  let d = 0
  let f = frame
  try { while (f && typeof f.parentFrame === 'function' && f.parentFrame()) { d += 1; f = f.parentFrame() } } catch { /* detached */ }
  return d
}

/**
 * v4.12 B4.2b — UNIFIED frame addressing: frame_id is the index into
 * page.frames() (the SAME scheme pwAxSnapshot tags), so a lease generated in
 * frame N resolves to that exact Frame here — works cross-origin (OOPIF) because
 * Frame.getByRole/locator operate in the frame's own context. 'main' → the page
 * (its main frame). Read fresh each call → no manual swap/detach handling.
 */
function scopeForFrame(page: any, frameId: string): any {
  if (!frameId || frameId === 'main') return page
  const m = /^frame-(\d+)$/.exec(frameId)
  if (!m) return page
  const idx = parseInt(m[1], 10)
  const frames = page.frames() as any[]
  return frames[idx] ?? page
}

export async function pwActByLease(
  lease: LeaseTarget,
  action: { kind: 'click' } | { kind: 'fill'; text: string },
): Promise<{ ok: boolean; verified?: boolean; value?: string; checked?: boolean; error?: string }> {
  activeDialogSupervisor().arm()
  const available = await checkPwAvailable()
  if (!available) return { ok: false, error: PLAYWRIGHT_MISSING_ERROR }
  const release = await pwAcquire()
  try {
    const page  = await ensurePage()
    assertControlledTab(page)
    const scope = scopeForFrame(page, lease.frame_id)

    // Primary: semantic getByRole(role, {name}). Use it only on an unambiguous
    // single match; empty/ambiguous → css_path fallback.
    let locator: any = null
    if (lease.role && lease.role !== 'generic' && lease.name) {
      try {
        const byRole = scope.getByRole(lease.role, { name: lease.name, exact: true })
        const count  = await byRole.count()
        if (count === 1) locator = byRole.first()
      } catch { /* role query unsupported → fall through to css */ }
    }
    if (!locator && lease.css_path) locator = scope.locator(lease.css_path).first()
    if (!locator) {
      return { ok: false, error: `Could not resolve ${lease.ref ?? 'element'} (role=${lease.role} name="${lease.name}")` }
    }

    if (action.kind === 'click') {
      await locator.click({ timeout: 5000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
      let checked: boolean | undefined
      try { checked = await locator.isChecked() as boolean } catch { /* not a checkable control */ }
      return { ok: true, verified: checked === undefined ? undefined : true, ...(checked === undefined ? {} : { checked }) }
    } else {
      await locator.fill(action.text, { timeout: 5000 })
      const value = await locator.inputValue()
      if (value !== action.text) return { ok: false, verified: false, value, error: 'Input value did not match after fill' }
      return { ok: true, verified: true, value }
    }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { release() }
}

// ── v4.3 Phase 4 — multi-tab snapshot ─────────────────────────────────────
//
// Persistent context can hold many pages (target=_blank, window.open,
// CDP popups). Aiden's tools still target `_activePage` only — Phase 4
// is DATA-ONLY: it records what tabs exist, who opened whom, and which
// is the active one, so v4.4+ cross-tab orchestration has a foundation.
//
// `_tabIdMap` is a WeakMap that assigns each observed Page a stable
// `tab_id` (`tab-1`, `tab-2`, ...). When a Page closes, Playwright drops
// its reference and the WeakMap entry GCs naturally — no manual cleanup.

const _tabIdMap = new WeakMap<object, string>()
let _nextTabIdCounter = 0

function getOrAssignTabId(page: any): string {
  let id = _tabIdMap.get(page)
  if (!id) {
    _nextTabIdCounter += 1
    id = `tab-${_nextTabIdCounter}`
    _tabIdMap.set(page, id)
  }
  return id
}

/**
 * v4.3 Phase 4 — enumerate all pages in the persistent context and
 * return their wire-data form. Stable `tab_id` per Page via the
 * `_tabIdMap` WeakMap. The opener Page is looked up the same way, so
 * `opener_id` is stable across reconciliations as long as the parent
 * still exists.
 *
 * Cheap — `context.pages()` is in-process; the per-page work is one
 * `url()` getter and one async `title()` call. Total cost scales
 * linearly with the number of tabs; for typical sessions (1-5 tabs)
 * it's well under 50ms.
 *
 * Returns `ok: false` when the browser is closed. Caller (BrowserState
 * .reconcileTabs) treats `ok: false` as "no reconciliation this cycle".
 */
export async function pwSnapshotTabs(): Promise<{
  ok:    boolean;
  tabs?: Array<{
    tab_id:    string;
    url:       string;
    title:     string;
    is_active: boolean;
    opener_id: string | null;
  }>;
  error?: string;
}> {
  try {
    const durableScope = currentBrowserExecutionScope()
    if (durableScope) {
      await ensurePage()
      await refreshTabMeta()
      return {
        ok: true,
        tabs: getTabRegistry().list(durableScope.session.browserSessionId).map((tab) => ({
          tab_id: tab.tab_id,
          url: tab.url,
          title: tab.title,
          is_active: tab.controlled,
          opener_id: tab.opener_id,
        })),
      }
    }
    const ctx   = await ensureContext()
    const pages = ctx.pages() as any[]
    const tabs: Array<{
      tab_id:    string;
      url:       string;
      title:     string;
      is_active: boolean;
      opener_id: string | null;
    }> = []
    for (const p of pages) {
      // Skip pages already closed mid-walk (rare race).
      if (typeof p.isClosed === 'function' && p.isClosed()) continue
      const tab_id   = getOrAssignTabId(p)
      const url      = (typeof p.url === 'function') ? (p.url() as string) : ''
      // title() can throw if the page navigated mid-walk; default to empty.
      let title = ''
      try { title = await p.title() as string } catch { /* defensive */ }
      // opener() returns the parent Page (or null). Same WeakMap lookup.
      let opener_id: string | null = null
      try {
        const opener = typeof p.opener === 'function' ? await p.opener() : null
        if (opener) opener_id = _tabIdMap.get(opener) ?? null
      } catch { /* defensive */ }
      tabs.push({
        tab_id,
        url,
        title,
        is_active: p === _activePage,
        opener_id,
      })
    }
    return { ok: true, tabs }
  } catch (e: any) { return { ok: false, error: e.message } }
}

/** Return the URL currently loaded in the active browser page. */
export async function pwGetUrl(): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    if (currentBrowserExecutionScope()) {
      const page = await ensurePage()
      return { ok: true, url: page.url() }
    }
    if (!_activePage || _activePage.isClosed()) {
      const ctx   = await ensureContext()
      const pages = ctx.pages() as any[]
      if (pages.length === 0) return { ok: false, error: 'No browser page open. Use open_browser first.' }
      _activePage = pages[pages.length - 1]
    }
    return { ok: true, url: _activePage.url() }
  } catch (e: any) { return { ok: false, error: e.message } }
}

/** Close the browser context and release all resources (call on server shutdown). */
export async function pwClose(): Promise<void> {
  const scope = currentBrowserExecutionScope()
  if (scope) {
    const registry = getTabRegistry()
    const ownedTabs = registry.list(scope.session.browserSessionId)
      .filter((tab) => tab.createdBy === 'aiden')
    for (const tab of ownedTabs) {
      const page = registry.pageById(tab.tab_id) as any
      if (!page || (page.isClosed && page.isClosed())) continue
      if (!scope.authority.canCloseTab(scope.binding, tab.tab_id)) continue
      try { await page.close() } catch {}
      registry.remove(page)
      if (page === _controlledPage) _controlledPage = null
      if (page === _activePage) _activePage = null
    }
    _sessionPages.delete(scope.session.browserSessionId)
    getDialogSupervisor(scope.session.browserSessionId).clear()
    return
  }
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
  if (_mode === 'attached') {
    // ★ Never close the user's Chrome — detach (disconnect) instead.
    await pwDetach()
    return
  }
  if (_browserContext) {
    try { await _browserContext.close() } catch {}
    _browserContext = null
    _activePage     = null
    _sessionPages.clear()
    clearDialogSupervisors()
    console.log('[Browser] Closed on shutdown')
  }
}

/**
 * Terminal lifecycle cleanup for one durable Browser Session. This is not an
 * action path: it can run after the Job has become terminal, so it relies on
 * the session-scoped registry ownership recorded when pages were created.
 * User-created tabs and tabs owned by any other session are never closed.
 */
export async function pwCloseBrowserSessionResources(browserSessionId: string): Promise<void> {
  const registry = getTabRegistry()
  const ownedTabs = registry.list(browserSessionId).filter((tab) => tab.createdBy === 'aiden')
  for (const tab of ownedTabs) {
    const page = registry.pageById(tab.tab_id) as any
    if (!page || (page.isClosed && page.isClosed())) continue
    try { await page.close() } catch {}
    registry.remove(page)
    if (page === _controlledPage) _controlledPage = null
    if (page === _activePage) _activePage = null
  }
  _sessionPages.delete(browserSessionId)
  clearLeaseStore(browserSessionId)
  getDialogSupervisor(browserSessionId).clear()
}

/** Expose active page for legacy callers that still need it. */
export function getActiveBrowserPage(): any { return _activePage }
