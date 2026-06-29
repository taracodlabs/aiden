/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.11 — isWeakModel predicate + boot-wire proof that weak models get a
 * tool catalog with NO ui_* tools (the cause-level fix for the UI-leak
 * class) while strong models keep them.
 */
import { describe, it, expect } from 'vitest';

import { isWeakModel } from '../../../core/v4/modelCapability';
import { shouldInjectUiEventsGuidance } from '../../../core/v4/promptBuilder';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4/index';
import { BUILT_IN_PROFILES } from '../../../core/v4/toolProfiles';

const STANDARD_TOOLSETS = BUILT_IN_PROFILES.standard.toolsets ?? [];

describe('isWeakModel', () => {
  it('flags the known leak-prone instruct families', () => {
    for (const id of [
      'llama-3.3-70b-versatile',   // groq default — the canonical leak source
      'llama-3.1-8b-instant',
      'meta-llama/Llama-3.2-3B',
      'mistral-large-latest',
      'google/gemma-2-9b-it',
      'qwen2.5-7b-instruct',
      'phi-3-mini',
    ]) {
      expect(isWeakModel(id), id).toBe(true);
    }
  });

  it('treats capable models (and unknown/undefined) as NOT weak', () => {
    for (const id of [
      'claude-opus-4-8',
      'deepseek-v4-pro',
      'gpt-5.4',
      'qwen3-32b',
      'llama-4-scout',             // llama-4 is not in the 3.x leak band
    ]) {
      expect(isWeakModel(id), id).toBe(false);
    }
    expect(isWeakModel(undefined)).toBe(false);
    expect(isWeakModel('')).toBe(false);
  });

  it('shouldInjectUiEventsGuidance is the exact inverse (one source of truth)', () => {
    for (const id of ['llama-3.3-70b-versatile', 'claude-opus-4-8', undefined]) {
      expect(shouldInjectUiEventsGuidance(id)).toBe(!isWeakModel(id));
    }
  });
});

describe('boot-wire: weak model → no ui_* in catalog', () => {
  function catalogFor(modelId: string | undefined): string[] {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    // Mirrors the REPL catalog assembly at cli/v4/aidenCLI.ts (getSchemas
    // with the weak-model ui strip).
    return registry
      .getSchemas(
        [...STANDARD_TOOLSETS],
        'repl',
        isWeakModel(modelId) ? ['ui'] : undefined,
      )
      .map((s) => s.name);
  }

  it('weak model: catalog contains zero ui_* tools', () => {
    const names = catalogFor('llama-3.3-70b-versatile');
    expect(names.filter((n) => n.startsWith('ui_'))).toEqual([]);
    // sanity: the strip didn't nuke everything — real tools remain.
    expect(names.length).toBeGreaterThan(5);
  });

  it('strong model: catalog still contains the ui_* tools', () => {
    const names = catalogFor('claude-opus-4-8');
    expect(names).toContain('ui_task_update');
    expect(names).toContain('ui_toast');
  });
});
