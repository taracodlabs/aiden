/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-bug-X — `memory_remove` protection of `## Durable facts`.
 *
 * Smoke-test regression guard. On 2026-05-13, a session on llama-3.3
 * autonomously called memory_remove("for next time: gpt-5") on a
 * user-approved fact in `## Durable facts`. This file pins the
 * post-fix behavior:
 *   - Substring in `## Durable facts` → tool rejects with explicit error
 *   - Substring in `## Recent sessions` → tool succeeds (mutable)
 *   - Substring in legacy pre-section content → tool succeeds (mutable)
 *   - USER.md unaffected (no section structure today)
 *   - Substring in BOTH `## Durable facts` and another section
 *     → STRICT rejection (whole-file substring removal would still
 *     nuke the durable copy as side-effect)
 *   - Missing ctx.memory → fall-through to old behavior (documented
 *     intentional; production CLI wires memoryManager)
 *   - Tool description carries the model-facing primary guard wording
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryManager } from '../../../core/v4/memoryManager';
import {
  MemoryGuard,
  containsInSection,
} from '../../../moat/memoryGuard';
import { memoryRemoveTool } from '../../../tools/v4/memory/memoryRemove';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let mgr: MemoryManager;
let guard: MemoryGuard;
let ctxFull:   ToolContext;     // with memoryManager wired (production-like)
let ctxNoMem:  ToolContext;     // without memoryManager (fall-through test)

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bug-x-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
  mgr = new MemoryManager(paths);
  guard = new MemoryGuard(mgr);
  ctxFull  = { cwd: tmp, paths, memoryGuard: guard, memory: mgr };
  ctxNoMem = { cwd: tmp, paths, memoryGuard: guard };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Seed MEMORY.md by writing each section via the real MemoryGuard API
 * (mirrors how Phase D's promotion writes `## Durable facts` and how
 * `session_summary` writes `## Recent sessions`). Storage is
 * entry-delimited (ENTRY_SEPARATOR = '\n§\n'), so each whole section
 * becomes one entry — meaning entry-granular `remove()` ops target
 * one section at a time, which is the production semantics we want
 * to test against.
 */
async function seedSections(opts: {
  recent?:  string;            // body for `## Recent sessions`
  durable?: string;            // body for `## Durable facts`
  legacy?:  string;            // pre-section free-form content (legacy users)
}): Promise<void> {
  if (opts.legacy) await mgr.add('memory', opts.legacy);
  if (opts.recent) await guard.replaceSection('memory', '## Recent sessions', opts.recent);
  if (opts.durable) await guard.replaceSection('memory', '## Durable facts', opts.durable);
}

describe('containsInSection (pure helper)', () => {
  it('returns true when target sits inside the section body', () => {
    const md = [
      '## Recent sessions',
      '- session A bullet',
      '',
      '## Durable facts',
      '- gpt-5.5 is the auto-picked default',
      '- v4.1.2 ships memory architecture A through D',
    ].join('\n');
    expect(containsInSection(md, 'gpt-5.5 is the auto-picked', '## Durable facts')).toBe(true);
    expect(containsInSection(md, 'v4.1.2 ships memory',         '## Durable facts')).toBe(true);
  });

  it('returns false when target sits in a different section', () => {
    const md = [
      '## Recent sessions',
      '- worked on gpt-5.5 wiring',
      '',
      '## Durable facts',
      '- different durable fact',
    ].join('\n');
    expect(containsInSection(md, 'gpt-5.5 wiring', '## Durable facts')).toBe(false);
  });

  it('returns false when the named section does not exist', () => {
    const md = '## Recent sessions\n- a session bullet';
    expect(containsInSection(md, 'a session bullet', '## Durable facts')).toBe(false);
  });

  it('returns false when target sits in the pre-section preamble', () => {
    const md = [
      'free-form legacy content before any section',
      '',
      '## Durable facts',
      '- a durable fact',
    ].join('\n');
    expect(containsInSection(md, 'legacy content', '## Durable facts')).toBe(false);
  });

  it('case-sensitive (matches guardedRemove semantics)', () => {
    const md = '## Durable facts\n- gpt-5.5 is default';
    expect(containsInSection(md, 'gpt-5.5', '## Durable facts')).toBe(true);
    expect(containsInSection(md, 'GPT-5.5', '## Durable facts')).toBe(false);
  });

  it('multi-line target spanning entries is detected', () => {
    const md = '## Durable facts\n- first fact\n- second fact';
    expect(containsInSection(md, 'first fact\n- second', '## Durable facts')).toBe(true);
  });

  it('empty arguments return false defensively', () => {
    expect(containsInSection('',       'x',  '## H')).toBe(false);
    expect(containsInSection('## H',   '',   '## H')).toBe(false);
    expect(containsInSection('## H',   'x',  ''    )).toBe(false);
  });
});

describe('memory_remove durable-section protection (end-to-end)', () => {
  it('REJECTS removal of content in `## Durable facts`', async () => {
    await seedSections({
      recent:  '- a session bullet',
      durable: [
        '- gpt-5.5 is the auto-picked default for chatgpt-plus',
        '- v4.1.2 ships memory architecture A through D',
      ].join('\n'),
    });

    const r = await memoryRemoveTool.execute(
      { file: 'memory', text: 'gpt-5.5 is the auto-picked default' },
      ctxFull,
    ) as { success: boolean; error: string; protectedSection: string };

    expect(r.success).toBe(false);
    expect(r.error).toContain('Cannot remove');
    expect(r.error).toContain('## Durable facts');
    expect(r.error).toContain('user-approved');
    expect(r.error).toMatch(/ask.*confirm/i);
    expect(r.protectedSection).toBe('## Durable facts');

    // Content survived on disk — verify the fact is still there.
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('gpt-5.5 is the auto-picked default');
  });

  it('ALLOWS removal of content in `## Recent sessions` (mutable)', async () => {
    await seedSections({
      recent:  '- worked on gpt-5.5 wiring',
      durable: '- different durable fact',
    });

    const r = await memoryRemoveTool.execute(
      { file: 'memory', text: 'worked on gpt-5.5 wiring' },
      ctxFull,
    ) as { success: boolean; verified: boolean };

    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);

    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).not.toContain('worked on gpt-5.5 wiring');
    // Durable section untouched.
    expect(snap.memoryMd).toContain('different durable fact');
  });

  it('ALLOWS removal of pre-section legacy content (mutable)', async () => {
    await seedSections({
      legacy:  'legacy free-form note from before v4.1.2',
      durable: '- a real durable fact',
    });

    const r = await memoryRemoveTool.execute(
      { file: 'memory', text: 'legacy free-form note from before v4.1.2' },
      ctxFull,
    ) as { success: boolean; verified: boolean };

    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('USER.md unaffected (no section structure today)', async () => {
    // Even if the user's USER.md happened to contain "## Durable facts",
    // the protection scope is MEMORY.md only.
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await fs.writeFile(paths.userMd, '## Durable facts\n- some user content', 'utf-8');

    const r = await memoryRemoveTool.execute(
      { file: 'user', text: 'some user content' },
      ctxFull,
    ) as { success: boolean; verified: boolean };

    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('STRICT: substring appearing in BOTH durable and another section → rejected', async () => {
    // The bug-X strict-containment rule: whole-file substring removal
    // would nuke the durable copy as side effect, so we reject ANY
    // substring that also appears in `## Durable facts`.
    await seedSections({
      recent:  '- gpt-5.5 came up in this session',
      durable: '- gpt-5.5 is the auto-picked default for chatgpt-plus',
    });

    const r = await memoryRemoveTool.execute(
      { file: 'memory', text: 'gpt-5.5' },
      ctxFull,
    ) as { success: boolean; error: string };

    expect(r.success).toBe(false);
    expect(r.error).toContain('## Durable facts');

    // Both copies survive — durable AND the recent-session mention.
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('gpt-5.5 came up in this session');
    expect(snap.memoryMd).toContain('gpt-5.5 is the auto-picked default');
  });

  it('falls through to old behavior when ctx.memory is not wired', async () => {
    // Test-context behavior: missing memoryManager → protection cannot
    // run (no snapshot access). We fall through rather than hard-fail,
    // preserving non-protection semantics for tests that don't wire
    // memoryManager. Production CLI sessions wire it; protection
    // works in real usage.
    await seedSections({ durable: '- unprotected in this ctx' });

    const r = await memoryRemoveTool.execute(
      { file: 'memory', text: 'unprotected in this ctx' },
      ctxNoMem,
    ) as { success: boolean; verified: boolean };

    // ctx.memory is not wired → protection skipped → guardedRemove
    // runs against the underlying file and succeeds.
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
  });

  it('long rejected-text preview is truncated with … marker', async () => {
    const longText = 'x'.repeat(120) + ' (long durable fact)';
    await seedSections({ durable: '- ' + longText });

    const r = await memoryRemoveTool.execute(
      { file: 'memory', text: longText },
      ctxFull,
    ) as { success: boolean; error: string };

    expect(r.success).toBe(false);
    // Preview shouldn't bloat the error to 120+ chars verbatim.
    expect(r.error).toContain('…');
    // Should keep the first 60-ish chars then `…`.
    expect(r.error).toMatch(/Cannot remove "x{60}…"/);
  });

  it('rejection on substring that appears nowhere → fall through to normal "not found"', async () => {
    // If the substring isn't in `## Durable facts` AT ALL, protection
    // doesn't fire. The underlying guardedRemove will then return its
    // own "not found in file" rejection (the existing failure mode
    // for unmatched removals).
    await seedSections({ durable: '- a real durable fact' });

    const r = await memoryRemoveTool.execute(
      { file: 'memory', text: 'not in any section' },
      ctxFull,
    ) as { success: boolean };

    // Old behavior: removal failed because text wasn't found.
    expect(r.success).toBe(false);
    // But the rejection reason should NOT be the durable-protection one.
    expect((r as { error?: string }).error ?? '').not.toContain('## Durable facts');
  });
});

describe('memoryRemoveTool schema — model-facing primary guard', () => {
  it('description warns the model about durable-facts protection', () => {
    const desc = memoryRemoveTool.schema.description;
    // Defense-in-depth: prompt-level guidance + tool-level rejection.
    // If a future refactor strips this, the model loses the up-front
    // warning and falls back to learning from rejected calls.
    expect(desc).toContain('CANNOT');
    expect(desc).toContain('## Durable facts');
    expect(desc).toContain('user-approved');
    expect(desc).toMatch(/do not propose autonomous/i);
  });

  it('allows file: memory|user|project (v4.10 Slice 10.1 — project added)', () => {
    const fileSpec = (
      memoryRemoveTool.schema.inputSchema.properties as Record<string, { enum?: string[] }>
    ).file;
    expect(fileSpec?.enum).toEqual(['memory', 'user', 'project']);
  });
});
