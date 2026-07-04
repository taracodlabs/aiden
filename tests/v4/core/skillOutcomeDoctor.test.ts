/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-slice4 — `renderSkillOutcomesSection` doctor coverage.
 * Mirrors the slice3 doctor-renderer test shape: empty silent, populated
 * expanded, last-failure spotlight.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderSkillOutcomesSection } from '../../../cli/v4/doctor';
import { SkillOutcomeTracker } from '../../../core/v4/skillOutcomeTracker';
import type {
  ToolCallRequest,
  ToolCallResult,
} from '../../../providers/v4/types';

const view = (name: string): ToolCallRequest => ({
  id: 'v-' + Math.random().toString(36).slice(2),
  name: 'skill_view',
  arguments: { name },
});
const tool = (name: string): ToolCallRequest => ({
  id: 't-' + Math.random().toString(36).slice(2),
  name,
  arguments: {},
});
const ok = (n: string): ToolCallResult => ({ id: 'r', name: n, result: { ok: true } });
const err = (n: string, msg: string): ToolCallResult => ({
  id: 'r', name: n, result: { error: msg, success: false },
});

let tmpDir: string;
let persistPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skill-doctor-'));
  persistPath = path.join(tmpDir, '.skill-outcomes.json');
});

afterEach(async () => {
  // maxRetries handles the rare case where a fire-and-forget persist
  // is still resolving when cleanup runs (Windows holds the file
  // briefly even after the JS side resolves).
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('renderSkillOutcomesSection', () => {
  it('renders nothing when no tracker is passed', () => {
    expect(renderSkillOutcomesSection(undefined)).toBe('');
  });

  it('renders nothing when the tracker has no outcomes', () => {
    const t = new SkillOutcomeTracker(persistPath);
    expect(renderSkillOutcomesSection(t)).toBe('');
  });

  it('renders the top-N block when skills have outcomes', () => {
    const t = new SkillOutcomeTracker(persistPath);
    // Three skills with different load counts so sort order is testable.
    t.onTool(view('alpha'), 'before');
    t.onTool(view('alpha'), 'after', ok('skill_view'));
    t.onTool(view('alpha'), 'before');
    t.onTool(view('alpha'), 'after', ok('skill_view'));
    t.onTool(view('alpha'), 'before');
    t.onTool(view('alpha'), 'after', ok('skill_view'));

    t.onTool(view('beta'), 'before');
    t.onTool(view('beta'), 'after', ok('skill_view'));
    t.onTool(tool('file_read'), 'before');
    t.onTool(tool('file_read'), 'after', ok('file_read'));

    const out = renderSkillOutcomesSection(t);
    expect(out).toContain('Skill outcomes');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    // alpha loaded 3x > beta loaded 1x → alpha appears first.
    expect(out.indexOf('alpha')).toBeLessThan(out.indexOf('beta'));
  });

  it('shows the rolling pass-rate from graded verdicts', () => {
    const t = new SkillOutcomeTracker(persistPath);
    // v4.14 — trust is graded by the verdict, not tool attribution. One pass +
    // one fail → 50% pass.
    t.onTool(view('mixed'), 'before'); t.recordTurnVerdict('completed');
    t.onTool(view('mixed'), 'before'); t.recordTurnVerdict('verification_failed');
    const out = renderSkillOutcomesSection(t);
    expect(out).toContain('50% pass');
  });

  it('shows an em-dash for a skill loaded but not yet graded', () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(view('untested'), 'before');
    t.onTool(view('untested'), 'after', ok('skill_view'));
    const out = renderSkillOutcomesSection(t);
    expect(out).toContain('untested');
    expect(out).toMatch(/loaded 1, 0\/0 verified  \(—\)/);
  });

  it('flags a chronically-failing skill as ⚠ flaky', () => {
    const t = new SkillOutcomeTracker(persistPath);
    for (let i = 0; i < 6; i += 1) { t.onTool(view('bad'), 'before'); t.recordTurnVerdict('verification_failed'); }
    expect(renderSkillOutcomesSection(t)).toContain('⚠ flaky');
  });

  it('spotlights the most recent failure with a ↳ row', () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(view('flaky'), 'before');
    t.onTool(view('flaky'), 'after', ok('skill_view'));
    t.onTool(tool('shell_exec'), 'before');
    t.onTool(tool('shell_exec'), 'after', err('shell_exec', 'permission denied'));
    const out = renderSkillOutcomesSection(t);
    expect(out).toContain('last failure: flaky');
    expect(out).toContain('permission denied');
  });

  it('caps the rendered list at the requested topN', () => {
    const t = new SkillOutcomeTracker(persistPath);
    // 8 distinct skills, default topN = 5.
    for (let i = 0; i < 8; i += 1) {
      const name = `skill-${i}`;
      // Higher i → higher load count so sort is deterministic.
      for (let j = 0; j <= i; j += 1) {
        t.onTool(view(name), 'before');
        t.onTool(view(name), 'after', ok('skill_view'));
      }
    }
    const out = renderSkillOutcomesSection(t);
    expect(out).toContain('skill-7');   // highest load → present
    expect(out).toContain('skill-3');   // 5th highest → present
    expect(out).not.toContain('skill-2'); // 6th highest → trimmed
  });
});
