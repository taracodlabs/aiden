/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 /commands slice — /activity roll-up.
 *
 * ★ Contract: /activity AGGREGATES existing sources; it does NOT recompute
 * them. These tests inject spy accessors (the same ones /usage /budget
 * /history /tasks /artifacts read) and assert the command (a) reads each
 * accessor and (b) formats their returned values verbatim.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeActivityCommand } from '../../../../cli/v4/commands/activity';

function mkCtx(usage?: { inputTokens: number; outputTokens: number }) {
  const out: string[] = [];
  const getTotalUsage = vi.fn(() => usage ?? { inputTokens: 0, outputTokens: 0 });
  const ctx = {
    args: [],
    rawArgs: '',
    display: {
      info:  (m: string) => out.push(m),
      write: (m: string) => out.push(m),
      dim:   (m: string) => out.push(m),
      warn:  (m: string) => out.push(m),
    },
    session: usage ? { getTotalUsage } : undefined,
  } as any;
  return { ctx, out, getTotalUsage };
}

describe('/activity — reads the same accessors (aggregates, no recompute)', () => {
  it('★ calls every injected source accessor and formats their values', async () => {
    const sources = {
      sessionId:       vi.fn(() => 'sess-123'),
      getCap:          vi.fn(() => 50_000),
      getUsedTokens:   vi.fn((_id: string) => 1_801),
      getHistoryCount: vi.fn(async () => 12),
      listTasks:       vi.fn((_id: string) => [
        { status: 'active' }, { status: 'completed' }, { status: 'completed' }, { status: 'failed' },
      ]),
      listArtifacts:   vi.fn((_id: string) => [{}, {}, {}]),
    };
    const cmd = makeActivityCommand(sources);
    const { ctx, out, getTotalUsage } = mkCtx({ inputTokens: 1_000, outputTokens: 801 });
    await cmd.handler(ctx);

    // (a) every accessor was consulted — the roll-up reads, doesn't recompute.
    expect(sources.sessionId).toHaveBeenCalled();
    expect(getTotalUsage).toHaveBeenCalled();                 // /usage source
    expect(sources.getCap).toHaveBeenCalled();                // /budget source
    expect(sources.getUsedTokens).toHaveBeenCalledWith('sess-123');
    expect(sources.getHistoryCount).toHaveBeenCalled();       // /history source
    expect(sources.listTasks).toHaveBeenCalledWith('sess-123');    // /tasks source
    expect(sources.listArtifacts).toHaveBeenCalledWith('sess-123'); // /artifacts source

    // (b) values are surfaced verbatim / rolled up, not recomputed.
    const text = out.join('\n');
    expect(text).toContain('1,000 in');
    expect(text).toContain('801 out');
    expect(text).toContain('1,801 total');            // in+out roll-up
    expect(text).toMatch(/1,801 \/ 50,000 tokens \(4%\)/); // budget used/cap/pct
    expect(text).toContain('12 recent prompts');
    expect(text).toMatch(/Tasks\s*:\s*4/);            // 4 tasks total
    expect(text).toContain('1 active');
    expect(text).toContain('2 completed');
    expect(text).toContain('1 failed');
    expect(text).toContain('3 files written');
  });

  it('no cap set → shows "no cap" instead of a percentage', async () => {
    const sources = {
      sessionId:       () => 'sess-9',
      getCap:          () => 0,
      getUsedTokens:   () => 500,
      getHistoryCount: () => 1,
      listTasks:       () => [],
      listArtifacts:   () => [],
    };
    const { ctx, out } = mkCtx({ inputTokens: 100, outputTokens: 400 });
    await makeActivityCommand(sources).handler(ctx);
    const text = out.join('\n');
    expect(text).toContain('no cap set');
    expect(text).toContain('1 recent prompt');          // singular
    expect(text).toContain('0 files written');
  });

  it('no active session → does not query used-tokens/tasks/artifacts by id', async () => {
    const getUsedTokens = vi.fn(() => 0);
    const listTasks = vi.fn(() => []);
    const listArtifacts = vi.fn(() => []);
    const sources = {
      sessionId:       () => undefined,
      getCap:          () => 0,
      getUsedTokens,
      getHistoryCount: () => 0,
      listTasks,
      listArtifacts,
    };
    const { ctx } = mkCtx();     // no session → getTotalUsage absent
    await makeActivityCommand(sources).handler(ctx);
    expect(getUsedTokens).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
    expect(listArtifacts).not.toHaveBeenCalled();
  });

  it('switches between summary and full presentation without adding another activity source', async () => {
    let mode: 'summary' | 'full' = 'summary';
    const sources = {
      sessionId: () => undefined,
      getCap: () => 0,
      getUsedTokens: () => 0,
      getHistoryCount: () => 0,
      listTasks: () => [],
      listArtifacts: () => [],
      getPresentationMode: () => mode,
      setPresentationMode: vi.fn((next: 'summary' | 'full') => { mode = next; }),
    };
    const { ctx, out } = mkCtx();
    ctx.args = ['full'];
    await makeActivityCommand(sources).handler(ctx);
    expect(sources.setPresentationMode).toHaveBeenCalledWith('full');
    expect(out.join('\n')).toContain('View      : full');

    ctx.args = ['summary'];
    await makeActivityCommand(sources).handler(ctx);
    expect(sources.setPresentationMode).toHaveBeenCalledWith('summary');
  });
});
