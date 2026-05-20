/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display/toolTrail.ts — Aiden v4.1.3-repl-polish
 *
 * Icon + verb lookup for the compact tool-trail rows.
 *
 * Format rendered by Display.toolRow():
 *
 *   ┊ {icon} {verb:12} {detail:40}
 *
 * Rules:
 *   - Exact tool-name match tried first (lowercased), then substring,
 *     then the '·' / 'calling' fallback.
 *   - Success outcomes are SILENT — the running row is erased and nothing
 *     persists. Only failed/degraded/blocked rows leave a trace.
 *   - This module is pure (no I/O, no side effects) so it can be tested
 *     in full isolation.
 */

/** Returned by iconForTool. */
export interface ToolIconVerb {
  /** Single glyph rendered outside SGR so emoji native colours show. */
  icon: string;
  /** Present-participle verb (≤12 chars) describing the action. */
  verb: string;
}

/** Width the verb field is padded / trimmed to. */
export const TRAIL_VERB_PAD = 12;
/** Hard cap on the detail (arg-preview) field. */
export const TRAIL_DETAIL_CAP = 40;
/** Row-prefix glyph that replaces the old indent dots. */
export const TRAIL_PIPE = '┊';

type TrailEntry = { readonly keys: readonly string[]; icon: string; verb: string };

/**
 * Ordered lookup table: tool name patterns → { icon, verb }.
 *
 * Exact match (lowercased tool name present in `keys`) is tried before
 * substring match. Entries are ordered from most-specific to most-generic
 * so that e.g. `recall_session` matches 'recalling' before the generic
 * `memory` → 'recalling' entry would.
 *
 * Keep entries grouped by semantic category to make auditing easy.
 */
const TRAIL_MAP: readonly TrailEntry[] = [
  // ── Observe / read / list ────────────────────────────────────────────
  { keys: ['file_read', 'read_file', 'read_text_file', 'read_multiple_files',
           'file_list', 'list_directory', 'list_directory_with_sizes',
           'directory_tree', 'file_info', 'get_file_info',
           'observe', 'read', 'list'],
    icon: '👁️',  verb: 'reading'   },

  // ── Write / edit / create ────────────────────────────────────────────
  { keys: ['file_write', 'write_file', 'edit_file', 'move_file',
           'notebook_edit', 'create_directory',
           'write', 'edit', 'create', 'save'],
    icon: '✏️',  verb: 'writing'   },

  // ── Execute / run / shell ────────────────────────────────────────────
  { keys: ['bash', 'powershell', 'execute_code', 'skill_view',
           'shortcuts_execute', 'javascript_tool',
           'shell_exec', 'process_spawn', 'process_kill',
           'run', 'execute', 'exec'],
    icon: '⚡',  verb: 'running'   },

  // ── Clipboard ────────────────────────────────────────────────────────
  { keys: ['clipboard_read', 'clipboard_write', 'clipboard'],
    icon: '📋',  verb: 'copying'   },

  // ── Web / fetch / browse ─────────────────────────────────────────────
  { keys: ['web_search', 'web_fetch', 'fetch_url', 'fetch_page',
           'open_url', 'navigate', 'get_page_text', 'read_page',
           'browser_extract', 'browser_get_url',
           'search_cloudflare_documentation', 'search_vercel_documentation',
           'search_mcp_registry',
           'browser', 'fetch', 'search'],
    icon: '🌐',  verb: 'fetching'  },

  // ── Memory / recall ──────────────────────────────────────────────────
  { keys: ['recall_session', 'session_search', 'session_list',
           'memory_add', 'memory_search',
           'recall', 'memory'],
    icon: '🧠',  verb: 'recalling' },

  // ── Think / analyse / summarise ──────────────────────────────────────
  { keys: ['session_summary', 'deep_research', 'analyze', 'think', 'plan'],
    icon: '🧠',  verb: 'thinking'  },

  // ── Skills / tools / catalog ─────────────────────────────────────────
  { keys: ['skills_list', 'list_connectors', 'suggest_connectors',
           'skill'],
    icon: '📋',  verb: 'listing'   },

  // ── Screen / capture / inspect ───────────────────────────────────────
  { keys: ['screenshot', 'browser_screenshot', 'aiden__screenshot',
           'preview_screenshot', 'preview_snapshot', 'preview_inspect',
           'computer', 'upload_image', 'read_media_file'],
    icon: '🖥',  verb: 'capturing' },

  // ── Media control ────────────────────────────────────────────────────
  // v4.1.4-media: the new three-layer media-control bundle.
  // Listed BEFORE the launch category so substring matching on `media_*`
  // tool names hits this category first — without this split, every
  // media_* name's substring would collide with the 'media' key in the
  // launch bucket and render as verb "launching".
  { keys: ['media_key', 'media_sessions', 'media_transport',
           'now_playing', 'youtube_search'],
    icon: '▶',   verb: 'media'     },

  // ── Media launch / open ──────────────────────────────────────────────
  // Note: `'media'` as a substring key was removed in v4.1.4 because it
  // false-matched the new media_* control tools above. Launch tools
  // (`app_launch`, `open_url`, etc.) are explicit-keyed.
  { keys: ['app_launch', 'open_url', 'open', 'launch'],
    icon: '▶',   verb: 'launching' },

  // ── Deploy / build / publish ─────────────────────────────────────────
  { keys: ['deploy_to_vercel', 'deploy_edge_function', 'apply_migration',
           'push_notification',
           'deploy', 'build', 'package', 'push'],
    icon: '📦',  verb: 'deploying' },

  // ── Message / notify / send ──────────────────────────────────────────
  { keys: ['create_draft', 'reply_to_toolbar_thread',
           'send', 'message', 'notify', 'email', 'reply'],
    icon: '💬',  verb: 'sending'   },

  // ── Verify / test / health ───────────────────────────────────────────
  { keys: ['get_advisors', 'confirm_cost', 'subsystem_health',
           'verify', 'test', 'doctor', 'health'],
    icon: '🛡',  verb: 'verifying' },

  // ── Database / query ─────────────────────────────────────────────────
  { keys: ['execute_sql', 'd1_database_query',
           'query', 'sql'],
    icon: '🗄',  verb: 'querying'  },
];

/**
 * Return the trail icon and verb for `name`.
 *
 * 1. Exact match — lowercased tool name is in `entry.keys`
 * 2. Substring match — any key appears in the lowercased name
 * 3. Default fallback: `{ icon: '⚡', verb: 'calling' }` — generic
 *    energy glyph for unmapped tools so the row still visually parses
 *    as a tool event even when the category is unknown.
 *
 * Pure — no side effects. Safe to call in hot paths.
 */
export function iconForTool(name: string): ToolIconVerb {
  const lc = name.toLowerCase();
  // Pass 1 — exact match
  for (const entry of TRAIL_MAP) {
    if ((entry.keys as readonly string[]).includes(lc)) {
      return { icon: entry.icon, verb: entry.verb };
    }
  }
  // Pass 2 — substring match (insertion order = priority)
  for (const entry of TRAIL_MAP) {
    for (const key of entry.keys) {
      if (lc.includes(key)) {
        return { icon: entry.icon, verb: entry.verb };
      }
    }
  }
  return { icon: '⚡', verb: 'calling' };
}

/**
 * Pad or trim `verb` to exactly TRAIL_VERB_PAD characters.
 * Pure helper used by Display.toolRow() to keep columns aligned.
 */
export function padVerb(verb: string): string {
  if (verb.length > TRAIL_VERB_PAD) return verb.slice(0, TRAIL_VERB_PAD);
  return verb.padEnd(TRAIL_VERB_PAD);
}

/**
 * Truncate `s` to TRAIL_DETAIL_CAP chars, appending '…' when cut.
 * Collapses internal whitespace first so multi-line args stay on one line.
 */
export function truncDetail(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= TRAIL_DETAIL_CAP) return flat;
  return flat.slice(0, TRAIL_DETAIL_CAP - 1) + '…';
}
