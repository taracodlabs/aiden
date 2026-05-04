/**
 * debugPrompt.test.ts — Phase 16b.4
 *
 * Covers /debug-prompt + /personality wiring at the slash-command surface.
 * Stubs AidenAgent + PersonalityManager — verifying wire-up, not the
 * underlying classes (those have their own tests).
 */
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { debugPrompt, redactSecrets } from '../../../cli/v4/commands/debugPrompt';
import { personality } from '../../../cli/v4/commands/personality';

function mkCtx() {
  const out: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const stderr = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout,
    stderr,
  });
  return {
    out,
    base: {
      display,
      registry: new CommandRegistry(),
      args: [],
      rawArgs: '',
    },
  };
}

describe('redactSecrets', () => {
  it('redacts groq, openai, xai, cerebras, google, bearer, jwt patterns', () => {
    const sample =
      'gsk_aaaaaaaaaaaaaaaaaaaa sk-bbbbbbbbbbbbbbbbbb xai-cccccccccccccccccccccc ' +
      'csk-dddddddddddddddddddddd AIzaeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ' +
      'Bearer ffffffffffffffffffff aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccc';
    const { redacted, hits } = redactSecrets(sample);
    expect(hits).toBeGreaterThan(0);
    expect(redacted).not.toContain('gsk_a');
    expect(redacted).not.toContain('sk-b');
    expect(redacted).not.toContain('xai-c');
    expect(redacted).not.toContain('AIzae');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).toContain('Bearer [REDACTED]');
  });

  it('preserves clean text untouched', () => {
    const safe = 'You are Aiden — a local-first AI agent.';
    const { redacted, hits } = redactSecrets(safe);
    expect(redacted).toBe(safe);
    expect(hits).toBe(0);
  });
});

describe('/debug-prompt', () => {
  it('dumps the system prompt when the agent is wired', async () => {
    const { out, base } = mkCtx();
    const fakeAgent = {
      getSystemPromptForDebug: vi.fn(async () => 'IDENTITY-MARKER\n\nMEMORY-MARKER'),
    };
    await debugPrompt.handler({
      ...base,
      agent: fakeAgent as any,
    } as any);
    const joined = out.join('');
    expect(joined).toContain('IDENTITY-MARKER');
    expect(joined).toContain('MEMORY-MARKER');
    expect(joined).toContain('BEGIN SYSTEM PROMPT');
  });

  it('redacts secret-shaped strings before printing', async () => {
    const { out, base } = mkCtx();
    const promptWithKey = 'You are Aiden.\nSomehow: gsk_abcdefghijklmnopqrst';
    const fakeAgent = {
      getSystemPromptForDebug: vi.fn(async () => promptWithKey),
    };
    await debugPrompt.handler({
      ...base,
      agent: fakeAgent as any,
    } as any);
    const joined = out.join('');
    expect(joined).not.toContain('gsk_abc');
    expect(joined).toContain('[REDACTED]');
  });

  it('warns when no agent is wired', async () => {
    const { out, base } = mkCtx();
    await debugPrompt.handler({ ...base } as any);
    const joined = out.join('');
    expect(joined.toLowerCase()).toContain('agent not wired');
  });

  it('warns when no PromptBuilder is wired (returns null)', async () => {
    const { out, base } = mkCtx();
    const fakeAgent = {
      getSystemPromptForDebug: vi.fn(async () => null),
    };
    await debugPrompt.handler({
      ...base,
      agent: fakeAgent as any,
    } as any);
    const joined = out.join('');
    expect(joined.toLowerCase()).toContain('no promptbuilder');
  });
});

describe('/personality wiring (Phase 16b.4)', () => {
  it('lists bundled + current when called with no args', async () => {
    const { out, base } = mkCtx();
    const mgr = {
      list: vi.fn(async () => [
        { name: 'default', description: 'd', source: 'bundled' as const },
        { name: 'concise', description: 'c', source: 'bundled' as const },
      ]),
      getCurrent: vi.fn(() => 'default'),
      getActiveOverlay: vi.fn(async () => ''),
      setCurrent: vi.fn(),
    };
    await personality.handler({
      ...base,
      personalityManager: mgr as any,
    } as any);
    const joined = out.join('');
    expect(joined).toContain('Active personality: default');
    expect(joined).toContain('concise');
    expect(joined).toContain('default');
  });

  it('switching pushes the new overlay into the agent and invalidates cache', async () => {
    const { base } = mkCtx();
    const mgr = {
      list: vi.fn(),
      getCurrent: vi.fn(() => 'concise'),
      getActiveOverlay: vi.fn(async () => 'BE BRIEF'),
      setCurrent: vi.fn(async (n: string) => ({ ok: n === 'concise' })),
    };
    const setOverlay = vi.fn(() => true);
    await personality.handler({
      ...base,
      rawArgs: 'concise',
      personalityManager: mgr as any,
      agent: { setPersonalityOverlay: setOverlay } as any,
    } as any);
    expect(mgr.setCurrent).toHaveBeenCalledWith('concise');
    expect(setOverlay).toHaveBeenCalledWith('BE BRIEF');
  });

  it('preserves SOUL.md (does not touch identity slot) when switching', async () => {
    // Verifies the personality command never mutates anything that could
    // overwrite slot 1. We assert by spying on agent: only
    // setPersonalityOverlay is called — never some hypothetical setIdentity.
    const { base } = mkCtx();
    const mgr = {
      list: vi.fn(),
      getCurrent: vi.fn(() => 'concise'),
      getActiveOverlay: vi.fn(async () => 'OVERLAY-BODY'),
      setCurrent: vi.fn(async () => ({ ok: true })),
    };
    const fakeAgent: Record<string, unknown> = {
      setPersonalityOverlay: vi.fn(() => true),
      // Identity-touching calls that should NOT happen:
      setProvider: vi.fn(),
      setIdentity: vi.fn(),
      setSoulMd: vi.fn(),
    };
    await personality.handler({
      ...base,
      rawArgs: 'concise',
      personalityManager: mgr as any,
      agent: fakeAgent as any,
    } as any);
    expect(fakeAgent.setPersonalityOverlay).toHaveBeenCalledTimes(1);
    expect(fakeAgent.setProvider).not.toHaveBeenCalled();
    expect(fakeAgent.setIdentity).not.toHaveBeenCalled();
    expect(fakeAgent.setSoulMd).not.toHaveBeenCalled();
  });

  it('/personality show dumps the active overlay body', async () => {
    const { out, base } = mkCtx();
    const mgr = {
      list: vi.fn(),
      getCurrent: vi.fn(() => 'concise'),
      getActiveOverlay: vi.fn(async () => 'BREVITY IS LIFE'),
      setCurrent: vi.fn(),
    };
    await personality.handler({
      ...base,
      rawArgs: 'show',
      personalityManager: mgr as any,
    } as any);
    const joined = out.join('');
    expect(joined).toContain('BREVITY IS LIFE');
    expect(mgr.setCurrent).not.toHaveBeenCalled();
  });

  it('warns when no manager is wired (regression guard for the 16b.4 bug)', async () => {
    const { out, base } = mkCtx();
    await personality.handler({ ...base } as any);
    const joined = out.join('');
    expect(joined).toContain('Personality manager not wired');
  });
});
