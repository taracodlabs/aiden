/**
 * v4.2 Phase 2 — Failure classifier unit tests.
 *
 * Coverage:
 *   1. Each of the 10 generic FailureCategory values produced by the default
 *      classifier (the 2 v4.3 Phase 5 browser-specific values
 *      `stale_ref` + `manual_blocker` are only emitted by the per-tool
 *      browser classifiers — covered in tests/v4/core/browserClassifier.test.ts)
 *      classifier from canonical error strings.
 *   2. Priority ordering — timeout > rate_limit > auth > network >
 *      permission > invalid_input > dependency_missing > not_found.
 *   3. Hallucination heuristic — fires only when isFileReadFamily AND
 *      args contain the failed path verbatim.
 *   4. Per-tool overrides: shell_exec exit-code rules (124/126/127).
 *   5. FailureClassifier.classify() returns null for verifier-ok inputs.
 *   6. buildDefaultClassifier wires all expected overrides.
 *   7. Confidence scores: 0.9+ for explicit pattern hits, 0.6 for
 *      hallucination (narrow), 0.3 for fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultClassifier,
  shellExecClassifier,
  FailureClassifier,
  buildDefaultClassifier,
} from '../../../core/v4/failureClassifier';
import type { VerificationResult } from '../../../core/v4/verifier';
import type { ToolCallResult } from '../../../providers/v4/types';

function mkResult(over: Partial<ToolCallResult> = {}): ToolCallResult {
  return { id: 't1', name: 'tool', result: null, ...over };
}

function mkFailed(reason: string, code: VerificationResult['code'] = 'failed'): VerificationResult {
  return { ok: false, confidence: 1.0, code, reason };
}

function mkOk(): VerificationResult {
  return { ok: true, confidence: 1.0, code: 'ok' };
}

describe('defaultClassifier — 10 generic categories', () => {
  it('timeout: "Operation timed out"', () => {
    const c = defaultClassifier(mkFailed('Operation timed out after 30s'), 'shell_exec', {}, mkResult());
    expect(c.category).toBe('timeout');
    expect(c.recoverable).toBe(true);
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(c.recoveryHint?.action).toBe('retry_with_backoff');
  });

  it('timeout: ETIMEDOUT envelope', () => {
    const c = defaultClassifier(mkFailed('ETIMEDOUT'), 'web_fetch', {}, mkResult());
    expect(c.category).toBe('timeout');
  });

  it('rate_limit: "Rate limit exceeded"', () => {
    const c = defaultClassifier(mkFailed('Rate limit exceeded, try again in 30s'), 'web_search', {}, mkResult());
    expect(c.category).toBe('rate_limit');
    expect(c.recoverable).toBe(true);
  });

  it('rate_limit: 429 status string', () => {
    const c = defaultClassifier(mkFailed('429 Too Many Requests'), 'web_fetch', {}, mkResult());
    expect(c.category).toBe('rate_limit');
  });

  it('auth: "Unauthorized"', () => {
    const c = defaultClassifier(mkFailed('Unauthorized: invalid API key'), 'web_search', {}, mkResult());
    expect(c.category).toBe('auth');
    expect(c.recoverable).toBe(false);
    expect(c.recoveryHint?.action).toBe('request_user_action');
  });

  it('auth: 403 status', () => {
    const c = defaultClassifier(mkFailed('403 Forbidden'), 'web_fetch', {}, mkResult());
    expect(c.category).toBe('auth');
  });

  it('network: ECONNREFUSED', () => {
    const c = defaultClassifier(mkFailed('connect ECONNREFUSED 127.0.0.1:8080'), 'web_fetch', {}, mkResult());
    expect(c.category).toBe('network');
    expect(c.recoverable).toBe(true);
  });

  it('network: DNS failure', () => {
    const c = defaultClassifier(mkFailed('getaddrinfo ENOTFOUND example.invalid'), 'web_fetch', {}, mkResult());
    expect(c.category).toBe('network');
  });

  it('permission: "Access denied: protected path"', () => {
    const c = defaultClassifier(
      mkFailed('Access denied: protected path (credentials/keys/.env)'),
      'file_read', { path: '/foo/.env' }, mkResult(),
    );
    expect(c.category).toBe('permission');
    expect(c.recoverable).toBe(false);
    expect(c.recoveryHint?.action).toBe('surface_to_user');
  });

  it('permission: EACCES', () => {
    const c = defaultClassifier(mkFailed('EACCES: permission denied'), 'file_write', {}, mkResult());
    expect(c.category).toBe('permission');
  });

  it('invalid_input: "No path provided"', () => {
    const c = defaultClassifier(mkFailed('No path provided'), 'file_read', {}, mkResult());
    expect(c.category).toBe('invalid_input');
    expect(c.recoverable).toBe(true);
    expect(c.recoveryHint?.action).toBe('retry');
  });

  it('invalid_input: "is required"', () => {
    const c = defaultClassifier(mkFailed('`app` is required and must be non-empty.'), 'app_input', {}, mkResult());
    expect(c.category).toBe('invalid_input');
  });

  it('dependency_missing: "command not found"', () => {
    const c = defaultClassifier(mkFailed("bash: deno: command not found"), 'shell_exec', {}, mkResult());
    expect(c.category).toBe('dependency_missing');
    expect(c.recoverable).toBe(false);
    expect(c.recoveryHint?.action).toBe('install_dependency');
  });

  it('dependency_missing: "is not recognized" (Windows)', () => {
    const c = defaultClassifier(
      mkFailed("'deno' is not recognized as an internal or external command"),
      'shell_exec', {}, mkResult(),
    );
    expect(c.category).toBe('dependency_missing');
  });

  it('dependency_missing: "not configured"', () => {
    const c = defaultClassifier(mkFailed('process registry not configured'), 'process_spawn', {}, mkResult());
    expect(c.category).toBe('dependency_missing');
  });

  it('not_found: ENOENT for file_read', () => {
    const c = defaultClassifier(
      mkFailed('ENOENT: no such file or directory'),
      'file_read', { path: 'something' }, mkResult(),
    );
    // Hallucination heuristic doesn't fire — args.path "something" does not appear in haystack.
    expect(c.category).toBe('not_found');
  });

  it('not_found: "file not found"', () => {
    const c = defaultClassifier(mkFailed('file not found'), 'session_list', {}, mkResult());
    expect(c.category).toBe('not_found');
  });

  it('other: unclassified gibberish', () => {
    const c = defaultClassifier(mkFailed('something weird happened'), 'unknown_tool', {}, mkResult());
    expect(c.category).toBe('other');
    expect(c.confidence).toBeLessThan(0.5);
  });
});

describe('defaultClassifier — priority ordering', () => {
  it('timeout > rate_limit when both keywords present', () => {
    const c = defaultClassifier(mkFailed('timed out — rate limit exceeded'), 'web_fetch', {}, mkResult());
    expect(c.category).toBe('timeout');
  });

  it('rate_limit > auth when both keywords present', () => {
    const c = defaultClassifier(mkFailed('429 unauthorized'), 'web_fetch', {}, mkResult());
    expect(c.category).toBe('rate_limit');
  });

  it('dependency_missing > not_found ("command not found" beats generic "not found")', () => {
    const c = defaultClassifier(mkFailed('bash: foo: command not found'), 'shell_exec', {}, mkResult());
    expect(c.category).toBe('dependency_missing');
  });
});

describe('defaultClassifier — hallucination heuristic (narrow)', () => {
  it('fires for file_read with not_found AND args.path verbatim in haystack', () => {
    const path = '/imaginary/path/to/nowhere.txt';
    const c = defaultClassifier(
      mkFailed(`ENOENT: no such file or directory, open '${path}'`),
      'file_read',
      { path },
      mkResult(),
    );
    expect(c.category).toBe('hallucination');
    expect(c.confidence).toBeCloseTo(0.6, 1);
    expect(c.recoverable).toBe(true);
  });

  it('does NOT fire for file_read when args path is short / not in haystack', () => {
    const c = defaultClassifier(
      mkFailed('ENOENT: no such file or directory'),
      'file_read',
      { path: 'x' },           // too short
      mkResult(),
    );
    expect(c.category).toBe('not_found');
  });

  it('does NOT fire for non-file-read tools even with verbatim path', () => {
    const c = defaultClassifier(
      mkFailed('not found: /some/long/path'),
      'web_search',            // not a file_read family tool
      { path: '/some/long/path' },
      mkResult(),
    );
    expect(c.category).toBe('not_found');
  });

  it('fires for file_list too (file_read family)', () => {
    const path = '/missing/directory';
    const c = defaultClassifier(
      mkFailed(`no such directory: ${path}`),
      'file_list',
      { path },
      mkResult(),
    );
    expect(c.category).toBe('hallucination');
  });
});

describe('shellExecClassifier — UNIX exit codes', () => {
  it('exit 124 → timeout', () => {
    const c = shellExecClassifier(
      mkFailed('non-zero exit (124)'),
      'shell_exec', { command: 'sleep 100' },
      mkResult({ result: { exitCode: 124, stdout: '', stderr: '' } }),
    );
    expect(c.category).toBe('timeout');
    expect(c.confidence).toBeGreaterThanOrEqual(0.95);
    expect(c.matchedPattern).toBe('exit 124');
  });

  it('exit 126 → permission', () => {
    const c = shellExecClassifier(
      mkFailed('non-zero exit (126)'),
      'shell_exec', { command: './script.sh' },
      mkResult({ result: { exitCode: 126, stdout: '', stderr: 'Permission denied' } }),
    );
    expect(c.category).toBe('permission');
    expect(c.matchedPattern).toBe('exit 126');
  });

  it('exit 127 → dependency_missing', () => {
    const c = shellExecClassifier(
      mkFailed('non-zero exit (127)'),
      'shell_exec', { command: 'unknown-bin' },
      mkResult({ result: { exitCode: 127, stdout: '', stderr: 'command not found' } }),
    );
    expect(c.category).toBe('dependency_missing');
    expect(c.matchedPattern).toBe('exit 127');
  });

  it('exit 1 with timeout stderr → default classifier path picks timeout', () => {
    const c = shellExecClassifier(
      mkFailed('non-zero exit (1)'),
      'shell_exec', { command: 'foo' },
      mkResult({ result: { exitCode: 1, stdout: '', stderr: 'Operation timed out' } }),
    );
    expect(c.category).toBe('timeout');
  });

  it('exit 1 with command-not-found stderr → dependency_missing', () => {
    const c = shellExecClassifier(
      mkFailed('non-zero exit (1)'),
      'shell_exec', { command: 'foo' },
      mkResult({ result: { exitCode: 1, stdout: '', stderr: 'bash: foo: command not found' } }),
    );
    expect(c.category).toBe('dependency_missing');
  });
});

describe('FailureClassifier registry', () => {
  it('returns null for verifier-ok inputs (saves cycles)', () => {
    const reg = buildDefaultClassifier();
    const c = reg.classify(mkOk(), 'file_read', {}, mkResult());
    expect(c).toBeNull();
  });

  it('classifies through per-tool override for shell_exec', () => {
    const reg = buildDefaultClassifier();
    const c = reg.classify(
      mkFailed('non-zero exit (127)'),
      'shell_exec', {},
      mkResult({ result: { exitCode: 127, stderr: 'command not found' } }),
    );
    expect(c?.category).toBe('dependency_missing');
    expect(c?.matchedPattern).toBe('exit 127');
  });

  it('falls back to default for unregistered tool', () => {
    const reg = buildDefaultClassifier();
    const c = reg.classify(
      mkFailed('Rate limit exceeded'),
      'custom_plugin_tool', {},
      mkResult(),
    );
    expect(c?.category).toBe('rate_limit');
  });

  it('hasOverride reflects registrations', () => {
    const reg = buildDefaultClassifier();
    expect(reg.hasOverride('shell_exec')).toBe(true);
    expect(reg.hasOverride('web_search')).toBe(true);
    expect(reg.hasOverride('web_fetch')).toBe(true);
    expect(reg.hasOverride('fetch_page')).toBe(true);
    expect(reg.hasOverride('web_page')).toBe(true);
    expect(reg.hasOverride('file_read')).toBe(true);
    expect(reg.hasOverride('totally_unknown')).toBe(false);
  });

  it('caller-supplied registration overrides default', () => {
    const reg = new FailureClassifier();
    reg.register('weird_tool', () => ({
      category:    'other',
      confidence:  0.99,
      reason:      'custom classifier said so',
      recoverable: false,
    }));
    const c = reg.classify(mkFailed('whatever'), 'weird_tool', {}, mkResult());
    expect(c?.confidence).toBeCloseTo(0.99, 2);
    expect(c?.reason).toContain('custom');
  });
});

describe('defaultClassifier — multi-source haystack', () => {
  it('reads from result.error envelope', () => {
    const c = defaultClassifier(
      mkFailed('unrelated'),
      'web_fetch', {},
      mkResult({ error: 'ETIMEDOUT during connect' }),
    );
    expect(c.category).toBe('timeout');
  });

  it('reads from result.result.stderr', () => {
    const c = defaultClassifier(
      mkFailed('non-zero exit'),
      'shell_exec', {},
      mkResult({ result: { exitCode: 1, stderr: 'EACCES' } }),
    );
    expect(c.category).toBe('permission');
  });

  it('reads from raw string result body', () => {
    const c = defaultClassifier(
      mkFailed('vague'),
      'web_search', {},
      mkResult({ result: 'Error: rate limit exceeded, please retry after 60s' }),
    );
    expect(c.category).toBe('rate_limit');
  });
});

describe('defaultClassifier — confidence scoring', () => {
  it('explicit pattern hits score ≥ 0.8', () => {
    const c = defaultClassifier(mkFailed('Operation timed out'), 'web_fetch', {}, mkResult());
    expect(c.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('hallucination scores around 0.6 (narrow)', () => {
    const path = '/imaginary/path/very-specific-name.json';
    const c = defaultClassifier(
      mkFailed(`ENOENT: no such file: ${path}`),
      'file_read', { path },
      mkResult(),
    );
    expect(c.confidence).toBeCloseTo(0.6, 1);
  });

  it('fallback scores ≤ 0.5', () => {
    const c = defaultClassifier(mkFailed('blargh'), 'unknown', {}, mkResult());
    expect(c.confidence).toBeLessThanOrEqual(0.5);
  });
});

// ── v4.4 Phase 5 — sandboxViolationClassifier ─────────────────────────────

import {
  sandboxViolationClassifier,
  shellExecClassifierWithSandbox,
  fileReadClassifierWithSandbox,
} from '../../../core/v4/failureClassifier';

function mkFsViolationResult(code: string, opts: {
  matched_policy?: string;
  requested_path?: string;
  resolved_path?: string;
} = {}): ToolCallResult {
  return mkResult({
    result: {
      success: false,
      error: 'Sandbox blocked',
      sandbox_violation: {
        code,
        matched_policy: opts.matched_policy ?? '',
        requested_path: opts.requested_path ?? '',
        resolved_path:  opts.resolved_path  ?? '',
        retryable: false,
        category: 'sandbox_violation',
      },
    },
  });
}

describe('sandboxViolationClassifier — Phase 2 FS violation envelopes', () => {
  it('categorizes fs.write_outside_allowlist correctly', () => {
    const r = mkFsViolationResult('fs.write_outside_allowlist', {
      requested_path: '/opt/x.txt',
      resolved_path:  '/opt/x.txt',
    });
    const c = sandboxViolationClassifier(mkFailed('Sandbox blocked'), 'file_write', { path: '/opt/x.txt' }, r);
    expect(c.category).toBe('sandbox_violation');
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
    expect(c.recoverable).toBe(false);
    expect(c.matchedPattern).toBe('fs.write_outside_allowlist');
    expect(c.sandboxViolation?.code).toBe('fs.write_outside_allowlist');
    expect(c.recoveryHint?.action).toBe('request_user_action');
    expect(c.recoveryHint?.detail).toMatch(/AIDEN_SANDBOX_ALLOW/);
  });

  it('categorizes fs.sensitive_path with deny-cannot-override hint', () => {
    const r = mkFsViolationResult('fs.sensitive_path', {
      matched_policy: '/etc',
      resolved_path: '/etc/passwd',
    });
    const c = sandboxViolationClassifier(mkFailed('Sandbox blocked'), 'file_read', { path: '/etc/passwd' }, r);
    expect(c.category).toBe('sandbox_violation');
    expect(c.recoverable).toBe(false);
    expect(c.recoveryHint?.detail).toMatch(/cannot be allowlisted/i);
    expect(c.recoveryHint?.detail).toMatch(/AIDEN_SANDBOX=0/);
  });

  it('categorizes fs.symlink_escape', () => {
    const r = mkFsViolationResult('fs.symlink_escape', { resolved_path: '/outside' });
    const c = sandboxViolationClassifier(mkFailed('Sandbox blocked'), 'file_write', {}, r);
    expect(c.matchedPattern).toBe('fs.symlink_escape');
    expect(c.recoveryHint?.detail).toMatch(/symlink/i);
  });

  it('categorizes fs.path_traversal', () => {
    const r = mkFsViolationResult('fs.path_traversal');
    const c = sandboxViolationClassifier(mkFailed('Sandbox blocked'), 'file_write', {}, r);
    expect(c.matchedPattern).toBe('fs.path_traversal');
    expect(c.recoveryHint?.detail).toMatch(/absolute path/i);
  });

  it('categorizes fs.read_denied', () => {
    const r = mkFsViolationResult('fs.read_denied', { matched_policy: '/etc' });
    const c = sandboxViolationClassifier(mkFailed('Sandbox blocked'), 'file_read', {}, r);
    expect(c.matchedPattern).toBe('fs.read_denied');
  });

  it('falls through to default when no sandbox envelope present', () => {
    const r = mkResult({ result: { success: false, error: 'ENOENT' } });
    const c = sandboxViolationClassifier(mkFailed('ENOENT: no such file'), 'file_write', {}, r);
    expect(c.category).not.toBe('sandbox_violation');
  });

  it('ignores malformed envelope (wrong category)', () => {
    const r = mkResult({ result: { success: false, sandbox_violation: { category: 'other', code: 'x' } } });
    const c = sandboxViolationClassifier(mkFailed('err'), 'file_write', {}, r);
    expect(c.category).not.toBe('sandbox_violation');
  });
});

describe('sandboxViolationClassifier — Phase 3 docker-start failure', () => {
  it('shell_exec stderr "Sandbox: failed to start container" → sandbox_violation', () => {
    const r = mkResult({
      result: {
        exitCode: -1,
        stdout: '',
        stderr: 'Sandbox: failed to start container: docker run timed out',
        backend: 'docker',
      },
    });
    const c = sandboxViolationClassifier(mkFailed('failed'), 'shell_exec', {}, r);
    expect(c.category).toBe('sandbox_violation');
    expect(c.matchedPattern).toBe('docker_unavailable');
    expect(c.recoverable).toBe(true);
    expect(c.recoveryHint?.action).toBe('install_dependency');
  });

  it('non-shell tool stderr same message: no special handling', () => {
    const r = mkResult({
      result: { success: false, stderr: 'Sandbox: failed to start container' },
    });
    const c = sandboxViolationClassifier(mkFailed('failed'), 'file_write', {}, r);
    expect(c.category).not.toBe('sandbox_violation');
  });
});

describe('shellExecClassifierWithSandbox', () => {
  it('sandbox envelope wins over default exit-code logic', () => {
    const r = mkFsViolationResult('fs.write_outside_allowlist');
    const c = shellExecClassifierWithSandbox(mkFailed('blocked'), 'shell_exec', {}, r);
    expect(c.category).toBe('sandbox_violation');
  });

  it('falls through to shellExecClassifier when no sandbox envelope', () => {
    const r = mkResult({ result: { exitCode: 124, stdout: '', stderr: '', backend: 'local' } });
    const c = shellExecClassifierWithSandbox(mkFailed('timed out'), 'shell_exec', {}, r);
    expect(c.category).toBe('timeout');
  });
});

describe('fileReadClassifierWithSandbox', () => {
  it('sandbox envelope wins over hallucination heuristic', () => {
    const r = mkFsViolationResult('fs.sensitive_path', { matched_policy: '/etc' });
    const c = fileReadClassifierWithSandbox(mkFailed('ENOENT'), 'file_read', { path: '/etc/passwd' }, r);
    expect(c.category).toBe('sandbox_violation');
  });

  it('falls through to fileReadClassifier when no envelope', () => {
    const r = mkResult({ result: { success: false, error: 'ENOENT' } });
    const c = fileReadClassifierWithSandbox(mkFailed('ENOENT: no such file'), 'file_read', { path: '/zzz/missing' }, r);
    expect(c.category).not.toBe('sandbox_violation');
  });
});

describe('buildDefaultClassifier — Phase 5 registrations', () => {
  it('registers sandbox-aware classifiers for all file_* tools + shell_exec', () => {
    const reg = buildDefaultClassifier();
    expect(reg.hasOverride('shell_exec')).toBe(true);
    expect(reg.hasOverride('file_read')).toBe(true);
    expect(reg.hasOverride('file_list')).toBe(true);
    expect(reg.hasOverride('file_write')).toBe(true);
    expect(reg.hasOverride('file_patch')).toBe(true);
    expect(reg.hasOverride('file_copy')).toBe(true);
    expect(reg.hasOverride('file_move')).toBe(true);
    expect(reg.hasOverride('file_delete')).toBe(true);
  });

  it('file_write with sandbox envelope flows through the registered classifier', () => {
    const reg = buildDefaultClassifier();
    const r = mkFsViolationResult('fs.write_outside_allowlist', { resolved_path: '/opt/y.txt' });
    const c = reg.classify(mkFailed('blocked'), 'file_write', {}, r);
    expect(c?.category).toBe('sandbox_violation');
  });
});
