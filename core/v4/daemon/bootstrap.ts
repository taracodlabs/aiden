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
import type { RunStore } from './runStore';
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
  const log = opts.log ?? ((level, msg) => {
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else                       console.log(msg);
  });

  if (!cfg.enabled) {
    _singleton = NOOP_HANDLE;
    return NOOP_HANDLE;
  }

  try {
    const aidenRoot  = resolveAidenRoot();
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

    // Module singletons.
    const triggerBus            = createTriggerBus({ db });
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
      markShutdown: (reason: 'sigterm' | 'sigint' | 'sigusr1_restart' | 'crash' | 'replaced', exitCode: number) =>
        tracker.markShutdown(reason, exitCode),
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
          runStore.emitEvent(runId, 'dispatcher:invoked', {
            source:    input.triggerContext.source,
            triggerId: input.triggerContext.triggerId,
            eventId:   input.triggerEventId,
            templated: input.triggerContext.promptTemplate !== null,
            messageLen: input.initialMessage.length,
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
  const logFn = log ?? ((level, msg) => {
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else                       console.log(msg);
  });
  try {
    const realRunner = createRealAgentRunner({
      db:               openDaemonDb(handle.dbPath!),
      runStore:         handle.runStore,
      resourceRegistry: handle.resourceRegistry ?? undefined,
      log:              logFn,
      agentBuilder,
      persistedDefault: persistedDefaultModel,
    });
    handle.dispatcher.installRunner(realRunner);
    return true;
  } catch (e) {
    logFn('error', `[daemon] installDaemonAgentBuilder failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
