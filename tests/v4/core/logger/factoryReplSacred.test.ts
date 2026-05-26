/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.7a — REPL-sacred logger contract regression layer.
 *
 * Background: pre-Slice-10.7a, cli-interactive mode included a
 * StderrSink at minLevel='warn'. On an interactive TTY, stderr and
 * stdin share the same terminal, so warn-level emissions from
 * background subsystems (channels.telegram polling 409s, channel
 * adapter failures, hook auto-disables, etc.) spliced into the
 * user's prompt typing line.
 *
 * Slice 10.7a removed StderrSink from cli-interactive. The user-
 * visible spawn-pause boot warning migrated to display.warn(). All
 * other warn callers now land only in the file log — postmortem
 * trail, not real-time TTY interruption.
 *
 * Tests in this file are the regression layer. The behavioral check
 * is the load-bearing one: write a warn through the cli-interactive
 * logger and assert NOTHING reaches process.stderr. If a future
 * refactor re-adds StderrSink (or any other TTY-writing sink), the
 * stderr-spy test fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  createBootLogger,
  isReplActive,
  markReplActive,
  markReplInactive,
} from '../../../../core/v4/logger/factory';

let tmp: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-logger-test-'));
  markReplInactive();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  markReplInactive();
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  await fs.rm(tmp, { recursive: true, force: true });
});

// ─── Behavioral: writes through the logger never reach the TTY ────────

describe('createBootLogger cli-interactive — TTY-write behavioral contract', () => {
  it('warn() through cli-interactive logger does NOT write to process.stderr', () => {
    const { logger } = createBootLogger({ mode: 'cli-interactive', logsDir: tmp });
    logger.warn('this should NOT appear on stderr (Slice 10.7a invariant)');
    expect(stderrSpy,
      'cli-interactive must not emit warn to stderr — that splices into the REPL TTY (Slice 10.7a fix). ' +
      'If you re-added a StderrSink to this mode, route the user-visible warning through display.warn instead.',
    ).not.toHaveBeenCalled();
  });

  it('error() through cli-interactive logger does NOT write to process.stderr', () => {
    const { logger } = createBootLogger({ mode: 'cli-interactive', logsDir: tmp });
    logger.error('this should NOT appear on stderr');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('cli-interactive logger does NOT write to process.stdout (chat surface stays clean)', () => {
    const { logger } = createBootLogger({ mode: 'cli-interactive', logsDir: tmp });
    logger.info('not for stdout');
    logger.warn('not for stdout');
    logger.error('not for stdout');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('warn() through cli-interactive logger DOES land in the file log (postmortem trail preserved)', async () => {
    const { logger } = createBootLogger({ mode: 'cli-interactive', logsDir: tmp });
    const marker = 'unique-marker-' + Date.now();
    logger.warn(marker, { test: true });
    // FileSink writes synchronously via appendFileSync per the codebase
    // convention; readback should see the marker.
    const logFile = path.join(tmp, 'aiden.log');
    // Allow at most one tick for any pending write to land.
    await new Promise((res) => setImmediate(res));
    const content = await fs.readFile(logFile, 'utf8').catch(() => '');
    expect(content).toContain(marker);
  });
});

// ─── Non-REPL modes still write to stderr (no regression) ─────────────

describe('createBootLogger — non-interactive modes still emit to stderr', () => {
  it('cli-headless writes warn to stderr', () => {
    const { logger } = createBootLogger({ mode: 'cli-headless', logsDir: tmp });
    logger.warn('headless warn');
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('mcp-stdio writes warn to stderr (stdout reserved for JSON-RPC frames)', () => {
    const { logger } = createBootLogger({ mode: 'mcp-stdio', logsDir: tmp });
    logger.warn('mcp warn');
    expect(stderrSpy).toHaveBeenCalled();
    // stdout MUST stay clean — that's the JSON-RPC channel.
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('serve mode writes info to stdout as NDJSON (log aggregators), not stderr', () => {
    const { logger } = createBootLogger({ mode: 'serve', logsDir: tmp });
    logger.info('serve info');
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ─── markReplActive flag wiring ───────────────────────────────────────

describe('markReplActive — defense-in-depth flag', () => {
  it('starts false at module load', () => {
    expect(isReplActive()).toBe(false);
  });

  it('flips true when marked active', () => {
    markReplActive();
    expect(isReplActive()).toBe(true);
  });

  it('flips false when marked inactive', () => {
    markReplActive();
    markReplInactive();
    expect(isReplActive()).toBe(false);
  });

  it('chatSession source contract: imports + calls markReplActive AND markReplInactive', async () => {
    // Source-level guard: the flag exists for defense-in-depth.
    // chatSession is the canonical caller; if a future refactor
    // severs the call, the flag becomes dead code. This grep
    // catches that regression.
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../../cli/v4/chatSession.ts'),
      'utf8',
    );
    expect(src).toMatch(/import\s+\{\s*markReplActive\s*,\s*markReplInactive\s*\}/);
    expect(src).toMatch(/\bmarkReplActive\s*\(\s*\)/);
    expect(src).toMatch(/\bmarkReplInactive\s*\(\s*\)/);
  });
});

// ─── Source-contract guard on the user-visible warn migration ─────────

describe('aidenCLI source contract — spawn-pause warn migrated to display.warn', () => {
  it('uses display.warn (not bootLogger.warn) for the user-visible spawn-pause notice', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../../cli/v4/aidenCLI.ts'),
      'utf8',
    );
    // The 10-line region around the spawn-pause boot block MUST
    // contain display.warn and MUST NOT contain bootLogger.warn —
    // because under Slice 10.7a bootLogger no longer routes warn to
    // the TTY in cli-interactive.
    const region = src.match(
      /v4\.6 Phase 3A — startup probe for the spawn-pause[\s\S]{0,2000}/,
    );
    expect(region, 'spawn-pause block not found in expected shape').not.toBeNull();
    expect(region![0]).toMatch(/display\.warn\(/);
    // Tolerate `bootLogger.info(...)` for the structured-context
    // record but reject `bootLogger.warn(` which is the regressed call.
    expect(region![0]).not.toMatch(/bootLogger\.warn\(/);
  });
});
