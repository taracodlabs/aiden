/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.5 SLICE 1 — SkillsHub curated ('official') source integration.
 *
 * Drives SkillsHub.install('official/<name>') end-to-end against:
 *   - real fs (tmpdir → paths.skillsDir)
 *   - real validateAttribution + parseSkillContent
 *   - real BundledManifest + SkillSecurityScanner
 *   - STUBBED fetchImpl (the only IO boundary mocked, per v4.9.1
 *     mock-blindness lesson — everything inside SkillsHub runs for real)
 *
 * Covers: success path, attribution strict-reject, manifest fetch fail,
 * skill-not-in-manifest, per-process manifest cache (N installs = 1 HTTP).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkillsHub, type FetchFn } from '../../../core/v4/skillsHub';
import { SkillSecurityScanner } from '../../../core/v4/skillSecurityScanner';
import { BundledManifest } from '../../../core/v4/skillBundledManifest';
import { resolveAidenPaths, type AidenPaths } from '../../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-curated-test-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Build a SKILL.md with full attribution (passes strict validator). */
const curatedSkillMd = (name: string): string => `---
name: ${name}
description: ${name} description
version: 1.2.0
license: MIT
author: Jane Doe
upstream_source: https://github.com/jdoe/${name}
---

# ${name}

Body content.
`;

/** Same but missing the strict-required upstream_source field. */
const incompleteSkillMd = (name: string): string => `---
name: ${name}
description: ${name} description
version: 1.2.0
license: MIT
author: Jane Doe
---

# ${name}

Body missing upstream_source — should be strict-rejected.
`;

const MANIFEST_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/main/manifest.json';

/**
 * Build a fetch stub mapping URL → response. Includes the manifest
 * URL by default; tests can override the manifest body or any per-skill
 * SKILL.md URL.
 */
function stubFetch(extra: Record<string, { ok?: boolean; status?: number; body: string }> = {}): FetchFn {
  const defaultManifest = {
    schema_version: 1,
    snapshot_at:    '2026-05-24T08:00:00Z',
    commit:         'abc1234deadbeef',
    skills: [
      {
        name: 'pdf-extractor', path: 'skills/pdf-extractor',
        description: 'Extract text from PDFs', category: 'files', version: '1.2.0',
        license: 'MIT', author: 'Jane Doe',
        upstream_source: 'https://github.com/jdoe/pdf-extractor',
        upstream_commit: 'deadbeef1234', size_bytes: 4200,
        files: ['SKILL.md', 'LICENSE'],
      },
      {
        name: 'csv-summarizer', path: 'skills/csv-summarizer',
        description: 'CSV stats', category: 'data', version: '0.4.1',
        license: 'Apache-2.0', author: 'Open Data',
        upstream_source: 'https://github.com/opendata/csv-skill',
        upstream_commit: '1234abc', size_bytes: 1800,
        files: ['SKILL.md', 'LICENSE'],
      },
    ],
  };
  const responses: Record<string, { ok: boolean; status: number; body: string }> = {
    [MANIFEST_URL]: { ok: true, status: 200, body: JSON.stringify(defaultManifest) },
  };
  for (const [url, r] of Object.entries(extra)) {
    responses[url] = { ok: r.ok ?? true, status: r.status ?? 200, body: r.body };
  }
  return vi.fn(async (url: string) => {
    const r = responses[url];
    if (!r) return { ok: false, status: 404, async text() { return ''; } };
    return { ok: r.ok, status: r.status, async text() { return r.body; } };
  });
}

const makeHub = (fetch?: FetchFn): SkillsHub => new SkillsHub(
  paths, new SkillSecurityScanner(), new BundledManifest(paths),
  fetch ? { fetch } : {},
);

// ── Happy path ──────────────────────────────────────────────────────

describe('SkillsHub — curated install happy path', () => {
  it('installs a curated skill: writes SKILL.md, stamps _source as official:, attribution validated', async () => {
    const SKILL_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234deadbeef/skills/pdf-extractor/SKILL.md';
    const hub = makeHub(stubFetch({
      [SKILL_URL]: { body: curatedSkillMd('pdf-extractor') },
    }));

    const result = await hub.install('official/pdf-extractor');

    expect(result.ok).toBe(true);
    // SkillsHub returns the path to the installed SKILL.md (not the dir).
    expect(result.installPath).toBe(path.join(paths.skillsDir, 'pdf-extractor', 'SKILL.md'));
    // File written to real fs.
    const written = await fs.readFile(
      path.join(paths.skillsDir, 'pdf-extractor', 'SKILL.md'),
      'utf-8',
    );
    expect(written).toContain('author: Jane Doe');
    expect(written).toContain('upstream_source:');
  });

  it('honors the legacy official/<category>/<name> identifier shape (back-compat)', async () => {
    const SKILL_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234deadbeef/skills/pdf-extractor/SKILL.md';
    const hub = makeHub(stubFetch({
      [SKILL_URL]: { body: curatedSkillMd('pdf-extractor') },
    }));
    // Old parser shape: 'official/<category>/<name>' — last segment
    // is the skill name. resolveOfficial's slash-aware fallback handles it.
    const result = await hub.install('official/files/pdf-extractor');
    expect(result.ok).toBe(true);
  });
});

// ── Strict attribution enforcement ──────────────────────────────────

describe('SkillsHub — curated install strict attribution', () => {
  it('REJECTS install when curated SKILL.md is missing upstream_source (curation-repo bug)', async () => {
    const SKILL_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234deadbeef/skills/pdf-extractor/SKILL.md';
    const hub = makeHub(stubFetch({
      [SKILL_URL]: { body: incompleteSkillMd('pdf-extractor') },
    }));

    const result = await hub.install('official/pdf-extractor');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing required attribution/);
    expect(result.reason).toMatch(/upstream_source/);
    expect(result.reason).toMatch(/aiden-skills curation repo/);
    // No file written to fs (clean abort).
    await expect(
      fs.access(path.join(paths.skillsDir, 'pdf-extractor', 'SKILL.md')),
    ).rejects.toThrow();
  });

  it('REJECTS install when curated SKILL.md is missing author', async () => {
    const noAuthor = `---
name: x
description: x
version: 1.0.0
license: MIT
upstream_source: https://example.com
---

body
`;
    const SKILL_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234deadbeef/skills/pdf-extractor/SKILL.md';
    const hub = makeHub(stubFetch({
      [SKILL_URL]: { body: noAuthor },
    }));
    const result = await hub.install('official/pdf-extractor');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/author/);
  });

  it('REJECTS install when curated SKILL.md is missing license', async () => {
    const noLicense = `---
name: x
description: x
version: 1.0.0
author: Someone
upstream_source: https://example.com
---

body
`;
    const SKILL_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234deadbeef/skills/pdf-extractor/SKILL.md';
    const hub = makeHub(stubFetch({
      [SKILL_URL]: { body: noLicense },
    }));
    const result = await hub.install('official/pdf-extractor');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/license/);
  });
});

// ── Manifest fetch failure paths ────────────────────────────────────

describe('SkillsHub — curated install manifest-side failures', () => {
  it('returns ok:false with helpful reason when manifest fetch returns non-2xx', async () => {
    const failing = vi.fn(async () => ({
      ok: false, status: 503, async text() { return ''; },
    })) as FetchFn;
    const hub = makeHub(failing);
    const result = await hub.install('official/pdf-extractor');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Fetch failed/);
    expect(result.reason).toMatch(/manifest unavailable.*HTTP 503/);
  });

  it('returns ok:false with helpful reason when skill not in manifest', async () => {
    const hub = makeHub(stubFetch());  // default manifest has pdf-extractor + csv-summarizer only
    const result = await hub.install('official/nonexistent-skill');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Fetch failed/);
    expect(result.reason).toMatch(/"nonexistent-skill" not found in manifest/);
  });
});

// ── Per-process manifest cache (Phase B Q1) ─────────────────────────

describe('SkillsHub — manifest cache (per-process)', () => {
  it('N installs in the same hub instance = 1 manifest HTTP fetch', async () => {
    const PDF_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234deadbeef/skills/pdf-extractor/SKILL.md';
    const CSV_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234deadbeef/skills/csv-summarizer/SKILL.md';
    const fetchStub = stubFetch({
      [PDF_URL]: { body: curatedSkillMd('pdf-extractor') },
      [CSV_URL]: { body: curatedSkillMd('csv-summarizer') },
    });
    const hub = makeHub(fetchStub);

    await hub.install('official/pdf-extractor');
    await hub.install('official/csv-summarizer');

    // Count manifest fetches — must be exactly 1 across both installs.
    const manifestCalls = (fetchStub as unknown as { mock: { calls: [string][] } })
      .mock.calls
      .filter(([url]) => url === MANIFEST_URL);
    expect(manifestCalls).toHaveLength(1);
  });
});
