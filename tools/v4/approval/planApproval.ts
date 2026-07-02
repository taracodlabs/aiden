/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/approval/planApproval.ts — `plan_approval`. v4.13 Phase D.
 *
 * The PREVIEW → APPROVE half of the demo flow, and the first real seam
 * of Pillar 2's trust dial. The model submits a structured batch of
 * INTENDED destructive operations (tool + exact args + reason); the
 * user approves all / selected / none ONCE; approved entries are
 * registered on the approval engine's SESSION allowlist
 * (`allowForSession(tool, argSignature(tool, args))`) so the follow-up
 * tool calls pass the normal dispatch-time gate without re-prompting —
 * and every execution still runs the full verified path (Gap-1
 * evidence-gated).
 *
 * Detector/policy separation, kept strict:
 *   - THIS TOOL EXECUTES NOTHING. It presents and records.
 *   - The approval ENGINE still decides at dispatch: approved entries
 *     pass because the user granted exactly their signatures; anything
 *     not granted (declined, or drifted args) hits the normal prompt/
 *     deny path. Nothing destructive can execute outside an approved
 *     batch entry short of a fresh per-call approval.
 *   - Declined entries are recorded (the evidence envelope picks them
 *     up as `declined`) — a declined op is a decision, not a failure.
 *
 * Trust-dial seam: the returned record carries {mode, decidedVia} so a
 * future permission mode can auto-approve/deny CLASSES of batch entries
 * (e.g. "deletes under ~/Downloads auto-approve") by supplying a
 * different decider — the record shape stays.
 *
 * REPL-only: batch approval needs a human; in daemon contexts the tool
 * is not visible (contexts: ['repl']).
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { argSignature } from '../../../moat/approvalEngine';

interface PlannedOp {
  tool:   string;
  args:   Record<string, unknown>;
  reason: string;
}

/** Parse "all" / "none" / "1,3-5" into approved indices (1-based input). */
export function parseApprovalSelection(answer: string, count: number): number[] | 'invalid' {
  const a = answer.trim().toLowerCase();
  if (a === 'all' || a === 'yes' || a === 'y') return Array.from({ length: count }, (_, i) => i);
  if (a === 'none' || a === 'no' || a === 'n' || a === '') return [];
  const picked = new Set<number>();
  for (const part of a.split(',')) {
    const p = part.trim();
    if (p.length === 0) continue;
    const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Number(range[1]); const hi = Number(range[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 1 || hi > count || lo > hi) return 'invalid';
      for (let i = lo; i <= hi; i += 1) picked.add(i - 1);
      continue;
    }
    const n = Number(p);
    if (!Number.isFinite(n) || n < 1 || n > count) return 'invalid';
    picked.add(n - 1);
  }
  return [...picked].sort((x, y) => x - y);
}

function describeOp(op: PlannedOp): string {
  const a = op.args;
  const target =
    typeof a.path === 'string' ? a.path :
    typeof a.from === 'string' && typeof a.to === 'string' ? `${a.from} -> ${a.to}` :
    JSON.stringify(a).slice(0, 120);
  return `${op.tool}  ${target}  (${op.reason})`;
}

export const planApprovalTool: ToolHandler = {
  schema: {
    name: 'plan_approval',
    description:
      'Present a batch of INTENDED destructive operations (deletes/moves/etc.) for ONE user approval before executing any of them. ' +
      'Submit the exact tool name + exact args you will call for each operation, with a short reason. ' +
      'The user approves all/selected/none; approved entries are pre-cleared so the follow-up calls will not re-prompt — ' +
      'call each approved tool afterwards with EXACTLY the args echoed back. Never perform destructive operations that were declined.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One-line summary of the batch (e.g. "Delete 4 duplicate files").' },
        operations: {
          type: 'array',
          description: 'The intended destructive operations, in execution order.',
          items: {
            type: 'object',
            properties: {
              tool:   { type: 'string', description: 'Exact tool to be called (e.g. file_delete, file_move).' },
              args:   { type: 'object', description: 'EXACT args the follow-up call will use.' },
              reason: { type: 'string', description: 'Why this operation is needed.' },
            },
            required: ['tool', 'args', 'reason'],
          },
        },
      },
      required: ['title', 'operations'],
    },
  },
  category: 'execute',
  mutates:  false,          // presents + records; never executes
  toolset:  'files',
  riskTier: 'safe',
  contexts: ['repl'],
  async execute(args, ctx) {
    const title = String(args.title ?? 'Planned operations');
    const rawOps = Array.isArray(args.operations) ? args.operations as unknown[] : [];
    const ops: PlannedOp[] = [];
    for (const o of rawOps) {
      if (
        o && typeof o === 'object'
        && typeof (o as PlannedOp).tool === 'string'
        && (o as PlannedOp).args && typeof (o as PlannedOp).args === 'object'
        && typeof (o as PlannedOp).reason === 'string'
      ) ops.push(o as PlannedOp);
    }
    if (ops.length === 0) {
      return { success: false, error: 'operations must be a non-empty array of {tool, args, reason}' };
    }
    if (!ctx.clarify) {
      return {
        success: false,
        status:  'unavailable',
        error:   'plan_approval needs an interactive user to decide; no clarify surface in this context',
      };
    }
    if (!ctx.approvalEngine) {
      return { success: false, error: 'no approval engine wired in this context' };
    }

    const lines = ops.map((op, i) => `${i + 1}. ${describeOp(op)}`);
    const question =
      `${title}\n${lines.join('\n')}\n` +
      `Approve which operations? (all / none / numbers like "1,3-5")`;
    const answer = await ctx.clarify(question);
    let selection = parseApprovalSelection(answer ?? 'none', ops.length);
    if (selection === 'invalid') {
      // One retry with an explicit format reminder; anything still
      // unparseable counts as none (never guess approval).
      const retry = await ctx.clarify(`Could not parse "${answer}". Reply exactly: all, none, or numbers like "1,3-5".`);
      selection = parseApprovalSelection(retry ?? 'none', ops.length);
      if (selection === 'invalid') selection = [];
    }

    const approvedIdx = new Set(selection);
    const approved: PlannedOp[] = [];
    const declined: PlannedOp[] = [];
    ops.forEach((op, i) => (approvedIdx.has(i) ? approved : declined).push(op));

    // Register exactly the approved signatures on the SESSION allowlist —
    // the engine (not this tool) still gates every dispatch.
    const engine = ctx.approvalEngine as unknown as {
      allowForSession(tool: string, signature: string): void;
      getMode(): string;
    };
    for (const op of approved) {
      engine.allowForSession(op.tool, argSignature(op.tool, op.args));
    }

    return {
      success:   true,
      title,
      mode:      engine.getMode(),
      decidedVia: 'user',
      approvedCount: approved.length,
      declinedCount: declined.length,
      // Echo the EXACT args so the model repeats them verbatim — the
      // session-allowlist match is signature-exact by design.
      approved:  approved.map((op) => ({ tool: op.tool, args: op.args, reason: op.reason })),
      declined:  declined.map((op) => ({ tool: op.tool, args: op.args, reason: op.reason })),
      instruction:
        approved.length > 0
          ? 'Execute ONLY the approved operations, calling each tool with EXACTLY the echoed args. Do not perform declined operations.'
          : 'No operations were approved. Do not perform any of them.',
    };
  },
};
