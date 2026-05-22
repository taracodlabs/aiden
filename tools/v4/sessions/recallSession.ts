/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/sessions/recallSession.ts — Phase v4.1.2-memory-C.
 *
 * `recall_session` — return ranked SessionDistillation summaries for
 * past sessions matching the user's query (or just the most recent N
 * when no query is supplied).
 *
 * Coexists with `session_search`:
 *   - session_search → FTS5 over message TEXT in SessionStore.
 *     Returns per-message snippets. Use when the user wants the exact
 *     words of a past message.
 *   - recall_session → ranked DISTILLATIONS by TOPIC. Returns
 *     structured per-session summaries (decisions, open items, files
 *     touched). Use when the user wants context on what HAPPENED in
 *     past sessions.
 *
 * Index strategy: scan-all. Reads every distillation JSON from
 * `<paths.root>/distillations/` per query. Expected file count is
 * <1000 per user; sub-100ms at that scale. When telemetry shows
 * latency >500ms, the escalation path is direct migration to SQLite
 * FTS5 — JSON-index intermediate is intentionally skipped.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { listDistillationIds, readDistillation } from '../../../core/v4/distillationStore';
import {
  rankDistillations,
  type RecallQuery,
  type RecallResult,
} from '../../../core/v4/distillationIndex';
import type { SessionDistillation } from '../../../core/v4/sessionDistiller';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT     = 25;

export const recallSessionTool: ToolHandler = {
  schema: {
    name: 'recall_session',
    description:
      'Recall past SESSIONS by topic. Returns ranked summaries — ' +
      'decisions made, files touched, open items, tool usage — from ' +
      'previously persisted session distillations. ' +
      'For the EXACT WORDS of a past message, call `session_search` ' +
      'instead (FTS5 over message text). For "what happened" / "what ' +
      'did we work on" / "what was unfinished", use this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional keyword filter. Case-insensitive substring match ' +
            'across keywords, bullets, decisions, open_items, and ' +
            'tool names. Omit to get the most recent sessions.',
        },
        limit: {
          type: 'number',
          description:
            `Maximum number of matches to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
        },
        days: {
          type: 'number',
          description:
            'Optional recency window in days. Drops distillations older ' +
            'than this before ranking. Omit for no time filter.',
        },
        include_full: {
          type: 'boolean',
          description:
            'When true, each match also carries tools_used + keywords ' +
            '(useful when the agent needs granular tool history). ' +
            'Default false to keep responses compact.',
        },
      },
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'sessions',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(args, ctx) {
    if (!ctx.paths?.root) {
      return {
        success: false,
        error:   'recall_session requires resolved aiden paths',
      };
    }
    // v4.9.0 Slice 9 — paths hygiene: use centralised distillationsDir
    // when present (added in Slice 9); fall back to the legacy ad-hoc
    // reconstruction so externally-mocked `ctx.paths` objects keep working.
    const dir = ctx.paths.distillationsDir ?? path.join(ctx.paths.root, 'distillations');

    // Read everything off disk first. Each failure (malformed JSON,
    // EACCES on individual files) is skipped silently; the diagnostic
    // for "files exist but couldn't be read" is the gap between
    // scanned (id count) and dists.length (parse-success count).
    let ids: string[];
    try {
      ids = await listDistillationIds(dir);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        // No distillations directory yet — first-run case is
        // success with zero matches, NOT a failure.
        return {
          success:     true,
          query:       typeof args.query === 'string' ? args.query : undefined,
          matches:     [],
          total_found: 0,
          scanned:     0,
        };
      }
      return {
        success: false,
        error:   `Failed to enumerate distillations: ${(err as Error).message}`,
      };
    }

    const dists: SessionDistillation[] = [];
    for (const id of ids) {
      try {
        const d = await readDistillation(dir, id);
        if (d) dists.push(d);
      } catch {
        // One bad file shouldn't prevent the agent from seeing the
        // rest. The user can diagnose via `aiden doctor` (the file
        // is still on disk).
      }
    }

    const recallQuery: RecallQuery = {
      query:        typeof args.query === 'string' ? args.query : undefined,
      limit:        typeof args.limit === 'number' ? args.limit : undefined,
      days:         typeof args.days  === 'number' ? args.days  : undefined,
      include_full: args.include_full === true,
    };
    const ranked: RecallResult = rankDistillations(dists, recallQuery);

    // v4.1.3-repl-polish: mark degraded when any matched session was
    // distilled with the Phase A+B `partial: true` flag (LLM-timeout
    // path — deterministic fields present, semantic bullets/decisions
    // may be empty). The model still gets the full match list; the
    // trail row renders yellow so the user knows recall completed
    // against partial data.
    const partialCount = ranked.matches.filter((m) => m.partial === true).length;
    const degraded = partialCount > 0;

    return {
      success:     true,
      query:       recallQuery.query,
      matches:     ranked.matches,
      total_found: ranked.total_found,
      // scanned reflects files we attempted to read — useful diagnostic.
      // If scanned > ranked.total_found AND dists.length < scanned, the
      // delta is malformed files; the agent can suggest running aiden
      // doctor to inspect.
      scanned:     ids.length,
      ...(degraded && {
        degraded:       true,
        degradedReason: partialCount === 1
          ? '1 matched session has partial distillation data'
          : `${partialCount} matched sessions have partial distillation data`,
      }),
    };

    // Note re: subsystem health — wire-up happens at the runtime
    // construction layer (cli/v4/aidenCLI.ts) where the registry is
    // built. The tool itself stays pure of registry-knowledge for
    // testability; the registry caller decides whether to wrap the
    // file-read errors in a tracker.
  },
};

// Expose the directory path for runtime wire-up. Tools that want to
// register recall_session with the slice3 SubsystemHealthRegistry
// pass this helper to the tracker so they get health snapshots without
// hard-coding the path in two places.
// v4.9.0 Slice 9 — kept for back-compat; mirrors `paths.distillationsDir`
// without requiring the full AidenPaths object.
export function getDistillationsDir(rootDir: string): string {
  return path.join(rootDir, 'distillations');
}

// Re-export read-only fs surface used by tests under controlled
// fixtures. Production code never imports from here; the tool calls
// fs directly.
export const __testFs = fs;
