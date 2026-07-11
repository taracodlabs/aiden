import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeOneShotTurn } from '../../cli/v4/aidenCLI';
import { recordTurnDivergence } from '../../core/v4/verificationAudit';
import { resolveAidenPaths } from '../../core/v4/paths';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// These are the MISSING layer: the unit tests exercised compareVerifiers
// directly and stayed green while production was inert. Here we drive real turn
// seams end-to-end and assert a record file actually lands on disk.

let root: string;   // the audit root (AIDEN_HOME-style)
let work: string;   // the working dir where the "written" file really exists
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'aiden-audit-'));
  work = mkdtempSync(path.join(os.tmpdir(), 'aiden-work-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

/** A trace for a SUCCESSFUL file_write — legacy will finalize `completed`, the
 *  tool-derived shadow will say `unverified` (coverage unknown): a guaranteed
 *  divergence. The file is really created so the legacy on-disk check passes. */
function successfulWriteTrace(): { trace: HonestyTraceEntry[]; file: string } {
  const file = path.join(work, 'out.txt');
  writeFileSync(file, 'data');
  const trace = [{
    name: 'file_write',
    handlerMutates: true,
    result: { path: file, bytesWritten: 4 },
    verification: { ok: true, code: 'ok', confidence: 1 },
  }] as unknown as HonestyTraceEntry[];
  return { trace, file };
}

function readRecords(logPath: string): Record<string, unknown>[] {
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('divergence audit wiring — the seam, end to end (was inert)', () => {
  it('1. headless executeOneShotTurn with a divergent turn WRITES a record to disk', async () => {
    const paths = resolveAidenPaths({ rootOverride: root });
    const { trace } = successfulWriteTrace();
    const agent = {
      runConversation: async () => ({ finalContent: 'done', finishReason: 'stop', toolCallTrace: trace }),
    };

    // precondition: the audit dir must NOT exist yet (the reported symptom)
    expect(existsSync(paths.verificationAuditDir)).toBe(false);

    const code = await executeOneShotTurn({
      agent, prompt: 'make a file', writeOut: () => {}, writeErr: () => {},
      paths, cwd: work,
    });

    expect(code).toBe(0);
    // THE assertion that was missing: a record file actually lands on disk.
    expect(existsSync(paths.verificationDivergenceLog)).toBe(true);
    const records = readRecords(paths.verificationDivergenceLog);
    expect(records).toHaveLength(1);
    expect(records[0].bucket).toBe('EXPECTED_STRICTNESS');
    expect(records[0].legacyVerdict).toBe('completed');
    expect(records[0].newVerdict).toBe('unverified');
    expect(records[0].turnId).toBe('oneshot');
  });

  it('1b. headless with NO paths writes nothing (zero I/O when unconfigured)', async () => {
    const { trace } = successfulWriteTrace();
    const agent = { runConversation: async () => ({ finalContent: 'x', finishReason: 'stop', toolCallTrace: trace }) };
    await executeOneShotTurn({ agent, prompt: 'x', writeOut: () => {}, writeErr: () => {} /* no paths */ });
    // nothing to assert on disk — just that it didn't throw and no audit root appeared
    expect(existsSync(path.join(root, 'verification-audit'))).toBe(false);
  });

  it('2. ChatSession seam — recordTurnDivergence fires with paths + a legacyView and NO task store', () => {
    const paths = resolveAidenPaths({ rootOverride: root });
    const { trace } = successfulWriteTrace();

    expect(existsSync(paths.verificationAuditDir)).toBe(false);

    // exactly the call ChatSession now makes (legacyView projected from the
    // authoritative fin), with no task store anywhere in sight.
    const rec = recordTurnDivergence({
      paths, cwd: work, now: 100, turnId: 'repl-run-7', taskId: '7',
      trace,
      legacyView: { status: 'completed', failures: [], handleCodes: ['ok'] },
    });

    expect(rec).not.toBeNull();
    expect(rec!.bucket).toBe('EXPECTED_STRICTNESS');
    expect(rec!.legacyVerdict).toBe('completed');
    expect(rec!.newVerdict).toBe('unverified');
    expect(existsSync(paths.verificationDivergenceLog)).toBe(true);
    expect(readRecords(paths.verificationDivergenceLog)).toHaveLength(1);
  });

  it('3. the legacy verdict recorded matches what was finalized — headless computes it fresh, no phantom', () => {
    // A write whose file does NOT exist → legacy on-disk check fails →
    // verification_failed. The recorded legacyVerdict must reflect THAT, not a
    // rosy 'completed' the user never saw.
    const paths = resolveAidenPaths({ rootOverride: root });
    const missing = path.join(work, 'never-written.txt');   // deliberately absent
    const trace = [{
      name: 'file_write', handlerMutates: true,
      result: { path: missing, bytesWritten: 4 },
      verification: { ok: true, code: 'ok', confidence: 1 },
    }] as unknown as HonestyTraceEntry[];

    const rec = recordTurnDivergence({
      paths, cwd: work, now: 1, turnId: 'oneshot', trace,
      finalize: { finishReason: 'stop', fileExists: (p) => existsSync(p) },
    });

    expect(rec).not.toBeNull();
    expect(rec!.legacyVerdict).toBe('verification_failed');   // honest — not 'completed'
  });
});
