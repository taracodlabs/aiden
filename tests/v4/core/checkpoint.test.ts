/**
 * v4.2 Phase 4 — Checkpoint / restore unit tests.
 *
 * Coverage:
 *   1. Ring buffer behaviour: capture / depth-limited rollover /
 *      checkpointDepth=0 disables / depth honored
 *   2. captureCheckpoint short-circuits when AIDEN_TCE=0 (regression
 *      sentinel)
 *   3. markMutationOnLiveCheckpoint flags every active checkpoint
 *      (including older ones, since rolling back to ANY of them
 *      would skip the mutation)
 *   4. findRestorableCheckpoint skips containedMutations=true (HARD
 *      BLOCK enforcement)
 *   5. findRestorableCheckpoint walks newest-to-oldest
 *   6. restoreInternalsFrom rewrites state + trims ring buffer
 *   7. reapplyCooldown re-cools tool + advances stage
 *   8. buildRollbackMessage formatting (with + without blockedBy)
 *   9. Full integration: capture → mark mutation → cooldown decision
 *      returns plain cooldown (no rollback, HARD BLOCK) →
 *      no-mutation path returns cooldown_with_rollback
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TurnState } from '../../../core/v4/turnState';
import { buildRollbackMessage } from '../../../core/v4/checkpoint';
import type { Message } from '../../../providers/v4/types';

function mkMsg(role: 'user' | 'assistant' | 'system', content: string): Message {
  return { role, content };
}

describe('TurnState — Phase 4 ring buffer', () => {
  beforeEach(() => { process.env.AIDEN_TCE = '1'; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  it('captureCheckpoint short-circuits when AIDEN_TCE=0 (opt-out regression sentinel)', () => {
    // v4.2 Phase 6 — TCE is ON by default; explicit `=0` opts out.
    process.env.AIDEN_TCE = '0';
    const ts = new TurnState();
    expect(ts.isEnabled()).toBe(false);
    ts.captureCheckpoint([mkMsg('user', 'hi')], 0);
    expect(ts.getCheckpoints()).toHaveLength(0);
  });

  it('capture appends to ring buffer up to checkpointDepth', () => {
    const ts = new TurnState({ checkpointDepth: 3 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.captureCheckpoint([mkMsg('user', 'b')], 1);
    ts.captureCheckpoint([mkMsg('user', 'c')], 2);
    expect(ts.getCheckpoints().map((c) => c.iteration)).toEqual([0, 1, 2]);
  });

  it('ring rolls over once depth is exceeded — oldest dropped', () => {
    const ts = new TurnState({ checkpointDepth: 2 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.captureCheckpoint([mkMsg('user', 'b')], 1);
    ts.captureCheckpoint([mkMsg('user', 'c')], 2);
    expect(ts.getCheckpoints().map((c) => c.iteration)).toEqual([1, 2]);
  });

  it('checkpointDepth=0 disables the buffer (no captures stored)', () => {
    const ts = new TurnState({ checkpointDepth: 0 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    expect(ts.getCheckpoints()).toHaveLength(0);
  });

  it('negative checkpointDepth coerces to 0', () => {
    const ts = new TurnState({ checkpointDepth: -1 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    expect(ts.getCheckpoints()).toHaveLength(0);
  });

  it('captured messages array is a separate reference (shallow clone)', () => {
    const ts = new TurnState();
    const msgs: Message[] = [mkMsg('user', 'a')];
    ts.captureCheckpoint(msgs, 0);
    const captured = ts.getCheckpoints()[0].messages;
    expect(captured).not.toBe(msgs);
    expect(captured).toEqual(msgs);
  });
});

describe('TurnState — Phase 4 mutation flagging', () => {
  beforeEach(() => { process.env.AIDEN_TCE = '1'; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  it('flags the live checkpoint + every older one when mutation seen', () => {
    const ts = new TurnState({ checkpointDepth: 3 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.captureCheckpoint([mkMsg('user', 'b')], 1);
    ts.captureCheckpoint([mkMsg('user', 'c')], 2);
    ts.markMutationOnLiveCheckpoint('file_write');
    for (const cp of ts.getCheckpoints()) {
      expect(cp.containedMutations).toBe(true);
      expect(cp.mutatingToolsSinceCheckpoint).toContain('file_write');
    }
  });

  it('mark is no-op when AIDEN_TCE=0 (opt-out)', () => {
    process.env.AIDEN_TCE = '0';
    const ts = new TurnState();
    ts.markMutationOnLiveCheckpoint('file_write');
    expect(ts.getCheckpoints()).toHaveLength(0);
  });

  it('mark is no-op when buffer is empty', () => {
    const ts = new TurnState();
    ts.markMutationOnLiveCheckpoint('file_write');
    expect(ts.getCheckpoints()).toHaveLength(0);
  });

  it('duplicate tool name not added twice', () => {
    const ts = new TurnState();
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.markMutationOnLiveCheckpoint('file_write');
    ts.markMutationOnLiveCheckpoint('file_write');
    expect(ts.getCheckpoints()[0].mutatingToolsSinceCheckpoint).toEqual(['file_write']);
  });

  it('multiple distinct tools accumulate on the same checkpoint', () => {
    const ts = new TurnState();
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.markMutationOnLiveCheckpoint('file_write');
    ts.markMutationOnLiveCheckpoint('shell_exec');
    const tools = ts.getCheckpoints()[0].mutatingToolsSinceCheckpoint;
    expect(tools).toEqual(['file_write', 'shell_exec']);
  });
});

describe('TurnState — Phase 4 findRestorableCheckpoint', () => {
  beforeEach(() => { process.env.AIDEN_TCE = '1'; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  it('returns null when buffer empty', () => {
    const ts = new TurnState();
    expect(ts.findRestorableCheckpoint()).toBeNull();
  });

  it('returns null when disabled (opt-out via AIDEN_TCE=0)', () => {
    process.env.AIDEN_TCE = '0';
    const ts = new TurnState();
    expect(ts.findRestorableCheckpoint()).toBeNull();
  });

  it('returns the most recent checkpoint when none mutate', () => {
    const ts = new TurnState({ checkpointDepth: 3 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.captureCheckpoint([mkMsg('user', 'b')], 1);
    ts.captureCheckpoint([mkMsg('user', 'c')], 2);
    expect(ts.findRestorableCheckpoint()?.iteration).toBe(2);
  });

  it('returns null when ALL checkpoints flagged (HARD BLOCK)', () => {
    const ts = new TurnState({ checkpointDepth: 3 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.captureCheckpoint([mkMsg('user', 'b')], 1);
    ts.markMutationOnLiveCheckpoint('file_write');
    // After mark, BOTH checkpoints are flagged. None restorable.
    expect(ts.findRestorableCheckpoint()).toBeNull();
  });

  it('returns the older checkpoint when mutation happens AFTER it was captured (but flagging propagates)', () => {
    // Subtle case: when mark fires AFTER multiple captures, the mark
    // propagates to ALL active checkpoints (because rolling back to
    // any of them would skip the mutation). Older ones are still
    // ineligible.
    const ts = new TurnState({ checkpointDepth: 3 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    // No mutation here.
    ts.captureCheckpoint([mkMsg('user', 'b')], 1);
    // Now a mutation happens after capture 1.
    ts.markMutationOnLiveCheckpoint('file_write');
    // Both checkpoints flagged; nothing restorable.
    expect(ts.findRestorableCheckpoint()).toBeNull();
  });
});

describe('TurnState — Phase 4 restoreInternalsFrom', () => {
  beforeEach(() => { process.env.AIDEN_TCE = '1'; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  it('rewrites stage / counters / arrays to checkpoint state', () => {
    const ts = new TurnState();
    // Capture clean baseline.
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    const cp = ts.getCheckpoints()[0];

    // Dirty up TurnState — record some calls.
    ts.recordToolCall('foo', { x: 1 });
    ts.recordToolCall('foo', { x: 2 });
    ts.recordToolCall('foo', { x: 3 });
    const dirtySnap = ts.getDiagnosticSnapshot();
    expect(dirtySnap.toolCalls.length).toBe(3);

    // Restore.
    ts.restoreInternalsFrom(cp);
    const restoredSnap = ts.getDiagnosticSnapshot();
    expect(restoredSnap.toolCalls).toHaveLength(0);
    expect(restoredSnap.consecName).toEqual({ name: null, count: 0 });
    expect(restoredSnap.stage).toBe('none');
  });

  it('trims ring buffer to entries older than the restored checkpoint', () => {
    const ts = new TurnState({ checkpointDepth: 3 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.captureCheckpoint([mkMsg('user', 'b')], 1);
    ts.captureCheckpoint([mkMsg('user', 'c')], 2);
    const oldest = ts.getCheckpoints()[0];
    ts.restoreInternalsFrom(oldest);
    // Everything from `oldest` onwards is dropped; nothing left.
    expect(ts.getCheckpoints()).toHaveLength(0);
  });

  it('no-op when disabled (opt-out via AIDEN_TCE=0)', () => {
    const liveTs = new TurnState();
    liveTs.captureCheckpoint([mkMsg('user', 'a')], 0);
    const cp = liveTs.getCheckpoints()[0];

    process.env.AIDEN_TCE = '0';
    const ts = new TurnState();
    // Set state visible via snapshot — restoreInternalsFrom should not touch it.
    ts.restoreInternalsFrom(cp);
    expect(ts.getDiagnosticSnapshot().enabled).toBe(false);
  });
});

describe('TurnState — Phase 4 reapplyCooldown', () => {
  beforeEach(() => { process.env.AIDEN_TCE = '1'; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  it('re-cools the tool and promotes stage to cooldown', () => {
    const ts = new TurnState();
    ts.reapplyCooldown('shell_exec');
    expect(ts.getCooledDownTools()).toContain('shell_exec');
    expect(ts.getDiagnosticSnapshot().stage).toBe('cooldown');
  });

  it('does not regress stage when already surfaced', () => {
    const ts = new TurnState({
      hintConsecThreshold: 1, cooldownConsecThreshold: 1, surfaceConsecThreshold: 1,
    });
    // Drive stage to 'surfaced'.
    ts.recordToolCall('x', {});
    expect(ts.getDiagnosticSnapshot().stage).toBe('surfaced');
    ts.reapplyCooldown('y');
    // Still surfaced — reapply does not regress.
    expect(ts.getDiagnosticSnapshot().stage).toBe('surfaced');
  });

  it('no-op when disabled (opt-out via AIDEN_TCE=0)', () => {
    process.env.AIDEN_TCE = '0';
    const ts = new TurnState();
    ts.reapplyCooldown('shell_exec');
    expect(ts.getCooledDownTools()).toHaveLength(0);
  });
});

describe('TurnState — Phase 4 cooldown emits cooldown_with_rollback when eligible', () => {
  beforeEach(() => { process.env.AIDEN_TCE = '1'; });
  afterEach(()  => { delete process.env.AIDEN_TCE; });

  // v4.13 — cooldown gates on LOOP-LIKE streaks (identical args or
  // consecutive failures); these varied-args loops now drive the
  // failure streak, matching the real stuck-loop scenario.
  const V_FAIL = { ok: false, confidence: 1, code: 'failed' as const, reason: 'stub failure' };

  it('emits cooldown_with_rollback when a restorable checkpoint exists', () => {
    const ts = new TurnState({ cooldownConsecThreshold: 2 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    // No mutations recorded; checkpoint stays clean.
    ts.recordToolCall('shell_exec', { c: 'one' }, V_FAIL);
    const decision = ts.recordToolCall('shell_exec', { c: 'two' }, V_FAIL);
    expect(decision.kind).toBe('cooldown_with_rollback');
    expect(decision.rollback).toBeDefined();
    expect(decision.rollback!.checkpoint.iteration).toBe(0);
    expect(decision.rollback!.blockedBy).toEqual([]);
  });

  it('emits plain cooldown when no restorable checkpoint exists (HARD BLOCK)', () => {
    const ts = new TurnState({ cooldownConsecThreshold: 2 });
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.markMutationOnLiveCheckpoint('file_write');   // flag checkpoint
    ts.recordToolCall('shell_exec', { c: 'one' }, V_FAIL);
    const decision = ts.recordToolCall('shell_exec', { c: 'two' }, V_FAIL);
    expect(decision.kind).toBe('cooldown');
    expect(decision.rollback).toBeUndefined();
    expect(decision.cooldownMessage).toContain('shell_exec');
  });

  it('emits plain cooldown when checkpointDepth=0 (Phase 1-3 behavior)', () => {
    const ts = new TurnState({ cooldownConsecThreshold: 2, checkpointDepth: 0 });
    // Even if we "capture" a checkpoint, depth=0 → buffer stays empty.
    ts.captureCheckpoint([mkMsg('user', 'a')], 0);
    ts.recordToolCall('shell_exec', { c: 'one' }, V_FAIL);
    const decision = ts.recordToolCall('shell_exec', { c: 'two' }, V_FAIL);
    expect(decision.kind).toBe('cooldown');
    expect(decision.rollback).toBeUndefined();
  });
});

describe('buildRollbackMessage formatting', () => {
  it('includes iteration and tool name', () => {
    const msg = buildRollbackMessage({ iteration: 3, toolName: 'shell_exec' });
    expect(msg).toContain('[tce]');
    expect(msg).toContain('iteration 3');
    expect(msg).toContain('shell_exec');
  });

  it('uses generic phrasing for iteration 0', () => {
    const msg = buildRollbackMessage({ iteration: 0, toolName: 'web_fetch' });
    expect(msg).toContain('to the start of this turn');
    expect(msg).toContain('web_fetch');
  });

  it('handles missing tool name with generic placeholder', () => {
    const msg = buildRollbackMessage({ iteration: 1 });
    expect(msg).toContain('the looping tool');
  });

  it('appends blockedBy note when present', () => {
    const msg = buildRollbackMessage({
      iteration: 2, toolName: 'web_fetch',
      blockedBy: ['file_write', 'shell_exec'],
    });
    expect(msg).toContain('CANNOT undo');
    expect(msg).toContain('file_write');
    expect(msg).toContain('shell_exec');
  });

  it('skips blockedBy note when array empty', () => {
    const msg = buildRollbackMessage({
      iteration: 2, toolName: 'web_fetch', blockedBy: [],
    });
    expect(msg).not.toContain('CANNOT undo');
  });
});
