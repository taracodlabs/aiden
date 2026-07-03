/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 Pillar 5 Slice C — production wiring of the pillar-event emitters.
 *
 * The five emitters were defined + tested but had zero production call sites.
 * This locks the wire-sites that ARE unit-reachable: autonomy_changed (through
 * the real ApprovalEngine setter), and the emit contract each site relies on
 * (name + payload, delivered to BOTH the live onEvent sink and the durable
 * run_events store). The safe-emit guard is asserted too: a telemetry failure
 * never breaks the underlying task. (artifact_verified / cost_updated fire from
 * chatSession + realAgentRunner — those hot paths stay green in their own
 * suites; here we pin the contract + the swallow.)
 */
import { describe, it, expect } from 'vitest';

import { ApprovalEngine } from '../../../moat/approvalEngine';
import { resolveAutonomyPolicy } from '../../../moat/autonomy';
import {
  emitArtifactVerified, emitCostUpdated, emitAutonomyChanged, type PillarEventSink,
} from '../../../core/v4/pillarEvents';

function captureSink(): {
  sink: PillarEventSink;
  live: Array<{ name: string; payload: Record<string, unknown> }>;
  durable: Array<{ name: string; payload: Record<string, unknown> }>;
} {
  const live: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const durable: Array<{ name: string; payload: Record<string, unknown> }> = [];
  return {
    live, durable,
    sink: {
      runId: 7,
      runStore: { emitEventRich: (o) => { durable.push({ name: String(o.name), payload: o.payload as Record<string, unknown> }); return 1; } },
      onEvent: (name, payload) => live.push({ name, payload }),
    },
  };
}

// ── autonomy_changed via the real ApprovalEngine seam ─────────────────────
describe('autonomy_changed — fires through ApprovalEngine.setAutonomyPolicy', () => {
  const policy = resolveAutonomyPolicy('Partner', { workspaceRoots: [process.cwd()] });

  it('the late-bound handler fires with (level, by) when the dial is set', () => {
    const engine = new ApprovalEngine('smart');
    const seen: Array<{ level: string; by: string }> = [];
    engine.setAutonomyChangedHandler((level, by) => seen.push({ level, by }));
    expect(engine.setAutonomyPolicy(policy, { userInitiated: true })).toBe(true);
    expect(seen).toEqual([{ level: 'Partner', by: 'user' }]);
  });

  it('wired to a sink, it lands on BOTH the live subscriber and durable run_events', () => {
    const { sink, live, durable } = captureSink();
    const engine = new ApprovalEngine('smart');
    engine.setAutonomyChangedHandler((level, by) => emitAutonomyChanged(sink, { level, by }));
    engine.setAutonomyPolicy(policy, { userInitiated: true });
    expect(live.find((e) => e.name === 'autonomy_changed')?.payload.level).toBe('Partner');
    expect(durable.find((e) => e.name === 'autonomy_changed')?.payload.level).toBe('Partner');
  });

  it('a throwing handler is swallowed — setAutonomyPolicy still applies + returns true', () => {
    const engine = new ApprovalEngine('smart');
    engine.setAutonomyChangedHandler(() => { throw new Error('telemetry down'); });
    expect(() => engine.setAutonomyPolicy(policy, { userInitiated: true })).not.toThrow();
    expect(engine.getAutonomyPolicy()?.level).toBe('Partner');
  });
});

// ── the emit contract chatSession + realAgentRunner rely on ───────────────
describe('artifact_verified + cost_updated emit contract', () => {
  it('artifact_verified carries verdict + handle count to both sinks', () => {
    const { sink, live, durable } = captureSink();
    emitArtifactVerified(sink, { verdict: 'completed', verified: true, handles: 2, taskId: '5' });
    for (const bag of [live, durable]) {
      const e = bag.find((x) => x.name === 'artifact_verified');
      expect(e?.payload.verdict).toBe('completed');
      expect(e?.payload.handles).toBe(2);
    }
  });

  it('cost_updated carries the token totals to both sinks', () => {
    const { sink, live, durable } = captureSink();
    emitCostUpdated(sink, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(live.find((x) => x.name === 'cost_updated')?.payload.totalTokens).toBe(15);
    expect(durable.find((x) => x.name === 'cost_updated')?.payload.totalTokens).toBe(15);
  });

  it('a throwing durable store never propagates out of the emitter (task continues)', () => {
    const throwing: PillarEventSink = {
      runId: 1,
      runStore: { emitEventRich: () => { throw new Error('DB down'); } },
      onEvent: () => { /* live still works */ },
    };
    expect(() => emitArtifactVerified(throwing, { verdict: 'completed', verified: true, handles: 0 })).not.toThrow();
    expect(() => emitCostUpdated(throwing, { inputTokens: 1, outputTokens: 1, totalTokens: 2 })).not.toThrow();
  });
});
