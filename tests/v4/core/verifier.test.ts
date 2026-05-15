/**
 * v4.2 Phase 1 — Verifier unit tests.
 *
 * Coverage:
 *   1. defaultVerifier handles 5 result shapes:
 *      - outer envelope error → failed
 *      - inner success:false → failed
 *      - inner success:true → ok
 *      - raw string ≥ 50 chars without error keywords → ok (conf 0.7)
 *      - raw string with "error" keywords in head → failed (conf 0.6)
 *      - raw string < 50 chars → low_signal (conf 0.4, ok:true)
 *
 *   2. 5 built-in per-tool verifiers each:
 *      - shellExecVerifier: exit 0 with stdout = ok / non-zero = failed
 *      - webSearchVerifier: short/empty result = low_signal
 *      - fileWriteVerifier: bytesWritten:0 = low_signal
 *      - fileReadVerifier: empty content = low_signal
 *      - webFetchVerifier: < 100 char body = low_signal
 *
 *   3. VerifierRegistry: override resolution + fallback to default
 *      for unknown tools.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultVerifier,
  shellExecVerifier,
  webSearchVerifier,
  fileWriteVerifier,
  fileReadVerifier,
  webFetchVerifier,
  VerifierRegistry,
  buildDefaultRegistry,
} from '../../../core/v4/verifier';
import type { ToolCallResult } from '../../../providers/v4/types';

function mkResult(over: Partial<ToolCallResult> = {}): ToolCallResult {
  return {
    id: 't1',
    name: 'tool',
    result: null,
    ...over,
  };
}

describe('defaultVerifier', () => {
  it('flags outer-envelope errors as failed', () => {
    const v = defaultVerifier('any', {}, mkResult({ error: 'executor threw' }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
    expect(v.confidence).toBe(1.0);
    expect(v.reason).toBe('executor threw');
  });

  it('flags inner success:false as failed', () => {
    const v = defaultVerifier('any', {}, mkResult({ result: { success: false, error: 'bad input' } }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
    expect(v.confidence).toBe(1.0);
    expect(v.reason).toBe('bad input');
  });

  it('flags inner success:true as ok', () => {
    const v = defaultVerifier('any', {}, mkResult({ result: { success: true, content: 'hi' } }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
    expect(v.confidence).toBe(1.0);
  });

  it('flags long raw string without error keywords as ok at conf 0.7', () => {
    const longText = 'A'.repeat(200);
    const v = defaultVerifier('any', {}, mkResult({ result: longText }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
    expect(v.confidence).toBe(0.7);
  });

  it('flags short raw string as low_signal', () => {
    const v = defaultVerifier('any', {}, mkResult({ result: 'short' }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
    expect(v.confidence).toBe(0.4);
  });

  it('flags empty string as low_signal', () => {
    const v = defaultVerifier('any', {}, mkResult({ result: '' }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
    expect(v.reason).toMatch(/empty/);
  });

  it('flags raw string with "error" keyword head as failed', () => {
    const v = defaultVerifier('any', {}, mkResult({ result: 'Error: connection refused while contacting service' }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
    expect(v.confidence).toBe(0.6);
  });

  it('flags object without success field as ok at conf 0.7', () => {
    const v = defaultVerifier('any', {}, mkResult({ result: { content: 'data', size: 42 } }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
    expect(v.confidence).toBe(0.7);
  });

  it('flags null result as unknown', () => {
    const v = defaultVerifier('any', {}, mkResult({ result: null }));
    expect(v.code).toBe('unknown');
    expect(v.confidence).toBe(0.5);
  });
});

describe('shellExecVerifier', () => {
  it('passes exit 0 with stdout', () => {
    const v = shellExecVerifier('shell_exec', {}, mkResult({
      result: { exitCode: 0, stdout: 'hello world', stderr: '' },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('flags non-zero exit as failed', () => {
    const v = shellExecVerifier('shell_exec', {}, mkResult({
      result: { exitCode: 1, stdout: '', stderr: 'command not found' },
    }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
    expect(v.reason).toMatch(/non-zero exit/);
    expect(v.suggestion).toBeDefined();
  });

  it('flags exit 0 with empty stdout as low_signal', () => {
    const v = shellExecVerifier('shell_exec', {}, mkResult({
      result: { exitCode: 0, stdout: '', stderr: '' },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
    expect(v.confidence).toBe(0.4);
  });

  it('handles outer envelope errors', () => {
    const v = shellExecVerifier('shell_exec', {}, mkResult({ error: 'spawn failed' }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
  });

  it('flags typed-failure envelope without exitCode as failed', () => {
    const v = shellExecVerifier('shell_exec', {}, mkResult({
      result: { success: false, error: 'wrapper preempted exec' },
    }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
    expect(v.reason).toBe('wrapper preempted exec');
  });

  it('trusts success:true when exitCode missing', () => {
    const v = shellExecVerifier('shell_exec', {}, mkResult({
      result: { success: true, stdout: 'ran' },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
    expect(v.confidence).toBe(0.7);
  });
});

describe('webSearchVerifier', () => {
  it('passes long results', () => {
    const v = webSearchVerifier('web_search', {}, mkResult({
      result: 'A'.repeat(200),
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('flags empty result as low_signal', () => {
    const v = webSearchVerifier('web_search', {}, mkResult({ result: '' }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
    expect(v.suggestion).toBeDefined();
  });

  it('flags short result as low_signal', () => {
    const v = webSearchVerifier('web_search', {}, mkResult({ result: 'no hits' }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
  });

  it('handles outer envelope errors', () => {
    const v = webSearchVerifier('web_search', {}, mkResult({ error: 'network unreachable' }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
  });

  it('falls back to default for non-string results', () => {
    const v = webSearchVerifier('web_search', {}, mkResult({
      result: { success: true, hits: ['a', 'b'] },
    }));
    expect(v.ok).toBe(true);
  });
});

describe('fileWriteVerifier', () => {
  it('passes a normal write', () => {
    const v = fileWriteVerifier('file_write', {}, mkResult({
      result: { success: true, path: '/tmp/foo', bytesWritten: 42 },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('flags bytesWritten:0 as low_signal', () => {
    const v = fileWriteVerifier('file_write', {}, mkResult({
      result: { success: true, path: '/tmp/foo', bytesWritten: 0 },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
  });

  it('flags success:false as failed', () => {
    const v = fileWriteVerifier('file_write', {}, mkResult({
      result: { success: false, error: 'permission denied' },
    }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
    expect(v.reason).toBe('permission denied');
  });
});

describe('fileReadVerifier', () => {
  it('passes a normal read', () => {
    const v = fileReadVerifier('file_read', {}, mkResult({
      result: { success: true, content: 'hello' },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('flags empty content as low_signal', () => {
    const v = fileReadVerifier('file_read', {}, mkResult({
      result: { success: true, content: '' },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
  });

  it('flags success:false as failed', () => {
    const v = fileReadVerifier('file_read', {}, mkResult({
      result: { success: false, error: 'not found' },
    }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
  });
});

describe('webFetchVerifier', () => {
  it('passes a string body ≥ 100 chars', () => {
    const v = webFetchVerifier('web_fetch', {}, mkResult({
      result: 'A'.repeat(200),
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('flags a short string body as low_signal', () => {
    const v = webFetchVerifier('web_fetch', {}, mkResult({
      result: 'tiny',
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
  });

  it('passes a typed object with substantive content', () => {
    const v = webFetchVerifier('web_fetch', {}, mkResult({
      result: { success: true, content: 'A'.repeat(200) },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('flags typed object with short body as low_signal', () => {
    const v = webFetchVerifier('web_fetch', {}, mkResult({
      result: { success: true, content: 'tiny' },
    }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('low_signal');
  });

  it('flags typed object with success:false as failed', () => {
    const v = webFetchVerifier('web_fetch', {}, mkResult({
      result: { success: false, error: '404' },
    }));
    expect(v.ok).toBe(false);
    expect(v.code).toBe('failed');
  });
});

describe('VerifierRegistry', () => {
  it('falls back to default for unregistered tools', () => {
    const reg = new VerifierRegistry();
    const fn  = reg.resolve('totally_unknown_tool');
    const v   = fn('totally_unknown_tool', {}, mkResult({ result: { success: true } }));
    expect(v.ok).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('resolves registered overrides', () => {
    const reg = new VerifierRegistry();
    const custom = (_n: string, _a: unknown, _r: ToolCallResult) => ({
      ok: false,
      confidence: 0.99,
      code: 'failed' as const,
      reason: 'custom verifier',
    });
    reg.register('my_tool', custom);
    expect(reg.hasOverride('my_tool')).toBe(true);
    const v = reg.resolve('my_tool')('my_tool', {}, mkResult());
    expect(v.reason).toBe('custom verifier');
  });

  it('buildDefaultRegistry wires all 5 built-ins + 2 aliases', () => {
    const reg = buildDefaultRegistry();
    expect(reg.hasOverride('shell_exec')).toBe(true);
    expect(reg.hasOverride('web_search')).toBe(true);
    expect(reg.hasOverride('file_write')).toBe(true);
    expect(reg.hasOverride('file_read')).toBe(true);
    expect(reg.hasOverride('web_fetch')).toBe(true);
    expect(reg.hasOverride('fetch_page')).toBe(true);
    expect(reg.hasOverride('web_page')).toBe(true);
    expect(reg.hasOverride('totally_unknown')).toBe(false);
  });
});
