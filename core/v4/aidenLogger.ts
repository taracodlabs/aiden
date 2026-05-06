/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/aidenLogger.ts — Aiden v4.0.0 (Phase 16b.2)
 *
 * Thin file-only logger for diagnostics that must NOT leak into the
 * interactive REPL spinner. Phase 16b.1's smoke gate revealed that the
 * `[SkillLoader] Skipping malformed skill ...` warnings were being emitted
 * via `console.warn` on every turn — they'd race the spinner and corrupt
 * the rendered line.
 *
 * Design:
 *   - One log file per stream name, under `<aidenRoot>/logs/<name>.log`.
 *   - Synchronous append (`fs.appendFileSync`) so the line is durable
 *     even if the process exits mid-turn. Volume is tiny (< 100 lines/boot).
 *   - The logger NEVER writes to stdout/stderr. Anything user-facing must
 *     go through `Display`.
 *   - No external dependencies; falls back to a no-op when the logs dir
 *     can't be written (e.g. read-only volume).
 *
 * This is intentionally narrow — not a general-purpose logger. The day we
 * need leveled queries / rotation / structured fields, replace this with
 * pino. Until then: one helper, one file, one append.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface AidenFileLogger {
  /** Append a line. Failures swallowed. */
  log(level: LogLevel, message: string): void;
  /** Convenience aliases. */
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Where the line went (for diagnostics tooling). */
  readonly filePath: string;
}

/**
 * Build a file-only logger that writes to `<logsDir>/<name>.log`.
 * `logsDir` is created on first write if missing. The returned logger is
 * cheap to construct — call sites can build one per subsystem.
 */
export function createFileLogger(
  logsDir: string,
  name: string,
): AidenFileLogger {
  const filePath = path.join(logsDir, `${name}.log`);
  let dirReady = false;

  const ensureDir = (): boolean => {
    if (dirReady) return true;
    try {
      mkdirSync(logsDir, { recursive: true });
      dirReady = true;
      return true;
    } catch {
      return false;
    }
  };

  const write = (level: LogLevel, message: string): void => {
    if (!ensureDir()) return;
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      appendFileSync(filePath, line, 'utf8');
    } catch {
      // Disk full / permission denied — drop the line. Better than
      // crashing the REPL on a diagnostic.
    }
  };

  return {
    filePath,
    log: write,
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

/**
 * No-op logger for tests / hosts that want to suppress disk writes.
 */
export function createNullLogger(): AidenFileLogger {
  return {
    filePath: '<null>',
    log: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
