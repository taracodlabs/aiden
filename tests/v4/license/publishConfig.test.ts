import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Phase 20 Task 4 — protect the npm publish surface from accidental drift.
 * If anyone bumps `version` to something unexpected, drops `publishConfig`,
 * or removes `prepublishOnly` we want a screaming red test before a tag
 * push fires the GitHub workflow.
 */
describe('npm publish config', () => {
  it('1. package.json declares v4.x version and public publishConfig', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const raw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, any>;
    expect(pkg.name).toBe('aiden-runtime');
    // Well-formedness check (not a publishability gate): `-dev` is a valid
    // pre-release identifier for dev branches. The publish gate is a MANUAL
    // `npm publish` (with 2FA); `prepublishOnly` runs typecheck + build as the
    // ship-readiness smoke.
    expect(pkg.version).toMatch(/^4\.\d+\.\d+(-(?:beta|rc|dev)(?:\.\d+)?)?$/);
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.scripts?.prepublishOnly).toContain('typecheck');
    expect(pkg.scripts?.prepublishOnly).toContain('build');
    // Phase 28.4.1: `npm test` was dropped from prepublishOnly because the
    // legacy v3 suite + vendored native-modules tests would block publish even
    // when v4 source was clean. Tests run in CI (ci.yml) on push/PR and via
    // `npm test` manually. prepublishOnly remains the typecheck + build smoke.
    expect(pkg.scripts?.['publish:beta']).toBeDefined();
    expect(pkg.scripts?.['publish:stable']).toBeDefined();
  });

  it('2. no auto-publish-on-tag workflow — manual publish is canonical', async () => {
    // The tag-triggered publish workflow was intentionally removed: it
    // duplicated the manual release flow (manual `npm publish` + web-2FA +
    // manual GitHub release) and, if its tests ever went green, would attempt a
    // duplicate npm publish (403) + duplicate release on an already-released
    // tag. Guard against it being reintroduced by accident.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const wfPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
    await expect(fs.access(wfPath)).rejects.toThrow(); // must NOT exist
    // Manual publish stays the canonical path.
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as Record<string, any>;
    expect(pkg.scripts?.['publish:stable']).toContain('npm publish');
  });
});
