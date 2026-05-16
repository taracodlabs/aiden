/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/index.ts — v4.5 Phase 1: barrel exports for the
 * daemon foundation.
 *
 * Phase 1 ships the foundation; Phases 2-6 add file watcher,
 * webhook, email, scheduler-migration, integration, default-on.
 *
 * Public surface (re-exported here so callers do
 * `import { ... } from '@/core/v4/daemon'` instead of subpath
 * imports for the common operations):
 *
 *   - configuration + paths
 *   - SQLite handle + migrations
 *   - runtime lock + instance tracker
 *   - clean-shutdown marker + restart-failure counter
 *   - trigger bus + idempotency store + run store
 *   - resource registry
 *   - supervisor + service template generators
 *   - drain + signal handlers
 *   - health + metrics endpoint mounter
 *   - event loop lag sampler
 *
 * Side-effect imports (modules that install global state) are NOT
 * re-exported here — those must be invoked explicitly during
 * daemon boot.
 */

export { DAEMON_RESTART_EXIT_CODE } from './restartCode';

export {
  getDaemonConfig,
  readDaemonConfig,
  daemonDir,
  daemonDbPath,
  daemonRuntimeLockPath,
  daemonCleanShutdownMarkerPath,
  getHostname,
  _resetDaemonConfigForTests,
} from './daemonConfig';
export type { DaemonConfig } from './daemonConfig';

export * from './types';

export { openDaemonDb, closeDaemonDb, _closeAllDaemonDbsForTests } from './db/connection';
export type { Db } from './db/connection';
export { runMigrations, LATEST_SCHEMA_VERSION } from './db/migrations';

export {
  acquireRuntimeLock,
  DaemonAlreadyRunningError,
} from './runtimeLock';
export type { RuntimeLock } from './runtimeLock';

export { createInstanceTracker } from './instanceTracker';
export type { InstanceTracker } from './instanceTracker';

export {
  touchCleanShutdownMarker,
  isCleanShutdown,
  consumeCleanShutdownMarker,
  evaluateBootState,
} from './cleanShutdown';

export {
  createRestartFailureCounter,
  DEFAULT_STUCK_LOOP_THRESHOLD,
} from './restartFailureCounter';
export type { RestartFailureCounter } from './restartFailureCounter';

export {
  createTriggerBus,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
} from './triggerBus';
export type { TriggerBus } from './triggerBus';

export {
  createIdempotencyStore,
  DEFAULT_TTL_MS as IDEMPOTENCY_DEFAULT_TTL_MS,
} from './idempotencyStore';
export type { IdempotencyStore, CachedResponse } from './idempotencyStore';

export { createRunStore } from './runStore';
export type { RunStore } from './runStore';

export {
  getResourceRegistry,
  createResourceRegistry,
  _resetResourceRegistryForTests,
} from './resourceRegistry';
export type { ResourceRegistry } from './resourceRegistry';

export {
  startSupervisor,
  generateSystemdUnit,
  generateLaunchdPlist,
  windowsServiceGuidance,
} from './supervisor';
export type { SupervisorOptions, SupervisorHandle, ServiceTemplateContext } from './supervisor';

export {
  performDrain,
  signalToReason,
  isDraining,
  _resetDrainStateForTests,
} from './drain';

export {
  installDaemonSignalHandlers,
  _resetDaemonSignalHandlersForTests,
} from './signals';

export {
  bootstrapDaemon,
  getDaemonHandle,
  _resetDaemonBootstrapForTests,
} from './bootstrap';
export type { DaemonBootstrapHandle, BootstrapOptions } from './bootstrap';

// ── v4.5 Phase 2 — file-watcher trigger ──────────────────────────────────
export {
  createFileWatcher,
} from './triggers/fileWatcher';
export type { FileWatcherHandle, FileWatcherStats } from './triggers/fileWatcher';
export {
  parseFileWatcherSpec,
  DEFAULT_FILE_WATCHER_SPEC,
} from './triggers/fileWatcherSpec';
export type {
  FileWatcherSpec,
  FileEventType,
  ReconcilePolicy,
} from './triggers/fileWatcherSpec';
export {
  createFileObservationsStore,
} from './triggers/fileObservationsStore';
export type {
  FileObservation,
  FileObservationsStore,
} from './triggers/fileObservationsStore';
export {
  reconcileFileWatcher,
} from './triggers/reconcile';
export {
  compileGlobMatcher,
  DEFAULT_IGNORE_PATTERNS,
} from './triggers/globMatcher';
export {
  settleStat,
} from './triggers/settleStat';
export {
  computeFileKey,
} from './triggers/fsIdentity';

// ── v4.5 Phase 3 — webhook trigger ───────────────────────────────────────
export {
  mountWebhookRoutes,
  assertSafeBind,
} from './triggers/webhook';
export type {
  WebhookRouteStats,
  MountedWebhookRoutes,
  MountWebhookRoutesOptions,
} from './triggers/webhook';
export {
  parseWebhookSpec,
  DEFAULT_WEBHOOK_SPEC,
  INSECURE_NO_AUTH,
} from './triggers/webhookSpec';
export type {
  WebhookSpec,
  WebhookHmacFormat,
} from './triggers/webhookSpec';
export {
  verifyWebhookSignature,
  deriveEventName,
} from './triggers/webhookVerifier';
export {
  createRateLimiter,
} from './triggers/webhookRateLimit';
export type { RateLimiter } from './triggers/webhookRateLimit';
export {
  deriveIdempotencyKey,
} from './triggers/webhookIdempotency';
export {
  createWebhookDeliveriesStore,
} from './triggers/webhookDeliveriesStore';
export type {
  WebhookDelivery,
  WebhookDeliveriesStore,
  RecordDeliveryInput,
} from './triggers/webhookDeliveriesStore';

// ── v4.5 Phase 4a — email IMAP trigger ───────────────────────────────────
export {
  createEmailTrigger,
} from './triggers/email';
export type {
  EmailTriggerHandle,
  EmailStats,
} from './triggers/email';
export {
  parseEmailSpec,
  DEFAULT_EMAIL_SPEC,
  DEFAULT_IMAP,
} from './triggers/email/emailSpec';
export type {
  EmailSpec,
  EmailImapConfig,
  AttachmentPolicy,
} from './triggers/email/emailSpec';
export {
  isAutomatedSender,
  NOREPLY_PATTERNS,
  AUTOMATED_HEADERS,
} from './triggers/email/automatedSender';
export {
  compileSenderAllowlist,
} from './triggers/email/allowlist';
export type { SenderAllowlist } from './triggers/email/allowlist';
export {
  createSeenUids,
  DEFAULT_MAX_SEEN_UIDS,
} from './triggers/email/seenUids';
export type { SeenUids } from './triggers/email/seenUids';
export {
  createEmailSeenStore,
} from './triggers/email/emailSeenStore';
export type {
  EmailSeen,
  EmailSeenStore,
  EmailSeenStatus,
  RecordEmailSeenInput,
} from './triggers/email/emailSeenStore';
export {
  extractEmailBody,
} from './triggers/email/bodyExtractor';
export type {
  ExtractedBody,
  AttachmentMetadata,
} from './triggers/email/bodyExtractor';
export {
  createImapConnection,
  nextBackoffMs,
  BACKOFF_CONSTANTS,
} from './triggers/email/imapConnection';
export type {
  ImapConnection,
  ImapConfig,
  RawMessage,
} from './triggers/email/imapConnection';

export {
  startEventLoopLagSampler,
  stopEventLoopLagSampler,
  getEventLoopLagMs,
  getLastTickAt,
  isEventLoopResponsive,
} from './eventLoopLag';

export {
  mountHealthEndpoints,
  evaluateDegraded,
} from './health';
export type { HealthDeps, DegradedReason } from './health';
