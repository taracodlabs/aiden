/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/fileWatcher.ts — v4.5 Phase 2: the
 * file-watcher trigger source.
 *
 * Wires chokidar 4.x into the Phase 1 trigger bus. One module-level
 * factory `createFileWatcher(spec)` returns a handle that:
 *   - subscribes to add/change/unlink events
 *   - filters via the glob matcher (default ignores + spec globs)
 *   - debounces per-path (default 750ms)
 *   - settles via a stat loop (default 1s) — second layer on top
 *     of chokidar's `awaitWriteFinish`
 *   - upserts a file_observations row + inserts a trigger_event
 *     under the bus's UNIQUE(source, idempotency_key) dedup
 *   - registers itself in the resourceRegistry for shutdown reap
 *   - exposes `stats()` for /metrics + diagnostics
 *
 * Backpressure: per-watcher queue depth (default 100). When full,
 * new events DROP with a log + stats counter bump (Q-P2-5 default).
 * Pausing chokidar would cause a resync-burst on resume — drop-new
 * is the correct trade-off.
 */

import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import type { TriggerBus } from '../triggerBus';
import type { ResourceRegistry } from '../resourceRegistry';
import type { FileObservationsStore } from './fileObservationsStore';
import type { FileWatcherSpec, FileEventType } from './fileWatcherSpec';
import { compileGlobMatcher } from './globMatcher';
import { computeFileKey } from './fsIdentity';
import { settleStat } from './settleStat';

export interface FileWatcherStats {
  queueDepth:  number;
  emitted:     number;
  coalesced:   number;
  skipped:     number;
  dropped:     number;
  overflowed:  boolean;
  lastError:   string | null;
}

export interface FileWatcherHandle {
  readonly watcherId:  string;
  readonly resourceId: string;
  pause():   void;
  resume():  void;
  close():   Promise<void>;
  stats():   FileWatcherStats;
}

export interface CreateFileWatcherOptions {
  watcherId:   string;
  spec:        FileWatcherSpec;
  triggerBus:  TriggerBus;
  obsStore:    FileObservationsStore;
  registry:    ResourceRegistry;
  log?:        (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface QueueEntry {
  absPath:     string;
  eventType:   FileEventType;
  enqueuedAt:  number;
  coalesced:   number;          // additional events merged into this one
  timer:       NodeJS.Timeout | null;
}

const noopLog = (_level: 'info' | 'warn' | 'error', _msg: string): void => undefined;

export function createFileWatcher(opts: CreateFileWatcherOptions): FileWatcherHandle {
  const { watcherId, spec, triggerBus, obsStore, registry } = opts;
  const log = opts.log ?? noopLog;

  const matcher = compileGlobMatcher({
    includeGlobs: spec.includeGlobs,
    excludeGlobs: spec.excludeGlobs,
    ignoreTemp:   spec.ignoreTemp,
  });

  // Per-path pending queue. Map key = absPath; one entry per path.
  const queue: Map<string, QueueEntry> = new Map();
  const acceptedEventTypes = new Set<FileEventType>(spec.eventTypes);
  let paused = false;

  const stats: FileWatcherStats = {
    queueDepth: 0,
    emitted:    0,
    coalesced:  0,
    skipped:    0,
    dropped:    0,
    overflowed: false,
    lastError:  null,
  };

  // ── chokidar setup ──────────────────────────────────────────────────────
  const watchOptions: Parameters<typeof chokidar.watch>[1] = {
    persistent:      true,
    ignoreInitial:   true,                   // boot-time reconciliation runs separately
    depth:           spec.recursive ? undefined : 0,
    awaitWriteFinish: {
      stabilityThreshold: Math.max(50, spec.settleMs),
      pollInterval:       100,
    },
    usePolling:      spec.polling?.enabled === true,
    // chokidar validates these fields as numbers when present. Do not pass
    // explicit undefined for `--polling` specs that rely on chokidar defaults.
    ...(typeof spec.polling?.intervalMs === 'number'
      ? { interval: spec.polling.intervalMs }
      : {}),
    ...(typeof spec.polling?.binaryIntervalMs === 'number'
      ? { binaryInterval: spec.polling.binaryIntervalMs }
      : {}),
    // chokidar 4.x removed built-in globs — we filter via picomatch
    // in handleEvent below.
  };

  const watcher: FSWatcher = chokidar.watch(spec.paths, watchOptions);

  // ── core event handler ──────────────────────────────────────────────────
  const handleEvent = (eventType: FileEventType, absPath: string): void => {
    if (paused) return;
    if (!acceptedEventTypes.has(eventType)) {
      stats.skipped += 1;
      return;
    }
    if (!matcher.match(absPath)) {
      stats.skipped += 1;
      return;
    }

    // Unlink bypasses debounce + settle — the file is gone.
    if (eventType === 'unlink') {
      void emit(absPath, 'unlink', null);
      return;
    }

    // Coalesce repeated events for the same path within the debounce window.
    const existing = queue.get(absPath);
    if (existing) {
      existing.coalesced += 1;
      // Reset the debounce timer.
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => { void flush(absPath); }, spec.debounceMs);
      if (typeof existing.timer.unref === 'function') existing.timer.unref();
      return;
    }

    if (queue.size >= spec.maxQueueDepth) {
      stats.dropped += 1;
      if (!stats.overflowed) {
        stats.overflowed = true;
        log('warn', `[file-watcher] queue overflow at ${watcherId} — dropping events (depth=${queue.size}, max=${spec.maxQueueDepth})`);
      }
      return;
    }

    const entry: QueueEntry = {
      absPath,
      eventType,
      enqueuedAt: Date.now(),
      coalesced:  0,
      timer:      null,
    };
    entry.timer = setTimeout(() => { void flush(absPath); }, spec.debounceMs);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    queue.set(absPath, entry);
    stats.queueDepth = queue.size;
  };

  // ── flush + settle + emit ───────────────────────────────────────────────
  const flush = async (absPath: string): Promise<void> => {
    const entry = queue.get(absPath);
    if (!entry) return;
    queue.delete(absPath);
    stats.queueDepth = queue.size;
    if (stats.overflowed && queue.size <= Math.floor(spec.maxQueueDepth / 2)) {
      stats.overflowed = false;
      log('info', `[file-watcher] queue drained at ${watcherId}`);
    }

    // Settle: stat repeatedly until stable.
    const stable = await settleStat(absPath, {
      intervalMs:  Math.max(50, spec.settleMs),
      maxSettleMs: spec.maxSettleMs,
    });
    if (stable === null) {
      // File vanished mid-settle; treat as unlink.
      void emit(absPath, 'unlink', null, entry.coalesced);
      return;
    }
    void emit(absPath, entry.eventType, stable, entry.coalesced);
  };

  const emit = async (
    absPath:        string,
    eventType:      FileEventType,
    stable:         { size: number; mtimeMs: number } | null,
    coalescedDelta: number = 0,
  ): Promise<void> => {
    try {
      const fileKey  = computeFileKey(absPath);
      const size     = stable?.size ?? null;
      const mtimeMs  = stable?.mtimeMs ?? Date.now();
      const contentHash = spec.contentHash && eventType !== 'unlink' && stable !== null
        ? await sha256OfFile(absPath)
        : null;

      const observationId = obsStore.upsert({
        watcherId,
        absPath,
        fileKey,
        size,
        mtimeMs,
        contentHash,
        eventType,
        coalescedDelta,
      });

      const idempotencyKey = `${absPath}::${mtimeMs}::${size ?? 'null'}`;
      const insertResult = triggerBus.insert({
        source:         'file',
        sourceKey:      watcherId,
        idempotencyKey,
        payload:        {
          absPath,
          eventType,
          mtime:        mtimeMs,
          size,
          fileKey,
          contentHash,
          watcherId,
        },
      });

      obsStore.markProcessed({
        observationId,
        eventId: insertResult.id,
        status: 'pending',
      });

      stats.emitted   += 1;
      stats.coalesced += coalescedDelta;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stats.lastError = msg;
      log('error', `[file-watcher] emit failed for ${absPath}: ${msg}`);
    }
  };

  // ── wire chokidar events ────────────────────────────────────────────────
  watcher.on('add',    (p) => handleEvent('add',    path.resolve(p)));
  watcher.on('change', (p) => handleEvent('change', path.resolve(p)));
  watcher.on('unlink', (p) => handleEvent('unlink', path.resolve(p)));
  watcher.on('error',  (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    stats.lastError = msg;
    log('error', `[file-watcher] chokidar error at ${watcherId}: ${msg}`);
  });

  // ── resource registry ───────────────────────────────────────────────────
  const close = async (): Promise<void> => {
    paused = true;
    // Cancel pending debounce timers.
    for (const e of queue.values()) {
      if (e.timer) clearTimeout(e.timer);
    }
    queue.clear();
    stats.queueDepth = 0;
    try { await watcher.close(); }
    catch (e) {
      log('warn', `[file-watcher] close error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const resourceId = registry.register({
    kind:  'file_watcher',
    owner: watcherId,
    metadata: { paths: spec.paths },
    close,
  });

  return {
    watcherId,
    resourceId,
    pause(): void  { paused = true; },
    resume(): void { paused = false; },
    close,
    stats(): FileWatcherStats { return { ...stats }; },
  };
}

// ── SHA-256 of file contents (opt-in via spec.contentHash) ─────────────────

function sha256OfFile(absPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      const h = crypto.createHash('sha256');
      const stream = fs.createReadStream(absPath);
      stream.on('data', (chunk: Buffer | string) => { h.update(chunk); });
      stream.on('error', () => resolve(null));
      stream.on('end',   () => resolve(h.digest('hex')));
    } catch {
      resolve(null);
    }
  });
}
