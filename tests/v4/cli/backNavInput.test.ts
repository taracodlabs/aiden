/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.11 — unit tests for the back-navigation decision (backspace-on-empty
 * → BACK). The pure `shouldGoBack` is the testable core; the keypress
 * WIRING into the live @inquirer/core prompt is covered by manual smoke
 * (a value-returning harness can't simulate raw keypresses).
 */
import { describe, it, expect } from 'vitest';

import { shouldGoBack, BACK } from '../../../cli/v4/onboarding/backNavInput';

const backspace = { name: 'backspace' };
const char = { name: 'a' };
const enter = { name: 'return' };

describe('shouldGoBack', () => {
  it('backspace with an empty prior buffer → go back', () => {
    expect(shouldGoBack('', backspace)).toBe(true);
  });

  it('backspace with a non-empty prior buffer → just delete (no back)', () => {
    expect(shouldGoBack('a', backspace)).toBe(false);
    expect(shouldGoBack('abc', backspace)).toBe(false);
  });

  it('non-backspace keys never trigger back, even on an empty buffer', () => {
    expect(shouldGoBack('', char)).toBe(false);
    expect(shouldGoBack('', enter)).toBe(false);
  });

  it('models the "delete to empty, then one more backspace" path', () => {
    // After deleting the last char the buffer is empty but the PRIOR
    // buffer had a char → not back. The NEXT backspace (prior empty) → back.
    expect(shouldGoBack('a', backspace)).toBe(false); // deletes 'a' → ''
    expect(shouldGoBack('', backspace)).toBe(true);   // backspace past start
  });

  it('BACK is a unique symbol sentinel (not a string a user could type)', () => {
    expect(typeof BACK).toBe('symbol');
    expect(BACK).not.toBe(':back');
  });
});
