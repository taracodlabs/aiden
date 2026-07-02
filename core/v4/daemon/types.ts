/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/types.ts — v4.5 Phase 1: shared type surface.
 *
 * Pure types only. No I/O, no imports of side-effecting modules.
 * Keeps the dependency graph one-way (every other daemon module
 * imports from here, but this imports nothing of consequence).
 */

// ── Trigger bus ─────────────────────────────────────────────────────────────

export type TriggerSource = 'file' | 'webhook' | 'email' | 'schedule' | 'manual';

export type TriggerEventStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'dead_letter';

export interface TriggerEventInput {
  source:          TriggerSource;
  /** Trigger spec id (FK to `triggers.id`). */
  sourceKey:       string;
  /** Dedup key — when set, UNIQUE(source, idempotency_key) is enforced. */
  idempotencyKey?: string;
  payload:         Record<string, unknown>;
}

export interface TriggerEventRow {
  id:              number;
  source:          TriggerSource;
  sourceKey:       string;
  idempotencyKey:  string | null;
  payload:         Record<string, unknown>;
  status:          TriggerEventStatus;
  attempts:        number;
  claimOwner:      string | null;
  claimExpiresAt:  number | null;
  lastError:       string | null;
  createdAt:       number;
  updatedAt:       number;
  completedAt:     number | null;
  runId:           number | null;
}

export interface ClaimedEvent extends TriggerEventRow {
  /** Per-claim nonce; required to release/markDone/markFailed. */
  claimToken: string;
}

// ── Runs ────────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface RunRow {
  id:              number;
  triggerEventId:  number | null;
  sessionId:       string;
  instanceId:      string;
  status:          RunStatus;
  finishReason:    string | null;
  startedAt:       number;
  completedAt:     number | null;
  resumePending:   boolean;
  resumeReason:    string | null;
  /** v4.13 Gap 4 — durable job-card linkage (null pre-v18). */
  taskId:          string | null;
}

// ── Daemon instance ─────────────────────────────────────────────────────────

export type ShutdownReason =
  | 'sigterm'
  | 'sigint'
  | 'sigusr1_restart'
  | 'crash'
  | 'replaced';

export interface DaemonInstanceRow {
  instanceId:     string;
  pid:            number;
  hostname:       string;
  startedAt:      number;
  lastHeartbeat:  number;
  shutdownAt:     number | null;
  shutdownReason: ShutdownReason | null;
  exitCode:       number | null;
  version:        string;
}

// ── Crash reports ───────────────────────────────────────────────────────────

export interface CrashReportRow {
  id:                number;
  instanceId:        string;
  detectedAt:        number;
  prevStartedAt:     number | null;
  prevLastHeartbeat: number | null;
  prevPid:           number | null;
  affectedSessions:  string[];
  psSnapshot:        string | null;
  details:           Record<string, unknown>;
}

// ── Resource registry ───────────────────────────────────────────────────────

export type ResourceKind =
  | 'browser_context'
  | 'docker_session'
  | 'http_client'
  | 'file_watcher'
  | 'subprocess'
  | 'imap_connection'
  | 'webhook_server'
  | 'sqlite_connection';

export interface Resource {
  id:           string;
  kind:         ResourceKind;
  owner:        string;
  createdAt:    number;
  lastUsedAt:   number;
  ttlMs?:       number;
  budgetUnits?: number;
  metadata?:    Record<string, unknown>;
  close:        () => Promise<void> | void;
}

// ── Idempotency cache ───────────────────────────────────────────────────────

export type IdempotencyScope = 'webhook' | 'api_run';

export interface IdempotencyEntry {
  scope:       IdempotencyScope;
  key:         string;
  fingerprint: string | null;
  responseJson: string;
  statusCode:  number;
  createdAt:   number;
  expiresAt:   number;
}

// ── Boot decision (cleanShutdown) ───────────────────────────────────────────

export interface BootDecision {
  cleanShutdown:         boolean;
  suspendActiveSessions: boolean;
  crashDetected:         boolean;
}

// ── Drain options ───────────────────────────────────────────────────────────

export interface DrainContext {
  /** Drain timeout for in-flight runs (ms). */
  drainTimeoutMs:        number;
  /** Reason this drain was triggered. */
  reason:                ShutdownReason;
  /** Exit code to pass to `process.exit` at the end. */
  exitCode?:             number;
  /** Grace period after interrupt before stepping into Step 3. Tests pass 0. */
  postInterruptGraceMs?: number;
  /** Notify active sessions before draining (e.g. distill, emit "shutting down"). */
  notifySessions?:       () => Promise<void> | void;
  /** Currently-active run ids. */
  activeRuns?:           () => Promise<number[]> | number[];
  /** Interrupt one in-flight run. */
  interruptRun?:         (runId: number, reason: string) => Promise<void> | void;
  /** Mark a run for resume-on-restart. */
  markResumePending?:    (runId: number, reason: string) => Promise<void> | void;
  /** Kill orphan tool subprocesses BEFORE adapter teardown. */
  killToolSubprocesses?: (reason: string) => Promise<void> | void;
  /** Final resource reap (browsers, docker, http clients, watchers). */
  closeResources?:       () => Promise<unknown> | void;
  /** Existing v4 closers — daemon owns the ordering. */
  closeBrowser?:         () => Promise<void> | void;
  closeCron?:            () => Promise<void> | void;
  closeDocker?:          () => Promise<void> | void;
  closeIdempotency?:     () => Promise<void> | void;
  /** Touch the .clean_shutdown marker (after all resources closed). */
  touchCleanShutdown?:   () => void;
  /** Release the runtime lock file. */
  removePid?:            () => void;
  /** Mark daemon_instances row with shutdown_at + reason + exit_code. */
  markShutdown?:         (reason: ShutdownReason, exitCode: number) => void;
}
