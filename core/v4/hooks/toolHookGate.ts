/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/toolHookGate.ts — v4.9.0 Slice 12a Phase 3.
 *
 * Bridge between the tool dispatcher and the hook subsystem. Wraps a
 * tool call with:
 *
 *   1. `tool.call.pre` dispatch — if any `mandatory_policy` block
 *      decision lands, the handler is NOT executed and a
 *      `HookBlockedError` is thrown so the executor's catch path
 *      surfaces it as a structured `ToolCallResult.error`.
 *   2. Input transform — patches from `transform_input` hooks merge
 *      into the args before the handler runs.
 *   3. Handler execution — caller-supplied async fn.
 *   4. `tool.call.post` dispatch — fires informational + output
 *      transform hooks. `transform_output` patches the result.
 *      A post-hook block is recorded in `hook_executions` but the
 *      tool result still returns (the handler already side-effected;
 *      block-after-the-fact would just hide that from the model).
 *
 * If `db` is null (e.g. the headless CLI mode without a daemon),
 * runs the handler directly — no audit, no hooks. Keeps test paths
 * that don't open a database fully working.
 */

import type { Db } from '../daemon/db/connection';
import { dispatchHook, type DispatchContext } from './dispatcher';

/**
 * Thrown when a `mandatory_policy` hook blocks `tool.call.pre`.
 * The tool dispatcher's outer catch maps this to a structured
 * `ToolCallResult.error` so the model sees the rejection.
 */
export class HookBlockedError extends Error {
  public readonly userMessage?:  string;
  public readonly modelMessage?: string;
  constructor(reason: string, userMessage?: string, modelMessage?: string) {
    super(reason);
    this.name         = 'HookBlocked';
    this.userMessage  = userMessage;
    this.modelMessage = modelMessage;
  }
}

export interface RunToolWithHooksOpts {
  db:           Db | null;
  toolName:     string;
  toolCallId:   string;
  args:         Record<string, unknown>;
  ctx:          DispatchContext;
}

/** Resolve action-changing pre-hooks before policy or approval evaluation. */
export async function runToolPreHooks(
  opts: RunToolWithHooksOpts,
): Promise<Record<string, unknown>> {
  if (!opts.db) return opts.args;
  const baseCtx: DispatchContext = { ...opts.ctx, toolName: opts.toolName, toolCallId: opts.toolCallId };
  const pre = await dispatchHook(opts.db, 'tool.call.pre', opts.args, baseCtx);
  if (pre.decision === 'block') {
    throw new HookBlockedError(
      pre.reason ?? 'tool call blocked by pre-hook',
      pre.user_message,
      pre.model_message,
    );
  }
  return pre.payload as Record<string, unknown>;
}

/** Apply presentation-only post-hooks after the frozen action has executed. */
export async function runToolPostHooks(
  opts: RunToolWithHooksOpts,
  finalArgs: Record<string, unknown>,
  result: unknown,
): Promise<unknown> {
  if (!opts.db) return result;
  const baseCtx: DispatchContext = { ...opts.ctx, toolName: opts.toolName, toolCallId: opts.toolCallId };
  const post = await dispatchHook(
    opts.db,
    'tool.call.post',
    { input: finalArgs, output: result },
    baseCtx,
  );
  const patched = post.payload as Record<string, unknown>;
  return ('output' in patched) ? patched.output : result;
}

/**
 * Wrap a tool handler call with pre/post hook dispatch. Returns
 * the (possibly transformed) handler result. Throws `HookBlockedError`
 * if a pre-hook with `mandatory_policy` decides block.
 */
export async function runToolWithHooks(
  opts:    RunToolWithHooksOpts,
  runHandler: (args: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  if (!opts.db) {
    // No daemon DB → no hook subsystem. Pass-through.
    return runHandler(opts.args);
  }

  const baseCtx: DispatchContext = { ...opts.ctx, toolName: opts.toolName, toolCallId: opts.toolCallId };

  // ── tool.call.pre ───────────────────────────────────────────────
  const pre = await dispatchHook(opts.db, 'tool.call.pre', opts.args, baseCtx);
  if (pre.decision === 'block') {
    throw new HookBlockedError(
      pre.reason ?? 'tool call blocked by pre-hook',
      pre.user_message, pre.model_message,
    );
  }
  const finalArgs = pre.payload as Record<string, unknown>;

  // ── handler ─────────────────────────────────────────────────────
  const result = await runHandler(finalArgs);

  // ── tool.call.post ──────────────────────────────────────────────
  // Wrap the output in a stable envelope so transform_output hooks
  // have a known field name to patch. We discard the post-hook's
  // block decision (the handler already ran — see file header).
  const postPayload: Record<string, unknown> = { input: finalArgs, output: result };
  const post = await dispatchHook(opts.db, 'tool.call.post', postPayload, baseCtx);
  const patched = post.payload as Record<string, unknown>;
  return ('output' in patched) ? patched.output : result;
}
