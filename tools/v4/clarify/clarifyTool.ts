/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/clarify/clarifyTool.ts — v4.11 Slice 1 (mechanism).
 *
 * The `clarify` tool: when the model is missing information needed to do
 * the task correctly AND no lookup tool can resolve it, it asks the user
 * a question and receives their answer — instead of guessing and
 * confidently doing the wrong thing (the honesty complement to the
 * verifier: don't fabricate missing inputs).
 *
 * Mechanism only (Slice 1). The WHEN-to-ask policy is deliberately left
 * to the existing conservative SOUL rule ("ask only when no tool can
 * resolve the ambiguity"); a deliberate policy tune is a separate slice.
 *
 * Control flow reuses the approval pattern: `execute` awaits a
 * `ctx.clarify` callback (wired to the REPL's readLine/prompt path), so
 * the turn pauses mid-loop and resumes with the answer as the tool
 * result — no new finish reason, no turn-loop surgery.
 *
 * `contexts: ['repl']` — the tool is excluded from the daemon catalog
 * (getSchemas(_, 'daemon')), and even if reached without a wired
 * callback it degrades to "unavailable, proceed" rather than hang. It is
 * also in SUBAGENT_BLOCKED_TOOL_NAMES (core/v4/subagent/childBuilder.ts)
 * so children — which have no user to ask — never receive it.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ToolSchema } from '../../../providers/v4/types';

/** Max suggested options surfaced as a menu (extra are dropped). */
export const CLARIFY_MAX_OPTIONS = 4;

export const CLARIFY_SCHEMA: ToolSchema = {
  name: 'clarify',
  description:
    'Ask the user ONE clarifying question when information needed to do the ' +
    'task correctly is missing and no other tool can resolve it. Returns the ' +
    "user's answer. Prefer resolving ambiguity with lookup tools first " +
    '(file_read, file_list, web_search, etc.); use clarify only when genuinely ' +
    'blocked. Do not use it for yes/no confirmation of dangerous commands — ' +
    'the approval flow handles that.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The single clarifying question to put to the user.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          `Optional ≤${CLARIFY_MAX_OPTIONS} suggested answers shown as a menu. ` +
          'The user can still type their own answer.',
      },
    },
    required: ['question'],
  },
};

export function makeClarifyTool(): ToolHandler {
  return {
    schema:   CLARIFY_SCHEMA,
    category: 'read',
    mutates:  false,
    toolset:  'clarify',
    riskTier: 'safe',
    // REPL-only: no interactive user exists in the daemon context.
    contexts: ['repl'],
    async execute(args, ctx) {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (!question) {
        return { ok: false, status: 'invalid', error: 'clarify: `question` is required.' };
      }
      const options = Array.isArray(args.options)
        ? args.options
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .slice(0, CLARIFY_MAX_OPTIONS)
        : undefined;

      // Headless / daemon / no interactive user → never hang. Tell the
      // model to proceed with a reasonable default and label the
      // assumption (the honesty contract).
      if (!ctx.clarify) {
        return {
          ok:     false,
          status: 'unavailable',
          answer: null,
          note:
            'clarify is unavailable in this context (no interactive user). ' +
            'Proceed with a reasonable default and label the assumption explicitly.',
        };
      }

      const answer = await ctx.clarify(question, options);
      if (answer === null || answer.trim().length === 0) {
        return {
          ok:     false,
          status: 'cancelled',
          answer: null,
          note:
            'The user did not answer. Proceed with a reasonable default and ' +
            'label the assumption explicitly.',
        };
      }
      return { ok: true, status: 'answered', answer };
    },
  };
}
