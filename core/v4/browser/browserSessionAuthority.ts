/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Db } from '../daemon/db/connection';
import type { JobProofAuthority } from '../daemon/jobProofAuthority';
import { normalizeUrl } from '../browserState';

export type BrowserSessionMode = 'owned' | 'attached';
export type BrowserSessionState =
  | 'initializing' | 'ready' | 'user_control_required' | 'user_control'
  | 'reconciling' | 'closing' | 'closed' | 'lost' | 'failed' | 'cancelled';

export type BrowserActionOutcome =
  | 'returned' | 'verified' | 'failed' | 'unknown' | 'reconciling'
  | 'not_applied' | 'cancelled';

export type BrowserAuthorityErrorCode =
  | 'SESSION_NOT_AUTHORIZED'
  | 'SESSION_NOT_ACTIONABLE'
  | 'SESSION_LOST'
  | 'TAB_NOT_OWNED'
  | 'TAB_NOT_CLOSEABLE'
  | 'ACTION_CANCELLED'
  | 'BUDGET_EXHAUSTED'
  | 'NO_PROGRESS'
  | 'FRESH_OBSERVATION_REQUIRED'
  | 'ACTION_NOT_FOUND';

export class BrowserAuthorityError extends Error {
  constructor(readonly code: BrowserAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'BrowserAuthorityError';
  }
}

export interface BrowserSessionBinding {
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  workspaceId?: string | null;
  mode?: BrowserSessionMode;
  profileIdentity?: string;
}

export interface BrowserBudgetPolicy {
  navigations: number;
  mutations: number;
  snapshots: number;
  screenshots: number;
  uploads: number;
  downloads: number;
  tabs: number;
  zeroProgress: number;
  elapsedMs: number;
  observationBytes: number;
}

export interface BrowserUsage {
  navigations: number;
  mutations: number;
  snapshots: number;
  screenshots: number;
  uploads: number;
  downloads: number;
  tabs: number;
  zeroProgress: number;
  observationBytes: number;
  startedAt: number;
}

export interface BrowserSessionRecord {
  browserSessionId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  workspaceId: string | null;
  mode: BrowserSessionMode;
  profileIdentity: string;
  state: BrowserSessionState;
  controlledTabId: string | null;
  recoveryState: string;
  leaseEpoch: number;
  usage: BrowserUsage;
  budget: BrowserBudgetPolicy;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface BrowserTabRecord {
  browserSessionId: string;
  tabId: string;
  ownerJobId: string;
  ownerAttemptId: string;
  ownerGeneration: number;
  createdBy: 'aiden' | 'user';
  controlled: boolean;
  openerTabId: string | null;
  purpose: string | null;
  url: string;
  normalizedUrl: string;
  title: string;
  dirtyForm: boolean;
  lastStateDigest: string | null;
  lastObservedAt: number | null;
  lastEvidenceAt: number | null;
  closePolicy: 'aiden_owned' | 'user_owned';
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface BrowserActionReceipt {
  actionId: string;
  browserSessionId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  actionSequence: number;
  toolCallId: string | null;
  effectId: string | null;
  tabId: string | null;
  actionType: string;
  actionSignature: string;
  state: string;
  commandOk: boolean | null;
  semanticOk: boolean | null;
  preStateDigest: string | null;
  postStateDigest: string | null;
  verification: unknown;
  evidenceIds: string[];
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserSessionAuthority {
  ensureSession(binding: BrowserSessionBinding): BrowserSessionRecord;
  getSession(browserSessionId: string): BrowserSessionRecord | null;
  getSessionForAttempt(jobId: string, attemptId: string, generation: number): BrowserSessionRecord | null;
  getAction(actionId: string): BrowserActionReceipt | null;
  listUnresolvedActions(jobId: string): BrowserActionReceipt[];
  assertActionable(binding: BrowserSessionBinding, tabId?: string | null): BrowserSessionRecord;
  bindTab(binding: BrowserSessionBinding, tab: {
    tabId: string; createdBy: 'aiden' | 'user'; controlled: boolean;
    openerTabId: string | null; purpose?: string | null; url?: string; title?: string;
  }): BrowserTabRecord;
  listTabs(browserSessionId: string): BrowserTabRecord[];
  setControlledTab(binding: BrowserSessionBinding, tabId: string): BrowserTabRecord;
  canCloseTab(binding: BrowserSessionBinding, tabId: string): boolean;
  markTabClosed(binding: BrowserSessionBinding, tabId: string): void;
  recordObservation(binding: BrowserSessionBinding, observation: {
    tabId: string; url: string; title: string; stateDigest: string;
    informationDigest?: string | null; purpose?: string | null; byteLength?: number;
  }): BrowserTabRecord;
  canRepeatNavigation(binding: BrowserSessionBinding, normalizedUrl: string, expectedInformationDigest?: string | null): boolean;
  beginAction(binding: BrowserSessionBinding, command: {
    toolCallId: string | null; effectId: string | null; tabId: string | null;
    actionType: string; args: Record<string, unknown>; expectedOutcome?: unknown;
    preStateDigest?: string | null;
  }): BrowserActionReceipt;
  markActionDispatched(binding: BrowserSessionBinding, actionId: string): BrowserActionReceipt;
  completeAction(binding: BrowserSessionBinding, actionId: string, result: {
    outcome: BrowserActionOutcome; commandOk: boolean; semanticOk: boolean | null;
    postStateDigest: string | null; verification: unknown; evidencePayload: unknown;
    errorCode?: string | null;
  }): { applied: boolean; late: boolean; receipt: BrowserActionReceipt };
  reconcileAction(binding: BrowserSessionBinding, actionId: string, resolution: {
    outcome: 'verified' | 'not_applied' | 'unknown'; verification: unknown; evidencePayload: unknown;
  }): { applied: boolean; receipt: BrowserActionReceipt };
  reconcilePriorAction(binding: BrowserSessionBinding, actionId: string, resolution: {
    outcome: 'verified' | 'not_applied' | 'unknown'; verification: unknown; evidencePayload: unknown;
  }): { applied: boolean; receipt: BrowserActionReceipt };
  requireUserControl(binding: BrowserSessionBinding, reason: string): BrowserSessionRecord;
  takeUserControl(binding: BrowserSessionBinding): BrowserSessionRecord;
  returnControl(binding: BrowserSessionBinding): BrowserSessionRecord;
  cancelSession(browserSessionId: string, reason: string): BrowserSessionRecord;
  closeSession(binding: BrowserSessionBinding, reason: string): BrowserSessionRecord;
  settleSession(
    binding: BrowserSessionBinding,
    state: 'closed' | 'cancelled' | 'lost' | 'failed',
    reason: string,
  ): BrowserSessionRecord;
}

interface SessionRow {
  browser_session_id: string; job_id: string; attempt_id: string; generation: number;
  fence_digest: string;
  workspace_id: string | null; mode: BrowserSessionMode; profile_identity: string;
  state: BrowserSessionState; controlled_tab_id: string | null; recovery_state: string;
  lease_epoch: number; usage_json: string; budget_json: string;
  created_at: number; updated_at: number; closed_at: number | null;
}

interface TabRow {
  browser_session_id: string; tab_id: string; owner_job_id: string; owner_attempt_id: string;
  owner_generation: number; created_by: 'aiden' | 'user'; controlled: number;
  opener_tab_id: string | null; purpose: string | null; url: string; normalized_url: string;
  title: string; dirty_form: number; last_state_digest: string | null;
  last_observed_at: number | null; last_evidence_at: number | null;
  close_policy: 'aiden_owned' | 'user_owned'; created_at: number; updated_at: number;
  closed_at: number | null;
}

interface ReceiptRow {
  action_id: string; browser_session_id: string; job_id: string; attempt_id: string;
  generation: number; action_sequence: number; tool_call_id: string | null; effect_id: string | null; tab_id: string | null;
  action_type: string; action_signature: string; state: string; command_ok: number | null;
  semantic_ok: number | null; pre_state_digest: string | null; post_state_digest: string | null;
  verification_json: string | null; evidence_ids_json: string; error_code: string | null;
  created_at: number; updated_at: number;
}

const ACTIVE_SESSION_STATES = new Set<BrowserSessionState>(['initializing', 'ready', 'reconciling']);
const TERMINAL_JOB_STATES = new Set(['cancelled', 'completed', 'failed', 'dead_letter', 'completed_unverified', 'verification_failed', 'abandoned']);
const TERMINAL_ATTEMPT_STATES = new Set(['succeeded', 'completed', 'failed', 'cancelled', 'timed_out', 'crashed', 'unknown', 'interrupted']);

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function boundedInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function defaultBudget(): BrowserBudgetPolicy {
  return {
    navigations: boundedInt('AIDEN_BROWSER_MAX_NAVIGATIONS', 80),
    mutations: boundedInt('AIDEN_BROWSER_MAX_MUTATIONS', 120),
    snapshots: boundedInt('AIDEN_BROWSER_MAX_SNAPSHOTS', 240),
    screenshots: boundedInt('AIDEN_BROWSER_MAX_SCREENSHOTS', 40),
    uploads: boundedInt('AIDEN_BROWSER_MAX_UPLOADS', 20),
    downloads: boundedInt('AIDEN_BROWSER_MAX_DOWNLOADS', 20),
    tabs: boundedInt('AIDEN_BROWSER_MAX_TABS', 8),
    zeroProgress: boundedInt('AIDEN_BROWSER_MAX_ZERO_PROGRESS', 8),
    elapsedMs: boundedInt('AIDEN_BROWSER_MAX_ELAPSED_MS', 20 * 60_000),
    observationBytes: boundedInt('AIDEN_BROWSER_MAX_OBSERVATION_BYTES', 4 * 1024 * 1024),
  };
}

function initialUsage(now: number): BrowserUsage {
  return {
    navigations: 0, mutations: 0, snapshots: 0, screenshots: 0,
    uploads: 0, downloads: 0, tabs: 0, zeroProgress: 0,
    observationBytes: 0, startedAt: now,
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function mapSession(row: SessionRow): BrowserSessionRecord {
  return {
    browserSessionId: row.browser_session_id, jobId: row.job_id, attemptId: row.attempt_id,
    generation: row.generation, workspaceId: row.workspace_id, mode: row.mode,
    profileIdentity: row.profile_identity, state: row.state, controlledTabId: row.controlled_tab_id,
    recoveryState: row.recovery_state, leaseEpoch: row.lease_epoch,
    usage: parseJson(row.usage_json, initialUsage(row.created_at)),
    budget: parseJson(row.budget_json, defaultBudget()), createdAt: row.created_at,
    updatedAt: row.updated_at, closedAt: row.closed_at,
  };
}

function mapTab(row: TabRow): BrowserTabRecord {
  return {
    browserSessionId: row.browser_session_id, tabId: row.tab_id, ownerJobId: row.owner_job_id,
    ownerAttemptId: row.owner_attempt_id, ownerGeneration: row.owner_generation,
    createdBy: row.created_by, controlled: row.controlled === 1, openerTabId: row.opener_tab_id,
    purpose: row.purpose, url: row.url, normalizedUrl: row.normalized_url, title: row.title,
    dirtyForm: row.dirty_form === 1, lastStateDigest: row.last_state_digest,
    lastObservedAt: row.last_observed_at, lastEvidenceAt: row.last_evidence_at,
    closePolicy: row.close_policy, createdAt: row.created_at, updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function mapReceipt(row: ReceiptRow): BrowserActionReceipt {
  return {
    actionId: row.action_id, browserSessionId: row.browser_session_id, jobId: row.job_id,
    attemptId: row.attempt_id, generation: row.generation, actionSequence: row.action_sequence,
    toolCallId: row.tool_call_id,
    effectId: row.effect_id, tabId: row.tab_id, actionType: row.action_type,
    actionSignature: row.action_signature, state: row.state,
    commandOk: row.command_ok === null ? null : row.command_ok === 1,
    semanticOk: row.semantic_ok === null ? null : row.semantic_ok === 1,
    preStateDigest: row.pre_state_digest, postStateDigest: row.post_state_digest,
    verification: parseJson(row.verification_json, null),
    evidenceIds: parseJson(row.evidence_ids_json, []), errorCode: row.error_code,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|auth|password|secret|key|signature|session|credential)/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch { return raw.slice(0, 2_000); }
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (/(?:password|passwd|token|cookie|authorization|secret|credential|otp|2fa)/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([nestedKey, nested]) => [nestedKey, sanitize(nested, nestedKey, depth + 1)]));
  }
  if (typeof value === 'string') {
    if (/^https?:/i.test(value)) return safeUrl(value);
    return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  }
  return value;
}

function actionMetric(actionType: string): keyof BrowserUsage | null {
  if (actionType === 'browser_navigate') return 'navigations';
  if (actionType === 'browser_snapshot' || actionType === 'browser_extract' || actionType === 'browser_see') return 'snapshots';
  if (actionType === 'browser_screenshot') return 'screenshots';
  if (actionType === 'browser_upload') return 'uploads';
  if (actionType === 'browser_download') return 'downloads';
  if (['browser_click', 'browser_type', 'browser_fill', 'browser_control', 'browser_dialog', 'browser_close'].includes(actionType)) return 'mutations';
  return null;
}

const MUTATING_BROWSER_ACTIONS = new Set([
  'browser_navigate', 'browser_click', 'browser_type', 'browser_fill',
  'browser_scroll', 'browser_close', 'browser_dialog', 'browser_upload',
  'browser_control', 'browser_download',
]);

export function createBrowserSessionAuthority(options: {
  db: Db;
  proof: JobProofAuthority;
  recordEffectReconciliation?: (command: {
    effectId: string; expectedJobStateVersion: number;
    outcome: 'occurred' | 'did_not_occur' | 'unknown';
    confidence: 'high' | 'medium' | 'low'; evidence: Record<string, unknown>;
    retryRecommendation: 'retry_same_identity' | 'do_not_retry' | 'human_review';
    humanResolutionRequired: boolean; producer: string; idempotencyKey: string;
  }) => { applied: boolean; duplicate?: boolean };
}): BrowserSessionAuthority {
  const { db, proof } = options;

  const sessionRow = (id: string): SessionRow | undefined => db.prepare(
    'SELECT * FROM browser_sessions WHERE browser_session_id=?',
  ).get(id) as SessionRow | undefined;
  const sessionForAttempt = (jobId: string, attemptId: string, generation: number): SessionRow | undefined => db.prepare(
    'SELECT * FROM browser_sessions WHERE job_id=? AND attempt_id=? AND generation=?',
  ).get(jobId, attemptId, generation) as SessionRow | undefined;
  const tabRow = (sessionId: string, tabId: string): TabRow | undefined => db.prepare(
    'SELECT * FROM browser_tabs WHERE browser_session_id=? AND tab_id=?',
  ).get(sessionId, tabId) as TabRow | undefined;
  const receiptRow = (actionId: string): ReceiptRow | undefined => db.prepare(
    'SELECT * FROM browser_action_receipts WHERE action_id=?',
  ).get(actionId) as ReceiptRow | undefined;

  const assertBinding = (binding: BrowserSessionBinding): {
    session?: SessionRow; workspaceId: string | null;
  } => {
    const row = db.prepare(
      `SELECT t.status AS job_status,t.active_attempt_id,t.workspace_id,
              r.status AS attempt_status,r.generation,r.fence_token,r.lease_expires_at
         FROM tasks t JOIN runs r ON r.task_id=t.id
        WHERE t.id=? AND r.attempt_id=?`,
    ).get(binding.jobId, binding.attemptId) as {
      job_status: string; active_attempt_id: string | null; workspace_id: string | null;
      attempt_status: string; generation: number; fence_token: string | null;
      lease_expires_at: number | null;
    } | undefined;
    const workspaceId = binding.workspaceId ?? row?.workspace_id ?? null;
    if (!row
      || row.active_attempt_id !== binding.attemptId
      || row.generation !== binding.generation
      || row.fence_token !== binding.fenceToken
      || row.lease_expires_at === null
      || row.lease_expires_at <= Date.now()
      || TERMINAL_JOB_STATES.has(row.job_status)
      || TERMINAL_ATTEMPT_STATES.has(row.attempt_status)
      || (binding.workspaceId !== undefined && binding.workspaceId !== null
        && row.workspace_id !== null && row.workspace_id !== binding.workspaceId)) {
      throw new BrowserAuthorityError('SESSION_NOT_AUTHORIZED', 'Browser authority does not match the active Job Attempt');
    }
    return { session: sessionForAttempt(binding.jobId, binding.attemptId, binding.generation), workspaceId };
  };

  const updateSessionUsage = (row: SessionRow, usage: BrowserUsage): void => {
    db.prepare('UPDATE browser_sessions SET usage_json=?,updated_at=? WHERE browser_session_id=?')
      .run(JSON.stringify(usage), Date.now(), row.browser_session_id);
  };

  const assertBudget = (row: SessionRow, metric: keyof BrowserUsage | null): void => {
    const session = mapSession(row);
    if (Date.now() - session.usage.startedAt > session.budget.elapsedMs) {
      throw new BrowserAuthorityError('BUDGET_EXHAUSTED', 'Browser elapsed-time budget exhausted');
    }
    if (session.usage.observationBytes > session.budget.observationBytes) {
      throw new BrowserAuthorityError('BUDGET_EXHAUSTED', 'Browser observation budget exhausted');
    }
    if (session.usage.zeroProgress >= session.budget.zeroProgress) {
      throw new BrowserAuthorityError('BUDGET_EXHAUSTED', 'Browser no-progress budget exhausted');
    }
    if (metric && metric !== 'startedAt' && metric !== 'observationBytes' && metric !== 'zeroProgress') {
      const limit = session.budget[metric as keyof BrowserBudgetPolicy];
      const used = session.usage[metric] as number;
      if (typeof limit === 'number' && used >= limit) {
        throw new BrowserAuthorityError('BUDGET_EXHAUSTED', `Browser ${metric} budget exhausted`);
      }
    }
  };

  const authority: BrowserSessionAuthority = {
    ensureSession(binding) {
      const checked = assertBinding(binding);
      if (checked.session) {
        if (!ACTIVE_SESSION_STATES.has(checked.session.state)) {
          throw new BrowserAuthorityError('SESSION_NOT_ACTIONABLE', `Browser session is ${checked.session.state}`);
        }
        return mapSession(checked.session);
      }
      const now = Date.now();
      const browserSessionId = `browser_session_${hash(`${binding.jobId}\0${binding.attemptId}\0${binding.generation}`).slice(0, 24)}`;
      const mode = binding.mode ?? 'owned';
      const profileIdentity = binding.profileIdentity ?? (mode === 'owned' ? 'aiden-default' : 'attached-user');
      const unresolvedPrior = (db.prepare(
        `SELECT COUNT(*) AS count FROM browser_action_receipts
          WHERE job_id=? AND generation<? AND state IN ('dispatched','unknown','reconciling')`,
      ).get(binding.jobId, binding.generation) as { count: number }).count > 0;
      const initialState: BrowserSessionState = unresolvedPrior ? 'reconciling' : 'ready';
      const recoveryState = unresolvedPrior ? 'reconcile_prior_unknown_actions' : 'none';
      db.transaction(() => {
        db.prepare(
          `UPDATE browser_sessions
              SET state='lost',recovery_state='superseded',controlled_tab_id=NULL,
                  lease_epoch=lease_epoch+1,updated_at=?,closed_at=COALESCE(closed_at,?)
            WHERE job_id=? AND state NOT IN ('closed','lost','failed','cancelled')`,
        ).run(now, now, binding.jobId);
        db.prepare(
          `INSERT INTO browser_sessions (
             browser_session_id,job_id,attempt_id,generation,fence_digest,workspace_id,
             mode,profile_identity,state,recovery_state,usage_json,budget_json,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          browserSessionId, binding.jobId, binding.attemptId, binding.generation,
          hash(binding.fenceToken), checked.workspaceId, mode, profileIdentity, initialState, recoveryState,
          JSON.stringify(initialUsage(now)), JSON.stringify(defaultBudget()), now, now,
        );
      }).immediate();
      return mapSession(sessionRow(browserSessionId)!);
    },

    getSession(browserSessionId) {
      const row = sessionRow(browserSessionId);
      return row ? mapSession(row) : null;
    },

    getSessionForAttempt(jobId, attemptId, generation) {
      const row = sessionForAttempt(jobId, attemptId, generation);
      return row ? mapSession(row) : null;
    },

    getAction(actionId) {
      const row = receiptRow(actionId);
      return row ? mapReceipt(row) : null;
    },

    listUnresolvedActions(jobId) {
      return (db.prepare(
        `SELECT * FROM browser_action_receipts
          WHERE job_id=? AND state IN ('dispatched','unknown','reconciling')
          ORDER BY generation,action_sequence`,
      ).all(jobId) as ReceiptRow[]).map(mapReceipt);
    },

    assertActionable(binding, tabId) {
      const checked = assertBinding(binding);
      if (!checked.session) throw new BrowserAuthorityError('SESSION_LOST', 'Browser session has not been established');
      if (!ACTIVE_SESSION_STATES.has(checked.session.state)) {
        const code = checked.session.state === 'cancelled' ? 'ACTION_CANCELLED' : 'SESSION_NOT_ACTIONABLE';
        throw new BrowserAuthorityError(code, `Browser session is ${checked.session.state}`);
      }
      assertBudget(checked.session, null);
      if (tabId) {
        const tab = tabRow(checked.session.browser_session_id, tabId);
        if (!tab || tab.closed_at !== null || tab.owner_job_id !== binding.jobId
          || tab.owner_attempt_id !== binding.attemptId || tab.owner_generation !== binding.generation) {
          throw new BrowserAuthorityError('TAB_NOT_OWNED', 'Browser tab does not belong to the active Job Attempt');
        }
      }
      return mapSession(checked.session);
    },

    bindTab(binding, tab) {
      const session = authority.assertActionable(binding);
      const existingOther = db.prepare(
        `SELECT browser_session_id FROM browser_tabs
          WHERE tab_id=? AND browser_session_id<>? AND closed_at IS NULL LIMIT 1`,
      ).get(tab.tabId, session.browserSessionId) as { browser_session_id: string } | undefined;
      if (existingOther) throw new BrowserAuthorityError('TAB_NOT_OWNED', 'Browser tab is already owned by another session');
      const row = sessionRow(session.browserSessionId)!;
      const now = Date.now();
      const existing = tabRow(session.browserSessionId, tab.tabId);
      if (!existing) assertBudget(row, 'tabs');
      db.transaction(() => {
        if (tab.controlled) {
          db.prepare('UPDATE browser_tabs SET controlled=0,updated_at=? WHERE browser_session_id=? AND controlled=1')
            .run(now, session.browserSessionId);
        }
        if (!existing) {
          db.prepare(
            `INSERT INTO browser_tabs (
               browser_session_id,tab_id,owner_job_id,owner_attempt_id,owner_generation,
               created_by,controlled,opener_tab_id,purpose,url,normalized_url,title,
               close_policy,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            session.browserSessionId, tab.tabId, binding.jobId, binding.attemptId, binding.generation,
            tab.createdBy, tab.controlled ? 1 : 0, tab.openerTabId, tab.purpose ?? null,
            safeUrl(tab.url ?? ''), tab.url ? normalizeUrl(safeUrl(tab.url)) : '', tab.title ?? '',
            tab.createdBy === 'aiden' ? 'aiden_owned' : 'user_owned', now, now,
          );
          const usage = mapSession(row).usage;
          usage.tabs += 1;
          updateSessionUsage(row, usage);
        } else {
          db.prepare(
            `UPDATE browser_tabs SET created_by=?,controlled=?,opener_tab_id=COALESCE(?,opener_tab_id),
                    purpose=COALESCE(?,purpose),url=?,normalized_url=?,title=?,updated_at=?,closed_at=NULL
              WHERE browser_session_id=? AND tab_id=?`,
          ).run(
            existing.created_by === 'aiden' ? 'aiden' : tab.createdBy,
            tab.controlled ? 1 : 0, tab.openerTabId, tab.purpose ?? null,
            safeUrl(tab.url ?? existing.url), normalizeUrl(safeUrl(tab.url ?? existing.url)),
            tab.title ?? existing.title, now, session.browserSessionId, tab.tabId,
          );
        }
        if (tab.controlled) db.prepare(
          'UPDATE browser_sessions SET controlled_tab_id=?,updated_at=? WHERE browser_session_id=?',
        ).run(tab.tabId, now, session.browserSessionId);
      }).immediate();
      return mapTab(tabRow(session.browserSessionId, tab.tabId)!);
    },

    listTabs(browserSessionId) {
      return (db.prepare(
        'SELECT * FROM browser_tabs WHERE browser_session_id=? ORDER BY created_at,tab_id',
      ).all(browserSessionId) as TabRow[]).map(mapTab);
    },

    setControlledTab(binding, tabId) {
      const session = authority.assertActionable(binding, tabId);
      const now = Date.now();
      db.transaction(() => {
        db.prepare('UPDATE browser_tabs SET controlled=0,updated_at=? WHERE browser_session_id=? AND controlled=1')
          .run(now, session.browserSessionId);
        db.prepare('UPDATE browser_tabs SET controlled=1,updated_at=? WHERE browser_session_id=? AND tab_id=? AND closed_at IS NULL')
          .run(now, session.browserSessionId, tabId);
        db.prepare('UPDATE browser_sessions SET controlled_tab_id=?,lease_epoch=lease_epoch+1,updated_at=? WHERE browser_session_id=?')
          .run(tabId, now, session.browserSessionId);
      }).immediate();
      return mapTab(tabRow(session.browserSessionId, tabId)!);
    },

    canCloseTab(binding, tabId) {
      const session = authority.assertActionable(binding, tabId);
      return tabRow(session.browserSessionId, tabId)?.close_policy === 'aiden_owned';
    },

    markTabClosed(binding, tabId) {
      const session = authority.assertActionable(binding, tabId);
      if (!authority.canCloseTab(binding, tabId)) {
        throw new BrowserAuthorityError('TAB_NOT_CLOSEABLE', 'User-owned browser tabs cannot be closed');
      }
      const now = Date.now();
      db.transaction(() => {
        db.prepare('UPDATE browser_tabs SET controlled=0,closed_at=?,updated_at=? WHERE browser_session_id=? AND tab_id=?')
          .run(now, now, session.browserSessionId, tabId);
        db.prepare(
          `UPDATE browser_sessions SET controlled_tab_id=CASE WHEN controlled_tab_id=? THEN NULL ELSE controlled_tab_id END,
                  lease_epoch=lease_epoch+1,updated_at=? WHERE browser_session_id=?`,
        ).run(tabId, now, session.browserSessionId);
      }).immediate();
    },

    recordObservation(binding, observation) {
      const session = authority.assertActionable(binding, observation.tabId);
      const row = sessionRow(session.browserSessionId)!;
      const usage = mapSession(row).usage;
      usage.snapshots += 1;
      usage.observationBytes += Math.max(0, observation.byteLength ?? 0);
      assertBudget(row, 'snapshots');
      const now = Date.now();
      const sanitizedUrl = safeUrl(observation.url);
      const normalized = normalizeUrl(sanitizedUrl);
      db.transaction(() => {
        db.prepare(
          `UPDATE browser_tabs SET url=?,normalized_url=?,title=?,last_state_digest=?,last_observed_at=?,updated_at=?
            WHERE browser_session_id=? AND tab_id=?`,
        ).run(sanitizedUrl, normalized, observation.title.slice(0, 1_000), observation.stateDigest, now, now,
          session.browserSessionId, observation.tabId);
        db.prepare(
          `INSERT INTO browser_navigation_history (
             browser_session_id,tab_id,normalized_url,purpose,state_digest,information_digest,observed_at
           ) VALUES (?,?,?,?,?,?,?)`,
        ).run(session.browserSessionId, observation.tabId, normalized, observation.purpose ?? null,
          observation.stateDigest, observation.informationDigest ?? null, now);
        updateSessionUsage(row, usage);
        if (row.state === 'reconciling' && row.recovery_state === 'fresh_observation_required') {
          db.prepare("UPDATE browser_sessions SET state='ready',recovery_state='none',updated_at=? WHERE browser_session_id=?")
            .run(now, session.browserSessionId);
        }
      }).immediate();
      return mapTab(tabRow(session.browserSessionId, observation.tabId)!);
    },

    canRepeatNavigation(binding, normalizedUrl, expectedInformationDigest = null) {
      const session = authority.assertActionable(binding);
      const row = db.prepare(
        `SELECT information_digest FROM browser_navigation_history
          WHERE browser_session_id=? AND normalized_url=?
          ORDER BY observed_at DESC,navigation_sequence DESC LIMIT 1`,
      ).get(session.browserSessionId, normalizeUrl(safeUrl(normalizedUrl))) as { information_digest: string | null } | undefined;
      if (!row) return true;
      return expectedInformationDigest !== null && row.information_digest !== expectedInformationDigest;
    },

    beginAction(binding, command) {
      const session = authority.assertActionable(binding, command.tabId);
      if (MUTATING_BROWSER_ACTIONS.has(command.actionType) && !command.preStateDigest) {
        throw new BrowserAuthorityError(
          'FRESH_OBSERVATION_REQUIRED',
          'A fresh browser observation is required before this action',
        );
      }
      if (session.state === 'reconciling') {
        throw new BrowserAuthorityError('SESSION_NOT_ACTIONABLE', `Browser session requires reconciliation: ${session.recoveryState}`);
      }
      const row = sessionRow(session.browserSessionId)!;
      const metric = actionMetric(command.actionType);
      assertBudget(row, metric);
      const argsDigest = hash(sanitize(command.args));
      const actionSignature = hash({
        tabId: command.tabId, actionType: command.actionType, argsDigest,
        preStateDigest: command.preStateDigest ?? null,
      });
      const repeated = db.prepare(
        `SELECT action_id FROM browser_action_receipts
          WHERE browser_session_id=? AND action_signature=?
            AND semantic_ok=0 AND state IN ('returned','failed','not_applied')
          ORDER BY created_at DESC LIMIT 1`,
      ).get(session.browserSessionId, actionSignature) as { action_id: string } | undefined;
      if (repeated) throw new BrowserAuthorityError('NO_PROGRESS', 'Repeated browser action produced no progress');
      const now = Date.now();
      const sequence = (db.prepare(
        'SELECT COALESCE(MAX(action_sequence),0)+1 AS sequence FROM browser_action_receipts WHERE browser_session_id=?',
      ).get(session.browserSessionId) as { sequence: number }).sequence;
      const actionId = `browser_action_${randomBytes(12).toString('hex')}`;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO browser_action_receipts (
             action_id,browser_session_id,action_sequence,job_id,attempt_id,generation,tool_call_id,effect_id,tab_id,
             action_type,action_signature,args_digest,expected_json,state,pre_state_digest,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'prepared',?,?,?)`,
        ).run(
          actionId, session.browserSessionId, sequence, binding.jobId, binding.attemptId, binding.generation,
          command.toolCallId, command.effectId, command.tabId, command.actionType,
          actionSignature, argsDigest, JSON.stringify(sanitize(command.expectedOutcome ?? {})),
          command.preStateDigest ?? null, now, now,
        );
        if (metric) {
          const usage = mapSession(row).usage;
          if (metric !== 'startedAt' && metric !== 'observationBytes' && metric !== 'zeroProgress') {
            (usage[metric] as number) += 1;
          }
          updateSessionUsage(row, usage);
        }
      }).immediate();
      return mapReceipt(receiptRow(actionId)!);
    },

    markActionDispatched(binding, actionId) {
      authority.assertActionable(binding);
      const row = receiptRow(actionId);
      if (!row || row.job_id !== binding.jobId || row.attempt_id !== binding.attemptId || row.generation !== binding.generation) {
        throw new BrowserAuthorityError('ACTION_NOT_FOUND', 'Browser action receipt does not match the active Attempt');
      }
      if (row.state === 'dispatched') return mapReceipt(row);
      const now = Date.now();
      db.prepare("UPDATE browser_action_receipts SET state='dispatched',dispatched_at=?,updated_at=? WHERE action_id=? AND state='prepared'")
        .run(now, now, actionId);
      return mapReceipt(receiptRow(actionId)!);
    },

    completeAction(binding, actionId, result) {
      const row = receiptRow(actionId);
      if (!row) throw new BrowserAuthorityError('ACTION_NOT_FOUND', 'Browser action receipt not found');
      try {
        authority.assertActionable(binding, row.tab_id);
      } catch (error) {
        if (!(error instanceof BrowserAuthorityError)) throw error;
        const now = Date.now();
        db.prepare(
          `UPDATE browser_action_receipts SET state='stale_rejected',error_code=?,returned_at=?,updated_at=?
            WHERE action_id=? AND state NOT IN ('verified','failed','not_applied','cancelled','stale_rejected')`,
        ).run(error.code, now, now, actionId);
        return { applied: false, late: true, receipt: mapReceipt(receiptRow(actionId)!) };
      }
      if (['verified', 'failed', 'not_applied', 'cancelled', 'stale_rejected'].includes(row.state)) {
        return { applied: false, late: false, receipt: mapReceipt(row) };
      }
      const now = Date.now();
      const evidenceIds: string[] = [];
      if (result.evidencePayload !== null && result.evidencePayload !== undefined) {
        const duplicate = db.prepare(
          `SELECT evidence_ids_json FROM browser_action_receipts
            WHERE browser_session_id=? AND action_id<>? AND action_signature=?
              AND post_state_digest IS ? AND evidence_ids_json<>'[]'
            ORDER BY action_sequence DESC LIMIT 1`,
        ).get(row.browser_session_id, actionId, row.action_signature, result.postStateDigest) as {
          evidence_ids_json: string;
        } | undefined;
        if (duplicate) {
          evidenceIds.push(...(JSON.parse(duplicate.evidence_ids_json) as string[]));
        } else {
          const evidence = proof.recordEvidence({
            jobId: binding.jobId, attemptId: binding.attemptId, generation: binding.generation,
            fenceToken: binding.fenceToken, effectId: row.effect_id,
            source: `browser.${row.action_type}`, producer: 'browser-operator', observedAt: now,
            freshUntil: now + 5 * 60_000,
            coverage: result.outcome === 'unknown' || result.outcome === 'reconciling' ? 'unknown' : 'full',
            verificationResult: result.outcome === 'verified' ? 'verified'
              : result.outcome === 'failed' || result.outcome === 'not_applied' ? 'failed' : 'unknown',
            payload: sanitize({
              browserActionId: actionId,
              toolCallId: row.tool_call_id,
              tabId: row.tab_id,
              observation: result.evidencePayload,
            }),
          });
          evidenceIds.push(evidence.evidenceId);
        }
      }
      const receiptState = result.outcome;
      db.transaction(() => {
        db.prepare(
          `UPDATE browser_action_receipts SET state=?,command_ok=?,semantic_ok=?,post_state_digest=?,
                  verification_json=?,evidence_ids_json=?,error_code=?,returned_at=?,observed_at=?,updated_at=?
            WHERE action_id=?`,
        ).run(
          receiptState, result.commandOk ? 1 : 0, result.semanticOk === null ? null : result.semanticOk ? 1 : 0,
          result.postStateDigest, JSON.stringify(sanitize(result.verification)), JSON.stringify(evidenceIds),
          result.errorCode ?? null, now, now, now, actionId,
        );
        if (result.semanticOk === false) {
          const session = sessionRow(row.browser_session_id)!;
          const usage = mapSession(session).usage;
          usage.zeroProgress += 1;
          updateSessionUsage(session, usage);
        }
        if (row.tab_id && evidenceIds.length > 0) db.prepare(
          'UPDATE browser_tabs SET last_evidence_at=?,updated_at=? WHERE browser_session_id=? AND tab_id=?',
        ).run(now, now, row.browser_session_id, row.tab_id);
        if (['verified', 'returned', 'failed', 'not_applied'].includes(receiptState)) db.prepare(
          'UPDATE browser_sessions SET lease_epoch=lease_epoch+1,updated_at=? WHERE browser_session_id=?',
        ).run(now, row.browser_session_id);
      }).immediate();
      return { applied: true, late: false, receipt: mapReceipt(receiptRow(actionId)!) };
    },

    reconcileAction(binding, actionId, resolution) {
      const session = authority.assertActionable(binding);
      const row = receiptRow(actionId);
      if (!row || row.browser_session_id !== session.browserSessionId || !['dispatched', 'unknown', 'reconciling'].includes(row.state)) {
        throw new BrowserAuthorityError('ACTION_NOT_FOUND', 'Unknown browser action is not available for reconciliation');
      }
      const result = authority.completeAction(binding, actionId, {
        outcome: resolution.outcome,
        commandOk: resolution.outcome !== 'not_applied',
        semanticOk: resolution.outcome === 'verified' ? true : resolution.outcome === 'not_applied' ? false : null,
        postStateDigest: null,
        verification: resolution.verification,
        evidencePayload: resolution.evidencePayload,
        errorCode: resolution.outcome === 'unknown' ? 'ACTION_UNKNOWN' : null,
      });
      return { applied: result.applied, receipt: result.receipt };
    },

    reconcilePriorAction(binding, actionId, resolution) {
      authority.assertActionable(binding);
      const row = receiptRow(actionId);
      if (!row || row.job_id !== binding.jobId || row.generation >= binding.generation
        || !['dispatched', 'unknown', 'reconciling'].includes(row.state)) {
        throw new BrowserAuthorityError('ACTION_NOT_FOUND', 'Prior unknown browser action is not available for reconciliation');
      }
      const now = Date.now();
      const evidence = proof.recordEvidence({
        jobId: binding.jobId, attemptId: binding.attemptId, generation: binding.generation,
        fenceToken: binding.fenceToken, source: 'browser.reconciliation', producer: 'browser-operator',
        observedAt: now, freshUntil: now + 5 * 60_000, coverage: resolution.outcome === 'unknown' ? 'unknown' : 'full',
        verificationResult: resolution.outcome === 'verified' ? 'verified'
          : resolution.outcome === 'not_applied' ? 'failed' : 'unknown',
        payload: sanitize({
          priorActionId: actionId,
          priorEffectId: row.effect_id,
          observation: resolution.evidencePayload,
        }),
      });
      if (row.effect_id && options.recordEffectReconciliation) {
        const job = db.prepare('SELECT state_version FROM tasks WHERE id=?').get(binding.jobId) as { state_version: number };
        options.recordEffectReconciliation({
          effectId: row.effect_id, expectedJobStateVersion: job.state_version,
          outcome: resolution.outcome === 'verified' ? 'occurred'
            : resolution.outcome === 'not_applied' ? 'did_not_occur' : 'unknown',
          confidence: resolution.outcome === 'unknown' ? 'low' : 'high',
          evidence: { browserActionId: actionId, evidenceId: evidence.evidenceId, verification: resolution.verification },
          retryRecommendation: resolution.outcome === 'not_applied' ? 'retry_same_identity'
            : resolution.outcome === 'verified' ? 'do_not_retry' : 'human_review',
          humanResolutionRequired: resolution.outcome === 'unknown',
          producer: 'browser-operator', idempotencyKey: `browser-action:${actionId}`,
        });
      }
      db.prepare(
        `UPDATE browser_action_receipts SET state=?,command_ok=?,semantic_ok=?,verification_json=?,
                evidence_ids_json=?,error_code=?,observed_at=?,updated_at=? WHERE action_id=?`,
      ).run(
        resolution.outcome, resolution.outcome === 'not_applied' ? 0 : 1,
        resolution.outcome === 'verified' ? 1 : resolution.outcome === 'not_applied' ? 0 : null,
        JSON.stringify(sanitize(resolution.verification)), JSON.stringify([evidence.evidenceId]),
        resolution.outcome === 'unknown' ? 'ACTION_UNKNOWN' : null, now, now, actionId,
      );
      const unresolved = (db.prepare(
        `SELECT COUNT(*) AS count FROM browser_action_receipts
          WHERE job_id=? AND generation<? AND state IN ('dispatched','unknown','reconciling')`,
      ).get(binding.jobId, binding.generation) as { count: number }).count;
      if (unresolved === 0) {
        db.prepare(
          "UPDATE browser_sessions SET state='ready',recovery_state='none',updated_at=? WHERE job_id=? AND attempt_id=? AND generation=? AND state='reconciling'",
        ).run(now, binding.jobId, binding.attemptId, binding.generation);
      }
      return { applied: true, receipt: mapReceipt(receiptRow(actionId)!) };
    },

    requireUserControl(binding, reason) {
      const session = authority.assertActionable(binding);
      const now = Date.now();
      db.prepare(
        `UPDATE browser_sessions SET state='user_control_required',recovery_state=?,lease_epoch=lease_epoch+1,updated_at=?
          WHERE browser_session_id=?`,
      ).run(String(sanitize(reason)).slice(0, 500), now, session.browserSessionId);
      return mapSession(sessionRow(session.browserSessionId)!);
    },

    takeUserControl(binding) {
      const checked = assertBinding(binding);
      if (!checked.session || checked.session.state !== 'user_control_required') {
        throw new BrowserAuthorityError('SESSION_NOT_ACTIONABLE', 'Browser session is not waiting for user control');
      }
      db.prepare("UPDATE browser_sessions SET state='user_control',lease_epoch=lease_epoch+1,updated_at=? WHERE browser_session_id=?")
        .run(Date.now(), checked.session.browser_session_id);
      return mapSession(sessionRow(checked.session.browser_session_id)!);
    },

    returnControl(binding) {
      const checked = assertBinding(binding);
      if (!checked.session || checked.session.state !== 'user_control') {
        throw new BrowserAuthorityError('SESSION_NOT_ACTIONABLE', 'Browser session is not under user control');
      }
      db.prepare(
        "UPDATE browser_sessions SET state='reconciling',recovery_state='fresh_observation_required',lease_epoch=lease_epoch+1,updated_at=? WHERE browser_session_id=?",
      ).run(Date.now(), checked.session.browser_session_id);
      return mapSession(sessionRow(checked.session.browser_session_id)!);
    },

    cancelSession(browserSessionId, reason) {
      const row = sessionRow(browserSessionId);
      if (!row) throw new BrowserAuthorityError('SESSION_LOST', 'Browser session not found');
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          `UPDATE browser_sessions SET state='cancelled',controlled_tab_id=NULL,recovery_state=?,
                  lease_epoch=lease_epoch+1,updated_at=?,closed_at=COALESCE(closed_at,?)
            WHERE browser_session_id=?`,
        ).run(String(sanitize(reason)).slice(0, 500), now, now, browserSessionId);
        db.prepare('UPDATE browser_tabs SET controlled=0,updated_at=? WHERE browser_session_id=?').run(now, browserSessionId);
      }).immediate();
      return mapSession(sessionRow(browserSessionId)!);
    },

    closeSession(binding, reason) {
      const checked = assertBinding(binding);
      if (!checked.session) throw new BrowserAuthorityError('SESSION_LOST', 'Browser session not found');
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          `UPDATE browser_sessions SET state='closed',controlled_tab_id=NULL,recovery_state=?,
                  lease_epoch=lease_epoch+1,updated_at=?,closed_at=? WHERE browser_session_id=?`,
        ).run(String(sanitize(reason)).slice(0, 500), now, now, checked.session.browser_session_id);
        db.prepare('UPDATE browser_tabs SET controlled=0,updated_at=? WHERE browser_session_id=?')
          .run(now, checked.session.browser_session_id);
      }).immediate();
      return mapSession(sessionRow(checked.session.browser_session_id)!);
    },

    settleSession(binding, state, reason) {
      const row = sessionForAttempt(binding.jobId, binding.attemptId, binding.generation);
      if (!row || row.fence_digest !== hash(binding.fenceToken)) {
        throw new BrowserAuthorityError('SESSION_NOT_AUTHORIZED', 'Browser session lineage does not match the settling Attempt');
      }
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          `UPDATE browser_sessions SET state=?,controlled_tab_id=NULL,recovery_state=?,
                  lease_epoch=lease_epoch+1,updated_at=?,closed_at=COALESCE(closed_at,?)
            WHERE browser_session_id=?`,
        ).run(state, String(sanitize(reason)).slice(0, 500), now, now, row.browser_session_id);
        db.prepare(
          `UPDATE browser_tabs SET controlled=0,
                  closed_at=CASE WHEN close_policy='aiden_owned' THEN COALESCE(closed_at,?) ELSE closed_at END,
                  updated_at=? WHERE browser_session_id=?`,
        ).run(now, now, row.browser_session_id);
      }).immediate();
      return mapSession(sessionRow(row.browser_session_id)!);
    },
  };

  return authority;
}
