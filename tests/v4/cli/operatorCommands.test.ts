/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { describe, expect, it, vi } from 'vitest';

import { cls } from '../../../cli/v4/commands/cls';
import { newSession } from '../../../cli/v4/commands/newSession';
import { clear } from '../../../cli/v4/commands/clear';
import { session } from '../../../cli/v4/commands/session';

describe('operator screen and conversation commands', () => {
  it('/cls clears only the visual screen', async () => {
    const clearScreen = vi.fn();
    const clearHistory = vi.fn();
    await cls.handler({ display: { clearScreen }, session: { clearHistory } } as never);
    expect(clearScreen).toHaveBeenCalledTimes(1);
    expect(clearHistory).not.toHaveBeenCalled();
  });

  it('/clear starts a new persisted conversation and preserves durable history', async () => {
    const clearScreen = vi.fn();
    const success = vi.fn();
    const dim = vi.fn();
    const result = await clear.handler({
      display: { clearScreen, success, dim },
      session: { startNewSession: () => 'session_new' },
    } as never);
    expect(clearScreen).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith('New chat started · session_new');
    expect(dim).toHaveBeenCalledWith('Previous Jobs and proof remain available through /jobs and /trace.');
    expect(result).toEqual({ clearHistory: true });
  });

  it('/new is an exact alias for /clear', async () => {
    const clearScreen = vi.fn();
    const success = vi.fn();
    const dim = vi.fn();
    const result = await newSession.handler({
      display: { clearScreen, success, dim },
      session: { startNewSession: () => 'session_new' },
    } as never);
    expect(result).toEqual({ clearHistory: true });
    expect(success).toHaveBeenCalledWith('New chat started · session_new');
  });

  it('retains bounded legacy behavior for injected sessions without persistence', async () => {
    const clearHistory = vi.fn();
    const dim = vi.fn();
    const result = await clear.handler({ display: { dim }, session: { clearHistory } } as never);
    expect(clearHistory).toHaveBeenCalledTimes(1);
    expect(dim).toHaveBeenCalledWith('History cleared. Persisted session switching is unavailable in this runtime.');
    expect(result).toEqual({ clearHistory: true });
  });

  it('/session delete requires an explicit confirmation', async () => {
    const warn = vi.fn();
    const dim = vi.fn();
    const deleteStoredSession = vi.fn();
    await session.handler({
      args: ['delete'], display: { warn, dim }, session: { deleteStoredSession },
    } as never);
    expect(deleteStoredSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Session deletion requires confirmation.');
  });

  it('/session delete removes only the selected stored conversation', async () => {
    const success = vi.fn();
    const dim = vi.fn();
    const deleteStoredSession = vi.fn(() => ({ deletedId: 'session_old', replacementId: null }));
    const result = await session.handler({
      args: ['delete', 'session_old', '--yes'],
      display: { success, dim },
      session: { deleteStoredSession },
    } as never);
    expect(deleteStoredSession).toHaveBeenCalledWith('session_old');
    expect(success).toHaveBeenCalledWith('Stored session deleted · session_old');
    expect(dim).toHaveBeenCalledWith('Durable Jobs, Effects, and Proof remain available.');
    expect(result).toEqual({ clearHistory: false });
  });
});
