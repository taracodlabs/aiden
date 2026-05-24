/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.5 SLICE 1 — /skills setup + /skills list author-column coverage.
 *
 * Real fs in tmpdir for SkillsHub + skillsDir. Stubbed fetchImpl for
 * the manifest HTTP. Real validateAttribution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { skills as skillsCmd } from '../../../../cli/v4/commands/skills';
import { SkillsHub, type FetchFn } from '../../../../core/v4/skillsHub';
import { SkillSecurityScanner } from '../../../../core/v4/skillSecurityScanner';
import { BundledManifest } from '../../../../core/v4/skillBundledManifest';
import { SkillLoader } from '../../../../core/v4/skillLoader';
import { resolveAidenPaths, type AidenPaths } from '../../../../core/v4/paths';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skills-cmd-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const MANIFEST_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/main/manifest.json';

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

const SKILL_URL = 'https://raw.githubusercontent.com/taracodlabs/aiden-skills/abc1234/skills/pdf-extractor/SKILL.md';

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

function stubFetch(extra: Record<string, { ok?: boolean; status?: number; body: string }> = {}): FetchFn {
  const responses: Record<string, { ok: boolean; status: number; body: string }> = {
    [MANIFEST_URL]: { ok: true, status: 200, body: JSON.stringify(SAMPLE_MANIFEST) },
  };
  for (const [u, r] of Object.entries(extra)) {
    responses[u] = { ok: r.ok ?? true, status: r.status ?? 200, body: r.body };
  }
  return vi.fn(async (url: string) => {
    const r = responses[url];
    if (!r) return { ok: false, status: 404, async text() { return ''; } };
    return { ok: r.ok, status: r.status, async text() { return r.body; } };
  });
}

function mkCtx(over: {
  args?:    string[];
  hub?:     SkillsHub;
  /** v4.9.5 Slice 1.5 — flow now drives via prompt (raw text input)
   *  instead of confirm (boolean). Default `'' (Enter alone)` triggers
   *  the install-all path. */
  prompt?:  (msg: string) => Promise<string>;
  loader?:  SkillLoader;
}): SlashCommandContext & { _writes: string[]; _warns: string[]; _successes: string[]; _errors: string[] } {
  const writes:    string[] = [];
  const warns:     string[] = [];
  const successes: string[] = [];
  const errors:    string[] = [];
  const ctx = {
    args:    over.args ?? [],
    rawArgs: (over.args ?? []).join(' '),
    paths,
    skillsHub:   over.hub,
    skillLoader: over.loader,
    prompt:      over.prompt,
    display: {
      write:      (s: string) => { writes.push(s); },
      dim:        (s: string) => { writes.push(s); },
      warn:       (s: string) => { warns.push(s); },
      success:    (s: string) => { successes.push(s); },
      info:       (s: string) => { writes.push(s); },
      printError: (s: string) => { errors.push(s); },
      startSpinner: () => ({ stop: () => {} }),
      // v4.9.5 Slice 1.5 — three-tier prompt needs `paint` for the
      // warn-tinted `?` glyph. Tests don't care about colour bytes.
      paint:      (s: string) => s,
    } as unknown as SlashCommandContext['display'],
    registry: {} as unknown as SlashCommandContext['registry'],
    _writes: writes, _warns: warns, _successes: successes, _errors: errors,
  } as SlashCommandContext & { _writes: string[]; _warns: string[]; _successes: string[]; _errors: string[] };
  return ctx;
}

// ── /skills setup ────────────────────────────────────────────────────

describe('/skills setup', () => {
  it('installs curated skills on user accept (Enter = install all)', async () => {
    const fetch = stubFetch({ [SKILL_URL]: { body: sampleSkillMd } });
    const hub = new SkillsHub(paths, new SkillSecurityScanner(), new BundledManifest(paths), { fetch });
    // v4.9.5 Slice 1.5: Stage 2 prompt is (A)ll/(p)ick/(s)kip — Enter
    // alone is the default install-all path.
    const ctx = mkCtx({ args: ['setup'], hub, prompt: vi.fn(async () => '') });

    await skillsCmd.handler(ctx as never);

    expect(ctx._successes.some((s) => s.includes('Installed 1 of 1 curated skills'))).toBe(true);
    // File on disk.
    await fs.access(path.join(paths.skillsDir, 'pdf-extractor', 'SKILL.md'));
  });

  it('declines cleanly when user types `s` at Stage 2 (skip path)', async () => {
    const fetch = stubFetch({});
    const hub = new SkillsHub(paths, new SkillSecurityScanner(), new BundledManifest(paths), { fetch });
    const ctx = mkCtx({ args: ['setup'], hub, prompt: vi.fn(async () => 's') });

    await skillsCmd.handler(ctx as never);

    // No success line, no install on disk.
    expect(ctx._successes.filter((s) => s.includes('Installed')).length).toBe(0);
    await expect(fs.access(path.join(paths.skillsDir, 'pdf-extractor', 'SKILL.md')))
      .rejects.toThrow();
  });

  it('refuses to proceed when SkillsHub is not wired', async () => {
    const ctx = mkCtx({ args: ['setup'], prompt: vi.fn(async () => '') });
    await skillsCmd.handler(ctx as never);
    expect(ctx._warns.some((w) => w.includes('SkillsHub not wired'))).toBe(true);
  });

  it('refuses to proceed when prompt primitive is not wired', async () => {
    const fetch = stubFetch({});
    const hub = new SkillsHub(paths, new SkillSecurityScanner(), new BundledManifest(paths), { fetch });
    const ctx = mkCtx({ args: ['setup'], hub });   // no prompt
    await skillsCmd.handler(ctx as never);
    expect(ctx._errors.some((e) => e.includes('Cannot prompt'))).toBe(true);
  });

  it('surfaces manifest fetch failure as a warn (does not crash)', async () => {
    // Stub fetch returns 404 for everything.
    const fetch: FetchFn = vi.fn(async () => ({
      ok: false, status: 404, async text() { return ''; },
    }));
    const hub = new SkillsHub(paths, new SkillSecurityScanner(), new BundledManifest(paths), { fetch });
    const ctx = mkCtx({ args: ['setup'], hub, prompt: vi.fn(async () => '') });

    await skillsCmd.handler(ctx as never);

    expect(ctx._warns.some((w) => w.includes('Could not fetch curated skills'))).toBe(true);
  });
});

// ── /skills list with Author column ──────────────────────────────────

describe('/skills list — Author column (v4.9.5)', () => {
  it('renders the author name when SKILL.md provides one', async () => {
    // Plant a curated-shaped SKILL.md on disk.
    const dir = path.join(paths.skillsDir, 'pdf-extractor');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), sampleSkillMd, 'utf-8');
    const loader = new SkillLoader(paths);
    const ctx = mkCtx({ args: ['list'], loader });

    await skillsCmd.handler(ctx as never);

    const out = ctx._writes.join('');
    expect(out).toContain('Name');
    expect(out).toContain('Author');
    expect(out).toContain('Jane Doe');
  });

  it('shows "(uncredited)" for community skills missing author', async () => {
    const noAuthor = `---
name: random-skill
description: A side-loaded skill
version: 0.1.0
license: MIT
_trustLevel: community
---
Body.
`;
    const dir = path.join(paths.skillsDir, 'random-skill');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), noAuthor, 'utf-8');
    const loader = new SkillLoader(paths);
    const ctx = mkCtx({ args: ['list'], loader });

    await skillsCmd.handler(ctx as never);

    const out = ctx._writes.join('');
    expect(out).toContain('(uncredited)');
  });

  it('shows "(builtin)" for skills with _trustLevel: builtin and no author', async () => {
    const builtin = `---
name: bundled-skill
description: A bundled skill
version: 1.0.0
_trustLevel: builtin
---
Body.
`;
    const dir = path.join(paths.skillsDir, 'bundled-skill');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), builtin, 'utf-8');
    const loader = new SkillLoader(paths);
    const ctx = mkCtx({ args: ['list'], loader });

    await skillsCmd.handler(ctx as never);

    const out = ctx._writes.join('');
    expect(out).toContain('(builtin)');
  });
});
