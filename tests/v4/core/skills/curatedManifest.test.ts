/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.5 SLICE 1 — curatedManifest coverage.
 *
 * Three layers:
 *   - validateCuratedManifest: pure JSON validation, no IO
 *   - fetchCuratedManifest:    stubbed FetchImpl, no network
 *   - renderManifestPreview:   pure column-shape assertion
 *
 * Forward-compat handling (schema_version > 1) is the load-bearing
 * test — without it, a future repo bump would crash old Aidens.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchCuratedManifest,
  validateCuratedManifest,
  renderManifestPreview,
  CURATED_MANIFEST_URL,
  SUPPORTED_SCHEMA_VERSION,
  type CuratedManifest,
  type FetchImpl,
} from '../../../../core/v4/skills/curatedManifest';

const SAMPLE_ENTRY = {
  name:            'pdf-extractor',
  path:            'skills/pdf-extractor',
  description:     'Extract text + tables from PDFs',
  category:        'files',
  version:         '1.2.0',
  license:         'MIT',
  author:          'Jane Doe',
  upstream_source: 'https://github.com/jdoe/pdf-skill',
  upstream_commit: 'deadbeef1234',
  size_bytes:      42000,
  files:           ['SKILL.md', 'LICENSE'],
};
const SAMPLE_MANIFEST: CuratedManifest = {
  schema_version: 1,
  snapshot_at:    '2026-05-24T08:00:00Z',
  commit:         'abc1234deadbeef',
  skills:         [SAMPLE_ENTRY],
};

// ── validateCuratedManifest ──────────────────────────────────────────

describe('validateCuratedManifest — happy path', () => {
  it('accepts a well-formed v1 manifest with one skill', () => {
    const r = validateCuratedManifest(SAMPLE_MANIFEST);
    expect(r.ok).toBe(true);
    expect(r.manifest).toBeDefined();
    expect(r.manifest!.skills).toHaveLength(1);
    expect(r.manifest!.skills[0].name).toBe('pdf-extractor');
  });

  it('accepts a manifest with zero skills (empty but valid)', () => {
    const r = validateCuratedManifest({ ...SAMPLE_MANIFEST, skills: [] });
    expect(r.ok).toBe(true);
    expect(r.manifest!.skills).toEqual([]);
  });

  it('preserves per-skill files array', () => {
    const r = validateCuratedManifest(SAMPLE_MANIFEST);
    expect(r.manifest!.skills[0].files).toEqual(['SKILL.md', 'LICENSE']);
  });
});

describe('validateCuratedManifest — schema_version handling', () => {
  it('rejects schema_version > SUPPORTED with an upgrade-aiden hint', () => {
    const future = { ...SAMPLE_MANIFEST, schema_version: SUPPORTED_SCHEMA_VERSION + 1 };
    const r = validateCuratedManifest(future);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/schema_version 2 is newer/);
    expect(r.reason).toMatch(/upgrade aiden-runtime/);
  });

  it('rejects schema_version < 1', () => {
    const r = validateCuratedManifest({ ...SAMPLE_MANIFEST, schema_version: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid/);
  });

  it('rejects non-numeric schema_version', () => {
    const r = validateCuratedManifest({ ...SAMPLE_MANIFEST, schema_version: 'one' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-numeric schema_version/);
  });
});

describe('validateCuratedManifest — top-level rejection cases', () => {
  it('rejects non-object input', () => {
    expect(validateCuratedManifest('not-an-object').ok).toBe(false);
    expect(validateCuratedManifest(null).ok).toBe(false);
    expect(validateCuratedManifest([]).ok).toBe(false);
  });

  it('rejects missing snapshot_at', () => {
    const { snapshot_at: _, ...rest } = SAMPLE_MANIFEST;
    void _;
    const r = validateCuratedManifest(rest);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/snapshot_at/);
  });

  it('rejects missing commit', () => {
    const { commit: _, ...rest } = SAMPLE_MANIFEST;
    void _;
    const r = validateCuratedManifest(rest);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/commit/);
  });

  it('rejects non-array skills', () => {
    const r = validateCuratedManifest({ ...SAMPLE_MANIFEST, skills: 'not-array' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/skills/);
  });
});

describe('validateCuratedManifest — per-skill rejection cases', () => {
  it('reports index of malformed entry (not just "something somewhere")', () => {
    const r = validateCuratedManifest({
      ...SAMPLE_MANIFEST,
      skills: [SAMPLE_ENTRY, { ...SAMPLE_ENTRY, author: '' }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/skills\[1\]\.author/);
  });

  it('rejects each required string field individually', () => {
    const required = ['name', 'path', 'description', 'category', 'version',
                      'license', 'author', 'upstream_source', 'upstream_commit'];
    for (const field of required) {
      const broken = { ...SAMPLE_ENTRY, [field]: '' };
      const r = validateCuratedManifest({ ...SAMPLE_MANIFEST, skills: [broken] });
      expect(r.ok, `field=${field}`).toBe(false);
      expect(r.reason, `field=${field}`).toMatch(new RegExp(`\\.${field}`));
    }
  });

  it('rejects non-number size_bytes', () => {
    const r = validateCuratedManifest({
      ...SAMPLE_MANIFEST,
      skills: [{ ...SAMPLE_ENTRY, size_bytes: 'big' }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/size_bytes/);
  });

  it('rejects negative size_bytes', () => {
    const r = validateCuratedManifest({
      ...SAMPLE_MANIFEST,
      skills: [{ ...SAMPLE_ENTRY, size_bytes: -1 }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/size_bytes/);
  });

  it('rejects non-string-array files', () => {
    const r = validateCuratedManifest({
      ...SAMPLE_MANIFEST,
      skills: [{ ...SAMPLE_ENTRY, files: [1, 2] }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/files/);
  });
});

// ── fetchCuratedManifest ─────────────────────────────────────────────

function stubFetch(scripted: { ok: boolean; status: number; body: string }): FetchImpl {
  return vi.fn(async () => ({
    ok:     scripted.ok,
    status: scripted.status,
    text:   async () => scripted.body,
  }));
}

describe('fetchCuratedManifest — IO boundary', () => {
  it('hits the CURATED_MANIFEST_URL by default', async () => {
    const stub = stubFetch({ ok: true, status: 200, body: JSON.stringify(SAMPLE_MANIFEST) });
    await fetchCuratedManifest(stub);
    expect(stub).toHaveBeenCalledWith(CURATED_MANIFEST_URL);
  });

  it('returns the parsed manifest on 200 + valid body', async () => {
    const stub = stubFetch({ ok: true, status: 200, body: JSON.stringify(SAMPLE_MANIFEST) });
    const r = await fetchCuratedManifest(stub);
    expect(r.manifest).not.toBeNull();
    expect(r.manifest!.skills[0].name).toBe('pdf-extractor');
  });

  it('returns null + reason on non-2xx (NEVER throws)', async () => {
    const stub = stubFetch({ ok: false, status: 503, body: '' });
    const r = await fetchCuratedManifest(stub);
    expect(r.manifest).toBeNull();
    expect(r.reason).toMatch(/HTTP 503/);
  });

  it('returns null + reason on invalid JSON', async () => {
    const stub = stubFetch({ ok: true, status: 200, body: '{not-json' });
    const r = await fetchCuratedManifest(stub);
    expect(r.manifest).toBeNull();
    expect(r.reason).toMatch(/invalid JSON/);
  });

  it('returns null + reason when fetch throws (network failure)', async () => {
    const stub: FetchImpl = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const r = await fetchCuratedManifest(stub);
    expect(r.manifest).toBeNull();
    expect(r.reason).toMatch(/network error.*ENOTFOUND/);
  });

  it('returns null + reason on schema_version mismatch (forward-compat)', async () => {
    const stub = stubFetch({
      ok: true, status: 200,
      body: JSON.stringify({ ...SAMPLE_MANIFEST, schema_version: 2 }),
    });
    const r = await fetchCuratedManifest(stub);
    expect(r.manifest).toBeNull();
    expect(r.reason).toMatch(/upgrade aiden-runtime/);
  });

  it('honors a custom URL parameter (test seam)', async () => {
    const stub = stubFetch({ ok: true, status: 200, body: JSON.stringify(SAMPLE_MANIFEST) });
    await fetchCuratedManifest(stub, 'https://example.com/m.json');
    expect(stub).toHaveBeenCalledWith('https://example.com/m.json');
  });
});

// ── renderManifestPreview ────────────────────────────────────────────

describe('renderManifestPreview — column shape + aggregates', () => {
  it('totalBytes is the sum of all skills size_bytes', () => {
    const m: CuratedManifest = {
      ...SAMPLE_MANIFEST,
      skills: [
        { ...SAMPLE_ENTRY, size_bytes: 1000 },
        { ...SAMPLE_ENTRY, name: 'b', size_bytes: 2500 },
      ],
    };
    const r = renderManifestPreview(m);
    expect(r.totalBytes).toBe(3500);
    expect(r.count).toBe(2);
  });

  it('table includes every skill name', () => {
    const m: CuratedManifest = {
      ...SAMPLE_MANIFEST,
      skills: [SAMPLE_ENTRY, { ...SAMPLE_ENTRY, name: 'csv-summarizer', author: 'Open Data' }],
    };
    const r = renderManifestPreview(m);
    expect(r.table).toContain('pdf-extractor');
    expect(r.table).toContain('csv-summarizer');
  });

  it('Author column appears BEFORE Category (per UX refinement: attribution is column 2)', () => {
    const r = renderManifestPreview(SAMPLE_MANIFEST);
    const authorIdx   = r.table.indexOf('Author');
    const categoryIdx = r.table.indexOf('Category');
    expect(authorIdx).toBeGreaterThan(-1);
    expect(categoryIdx).toBeGreaterThan(-1);
    expect(authorIdx).toBeLessThan(categoryIdx);
  });

  it('all five expected headers appear', () => {
    const r = renderManifestPreview(SAMPLE_MANIFEST);
    for (const header of ['Name', 'Author', 'Category', 'License', 'Size']) {
      expect(r.table).toContain(header);
    }
  });

  it('renders KB size string with 1 decimal place', () => {
    const m: CuratedManifest = {
      ...SAMPLE_MANIFEST,
      skills: [{ ...SAMPLE_ENTRY, size_bytes: 4096 }],
    };
    const r = renderManifestPreview(m);
    expect(r.table).toMatch(/4\.0 KB/);
  });

  it('handles zero-skill manifest gracefully', () => {
    const r = renderManifestPreview({ ...SAMPLE_MANIFEST, skills: [] });
    expect(r.count).toBe(0);
    expect(r.totalBytes).toBe(0);
    // Table renders headers even with no rows.
    expect(r.table).toContain('Name');
  });
});
