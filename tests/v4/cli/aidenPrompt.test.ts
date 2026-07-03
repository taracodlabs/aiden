/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.2 SLICE 2 — aidenPrompt render-snapshot coverage.
 *
 * First test file for cli/v4/aidenPrompt.ts. Mocks @inquirer/core so
 * we can drive the render closure with synthetic keypresses and
 * inspect the returned [line, footer] tuple. Closes the v4.1-era
 * test gap that let Bug D ship silently in v4.9.1.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Inline @inquirer/core mock ─────────────────────────────────────────
//
// The mock replaces createPrompt with a sync runner that:
//   - Backs useState / useRef with per-render arrays indexed by call order
//   - Stores the registered useKeypress callback for tests to invoke
//   - Re-runs the render closure on every keypress so the test reads the
//     latest [line, footer] tuple
//
// Hooks faked: useState, useRef, useEffect, useKeypress, usePrefix,
// makeTheme, isEnterKey, isTabKey, isBackspaceKey.

type Render = string | [string, string];
type KeyHandler = (key: { name?: string; ctrl?: boolean }, rl: FakeRl) => void;

interface FakeRl {
  line:        string;
  cursor:      number;
  clearLine:   (dir?: number) => void;
  write:       (s: string) => void;
}

interface PromptRunner {
  lastRender(): { line: string; footer: string | undefined };
  type(text: string): void;
  keypress(key: { name?: string; ctrl?: boolean }): void;
  state: { rl: FakeRl };
}

// Hook stores (reset per createPrompt invocation).
let stateStore:      unknown[];
let stateIdx:        number;
let refStore:        Array<{ current: unknown }>;
let refIdx:          number;
let effectRan:       boolean;
let keyHandler:      KeyHandler | null;
let lastRendered:    Render = '';
let renderClosure:   ((config: unknown, done: (v: unknown) => void) => Render) | null = null;
let activeConfig:    unknown = null;
let fakeRl:          FakeRl;

function resetHookStores(): void {
  stateStore  = [];
  refStore    = [];
  effectRan   = false;
  keyHandler  = null;
}

vi.mock('@inquirer/core', () => {
  return {
    createPrompt: (fn: (config: unknown, done: (v: unknown) => void) => Render) => {
      renderClosure = fn;
      // Real @inquirer/core returns a callable that runs the prompt against
      // stdio. Our tests never call this — they invoke renderClosure directly
      // via PromptRunner.
      return ((_config: unknown): Promise<string> => Promise.resolve(''));
    },
    useState: <T,>(initial: T): [T, (next: T) => void] => {
      const idx = stateIdx++;
      if (stateStore[idx] === undefined) stateStore[idx] = initial;
      return [stateStore[idx] as T, (next: T) => { stateStore[idx] = next; }];
    },
    useRef: <T,>(initial: T): { current: T } => {
      const idx = refIdx++;
      if (!refStore[idx]) refStore[idx] = { current: initial };
      return refStore[idx] as { current: T };
    },
    useEffect: (fn: (rl: FakeRl) => void) => {
      if (!effectRan) { effectRan = true; fn(fakeRl); }
    },
    useKeypress: (fn: KeyHandler) => { keyHandler = fn; },
    usePrefix:   () => '?',
    makeTheme:   <T,>(_base: unknown, override?: T) => ({
      style: {
        message: (s: string) => s,
        answer:  (s: string) => s,
      },
      ...((override ?? {}) as object),
    }),
    isEnterKey:     (k: { name?: string }) => k?.name === 'enter',
    isTabKey:       (k: { name?: string }) => k?.name === 'tab',
    isBackspaceKey: (k: { name?: string }) => k?.name === 'backspace',
  };
});

function renderPrompt(config: {
  message?:  string;
  commands:  Array<{ name: string; aliases?: string[]; description: string; hidden?: boolean }>;
  history:   string[];
}): PromptRunner {
  activeConfig = { message: '›', ...config };
  resetHookStores();
  fakeRl = {
    line:   '',
    cursor: 0,
    clearLine() { fakeRl.line = ''; fakeRl.cursor = 0; },
    write(s: string) { fakeRl.line = s; fakeRl.cursor = s.length; },
  };

  function render(): Render {
    stateIdx = 0;
    refIdx   = 0;
    const out = renderClosure!(activeConfig, () => { /* done */ });
    lastRendered = out;
    return out;
  }
  // Prime: first render registers hooks + the useKeypress callback.
  render();

  return {
    state: { rl: fakeRl },
    lastRender() {
      return Array.isArray(lastRendered)
        ? { line: lastRendered[0], footer: lastRendered[1] }
        : { line: lastRendered as string, footer: undefined };
    },
    type(text: string) {
      for (const ch of text) {
        fakeRl.line   += ch;
        fakeRl.cursor =  fakeRl.line.length;
        keyHandler?.({ name: ch }, fakeRl);
        render();
      }
    },
    keypress(key) {
      keyHandler?.(key, fakeRl);
      render();
    },
  };
}

// Import the prompt AFTER the mock is in place.
let aidenPrompt: unknown;
beforeEach(async () => {
  vi.resetModules();
  resetHookStores();
  const mod = await import('../../../cli/v4/aidenPrompt');
  aidenPrompt = mod.default;
  void aidenPrompt;  // referenced to register createPrompt closure
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('aidenPrompt — Bug D fix via footer rendering (v4.10 Slice 10.5)', () => {
  it('ghost text renders in the footer slot, NOT inline in the prompt line', () => {
    const runner = renderPrompt({
      commands: [{ name: 'daemon', description: 'Manage the Aiden daemon.' }],
      history:  [],
    });
    runner.type('/d');
    const { line, footer } = runner.lastRender();
    // v4.10 Slice 10.5 — Path A. The ghost suggestion ("aemon" — the
    // tail of "/daemon" minus the typed "/d") MUST NOT appear inline
    // in the prompt line. Inquirer's screen-manager owns cursor
    // positioning on `line`; with no embedded ghost it naturally
    // lands right after the typed value. The ghost text renders in
    // the footer slot below.
    expect(line).not.toContain('aemon');
    expect(line).not.toMatch(/\[\d+D/);    // no inline cursor escape either
    // And footer carries the ghost (in addition to dropdown rows).
    expect(footer).toBeDefined();
    expect(footer).toContain('aemon');
  });

  it('no ghost AND no dropdown → string return (no tuple)', () => {
    const runner = renderPrompt({
      commands: [{ name: 'daemon', description: 'Manage the Aiden daemon.' }],
      history:  [],
    });
    runner.type('xy');     // free-text, no history match → no ghost
    const { footer } = runner.lastRender();
    expect(footer).toBeUndefined();
  });

  it('ghost without dropdown (free-text history match) still lands in footer', () => {
    const runner = renderPrompt({
      commands: [{ name: 'daemon', description: 'Manage the Aiden daemon.' }],
      history:  ['how do I quit'],
    });
    runner.type('how');
    const { line, footer } = runner.lastRender();
    // free-text ghost (rest of "how do I quit") must be in footer,
    // not embedded in the prompt line.
    expect(line).not.toContain('do I quit');
    expect(footer).toBeDefined();
    expect(footer).toContain('do I quit');
  });
});

describe('aidenPrompt — extra render-snapshot coverage', () => {
  it('omits cursorBackward when no ghost is present (unknown command)', () => {
    const runner = renderPrompt({
      commands: [{ name: 'daemon', description: 'Manage the Aiden daemon.' }],
      history:  [],
    });
    // '/xyz' matches no slash command → findGhost returns null →
    // no cursorBackward post-pend.
    runner.type('/xyz');
    const { line } = runner.lastRender();
    // Assert no CSI backward sequence anywhere in the line.
    expect(line).not.toMatch(/\[\d+D/);
  });

  it('returns a non-empty footer with slash rows when typing /', () => {
    const runner = renderPrompt({
      commands: [
        { name: 'daemon', description: 'Manage the Aiden daemon.' },
        { name: 'doctor', description: 'Diagnose Aiden setup.' },
      ],
      history: [],
    });
    runner.type('/d');
    const { footer } = runner.lastRender();
    expect(footer).toBeDefined();
    expect(footer).toContain('/daemon');
    expect(footer).toContain('/doctor');
  });

  it('free-text input with NO history match returns string (no footer)', () => {
    const runner = renderPrompt({
      commands: [{ name: 'daemon', description: 'Manage the Aiden daemon.' }],
      history:  ['unrelated'],
    });
    runner.type('zzz');     // no history match → no ghost → no footer
    const { footer } = runner.lastRender();
    expect(footer).toBeUndefined();
  });

  // v4.10 Slice 10.5 — Bug D fix (Path A) moved ghost out of the
  // line into the footer. This used to assert `footer === undefined`
  // for free-text + history match; the new contract is the opposite —
  // ghost goes to the footer slot. The "ghost without dropdown lands
  // in footer" test above covers the new positive case.
});
