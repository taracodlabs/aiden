/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 4 Slice 1, Phase 1 — the Pillar 1/2/3 surfaces emit as events
 * through the shared taxonomy, on the live seam (subscriber) AND durably.
 */
import { describe, it, expect, vi } from 'vitest';
import { categorizeEvent } from '../../../core/v4/daemon/eventCategories';
import {
  emitPillarEvent,
  emitArtifactVerified,
  emitAutonomyChanged,
  emitSubagentEscalation,
  emitNeedsConfirmation,
  emitCostUpdated,
  type PillarEventSink,
} from '../../../core/v4/pillarEvents';

function sink(): { s: PillarEventSink; live: Array<{ name: string; payload: unknown }>; rich: any[] } {
  const live: Array<{ name: string; payload: unknown }> = [];
  const rich: any[] = [];
  const s: PillarEventSink = {
    runStore: { emitEventRich: (o) => { rich.push(o); return rich.length; } },
    runId: 7,
    onEvent: (name, payload) => live.push({ name, payload }),
  };
  return { s, live, rich };
}

describe('categorizeEvent — the 5 new Pillar surfaces', () => {
  it('maps each new kind into the existing taxonomy', () => {
    expect(categorizeEvent('artifact_verified')).toEqual({ category: 'artifact', kind: 'artifact.verified' });
    expect(categorizeEvent('needs_confirmation')).toEqual({ category: 'approval', kind: 'approval.needs_confirmation' });
    expect(categorizeEvent('autonomy_changed')).toEqual({ category: 'status', kind: 'status.autonomy' });
    expect(categorizeEvent('subagent_escalation')).toEqual({ category: 'subagent', kind: 'subagent.escalation' });
    expect(categorizeEvent('cost_updated')).toEqual({ category: 'status', kind: 'status.cost' });
  });
});

describe('emitPillarEvent — live subscriber + durable persistence', () => {
  it('fires the live subscriber AND persists with the right (category, kind)', () => {
    const { s, live, rich } = sink();
    emitPillarEvent(s, 'artifact_verified', { verdict: 'completed' });
    expect(live).toEqual([{ name: 'artifact_verified', payload: { verdict: 'completed' } }]);
    expect(rich[0]).toMatchObject({ runId: 7, category: 'artifact', kind: 'artifact.verified', name: 'artifact_verified', source: 'repl' });
  });

  it('works with only a subscriber (no runStore — headless/tests)', () => {
    const live: Array<{ name: string }> = [];
    emitPillarEvent({ onEvent: (name) => live.push({ name }) }, 'cost_updated', {});
    expect(live).toEqual([{ name: 'cost_updated' }]);
  });

  it('a throwing subscriber never breaks the caller', () => {
    expect(() => emitPillarEvent({ onEvent: () => { throw new Error('boom'); } }, 'autonomy_changed', {})).not.toThrow();
  });
});

describe('typed convenience emitters', () => {
  it('each Pillar surface emits with its name + payload', () => {
    const { s, live } = sink();
    emitArtifactVerified(s, { verdict: 'verification_failed', verified: false, handles: 0 });
    emitAutonomyChanged(s, { level: 'Partner', by: 'user' });
    emitSubagentEscalation(s, { tool: 'file_delete', reason: 'destructive' });
    emitNeedsConfirmation(s, { tool: 'channel_send', target: 'discord:c1' });
    emitCostUpdated(s, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(live.map((e) => e.name)).toEqual([
      'artifact_verified', 'autonomy_changed', 'subagent_escalation', 'needs_confirmation', 'cost_updated',
    ]);
    expect(live[1].payload).toMatchObject({ level: 'Partner', by: 'user' });
    expect(live[4].payload).toMatchObject({ totalTokens: 150 });
  });
});
