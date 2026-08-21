/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it, vi } from 'vitest';

import { makeCodingCommand } from '../../../../cli/v4/commands/coding';
import type { WorkbenchCodingPort } from '../../../../core/v4/workbench/codingPort';

function displaySink() {
  const rows: string[] = [];
  return {
    rows,
    display: {
      info: (value: string) => rows.push(value),
      dim: (value: string) => rows.push(value),
      write: (value: string) => rows.push(value),
      success: (value: string) => rows.push(value),
      warn: (value: string) => rows.push(value),
      printError: (value: string) => rows.push(value),
    },
  };
}

function port(overrides: Partial<WorkbenchCodingPort> = {}): WorkbenchCodingPort {
  return {
    list: vi.fn(() => []),
    review: vi.fn(async () => ({
      promotionId: 'coding_promotion_1',
      codingSessionId: 'coding_session_1',
      state: 'prepared',
      files: [{
        path: 'src/value.ts', operation: 'update', before: 'export const value = 1;', after: 'export const value = 2;',
        beforeHash: 'before', afterHash: 'after', truncated: false,
      }],
      truncated: false,
    })),
    apply: vi.fn(async () => ({ value: { disposition: 'applied' } }) as never),
    discard: vi.fn(async () => ({ value: { disposition: 'rejected' } }) as never),
    discardUnknown: vi.fn(async (codingSessionId: string) => ({
      codingSessionId, state: 'failed', reconciliationState: 'reconciled', workspaceState: 'released',
    })),
    ...overrides,
  };
}

describe('/coding durable promotion command', () => {
  it('renders a bounded exact promotion review without applying it', async () => {
    const coding = port();
    const sink = displaySink();
    await makeCodingCommand({ port: coding }).handler({
      args: ['review', 'coding_promotion_1'], rawArgs: 'review coding_promotion_1',
      display: sink.display, registry: {} as never,
    } as never);

    expect(coding.review).toHaveBeenCalledWith('coding_promotion_1');
    expect(coding.apply).not.toHaveBeenCalled();
    expect(sink.rows.join('\n')).toContain('UPDATE src/value.ts');
    expect(sink.rows.join('\n')).toContain('export const value = 1;');
    expect(sink.rows.join('\n')).toContain('export const value = 2;');
  });

  it('fails closed when apply lacks confirmation and preserves a denied confirmation', async () => {
    const coding = port();
    const withoutConfirmation = displaySink();
    await makeCodingCommand({ port: coding }).handler({
      args: ['apply', 'coding_promotion_1'], rawArgs: 'apply coding_promotion_1',
      display: withoutConfirmation.display, registry: {} as never,
    } as never);
    expect(coding.apply).not.toHaveBeenCalled();
    expect(withoutConfirmation.rows.join('\n')).toContain('requires an interactive confirmation');

    const denied = displaySink();
    await makeCodingCommand({ port: coding }).handler({
      args: ['apply', 'coding_promotion_1'], rawArgs: 'apply coding_promotion_1',
      display: denied.display, registry: {} as never, confirm: async () => false,
    } as never);
    expect(coding.apply).not.toHaveBeenCalled();
    expect(denied.rows.join('\n')).toContain('Apply cancelled.');
  });

  it('applies or discards only after the exact interactive confirmation', async () => {
    const coding = port();
    const applied = displaySink();
    const confirmApply = vi.fn(async () => true);
    await makeCodingCommand({ port: coding }).handler({
      args: ['apply', 'coding_promotion_1'], rawArgs: 'apply coding_promotion_1',
      display: applied.display, registry: {} as never, confirm: confirmApply,
    } as never);
    expect(confirmApply.mock.calls[0]?.[0]).toContain('coding_promotion_1');
    expect(coding.apply).toHaveBeenCalledWith('coding_promotion_1');
    expect(applied.rows.join('\n')).toContain('Applied coding promotion coding_promotion_1.');

    const discarded = displaySink();
    await makeCodingCommand({ port: coding }).handler({
      args: ['discard', 'coding_promotion_1'], rawArgs: 'discard coding_promotion_1',
      display: discarded.display, registry: {} as never, confirm: async () => true,
    } as never);
    expect(coding.discard).toHaveBeenCalledWith('coding_promotion_1');
    expect(discarded.rows.join('\n')).toContain('Discarded coding promotion coding_promotion_1.');
  });
});
