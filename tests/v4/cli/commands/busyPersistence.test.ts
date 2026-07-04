/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — /busy persists the preferred Enter-while-busy mode so it survives a
 * restart: it writes `agent.busyMode` to config, and boot re-reads it via
 * resolveConfiguredBusyMode. A garbage stored value never RAISES to a more
 * autonomous mode — it coerces to the safe 'queue'.
 */
import { describe, it, expect, vi } from 'vitest';
import { busy } from '../../../../cli/v4/commands/busy';
import { resolveConfiguredBusyMode } from '../../../../cli/v4/duringTurnInput';
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
function fakeSession() {
  let mode = 'queue';
  return { setBusyMode: (m: string) => { mode = m; }, getBusyMode: () => mode };
}
function buildCtx(args: string[], opts: { session?: unknown; config?: ReturnType<typeof fakeConfig> }) {
  const out: string[] = [];
  const display = {
    info: (m: string) => out.push(`info:${m}`),
    warn: (m: string) => out.push(`warn:${m}`),
    success: (m: string) => out.push(`ok:${m}`),
  };
  const ctx = { args, rawArgs: args.join(' '), display, session: opts.session, config: opts.config } as unknown as SlashCommandContext;
  return { ctx, out };
}
const text = (o: string[]) => o.join('\n');

describe('resolveConfiguredBusyMode', () => {
  it('reads a valid persisted mode', () => {
    expect(resolveConfiguredBusyMode({ getValue: (<T,>(_k: string, _fb?: T) => 'redirect' as unknown as T) })).toBe('redirect');
  });
  it('defaults to queue when unset, and coerces garbage to queue (never RAISES)', () => {
    expect(resolveConfiguredBusyMode()).toBe('queue');
    expect(resolveConfiguredBusyMode({ getValue: (<T,>(_k: string, fb?: T) => fb as T) })).toBe('queue');
    expect(resolveConfiguredBusyMode({ getValue: (<T,>() => 'interrupt-ish' as unknown as T) })).toBe('queue');
  });
});

describe('/busy — persists the preferred mode across restarts', () => {
  it('sets the live mode AND writes agent.busyMode (survives a simulated restart)', async () => {
    const config = fakeConfig();
    const session = fakeSession();
    const { ctx, out } = buildCtx(['redirect'], { session, config });

    await busy.handler(ctx);

    expect(session.getBusyMode()).toBe('redirect');        // live session flipped
    expect(config.store['agent.busyMode']).toBe('redirect'); // written to config
    expect(config.save).toHaveBeenCalledOnce();
    expect(resolveConfiguredBusyMode(config)).toBe('redirect'); // boot re-reads it
    expect(text(out)).toMatch(/persisted/i);
  });

  it('an unknown mode is rejected — no write, no persist', async () => {
    const config = fakeConfig();
    const session = fakeSession();
    const { ctx, out } = buildCtx(['nonsense'], { session, config });
    await busy.handler(ctx);
    expect(config.store['agent.busyMode']).toBeUndefined();
    expect(config.save).not.toHaveBeenCalled();
    expect(text(out)).toMatch(/Unknown mode/);
  });

  it('no config wired → session-only switch, no crash, no "persisted" claim', async () => {
    const session = fakeSession();
    const { ctx, out } = buildCtx(['interrupt'], { session });
    await busy.handler(ctx);
    expect(session.getBusyMode()).toBe('interrupt');
    expect(text(out)).not.toMatch(/persisted/i);
  });
});
