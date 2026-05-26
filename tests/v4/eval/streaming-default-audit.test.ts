/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.9 — streaming-default audit.
 *
 * Slice 10.9 Phase A audit caught a multi-version bug: since v4.0,
 * `DEFAULT_CONFIG.display.streaming` was `false`. The setup wizard
 * spreads `...DEFAULT_CONFIG.display` into the config.yaml it writes,
 * so every wizard install baked `streaming: false` into the user's
 * config. Users reported "Aiden feels slow" because they were
 * waiting on full provider responses with no visible feedback —
 * traced back via the Slice 10.6c perf diagnosis pass.
 *
 * Slice 10.9 flips the default to `true` AND adds a one-time per-
 * session disclosure in chatSession.ts when the running config still
 * has `streaming: false` (existing-user respect path; the user has
 * to actively flip their setting, with the warning as the consent
 * surface).
 *
 * This file pins both:
 *   1. `DEFAULT_CONFIG.display.streaming === true` — a future
 *      refactor that flips it back to `false` (or drops the key)
 *      fails here. The wizard writes from this constant, so the
 *      assertion guards the entire downstream perception.
 *   2. The chatSession.ts warning emission logic — a future refactor
 *      that removes the disclosure (or fires it every turn instead
 *      of once per session) fails the source-contract guard.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../../../core/v4/config';

describe('streaming default — DEFAULT_CONFIG pin (Slice 10.9)', () => {
  it('DEFAULT_CONFIG.display.streaming is true (the v4.10 flip)', () => {
    expect(DEFAULT_CONFIG.display.streaming).toBe(true);
  });

  it('source-contract guard — config.ts DEFAULT_CONFIG sets streaming: true', async () => {
    // Pin the source-level shape too. A future refactor that
    // restructures DEFAULT_CONFIG via a builder or a different
    // module could pass the constant-import assertion above while
    // baking `false` into the wizard's written file via some other
    // path. The literal `streaming: true` in the config.ts source
    // is the canonical setting.
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../core/v4/config.ts'),
      'utf8',
    );
    // Match `streaming: true` inside the display block. The positive
    // shape is the canonical check; we don't add a negative
    // `not.toMatch /streaming:\s*false/` because the historical
    // commentary in config.ts intentionally quotes the prior
    // `streaming: false` value in `\`backticks\`` to explain why the
    // flip happened. A naive negative regex would fail on the doc
    // string. The imported-constant assertion in the prior test
    // case (DEFAULT_CONFIG.display.streaming === true) is the
    // canonical runtime guard.
    expect(src).toMatch(/streaming:\s*true/);
  });
});

describe('streaming disabled warning — chatSession.ts source-contract guard (Slice 10.9)', () => {
  it('chatSession.runAgentTurn emits a one-shot dim warning when streaming is disabled', async () => {
    // The disclosure has to fire AT MOST ONCE per chat session
    // (not per turn) so users see it predictably. The implementation
    // uses an instance-level flag `streamingDisabledWarned`. A
    // refactor that drops the flag — making the warning fire every
    // turn or never — should fail this guard.
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/chatSession.ts'),
      'utf8',
    );

    // Flag declaration present.
    expect(src).toMatch(/streamingDisabledWarned\s*=\s*false/);

    // The check uses both !streamingEnabled AND !this.streamingDisabledWarned —
    // catches a regression that drops either condition.
    expect(src).toMatch(/!streamingEnabled\s*&&\s*!this\.streamingDisabledWarned/);

    // Flag flips to true (one-shot) + the dim() disclosure message
    // mentions `display.streaming` so the user knows what to flip.
    expect(src).toMatch(/this\.streamingDisabledWarned\s*=\s*true/);
    expect(src).toMatch(/display\.streaming.*true/);
  });

  it('warning includes user-actionable guidance (set display.streaming: true)', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/chatSession.ts'),
      'utf8',
    );
    // The disclosure must mention the exact config key + the value
    // to set — vague "enable streaming" wouldn't tell the user
    // where to go. Pattern-absorbed from Slice 10.7's
    // `/channel telegram remove` shell-env hint.
    expect(src).toMatch(/display\.streaming:\s*true.*config\.yaml/);
  });
});
