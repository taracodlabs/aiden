/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 Pillar 3 — Phase D: verified-preferring fanout aggregation.
 *
 * A child that CLAIMS success with no re-checked evidence must not out-vote a
 * child that PROVED its work. For selection strategies (vote / pick-best) the
 * aggregator only sees verified candidates when any exist; unverified/advisory
 * claims are annotated with a [trust: …] tag so the judge weights them down.
 */
import { describe, it, expect, vi } from 'vitest';
import { mergeResults, type SubagentResult } from '../../../core/v4/subagent/merger';
import type { ProviderAdapter } from '../../../providers/v4/types';

/** Stub aggregator that captures the user prompt it was handed. */
function captureAdapter(): { adapter: ProviderAdapter; lastUserPrompt: () => string } {
  let prompt = '';
  const adapter = {
    call: vi.fn(async (input: { messages: Array<{ role: string; content: string }> }) => {
      prompt = input.messages.find((m) => m.role === 'user')?.content ?? '';
      return { content: 'AGGREGATED', finishReason: 'stop' };
    }),
  } as unknown as ProviderAdapter;
  return { adapter, lastUserPrompt: () => prompt };
}

const R = (index: number, output: string, over: Partial<SubagentResult> = {}): SubagentResult => ({
  index, providerId: 'p', modelId: 'm', output, elapsedMs: 1, ...over,
});

const opts = (adapter: ProviderAdapter, strategy: 'vote' | 'pick-best' | 'combine') => ({
  strategy,
  aggregatorAdapter: adapter,
  aggregatorModel: { providerId: 'p', modelId: 'm' },
  userQuery: 'do the thing',
});

describe('mergeResults — verified-preferring selection', () => {
  it('vote: when a verified candidate exists, the aggregator ONLY sees verified ones', async () => {
    const { adapter, lastUserPrompt } = captureAdapter();
    const results = [
      R(0, 'CLAIMED but unbacked', { verified: false }),
      R(1, 'PROVEN with a real file', { verified: true }),
      R(2, 'also unbacked',          { verified: false }),
    ];
    await mergeResults(results, opts(adapter, 'vote'));
    const p = lastUserPrompt();
    expect(p).toContain('PROVEN with a real file');
    expect(p).not.toContain('CLAIMED but unbacked');   // handle-less claim isn't in the running
    expect(p).toContain('[trust: verified]');
  });

  it('pick-best: falls back to ALL candidates (annotated) when none are verified', async () => {
    const { adapter, lastUserPrompt } = captureAdapter();
    const results = [
      R(0, 'analysis one', { reasoningOnly: true }),
      R(1, 'analysis two', { verified: false }),
    ];
    await mergeResults(results, opts(adapter, 'pick-best'));
    const p = lastUserPrompt();
    expect(p).toContain('analysis one');
    expect(p).toContain('analysis two');
    expect(p).toContain('[trust: advisory]');           // reasoning-only tagged advisory
    expect(p).toContain('[trust: unverified]');
  });

  it('combine: keeps every candidate but annotates trust so synthesis weights it', async () => {
    const { adapter, lastUserPrompt } = captureAdapter();
    const results = [
      R(0, 'verified part', { verified: true }),
      R(1, 'claimed part',  { verified: false }),
    ];
    await mergeResults(results, opts(adapter, 'combine'));
    const p = lastUserPrompt();
    expect(p).toContain('verified part');
    expect(p).toContain('claimed part');                // combine synthesizes all
    expect(p).toContain('[trust: verified]');
    expect(p).toContain('[trust: unverified]');
  });

  it('a verification_failed candidate is tagged so and never out-ranks verified', async () => {
    const { adapter, lastUserPrompt } = captureAdapter();
    const results = [
      R(0, 'failed claim', { verified: false, verdict: 'verification_failed' }),
      R(1, 'proven',       { verified: true }),
    ];
    await mergeResults(results, opts(adapter, 'vote'));
    const p = lastUserPrompt();
    expect(p).toContain('proven');
    expect(p).not.toContain('failed claim');            // verified pool excludes it
  });
});
