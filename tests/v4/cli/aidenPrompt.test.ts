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

describe('aidenPrompt — cursor positioning (Bug D — deferred to v4.10)', () => {
  it('ghost-bearing render currently has NO cursor fix wired (Bug D documented + deferred)', () => {
    const runner = renderPrompt({
      commands: [{ name: 'daemon', description: 'Manage the Aiden daemon.' }],
      history:  [],
    });
    runner.type('/d');
    const { line } = runner.lastRender();
    // v4.9.2 STATE: Bug D (cursor lands ghost.length cols past
    // end-of-value when a ghost is present) is documented but NOT
    // fixed in this release. The Slice 2 attempt at a cursorBackward
    // post-pend (commit 0d0668f1) was reverted because
    // @inquirer/core's screen-manager.js:56 appends an absolute
    // cursorTo() AFTER our content, overriding any inline cursor-
    // positioning escape. The real fix requires the save/restore
    // refactor scheduled for v4.10. This test pins the current
    // (broken) shape so a future accidental "fix" that doesn't
    // actually work shows up as a changed test rather than silent
    // regression.
    expect(line).toContain('aemon');           // ghost text is rendered
    expect(line).not.toMatch(/\[\d+D/);        // …but NO cursor-back fix
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

  it('produces no footer for non-slash input (free-text mode)', () => {
    const runner = renderPrompt({
      commands: [{ name: 'daemon', description: 'Manage the Aiden daemon.' }],
      history:  ['how do I quit'],
    });
    runner.type('how');
    const { footer } = runner.lastRender();
    // Dropdown is gated on value.startsWith('/'); free-text history
    // suggestion lives inline as a ghost, not in the footer.
    expect(footer).toBeUndefined();
  });
});
