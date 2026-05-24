/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skills/curatedManifest.ts — v4.9.5 Slice 1.
 *
 * Fetch + validate the taracod-curated skills manifest. The
 * manifest.json is hosted at github.com/taracodlabs/aiden-skills and
 * pins each skill to a specific upstream commit so install is
 * reproducible across days (snapshot semantics — upstream-author
 * updates do not propagate automatically).
 *
 * Three exports:
 *   - fetchCuratedManifest(fetchImpl)     — async, NEVER throws
 *   - validateCuratedManifest(raw)        — pure JSON validator
 *   - renderManifestPreview(manifest)     — preview table for
 *                                           the two-stage confirm UX
 *
 * Forward-compat: a manifest with schema_version > 1 returns null +
 * a "please upgrade aiden-runtime" reason. The wizard / slash caller
 * prints the reason and skips the install — no crash.
 */

import { renderTable } from '../../../cli/v4/table';

/** Skills repo URL. Exported so tests can replace via dependency
 *  injection without env vars. */
export const CURATED_MANIFEST_URL =
  'https://raw.githubusercontent.com/taracodlabs/aiden-skills/main/manifest.json';

export type FetchImpl = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// ── Types ────────────────────────────────────────────────────────────

/**
 * A single skill in the manifest. Mirrors the JSON wire shape exactly —
 * the parsed TypeScript type IS the JSON contract.
 */
export interface CuratedManifestEntry {
  name:             string;
  path:             string;
  description:      string;
  category:         string;
  version:          string;
  license:          string;          // SPDX id (MIT, Apache-2.0, ...)
  author:           string;          // single string per Phase B Q3
  upstream_source:  string;          // upstream repo URL
  upstream_commit:  string;          // SHA pinned at snapshot
  size_bytes:       number;
  files:            readonly string[];
}

export interface CuratedManifest {
  schema_version:   number;
  snapshot_at:      string;          // ISO-8601
  commit:           string;          // self-referencing manifest SHA
  skills:           readonly CuratedManifestEntry[];
}

/** Highest manifest schema this Aiden understands. Bumping requires
 *  a code update in this file (typically additive). */
export const SUPPORTED_SCHEMA_VERSION = 1;

// ── Fetch ────────────────────────────────────────────────────────────

export interface FetchResult {
  manifest: CuratedManifest | null;
  reason?:  string;
}

/**
 * Fetch + validate the manifest.json. NEVER throws — surface every
 * error as `{ manifest: null, reason }` so the caller (wizard, slash)
 * can render the reason without a try/catch. The "skip install on
 * error" path is the caller's responsibility.
 */
export async function fetchCuratedManifest(
  fetchImpl: FetchImpl,
  url:       string = CURATED_MANIFEST_URL,
): Promise<FetchResult> {
  let raw: string;
  try {
    const r = await fetchImpl(url);
    if (!r.ok) {
      return { manifest: null, reason: `HTTP ${r.status} fetching ${url}` };
    }
    raw = await r.text();
  } catch (e) {
    return { manifest: null, reason: `network error: ${(e as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { manifest: null, reason: `invalid JSON: ${(e as Error).message}` };
  }

  const validation = validateCuratedManifest(parsed);
  if (!validation.ok) {
    return { manifest: null, reason: validation.reason };
  }
  return { manifest: validation.manifest! };
}

// ── Validate (pure) ──────────────────────────────────────────────────

export interface ValidationResult {
  ok:        boolean;
  manifest?: CuratedManifest;
  reason?:   string;
}

/**
 * Pure schema validator. Walks the parsed JSON, asserts every required
 * field is present + correctly-typed. Forward-compat: a schema_version
 * greater than SUPPORTED_SCHEMA_VERSION is treated as an upgrade hint
 * (returns ok:false with a clear reason); the wizard/slash prints it
 * and skips install rather than crashing.
 */
export function validateCuratedManifest(raw: unknown): ValidationResult {
  if (!isObject(raw)) {
    return { ok: false, reason: 'manifest must be a JSON object' };
  }
  const m = raw as Record<string, unknown>;

  // Schema version first — forward-compat reject before any other field
  // checks so an unknown shape can't accidentally trip type errors.
  if (typeof m.schema_version !== 'number') {
    return { ok: false, reason: 'missing or non-numeric schema_version' };
  }
  if (m.schema_version > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok:     false,
      reason: `Curated manifest schema_version ${m.schema_version} is newer than this Aiden (${SUPPORTED_SCHEMA_VERSION}). ` +
              `Please upgrade aiden-runtime to install curated skills.`,
    };
  }
  if (m.schema_version < 1) {
    return { ok: false, reason: `schema_version ${m.schema_version} is invalid` };
  }

  if (typeof m.snapshot_at !== 'string') {
    return { ok: false, reason: 'missing or non-string snapshot_at' };
  }
  if (typeof m.commit !== 'string') {
    return { ok: false, reason: 'missing or non-string commit' };
  }
  if (!Array.isArray(m.skills)) {
    return { ok: false, reason: 'missing or non-array skills' };
  }

  // Per-skill validation. Bail on the FIRST malformed entry with an
  // index hint — debugging a broken manifest is easier when the error
  // points at the row, not just "something somewhere".
  const entries: CuratedManifestEntry[] = [];
  for (let i = 0; i < m.skills.length; i++) {
    const e = m.skills[i] as unknown;
    if (!isObject(e)) {
      return { ok: false, reason: `skills[${i}] must be an object` };
    }
    const v = entryValidate(e as Record<string, unknown>, i);
    if (!v.ok) return { ok: false, reason: v.reason };
    entries.push(v.entry!);
  }

  return {
    ok:       true,
    manifest: {
      schema_version: m.schema_version,
      snapshot_at:    m.snapshot_at,
      commit:         m.commit,
      skills:         entries,
    },
  };
}

function entryValidate(
  e: Record<string, unknown>,
  i: number,
): { ok: boolean; reason?: string; entry?: CuratedManifestEntry } {
  const required: Array<keyof CuratedManifestEntry> = [
    'name', 'path', 'description', 'category', 'version',
    'license', 'author', 'upstream_source', 'upstream_commit',
  ];
  for (const field of required) {
    if (typeof e[field] !== 'string' || (e[field] as string).trim() === '') {
      return { ok: false, reason: `skills[${i}].${field}: missing or non-string` };
    }
  }
  if (typeof e.size_bytes !== 'number' || e.size_bytes < 0) {
    return { ok: false, reason: `skills[${i}].size_bytes: missing or invalid` };
  }
  if (!Array.isArray(e.files) || e.files.some((f) => typeof f !== 'string')) {
    return { ok: false, reason: `skills[${i}].files: must be string[]` };
  }
  return {
    ok:    true,
    entry: {
      name:            e.name           as string,
      path:            e.path           as string,
      description:     e.description    as string,
      category:        e.category       as string,
      version:         e.version        as string,
      license:         e.license        as string,
      author:          e.author         as string,
      upstream_source: e.upstream_source as string,
      upstream_commit: e.upstream_commit as string,
      size_bytes:      e.size_bytes     as number,
      files:           e.files          as string[],
    },
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// ── Preview renderer ─────────────────────────────────────────────────

export interface PreviewResult {
  table:      string;
  totalBytes: number;
  count:      number;
}

/**
 * Render the two-stage-confirm preview table. Column order per the
 * Phase B UX refinement: Name | Author | Category | License | Size.
 * Author is the second column on purpose — attribution must be
 * visible BEFORE the user confirms, not buried at the right edge.
 *
 * Pure — returns the table string + aggregate stats so the caller can
 * splice both into the prompt without re-walking the manifest.
 */
export function renderManifestPreview(manifest: CuratedManifest): PreviewResult {
  const totalBytes = manifest.skills.reduce((sum, e) => sum + e.size_bytes, 0);
  const rows = manifest.skills.map((e) => ({
    name:     e.name,
    author:   e.author,
    category: e.category,
    license:  e.license,
    size:     `${(e.size_bytes / 1024).toFixed(1)} KB`,
  }));
  const table = renderTable(rows, [
    { key: 'name',     header: 'Name',     align: 'left',  minWidth: 18 },
    { key: 'author',   header: 'Author',   align: 'left',  minWidth: 16 },
    { key: 'category', header: 'Category', align: 'left',  minWidth: 10 },
    { key: 'license',  header: 'License',  align: 'left',  minWidth: 10 },
    { key: 'size',     header: 'Size',     align: 'right', minWidth: 8 },
  ]);
  return { table, totalBytes, count: manifest.skills.length };
}
