/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/toolPreview.ts — Phase v4.1.2 alive-core.
 *
 * Clean per-tool argument previews. Replaces the old
 * `JSON.stringify(args)` blob in `display.toolPreview` with a
 * tool-aware lookup that extracts the primary argument (the one
 * actually useful at a glance — `command` for terminal, `path` for
 * file ops, `query` for search, etc.).
 *
 * Unknown tools use a bounded human argument count in compact mode.
 * Structured details remain available through full/debug projections.
 *
 * Adding a new tool with a non-obvious primary arg? Add it here.
 * Tools whose `args` shape is "the arg is meaningful at-a-glance"
 * (a path, a query, a command, a URL, an id, a name) belong in this map.
 * Tools whose args are a small flag bag (e.g. system_info has no args
 * worth showing) can be omitted — the renderer hides the args block
 * entirely when the map returns `null` and the arg object is empty.
 */

/**
 * v4.1.4 Phase 3b' (Issue H1) — extractor function support.
 *
 * A `TOOL_PRIMARY_ARG` entry can now be either:
 *   - A string: the name of the property in `args` to render (legacy
 *     behavior, unchanged).
 *   - A function: takes `args` and returns the preview string. Use
 *     when no single key holds the meaningful target (e.g. app_launch
 *     uses `explorer.exe` as the binary but the real target is the
 *     URI in `args[0]`).
 *
 * Functions must return a string. Return `''` to show no preview
 * (matches the empty-key convention). Pure — no side effects.
 */
import { truncateVisible, visibleLength } from './box';

export type ToolPreviewExtractor = string | ((args: unknown) => string);

/**
 * Map of tool-name → preview extractor (string key OR function).
 * Stable contract; tests assert specific entries.
 */
export const TOOL_PRIMARY_ARG: Record<string, ToolPreviewExtractor> = {
  // ── terminal / execution ─────────────────────────────────────────────
  shell_exec:        'command',
  execute_code:      'code',

  // ── file ops ─────────────────────────────────────────────────────────
  file_read: (args: unknown): string => {
    if (!args || typeof args !== 'object') return '';
    const input = args as Record<string, unknown>;
    const target = typeof input.path === 'string' ? input.path
      : typeof input.file === 'string' ? input.file : '';
    if (!target) return '';
    const hasOffset = typeof input.offset === 'number' && Number.isFinite(input.offset);
    const hasLimit = typeof input.limit === 'number' && Number.isFinite(input.limit);
    if (!hasOffset && !hasLimit) return target;
    const offset = hasOffset ? Math.max(0, Math.floor(input.offset as number)) : 0;
    if (!hasLimit) return `${target} · from char ${offset}`;
    const limit = Math.max(1, Math.floor(input.limit as number));
    return `${target} · chars ${offset}–${offset + limit - 1}`;
  },
  read_file:          'path',
  read_text_file:     'path',
  file_write:        'path',
  file_patch:        'path',
  file_list:         'path',
  file_copy:         'source',
  file_move:         'source',
  file_delete:       'path',

  // ── web ──────────────────────────────────────────────────────────────
  web_search:        'query',
  deep_research:     'query',
  youtube_search:    'query',
  fetch_url:         'url',
  fetch_page:        'url',
  open_url:          'url',

  // ── browser ──────────────────────────────────────────────────────────
  browser_navigate:  'url',
  browser_click:     'selector',
  browser_fill:      'selector',
  browser_type:      'selector',
  browser_scroll:    'selector',
  browser_extract:   'selector',
  browser_get_url:   '',           // no args — present so map lookup hits
  browser_screenshot:'path',
  browser_close:     '',

  // ── memory ───────────────────────────────────────────────────────────
  memory_add:        'content',
  memory_remove:     'content',
  memory_replace:    'old',

  // ── skills ───────────────────────────────────────────────────────────
  skill_view:        'name',
  skill_manage:      'action',
  skills_list:       '',
  // v4.1.5 Phase 1d (Q-Q1-a) — registry introspection tool. Args
  // shape: `{ toolName: 'web_search' }`. The agent uses this to
  // discover unfamiliar tool schemas during planning. Surface the
  // target tool name so the trail row (when not suppressed via
  // TRAIL_HIDE_TOOLS) reads as the introspected tool, not raw JSON.
  // Note: most callers see this tool suppressed entirely from the
  // visible trail via the TRAIL_HIDE_TOOLS set in display.ts; the
  // extractor exists for code paths that DON'T suppress (verbose
  // mode, log-file capture).
  lookup_tool_schema: 'toolName',

  // ── sessions ─────────────────────────────────────────────────────────
  session_search:    'query',
  session_list:      '',
  session_summary:   'trigger',

  // ── process ──────────────────────────────────────────────────────────
  process_spawn:     'command',
  process_kill:      'pid',
  process_list:      '',
  process_wait:      'pid',
  process_log_read:  'pid',

  // ── subagent ─────────────────────────────────────────────────────────
  subagent_fanout:   'mode',

  // ── system / misc ────────────────────────────────────────────────────
  system_info:       '',
  now_playing:       '',
  get_natural_events:'',

  // ── v4.1.4-media — three-layer media-control bundle ──────────────────
  // `media_sessions` has no args by schema; the empty-arg preview is
  // suppressed by buildToolPreview returning ''.
  // `media_transport` → preview by target ("spotify"), the actionable
  // identifier the user typed. `action` is intentionally NOT chosen —
  // GSMTC actions (play/pause/toggle) are short, the target is the
  // discriminator.
  // `media_key` is layer-3 fallback; show `action` since there's no
  // target to surface (it's a blind keystroke).
  // `app_input` shows `app` so the user sees which window got the keys.
  media_sessions:    '',
  media_transport:   'target',
  media_key:         'action',
  app_input:         'app',

  // ── v4.1.4 Phase 3b' (Issue H) ───────────────────────────────────────
  // app_launch needs custom logic: when `app === 'explorer.exe'` the
  // binary is just the URI dispatcher and the meaningful target is in
  // `args[0]` (e.g. 'spotify:track/...'). Surface the protocol scheme
  // ('spotify') rather than the dispatch binary. Falls through to the
  // app name for normal exe launches.
  app_launch: (args: unknown): string => {
    if (!args || typeof args !== 'object') return '';
    const a = args as { app?: unknown; args?: unknown };
    const appRaw = typeof a.app === 'string' ? a.app.trim() : '';
    // URI-protocol case: explorer.exe + 'scheme:...' in args[0].
    if (appRaw.toLowerCase() === 'explorer.exe' && Array.isArray(a.args)) {
      const first = a.args[0];
      if (typeof first === 'string' && first.length > 0) {
        // Scheme requires ≥2 chars so Windows drive letters
        // (`C:/path`) don't mis-detect as the scheme `C`. Real URI
        // schemes (spotify, vscode, http, file, etc.) are all
        // multi-char by RFC.
        const m = first.match(/^([A-Za-z][A-Za-z0-9+.-]+):/);
        if (m) return m[1]!;       // 'spotify:track/...' → 'spotify'
        return first;              // No protocol — surface the raw arg
      }
    }
    return appRaw;
  },

  // Clipboard write — the actual text being copied is the meaningful
  // target. Reads have no args worth showing (empty schema).
  clipboard_write: 'text',
  clipboard_read:  '',
};

/**
 * Maximum visible terminal columns for the preview value. Long commands /
 * full file contents get truncated with an ellipsis so a single tool
 * row stays on one line at typical terminal widths.
 */
const PREVIEW_MAX_CHARS = 120;

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/gu;

function cleanPreviewText(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncatePreview(value: string, columns = PREVIEW_MAX_CHARS): string {
  const clean = cleanPreviewText(value);
  if (visibleLength(clean) <= columns) return clean;
  return `${truncateVisible(clean, Math.max(0, columns - 1))}…`;
}

function summarizeShellCommand(command: string): string {
  const statements = command
    .split(/(?:\r?\n|\s*;\s*|\s*&&\s*|\s*\|\|\s*)/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const firstStatement = statements[0] ?? command;
  const withoutQuietRedirection = firstStatement
    .replace(/\s+(?:\d?>|\d?>>)\s*\$null\s*$/iu, '')
    .trim();
  const remaining = statements.length > 1 ? ` · +${statements.length - 1} steps` : '';
  const semantic = /\bSelect-String\b/iu.test(command)
    ? 'search repository source'
    : /\bGet-Content\b/iu.test(command)
      ? 'read repository source'
      : /\b(?:Get-ChildItem|rg(?:\.exe)?)\b/iu.test(command)
        ? 'inspect repository files'
        : /^\s*\$[A-Za-z_][\w]*\s*=|@\(/u.test(withoutQuietRedirection)
          ? 'run PowerShell inspection'
          : withoutQuietRedirection || command;
  return truncatePreview(`${semantic}${remaining}`);
}

/** Human compact fallback for unmapped or structured tool arguments. */
export function summarizeToolArguments(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return truncatePreview(args);
  if (typeof args !== 'object') return String(args);
  if (Array.isArray(args)) return `${args.length} ${args.length === 1 ? 'item' : 'items'}`;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';
  return `${entries.length} ${entries.length === 1 ? 'argument' : 'arguments'}`;
}

function summarizeStructuredValue(value: object): string {
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  const entries = Object.entries(value as Record<string, unknown>);
  const safeValues = entries
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 2)
    .map(([, value]) => cleanPreviewText(String(value)))
    .filter(Boolean);
  if (safeValues.length > 0) return truncatePreview(safeValues.join(' · '));
  return `${entries.length} ${entries.length === 1 ? 'argument' : 'arguments'}`;
}

/**
 * Build the per-tool preview string for `args`. Returns:
 *   - `null` when the tool isn't in the map (caller falls back to the
 *     legacy JSON.stringify path),
 *   - `''` (empty string) when the tool is in the map but has no
 *     meaningful primary arg (caller renders just the tool name),
 *   - the truncated string value of the primary arg otherwise.
 *
 * Exposed for unit tests. Pure function, no side effects.
 */
export function buildToolPreview(
  toolName: string,
  args: unknown,
  opts: { mode?: 'summary' | 'full' } = {},
): string | null {
  if (!Object.prototype.hasOwnProperty.call(TOOL_PRIMARY_ARG, toolName)) {
    return null;
  }
  const extractor = TOOL_PRIMARY_ARG[toolName]!;

  // v4.1.4 Phase 3b' (Issue H1): function extractor path. Used by
  // tools whose preview can't be expressed as a single key lookup
  // (e.g. app_launch with URI-protocol routing through explorer.exe).
  let str: string;
  if (typeof extractor === 'function') {
    try {
      const out = extractor(args);
      str = typeof out === 'string' ? out : '';
    } catch {
      // Extractor threw — degrade to empty preview rather than crash
      // the tool-row render. The tool name + state cluster still
      // carries enough info.
      str = '';
    }
  } else {
    // String-key path (legacy, unchanged behaviour).
    const argKey = extractor;
    if (argKey === '') return '';
    if (!args || typeof args !== 'object') return '';
    const raw = (args as Record<string, unknown>)[argKey];
    if (raw === undefined || raw === null) return '';
    if (typeof raw === 'string') {
      str = raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      str = String(raw);
    } else if (opts.mode === 'full') {
      try { str = JSON.stringify(raw); } catch { str = String(raw); }
    } else {
      str = summarizeStructuredValue(raw as object);
    }
  }

  if (opts.mode !== 'full' && toolName === 'shell_exec') {
    return summarizeShellCommand(str);
  }
  return truncatePreview(str);
}
