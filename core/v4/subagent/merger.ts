/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/merger.ts — Phase v4.1-subagent
 *
 * Combine N subagent outputs into one (or zero) aggregator response.
 * Four strategies, each with a different cost shape — the tool's
 * description surfaces this so the calling LLM picks knowingly:
 *
 *   - 'all'        — return raw N results, no aggregator call. FREE.
 *                    Caller's parent agent reads them in its own
 *                    next turn (the partition pattern).
 *   - 'vote'       — LLM judge picks ONE result verbatim. +1 call.
 *   - 'pick-best'  — LLM judge picks one with reasoning. +1 call.
 *                    Same wire shape as 'vote', different prompt.
 *   - 'combine'    — LLM synthesizes N results into one answer.
 *                    +1 call (the ensemble pattern).
 *
 * The aggregator uses the parent's active provider+model by default,
 * env override `AIDEN_SUBAGENT_AGGREGATOR_MODEL` (provider:model
 * format, e.g. `groq:llama-3.3-70b-versatile`) when the user wants
 * to control aggregator cost without affecting subagent fanout.
 *
 * The aggregator call is intentionally THIN — single-shot, no tools,
 * no agent loop. It's a text-in / text-out pass over the N results
 * with a strategy-specific system prompt.
 */

import type { Message, ProviderAdapter } from '../../../providers/v4/types';
import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';

export type MergeStrategy = 'all' | 'vote' | 'pick-best' | 'combine';

export interface SubagentResult {
  /** 0-based index, matches diagnostics arrays. */
  index: number;
  /** Provider+model that produced this result. */
  providerId: string;
  modelId:    string;
  /** Final assistant text. Empty string when `error` is set. */
  output: string;
  /** Set when the subagent timed out, errored, or was aborted. */
  error?: string;
  /** Wall-clock elapsed (ms). */
  elapsedMs: number;
  // ── v4.12.1 Pillar 3 — evidence-required reporting ─────────────────────
  /** True when this child's claim was backed by re-checked proof handles. */
  verified?: boolean;
  /** Verify-before-done verdict over the child's trace after handle re-check. */
  verdict?: 'completed' | 'completed_unverified' | 'verification_failed' | null;
  /** True when the child did no mutating work — advisory, not verified-fact. */
  reasoningOnly?: boolean;
}

export interface MergeOptions {
  strategy:        MergeStrategy;
  /** Adapter for aggregator calls. Caller threads the parent's
   *  active adapter. */
  aggregatorAdapter: ProviderAdapter;
  /** Provider+model used for the aggregator (for diagnostics). */
  aggregatorModel: { providerId: string; modelId: string };
  /** Original user query — gives the aggregator context. For
   *  partition-mode fanouts the caller passes the umbrella prompt. */
  userQuery: string;
  logger?: Logger;
  /** Abort signal — aggregator call honours parent abort. */
  signal?: AbortSignal;
}

export interface MergeOutput {
  /** Strategy-dependent merged text, or null when strategy === 'all'. */
  merged: string | null;
  /** Aggregator label `${providerId}:${modelId}`, or empty for 'all'. */
  aggregator: string;
}

/** Resolve env override for aggregator model. Returns null when unset
 *  or malformed; caller falls back to parent's active model. */
export function resolveAggregatorOverride(
  env: NodeJS.ProcessEnv = process.env,
): { providerId: string; modelId: string } | null {
  const raw = env.AIDEN_SUBAGENT_AGGREGATOR_MODEL?.trim();
  if (!raw) return null;
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) return null;
  const providerId = raw.slice(0, colon).trim();
  const modelId    = raw.slice(colon + 1).trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** Apply the strategy. Logs every aggregator call for observability. */
export async function mergeResults(
  results: SubagentResult[],
  opts: MergeOptions,
): Promise<MergeOutput> {
  const logger = opts.logger ?? noopLogger();

  if (opts.strategy === 'all') {
    return { merged: null, aggregator: '' };
  }

  // Filter out failures — aggregator only sees usable outputs.
  const usable = results.filter((r) => !r.error && r.output.length > 0);
  if (usable.length === 0) {
    return {
      merged: '[Aggregator: every subagent failed — no output to merge]',
      aggregator: '',
    };
  }

  // v4.12.1 Pillar 3 — verified-preferring aggregation. A child claiming
  // success with no re-checked evidence must not out-vote one that proved
  // its work. For SELECTION strategies (vote/pick-best), when any verified
  // candidate exists, the pool is restricted to verified ones — a handle-less
  // "success" simply isn't in the running. 'combine' keeps everyone (it
  // synthesizes), but every candidate is annotated with its trust label so
  // the aggregator weights verified content higher.
  const verified = usable.filter((r) => r.verified === true);
  const pool =
    opts.strategy === 'combine'
      ? usable
      : (verified.length > 0 ? verified : usable);

  const aggregatorLabel =
    `${opts.aggregatorModel.providerId}:${opts.aggregatorModel.modelId}`;

  const systemPrompt = buildSystemPrompt(opts.strategy);
  const userPrompt   = buildUserPrompt(opts.strategy, pool, opts.userQuery);

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt },
  ];

  logger.info('subagent merge: aggregator dispatching', {
    scope:       'subagent',
    strategy:    opts.strategy,
    aggregator:  aggregatorLabel,
    sources:     pool.length,
    verifiedPreferred: verified.length > 0 && opts.strategy !== 'combine',
  });

  try {
    const out = await opts.aggregatorAdapter.call({
      messages,
      tools: [],
      stream: false,
    });
    const text = extractFinalText(out);
    return { merged: text, aggregator: aggregatorLabel };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('subagent merge: aggregator failed', {
      scope:    'subagent',
      strategy: opts.strategy,
      error:    message,
    });
    // Graceful degrade: return the first usable subagent output rather
    // than crash the whole fanout. Caller sees `aggregator === ''`
    // and a synthetic merged note.
    return {
      merged: `[Aggregator failed: ${message}]\n\n${usable[0]!.output}`,
      aggregator: '',
    };
  }
}

function buildSystemPrompt(strategy: MergeStrategy): string {
  switch (strategy) {
    case 'vote':
      return [
        'You are an answer-selection judge. You will be shown a user query and N candidate answers from independent agents.',
        'Pick exactly ONE candidate that best answers the query and return ITS TEXT VERBATIM with no preamble, no commentary, no formatting changes.',
        'Choose the answer that is most factually accurate, complete, and directly addresses the query.',
        'Each candidate carries a [trust: …] tag: PREFER candidates whose work is `verified` (backed by re-checked evidence); treat `unverified` and `advisory` claims skeptically and never let them out-rank a verified one.',
      ].join(' ');
    case 'pick-best':
      return [
        'You are an answer-selection judge. You will be shown a user query and N candidate answers from independent agents.',
        'Pick the BEST candidate. Output a one-sentence reason on the first line, then a blank line, then the chosen candidate text verbatim.',
        'Each candidate carries a [trust: …] tag: PREFER `verified` candidates (evidence re-checked); treat `unverified`/`advisory` as claims, not facts.',
        'Format:\nReason: <one sentence>\n\n<chosen candidate verbatim>',
      ].join(' ');
    case 'combine':
      return [
        'You are a synthesis aggregator. You will be shown a user query and N candidate answers from independent agents.',
        'Produce ONE unified answer that integrates the strongest points from each candidate.',
        'Resolve disagreements by stating both positions when sources diverge factually; collapse redundancy where they agree.',
        'Do not name the candidates. Speak directly. No meta-commentary about being an aggregator.',
      ].join(' ');
    default:
      return 'You are a helpful assistant.';
  }
}

function buildUserPrompt(
  strategy: MergeStrategy,
  results: SubagentResult[],
  query: string,
): string {
  const trustLabel = (r: SubagentResult): string =>
    r.verdict === 'verification_failed' ? 'verification_failed'
    : r.verified === true               ? 'verified'
    : r.reasoningOnly === true          ? 'advisory'
    : 'unverified';
  const blocks = results.map((r, i) =>
    `--- CANDIDATE ${i + 1} (${r.providerId}:${r.modelId}) [trust: ${trustLabel(r)}] ---\n${r.output.trim()}`,
  ).join('\n\n');
  const action = strategy === 'combine'
    ? 'Synthesize these into one unified answer.'
    : strategy === 'pick-best'
    ? 'Pick the best candidate.'
    : 'Pick the best candidate verbatim.';
  return `USER QUERY:\n${query}\n\n${blocks}\n\n${action}`;
}

function extractFinalText(out: unknown): string {
  // ProviderCallOutput.content is `string | null` per providers/v4/types.ts.
  // For a single-shot non-streaming aggregator call we expect the model
  // to return text directly with `finishReason: 'stop'`.
  if (out && typeof out === 'object') {
    const o = out as { content?: string | null };
    if (typeof o.content === 'string' && o.content.length > 0) return o.content;
  }
  return '';
}
