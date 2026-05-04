/**
 * tests/v4/cli/commands.providers.test.ts — Phase 16b.1
 */

import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { providers } from '../../../cli/v4/commands/providers';
import { allCommands } from '../../../cli/v4/commands';
import {
  FallbackAdapter,
  type ProviderSlot,
} from '../../../core/v4/providerFallback';
import type { ProviderAdapter } from '../../../providers/v4/types';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeCtx(over: Record<string, unknown> = {}) {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
  });
  const reg = new CommandRegistry();
  for (const c of allCommands) reg.register(c);
  return {
    output: () => stripAnsi(chunks.join('')),
    ctx: {
      args: [] as string[],
      rawArgs: '',
      display,
      registry: reg,
      ...over,
    },
  };
}

const okAdapter: ProviderAdapter = {
  apiMode: 'chat_completions',
  call: async () => ({
    content: 'ok',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
};

function slot(id: string, keyTail: string | null): ProviderSlot {
  return {
    id,
    providerId: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    keyPresent: keyTail !== null,
    keyTail,
    build: () => (keyTail !== null ? okAdapter : null),
  };
}

describe('/providers', () => {
  it('renders the chain with masked key tails and never leaks the full key', async () => {
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [slot('groq', 'aaaa'), slot('groq2', null), slot('together', 'zzzz')],
    });
    const { ctx, output } = makeCtx({ fallbackAdapter: fa });

    await providers.handler(ctx as any);
    const out = output();

    // Slot ids appear.
    expect(out).toMatch(/groq\b/);
    expect(out).toMatch(/together/);
    // Tails are visible (masked form).
    expect(out).toContain('aaaa');
    expect(out).toContain('zzzz');
    // The mask prefix '••••' shows up before tails.
    expect(out).toContain('••••aaaa');
    // No full key leaks (we never set a long secret here, so just sanity-check).
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    // 'unset' rendering for empty slot.
    expect(out).toMatch(/unset/);
  });

  it('falls back to a one-line summary when no FallbackAdapter is wired', async () => {
    const stubSession = {
      history: [],
      setHistory: () => undefined,
      clearHistory: () => undefined,
      getCurrentProvider: () => 'groq',
      getCurrentModel: () => 'llama-3.3-70b-versatile',
      setProvider: async () => undefined,
    };
    const { ctx, output } = makeCtx({
      session: stubSession,
      fallbackAdapter: null,
    });
    await providers.handler(ctx as any);
    const out = output();
    expect(out).toMatch(/Active: groq/);
    expect(out).toMatch(/fallback chain not active/);
  });
});
