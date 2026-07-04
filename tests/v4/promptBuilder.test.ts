import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptBuilder, narrowSkillDesc, SKILL_DESC_CAP } from '../../core/v4/promptBuilder';
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

  it('4b. v4.12 — empty USER.md injects the onboarding nudge (not USER PROFILE)', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      memorySnapshot: { memoryMd: '', userMd: '', loadedAt: Date.now(), isEmpty: true },
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('Getting to know the user');
    expect(out).toContain('memory_add(file: "user")');
    expect(out).not.toContain('USER PROFILE');
  });

  it('4c. v4.12 — non-empty USER.md injects USER PROFILE, not the onboarding nudge', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      memorySnapshot: { memoryMd: '', userMd: 'Name: Shiva', loadedAt: Date.now(), isEmpty: false },
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('USER PROFILE');
    expect(out).not.toContain('Getting to know the user');
  });

  it('4a. memory section uses identity framing (Phase 16e)', async () => {
    // Locks the parenthetical identity-framing phrasing. Without it,
    // the model treats USER.md as past conversation and refuses to surface it
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

  it('4c. skills slot uses mandatory framing (Phase 16g)', async () => {
    // Locks "## Skills (mandatory) — you MUST load it"
    // framing. Pre-16g header was "## Available skills" which the
    // model treated as passive and skipped on fuzzy intents.
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      skillsList: [
        { name: 'youtube-player', description: 'play music on youtube' },
      ],
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('## Skills (mandatory)');
    expect(out).toMatch(/MUST load it first/);
    expect(out).toContain('skill_view');
    expect(out).toContain('<available_skills>');
    expect(out).toContain('youtube-player: play music on youtube');
  });

  it('4c-r. v4.14 — a non-ready skill shows its readiness note so the model knows it needs setup', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      skillsList: [
        { name: 'censys', description: 'internet asset discovery', readinessNote: 'needs setup: CENSYS_API_ID' },
        { name: 'arxiv',  description: 'search papers' },   // ready → no marker
      ],
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toContain('censys: internet asset discovery  [needs setup: CENSYS_API_ID]');
    // A ready skill carries no marker.
    expect(out).toContain('arxiv: search papers');
    expect(out).not.toContain('arxiv: search papers  [');
  });

  it('4d. skills slot omitted entirely when no skills supplied (Phase 16g)', async () => {
    // Empty skillsList stays out of the prompt — the mandatory framing
    // would be confusing if there's nothing to scan.
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      skillsList: [],
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).not.toContain('## Skills (mandatory)');
    expect(out).not.toContain('<available_skills>');
  });

  it('4b. memory section includes anti-confusion system note (Phase 16e)', async () => {
    // Locks the [System note: …] anti-confusion line on external
    // provider blocks. We apply it to the built-in MEMORY/USER blocks
    // too because that's where the bug lived.
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

  it('7b. weak-match nudge line follows the skill list (v4.11 narrowing)', async () => {
    // When skills are present the model is told to fall back to the full
    // descriptions via skills_list if the narrowed index is too thin to
    // disambiguate. The nudge must sit AFTER the closing tag.
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      skillsList: [{ name: 'graphify', description: 'knowledge-graph any input' }],
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).toMatch(/no skill above clearly matches/i);
    expect(out).toContain('`skills_list`');
    const idxClose = out.indexOf('</available_skills>');
    const idxNudge = out.search(/no skill above clearly matches/i);
    expect(idxClose).toBeGreaterThan(-1);
    expect(idxNudge).toBeGreaterThan(idxClose);
  });

  it('7c. nudge omitted entirely when no skills supplied', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      skillsList: [],
      platform: 'linux',
      skipFilesystem: true,
    });
    expect(out).not.toMatch(/no skill above clearly matches/i);
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

describe('narrowSkillDesc (v4.11 Skill Injection Narrowing)', () => {
  it('leaves a short single-sentence description unchanged', () => {
    expect(narrowSkillDesc('knowledge-graph any input')).toBe('knowledge-graph any input');
    expect(narrowSkillDesc('review a PR')).toBe('review a PR');
  });

  it('keeps only the first sentence of a multi-sentence description', () => {
    const out = narrowSkillDesc('Reconcile accounts. Use when performing bank recs.');
    expect(out).toBe('Reconcile accounts');
    expect(out).not.toMatch(/Use when/);
  });

  it('splits on a newline as a sentence boundary too', () => {
    expect(narrowSkillDesc('Audit accessibility\nWCAG 2.1 AA checks')).toBe('Audit accessibility');
  });

  it('hard-caps a long first sentence and marks it with an ellipsis', () => {
    const long =
      'Generate financial statements with period-over-period comparison and variance analysis for leadership';
    const out = narrowSkillDesc(long);
    // The cap actually fires (the pre-v4.11 slice(0,120) never did).
    expect(out.length).toBeLessThanOrEqual(SKILL_DESC_CAP + 1); // +1 for the ellipsis char
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1).trimEnd())).toBe(true);
  });

  it('does not append an ellipsis when the first sentence is exactly at the cap', () => {
    const exact = 'x'.repeat(SKILL_DESC_CAP);
    const out = narrowSkillDesc(exact);
    expect(out).toBe(exact);
    expect(out.endsWith('…')).toBe(false);
  });

  it('is idempotent — narrowing already-narrowed text is a no-op', () => {
    const once = narrowSkillDesc(
      'Generate financial statements with period-over-period comparison and variance analysis',
    );
    expect(narrowSkillDesc(once)).toBe(once);
  });

  it('returns empty string for empty / whitespace / non-string input', () => {
    expect(narrowSkillDesc('')).toBe('');
    expect(narrowSkillDesc('   ')).toBe('');
    // @ts-expect-error — guarding the runtime path that maps `description ?? ''`
    expect(narrowSkillDesc(undefined)).toBe('');
  });
});
