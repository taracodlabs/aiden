import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  SkillTeacher,
  filterFlaggedSkills,
  type SkillTeacherTraceEntry,
  type SkillProposal,
} from '../../../moat/skillTeacher';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { SkillLoader } from '../../../core/v4/skillLoader';

// ── Test fixtures ─────────────────────────────────────────────────────

const TOOLSETS: Record<string, string> = {
  file_read: 'files',
  file_write: 'files',
  web_search: 'web',
  web_fetch: 'web',
  shell_exec: 'execute',
  memory_add: 'memory',
};

const fakeResolveHandler = (name: string): ToolHandler | undefined => {
  const toolset = TOOLSETS[name];
  if (!toolset) return undefined;
  return {
    schema: { name, description: '', inputSchema: { type: 'object', properties: {} } },
    category: 'read',
    mutates: false,
    toolset,
    execute: async () => ({}),
  };
};

const fakeLoader = {} as SkillLoader;

interface FakeSkillManager {
  execute: ReturnType<typeof vi.fn>;
}

function makeManager(): FakeSkillManager {
  return { execute: vi.fn().mockResolvedValue({ ok: true }) };
}

const trace = (entries: Partial<SkillTeacherTraceEntry>[]): SkillTeacherTraceEntry[] =>
  entries.map((e) => ({
    name: e.name ?? 'unknown',
    args: e.args ?? {},
    result: e.result ?? null,
    error: e.error,
    toolset: e.toolset ?? TOOLSETS[e.name ?? ''],
  }));

const userMsg = (s: string) => ({ role: 'user' as const, content: s });

// Each test uses a unique quality-file path to avoid cross-test pollution.
let tmpQualityPath: string;
beforeEach(() => {
  tmpQualityPath = path.join(
    os.tmpdir(),
    `aiden-skill-quality-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
});
afterEach(async () => {
  try {
    await fs.unlink(tmpQualityPath);
  } catch {}
});

function makeTeacher(tier: 'tier_3_propose' | 'tier_4_auto' | 'off' = 'tier_3_propose') {
  const manager = makeManager();
  const teacher = new SkillTeacher(
    fakeLoader,
    manager as never,
    tier,
    tmpQualityPath,
    fakeResolveHandler,
  );
  return { teacher, manager };
}

// ── observeTurn tests ─────────────────────────────────────────────────

describe('SkillTeacher.observeTurn — gating', () => {
  it('1. returns null when < 5 tool calls', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'web_search' },
    ]);
    const proposal = await teacher.observeTurn(
      [userMsg('search for X then read the file')],
      t,
    );
    expect(proposal).toBeNull();
  });

  it('2. returns null when any tool errored', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'web_search', error: 'timeout' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
      { name: 'shell_exec' },
    ]);
    const proposal = await teacher.observeTurn(
      [userMsg('do a thing')],
      t,
    );
    expect(proposal).toBeNull();
  });

  it('3. returns null when toolsets count < 2', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'file_read' },
      { name: 'file_write' },
      { name: 'file_write' },
      { name: 'file_read' },
    ]);
    const proposal = await teacher.observeTurn(
      [userMsg('manage some files')],
      t,
    );
    expect(proposal).toBeNull();
  });

  it('4. returns null when conversation aborted', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
      { name: 'shell_exec' },
    ]);
    const proposal = await teacher.observeTurn(
      [userMsg('do everything please')],
      t,
      true, // aborted
    );
    expect(proposal).toBeNull();
  });

  it('5. returns null when user said "don\'t save this"', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
      { name: 'shell_exec' },
    ]);
    const proposal = await teacher.observeTurn(
      [userMsg("don't save this as a skill — just do it")],
      t,
    );
    expect(proposal).toBeNull();
  });

  it('6. returns proposal when criteria met', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
      { name: 'shell_exec' },
    ]);
    const proposal = await teacher.observeTurn(
      [
        userMsg('rename old screenshots to dated names'),
        userMsg('continue please'),
      ],
      t,
    );
    expect(proposal).not.toBeNull();
    expect(proposal!.toolsUsed).toHaveLength(5);
    expect(proposal!.confidence).toBeGreaterThan(0);
  });

  it('7. proposal name uses kebab-case from user message', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'file_write' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
    ]);
    const proposal = await teacher.observeTurn(
      [
        userMsg('rename old screenshots to dated names'),
        userMsg('looks good, continue'),
      ],
      t,
    );
    expect(proposal!.proposedName).toMatch(/^[a-z][a-z0-9-]+$/);
    // First user message → "rename old screenshots …" → kebab includes
    // those keywords (after stop-word filtering).
    expect(proposal!.proposedName).toContain('rename');
  });

  it('8. proposal description includes toolset list', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'file_write' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
    ]);
    const proposal = await teacher.observeTurn(
      [
        userMsg('research the topic and save the findings to a note'),
        userMsg('keep going'),
      ],
      t,
    );
    expect(proposal!.description).toMatch(/files|web|memory/i);
  });

  // Phase 16b.2 — additional gating tests
  it('15. returns null on first turn (only one user message)', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'file_write' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
    ]);
    const proposal = await teacher.observeTurn(
      [userMsg('rename old screenshots to dated names')],
      t,
    );
    expect(proposal).toBeNull();
  });

  it('16. returns null when user message is too short (< 20 chars)', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'file_read' },
      { name: 'file_write' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'memory_add' },
    ]);
    const proposal = await teacher.observeTurn(
      [userMsg('hey'), userMsg('go')],
      t,
    );
    expect(proposal).toBeNull();
  });

  it('17. returns null when distinct tool types < 3 (e.g. all web_search)', async () => {
    const { teacher } = makeTeacher();
    const t = trace([
      { name: 'web_search' },
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'web_search' },
      { name: 'web_fetch' },
    ]);
    // Only 2 distinct tool types (web_search, web_fetch). Even though they
    // span... well actually they're both 'web' toolset. Build a case with
    // 2 toolsets but still only 2 distinct names.
    const t2 = trace([
      { name: 'web_search' },
      { name: 'file_read' },
      { name: 'web_search' },
      { name: 'file_read' },
      { name: 'web_search' },
    ]);
    void t;
    const proposal = await teacher.observeTurn(
      [
        userMsg('do a fairly long enough request please'),
        userMsg('continue'),
      ],
      t2,
    );
    expect(proposal).toBeNull();
  });
});

// ── handleProposal tests ──────────────────────────────────────────────

const FAKE_PROPOSAL: SkillProposal = {
  proposedName: 'web-search-and-save',
  description: 'do a thing using web+files',
  toolsUsed: ['web_search', 'file_write'],
  exampleSteps: ['Call web_search', 'Call file_write'],
  trace: [],
  confidence: 0.5,
};

describe('SkillTeacher.handleProposal', () => {
  it('9. Tier 3: prompts user before creating', async () => {
    const { teacher, manager } = makeTeacher('tier_3_propose');
    const promptUser = vi.fn().mockResolvedValue(true);
    const result = await teacher.handleProposal(FAKE_PROPOSAL, { promptUser });
    expect(promptUser).toHaveBeenCalledOnce();
    expect(result.created).toBe(true);
    expect(result.skillName).toBe('web-search-and-save');
    expect(manager.execute).toHaveBeenCalledOnce();
  });

  it('10. Tier 3: skips creation on user decline', async () => {
    const { teacher, manager } = makeTeacher('tier_3_propose');
    const promptUser = vi.fn().mockResolvedValue(false);
    const result = await teacher.handleProposal(FAKE_PROPOSAL, { promptUser });
    expect(result.created).toBe(false);
    expect(result.reason).toBe('declined');
    expect(manager.execute).not.toHaveBeenCalled();
  });

  it('11. Tier 4: auto-creates without prompting', async () => {
    const { teacher, manager } = makeTeacher('tier_4_auto');
    const promptUser = vi.fn();
    const result = await teacher.handleProposal(FAKE_PROPOSAL, { promptUser });
    expect(promptUser).not.toHaveBeenCalled();
    expect(result.created).toBe(true);
    expect(manager.execute).toHaveBeenCalledOnce();
    // Verify the markdown was passed to skill_manage.
    const args = manager.execute.mock.calls[0][0];
    expect(args.action).toBe('create');
    expect(args.name).toBe('web-search-and-save');
    expect(args.content).toContain('# web-search-and-save');
  });
});

// ── quality scoring tests ─────────────────────────────────────────────

describe('SkillTeacher quality scoring', () => {
  it('12. trackSkillUsage + getSkillQualityScore: success rate', () => {
    const { teacher } = makeTeacher();
    teacher.trackSkillUsage('foo', true);
    teacher.trackSkillUsage('foo', true);
    teacher.trackSkillUsage('foo', false);
    const score = teacher.getSkillQualityScore('foo');
    expect(score.usageCount).toBe(3);
    expect(score.successRate).toBeCloseTo(2 / 3, 5);
  });

  it('13. quality flagged after 5+ uses with <60% success', () => {
    const { teacher } = makeTeacher();
    // 1 success / 5 failures = 16% success rate, total 6 uses.
    teacher.trackSkillUsage('bar', true);
    for (let i = 0; i < 5; i++) teacher.trackSkillUsage('bar', false);
    const score = teacher.getSkillQualityScore('bar');
    expect(score.flagged).toBe(true);
    expect(teacher.flaggedSkillNames()).toContain('bar');
  });

  it('14. flagged skills excluded from skills_list via filterFlaggedSkills helper', () => {
    const { teacher } = makeTeacher();
    teacher.trackSkillUsage('alpha', true);
    teacher.trackSkillUsage('alpha', true);
    teacher.trackSkillUsage('alpha', true);
    teacher.trackSkillUsage('alpha', true);
    teacher.trackSkillUsage('alpha', true);
    // beta: 0/5 success → flagged
    for (let i = 0; i < 5; i++) teacher.trackSkillUsage('beta', false);
    const allSkills = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }];
    const filtered = filterFlaggedSkills(allSkills, teacher.flaggedSkillNames());
    expect(filtered.map((s) => s.name)).toEqual(['alpha', 'gamma']);
  });
});
