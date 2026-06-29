/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/toolProfiles.test.ts — v4.11 toolset grouping
 *
 * Covers:
 *   - parseProfileName accepts canonical names (case-insensitive,
 *     trimmed) and rejects everything else.
 *   - resolveProfileToolsets returns the expected list per profile,
 *     honours `custom` override, and falls back to standard on
 *     empty/malformed custom.
 *   - resolveBootProfile precedence: env > config > default.
 *   - Every registered tool has a `toolset` tag (audit gap from
 *     Phase A — closes the 7 untagged ui_* tools).
 *   - Built-in profiles resolve to a non-empty schema list against
 *     the live registry.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_NAME,
  PROFILE_NAMES,
  parseProfileName,
  resolveBootProfile,
  resolveProfileToolsets,
} from '../../core/v4/toolProfiles';
import { ToolRegistry } from '../../core/v4/toolRegistry';
import { registerAllTools } from '../../tools/v4';

describe('toolProfiles — parseProfileName', () => {
  it('accepts canonical names', () => {
    expect(parseProfileName('minimal')).toBe('minimal');
    expect(parseProfileName('standard')).toBe('standard');
    expect(parseProfileName('full')).toBe('full');
    expect(parseProfileName('custom')).toBe('custom');
  });

  it('is case-insensitive + trims whitespace', () => {
    expect(parseProfileName('  MINIMAL ')).toBe('minimal');
    expect(parseProfileName('Standard\n')).toBe('standard');
  });

  it('rejects unknown / empty / non-string input', () => {
    expect(parseProfileName('')).toBeUndefined();
    expect(parseProfileName('verbose')).toBeUndefined();
    expect(parseProfileName(undefined)).toBeUndefined();
    expect(parseProfileName(null)).toBeUndefined();
    expect(parseProfileName(42)).toBeUndefined();
    expect(parseProfileName({})).toBeUndefined();
  });
});

describe('toolProfiles — resolveProfileToolsets', () => {
  it('returns undefined for `full` (= no filter)', () => {
    expect(resolveProfileToolsets('full', undefined)).toBeUndefined();
  });

  it('returns the minimal list', () => {
    const ts = resolveProfileToolsets('minimal', undefined);
    expect(ts).toBeDefined();
    expect(ts).toContain('files');
    expect(ts).toContain('terminal');
    expect(ts).toContain('web');
    expect(ts).not.toContain('subagent');   // standard-only
    expect(ts).not.toContain('browser');    // standard-only
  });

  it('standard ⊇ minimal', () => {
    const minimal  = new Set(resolveProfileToolsets('minimal',  undefined) ?? []);
    const standard = new Set(resolveProfileToolsets('standard', undefined) ?? []);
    for (const t of minimal) expect(standard.has(t)).toBe(true);
    expect(standard.size).toBeGreaterThan(minimal.size);
  });

  it('uses custom list when provided', () => {
    const out = resolveProfileToolsets('custom', ['files', 'web']);
    expect(out).toEqual(['files', 'web']);
  });

  it('dedupes custom entries', () => {
    const out = resolveProfileToolsets('custom', ['files', 'files', 'web']);
    expect(out).toEqual(['files', 'web']);
  });

  it('falls back to standard when custom is empty/malformed', () => {
    // Empty array → falls back to standard's list.
    const standardList = resolveProfileToolsets('standard', undefined);
    expect(resolveProfileToolsets('custom', [])).toEqual(standardList);
    expect(resolveProfileToolsets('custom', undefined)).toEqual(standardList);
  });
});

describe('toolProfiles — resolveBootProfile precedence', () => {
  it('env wins over config + default', () => {
    const r = resolveBootProfile('minimal', 'full', undefined);
    expect(r.name).toBe('minimal');
    expect(r.source).toBe('env');
  });

  it('config wins when env is unset / invalid', () => {
    const r = resolveBootProfile(undefined, 'minimal', undefined);
    expect(r.name).toBe('minimal');
    expect(r.source).toBe('config');
  });

  it('config wins when env is a malformed string', () => {
    const r = resolveBootProfile('garbage', 'full', undefined);
    expect(r.name).toBe('full');
    expect(r.source).toBe('config');
  });

  it('falls back to DEFAULT_PROFILE_NAME when both unset', () => {
    const r = resolveBootProfile(undefined, undefined, undefined);
    expect(r.name).toBe(DEFAULT_PROFILE_NAME);
    expect(r.source).toBe('default');
  });

  it('`full` profile carries toolsets=undefined', () => {
    const r = resolveBootProfile('full', undefined, undefined);
    expect(r.toolsets).toBeUndefined();
  });

  it('`minimal` profile carries the minimal toolset list', () => {
    const r = resolveBootProfile('minimal', undefined, undefined);
    expect(r.toolsets).toBeDefined();
    expect(r.toolsets).toContain('files');
  });
});

describe('toolProfiles — live registry integration', () => {
  it('every registered tool has a toolset tag (audit gap closed)', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const untagged: string[] = [];
    for (const name of registry.list()) {
      const handler = registry.get(name);
      if (!handler?.toolset) untagged.push(name);
    }
    expect(untagged, `Untagged tools: ${untagged.join(', ')}`).toEqual([]);
  });

  it('every built-in profile resolves to a non-empty schema list', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    for (const name of PROFILE_NAMES) {
      const def    = BUILT_IN_PROFILES[name];
      const filter = def.toolsets === null ? undefined : [...def.toolsets];
      const schemas = registry.getSchemas(filter, 'repl');
      expect(schemas.length, `${name} produced 0 schemas`).toBeGreaterThan(0);
    }
  });

  it('minimal profile is strictly smaller than full', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const minimalFilter = [...(BUILT_IN_PROFILES.minimal.toolsets ?? [])];
    const minimal = registry.getSchemas(minimalFilter, 'repl');
    const full    = registry.getSchemas(undefined,     'repl');
    expect(minimal.length).toBeGreaterThan(0);
    expect(minimal.length).toBeLessThan(full.length);
  });

  it('standard profile lies between minimal and full', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const min  = registry.getSchemas([...(BUILT_IN_PROFILES.minimal.toolsets  ?? [])], 'repl');
    const std  = registry.getSchemas([...(BUILT_IN_PROFILES.standard.toolsets ?? [])], 'repl');
    const full = registry.getSchemas(undefined, 'repl');
    expect(std.length).toBeGreaterThanOrEqual(min.length);
    expect(std.length).toBeLessThanOrEqual(full.length);
  });
});
