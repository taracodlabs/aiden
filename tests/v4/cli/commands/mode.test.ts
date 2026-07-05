/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 BUG 1 — `/mode`: the friendly trust-level viewer/switcher. No args shows
 * the current level + options in plain language; an arg switches and persists
 * (agent.autonomy in config); friendly aliases (safe/auto/observer) map to the
 * dial; an unknown arg is a calm error. Floors are NOT touched here.
 */
import { describe, it, expect, vi } from 'vitest';
import { mode } from '../../../../cli/v4/commands/mode';
import { ApprovalEngine } from '../../../../moat/approvalEngine';
import { resolveConfiguredAutonomyLevel } from '../../../../core/v4/config';
import { resolveAutonomyPolicy } from '../../../../moat/autonomy';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';

function fakeConfig() {
  const store: Record<string, unknown> = {};
  return {
    store,
    set: (k: string, v: unknown) => { store[k] = v; },
    save: vi.fn(async () => {}),
    getValue: <T,>(k: string, fb?: T): T => (k in store ? (store[k] as T) : (fb as T)),
  };
}
function captured() {
  const out: string[] = [];
  return {
    out,
    info: (m: string) => out.push(`info:${m}`),
    warn: (m: string) => out.push(`warn:${m}`),
    success: (m: string) => out.push(`ok:${m}`),
    dim: (m: string) => out.push(`dim:${m}`),
  };
}
function buildCtx(args: string[], opts: { engine?: ApprovalEngine; config?: ReturnType<typeof fakeConfig> } = {}) {
  const display = captured();
  const ctx = { args, rawArgs: args.join(' '), display, approvalEngine: opts.engine, config: opts.config } as unknown as SlashCommandContext;
  return { ctx, display };
}
const text = (d: ReturnType<typeof captured>) => d.out.join('\n');
/** An engine seeded at a level. */
function engineAt(level: 'Observer' | 'Assistant' | 'Partner') {
  const e = new ApprovalEngine('smart');
  e.setAutonomyPolicy(resolveAutonomyPolicy(level, { workspaceRoots: ['/ws'] }));
  return e;
}

describe('/mode — view', () => {
  it('no args shows the current level + all options in plain language', async () => {
    const { ctx, display } = buildCtx([], { engine: engineAt('Assistant'), config: fakeConfig() });
    await mode.handler(ctx);
    const out = text(display);
    expect(out).toMatch(/Trust: safe/);           // current, plain-language
    expect(out).toMatch(/Observer/);
    expect(out).toMatch(/Assistant/);
    expect(out).toMatch(/Partner/);
    expect(out).toMatch(/● Assistant/);            // active one marked
    expect(out).toMatch(/always ask, even in auto/); // floors reassurance
  });
});

describe('/mode — switch + persist', () => {
  it('/mode auto switches to Partner and PERSISTS (survives restart)', async () => {
    const engine = engineAt('Assistant');
    const config = fakeConfig();
    const { ctx, display } = buildCtx(['auto'], { engine, config });
    await mode.handler(ctx);
    expect(engine.getAutonomyPolicy()?.level).toBe('Partner');   // live change
    expect(config.store['agent.autonomy']).toBe('Partner');       // written
    expect(resolveConfiguredAutonomyLevel(config)).toBe('Partner'); // next boot reads it
    expect(text(display)).toMatch(/persisted across restarts/);
  });

  it('/mode safe switches back to Assistant, persisted', async () => {
    const engine = engineAt('Partner');
    const config = fakeConfig();
    config.set('agent.autonomy', 'Partner');
    const { ctx } = buildCtx(['safe'], { engine, config });
    await mode.handler(ctx);
    expect(engine.getAutonomyPolicy()?.level).toBe('Assistant');
    expect(config.store['agent.autonomy']).toBe('Assistant');
    expect(resolveConfiguredAutonomyLevel(config)).toBe('Assistant');
  });

  it('/mode observer → Observer (read-only)', async () => {
    const engine = engineAt('Assistant');
    const config = fakeConfig();
    const { ctx } = buildCtx(['observer'], { engine, config });
    await mode.handler(ctx);
    expect(engine.getAutonomyPolicy()?.level).toBe('Observer');
    expect(config.store['agent.autonomy']).toBe('Observer');
  });

  it('canonical dial names still work (case-insensitive)', async () => {
    const engine = engineAt('Assistant');
    const { ctx } = buildCtx(['partner'], { engine, config: fakeConfig() });
    await mode.handler(ctx);
    expect(engine.getAutonomyPolicy()?.level).toBe('Partner');
  });

  it('unknown arg → friendly error, no change', async () => {
    const engine = engineAt('Assistant');
    const { ctx, display } = buildCtx(['turbo'], { engine, config: fakeConfig() });
    await mode.handler(ctx);
    expect(engine.getAutonomyPolicy()?.level).toBe('Assistant');  // unchanged
    expect(text(display)).toMatch(/Unknown mode "turbo"/);
    expect(text(display)).toMatch(/safe \| auto \| observer/);
  });

  it('no approval engine → clear warning, no crash', async () => {
    const { ctx, display } = buildCtx(['auto']);
    await mode.handler(ctx);
    expect(text(display)).toMatch(/Approval engine not wired/);
  });
});
