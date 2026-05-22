/**
 * tests/v4/identity/enforcement.test.ts — v4.9.0 Slice 8.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEnforcementMode,
  reportMissingContext,
  ContextMissingError,
  getContextMissingCounter,
  _resetContextMissingCountersForTests,
} from '../../../core/v4/identity';

let prev: Record<string, string | undefined>;

beforeEach(() => {
  prev = {
    AIDEN_CONTEXT_ENFORCEMENT:                process.env.AIDEN_CONTEXT_ENFORCEMENT,
    AIDEN_CONTEXT_ENFORCEMENT_TOOL:           process.env.AIDEN_CONTEXT_ENFORCEMENT_TOOL,
    AIDEN_CONTEXT_ENFORCEMENT_LLM:            process.env.AIDEN_CONTEXT_ENFORCEMENT_LLM,
    AIDEN_CONTEXT_ENFORCEMENT_HTTP_OUTBOUND:  process.env.AIDEN_CONTEXT_ENFORCEMENT_HTTP_OUTBOUND,
    AIDEN_CONTEXT_ENFORCEMENT_SUBPROCESS:     process.env.AIDEN_CONTEXT_ENFORCEMENT_SUBPROCESS,
  };
  _resetContextMissingCountersForTests();
});
afterEach(() => {
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

describe('enforcement — Slice 8', () => {
  it('default mode is warn', () => {
    delete process.env.AIDEN_CONTEXT_ENFORCEMENT;
    expect(getEnforcementMode('tool')).toBe('warn');
  });

  it('global env override applies to all kinds', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'silent';
    expect(getEnforcementMode('tool')).toBe('silent');
    expect(getEnforcementMode('llm')).toBe('silent');
    expect(getEnforcementMode('http_outbound')).toBe('silent');
  });

  it('per-kind override beats global', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'warn';
    process.env.AIDEN_CONTEXT_ENFORCEMENT_TOOL = 'strict';
    expect(getEnforcementMode('tool')).toBe('strict');
    expect(getEnforcementMode('llm')).toBe('warn');
  });

  it('invalid env value falls back to default', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'banana';
    expect(getEnforcementMode('tool')).toBe('warn');
  });

  it('silent mode: no throw, no warn, counter increments', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'silent';
    let warnCount = 0;
    expect(() => reportMissingContext('tool', 'shell_exec', { warn: () => { warnCount += 1; } })).not.toThrow();
    expect(warnCount).toBe(0);
    expect(getContextMissingCounter('tool')).toBe(1);
  });

  it('warn mode: no throw, warn fires, counter increments', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'warn';
    let warnMsg = '';
    expect(() => reportMissingContext('llm', 'gpt-5', { warn: (m) => { warnMsg = m; } })).not.toThrow();
    expect(warnMsg).toMatch(/llm missing context.*gpt-5/);
    expect(getContextMissingCounter('llm')).toBe(1);
  });

  it('strict mode: throws ContextMissingError with kind on the error', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'strict';
    try {
      reportMissingContext('subprocess', 'shell_exec');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ContextMissingError);
      expect((e as ContextMissingError).kind).toBe('subprocess');
      expect((e as Error).message).toMatch(/no ambient ExecutionContext/);
    }
    // Counter still increments in strict mode.
    expect(getContextMissingCounter('subprocess')).toBe(1);
  });

  it('warn-mode dedup: tight loop only logs once per 30s', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'warn';
    let warnCount = 0;
    for (let i = 0; i < 5; i += 1) {
      reportMissingContext('hook', `h${i}`, { warn: () => { warnCount += 1; } });
    }
    expect(warnCount).toBe(1);
    // Counter still tracks all 5.
    expect(getContextMissingCounter('hook')).toBe(5);
  });

  it('per-kind counters are independent', () => {
    process.env.AIDEN_CONTEXT_ENFORCEMENT = 'silent';
    reportMissingContext('tool');
    reportMissingContext('tool');
    reportMissingContext('llm');
    expect(getContextMissingCounter('tool')).toBe(2);
    expect(getContextMissingCounter('llm')).toBe(1);
    expect(getContextMissingCounter('subprocess')).toBe(0);
  });
});
