/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/subagent/fanout.ts — Phase v4.1-subagent
 *
 * Parallel-agent orchestrator. Spawn N children against the same
 * problem (or a partition), enforce per-child timeouts and an outer
 * wall-clock cap, then merge results via the chosen strategy.
 *
 * Design constraints (locked from recon):
 *
 *   - In-process `Promise.all` over N children. No child processes,
 *     no MCP-spawn (Aiden's MCP server is for external clients).
 *   - Per-child AbortSignal derived from a parent signal + timeout.
 *     Aborts cascade — parent abort kills every child mid-flight via
 *     the provider's own HTTP AbortController.
 *   - Each child gets:
 *       * own session ID (UUID) — sessions never collide
 *       * own provider rotation slot
 *       * own cloned FallbackAdapter when applicable (mutable rate-
 *         limit state isolated per child)
 *       * fresh max_iterations (no v3-style budget halving)
 *   - Shared (read-only) across children:
 *       * tool registry, skill loader, paths, memoryManager
 *
 * Hot blockers from the recon are addressed by the caller:
 *   - browser bridge: caller wraps browser tool dispatch in
 *     `withPwLock` (see core/playwrightBridge.ts)
 *   - approval engine: caller passes a ToolContext with
 *     `approvalEngine` undefined (no prompts in subagents)
 *   - destructive tool exposure: caller filters the schemas array
 *     based on `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE`
 *
 * v4.6 Phase 2Q-A — the orchestrator was previously decoupled from
 * AidenAgent via a `runChild` callback (one closure per fanout call
 * built the child agent). Post-2Q-A every child flows through the
 * `spawnSubAgent` primitive, so the legacy `runChild` callback is
 * gone (deleted in 2R). Behavioural test fakes inject a stub
 * `SpawnSubAgentDeps` (real `toolRegistry` + mock provider) — see
 * `tests/v4/subagent/fanout.behavioral.test.ts` for the pattern.
 */

import type { Logger } from '../logger/logger';
import { noopLogger } from '../logger/factory';
import {
  resolveBudget,
  validateN,
  type SubagentBudget,
} from './budget';
import {
  rotateProviders,
  type ProviderOption,
} from './providerRotation';
import {
  mergeResults,
  type MergeStrategy,
  type SubagentResult,
  type MergeOptions,
} from './merger';
import { AIDEN_SUBAGENT_BUILD, type FanoutDiagnostics } from './diagnostics';
import { spawnSubAgent, type SpawnSubAgentDeps, type SubAgentSpec } from './spawnSubAgent';

// ── Public types ─────────────────────────────────────────────────────────

/** One unit of work for partition mode. */
export interface PartitionTask {
  goal: string;
  context?: string;
  /** Optional role tag for diagnostics + prompt context. */
  role?: string;
}

export type FanoutMode = 'partition' | 'ensemble';

export interface FanoutOptions {
  mode: FanoutMode;
  /** Same query for every child (ensemble mode). Required when
   *  `mode === 'ensemble'`. */
  query?: string;
  /** Per-child task list (partition mode). Required when
   *  `mode === 'partition'`; length must equal `n`. */
  tasks?: PartitionTask[];
  /** Number of children to spawn. Validated against MAX_FANOUT_N. */
  n: number;
  merge: MergeStrategy;
  /** Available provider options for rotation. */
  providers: ProviderOption[];
  /**
   * v4.6 Phase 2Q-A — required deps the fanout layer threads into
   * each `spawnSubAgent` call (see
   * `core/v4/subagent/spawnSubAgent.ts`). Carries `toolRegistry`,
   * `parentProvider` (a FallbackAdapter when provider rotation is
   * needed), `runStore` for child-run persistence, etc.
   */
  spawnDeps: SpawnSubAgentDeps;
  /**
   * v4.6 Phase 2Q — optional parent run / session identifiers.
   * Threaded into each child's `spawnSubAgent` ctx as
   * `parentRunId` / `parentSessionId` so child rows link back to
   * the parent's run row via `spawned_from_run_id`. Null when the
   * fanout is invoked from a context without a parent run row
   * (e.g. MCP-mode where the wrapper doesn't create a parent row).
   */
  parentRunId?:     number;
  parentSessionId?: string;
  /** Aggregator adapter — supplied by the caller. Same shape as the
   *  parent's adapter. Used only when `merge !== 'all'`. */
  aggregatorAdapter: MergeOptions['aggregatorAdapter'];
  aggregatorModel:   MergeOptions['aggregatorModel'];
  /** Override per-child timeout. */
  timeoutMs?: number;
  /** Parent abort — cascades to all children. */
  parentAbort?: AbortSignal;
  logger?: Logger;
  /** Wall clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface FanoutResult {
  results: SubagentResult[];
  merged:  string | null;
  diagnostics: FanoutDiagnostics;
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export async function runFanout(opts: FanoutOptions): Promise<FanoutResult> {
  const logger = (opts.logger ?? noopLogger()).child('subagent');
  const now    = opts.now ?? Date.now;

  // ── Pre-flight validation ─────────────────────────────────────
  validateN(opts.n);
  if (opts.mode === 'ensemble' && !opts.query) {
    throw new Error('subagent_fanout: ensemble mode requires a `query`');
  }
  if (opts.mode === 'partition') {
    if (!opts.tasks || opts.tasks.length === 0) {
      throw new Error('subagent_fanout: partition mode requires `tasks[]`');
    }
    if (opts.tasks.length !== opts.n) {
      throw new Error(
        `subagent_fanout: partition tasks.length (${opts.tasks.length}) ` +
        `must equal n (${opts.n})`,
      );
    }
  }
  if (opts.providers.length === 0) {
    throw new Error('subagent_fanout: no providers available — cannot fan out');
  }

  const budget: SubagentBudget = resolveBudget({ timeoutMs: opts.timeoutMs });
  const rotation = rotateProviders(opts.n, opts.providers);

  if (rotation.singleProviderWarning) {
    logger.warn('subagent_fanout: single-provider fanout — diversity ≈ temperature variation', {
      providers: opts.providers.length,
      n:         opts.n,
    });
  }

  logger.info('subagent_fanout: launching', {
    build:               AIDEN_SUBAGENT_BUILD,
    mode:                opts.mode,
    n:                   opts.n,
    merge:               opts.merge,
    perSubagentTimeoutMs: budget.perSubagentTimeoutMs,
    wallClockCapMs:      budget.wallClockCapMs,
  });

  // ── Spawn ─────────────────────────────────────────────────────
  const startedAt = now();
  const wallController = new AbortController();
  const wallTimer = setTimeout(() => wallController.abort(),
    budget.wallClockCapMs);
  // Forward parent abort to the wall controller so it cascades.
  const parentAbortHandler = () => wallController.abort();
  if (opts.parentAbort) {
    if (opts.parentAbort.aborted) wallController.abort();
    else opts.parentAbort.addEventListener('abort', parentAbortHandler, { once: true });
  }

  const children: Array<Promise<SubagentResult>> = [];
  for (let i = 0; i < opts.n; i += 1) {
    const provider = rotation.assignments[i]!;
    const task = opts.mode === 'partition' ? opts.tasks![i]! : null;
    const role = task?.role;
    children.push(spawnViaPrimitive({
      index:         i,
      query:         opts.mode === 'ensemble' ? opts.query! : task!.goal,
      context:       task?.context,
      role,
      provider,
      singleProviderWarning: rotation.singleProviderWarning,
      maxIterations: budget.maxIterations,
      perTimeoutMs:  budget.perSubagentTimeoutMs,
      wallSignal:    wallController.signal,
      spawnDeps:     opts.spawnDeps,
      parentRunId:   opts.parentRunId,
      parentSessionId: opts.parentSessionId,
      logger:        logger.child(`#${i}:${provider.providerId}`),
      now,
    }));
  }

  const results = await Promise.all(children);
  clearTimeout(wallTimer);
  if (opts.parentAbort) {
    opts.parentAbort.removeEventListener('abort', parentAbortHandler);
  }

  const totalMs = now() - startedAt;

  // ── Merge ─────────────────────────────────────────────────────
  const merge = await mergeResults(results, {
    strategy:          opts.merge,
    aggregatorAdapter: opts.aggregatorAdapter,
    aggregatorModel:   opts.aggregatorModel,
    userQuery:         opts.mode === 'ensemble'
      ? opts.query!
      : opts.tasks!.map((t, i) => `(${i + 1}) ${t.goal}`).join('\n'),
    logger,
    signal: wallController.signal,
  });

  // ── Diagnostics ───────────────────────────────────────────────
  const diagnostics: FanoutDiagnostics = {
    build:                 AIDEN_SUBAGENT_BUILD,
    launched:              opts.n,
    succeeded:             results.filter((r) => !r.error && r.output.length > 0).length,
    failed:                results.filter((r) => !!r.error || r.output.length === 0).length,
    totalMs,
    perSubagentMs:         results.map((r) => r.elapsedMs),
    providerDistribution:  results.map((r) => r.providerId),
    singleProviderWarning: rotation.singleProviderWarning,
    aggregator:            merge.aggregator,
  };

  logger.info('subagent_fanout: complete', {
    succeeded: diagnostics.succeeded,
    failed:    diagnostics.failed,
    totalMs,
    aggregator: merge.aggregator || '(none)',
  });

  return { results, merged: merge.merged, diagnostics };
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * v4.6 Phase 2Q — single-child spawn args. Replaces the pre-Phase-2
 * `SpawnOneArgs` shape (which called `runChild` directly). The new
 * shape delegates everything past the rotation slot to
 * `spawnSubAgent`, which owns the run row + abort plumbing internally.
 *
 * Per-child timeout (`perTimeoutMs`) is kept here so the fanout layer
 * still enforces its own envelope around each child — note that
 * `spawnSubAgent` ALSO has its own `timeoutMs`, but we hand it the
 * per-child fanout cap via `spec.timeoutMs` so the two systems agree.
 * `wallSignal` carries the outer wall-clock cap; we pass it as
 * `ctx.signal` so the primitive cascades it into the child loop.
 */
interface SpawnViaPrimitiveArgs {
  index:           number;
  /** Either the ensemble query, or the partition task's `goal`. */
  query:           string;
  /** Partition-mode background — flows into `spec.context`. */
  context?:        string;
  role?:           string;
  provider:        ProviderOption;
  /**
   * v4.6 Phase 2Q-A-FIX — when true, the rotation pool has fewer
   * than 2 distinct providerIds (every assignment is the same
   * provider). The fanout layer omits the per-spawn provider
   * override in this case so children inherit the parent's adapter
   * directly, avoiding a `provider_not_found` from 2P's strict
   * validation when the parent is NOT a FallbackAdapter. The
   * override path only adds value when rotation produces diversity.
   */
  singleProviderWarning: boolean;
  maxIterations:   number;
  perTimeoutMs:    number;
  wallSignal:      AbortSignal;
  spawnDeps:       SpawnSubAgentDeps;
  parentRunId?:    number;
  parentSessionId?: string;
  logger:          Logger;
  now:             () => number;
}

/**
 * Spawn one child via the `spawnSubAgent` primitive and adapt its
 * envelope to the merger's `SubagentResult` shape. Centralises the
 * fanout-layer → primitive-layer conversion in one place — every
 * call site goes through here so a future envelope-shape change
 * has a single edit point.
 *
 * Envelope → SubagentResult mapping:
 *   - `envelope.summary` → `output` (empty string on failure;
 *      the merger uses `output.length === 0` for the failed test).
 *   - `envelope.error`   → `error` (undefined when ok).
 *   - `envelope.metrics.durationMs` → ignored; we capture wall-clock
 *      at this layer for diagnostics consistency with v4.1's shape.
 */
async function spawnViaPrimitive(args: SpawnViaPrimitiveArgs): Promise<SubagentResult> {
  const startedAt = args.now();

  args.logger.info('child: spawned', {
    provider:  `${args.provider.providerId}:${args.provider.modelId}`,
    role:      args.role,
    timeoutMs: args.perTimeoutMs,
  });

  // v4.6 Phase 2Q-A-FIX — only forward the per-spawn provider
  // override when rotation has real diversity (>= 2 distinct
  // providerIds). For single-provider pools, every child would be
  // assigned the same providerId, so the override path adds nothing
  // — and worse, it trips 2P's `resolveChildProvider` rejection when
  // the parent is a non-FallbackAdapter ("single-provider
  // configuration" branch). Omitting it lets the child inherit the
  // parent's adapter, which is the correct effective behavior.
  const spec: SubAgentSpec = {
    goal:          args.role ? `[role: ${args.role}] ${args.query}` : args.query,
    context:       args.context,
    maxIterations: args.maxIterations,
    timeoutMs:     args.perTimeoutMs,
    provider:      args.singleProviderWarning ? undefined : args.provider.providerId,
  };

  let envelope;
  try {
    envelope = await spawnSubAgent(spec, args.spawnDeps, {
      signal:          args.wallSignal,
      parentRunId:     args.parentRunId,
      parentSessionId: args.parentSessionId,
    });
  } catch (err) {
    // spawnSubAgent's contract says it never throws — but defend in
    // depth: a thrown error from the primitive would otherwise sink
    // the whole Promise.all, which would silently kill sibling
    // children. Surface as a failed SubagentResult instead.
    const error = err instanceof Error ? err.message : String(err);
    args.logger.warn('child: primitive threw', { error });
    return {
      index:      args.index,
      providerId: args.provider.providerId,
      modelId:    args.provider.modelId,
      output:     '',
      error,
      elapsedMs:  args.now() - startedAt,
    };
  }

  const elapsedMs = args.now() - startedAt;
  const error = envelope.error ?? undefined;
  args.logger.info('child: done', {
    elapsedMs,
    ok:         envelope.ok,
    status:     envelope.status,
    exitReason: envelope.exitReason,
    childRunId: envelope.childRunId,
  });

  return {
    index:      args.index,
    providerId: args.provider.providerId,
    modelId:    args.provider.modelId,
    output:     envelope.ok ? (envelope.summary ?? '') : '',
    error,
    elapsedMs,
    // v4.12.1 Pillar 3 — carry the child's evidence verdict into the merger
    // so aggregation can prefer verified answers over bare claims.
    verified:      envelope.verified,
    verdict:       envelope.verdict,
    reasoningOnly: envelope.reasoningOnly,
  };
}
