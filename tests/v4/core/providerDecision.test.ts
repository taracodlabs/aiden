/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase 6 — the provider decision trace: explicit-vs-default classification,
 * durable (out-of-process) round-trip incl. the fallback reason + fix command,
 * and the honest describeOrigin wording.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeProviderDecision,
  readProviderDecision,
  isExplicitSource,
  describeOrigin,
  type ProviderDecision,
} from '../../../core/v4/providerDecision';
import type { AidenPaths } from '../../../core/v4/paths';

function tmpPaths(): AidenPaths {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiden-decision-'));
  return { root } as unknown as AidenPaths;   // only `.root` is read by write/read
}

describe('providerDecision — explicit vs default source', () => {
  it('only CLI flags count as explicit', () => {
    expect(isExplicitSource('cli-flag')).toBe(true);
    expect(isExplicitSource('cli-flag-partial')).toBe(true);
    expect(isExplicitSource('persisted-config')).toBe(false);
    expect(isExplicitSource('config-partial')).toBe(false);
    expect(isExplicitSource('auto-priority')).toBe(false);
    expect(isExplicitSource('hardcoded-fallback')).toBe(false);
  });
});

describe('providerDecision — durable round-trip (readable out-of-process)', () => {
  it('write then read returns the same decision, incl. the fallback reason + fix command', () => {
    const paths = tmpPaths();
    const decision: ProviderDecision = {
      provider: 'groq',
      model:    'llama-3.3-70b-versatile',
      source:   'persisted-config',
      requestedProvider: 'chatgpt-plus',
      requestedExplicit: false,
      fallbackReason: 'OAuth token for chatgpt-plus is expired. Run `/auth refresh chatgpt-plus`.',
      attempts: [
        { providerId: 'chatgpt-plus', ok: false, reason: 'expired' },
        { providerId: 'groq', ok: true },
      ],
    };
    writeProviderDecision(paths, decision);
    const read = readProviderDecision(paths);
    expect(read).toEqual(decision);
    // The fix command survives to disk — a later `aiden doctor` can show it.
    expect(read?.fallbackReason).toContain('/auth refresh chatgpt-plus');
  });

  it('absent decision file → null', () => {
    expect(readProviderDecision(tmpPaths())).toBeNull();
  });
});

describe('providerDecision — describeOrigin (honest wording)', () => {
  it('no fallback → just where the pick came from', () => {
    expect(describeOrigin({
      provider: 'ollama', model: 'llama3.2', source: 'cli-flag',
      requestedExplicit: true, attempts: [{ providerId: 'ollama', ok: true }],
    })).toBe('from --provider/--model');
  });

  it('an EXPLICIT --provider failure says "you asked for X" + reason + "fell back" — never "default"', () => {
    const s = describeOrigin({
      provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'cli-flag',
      requestedProvider: 'ollama', requestedExplicit: true,
      fallbackReason: "Model 'gemma4:e4b' not found for provider 'ollama'.",
      attempts: [],
    });
    expect(s).toContain('you asked for ollama');
    expect(s).toContain("Model 'gemma4:e4b' not found");
    expect(s).toContain('fell back to chatgpt-plus');
    expect(s).not.toContain('previous default');
  });

  it('a non-explicit (config/auto) failure reads "X unavailable", not "you asked for"', () => {
    const s = describeOrigin({
      provider: 'groq', model: 'llama-3.3-70b-versatile', source: 'persisted-config',
      requestedProvider: 'chatgpt-plus', requestedExplicit: false,
      fallbackReason: 'expired', attempts: [],
    });
    expect(s).toContain('chatgpt-plus unavailable');
    expect(s).not.toContain('you asked for');
  });
});
