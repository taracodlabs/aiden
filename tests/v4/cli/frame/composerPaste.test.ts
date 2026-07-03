/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12.1 — the frame renderer's main-prompt paste leak.
 *
 * When bracketed paste is enabled, a paste burst reaches the Composer's
 * `useInput` handler with the raw \x1b[200~ / \x1b[201~ markers embedded in
 * `input`. The composer must strip them so they never enter `value` (which is
 * both rendered live AND echoed to scrollback on submit) — this is the path
 * part (a) missed on the main prompt.
 *
 * The Composer calls `useInput` synchronously in its body, and
 * `React.createElement` never invokes child components — so we can capture the
 * key handler by invoking the component as a plain function with fake Ink
 * primitives, then drive synthetic keypresses.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeComposer, type InkComponents, type ComposerCallbacks } from '../../../../cli/v4/frame/composer';
import { makeInitialState, type FrameState } from '../../../../cli/v4/frame/state';

const PASTE_BEGIN = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

type KeyHandler = (input: string, key: Record<string, boolean>) => void;

/** Build a Composer + capture its key handler, seeded with `value`/`cursor`. */
function mount(value = '', cursor = value.length): {
  handler: KeyHandler;
  onChange: ReturnType<typeof vi.fn>;
  callbacks: ComposerCallbacks;
} {
  let handler: KeyHandler = () => {};
  const ink: InkComponents = {
    Box:  (() => null) as unknown as InkComponents['Box'],
    Text: (() => null) as unknown as InkComponents['Text'],
    useInput: ((h: KeyHandler) => { handler = h; }) as unknown as InkComponents['useInput'],
  };
  const Composer = makeComposer(ink);
  const state: FrameState = { ...makeInitialState('› '), composer: { value, cursor, prompt: '› ' } };
  const onChange = vi.fn();
  const callbacks: ComposerCallbacks = { onChange, onSubmit: vi.fn(), onCancel: vi.fn() };
  // Invoke the component as a plain function — registers the handler via useInput.
  (Composer as unknown as (p: { state: FrameState; callbacks: ComposerCallbacks }) => unknown)({ state, callbacks });
  return { handler, onChange, callbacks };
}

describe('frame Composer — bracketed-paste markers never enter the value', () => {
  it('a marker-wrapped single-line paste lands clean', () => {
    const { handler, onChange } = mount();
    handler(`${PASTE_BEGIN}list files in Downloads${PASTE_END}`, {});
    expect(onChange).toHaveBeenCalledExactlyOnceWith('list files in Downloads', 'list files in Downloads'.length);
  });

  it('a bare begin marker alone produces no marker in the value', () => {
    const { handler, onChange } = mount();
    handler(`${PASTE_BEGIN}list files`, {});   // end marker arrives in a later burst
    const [value] = onChange.mock.calls.at(-1)!;
    expect(value).toBe('list files');
    expect(value).not.toContain('[200~');
    expect(value).not.toContain('\x1b');
  });

  it('markers embedded mid-buffer are stripped, surrounding text kept', () => {
    const { handler, onChange } = mount('pre', 3);
    handler(`${PASTE_BEGIN}fix${PASTE_END}`, {});
    expect(onChange).toHaveBeenCalledWith('prefix', 'prefix'.length);
  });

  it('an input that is ONLY a marker is a no-op (no empty onChange churn)', () => {
    const { handler, onChange } = mount('hi', 2);
    handler(PASTE_BEGIN, {});
    handler(PASTE_END, {});
    expect(onChange).not.toHaveBeenCalled();
  });

  it('plain typing is unaffected (no regression)', () => {
    const { handler, onChange } = mount('ab', 2);
    handler('c', {});
    expect(onChange).toHaveBeenCalledExactlyOnceWith('abc', 3);
  });

  it('control bytes riding along with a paste are scrubbed', () => {
    const { handler, onChange } = mount();
    handler(`${PASTE_BEGIN}a\x07b\x08c${PASTE_END}`, {});   // BEL + BS embedded
    expect(onChange).toHaveBeenCalledExactlyOnceWith('abc', 3);
  });
});
