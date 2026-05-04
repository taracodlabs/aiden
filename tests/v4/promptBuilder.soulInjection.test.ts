/**
 * promptBuilder.soulInjection.test.ts — Phase 16b.4
 *
 * Locks down the four contracts the promptBuilder must honour for SOUL.md
 * to actually reach the LLM:
 *   1. SOUL.md path is read from `opts.paths.soulMd`.
 *   2. SOUL.md content lands in slot #1 (before any other slot).
 *   3. `DEFAULT_SOUL_MD` does not override real SOUL.md when one exists.
 *   4. Empty/whitespace SOUL.md falls back to the bundled default.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import { DEFAULT_SOUL_MD } from '../../cli/v4/defaultSoul';
import type { AidenPaths } from '../../core/v4/paths';

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'MEMORY.md'),
    userMd: path.join(root, 'USER.md'),
    skillsDir: path.join(root, 'skills'),
  } as AidenPaths;
}

describe('PromptBuilder · SOUL.md injection (Phase 16b.4)', () => {
  it('reads SOUL.md from paths.soulMd', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-soul-inj-'));
    const marker = 'I am Aiden, custom-soul ' + Math.random().toString(36).slice(2);
    await fs.writeFile(path.join(root, 'SOUL.md'), marker, 'utf8');
    const out = await new PromptBuilder().build({
      paths: makePaths(root),
      platform: 'linux',
    });
    expect(out).toContain(marker);
  });

  it('SOUL.md content lands in slot #1 (before personality, memory, skills, env)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-soul-slot1-'));
    await fs.writeFile(path.join(root, 'SOUL.md'), 'AIDEN-IDENTITY-MARKER', 'utf8');
    const out = await new PromptBuilder().build({
      paths: makePaths(root),
      personalityOverlay: 'PERSONALITY-MARKER',
      memorySnapshot: {
        memoryMd: 'MEMORY-MARKER',
        userMd: 'USER-MARKER',
        loadedAt: 0,
        isEmpty: false,
      },
      skillsList: [{ name: 'sk', description: 'SKILLS-MARKER' }],
      platform: 'linux',
    });
    const idxIdentity = out.indexOf('AIDEN-IDENTITY-MARKER');
    const idxPersonality = out.indexOf('PERSONALITY-MARKER');
    const idxMemory = out.indexOf('MEMORY-MARKER');
    const idxUser = out.indexOf('USER-MARKER');
    const idxSkills = out.indexOf('SKILLS-MARKER');
    const idxEnv = out.indexOf('## Environment');
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxIdentity).toBeLessThan(idxPersonality);
    expect(idxIdentity).toBeLessThan(idxMemory);
    expect(idxIdentity).toBeLessThan(idxUser);
    expect(idxIdentity).toBeLessThan(idxSkills);
    expect(idxIdentity).toBeLessThan(idxEnv);
  });

  it('DEFAULT_SOUL_MD does not override real SOUL.md when present', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-soul-noov-'));
    const customSoul = 'I am ZARTHRAX — guardian of the void.';
    await fs.writeFile(path.join(root, 'SOUL.md'), customSoul, 'utf8');
    const out = await new PromptBuilder().build({
      paths: makePaths(root),
      platform: 'linux',
    });
    expect(out).toContain('ZARTHRAX');
    // Default identity's distinctive bullet should NOT appear.
    expect(out).not.toContain('71 bundled skills');
  });

  it('empty/whitespace SOUL.md falls back to DEFAULT_SOUL_MD', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-soul-empty-'));
    await fs.writeFile(path.join(root, 'SOUL.md'), '   \n  \t\n', 'utf8');
    const out = await new PromptBuilder().build({
      paths: makePaths(root),
      platform: 'linux',
    });
    // First line of DEFAULT_SOUL_MD: "You are Aiden — a local-first AI agent…"
    const defaultFirstLine = DEFAULT_SOUL_MD.split('\n')[0];
    expect(out).toContain(defaultFirstLine);
  });
});
