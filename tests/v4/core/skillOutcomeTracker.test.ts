/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 Pillar 6 Slice B — SkillOutcomeTracker, migrated onto the shared
 * rolling-reliability record. Trust is now graded by the run's real task
 * VERDICT (recordTurnVerdict), not the old noisy tool-success window. The
 * window survives only to attach a `lastError` for context. Emits a
 * `skill_outcome` event; a telemetry failure never breaks the turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillOutcomeTracker, isFailure } from '../../../core/v4/skillOutcomeTracker';
import { isQuarantineCandidate } from '../../../core/v4/reliability';
import type { PillarEventSink } from '../../../core/v4/pillarEvents';
import type { ToolCallRequest, ToolCallResult } from '../../../providers/v4/types';

const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest =>
  ({ id: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });
const okResult = (name: string, payload: unknown = { ok: true }): ToolCallResult =>
  ({ id: 'r', name, result: payload });
const errResult = (name: string, error = 'boom'): ToolCallResult =>
  ({ id: 'r', name, result: { error, success: false } });

/** Fire a full skill_view (before+after) so the skill is active this turn. */
function view(t: SkillOutcomeTracker, name: string): void {
  t.onTool(call('skill_view', { name }), 'before');
  t.onTool(call('skill_view', { name }), 'after', okResult('skill_view'));
}

let tmpDir: string; let persistPath: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skill-outcome-'));
  persistPath = path.join(tmpDir, '.skill-outcomes.json');
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('SkillOutcomeTracker — verdict-graded trust', () => {
  it('skill_view records load + lastUsed; no outcome until a verdict', () => {
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'foo');
    const s = t.snapshot()[0];
    expect(s.skillName).toBe('foo');
    expect(s.loaded).toBe(1);
    expect(s.lastUsed).toBeTypeOf('string');
    expect(s.reliability.lastOutcomes).toEqual([]);       // no verdict yet
    expect(s.reliability.rollingPassRate).toBeNull();
  });

  it('recordTurnVerdict(completed) → a PASS folded into the active skill', () => {
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'foo');
    t.recordTurnVerdict('completed');
    const rel = t.snapshot()[0].reliability;
    expect(rel.lastOutcomes).toEqual(['pass']);
    expect(rel.rollingPassRate).toBe(1);
    expect(rel.totalPassed).toBe(1);
  });

  it('a skill active in a verification_failed run → a FAIL (negative signal)', () => {
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'foo');
    t.recordTurnVerdict('verification_failed');
    const rel = t.snapshot()[0].reliability;
    expect(rel.lastOutcomes).toEqual(['fail']);
    expect(rel.rollingPassRate).toBe(0);
  });

  it('completed_unverified → pass; failed → fail', () => {
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'a'); t.recordTurnVerdict('completed_unverified');
    view(t, 'b'); t.recordTurnVerdict('failed');
    const a = t.snapshot().find((s) => s.skillName === 'a')!;
    const b = t.snapshot().find((s) => s.skillName === 'b')!;
    expect(a.reliability.lastOutcomes).toEqual(['pass']);
    expect(b.reliability.lastOutcomes).toEqual(['fail']);
  });

  it('grades EVERY skill used in the turn against the one verdict', () => {
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'x'); view(t, 'y');
    t.recordTurnVerdict('verification_failed');
    for (const name of ['x', 'y']) {
      expect(t.snapshot().find((s) => s.skillName === name)!.reliability.lastOutcomes).toEqual(['fail']);
    }
    // active set cleared — a later verdict does NOT re-grade them.
    view(t, 'z'); t.recordTurnVerdict('completed');
    expect(t.snapshot().find((s) => s.skillName === 'x')!.reliability.lastOutcomes).toEqual(['fail']);
  });

  it('a chronically-failing skill → quarantine candidate', () => {
    const t = new SkillOutcomeTracker(persistPath);
    for (let i = 0; i < 6; i += 1) { view(t, 'flaky'); t.recordTurnVerdict('verification_failed'); }
    const rel = t.snapshot()[0].reliability;
    expect(rel.rollingPassRate).toBe(0);
    expect(isQuarantineCandidate(rel)).toBe(true);
  });

  it('a mostly-passing skill is NOT quarantined', () => {
    const t = new SkillOutcomeTracker(persistPath);
    for (let i = 0; i < 6; i += 1) { view(t, 'good'); t.recordTurnVerdict('completed'); }
    expect(isQuarantineCandidate(t.snapshot()[0].reliability)).toBe(false);
  });

  it('captures lastError from a failed tool inside the window (context only)', () => {
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'foo');
    t.onTool(call('file_read'), 'before');
    t.onTool(call('file_read'), 'after', errResult('file_read', 'ENOENT'));
    expect(t.snapshot()[0].lastError?.message).toBe('ENOENT');
  });

  it('skill_view with an empty name is ignored', () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(call('skill_view', { name: '' }), 'before');
    t.recordTurnVerdict('completed');
    expect(t.snapshot()).toHaveLength(0);
  });

  it('snapshot sorted by load count descending', () => {
    const t = new SkillOutcomeTracker(persistPath);
    for (let i = 0; i < 3; i += 1) view(t, 'rare');
    for (let i = 0; i < 5; i += 1) view(t, 'common');
    expect(t.snapshot()[0].skillName).toBe('common');
  });

  it('emits skill_outcome to both sinks; a throwing sink is swallowed', () => {
    const t = new SkillOutcomeTracker(persistPath);
    const live: string[] = []; const durable: string[] = [];
    const sink: PillarEventSink = {
      runId: 1,
      onEvent: (n) => live.push(n),
      runStore: { emitEventRich: (o) => { durable.push(String(o.name)); return 1; } },
    };
    view(t, 'foo');
    t.recordTurnVerdict('completed', sink);
    expect(live).toContain('skill_outcome');
    expect(durable).toContain('skill_outcome');

    // A throwing durable sink never propagates out of the turn.
    const t2 = new SkillOutcomeTracker(persistPath);
    view(t2, 'bar');
    const throwing: PillarEventSink = { runId: 1, runStore: { emitEventRich: () => { throw new Error('DB down'); } } };
    expect(() => t2.recordTurnVerdict('completed', throwing)).not.toThrow();
  });

  it('persists the reliability record; a fresh tracker hydrates it', async () => {
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'persist-me'); t.recordTurnVerdict('completed');
    await t.flush();
    const t2 = new SkillOutcomeTracker(persistPath);
    view(t2, 'persist-me');   // triggers hydration
    const s = t2.snapshot().find((x) => x.skillName === 'persist-me')!;
    expect(s.loaded).toBe(2);                       // 1 hydrated + 1 new view
    expect(s.reliability.totalPassed).toBe(1);      // the persisted pass survived
    await t2.flush();
  });

  it('tolerates a pre-migration sidecar (old toolSuccesses shape) — still loads, reliability fresh', async () => {
    await fs.writeFile(persistPath, JSON.stringify({
      oldskill: { skillName: 'oldskill', loaded: 3, toolSuccesses: 5, toolFailures: 2, lastUsed: '2026-01-01T00:00:00Z' },
    }), 'utf-8');
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'oldskill');
    const s = t.snapshot()[0];
    expect(s.skillName).toBe('oldskill');
    expect(s.loaded).toBe(4);                        // migrated loaded (3) + this view
    expect(s.reliability.lastOutcomes).toEqual([]);  // rolling record started clean
    await t.flush();
  });

  it('survives a corrupt sidecar file (parse failure → empty start)', async () => {
    await fs.writeFile(persistPath, 'not valid json {{{', 'utf-8');
    const t = new SkillOutcomeTracker(persistPath);
    view(t, 'recover');
    expect(t.snapshot()[0].skillName).toBe('recover');
    await t.flush();
  });
});

describe('isFailure (failure classification — unchanged)', () => {
  it('undefined → success (no signal)', () => expect(isFailure(undefined)).toBe(false));
  it('top-level success===false → failure', () => expect(isFailure({ id: 'x', name: 'x', result: { success: false } } as unknown as ToolCallResult)).toBe(true));
  it('truthy error string → failure', () => expect(isFailure({ id: 'x', name: 'x', result: { error: 'ENOENT' } } as unknown as ToolCallResult)).toBe(true));
  it('{ok:true} → success', () => expect(isFailure({ id: 'x', name: 'x', result: { ok: true } })).toBe(false));
});
