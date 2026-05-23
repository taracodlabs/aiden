/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.2 SLICE 3 — confirm primitive behaviour coverage.
 *
 * Tests the extracted `runConfirm` helper (cli/v4/confirmPrompt.ts).
 * No mocks for rendering — the helper is pure-logic around a stubbed
 * promptApi.readLine and a captured display. We're asserting the
 * BEHAVIOR contract (return value + emitted cancellation reason),
 * not a snapshot of internal rendering (Slice 2's mock-blindness
 * lesson).
 */
import { describe, it, expect, vi } from 'vitest';
import { runConfirm, type ConfirmPromptApi, type ConfirmDisplay } from '../../../cli/v4/confirmPrompt';

interface ScriptedRun {
  scripted:           string | null | undefined;
  capturedPrompt?:    string;
  capturedOpts?:      { suggestionsDisabled?: boolean };
  dimLines:           string[];
  promptApi:          ConfirmPromptApi;
  display:            ConfirmDisplay;
}

function makeHarness(scripted: string | null | undefined): ScriptedRun {
  const dimLines: string[] = [];
  const run: ScriptedRun = {
    scripted,
    dimLines,
    promptApi: {
      async readLine(prompt, opts) {
        run.capturedPrompt = prompt;
        run.capturedOpts   = opts;
        return scripted as string;
      },
    },
    display: {
      // The warn paint is irrelevant for behavior tests; return a
      // recognisable marker so we can assert the glyph reached the
      // decorated prompt.
      paint: (text, kind) => `<paint:${kind}>${text}</paint>`,
      dim:   (s) => { dimLines.push(s); },
    },
  };
  return run;
}

describe('runConfirm — decorated prompt assembly', () => {
  it('appends canonical " (y/N) " when caller passes a bare message', async () => {
    const h = makeHarness('y');
    await runConfirm('Take over Telegram polling?', h.promptApi, h.display);
    expect(h.capturedPrompt).toMatch(/Take over Telegram polling\? \(y\/N\) $/);
  });

  it('strips a caller-appended " (y/N) " and re-appends canonical form (no duplication)', async () => {
    const h = makeHarness('y');
    await runConfirm('Delete cron job? (y/N) ', h.promptApi, h.display);
    // Must not produce " (y/N)  (y/N)".
    expect(h.capturedPrompt).toMatch(/Delete cron job\? \(y\/N\) $/);
    expect(h.capturedPrompt).not.toContain('(y/N) (y/N)');
  });

  it('strips a caller-appended " [y/N] " (bracket variant) and re-appends canonical form', async () => {
    const h = makeHarness('y');
    await runConfirm('Install with permissions? [y/N] ', h.promptApi, h.display);
    expect(h.capturedPrompt).toMatch(/Install with permissions\? \(y\/N\) $/);
    expect(h.capturedPrompt).not.toContain('[y/N]');
  });

  it('prefixes the warn-tinted "?" glyph so the confirm chrome is visually distinct', async () => {
    const h = makeHarness('y');
    await runConfirm('Question?', h.promptApi, h.display);
    // The paint helper marker we wired in the harness — confirms warn
    // was the requested kind.
    expect(h.capturedPrompt!.startsWith('<paint:warn>?</paint> ')).toBe(true);
  });

  it('passes suggestionsDisabled:true so the inquirer-input path runs (no ghost-match)', async () => {
    const h = makeHarness('y');
    await runConfirm('msg', h.promptApi, h.display);
    expect(h.capturedOpts).toEqual({ suggestionsDisabled: true });
  });
});

describe('runConfirm — acceptance', () => {
  it('"y" → true', async () => {
    const h = makeHarness('y');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(true);
    expect(h.dimLines).toEqual([]);  // no cancellation message on accept
  });
  it('"Y" → true (case-insensitive)', async () => {
    const h = makeHarness('Y');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(true);
  });
  it('"yes" → true', async () => {
    const h = makeHarness('yes');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(true);
  });
  it('"  yes  " → true (whitespace tolerated)', async () => {
    const h = makeHarness('  yes  ');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(true);
  });
});

describe('runConfirm — per-input cancellation reasons', () => {
  it('empty string → false with the "press y to confirm" hint', async () => {
    const h = makeHarness('');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual([`Cancelled (press 'y' to confirm; Enter alone = no).`]);
  });

  it('whitespace-only → false with the "press y" hint (treated as empty)', async () => {
    const h = makeHarness('   ');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual([`Cancelled (press 'y' to confirm; Enter alone = no).`]);
  });

  it('"n" → false with bare "Cancelled." (deliberate decline — no extra hint)', async () => {
    const h = makeHarness('n');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual(['Cancelled.']);
  });

  it('"no" → false with bare "Cancelled."', async () => {
    const h = makeHarness('no');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual(['Cancelled.']);
  });

  it('"NO" → false with bare "Cancelled." (case-insensitive deliberate decline)', async () => {
    const h = makeHarness('NO');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual(['Cancelled.']);
  });

  it('unrecognised input ("blah") → false with the "not recognized" hint', async () => {
    const h = makeHarness('blah');
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual([
      `Cancelled ("blah" not recognized — expected y/yes/n/no).`,
    ]);
  });

  it('non-string return (null) → false with the "no input" reason', async () => {
    const h = makeHarness(null);
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual(['Cancelled (no input).']);
  });

  it('non-string return (undefined) → false with the "no input" reason', async () => {
    const h = makeHarness(undefined);
    expect(await runConfirm('m', h.promptApi, h.display)).toBe(false);
    expect(h.dimLines).toEqual(['Cancelled (no input).']);
  });
});

describe('runConfirm — caller no longer needs its own Cancelled line', () => {
  it('emits exactly one dim line on rejection (callers should NOT print extra)', async () => {
    // This is the contract change Slice 3 enforces. If a future
    // caller adds a redundant `display.dim('Cancelled.')` after a
    // false return, the user will see a doubled-up cancellation.
    // Test guards against the primitive emitting MORE than one line.
    const cases = ['', 'n', 'no', 'blah'];
    for (const input of cases) {
      const h = makeHarness(input);
      await runConfirm('m', h.promptApi, h.display);
      expect(h.dimLines).toHaveLength(1);
    }
  });
});

describe('runConfirm — does not call paint twice or leak the marker into the input', () => {
  it('the scripted "y" answer does not include the warn-paint marker (asserts the marker is in the PROMPT, not the response)', async () => {
    const paint = vi.fn((text: string, kind: string) => `[${kind}]${text}[/]`);
    const h = makeHarness('y');
    h.display = { paint, dim: () => {} };
    await runConfirm('m', h.promptApi, h.display);
    // Exactly one paint call for the glyph; the response 'y' isn't
    // painted — it's user input echoed by inquirer, not our code.
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveBeenCalledWith('?', 'warn');
  });
});
