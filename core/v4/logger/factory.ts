/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/factory.ts — Phase v4.1-1.3a
 *
 * Build a root `Logger` for the running process based on which mode
 * Aiden is in. Each mode has different invariants:
 *
 *   - cli-interactive  — REPL is sacred. Zero stdout sinks. Errors go
 *                        to stderr (visible to the user without
 *                        touching the chat prompt). Everything to file.
 *   - cli-headless     — `aiden setup`, `aiden doctor`, scripts. No
 *                        REPL to protect. Warnings/errors go to stderr.
 *                        Everything to file. Stdout stays free for the
 *                        command's own output (so users can pipe).
 *   - serve            — daemon. Logs go to stdout as NDJSON for systemd
 *                        / docker / log aggregators. File mirror keeps
 *                        a local trace.
 *   - test             — vitest etc. NullSink only. Pass `withMemory:
 *                        true` to swap in a MemorySink for assertions.
 *
 * Modules NEVER pick their own sinks — they receive a Logger and call
 * `.info()` etc. The factory is the only place mode-routing decisions
 * live.
 */

import { CoreLogger, type Logger } from './logger';
import { FileSink } from './sinks/fileSink';
import { StderrSink, StdoutJsonSink } from './sinks/stdSink';
import { NullSink, MemorySink } from './sinks/nullSink';

export type AidenMode = 'cli-interactive' | 'cli-headless' | 'serve' | 'test' | 'mcp-stdio';

export interface BootLoggerOptions {
  /** Mode picks the sink composition. */
  mode: AidenMode;
  /**
   * Logs directory — file sink writes `<logsDir>/aiden.log`. Optional
   * when `mode === 'test'` (a Null/Memory sink doesn't need it). The
   * CLI passes `paths.logsDir`; api/server passes the same.
   */
  logsDir?: string;
  /**
   * When true (test mode), the returned Logger's only sink is a
   * MemorySink exposed via the second return value for assertions.
   */
  withMemory?: boolean;
}

export interface BootLoggerResult {
  logger: Logger;
  /** Only set when `mode === 'test' && withMemory === true`. */
  memory?: MemorySink;
}

export function createBootLogger(opts: BootLoggerOptions): BootLoggerResult {
  switch (opts.mode) {
    case 'cli-interactive': {
      // v4.10 Slice 10.7a — REPL invariant: ZERO writes to the
      // shared TTY. The pre-Slice-10.7a comment claimed "stderr is
      // allowed for warn/error so a real failure isn't completely
      // silent" — but for an interactive REPL, stderr IS the same
      // TTY as stdin, so warn writes (Telegram polling 409s, channel
      // adapter failures, etc.) splice into the user's typing line.
      //
      // Fix: file sink only. The one user-visible boot warning
      // (spawn-pause notice at aidenCLI.ts:1819) was migrated to
      // display.warn(...) — Display is TTY-aware and coordinates
      // with the prompt lifecycle. Other warn callers are
      // diagnostic and now land in <logsDir>/aiden.log only.
      //
      // The markReplActive() flag at the bottom of this file is
      // additionally wired in chatSession as belt-and-suspenders.
      const sinks: import('./logger').LoggerSink[] = [];
      if (opts.logsDir) sinks.push(new FileSink({ dir: opts.logsDir, name: 'aiden' }));
      return { logger: new CoreLogger({ sinks }) };
    }

    case 'cli-headless': {
      const sinks: import('./logger').LoggerSink[] = [];
      if (opts.logsDir) sinks.push(new FileSink({ dir: opts.logsDir, name: 'aiden' }));
      sinks.push(new StderrSink({ minLevel: 'warn' }));
      return { logger: new CoreLogger({ sinks }) };
    }

    case 'serve': {
      // Daemon — stdout NDJSON for log aggregators, mirror to file for
      // local-on-disk debugging.
      const sinks: import('./logger').LoggerSink[] = [new StdoutJsonSink()];
      if (opts.logsDir) sinks.push(new FileSink({ dir: opts.logsDir, name: 'aiden' }));
      return { logger: new CoreLogger({ sinks }) };
    }

    case 'test': {
      if (opts.withMemory) {
        const memory = new MemorySink();
        return { logger: new CoreLogger({ sinks: [memory] }), memory };
      }
      return { logger: new CoreLogger({ sinks: [new NullSink()] }) };
    }

    case 'mcp-stdio': {
      // Phase v4.1-mcp invariant: stdout carries the JSON-RPC protocol
      // frames — any byte written to stdout outside the MCP transport
      // corrupts the wire. So this mode wires ZERO stdout sinks. Errors
      // and warnings go to stderr (visible to the spawning client's log
      // stream); everything else lands in the file sink for postmortems.
      const sinks: import('./logger').LoggerSink[] = [];
      if (opts.logsDir) sinks.push(new FileSink({ dir: opts.logsDir, name: 'aiden-mcp' }));
      sinks.push(new StderrSink({ minLevel: 'warn' }));
      return { logger: new CoreLogger({ sinks }) };
    }
  }
}

/**
 * No-op singleton — what `attachLogger()` setters fall back to when no
 * caller has wired in a real one yet. Avoids null-checks at every emit
 * site. Lazy-built so tests that import this module don't allocate
 * sinks they'll never touch.
 */
let _noop: Logger | null = null;
export function noopLogger(): Logger {
  if (!_noop) _noop = new CoreLogger({ sinks: [new NullSink()] });
  return _noop;
}

/**
 * Phase v4.1-1.3a — process-wide flag tripped once the chat prompt is
 * up. The repl-sacred invariant in `cli-interactive` mode comes from
 * the factory not wiring any stdout sink, but a defense-in-depth layer:
 * if any future code path manages to grab stdout directly, this flag
 * lets us assert in tests + audit.
 */
let _replActive = false;
export function markReplActive(): void { _replActive = true; }
export function markReplInactive(): void { _replActive = false; }
export function isReplActive(): boolean { return _replActive; }
