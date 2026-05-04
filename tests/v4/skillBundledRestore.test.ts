/**
 * tests/v4/skillBundledRestore.test.ts — Phase 16b.1
 *
 * Covers the first-run / self-heal copy of bundled skills into the user's
 * skills dir. Uses a tmp paths root + a tmp bundled-skills source so we
 * don't touch %LOCALAPPDATA%.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
  type AidenPaths,
} from '../../core/v4/paths';
import { restoreBundledSkillsIfNeeded } from '../../core/v4/skillBundledRestore';

let tmpRoot: string;
let tmpSource: string;
let paths: AidenPaths;

async function mkSkill(dir: string, name: string, body: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), body, 'utf-8');
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bundled-test-'));
  tmpSource = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-source-test-'));
  paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);
  // Two bundled skills + a single-file skill + a marker that should be skipped.
  await mkSkill(
    tmpSource,
    'foo',
    '---\nname: foo\ndescription: f\nversion: 1.0.0\n---\nbody',
  );
  await mkSkill(
    tmpSource,
    'bar',
    '---\nname: bar\ndescription: b\nversion: 1.0.0\n---\nbody',
  );
  await fs.writeFile(
    path.join(tmpSource, 'single.md'),
    '---\nname: single\ndescription: s\nversion: 1.0.0\n---\nbody',
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpSource, 'AIDEN_CATALOG.md'),
    '# catalog (must be skipped)',
    'utf-8',
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(tmpSource, { recursive: true, force: true });
});

describe('restoreBundledSkillsIfNeeded', () => {
  it('copies bundled skills into an empty skills dir on first run', async () => {
    const result = await restoreBundledSkillsIfNeeded(paths, {
      sourceOverride: tmpSource,
    });
    expect(result.sourceDir).toBe(tmpSource);
    // foo + bar + single.md = 3 copied. AIDEN_CATALOG.md skipped.
    expect(result.copied).toBe(3);
    expect(result.manifestInitialized).toBe(true);

    // Verify on-disk content.
    const fooSkill = await fs.readFile(
      path.join(paths.skillsDir, 'foo', 'SKILL.md'),
      'utf-8',
    );
    expect(fooSkill).toContain('name: foo');
    const single = await fs.readFile(
      path.join(paths.skillsDir, 'single.md'),
      'utf-8',
    );
    expect(single).toContain('name: single');
    // Catalog should NOT be present.
    await expect(
      fs.access(path.join(paths.skillsDir, 'AIDEN_CATALOG.md')),
    ).rejects.toThrow();
    // Manifest written.
    await expect(fs.access(paths.bundledManifest)).resolves.toBeUndefined();
  });

  it('preserves user-modified skills on a subsequent run', async () => {
    // Pre-existing user skill with the same name as a bundled skill.
    await mkSkill(
      paths.skillsDir,
      'foo',
      '---\nname: foo\ndescription: USER\nversion: 9.9.9\n---\ncustom body',
    );

    const result = await restoreBundledSkillsIfNeeded(paths, {
      sourceOverride: tmpSource,
    });
    // Should NOT overwrite foo (user has it). Should still copy bar + single.
    expect(result.copied).toBe(2);
    const fooContent = await fs.readFile(
      path.join(paths.skillsDir, 'foo', 'SKILL.md'),
      'utf-8',
    );
    expect(fooContent).toContain('USER');
    expect(fooContent).not.toContain('body\n'); // bundled "body" not used
  });

  it('returns no-op result when source dir is missing', async () => {
    const result = await restoreBundledSkillsIfNeeded(paths, {
      sourceOverride: path.join(tmpSource, 'nonexistent'),
    });
    expect(result.sourceDir).toBeNull();
    expect(result.copied).toBe(0);
  });
});
