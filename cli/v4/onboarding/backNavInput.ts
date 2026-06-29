/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/onboarding/backNavInput.ts — v4.11 wizard back-navigation.
 *
 * A custom @inquirer/core text prompt (with an optional masked variant)
 * that resolves the BACK sentinel when the user presses Backspace while
 * the input buffer is ALREADY empty — the intuitive "backspace out of an
 * empty field to go back a step" UX. Otherwise it behaves like a normal
 * single-line input: readline owns the buffer; we sync + render.
 *
 * Why a custom prompt: the stock `@inquirer/prompts` input() exposes only
 * the final value — no keypress hooks. `@inquirer/core` (already used by
 * cli/v4/aidenPrompt.ts) gives `useKeypress`. Menu steps keep a visible
 * "← Back" choice instead; backspace's win is text fields, where the
 * mistyped-key friction actually lives.
 *
 * Key disambiguation: readline applies the deletion BEFORE the keypress
 * handler runs, so the post-state `rl.line === ''` is ambiguous (was the
 * field already empty, or did we just delete the last char?). We track
 * the PRIOR buffer in `prevLineRef`; if it was already empty when
 * Backspace arrives, that's a back request. UX: backspace on an empty
 * field — or one extra backspace past the start — goes back.
 */
import {
  createPrompt,
  useState,
  useKeypress,
  useRef,
  usePrefix,
  isEnterKey,
  isBackspaceKey,
  makeTheme,
  type Theme,
} from '@inquirer/core';

/** Resolved (instead of a string) when the user backspaces out of an empty field. */
export const BACK: unique symbol = Symbol('aiden.wizard.back');
export type BackSentinel = typeof BACK;

export interface BackNavInputConfig {
  message:  string;
  default?: string;
  mask?:    boolean;
}

/** Minimal keypress shape `isBackspaceKey` inspects — keeps the pure fn testable. */
export interface KeypressLike {
  name?:  string;
  ctrl?:  boolean;
  meta?:  boolean;
  shift?: boolean;
}

/**
 * Pure decision: should this keystroke trigger back-navigation, given the
 * buffer state BEFORE the key was applied? Extracted so the back trigger
 * is unit-testable without a TTY; the keypress WIRING itself is covered by
 * manual smoke (the value-returning test harness can't simulate keys).
 */
export function shouldGoBack(prevLine: string, key: KeypressLike): boolean {
  return prevLine.length === 0 && isBackspaceKey(key as never);
}

export const backNavInput = createPrompt<string | BackSentinel, BackNavInputConfig>(
  (config, done) => {
    const theme = makeTheme<Theme>({}, undefined);
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [value, setValue] = useState('');
    // Snapshot of the buffer BEFORE the current keystroke — readline
    // pre-applies edits, so we compare against this to tell "backspace on
    // empty" apart from "backspace deleted the last char".
    const prevLineRef = useRef('');
    const prefix = usePrefix({ status, theme });

    useKeypress((key, rl) => {
      if (status !== 'idle') return;

      if (isEnterKey(key)) {
        const final = rl.line.length > 0 ? rl.line : (config.default ?? '');
        setValue(final);
        setStatus('done');
        done(final);
        return;
      }

      if (shouldGoBack(prevLineRef.current, key)) {
        setStatus('done');
        done(BACK);
        return;
      }

      // Normal edit — readline already mutated rl.line. Sync + remember.
      prevLineRef.current = rl.line;
      setValue(rl.line);
    });

    const message = theme.style.message(config.message, status);

    if (status === 'done') {
      // Never echo a masked answer back.
      return config.mask ? `${prefix} ${message}` : `${prefix} ${message} ${theme.style.answer(value)}`;
    }

    const body = config.mask ? '*'.repeat(value.length) : value;
    const defaultHint =
      !value && config.default ? ` ${theme.style.help(`(${config.default})`)}` : '';
    const main = `${prefix} ${message} ${body}${defaultHint}`;
    // Discoverable back affordance — shown (dim, bottom line) only while
    // the buffer is empty, which is exactly when Backspace goes back.
    // Disappears once the user types, where Backspace deletes normally.
    // Matches the muted hint style used by the approval footer.
    const backHint = value.length === 0 ? theme.style.help('backspace to go back') : '';
    return [main, backHint];
  },
);
