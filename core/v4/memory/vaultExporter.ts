/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/vaultExporter.ts — v4.11 Obsidian-compatible vault mirror
 *
 * Read-only export of Aiden's memory artifacts into a flat per-entry
 * markdown layout suitable for browsing in Obsidian (or any
 * markdown editor). v1 scope: ADDITIVE ONLY — the export never
 * mutates the memory write path, and vault edits never flow back.
 *
 * Vault layout (created lazily; root = `<vault>/aiden-memory/`):
 *
 *     <vault>/aiden-memory/
 *     ├── memory/    — MEMORY.md entries, one note each
 *     ├── user/      — USER.md entries
 *     ├── project/   — <projectRoot>/.aiden/PROJECT.md (when present)
 *     ├── sessions/  — distillations/<uuid>.json rendered as markdown
 *     ├── soul/      — SOUL.md mirrored as a single note (read-only)
 *     └── notes/     — empty placeholder for user's hand-written notes
 *                      (NOT ingested in v1; reserved for v2)
 *
 * Frontmatter on every auto-generated note:
 *
 *     ---
 *     namespace: memory|user|project|sessions|soul
 *     source_file: relative path inside aiden home
 *     entry_id: short stable hash of the entry's content
 *     created: ISO timestamp (first export of this entry)
 *     updated: ISO timestamp (every export)
 *     scope: aiden-auto | aiden-identity (the latter on SOUL mirror)
 *     readonly: true | false  (true on SOUL; vault never writes back)
 *     ---
 *
 * Filename scheme: `<slug>-<hash4>.md` where slug derives from the
 * first heading or first ~5 words of the entry (lowercased, hyphenated)
 * and hash4 is the first 4 hex of a content hash. Same entry → same
 * filename across re-exports (idempotent). Distinct entries with the
 * same slug differ in their hash suffix so no collision.
 *
 * Idempotency: every export is "compute what files should exist, write
 * them, remove any stale `.md` in the export dir that's not in the
 * current set." Bare files dropped into the namespace dir by the user
 * are preserved (only files matching the `<slug>-<4hex>.md` pattern
 * are eligible for cleanup) — this protects user-added scratch notes
 * accidentally placed in `memory/` etc.
 *
 * Defensive: malformed source files (missing/unreadable/bad JSON for
 * distillations) are skipped with a logged warning; the export
 * continues with whatever it can read.
 *
 * The export NEVER reads from `notes/` and NEVER writes into it
 * (other than creating the empty directory on first export). User's
 * hand-written notes live there safely.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { AidenPaths } from '../paths';
import { resolveUserPath } from '../paths';
import { ENTRY_SEPARATOR } from '../memoryManager';

// ── Public types ──────────────────────────────────────────────────────

export interface VaultExporterDeps {
  paths:        AidenPaths;
  /** Absolute path to the vault root. The exporter writes into
   *  `<vaultPath>/aiden-memory/<source>/`. */
  vaultPath:    string;
  /** Optional project root for per-project memory; null when not
   *  in a repo. */
  projectRoot?: string | null;
  /** Best-effort logger. Errors during export are NEVER fatal. */
  log?:         (level: 'info' | 'warn', msg: string) => void;
}

export interface ExportSummary {
  written:    number;
  removed:    number;
  skipped:    number;
  errors:     string[];
}

// ── Constants ─────────────────────────────────────────────────────────

const VAULT_SUBDIR    = 'aiden-memory';
const NAMESPACE_DIRS  = ['memory', 'user', 'project', 'sessions', 'soul', 'notes'] as const;
type   NamespaceDir   = typeof NAMESPACE_DIRS[number];

/** Filenames `<slug>-<4hex>.md` are auto-generated. User-dropped
 *  notes (anything not matching this pattern) are preserved by the
 *  stale-file cleanup pass. */
const AUTO_FILENAME_RE = /^[a-z0-9][a-z0-9-]*-[0-9a-f]{4}\.md$/;

// ── Resolve vault path from env > config > undefined ──────────────────

/**
 * Boot-time resolver. Env var wins over config; empty string treated
 * as unset. Returns `null` when no vault is configured (= feature
 * off → exporter is a no-op).
 *
 * v4.12.1 — routed through `resolveUserPath` (quote-strip, ~ expansion,
 * absolute-wins) so a quoted value from `setx` / a hand-edited config can
 * no longer be glued onto the cwd (`C:\...\DevOS\"C:\Users\...`).
 *
 * Poisoned-value guard: a config persisted by the PRE-v4.11 `/memory
 * vault link` bug holds an already-glued absolute path with a quote char
 * embedded MID-string — no resolver can un-glue that. Rather than export
 * into a garbage directory, surface it via `onWarn` and treat the vault
 * as unconfigured. (`"` is illegal in Windows paths and never intentional
 * in a configured vault path; a mid-string apostrophe — O'Brien — is
 * legitimate on POSIX, so only `"` triggers the guard.)
 */
export function resolveVaultPath(
  envValue:    string | undefined,
  configValue: string | undefined,
  onWarn?:     (msg: string) => void,
): string | null {
  const resolved = resolveUserPath(envValue) ?? resolveUserPath(configValue);
  if (resolved === null) return null;
  if (resolved.includes('"')) {
    onWarn?.(
      'vault_path is malformed (contains a quote character) — vault export disabled. ' +
      'Re-run /memory vault link <path> (or fix AIDEN_VAULT_PATH).',
    );
    return null;
  }
  return resolved;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Full export of every source into the vault. Idempotent. Returns a
 * summary; never throws (errors collected into `errors[]`).
 */
export async function exportAll(deps: VaultExporterDeps): Promise<ExportSummary> {
  const summary: ExportSummary = { written: 0, removed: 0, skipped: 0, errors: [] };
  await ensureDirs(deps.vaultPath, summary);

  // memory / user — always
  await exportNamespace(deps, 'memory', deps.paths.memoryMd, summary);
  await exportNamespace(deps, 'user',   deps.paths.userMd,   summary);

  // project — only when projectRoot is set
  if (deps.projectRoot) {
    const projectMd = path.join(deps.projectRoot, '.aiden', 'PROJECT.md');
    await exportNamespace(deps, 'project', projectMd, summary);
  }

  // sessions — render every distillation as one note
  await exportSessions(deps, summary);

  // soul — read-only mirror
  await exportSoul(deps, summary);

  deps.log?.('info', `[vault] exported ${summary.written} note(s), removed ${summary.removed} stale, skipped ${summary.skipped}`);
  return summary;
}

/**
 * Export one memory namespace (memory|user|project). Splits the source
 * `.md` file on the entry separator, writes one note per entry,
 * cleans up stale auto-generated files.
 *
 * Source file missing/unreadable is treated as "no entries" — the
 * namespace dir is wiped clean of auto files but kept on disk so
 * the user can still see the structure.
 */
export async function exportNamespace(
  deps:       VaultExporterDeps,
  namespace:  'memory' | 'user' | 'project',
  sourcePath: string,
  summary:    ExportSummary,
): Promise<void> {
  const dir = path.join(deps.vaultPath, VAULT_SUBDIR, namespace);
  await safeMkdir(dir);

  const raw = await readFileOrEmpty(sourcePath);
  const entries = splitEntries(raw);
  const expectedNames = new Set<string>();

  for (const entry of entries) {
    try {
      const id       = entryHash(entry);
      const slug     = slugify(entry);
      const filename = `${slug}-${id}.md`;
      expectedNames.add(filename);

      const filePath = path.join(dir, filename);
      const existing = await readFileOrEmpty(filePath);
      const created  = extractFrontmatterField(existing, 'created') ?? nowIso();
      const updated  = nowIso();

      const fm = {
        namespace,
        source_file: relativeFromHome(deps.paths, sourcePath),
        entry_id:    id,
        created,
        updated,
        scope:       'aiden-auto',
        readonly:    false,
      };
      const body = renderEntryBody(entry, namespace);
      await writeNote(filePath, fm, body);
      summary.written += 1;
    } catch (err) {
      summary.errors.push(`[${namespace}] ${(err as Error).message}`);
      summary.skipped += 1;
    }
  }

  summary.removed += await cleanStaleAutoNotes(dir, expectedNames);
}

/**
 * Render every `distillations/<uuid>.json` as one markdown note in
 * `sessions/`. Bullets / decisions / open_items / keywords each
 * become their own H2 section with bullet lists.
 */
export async function exportSessions(
  deps:    VaultExporterDeps,
  summary: ExportSummary,
): Promise<void> {
  const dir = path.join(deps.vaultPath, VAULT_SUBDIR, 'sessions');
  await safeMkdir(dir);

  let files: string[] = [];
  try {
    files = (await fs.readdir(deps.paths.distillationsDir))
      .filter((f) => f.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      summary.errors.push(`[sessions] ${(err as Error).message}`);
    }
  }
  const expected = new Set<string>();

  for (const f of files) {
    try {
      const full = path.join(deps.paths.distillationsDir, f);
      const raw  = await fs.readFile(full, 'utf8');
      const j    = JSON.parse(raw) as Record<string, unknown>;
      const sessionId = String(j.session_id ?? path.basename(f, '.json'));
      const id        = sessionId.slice(0, 4);  // session id already unique
      const slug      = slugify(`session ${(j.started_at as string)?.slice(0, 10) ?? sessionId}`);
      const filename  = `${slug}-${id}.md`;
      expected.add(filename);

      const fm = {
        namespace:   'sessions',
        source_file: relativeFromHome(deps.paths, full),
        entry_id:    sessionId,
        created:     String(j.started_at ?? nowIso()),
        updated:     String(j.ended_at   ?? nowIso()),
        scope:       'aiden-auto',
        readonly:    false,
      };
      const body = renderSessionBody(j);
      await writeNote(path.join(dir, filename), fm, body);
      summary.written += 1;
    } catch (err) {
      summary.errors.push(`[sessions] ${f}: ${(err as Error).message}`);
      summary.skipped += 1;
    }
  }
  summary.removed += await cleanStaleAutoNotes(dir, expected);
}

/**
 * Mirror SOUL.md as a single read-only note. The frontmatter marks
 * `scope: aiden-identity` + `readonly: true` so future vault-editor
 * tools / users know not to round-trip edits.
 */
export async function exportSoul(
  deps:    VaultExporterDeps,
  summary: ExportSummary,
): Promise<void> {
  const dir = path.join(deps.vaultPath, VAULT_SUBDIR, 'soul');
  await safeMkdir(dir);

  const body = await readFileOrEmpty(deps.paths.soulMd);
  if (!body.trim()) {
    summary.skipped += 1;
    return;
  }
  const id       = entryHash(body);
  const filename = `soul-${id}.md`;
  const filePath = path.join(dir, filename);
  const existing = await readFileOrEmpty(filePath);
  const created  = extractFrontmatterField(existing, 'created') ?? nowIso();

  const fm = {
    namespace:   'soul',
    source_file: relativeFromHome(deps.paths, deps.paths.soulMd),
    entry_id:    id,
    created,
    updated:     nowIso(),
    scope:       'aiden-identity',
    readonly:    true,
  };
  // Trailing note that any vault edit here is ignored — protects
  // users who might assume Obsidian edits round-trip.
  const note = body.trimEnd() +
    "\n\n---\n_Read-only mirror — vault edits are NOT synced back to Aiden's identity._\n";
  await writeNote(filePath, fm, note);
  summary.written += 1;
  summary.removed += await cleanStaleAutoNotes(dir, new Set([filename]));
}

// ── Helpers ───────────────────────────────────────────────────────────

function splitEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(ENTRY_SEPARATOR)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/** Short, stable content hash — 4 hex chars from sha1. Stable across
 *  re-exports for the same entry, so the filename doesn't churn. */
function entryHash(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 4);
}

/** Lowercase, hyphenated, max 40 chars. Picks the first markdown
 *  heading if one's in the entry; otherwise the first ~5 words. */
function slugify(content: string): string {
  const headingMatch = content.match(/^\s*#{1,6}\s+(.+?)\s*$/m);
  const seed = headingMatch ? headingMatch[1] : content.split(/\s+/).slice(0, 5).join(' ');
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'entry';
}

function nowIso(): string {
  return new Date().toISOString();
}

function relativeFromHome(paths: AidenPaths, abs: string): string {
  const rel = path.relative(paths.root, abs);
  return rel.replace(/\\/g, '/');
}

async function readFileOrEmpty(p: string): Promise<string> {
  try { return await fs.readFile(p, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

async function safeMkdir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureDirs(vaultPath: string, summary: ExportSummary): Promise<void> {
  try {
    for (const sub of NAMESPACE_DIRS) {
      await safeMkdir(path.join(vaultPath, VAULT_SUBDIR, sub));
    }
  } catch (err) {
    summary.errors.push(`ensureDirs: ${(err as Error).message}`);
  }
}

/**
 * Serialise frontmatter as YAML. Built manually — no js-yaml dep
 * needed for the flat string-keyed values we emit, and avoids any
 * surprise quoting behaviour.
 */
function serialiseFrontmatter(fm: Record<string, string | boolean>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else {
      // Quote only when the value contains a YAML-sensitive char.
      const needsQuote = /[:#&*!|>%@`,\\[\]{}]/.test(v) || /^\s|\s$/.test(v);
      lines.push(needsQuote ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/** Read a string field from frontmatter (for created-timestamp
 *  stability across re-exports). Returns null when absent. */
function extractFrontmatterField(noteContent: string, key: string): string | null {
  if (!noteContent.startsWith('---')) return null;
  const end = noteContent.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = noteContent.slice(3, end);
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm');
  const m = fm.match(re);
  return m ? m[1] : null;
}

/** Append a small Related section so Obsidian's backlinks panel
 *  surfaces sibling notes in the same namespace. Keeps the entry
 *  body verbatim above the marker. */
function renderEntryBody(entry: string, namespace: string): string {
  const related = `\n\n## Related\n- Namespace: [[${namespace}]]\n`;
  return entry.trimEnd() + related;
}

function renderSessionBody(j: Record<string, unknown>): string {
  const lines: string[] = [];
  const startedAt = j.started_at ? String(j.started_at) : null;
  const endedAt   = j.ended_at   ? String(j.ended_at)   : null;
  const exitPath  = j.exit_path  ? String(j.exit_path)  : null;
  const userTurns = typeof j.user_turns === 'number' ? j.user_turns : null;
  if (startedAt || endedAt) {
    lines.push(`**Started:** ${startedAt ?? '?'}  ·  **Ended:** ${endedAt ?? '?'}`);
  }
  if (exitPath)      lines.push(`**Exit:** ${exitPath}`);
  if (userTurns != null) lines.push(`**User turns:** ${userTurns}`);
  if (lines.length > 0) lines.push('');

  const section = (title: string, key: string): void => {
    const arr = Array.isArray(j[key]) ? j[key] as unknown[] : [];
    if (arr.length === 0) return;
    lines.push(`## ${title}`);
    for (const item of arr) lines.push(`- ${String(item)}`);
    lines.push('');
  };
  section('Bullets',     'bullets');
  section('Decisions',   'decisions');
  section('Open items',  'open_items');
  section('Keywords',    'keywords');
  lines.push('## Related');
  lines.push('- Namespace: [[sessions]]');
  return lines.join('\n');
}

/**
 * Atomic write via temp+rename, mirroring memoryManager's approach.
 * Frontmatter is rebuilt fresh each call so the note's header always
 * reflects the latest export state.
 */
async function writeNote(
  filePath: string,
  fm:       Record<string, string | boolean>,
  body:     string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = `${serialiseFrontmatter(fm)}\n\n${body.trimEnd()}\n`;
  const tmp     = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* swallow */ }
    throw err;
  }
}

/**
 * Remove auto-generated notes (filename matches the `<slug>-<4hex>.md`
 * pattern) that aren't in the current expected set. User-dropped
 * files with other filenames are preserved.
 */
async function cleanStaleAutoNotes(dir: string, expected: Set<string>): Promise<number> {
  let removed = 0;
  let entries: string[];
  try { entries = await fs.readdir(dir); }
  catch { return 0; }
  for (const name of entries) {
    if (expected.has(name)) continue;
    if (!AUTO_FILENAME_RE.test(name)) continue;  // user file — skip
    try {
      await fs.unlink(path.join(dir, name));
      removed += 1;
    } catch { /* race/permission — skip silently */ }
  }
  return removed;
}
