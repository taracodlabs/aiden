/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 Pillar 6 Slice A — the skill precondition gate ("can this skill run
 * HERE?"). Pure, no-execution checks over declared frontmatter: env vars
 * (v3 + v4), binaries-on-PATH, platform. All probes are injected so the tests
 * assert the three states deterministically. Also proves the previously-dead
 * env check is now wired, and that a "needs_setup" skill still LOADS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  computeReadiness, requiredEnvVars, requiredBinaries, readinessNote,
  type ReadinessProbe,
} from '../../../core/v4/skillReadiness';
import type { SkillFrontmatter, Platform } from '../../../core/v4/skillSpec';
import { SkillLoader } from '../../../core/v4/skillLoader';
import { SkillsConfig } from '../../../core/v4/skillsConfig';
import { ConfigManager } from '../../../core/v4/config';
import { parseSkillContent, type ParsedSkill } from '../../../core/v4/skillSpec';
import { resolveAidenPaths, type AidenPaths } from '../../../core/v4/paths';

function fm(over: Partial<SkillFrontmatter> = {}): SkillFrontmatter {
  return { name: 's', description: 'd', version: '1.0.0', ...over };
}
/** A probe where everything is satisfied on linux unless overridden. */
function probe(over: Partial<ReadinessProbe> = {}): Partial<ReadinessProbe> {
  return { hasEnv: () => true, hasBinary: () => true, platform: 'linux' as Platform, ...over };
}

// ── computeReadiness: the three states ─────────────────────────────────────
describe('computeReadiness', () => {
  it('a skill with no declared preconditions → ready', () => {
    const r = computeReadiness(fm(), probe());
    expect(r.status).toBe('ready');
    expect(r.missing).toEqual([]);
  });

  it('a fully-satisfied skill (env present, binary present, platform match) → ready', () => {
    const f = fm({
      platforms: ['linux'],
      metadata: { aiden: { required_environment_variables: [{ name: 'K' }], required_binaries: [{ name: 'nmap' }] } },
    });
    expect(computeReadiness(f, probe()).status).toBe('ready');
  });

  it('missing v4 env var → needs_setup with an env gap', () => {
    const f = fm({ metadata: { aiden: { required_environment_variables: [{ name: 'CENSYS_API_ID', help: 'get a key' }] } } });
    const r = computeReadiness(f, probe({ hasEnv: (n) => n !== 'CENSYS_API_ID' }));
    expect(r.status).toBe('needs_setup');
    expect(r.missing).toEqual([{ kind: 'env', name: 'CENSYS_API_ID', help: 'get a key' }]);
  });

  it('missing LEGACY v3 env_required var → needs_setup (the previously-ignored form)', () => {
    const f = fm({ env_required: ['CENSYS_API_ID', 'CENSYS_API_SECRET'] });
    const r = computeReadiness(f, probe({ hasEnv: () => false }));
    expect(r.status).toBe('needs_setup');
    expect(r.missing.map((m) => m.name).sort()).toEqual(['CENSYS_API_ID', 'CENSYS_API_SECRET']);
    expect(r.missing.every((m) => m.kind === 'env')).toBe(true);
  });

  it('binary present → ready; binary absent → needs_setup with a binary gap', () => {
    const f = fm({ metadata: { aiden: { required_binaries: [{ name: 'docker', help: 'install docker' }] } } });
    expect(computeReadiness(f, probe({ hasBinary: () => true })).status).toBe('ready');
    const r = computeReadiness(f, probe({ hasBinary: (n) => n !== 'docker' }));
    expect(r.status).toBe('needs_setup');
    expect(r.missing).toEqual([{ kind: 'binary', name: 'docker', help: 'install docker' }]);
  });

  it('platform mismatch → unavailable (a hard gate, no setup fixes it)', () => {
    const f = fm({ platforms: ['windows'] });
    const r = computeReadiness(f, probe({ platform: 'linux' }));
    expect(r.status).toBe('unavailable');
    expect(r.missing[0].kind).toBe('platform');
  });

  it('platform gate short-circuits before env/binary gaps', () => {
    const f = fm({ platforms: ['macos'], metadata: { aiden: { required_environment_variables: [{ name: 'K' }] } } });
    const r = computeReadiness(f, probe({ platform: 'linux', hasEnv: () => false }));
    expect(r.status).toBe('unavailable');   // not needs_setup — can't run here at all
    expect(r.missing).toHaveLength(1);
  });
});

// ── collectors + note ──────────────────────────────────────────────────────
describe('collectors + readinessNote', () => {
  it('requiredEnvVars merges v3 + v4 and dedupes (v4 help wins)', () => {
    const f = fm({
      env_required: ['A', 'B'],
      metadata: { aiden: { required_environment_variables: [{ name: 'B', help: 'hi' }, { name: 'C' }] } },
    });
    const got = requiredEnvVars(f);
    expect(got.map((e) => e.name).sort()).toEqual(['A', 'B', 'C']);
    expect(got.find((e) => e.name === 'B')?.help).toBe('hi');
  });

  it('requiredBinaries reads the declared list', () => {
    expect(requiredBinaries(fm({ metadata: { aiden: { required_binaries: [{ name: 'docker' }] } } }))).toEqual([{ name: 'docker', help: undefined }]);
  });

  it('readinessNote: ready→undefined, needs_setup→list, unavailable→message', () => {
    expect(readinessNote({ status: 'ready', missing: [] })).toBeUndefined();
    expect(readinessNote({ status: 'needs_setup', missing: [{ kind: 'env', name: 'K' }, { kind: 'binary', name: 'docker' }] }))
      .toBe('needs setup: K, binary docker');
    expect(readinessNote({ status: 'unavailable', missing: [{ kind: 'platform', name: 'linux', help: 'declares platforms: windows' }] }))
      .toMatch(/unavailable here/);
  });
});

// ── checkRequiredEnvVars is now WIRED to read v3 too ───────────────────────
describe('SkillsConfig.checkRequiredEnvVars — now reads legacy v3 env_required', () => {
  let tmp: string; let cfg: ConfigManager; let skillsCfg: SkillsConfig;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-readiness-cfg-'));
    cfg = new ConfigManager(resolveAidenPaths({ rootOverride: tmp }));
    skillsCfg = new SkillsConfig(cfg);
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

  it('a v3 env_required var that is unset → reported missing (was silently ignored before)', () => {
    const skill: ParsedSkill = parseSkillContent(
      ['---', 'name: censys', 'description: d', 'version: 1.0.0',
       'env_required:', '  - AIDEN_READINESS_ABSENT_KEY', '---', '', 'body'].join('\n'),
      '/virtual/censys/SKILL.md',
    )!;
    delete process.env.AIDEN_READINESS_ABSENT_KEY;
    const res = skillsCfg.checkRequiredEnvVars(skill);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain('AIDEN_READINESS_ABSENT_KEY');
  });
});

// ── a needs_setup skill still LOADS (not removed) ──────────────────────────
describe('SkillLoader.list — readiness is attached, needs_setup skills still load', () => {
  let tmp: string; let paths: AidenPaths;
  const skillMd = (name: string, extra: string) =>
    ['---', `name: ${name}`, 'description: test skill', 'version: 1.0.0', extra, '---', '', `# ${name}`, '', 'body'].join('\n');

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-readiness-loader-'));
    paths = resolveAidenPaths({ rootOverride: tmp });
    await fs.mkdir(paths.skillsDir, { recursive: true });
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

  it('a skill needing an absent key still appears in list() — flagged needs_setup, not removed', async () => {
    delete process.env.AIDEN_READINESS_LOADER_KEY;
    await fs.mkdir(path.join(paths.skillsDir, 'needy'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'needy', 'SKILL.md'),
      skillMd('needy', ['metadata:', '  aiden:', '    required_environment_variables:', '      - name: AIDEN_READINESS_LOADER_KEY'].join('\n')),
    );
    await fs.mkdir(path.join(paths.skillsDir, 'plain'));
    await fs.writeFile(path.join(paths.skillsDir, 'plain', 'SKILL.md'), skillMd('plain', 'category: misc'));

    const list = await new SkillLoader(paths).list();
    const needy = list.find((s) => s.name === 'needy');
    const plain = list.find((s) => s.name === 'plain');
    // The needy skill LOADED (present in the list) — it's flagged, not hidden.
    expect(needy).toBeTruthy();
    expect(needy?.readiness?.status).toBe('needs_setup');
    expect(needy?.readiness?.missing[0]).toMatchObject({ kind: 'env', name: 'AIDEN_READINESS_LOADER_KEY' });
    // A skill with no preconditions is ready.
    expect(plain?.readiness?.status).toBe('ready');
  });
});
