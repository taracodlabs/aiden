/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/bootstrap.ts — v4.5 Phase 1 follow-up: shared entry
 * for daemon foundation initialization.
 *
 * Phase 1 wired the daemon init into `api/server.ts`. That path is
 * only hit when the user starts the HTTP API server (Electron child,
 * `aiden serve`-style invocation, OpenAI-compatible endpoint
 * mode). The interactive REPL entry (`cli/v4/aidenCLI.ts`) is
 * standalone and never imports api/server.ts, so AIDEN_DAEMON=1
 * silently did nothing for REPL users.
 *
 * This module is the single bootstrap that BOTH entry points call.
 * Idempotent — safe to invoke from multiple sites in the same
 * process (the singleton guard returns the existing handle).
 *
 * When an Express app is supplied (api/server.ts path), health
 * endpoints mount onto it. When omitted (CLI path), a minimal
 * Express server is spun up on the configured port so
 * `/health/live`, `/metrics`, etc. are reachable regardless of
 * how the user invoked Aiden.
 */

import type { Express } from 'express';
import express from 'express';
import http   from 'node:http';

import { getDaemonConfig } from './daemonConfig';
import {
  daemonDbPath,
  daemonRuntimeLockPath,
  daemonCleanShutdownMarkerPath,
} from './daemonConfig';
import { resolveAidenRoot } from '../paths';
import { openDaemonDb } from './db/connection';
import { acquireRuntimeLock, DaemonAlreadyRunningError } from './runtimeLock';
import type { RuntimeLock } from './runtimeLock';
import { createInstanceTracker } from './instanceTracker';
import type { InstanceTracker } from './instanceTracker';
import { evaluateBootState, touchCleanShutdownMarker } from './cleanShutdown';
import { createTriggerBus } from './triggerBus';
import type { TriggerBus } from './triggerBus';
import { createIdempotencyStore } from './idempotencyStore';
import type { IdempotencyStore } from './idempotencyStore';
import { createRunStore } from './runStore';
import { createTaskStore } from './taskStore';
import { sweepResumePending } from './resumeSweep';
import type { RunStore } from './runStore';
// v4.10 Slice 10.2b — shared event taxonomy.
import { categorizeEvent } from './eventCategories';
import { createRestartFailureCounter } from './restartFailureCounter';
import type { RestartFailureCounter } from './restartFailureCounter';
import { getResourceRegistry } from './resourceRegistry';
import type { ResourceRegistry } from './resourceRegistry';
import { startEventLoopLagSampler, stopEventLoopLagSampler } from './eventLoopLag';
import { mountHealthEndpoints } from './health';
import { installDaemonSignalHandlers } from './signals';
// v4.5 Phase 2 — file watcher trigger.
import { createFileObservationsStore } from './triggers/fileObservationsStore';
import { createFileWatcher } from './triggers/fileWatcher';
import type { FileWatcherHandle } from './triggers/fileWatcher';
import { reconcileFileWatcher } from './triggers/reconcile';
import { parseFileWatcherSpec } from './triggers/fileWatcherSpec';
import type { TriggerRowSql } from './db/schema/v1.spec';
// v4.5 Phase 3 — webhook trigger.
import { mountWebhookRoutes, assertSafeBind } from './triggers/webhook';
import type { MountedWebhookRoutes } from './triggers/webhook';
// v4.5 Phase 4a — email trigger.
import { createEmailTrigger } from './triggers/email';
import type { EmailTriggerHandle } from './triggers/email';
import { parseEmailSpec } from './triggers/email/emailSpec';
import { createEmailSeenStore } from './triggers/email/emailSeenStore';
// v4.5 Phase 5a — trigger dispatcher.
import {
  createDispatcher,
  createRealAgentRunner,
  makeRunner,
} from './dispatcher';
import type {
  AgentBuilder,
  Dispatcher,
  DaemonAgentRunner,
  DaemonAgentResult,
} from './dispatcher';
// v4.5 Phase 5b — cron migration to SQLite + daemon-mode emitter.
import { runCronMigration } from './cron/migration';
import { createCronEmitter } from './cron/cronEmitter';
import { pwClose } from '../../playwrightBridge';
import { VERSION } from '../../version';
// v4.9.0 Slice 3 — structured logger + crash recovery.
import path from 'node:path';
import {
  CoreLogger,
  FileSink,
  StderrSink,
  RedactingSink,
  type Logger,
  type LogLevel,
} from '../logger';
import { reclaimStuckRuns } from './runs/reclaim';
// v4.9.0 Slice 8 — stuck-attempt watchdog ticker.
import { sweepStuckAttempts } from './runs/stuckAttemptWatchdog';
// v4.9.0 Slice 4 — identity substrate + incarnations table.
import {
  loadOrCreateDaemonId,
  newIncarnationId,
  currentContext,
} from '../identity';
import { insertIncarnation, markEnded } from './incarnationStore';
// v4.9.0 Slice 7 — static import. The lazy `require()` form here
// silently failed under vite-node (CJS `.ts` resolution) and the
// `/api/runs` route never mounted in tests.
import { mountRunsRoutes } from './api/runs';

export interface DaemonBootstrapHandle {
  /** True when the foundation actually initialized (AIDEN_DAEMON=1). */
  active:            boolean;
  /** Instance id assigned by `createInstanceTracker`. */
  instanceId:        string | null;
  /** Whether bootstrap started its own minimal HTTP server (CLI path). */
  ownsHttpServer:    boolean;
  triggerBus:        TriggerBus | null;
  idempotencyStore:  IdempotencyStore | null;
  runStore:          RunStore | null;
  restartFailureCounter: RestartFailureCounter | null;
  resourceRegistry:  ResourceRegistry | null;
  instanceTracker:   InstanceTracker | null;
  runtimeLock:       RuntimeLock | null;
  /** Where daemon.db landed (diagnostic). */
  dbPath:            string | null;
  /** Where the clean-shutdown marker is written on graceful exit. */
  markerPath:        string | null;
  /** Optional: own HTTP server for CLI path. */
  httpServer:        http.Server | null;
  /** v4.5 Phase 2 — active file watcher handles. */
  fileWatchers:      ReadonlyArray<FileWatcherHandle>;
  /** v4.5 Phase 3 — webhook route mount (null when no app available). */
  webhookRoutes:     MountedWebhookRoutes | null;
  /** v4.5 Phase 4a — active email trigger handles. */
  emailTriggers:     ReadonlyArray<EmailTriggerHandle>;
  /** v4.5 Phase 5a — trigger bus dispatcher (null when daemon disabled). */
  dispatcher:        Dispatcher | null;
  /**
   * v4.5 Phase 5b — cron migration result (one-shot on first v5 boot).
   * Subsequent boots return {ran:false, reason:'already_migrated'}.
   */
  cronMigration:     {
    ran:        boolean;
    migrated:   number;
    skipped:    number;
    backupPath: string | null;
    reason?:    string;
  } | null;
}

const NOOP_HANDLE: DaemonBootstrapHandle = Object.freeze({
  active:                false,
  instanceId:            null,
  ownsHttpServer:        false,
  triggerBus:            null,
  idempotencyStore:      null,
  runStore:              null,
  restartFailureCounter: null,
  resourceRegistry:      null,
  instanceTracker:       null,
  runtimeLock:           null,
  dbPath:                null,
  markerPath:            null,
  httpServer:            null,
  fileWatchers:          Object.freeze([] as FileWatcherHandle[]),
  webhookRoutes:         null,
  emailTriggers:         Object.freeze([] as EmailTriggerHandle[]),
  dispatcher:            null,
  cronMigration:         null,
});

// Process-wide singleton — the second call returns the same handle.
let _singleton: DaemonBootstrapHandle | null = null;

/**
 * v4.9.0 Slice 4 — module-level holders for the persistent daemon
 * identity (`dmn_...`) and the per-process incarnation (`inc_...`).
 * Populated by `bootstrapDaemon()`. Readable by other modules (e.g.
 * the logger sink) via `getCurrentDaemonId()` / `getCurrentIncarnationId()`
 * so they can stamp every record with the identity pair without
 * requiring an ambient ExecutionContext.
 */
let _currentDaemonId:      string | null = null;
let _currentIncarnationId: string | null = null;
// v4.9.0 Slice 6 — module-level reference to the active daemon DB
// handle. Cached after `openDaemonDb(dbPath)` returns so tool/LLM span
// wrappers can pull it via `getCurrentDaemonDb()` without re-opening.
let _currentDaemonDb: import('./db/connection').Db | null = null;
// v4.9.0 Slice 6 — and a reference to the daemon logger, for the
// same reason: spans + log enrichments need a logger handle without
// each cross-cutting site plumbing its own.
let _currentDaemonLogger: Logger | null = null;
/** v4.9.0 Slice 6 — read the daemon's structured Logger (or null). */
export function getCurrentDaemonLogger(): Logger | null { return _currentDaemonLogger; }

/** v4.9.0 Slice 4 — read the persistent daemon id (`dmn_...`) or null. */
export function getCurrentDaemonId():      string | null { return _currentDaemonId; }
/** v4.9.0 Slice 4 — read this boot's incarnation id (`inc_...`) or null. */
export function getCurrentIncarnationId(): string | null { return _currentIncarnationId; }

/**
 * v4.9.0 Slice 6 — read the active daemon DB handle, or null when
 * AIDEN_DAEMON=0 / bootstrap hasn't run / bootstrap failed. Lets
 * cross-cutting modules (tool dispatcher, agent loop) opt into
 * span instrumentation without requiring CLI-level wiring. NOOP-safe:
 * returns null silently when the daemon foundation isn't up.
 */
export function getCurrentDaemonDb(): import('./db/connection').Db | null {
  return _currentDaemonDb;
}

/**
 * v4.9.0 Slice 3 — track whether the process-wide crash handlers
 * already wrapped this process. Reset by the test helper. The guard
 * prevents duplicate handler chains when bootstrap runs twice (which
 * the singleton normally prevents anyway, but tests sometimes punch
 * through `_resetDaemonBootstrapForTests`).
 */
let _crashHandlersInstalled = false;

/**
 * v4.9.0 Slice 3 — build a structured daemon logger composed of:
 *   stderr (human, warn+)  — visible to systemd / journalctl
 *   file   (NDJSON)        — `<aidenRoot>/logs/daemon.log`, rotated at 5 MB
 * Both sinks are wrapped in `RedactingSink` so secret-shaped tokens
 * never reach disk or stderr. Level is `info` by default; the
 * `AIDEN_DAEMON_LOG_LEVEL` env var promotes to `debug` for diagnostics.
 */
function buildDaemonLogger(logsDir: string): Logger {
  const envLvl = (process.env.AIDEN_DAEMON_LOG_LEVEL ?? '').toLowerCase();
  const level: LogLevel =
    envLvl === 'debug' || envLvl === 'info' || envLvl === 'warn' || envLvl === 'error'
      ? (envLvl as LogLevel)
      : 'info';
  return new CoreLogger({
    level,
    sinks: [
      // v4.9.0 Slice 6 — pretty stderr (short timestamp + dim runId
      // last-8 suffix when ambient context is present). File sink
      // stays NDJSON with full IDs for log aggregators.
      new RedactingSink(new StderrSink({ minLevel: 'warn', pretty: true })),
      new RedactingSink(new FileSink({ dir: logsDir, name: 'daemon', format: 'ndjson' })),
    ],
    // v4.9.0 Slice 4 — every daemon log line gets stamped with the
    // identity pair (daemonId, incarnationId) plus any ambient
    // ExecutionContext fields (runId, traceId, spanId, ...). Caller
    // ctx wins on key collision. Provider is guarded against init-time
    // calls (before the identity holders are populated) — returning
    // `undefined` then is fine; the merge step skips it.
    getContext: () => {
      const out: Record<string, unknown> = {};
      if (_currentDaemonId)      out.daemonId      = _currentDaemonId;
      if (_currentIncarnationId) out.incarnationId = _currentIncarnationId;
      const ctx = currentContext();
      if (ctx) {
        out.runId    = ctx.runId;
        out.traceId  = ctx.traceId;
        out.spanId   = ctx.spanId;
        if (ctx.parentSpanId) out.parentSpanId = ctx.parentSpanId;
        if (ctx.sessionId)    out.sessionId    = ctx.sessionId;
        if (ctx.triggerId)    out.triggerId    = ctx.triggerId;
        out.source   = ctx.source;
        out.attempt  = ctx.attempt;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    },
  });
}

export interface BootstrapOptions {
  /**
   * Existing Express app to mount health endpoints on. When omitted,
   * bootstrap spins up a minimal Express server on the configured
   * port (CLI / REPL entry path).
   */
  app?: Express;
  /**
   * Override how startup messages are surfaced. Defaults to
   * `console.log` / `console.error` so REPL users see the daemon
   * init line above the chat prompt.
   */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * v4.5 Phase 7 — caller-injected agent builder. When provided,
   * the dispatcher uses `createRealAgentRunner` to invoke
   * `AidenAgent.runConversation` per claim. When omitted, the
   * Phase 5a placeholder runner is used (still useful for rails-
   * only integration + environments without a configured provider).
   *
   * The CLI's `main()` is the natural call site: it already owns
   * agent construction for the REPL, so it can pass an
   * AgentBuilder that mirrors the REPL's `AidenAgent` construction
   * with the daemon-specific hooks plumbed in.
   */
  agentBuilder?: AgentBuilder;
  /**
   * v4.5 Phase 7 — persisted-default model. Last leg of the
   * `trigger spec → AIDEN_DAEMON_MODEL → persisted` chain. CLI
   * loads this from its config layer; daemon mode doesn't read
   * config files directly to keep import direction clean.
   */
  persistedDefaultModel?: { provider: string; model: string };
}

/**
 * Initialize the daemon foundation IF AIDEN_DAEMON=1. Returns a
 * handle describing what was wired (or a NOOP_HANDLE when the
 * daemon is disabled).
 *
 * Idempotent: a second call returns the existing singleton.
 *
 * Failures during init log a loud error but do NOT throw — the
 * agent loop should keep running even if daemon foundation init
 * fails, so the user isn't blocked from chatting because (say)
 * docker is dead. Health endpoints will simply be absent.
 */
export function bootstrapDaemon(opts: BootstrapOptions = {}): DaemonBootstrapHandle {
  if (_singleton) return _singleton;

  const cfg = getDaemonConfig();

  if (!cfg.enabled) {
    _singleton = NOOP_HANDLE;
    return NOOP_HANDLE;
  }

  // v4.9.0 Slice 3 — promote startup logging to the structured pipeline
  // BEFORE the first emit. Sub-modules receive the `log(level, msg)`
  // shape they were built against; the adapter forwards to the
  // CoreLogger which redacts before fan-out to stderr + file.
  const aidenRootForLog = resolveAidenRoot();
  const daemonLogger = buildDaemonLogger(path.join(aidenRootForLog, 'logs'));
  // v4.9.0 Slice 6 — stash for cross-cutting consumers (tool dispatcher
  // span wrap, LLM call span wrap). NOOP-safe via `getCurrentDaemonLogger()`.
  _currentDaemonLogger = daemonLogger;
  const log = opts.log ?? ((level, msg) => {
    if (level === 'error')      daemonLogger.error(msg);
    else if (level === 'warn')  daemonLogger.warn(msg);
    else                        daemonLogger.info(msg);
  });

  try {
    const aidenRoot  = aidenRootForLog;
    const dbPath     = daemonDbPath(aidenRoot);
    const lockPath   = daemonRuntimeLockPath(aidenRoot);
    const markerPath = daemonCleanShutdownMarkerPath(aidenRoot);

    // v4.6 Phase 3A — wire the spawn-pause singleton against the
    // same `aidenRoot` the REPL uses. Daemon-fired turns that
    // invoke `subagent_fanout` will read the same marker file the
    // REPL writes via /spawn-pause. Cross-process coordination is
    // the whole point of the file-marker design (in-process
    // singletons in three runtimes would each have independent
    // pause flags, which would defeat the operator control).
    // The init is idempotent — if the REPL already ran initSpawnPause
    // in this same process, this call replaces the singleton with
    // an equivalent one pointing at the same path.
    //
    // Defensive try/catch: a pause-init failure must NOT prevent
    // daemon bootstrap. Worst case the singleton stays uninit and
    // tool handlers fall through to their `safeReadPause` path
    // (treat as "not paused"). The daemon's startup probe below
    // is best-effort.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { initSpawnPause } = require('../subagent/spawnPause');
      const sp = initSpawnPause({ aidenHome: aidenRoot });
      if (sp.isPaused()) {
        const s = sp.status();
        const reasonSuffix = s.reason ? ` (reason: ${s.reason})` : '';
        log('warn',
          `[daemon] sub-agent spawning is PAUSED${reasonSuffix}. ` +
          'Daemon-fired subagent_fanout calls will reject until an operator ' +
          'runs /spawn-pause off in a REPL session.');
      }
    } catch (e) {
      log('warn', '[daemon] spawn-pause init failed (non-fatal): ' +
        (e instanceof Error ? e.message : String(e)));
    }

    const db = openDaemonDb(dbPath);
    // v4.9.0 Slice 6 — cache for cross-cutting consumers.
    _currentDaemonDb = db;
    const tracker = createInstanceTracker({ db, version: VERSION });
    tracker.start();

    // v4.6 Phase 3b — self-improvement loop singleton. Daemon-fired
    // turns that classify failures via TCE write through to the
    // shared failure ledger, so operator queries from a REPL see
    // daemon-side failure patterns too. Defensive try/catch — init
    // failure must not block daemon bootstrap; the TCE write-through
    // path silently no-ops when the singleton is missing.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { initRecoveryStore } = require('../selfimprovement/recoveryStore');
      initRecoveryStore({ db });
    } catch (e) {
      log('warn', '[daemon] recovery-store init failed (non-fatal): ' +
        (e instanceof Error ? e.message : String(e)));
    }

    // Race-safe runtime lock. EEXIST + live PID → DaemonAlreadyRunningError.
    let runtimeLock: RuntimeLock;
    try {
      runtimeLock = acquireRuntimeLock({
        lockPath,
        instanceId: tracker.instanceId,
        log,
      });
    } catch (e) {
      tracker.stop();
      if (e instanceof DaemonAlreadyRunningError) {
        log('error', '[daemon] ' + e.message);
        // Fail-loud: AIDEN_DAEMON=1 + another daemon already running is
        // an unambiguous error condition that should surface.
        process.exit(1);
      }
      throw e;
    }

    // Boot-state evaluation: detects crashed prior instance, writes
    // crash_reports, marks affected runs interrupted+resume_pending=1.
    const boot = evaluateBootState({ db, markerPath, instanceId: tracker.instanceId });
    if (boot.crashDetected) {
      log('warn', '[daemon] crash recovery: prior instance crashed; affected runs marked resume_pending=1');
    }

    // v4.9.0 Slice 4 — establish persistent daemon identity + per-process
    // incarnation. The daemon_id file is created on first boot at
    // <aidenRoot>/daemon/daemon_id; subsequent boots load it. The
    // incarnation row in daemon_incarnations gives every process a
    // first-class lineage row so `aiden doctor`-style tooling can show
    // "this daemon has booted N times across M crashes".
    //
    // Distinct from `tracker.instanceId`: the latter is a random UUID
    // for the v1-era `daemon_instances` table that Slice 3's crash
    // recovery still uses. We keep both alive; Slice 4 ADDS identity,
    // doesn't replace.
    try {
      _currentDaemonId      = loadOrCreateDaemonId(aidenRoot);
      _currentIncarnationId = newIncarnationId();
      insertIncarnation(db, {
        incarnationId: _currentIncarnationId,
        daemonId:      _currentDaemonId,
        pid:           process.pid,
        aidenVersion:  VERSION,
        nodeVersion:   process.version,
      });
      log('info',
        `[daemon] identity established daemon_id=${_currentDaemonId} ` +
        `incarnation_id=${_currentIncarnationId}`);
    } catch (e) {
      log('warn', `[daemon] identity init failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      _currentDaemonId      = null;
      _currentIncarnationId = null;
    }

    // v4.9.0 Slice 3 — defence-in-depth: sweep any `running` rows owned
    // by a non-current instance. `evaluateBootState` already covers the
    // common case, but a row racing the crash window could slip past it.
    // Idempotent: no-op when no rows match.
    try {
      const swept = reclaimStuckRuns(db, { currentInstanceId: tracker.instanceId });
      if (swept.reclaimed > 0) {
        log('warn',
          `[daemon] startup reclaim swept ${swept.reclaimed} orphaned run(s) ` +
          `from prior incarnations: ids=[${swept.runIds.join(',')}]`);
      }
    } catch (e) {
      log('warn', `[daemon] startup reclaim failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }

    // v4.9.0 Slice 3 — process-wide crash handlers. Either signal
    // means "this daemon is about to die unexpectedly". Reclaim our
    // still-`running` rows BEFORE the exit so a follow-up boot sees
    // an unambiguous `interrupted` shape, then exit 1 so service
    // managers (systemd / launchd) know to restart us.
    //
    // We install `process.on(...)` (not `.once`) so the handler covers
    // the rare double-crash. The exit is guarded by a 100ms timeout so
    // a flush of the file sink has a chance to land.
    if (!_crashHandlersInstalled) {
      _crashHandlersInstalled = true;
      const crashedInstanceId = tracker.instanceId;
      const reclaimAndExit = (eventName: 'uncaughtException' | 'unhandledRejection', reason: unknown): void => {
        try {
          const err = reason instanceof Error
            ? { type: reason.name, message: reason.message, stack: reason.stack }
            : { type: 'NonError', message: String(reason) };
          daemonLogger.error(`[daemon] ${eventName} — terminating after run reclaim`, {
            event:      'daemon.crashed',
            component:  'daemon.bootstrap',
            incarnationId: crashedInstanceId,
            error:      err,
          });
        } catch { /* logging must not block the reclaim path */ }
        try {
          const swept = reclaimStuckRuns(db, { instanceId: crashedInstanceId });
          if (swept.reclaimed > 0) {
            try {
              daemonLogger.warn(
                `[daemon] crash-handler reclaim marked ${swept.reclaimed} run(s) interrupted`,
                { event: 'daemon.crash_reclaim', runIds: swept.runIds },
              );
            } catch { /* noop */ }
          }
        } catch { /* never block exit on reclaim failure */ }
        // v4.9.0 Slice 4 — flag the incarnation row as crashed before
        // we exit. Best-effort; never blocks the exit path.
        try {
          if (_currentIncarnationId) {
            markEnded(db, {
              incarnationId: _currentIncarnationId,
              exitReason:    'crash',
              exitCode:      1,
            });
          }
        } catch { /* noop */ }
        // 100ms grace for the file sink to flush before we tear down.
        setTimeout(() => { try { process.exit(1); } catch { /* noop */ } }, 100);
      };
      process.on('uncaughtException', (err) => reclaimAndExit('uncaughtException', err));
      process.on('unhandledRejection', (reason) => reclaimAndExit('unhandledRejection', reason));
    }

    // Module singletons.
    // v4.9.0 Slice 5 — opt the trigger bus into the durable
    // run-idempotency anchor. Every accepted trigger_event with a
    // non-null idempotency_key now also writes a row to
    // `run_idempotency_keys` in the same transaction.
    const triggerBus            = createTriggerBus({
      db,
      enableRunIdempotency:   true,
      onIdempotencyConflict:  (info) => {
        log('warn',
          `[trigger-bus] duplicate ingress namespace=trigger:${info.source} ` +
          `key=${info.key} — reusing existing run anchor`);
      },
    });
    const idempotencyStore      = createIdempotencyStore({ db });
    const runStore              = createRunStore({ db });
    const restartFailureCounter = createRestartFailureCounter({ db, threshold: cfg.restartFailureThreshold });
    const resourceRegistry      = getResourceRegistry();
    try { idempotencyStore.reseed(); } catch { /* best-effort */ }

    startEventLoopLagSampler();

    // Mount health endpoints. When the caller supplied an existing
    // Express app (api/server.ts path), use it. Otherwise spin up a
    // minimal Express server on the configured port (CLI path).
    let app = opts.app;
    let httpServer: http.Server | null = null;
    let ownsHttpServer = false;
    if (!app) {
      app = express();
      // NOTE: deliberately DO NOT install express.json() globally.
      // The daemon-only routes mounted below are:
      //   - GET /health/{live,ready,degraded}   — no body
      //   - GET /metrics                        — no body
      //   - GET /api/daemon/{status,resources}  — no body
      //   - POST /api/triggers/webhook/:id      — requires RAW body
      //                                            (express.raw inline)
      // If a global json parser were registered here, it would
      // consume the webhook body BEFORE the route's express.raw
      // could see it, making HMAC verification always fail.
      ownsHttpServer = true;
    }
    mountHealthEndpoints(app, {
      db,
      triggerBus,
      resourceRegistry,
      instanceTracker:  tracker,
      version:          VERSION,
    });

    // v4.5 Phase 3 — webhook routes mount on the same Express app.
    // Single dispatch endpoint POST /api/triggers/webhook/:id resolves
    // routes at request time, so no per-route Express handler bloat.
    const webhookRoutes = mountWebhookRoutes({
      app,
      db,
      triggerBus,
      idempotencyStore,
      resourceRegistry,
      log,
    });

    // v4.9.0 Slice 5 — POST /api/runs durable ingress. Returns 202
    // only after the trigger_event + run_idempotency_keys rows commit.
    // Slice 7 also adopts inbound `traceparent` here.
    try {
      const ingressBindHost = process.env.AIDEN_DAEMON_BIND ?? '127.0.0.1';
      mountRunsRoutes({
        app,
        triggerBus,
        log,
        apiKeyRequired: ingressBindHost !== '127.0.0.1' && ingressBindHost !== 'localhost',
      });
      log('info', '[api/runs] POST /api/runs durable ingress mounted');
    } catch (e) {
      log('error', `[api/runs] mount failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // v4.5 Phase 3 — bind safety check. When AIDEN_DAEMON_BIND opts
    // into a non-loopback interface, require AIDEN_API_KEY + refuse
    // INSECURE_NO_AUTH webhook routes. Runs BEFORE the listener binds.
    const bindHost = process.env.AIDEN_DAEMON_BIND ?? '127.0.0.1';
    try {
      assertSafeBind({
        bindHost,
        apiKeyConfigured: typeof process.env.AIDEN_API_KEY === 'string' && process.env.AIDEN_API_KEY.length > 0,
        db,
        log,
      });
    } catch (e) {
      // Refuse to bring up the HTTP listener but DO keep the foundation
      // running (file watchers, daemon db, instance tracker) so the
      // operator can see status via the daemon-already-running guard.
      log('error', '[daemon] refusing to start HTTP listener due to bind-safety check failure');
      throw e;
    }

    if (ownsHttpServer) {
      httpServer = http.createServer(app);
      httpServer.listen(cfg.port, bindHost, () => {
        log('info', `[daemon] http server listening on http://${bindHost}:${cfg.port}`);
      });
      httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log('warn', `[daemon] port ${cfg.port} in use — health endpoints unavailable (db / triggers still active)`);
        } else {
          log('error', `[daemon] http server error: ${err.message}`);
        }
      });
    }

    // v4.5 Phase 3 — webhook deliveries retention sweep. Runs once on
    // boot then every 24h. Configurable via env (default 7 days).
    const retentionDays = (() => {
      const raw = process.env.AIDEN_DAEMON_WEBHOOK_RETENTION_DAYS;
      const n = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 7;
    })();
    try {
      const swept = webhookRoutes.sweepDeliveries(retentionDays);
      if (swept.deleted > 0) {
        log('info', `[webhook] retention sweep: deleted ${swept.deleted} delivery rows older than ${retentionDays}d`);
      }
    } catch { /* best-effort */ }
    const retentionTimer = setInterval(() => {
      try { webhookRoutes.sweepDeliveries(retentionDays); }
      catch { /* never let sweep crash */ }
    }, 24 * 60 * 60 * 1000);
    if (typeof retentionTimer.unref === 'function') retentionTimer.unref();

    // v4.9.0 Slice 4 — wire the missing `triggerBus.reclaimExpired()`
    // ticker. The function existed since v4.5 Phase 5a but had no call
    // site; crashed-mid-claim trigger events were stuck in `'claimed'`
    // because the claim picker only matches `status='pending'`. 30s
    // cadence matches what the original `triggerBus.ts` header
    // comment promised. Boot-time call covers the gap where a daemon
    // crashed *after* a claim and a new daemon starts before any lease
    // expires naturally.
    try {
      const swept = triggerBus.reclaimExpired();
      if (swept.reclaimed > 0) {
        log('warn',
          `[trigger-bus] boot reclaim returned ${swept.reclaimed} expired claim(s) to 'pending'`);
      }
    } catch (e) {
      log('warn', `[trigger-bus] boot reclaim failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
    const reclaimTimer = setInterval(() => {
      try { triggerBus.reclaimExpired(); }
      catch { /* never let the sweep crash the daemon */ }
    }, 30_000);
    if (typeof reclaimTimer.unref === 'function') reclaimTimer.unref();

    // v4.9.0 Slice 8 — stuck-attempt + orphan-span watchdog.
    // Sweeps run_attempts (status='running', older than threshold,
    // owned by non-current incarnation) and spans (open + non-current
    // incarnation). Default cadence 5min; threshold 30min. Both
    // configurable via env. unref'd so the ticker doesn't block exit.
    const watchdogIntervalMs = (() => {
      const raw = process.env.AIDEN_STUCK_ATTEMPT_CHECK_MS;
      const n = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
    })();
    const watchdogThresholdMs = (() => {
      const raw = process.env.AIDEN_STUCK_ATTEMPT_THRESHOLD_MS;
      const n = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
    })();
    const runWatchdogSweep = (): void => {
      try {
        if (!_currentIncarnationId) return;
        const r = sweepStuckAttempts(db, {
          currentIncarnationId: _currentIncarnationId,
          thresholdMs:          watchdogThresholdMs,
        });
        if (r.reclaimedAttempts > 0 || r.reclaimedSpans > 0) {
          log('warn',
            `[watchdog] swept stuck attempts=${r.reclaimedAttempts} ` +
            `orphan_spans=${r.reclaimedSpans}`);
        }
      } catch (e) {
        log('warn', `[watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    // Boot-time sweep covers anything left over from a prior crash
    // that evaluateBootState / reclaimStuckRuns didn't catch.
    runWatchdogSweep();
    const watchdogTimer = setInterval(runWatchdogSweep, watchdogIntervalMs);
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

    // Drain context — same shape api/server.ts wires.
    const getDrainCtx = () => ({
      drainTimeoutMs:    cfg.drainTimeoutMs,
      reason:            'sigterm' as const,
      notifySessions:    async () => { /* CLI path has no distillAllActiveSessions; api/server.ts path passes its own context */ },
      activeRuns:        () => runStore.listActive().map((r) => r.id),
      markResumePending: (runId: number, reason: string) => runStore.markResumePending(runId, reason),
      interruptRun:      async () => {
        // v4.5 Phase 5a — the dispatcher's runner is the
        // unit-of-interrupt. Phase 5a's runner is synchronous
        // (placeholder); the real AidenAgent-backed runner will
        // receive a per-run abort signal when wired.
      },
      killToolSubprocesses: async () => { /* Phase 5b wires tool-subprocess kill */ },
      closeBrowser:      () => pwClose(),
      closeCron:         () => { /* Phase 5b wires cron stop */ },
      closeIdempotency:  () => idempotencyStore.close(),
      closeResources:    () => resourceRegistry.reapAll(3_000),
      touchCleanShutdown: () => touchCleanShutdownMarker(markerPath),
      removePid:         async () => {
        // v4.5 Phase 5a — drain in-flight dispatcher claims before
        // releasing the runtime lock so SIGTERM-replace doesn't
        // duplicate trigger work on the incoming instance.
        if (_singleton?.dispatcher) {
          try { await _singleton.dispatcher.stop(cfg.drainTimeoutMs); }
          catch { /* never block shutdown on dispatcher cleanup */ }
        }
        try { runtimeLock.release(); } catch { /* noop */ }
        stopEventLoopLagSampler();
        tracker.stop();
        if (httpServer) {
          try { httpServer.close(); } catch { /* noop */ }
        }
      },
      markShutdown: (reason: 'sigterm' | 'sigint' | 'sigusr1_restart' | 'crash' | 'replaced', exitCode: number) => {
        tracker.markShutdown(reason, exitCode);
        // v4.9.0 Slice 4 — patch the incarnation row alongside the
        // legacy daemon_instances row. Map sigusr1_restart/replaced
        // → 'clean' (graceful drain), keep sigterm/sigint/crash
        // verbatim. Best-effort; never throws into the drain path.
        try {
          if (_currentIncarnationId) {
            const incReason =
              reason === 'sigterm' ? 'sigterm' :
              reason === 'sigint'  ? 'sigint'  :
              reason === 'crash'   ? 'crash'   :
              'clean';
            markEnded(db, {
              incarnationId: _currentIncarnationId,
              exitReason:    incReason,
              exitCode,
            });
          }
        } catch { /* drain path must never throw */ }
      },
    });

    installDaemonSignalHandlers({ getDrainContext: getDrainCtx });

    log('info', `[daemon] foundation initializing instance_id=${tracker.instanceId} db=${dbPath}`);
    if (boot.crashDetected) {
      log('warn', '[daemon] boot state: crash recovery applied');
    } else if (boot.cleanShutdown) {
      log('info', '[daemon] boot state: clean (previous instance exited gracefully)');
    } else {
      log('info', '[daemon] boot state: first boot / no prior daemon detected');
    }

    // ── v4.5 Phase 2 — load enabled file-watcher triggers ────────────────
    const fileWatchers: FileWatcherHandle[] = [];
    try {
      const obsStore = createFileObservationsStore({ db });
      const rows = db
        .prepare(
          `SELECT * FROM triggers WHERE source = 'file' AND enabled = 1 ORDER BY name`,
        )
        .all() as TriggerRowSql[];
      for (const t of rows) {
        try {
          const spec = parseFileWatcherSpec(t.spec_json);
          // Boot-time reconciliation BEFORE the watcher starts so
          // the policy decision is deterministic.
          reconcileFileWatcher({
            watcherId: t.id, spec, triggerBus, obsStore, log,
          });
          const handle = createFileWatcher({
            watcherId: t.id, spec, triggerBus, obsStore,
            registry:  resourceRegistry, log,
          });
          fileWatchers.push(handle);
          log('info', `[file-watcher] active: ${t.name} (${t.id}) paths=${spec.paths.length}`);
        } catch (e) {
          log('error', `[file-watcher] failed to start ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (rows.length === 0) {
        log('info', '[file-watcher] no file triggers registered');
      }
    } catch (e) {
      log('error', `[file-watcher] trigger registry scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── v4.5 Phase 4a — load enabled email-IMAP triggers ─────────────────
    const emailTriggers: EmailTriggerHandle[] = [];
    try {
      const seenStore = createEmailSeenStore({ db });
      const rows = db
        .prepare(
          `SELECT * FROM triggers WHERE source = 'email' AND enabled = 1 ORDER BY name`,
        )
        .all() as TriggerRowSql[];
      for (const t of rows) {
        try {
          const spec = parseEmailSpec(t.spec_json);
          const handle = createEmailTrigger({
            watcherId:      t.id,
            spec,
            triggerBus,
            emailSeenStore: seenStore,
            db,
            registry:       resourceRegistry,
            log,
          });
          emailTriggers.push(handle);
          log('info', `[email] active: ${t.name} (${t.id}) host=${spec.imap.host} mailbox=${spec.mailbox}`);
        } catch (e) {
          log('error', `[email] failed to start ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (rows.length === 0) {
        log('info', '[email] no email triggers registered');
      }
      // Retention sweep on boot (and every 24h via unref'd interval).
      const retentionDays = (() => {
        const raw = process.env.AIDEN_DAEMON_EMAIL_RETENTION_DAYS;
        const n = raw ? Number.parseInt(raw, 10) : NaN;
        return Number.isFinite(n) && n > 0 ? n : 30;
      })();
      try {
        const swept = seenStore.sweep(retentionDays);
        if (swept.deleted > 0) {
          log('info', `[email] retention sweep: deleted ${swept.deleted} email_seen rows older than ${retentionDays}d`);
        }
      } catch { /* best-effort */ }
      const emailRetTimer = setInterval(() => {
        try { seenStore.sweep(retentionDays); }
        catch { /* never let sweep crash */ }
      }, 24 * 60 * 60 * 1000);
      if (typeof emailRetTimer.unref === 'function') emailRetTimer.unref();
    } catch (e) {
      log('error', `[email] trigger registry scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── v4.5 Phase 5b — cron JSON → SQLite migration ─────────────────────
    // Idempotent: only copies rows when scheduled_workflows is empty
    // AND ~/.aiden/cron_jobs.json exists. Subsequent boots return
    // {ran:false, reason:'already_migrated'}. Original JSON file is
    // left in place so AIDEN_DAEMON=0 callers keep working.
    let cronMigrationResult: {
      ran: boolean; migrated: number; skipped: number;
      backupPath: string | null; reason?: string;
    } | null = null;
    try {
      const res = runCronMigration({ db, log });
      cronMigrationResult = {
        ran:        res.ran,
        migrated:   res.migrated,
        skipped:    res.skipped,
        backupPath: res.backupPath,
        reason:     res.reason,
      };
    } catch (e) {
      log('error', `[cron-migration] unhandled failure: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── v4.5 Phase 5b — install daemon-mode cron emitter ─────────────────
    // When AIDEN_DAEMON=1, cron fires go through the trigger bus
    // (consumed by the Phase 5a dispatcher) instead of shelling out.
    // We swap the cronManager's RunActionFn here so any cron heartbeat
    // started by the CLI uses the daemon-mode path.
    //
    // Best-effort import — we don't pull cronManager into the daemon
    // hot path unless the user actually runs cron. The import is
    // lazy so non-cron CLIs don't pay the cost.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cm = require('../cron/cronManager') as typeof import('../cron/cronManager');
      const emitter = createCronEmitter({
        triggerBus, db, log,
      });
      cm.setRunActionForTests(emitter);
      log('info', `[cron-emitter] daemon-mode runAction installed`);
    } catch (e) {
      log('warn', `[cron-emitter] install skipped: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── v4.5 Phase 5a — start the trigger dispatcher ─────────────────────
    // The dispatcher is the bus consumer. It claims pending
    // trigger_events and routes them through the agent loop (or
    // the deliverOnly stub when spec.deliver_only=1). Phase 5a
    // wires a placeholder runner that returns 'stop' immediately
    // — the real AidenAgent-backed runner is wired by the CLI
    // entry path in a follow-up (it owns provider/toolExecutor
    // construction). The dispatcher infrastructure is fully
    // functional NOW; the runner adapter is the last seam.
    let dispatcher: Dispatcher | null = null;
    try {
      // v4.5 Phase 7 — runner selection: real agent when builder
      // injected, placeholder otherwise. Both paths exercise the
      // full bus / claim / lease / markDone / run_events plumbing;
      // the difference is whether real `AidenAgent.runConversation`
      // fires or just an immediate stop.
      const runnerFactory: () => DaemonAgentRunner = opts.agentBuilder
        ? () => createRealAgentRunner({
            db, runStore, resourceRegistry,
            log, agentBuilder: opts.agentBuilder!,
            persistedDefault: opts.persistedDefaultModel,
            // v4.13 Gap 4 — daemon runs carry the durable job-card.
            taskStore: createTaskStore({ db }),
          })
        : () => makeRunner(async (input) => {
          // Phase 5a placeholder runner — used when no AgentBuilder
          // is injected (e.g. user has no provider configured yet).
          // Marks the run completed with finishReason='stop' after
          // creating the run row + emitting a placeholder event.
          // The bus / dispatch / lease / markDone path is fully
          // exercised end-to-end so soak harness + tests still
          // work without a real model wired.
          const runId = runStore.create({
            sessionId:      input.sessionId,
            instanceId:     input.instanceId,
            triggerEventId: input.triggerEventId,
            status:         'running',
          });
          // v4.10 Slice 10.2b — rich emission via the shared taxonomy.
          // Placeholder runner path; still wants a categorised row so
          // trace_query produces consistent shape regardless of which
          // runner was wired.
          const tags = categorizeEvent('dispatcher:invoked');
          runStore.emitEventRich({
            runId,
            category:  tags.category,
            kind:      tags.kind,
            name:      'dispatcher:invoked',
            sessionId: input.sessionId,
            summary:   `placeholder/${input.triggerContext.source}`,
            payload: {
              source:    input.triggerContext.source,
              triggerId: input.triggerContext.triggerId,
              eventId:   input.triggerEventId,
              templated: input.triggerContext.promptTemplate !== null,
              messageLen: input.initialMessage.length,
            },
            visibility:'system',
            source:    'daemon',
          });
          runStore.setStatus(runId, 'completed', { finishReason: 'stop' });
          const result: DaemonAgentResult = { runId, finishReason: 'stop' };
          return result;
        });
      dispatcher = createDispatcher({
        triggerBus,
        runStore,
        db,
        ownerId:       tracker.instanceId,
        instanceId:    tracker.instanceId,
        workerCount:   1,                   // Q-P5-1(a)
        runnerFactory,
        log,
      });
      dispatcher.start();
      log('info', `[dispatcher] active workerCount=1 runner=${opts.agentBuilder ? 'real' : 'placeholder'}`);
      // v4.13 Gap 4 — resume sweep: act on the resume_pending marks
      // crash recovery left. Gated on a REAL runner — re-driving into
      // the placeholder would fake-complete resumed tasks. Best-effort.
      if (opts.agentBuilder) {
        try {
          const sweep = sweepResumePending({
            runStore,
            taskStore: createTaskStore({ db }),
            triggerBus,
            log,
          });
          if (sweep.scanned > 0) {
            log('info', `[resume] sweep: scanned=${sweep.scanned} resumed=${sweep.resumed} needs_user=${sweep.askedUser} abandoned=${sweep.abandoned} skipped=${sweep.skipped}`);
          }
        } catch (e) {
          log('warn', `[resume] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      log('error', `[dispatcher] start failed: ${e instanceof Error ? e.message : String(e)}`);
      dispatcher = null;
    }

    _singleton = {
      active:                true,
      instanceId:            tracker.instanceId,
      ownsHttpServer,
      triggerBus,
      idempotencyStore,
      runStore,
      restartFailureCounter,
      resourceRegistry,
      instanceTracker:       tracker,
      runtimeLock,
      dbPath,
      markerPath,
      httpServer,
      fileWatchers,
      webhookRoutes,
      emailTriggers,
      dispatcher,
      cronMigration: cronMigrationResult,
    };
    return _singleton;
  } catch (e) {
    // Fail-loud but non-fatal: the agent should keep running.
    log('error', `[daemon] foundation init failed: ${e instanceof Error ? e.message : String(e)}`);
    _singleton = NOOP_HANDLE;
    return NOOP_HANDLE;
  }
}

/** Test-only — clears the singleton so subsequent calls re-bootstrap. */
export function _resetDaemonBootstrapForTests(): void {
  _singleton = null;
  // v4.9.0 Slice 3 — also rearm the crash-handler installer guard
  // so a fresh bootstrap in the same test process can install its
  // own handlers without tripping the once-per-process check.
  _crashHandlersInstalled = false;
  // v4.9.0 Slice 4 — clear identity holders too.
  _currentDaemonId      = null;
  _currentIncarnationId = null;
  // v4.9.0 Slice 6 — clear cross-cutting refs too.
  _currentDaemonDb     = null;
  _currentDaemonLogger = null;
}

/** Diagnostic — returns the current handle (or null if not yet bootstrapped). */
export function getDaemonHandle(): DaemonBootstrapHandle | null {
  return _singleton;
}

/**
 * v4.5 Phase 7c — boot the daemon foundation without any agent
 * builder. Drop-in replacement for `bootstrapDaemon()` callers that
 * want the rails (file watchers, webhook routes, email triggers,
 * cron emitter, dispatcher with placeholder runner) up immediately,
 * with the real-agent runner installed later via
 * `installDaemonAgentBuilder()`.
 *
 * Use this at the top of REPL boot (before `buildAgentRuntime`)
 * so the daemon foundation comes up regardless of whether the user
 * has a provider configured. Once `buildAgentRuntime` returns, call
 * `installDaemonAgentBuilder(handle, builder, persistedDefaultModel)`
 * to swap in the real runner.
 *
 * Idempotent — second call returns the existing singleton.
 */
export function bootstrapDaemonFoundation(
  opts: Omit<BootstrapOptions, 'agentBuilder' | 'persistedDefaultModel'> = {},
): DaemonBootstrapHandle {
  return bootstrapDaemon(opts);
}

/**
 * v4.5 Phase 7c — swap the dispatcher's placeholder runner for a
 * real `AidenAgent`-backed one. Safe to call once the REPL's
 * provider, toolRegistry, and prompt builder are constructed.
 *
 * Returns `false` when the foundation isn't active (AIDEN_DAEMON=0
 * or `bootstrapDaemonFoundation` not called) — caller can decide
 * what to do.
 *
 * Returns `true` when the swap succeeded. The dispatcher's next
 * claim uses the new runner; any in-flight claim continues on the
 * placeholder until completion (the placeholder's behavior is
 * instant-stop, so this window is effectively zero).
 */
export function installDaemonAgentBuilder(
  handle:                DaemonBootstrapHandle,
  agentBuilder:          AgentBuilder,
  persistedDefaultModel: { provider: string; model: string } | undefined,
  log?:                  BootstrapOptions['log'],
): boolean {
  if (!handle.active || !handle.dispatcher || !handle.triggerBus || !handle.runStore) {
    return false;
  }
  // v4.9.0 Slice 3 — fall back to the daemon's own structured logger
  // (built lazily here in case the caller skipped passing one). When
  // bootstrap already constructed a logger, the singleton's startup
  // log path used the same composition.
  const fallbackLogger = (() => {
    try { return buildDaemonLogger(path.join(resolveAidenRoot(), 'logs')); }
    catch { return null; }
  })();
  const logFn = log ?? ((level, msg) => {
    if (!fallbackLogger) return;
    if (level === 'error')      fallbackLogger.error(msg);
    else if (level === 'warn')  fallbackLogger.warn(msg);
    else                        fallbackLogger.info(msg);
  });
  try {
    const dbHandle = openDaemonDb(handle.dbPath!);
    const taskStore = createTaskStore({ db: dbHandle });
    const realRunner = createRealAgentRunner({
      db:               dbHandle,
      runStore:         handle.runStore,
      resourceRegistry: handle.resourceRegistry ?? undefined,
      log:              logFn,
      agentBuilder,
      persistedDefault: persistedDefaultModel,
      // v4.13 Gap 4 — daemon runs carry the durable job-card.
      taskStore,
    });
    handle.dispatcher.installRunner(realRunner);
    // v4.13 Gap 4 — with a real runner installed, act on any pending
    // resume marks (the foundation booted with the placeholder, which
    // must never re-drive). Best-effort.
    try {
      const sweep = sweepResumePending({
        runStore:   handle.runStore,
        taskStore,
        triggerBus: handle.triggerBus,
        log:        logFn,
      });
      if (sweep.scanned > 0) {
        logFn('info', `[resume] sweep: scanned=${sweep.scanned} resumed=${sweep.resumed} needs_user=${sweep.askedUser} abandoned=${sweep.abandoned} skipped=${sweep.skipped}`);
      }
    } catch (e) {
      logFn('warn', `[resume] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  } catch (e) {
    logFn('error', `[daemon] installDaemonAgentBuilder failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
