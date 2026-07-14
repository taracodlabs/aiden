import { describe, expect, it, vi } from 'vitest';
import { InputAuthority, type RawStdinLike } from '../../../cli/v4/inputAuthority';
import { CliCallbacks } from '../../../cli/v4/callbacks';
import { attachTurnInputListener } from '../../../cli/v4/turnInputListener';
import { DuringTurnInput } from '../../../cli/v4/duringTurnInput';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { Writable } from 'node:stream';

function fakeStdin(initialRaw = false, initialPaused = false) {
  let raw = initialRaw;
  let paused = initialPaused;
  const listeners = new Set<(s: string | undefined, k: { name?: string; sequence?: string }) => void>();
  const stdin: RawStdinLike & { emitKey(s?: string, k?: { name?: string; sequence?: string }): void; count(): number } = {
    isTTY: true,
    get isRaw() { return raw; },
    get readableFlowing() { return paused ? false : true; },
    isPaused() { return paused; },
    resume: vi.fn(() => { paused = false; }),
    pause: vi.fn(() => { paused = true; }),
    setRawMode: vi.fn((value: boolean) => { raw = value; }),
    on(_event, handler) { listeners.add(handler); },
    removeListener(_event, handler) { listeners.delete(handler); },
    emitKey(s, k = {}) { for (const handler of [...listeners]) handler(s, k); },
    count() { return listeners.size; },
  };
  return stdin;
}

describe('InputAuthority exclusive leases', () => {
  it('lends modal prompts a non-owning facade that suppresses readline cleanup mutations', async () => {
    const stdin = fakeStdin(false, true);
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    const releaseRaw = authority.mountRawOwner('during_turn', vi.fn());
    const pauseCallsBefore = vi.mocked(stdin.pause!).mock.calls.length;
    const rawCallsBefore = vi.mocked(stdin.setRawMode!).mock.calls.length;

    await authority.runExclusive('clarify', async (modal: RawStdinLike) => {
      expect(modal).not.toBe(stdin);
      expect(stdin.isRaw).toBe(true);
      expect(stdin.isPaused?.()).toBe(false);
      modal.pause?.();
      modal.setRawMode?.(false);
      expect(stdin.isRaw).toBe(true);
      expect(stdin.isPaused?.()).toBe(false);
    });

    expect(vi.mocked(stdin.pause!).mock.calls.length).toBe(pauseCallsBefore);
    expect(vi.mocked(stdin.setRawMode!).mock.calls.length).toBe(rawCallsBefore);
    expect(authority.currentOwner()).toBe('during_turn');
    expect(stdin.isRaw).toBe(true);
    expect(stdin.isPaused?.()).toBe(false);

    releaseRaw();
    expect(stdin.isRaw).toBe(false);
    expect(stdin.isPaused?.()).toBe(true);
  });

  it('ignores stale facade cleanup after a newer modal lease acquires stdin', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    authority.mountRawOwner('during_turn', vi.fn());
    let staleFacade!: RawStdinLike;
    await authority.runExclusive('clarify', async (modal: RawStdinLike) => {
      staleFacade = modal;
      return 'first';
    });

    await authority.runExclusive('approval', async (modal: RawStdinLike) => {
      expect(modal).not.toBe(staleFacade);
      const pauseCalls = vi.mocked(stdin.pause!).mock.calls.length;
      const rawCalls = vi.mocked(stdin.setRawMode!).mock.calls.length;
      staleFacade.pause?.();
      staleFacade.setRawMode?.(false);
      expect(vi.mocked(stdin.pause!).mock.calls.length).toBe(pauseCalls);
      expect(vi.mocked(stdin.setRawMode!).mock.calls.length).toBe(rawCalls);
      expect(stdin.isRaw).toBe(true);
      expect(stdin.isPaused?.()).toBe(false);
      return 'second';
    });
  });

  it.each([
    { initialRaw: true, initialPaused: false },
    { initialRaw: false, initialPaused: false },
    { initialRaw: false, initialPaused: true },
  ])('restores exact pre-lease state without a raw owner ($initialRaw/$initialPaused)', async ({ initialRaw, initialPaused }) => {
    const stdin = fakeStdin(initialRaw, initialPaused);
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    await authority.runExclusive('approval', async (modal: RawStdinLike) => {
      expect(stdin.isRaw).toBe(true);
      expect(stdin.isPaused?.()).toBe(false);
      modal.pause?.();
      modal.setRawMode?.(false);
      return 'deny';
    });
    expect(stdin.isRaw).toBe(initialRaw);
    expect(stdin.isPaused?.()).toBe(initialPaused);
    expect(authority.currentOwner()).toBeNull();
  });

  it('uses unique leases and stale/double releases cannot remove a newer mount', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    const first = authority.mountRawOwner('during_turn', vi.fn());
    const firstId = authority.currentLeaseId();
    const secondHandler = vi.fn();
    const second = authority.mountRawOwner('during_turn', secondHandler);
    expect(authority.currentLeaseId()).not.toBe(firstId);
    await first();
    stdin.emitKey('x', { name: 'x', sequence: 'x' });
    expect(secondHandler).toHaveBeenCalledOnce();
    await first();
    expect(stdin.count()).toBe(1);
    await second();
    expect(stdin.count()).toBe(0);
  });

  it('restores the exact handler, excludes overlap, and replays no modal input', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    const handler = vi.fn();
    authority.mountRawOwner('during_turn', handler);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const modal = authority.runExclusive('skill_prompt', async () => {
      expect(stdin.count()).toBe(0);
      stdin.emitKey('n', { name: 'n', sequence: 'n' });
      await expect(authority.runExclusive('approval', async () => true)).rejects.toThrow(/exclusive input lease/i);
      await gate;
      return false;
    });
    release();
    await expect(modal).resolves.toBe(false);
    expect(authority.currentOwner()).toBe('during_turn');
    expect(handler).not.toHaveBeenCalled();
    stdin.emitKey('z', { name: 'z', sequence: 'z' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([false, true])('restores raw mode and ownership after throw (initial=%s)', async (initial) => {
    const stdin = fakeStdin(initial);
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    authority.mountRawOwner('during_turn', vi.fn());
    await expect(authority.runExclusive('clarify', async () => { throw new Error('cancel'); })).rejects.toThrow('cancel');
    expect(authority.currentOwner()).toBe('during_turn');
    expect(stdin.isRaw).toBe(true);
  });

  it('preserves pre-modal type-ahead in the same handler and queues no modal answer', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    const queue = new DuringTurnInput();
    attachTurnInputListener({
      authority,
      cb: { onLine: (text) => { queue.onBusyEnter(text); }, onEscape: vi.fn(), onCtrlC: vi.fn() },
    });
    stdin.emitKey('a', { name: 'a', sequence: 'a' });
    await authority.runExclusive('skill_prompt', async () => {
      stdin.emitKey('n', { name: 'n', sequence: 'n' });
      stdin.emitKey('\r', { name: 'return', sequence: '\r' });
      return false;
    });
    expect(queue.dequeue()).toBeNull();
    stdin.emitKey('b', { name: 'b', sequence: 'b' });
    stdin.emitKey('\r', { name: 'return', sequence: '\r' });
    expect(queue.dequeue()).toBe('ab');
    expect(queue.dequeue()).toBeNull();
  });

  it('resumes stdin when restoring a raw owner after prompt cleanup paused it', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    authority.mountRawOwner('during_turn', vi.fn());
    await authority.runExclusive('clarify', async () => { stdin.pause?.(); return 'answer'; });
    expect(stdin.isPaused?.()).toBe(false);
    expect(stdin.readableFlowing).toBe(true);
    expect(stdin.resume).toHaveBeenCalledOnce();
  });

  it('restores only flow state changed by the exact registration', () => {
    const stdin = fakeStdin(false, true);
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    const first = authority.mountRawOwner('during_turn', vi.fn());
    expect(stdin.isPaused?.()).toBe(false);
    const second = authority.mountRawOwner('during_turn', vi.fn());
    first();
    expect(stdin.isPaused?.()).toBe(false);
    second();
    expect(stdin.isPaused?.()).toBe(true);
  });
});

describe('interactive callback lease wiring', () => {
  it('leases approval, clarification, and skill-save and passes the lease facade only to modal prompts', async () => {
    const owners: string[] = [];
    const modalInput = fakeStdin();
    const contexts: unknown[] = [];
    const prompts = {
      select: vi.fn(async ({ message }: { message: string }, context?: unknown) => {
        contexts.push(context);
        return message === 'Decision' ? 'deny' : 'one';
      }),
      confirm: vi.fn(async (_opts: unknown, context?: unknown) => { contexts.push(context); return false; }),
      input: vi.fn(async (_opts: unknown, context?: unknown) => { contexts.push(context); return 'answer'; }),
    };
    const sink = new Writable({ write(_chunk, _enc, done) { done(); } }) as NodeJS.WriteStream;
    const display = new Display({ skin: new SkinEngine({ forceMono: true }), stdout: sink, stderr: sink });
    const callbacks = new CliCallbacks({ display, promptModule: prompts });
    callbacks.setExclusiveInputRunner(async (owner, run) => { owners.push(owner); return run(modalInput); });
    await callbacks.promptApproval({ toolName: 'shell_exec', category: 'execute', args: {}, reason: 'test' } as never);
    await callbacks.promptClarify('Question?');
    await callbacks.promptSkillProposal({ proposedName: 'test', description: 'test', toolsUsed: [], confidence: 0.8 } as never);
    expect(owners).toEqual(['approval', 'clarify', 'skill_prompt']);
    expect(contexts).toEqual([
      { input: modalInput },
      { input: modalInput },
      { input: modalInput },
    ]);
  });

  it('releases and reacquires unique leases for consecutive clarification calls', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    const rawHandler = vi.fn();
    authority.mountRawOwner('during_turn', rawHandler);
    const answers = ['first answer', 'second answer'];
    const prompts = { select: vi.fn(), confirm: vi.fn(), input: vi.fn(async () => {
      expect(authority.currentOwner()).toBe('clarify');
      stdin.emitKey('x', { name: 'x', sequence: 'x' });
      return answers.shift()!;
    }) };
    const sink = new Writable({ write(_chunk, _enc, done) { done(); } }) as NodeJS.WriteStream;
    const callbacks = new CliCallbacks({ display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: sink, stderr: sink }), promptModule: prompts });
    const acquisitions: Array<{ leaseId: number | null; epoch: number }> = [];
    callbacks.setExclusiveInputRunner((owner, run) => authority.runExclusive(owner, async () => {
      acquisitions.push({ leaseId: authority.currentLeaseId(), epoch: authority.currentEpoch() });
      return run();
    }));
    await expect(callbacks.promptClarify('first?')).resolves.toBe('first answer');
    expect(authority.currentOwner()).toBe('during_turn');
    await expect(callbacks.promptClarify('second?')).resolves.toBe('second answer');
    expect(acquisitions[0].leaseId).not.toBe(acquisitions[1].leaseId);
    expect(acquisitions[1].epoch).toBeGreaterThan(acquisitions[0].epoch);
    expect(rawHandler).not.toHaveBeenCalled();
  });

  it('keeps select then Other free-text inside one lease', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    authority.mountRawOwner('during_turn', vi.fn());
    const owners: Array<string | null> = [];
    const prompts = {
      select: vi.fn(async () => { owners.push(authority.currentOwner()); return '__clarify_other__'; }),
      confirm: vi.fn(),
      input: vi.fn(async () => { owners.push(authority.currentOwner()); return 'custom'; }),
    };
    const sink = new Writable({ write(_chunk, _enc, done) { done(); } }) as NodeJS.WriteStream;
    const callbacks = new CliCallbacks({ display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: sink, stderr: sink }), promptModule: prompts });
    let leases = 0;
    callbacks.setExclusiveInputRunner((owner, run) => { leases += 1; return authority.runExclusive(owner, run); });
    await expect(callbacks.promptClarify('pick?', ['A'])).resolves.toBe('custom');
    expect(leases).toBe(1);
    expect(owners).toEqual(['clarify', 'clarify']);
    expect(authority.currentOwner()).toBe('during_turn');
  });

  it('cancelling the second clarification returns null without aborting the turn', async () => {
    const stdin = fakeStdin();
    const authority = new InputAuthority({ stdin, emitKeypressEvents: vi.fn(), onProcessExit: vi.fn(), offProcessExit: vi.fn() });
    authority.mountRawOwner('during_turn', vi.fn());
    let calls = 0;
    const prompts = { select: vi.fn(), confirm: vi.fn(), input: vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('ExitPromptError');
      return 'first';
    }) };
    const sink = new Writable({ write(_chunk, _enc, done) { done(); } }) as NodeJS.WriteStream;
    const callbacks = new CliCallbacks({ display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: sink, stderr: sink }), promptModule: prompts });
    callbacks.setExclusiveInputRunner((owner, run) => authority.runExclusive(owner, run));
    const turn = new AbortController();
    await expect(callbacks.promptClarify('first?')).resolves.toBe('first');
    await expect(callbacks.promptClarify('second?')).resolves.toBeNull();
    expect(turn.signal.aborted).toBe(false);
    expect(authority.currentOwner()).toBe('during_turn');
  });
});
