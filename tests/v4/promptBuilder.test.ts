import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import type { AidenPaths } from '../../core/v4/paths';
import type { MemorySnapshot } from '../../core/v4/memoryProvider';
import type { ToolSchema } from '../../providers/v4/types';

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

describe('PromptBuilder', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pb-'));
  });

  it('1. empty options returns minimal prompt with environment block', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      cwd: '/test/cwd',
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('Aiden');
    expect(out).toContain('## Environment');
    expect(out).toContain('Platform: linux');
    expect(out).toContain('/test/cwd');
  });

  it('2. SOUL.md slot loaded if file exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pb-soul-'));
    await fs.writeFile(path.join(root, 'SOUL.md'), 'I am Aiden, a custom soul.');
    const pb = new PromptBuilder();
    const out = await pb.build({ paths: makePaths(root), platform: 'linux' });
    expect(out).toContain('custom soul');
  });

  it('3. SOUL.md slot skipped without error if file missing', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      platform: 'linux',
      skipFilesystem: true,
    });
    // Default identity used.
    expect(out).toContain('You are Aiden');
  });

  it('4. MEMORY.md + USER.md included from snapshot', async () => {
    const snapshot: MemorySnapshot = {
      memoryMd: 'Project uses pytest.',
      userMd: 'User prefers concise answers.',
      loadedAt: Date.now(),
      isEmpty: false,
    };
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      memorySnapshot: snapshot,
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('Project uses pytest');
    expect(out).toContain('User prefers concise');
  });

  it('4a. memory section uses Hermes-style identity framing (Phase 16e)', async () => {
    // Locks the parenthetical phrasing copied from Hermes
    // (`tools/memory_tool.py:393-409`). Without this framing the model
    // treats USER.md as past conversation and refuses to surface it
    // (16d run-1 smoke).
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      memorySnapshot: {
        memoryMd: 'note A',
        userMd: 'fact B',
        loadedAt: Date.now(),
        isEmpty: false,
      },
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('USER PROFILE (who the user is)');
    expect(out).toContain('MEMORY (your personal notes)');
    expect(out).toContain('═════');
  });

  it('4b. memory section includes anti-confusion system note (Phase 16e)', async () => {
    // Locks the [System note: …] line that Hermes puts on external
    // provider blocks (`memory_manager.py:184-188`). We apply it to the
    // built-in MEMORY/USER blocks too because that's where the bug lived.
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      memorySnapshot: {
        memoryMd: 'agent note',
        userMd: 'user fact',
        loadedAt: Date.now(),
        isEmpty: false,
      },
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toMatch(/Treat as live identity, not past conversation/);
    expect(out).toMatch(/Treat as live working memory, not past conversation/);
  });

  it('5. slots assembled in deterministic order (identity → memory → user → skills → budget → env)', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      memorySnapshot: {
        memoryMd: 'MEMORY-SLOT',
        userMd: 'USER-SLOT',
        loadedAt: Date.now(),
        isEmpty: false,
      },
      skillsList: [{ name: 'sk1', description: 'SKILLS-SLOT' }],
      initialBudget: { used: 0, max: 90 },
      platform: 'linux',
      skipFilesystem: true,
    });
    const idxIdentity = out.indexOf('You are Aiden');
    const idxMemory = out.indexOf('MEMORY-SLOT');
    const idxUser = out.indexOf('USER-SLOT');
    const idxSkills = out.indexOf('SKILLS-SLOT');
    const idxBudget = out.indexOf('Iteration budget');
    const idxEnv = out.indexOf('## Environment');
    expect(idxIdentity).toBeLessThan(idxMemory);
    expect(idxMemory).toBeLessThan(idxUser);
    expect(idxUser).toBeLessThan(idxSkills);
    expect(idxSkills).toBeLessThan(idxBudget);
    expect(idxBudget).toBeLessThan(idxEnv);
  });

  it('6. empty slots do not leave gaps (no double blank lines)', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('7. skills list rendered as compact name + description', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      skillsList: [
        { name: 'graphify', description: 'knowledge-graph any input' },
        { name: 'review', description: 'review a PR' },
      ],
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('- graphify: knowledge-graph any input');
    expect(out).toContain('- review: review a PR');
  });

  it('8. personality overlay applied after SOUL', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      personalityOverlay: 'PERSONALITY-OVERRIDE',
      platform: 'linux',
      skipFilesystem: true,
    });
    const idxIdentity = out.indexOf('You are Aiden');
    const idxOverlay = out.indexOf('PERSONALITY-OVERRIDE');
    expect(idxIdentity).toBeLessThan(idxOverlay);
  });

  it('9. initial budget block included', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      initialBudget: { used: 5, max: 90 },
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('Used 5 of 90 turns');
  });

  it('10. frozen: subsequent build() with same opts returns same string', async () => {
    const pb = new PromptBuilder();
    const opts = {
      paths: makePaths(tmp),
      memorySnapshot: {
        memoryMd: 'X',
        userMd: 'Y',
        loadedAt: 1,
        isEmpty: false,
      },
      skillsList: [{ name: 'a', description: 'b' }],
      initialBudget: { used: 0, max: 90 },
      platform: 'linux' as const,
      cwd: '/static',
      skipFilesystem: true,
    };
    // Stabilise the date by stubbing Date.now isn't trivial; the date string
    // is built from `new Date()`, so calls in the same test run get the same
    // ISO date — good enough.
    const a = await pb.build(opts);
    const b = await pb.build(opts);
    expect(a).toBe(b);
  });

  it('11. renderToolsForTurn formats descriptions', () => {
    const pb = new PromptBuilder();
    const tools: ToolSchema[] = [
      {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const out = pb.renderToolsForTurn(tools);
    expect(out).toContain('## Active tools');
    expect(out).toContain('- web_search: Search the web');
  });

  it('12. renderBudgetSnippet returns "Used N of M"', () => {
    const pb = new PromptBuilder();
    expect(pb.renderBudgetSnippet(3, 90)).toContain('Used 3 of 90');
    expect(pb.renderBudgetSnippet(3, 90)).toContain('87 remaining');
  });

  it('13. windows path separators handled in cwd', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      cwd: 'C:\\Users\\shiva\\DevOS',
      platform: 'windows',
      skipFilesystem: true,
    });
    expect(out).toContain('C:\\Users\\shiva\\DevOS');
    expect(out).toContain('Platform: windows');
  });

  it('14. unicode in identity preserved', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pb-uni-'));
    await fs.writeFile(path.join(root, 'SOUL.md'), 'I am 艾登 — Aiden 🧠');
    const pb = new PromptBuilder();
    const out = await pb.build({ paths: makePaths(root), platform: 'linux' });
    expect(out).toContain('艾登');
    expect(out).toContain('🧠');
  });
});
