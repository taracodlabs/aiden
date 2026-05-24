/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.5 SLICE 1 — setupWizard Step 4 (curated skills) coverage.
 *
 * The new Step 4 calls runCuratedSetupFlow under the hood. Rather
 * than driving the wizard end-to-end (the existing setupWizard.test.ts
 * already does that with scripted prompts), this file tests the
 * SHARED flow `runCuratedSetupFlow` directly against:
 *   - real fs in tmpdir (real SkillsHub instance)
 *   - real validateAttribution + parseSkillContent
 *   - stubbed fetchImpl (only IO boundary mocked)
 *   - scripted confirm to drive accept/reject paths
 *
 * TTY-GATE HONESTY (per v4.9.3 Slice 1b lesson): the actual wizard
 * Step 4 site uses inquirer for the live confirm — that path requires
 * a real terminal. Existing setupWizard.test.ts uses scripted
 * `prompts` injection which auto-skips Step 4 (the wizard checks
 * `!opts.prompts && !opts.skipCuratedStep` before entering the
 * curated branch). So the real-TTY flow IS bypassed in CI.
 *
 * What this test covers: the runCuratedSetupFlow contract that the
 * wizard calls. The real-TTY wiring is the user's manual smoke
 * responsibility (`aiden setup` interactively) per
 * docs/v4.9.5-smoke.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runCuratedSetupFlow, type CuratedSetupDisplay } from '../../../cli/v4/skills/curatedSetupFlow';
import { SkillsHub, type FetchFn } from '../../../core/v4/skillsHub';
import { SkillSecurityScanner } from '../../../core/v4/skillSecurityScanner';
import { BundledManifest } from '../../../core/v4/skillBundledManifest';
import { resolveAidenPaths, type AidenPaths } from '../../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-wizard-curated-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function mkDisplay(): { display: CuratedSetupDisplay; writes: string[]; warns: string[]; successes: string[]; dims: string[] } {
  const writes: string[] = [], warns: string[] = [], successes: string[] = [], dims: string[] = [];
  return {
    display: {
      write:      (s) => { writes.push(s); },
      warn:       (s) => { warns.push(s); },
      success:    (s) => { successes.push(s); },
      dim:        (s) => { dims.push(s); },
      printError: (s) => { warns.push(s); },
    },
    writes, warns, successes, dims,
  };
}

const SAMPLE_MANIFEST = {
  schema_version: 1,
  snapshot_at:    '2026-05-24T08:00:00Z',
  commit:         'abc1234',
  skills: [
    {
      name: 'pdf-extractor', path: 'skills/pdf-extractor',
      description: 'Extract PDFs', category: 'files', version: '1.0',
      license: 'MIT', author: 'Jane Doe',
      upstream_source: 'https://example.com/pdf',
      upstream_commit: 'aaa', size_bytes: 4000, files: ['SKILL.md'],
    },
  ],
};

const sampleSkillMd = `---
name: pdf-extractor
description: Extract PDFs
version: 1.0
license: MIT
author: Jane Doe
upstream_source: https://example.com/pdf
---

Body.
`;

function stubFetch(responses: Record<string, { ok?: boolean; status?: number; body: string }>): FetchFn {
  return vi.fn(async (url: string) => {
    const r = responses[url];
    if (!r) return { ok: false, status: 404, async text() { return ''; } };
    return { ok: r.ok ?? true, status: r.status ?? 200, async text() { return r.body; } };
  });
}

const MANIFEST_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/main/manifest.json';
const SKILL_URL    = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234/skills/pdf-extractor/SKILL.md';

const makeHub = (fetch: FetchFn) => new SkillsHub(
  paths, new SkillSecurityScanner(), new BundledManifest(paths), { fetch },
);

describe('runCuratedSetupFlow — happy path', () => {
  it('renders preview + installs all skills on accept', async () => {
    const fetch = stubFetch({
      [MANIFEST_URL]: { body: JSON.stringify(SAMPLE_MANIFEST) },
      [SKILL_URL]:    { body: sampleSkillMd },
    });
    const hub = makeHub(fetch);
    const { display, writes, successes } = mkDisplay();
    const confirm = vi.fn(async () => true);   // user accepts Stage 2

    const r = await runCuratedSetupFlow({
      hub, display, confirm,
    });

    expect(r.ranInstall).toBe(true);
    expect(r.installed).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(false);
    // Preview table appeared in writes.
    const out = writes.join('');
    expect(out).toContain('Available curated skills');
    expect(out).toContain('Name');
    expect(out).toContain('Author');
    expect(out).toContain('pdf-extractor');
    expect(out).toContain('Jane Doe');
    // Success line emitted.
    expect(successes.some((s) => s.includes('Installed 1 curated skills'))).toBe(true);
    // File landed on disk.
    await fs.access(path.join(paths.skillsDir, 'pdf-extractor', 'SKILL.md'));
  });

  it('confirm primitive is asked AFTER the preview renders (UX order)', async () => {
    const fetch = stubFetch({
      [MANIFEST_URL]: { body: JSON.stringify(SAMPLE_MANIFEST) },
      [SKILL_URL]:    { body: sampleSkillMd },
    });
    const hub = makeHub(fetch);
    const { display, writes } = mkDisplay();
    let confirmCalledAfterWrites = -1;
    const confirm = vi.fn(async () => {
      confirmCalledAfterWrites = writes.length;
      return true;
    });
    await runCuratedSetupFlow({ hub, display, confirm });
    expect(confirmCalledAfterWrites).toBeGreaterThan(0);
    // The preview write happens BEFORE confirm.
    expect(writes.slice(0, confirmCalledAfterWrites).join('')).toContain('Available curated skills');
  });
});

describe('runCuratedSetupFlow — rejection paths', () => {
  it('returns skipped=true when user declines Stage 2 confirm', async () => {
    const fetch = stubFetch({
      [MANIFEST_URL]: { body: JSON.stringify(SAMPLE_MANIFEST) },
    });
    const hub = makeHub(fetch);
    const { display } = mkDisplay();
    const confirm = vi.fn(async () => false);   // user declines

    const r = await runCuratedSetupFlow({ hub, display, confirm });
    expect(r.skipped).toBe(true);
    expect(r.ranInstall).toBe(false);
    expect(r.installed).toBe(0);
    // No skill files written.
    await expect(fs.access(path.join(paths.skillsDir, 'pdf-extractor', 'SKILL.md')))
      .rejects.toThrow();
  });

  it('returns skipped=true + fetchError when manifest fetch fails', async () => {
    const fetch = stubFetch({});                // no entries → 404 on manifest
    const hub = makeHub(fetch);
    const { display, warns } = mkDisplay();
    const confirm = vi.fn();                    // should never be called

    const r = await runCuratedSetupFlow({ hub, display, confirm });
    expect(r.skipped).toBe(true);
    expect(r.fetchError).toBeDefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(warns.some((w) => w.includes('Could not fetch curated skills'))).toBe(true);
  });

  it('handles empty manifest gracefully', async () => {
    const fetch = stubFetch({
      [MANIFEST_URL]: { body: JSON.stringify({ ...SAMPLE_MANIFEST, skills: [] }) },
    });
    const hub = makeHub(fetch);
    const { display, dims } = mkDisplay();
    const confirm = vi.fn();

    const r = await runCuratedSetupFlow({ hub, display, confirm });
    expect(r.ranInstall).toBe(false);
    expect(r.installed).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(dims.some((d) => d.includes('Curated catalog is empty'))).toBe(true);
  });
});

describe('runCuratedSetupFlow — partial install reporting', () => {
  it('reports failed installs without aborting the rest of the batch', async () => {
    // Two skills; first SKILL.md fetch succeeds with valid attribution,
    // second returns 404 → fails. Flow should continue + report 1/2.
    const SKILL_URL_2 = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234/skills/csv-summarizer/SKILL.md';
    const twoSkillManifest = {
      ...SAMPLE_MANIFEST,
      skills: [
        SAMPLE_MANIFEST.skills[0],
        {
          name: 'csv-summarizer', path: 'skills/csv-summarizer',
          description: 'CSV', category: 'data', version: '0.1',
          license: 'MIT', author: 'Open Data',
          upstream_source: 'https://example.com/csv',
          upstream_commit: 'bbb', size_bytes: 2000, files: ['SKILL.md'],
        },
      ],
    };
    const fetch = stubFetch({
      [MANIFEST_URL]: { body: JSON.stringify(twoSkillManifest) },
      [SKILL_URL]:    { body: sampleSkillMd },
      // SKILL_URL_2 deliberately absent → 404
    });
    const hub = makeHub(fetch);
    const { display, warns } = mkDisplay();
    const confirm = vi.fn(async () => true);

    const r = await runCuratedSetupFlow({ hub, display, confirm });
    expect(r.installed).toBe(1);
    expect(r.failed).toBe(1);
    expect(warns.some((w) => w.includes('csv-summarizer'))).toBe(true);
    void SKILL_URL_2;
  });
});

describe('runCuratedSetupFlow — pre-fetched manifest seam', () => {
  it('skips the HTTP fetch when manifest is passed in (used by /skills setup catalog inspection)', async () => {
    const SKILL_URL_INLINE = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234/skills/pdf-extractor/SKILL.md';
    const fetch = stubFetch({ [SKILL_URL_INLINE]: { body: sampleSkillMd } });
    const hub = makeHub(fetch);
    const { display } = mkDisplay();
    const confirm = vi.fn(async () => true);

    const fetchWithManifest = stubFetch({
      [MANIFEST_URL]:      { body: JSON.stringify(SAMPLE_MANIFEST) },
      [SKILL_URL_INLINE]:  { body: sampleSkillMd },
    });
    const hub2 = makeHub(fetchWithManifest);
    await runCuratedSetupFlow({
      hub: hub2, display, confirm,
      manifest: SAMPLE_MANIFEST as never,   // pre-fetched
    });
    // runCuratedSetupFlow's OWN preview fetch was skipped — the
    // manifest URL is only hit ONCE (by SkillsHub.install internally
    // via resolveOfficial), not twice (preview + install).
    const calls = (fetchWithManifest as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(calls.filter(([url]) => url === MANIFEST_URL)).toHaveLength(1);
  });
});
