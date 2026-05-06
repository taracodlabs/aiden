/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/sessions/sessionList.ts — `session_list` wrapper.
 *
 * Lists recently touched sessions, newest first. Useful for "what
 * was I working on yesterday" queries that don't have a keyword to
 * search for.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export const sessionListTool: ToolHandler = {
  schema: {
    name: 'session_list',
    description:
      'List recently active sessions, newest first. Returns id, title, timestamps, provider/model, and accumulated token totals for each.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `How many sessions to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
        },
        orderBy: {
          type: 'string',
          enum: ['created', 'updated'],
          description:
            "Sort by 'created' (when the session began) or 'updated' (last activity). Defaults to 'updated'.",
        },
      },
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'sessions',
  async execute(args, ctx) {
    if (!ctx.sessions) {
      return {
        success: false,
        error: 'Session manager not available in this context',
      };
    }
    const requested = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));
    const orderBy =
      args.orderBy === 'created' ? 'created' : 'updated';
    const results = ctx.sessions.listSessions({ limit, orderBy });
    return {
      success: true,
      count: results.length,
      sessions: results,
    };
  },
};
