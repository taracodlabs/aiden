/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/workbench/bridgeMain.ts — runnable entry for the Workbench bridge.
 *
 * Opens the SHARED daemon run-event store (the exact db the CLI writes to via
 * replRunStore, and the daemon dispatcher writes to via its run store) and
 * starts the read-only SSE bridge on loopback. Because the store is shared, the
 * bridge can follow a live CLI or daemon turn with no IPC and no agent coupling.
 *
 * Run (after `npm run build` / tsc → dist):
 *   node dist/core/v4/workbench/bridgeMain.js
 *   WORKBENCH_BRIDGE_PORT=4280 node dist/core/v4/workbench/bridgeMain.js
 *
 * Then follow a session (find its id via `aiden runs`), e.g.:
 *   curl -N http://127.0.0.1:4280/api/sessions/<sessionId>/events
 */

import { resolveAidenPaths } from '../paths';
import { daemonDbPath } from '../daemon/daemonConfig';
import { openDaemonDb } from '../daemon/db/connection';
import { createRunStore } from '../daemon/runStore';
import { SessionStore } from '../sessionStore';
import { startWorkbenchBridge } from './bridgeServer';
import { createSessionLister } from './sessionList';

async function main(): Promise<void> {
  const paths  = resolveAidenPaths();
  const dbPath = daemonDbPath(paths.root);
  const db     = openDaemonDb(dbPath);
  const runStore = createRunStore({ db });
  const sessions = createSessionLister(new SessionStore(paths.sessionsDb));

  const port = Number(process.env.WORKBENCH_BRIDGE_PORT ?? 4280);
  const bridge = await startWorkbenchBridge({
    reader: runStore,
    sessions,
    port,
    log: (m) => console.log(`[workbench-bridge] ${m}`),
  });

  console.log(`[workbench-bridge] read-only event stream at http://${bridge.host}:${bridge.port}`);
  console.log('[workbench-bridge]   GET /api/sessions/<sessionId>/events   (SSE replay + live tail)');
  console.log('[workbench-bridge]   GET /api/runs/<runId>/events           (SSE replay + live tail)');
  console.log('[workbench-bridge]   GET /api/health');
  console.log(`[workbench-bridge]   store: ${dbPath}`);

  const shutdown = (): void => { void bridge.close().finally(() => process.exit(0)); };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('[workbench-bridge] fatal:', e); process.exit(1); });
