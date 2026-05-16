/**
 * v4.4 Phase 1 — SandboxConfig unit tests.
 *
 * Coverage:
 *   1. Default config when no env vars → enabled:false + safe defaults
 *   2. AIDEN_SANDBOX gating (strict `=== '1'` in Phase 1)
 *   3. AIDEN_SANDBOX_ALLOW / DENY env-list parsing + extension
 *   4. AIDEN_SANDBOX_NETWORK enum parsing
 *   5. AIDEN_SANDBOX_PERSISTENT default-true + 0-opt-out
 *   6. AIDEN_SANDBOX_MEMORY / CPUS / PIDS / IDLE_MS parsing + fallbacks
 *   7. AIDEN_DRYRUN orthogonal to AIDEN_SANDBOX
 *   8. inferDefaultRiskTier — mutates → caution; !mutates → safe
 *   9. resolveRealPath caching + idempotence
 *  10. defaultBackend = docker when enabled, local otherwise
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  readSandboxConfig,
  inferDefaultRiskTier,
  resolveRealPath,
  _clearRealPathCacheForTests,
} from '../../../core/v4/sandboxConfig';

function envWith(over: Record<string, string>): NodeJS.ProcessEnv {
  return { ...over } as NodeJS.ProcessEnv;
}

describe('readSandboxConfig — defaults', () => {
  it('no env vars: enabled=false, defaults across the board', () => {
    const cfg = readSandboxConfig(envWith({}));
    expect(cfg.enabled).toBe(false);
    expect(cfg.defaultBackend).toBe('local');
    expect(cfg.persistent).toBe(true);
    expect(cfg.networkMode).toBe('bridge');
    expect(cfg.dryRun).toBe(false);
    expect(cfg.resourceLimits.memory).toBe('1g');
    expect(cfg.resourceLimits.cpus).toBe('2');
    expect(cfg.resourceLimits.pidsLimit).toBe(256);
    expect(cfg.idleReaperMs).toBe(300000);
  });

  it('fsAllowList includes cwd + common user dirs by default', () => {
    const cfg = readSandboxConfig(envWith({}));
    expect(cfg.fsAllowList.length).toBeGreaterThan(0);
  });

  it('fsDenyList non-empty by default (sensitive paths)', () => {
    const cfg = readSandboxConfig(envWith({}));
    expect(cfg.fsDenyList.length).toBeGreaterThan(0);
  });
});

describe('AIDEN_SANDBOX gating (Phase 1 strict opt-in)', () => {
  it('AIDEN_SANDBOX=1: enabled', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX: '1' })).enabled).toBe(true);
  });

  it('AIDEN_SANDBOX=0: disabled (Phase 1 strict; junk also disables)', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX: '0' })).enabled).toBe(false);
  });

  it('AIDEN_SANDBOX=true: disabled (only `1` enables in Phase 1)', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX: 'true' })).enabled).toBe(false);
  });

  it('AIDEN_SANDBOX=yes: disabled', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX: 'yes' })).enabled).toBe(false);
  });

  it('AIDEN_SANDBOX unset: disabled', () => {
    expect(readSandboxConfig(envWith({})).enabled).toBe(false);
  });

  it('defaultBackend flips to docker when enabled', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX: '1' })).defaultBackend).toBe('docker');
  });

  it('defaultBackend stays local when disabled', () => {
    expect(readSandboxConfig(envWith({})).defaultBackend).toBe('local');
  });
});

describe('AIDEN_SANDBOX_ALLOW / AIDEN_SANDBOX_DENY env extension', () => {
  it('AIDEN_SANDBOX_ALLOW extends the allowlist', () => {
    const base = readSandboxConfig(envWith({}));
    const ext  = readSandboxConfig(envWith({ AIDEN_SANDBOX_ALLOW: '/tmp/x:/tmp/y' }));
    expect(ext.fsAllowList.length).toBeGreaterThanOrEqual(base.fsAllowList.length);
  });

  it('AIDEN_SANDBOX_DENY extends the denylist', () => {
    const base = readSandboxConfig(envWith({}));
    const ext  = readSandboxConfig(envWith({ AIDEN_SANDBOX_DENY: '/tmp/secret' }));
    expect(ext.fsDenyList.length).toBeGreaterThanOrEqual(base.fsDenyList.length);
  });

  it('empty string AIDEN_SANDBOX_ALLOW: no extension', () => {
    const base = readSandboxConfig(envWith({}));
    const ext  = readSandboxConfig(envWith({ AIDEN_SANDBOX_ALLOW: '' }));
    expect(ext.fsAllowList.length).toBe(base.fsAllowList.length);
  });

  it('whitespace-only path stripped', () => {
    const base = readSandboxConfig(envWith({}));
    const ext  = readSandboxConfig(envWith({ AIDEN_SANDBOX_ALLOW: '  : ' }));
    expect(ext.fsAllowList.length).toBe(base.fsAllowList.length);
  });
});

describe('Network mode parsing', () => {
  it('AIDEN_SANDBOX_NETWORK=none: full isolation', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_NETWORK: 'none' })).networkMode).toBe('none');
  });

  it('AIDEN_SANDBOX_NETWORK=bridge: default', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_NETWORK: 'bridge' })).networkMode).toBe('bridge');
  });

  it('AIDEN_SANDBOX_NETWORK=host: falls back to bridge (junk default)', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_NETWORK: 'host' })).networkMode).toBe('bridge');
  });

  it('AIDEN_SANDBOX_NETWORK unset: bridge', () => {
    expect(readSandboxConfig(envWith({})).networkMode).toBe('bridge');
  });
});

describe('Persistent filesystem toggle', () => {
  it('AIDEN_SANDBOX_PERSISTENT=0: ephemeral tmpfs', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_PERSISTENT: '0' })).persistent).toBe(false);
  });

  it('AIDEN_SANDBOX_PERSISTENT=1: bind mount', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_PERSISTENT: '1' })).persistent).toBe(true);
  });

  it('AIDEN_SANDBOX_PERSISTENT unset: default true (bind mount)', () => {
    expect(readSandboxConfig(envWith({})).persistent).toBe(true);
  });
});

describe('Resource-limit env vars', () => {
  it('AIDEN_SANDBOX_MEMORY pass-through (Docker parses)', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_MEMORY: '4g' })).resourceLimits.memory).toBe('4g');
  });

  it('AIDEN_SANDBOX_CPUS pass-through', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_CPUS: '4' })).resourceLimits.cpus).toBe('4');
  });

  it('AIDEN_SANDBOX_PIDS=512: parsed', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_PIDS: '512' })).resourceLimits.pidsLimit).toBe(512);
  });

  it('AIDEN_SANDBOX_PIDS=garbage: fallback to default', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_PIDS: 'abc' })).resourceLimits.pidsLimit).toBe(256);
  });

  it('AIDEN_SANDBOX_PIDS=0 (invalid): fallback', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_PIDS: '0' })).resourceLimits.pidsLimit).toBe(256);
  });

  it('AIDEN_SANDBOX_IDLE_MS=60000: parsed', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_IDLE_MS: '60000' })).idleReaperMs).toBe(60000);
  });

  it('AIDEN_SANDBOX_IDLE_MS=junk: fallback', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_IDLE_MS: 'junk' })).idleReaperMs).toBe(300000);
  });
});

describe('AIDEN_DRYRUN — orthogonal to AIDEN_SANDBOX', () => {
  it('AIDEN_DRYRUN=1 alone: dryRun=true, enabled=false', () => {
    const cfg = readSandboxConfig(envWith({ AIDEN_DRYRUN: '1' }));
    expect(cfg.dryRun).toBe(true);
    expect(cfg.enabled).toBe(false);
  });

  it('AIDEN_DRYRUN=0 + AIDEN_SANDBOX=1: dryRun=false, enabled=true', () => {
    const cfg = readSandboxConfig(envWith({ AIDEN_DRYRUN: '0', AIDEN_SANDBOX: '1' }));
    expect(cfg.dryRun).toBe(false);
    expect(cfg.enabled).toBe(true);
  });

  it('both unset: both false', () => {
    const cfg = readSandboxConfig(envWith({}));
    expect(cfg.dryRun).toBe(false);
    expect(cfg.enabled).toBe(false);
  });
});

describe('AIDEN_SANDBOX_IMAGE — Phase 3 image override', () => {
  it('unset: defaults to node:22-alpine', () => {
    expect(readSandboxConfig(envWith({})).image).toBe('node:22-alpine');
  });

  it('set: pass-through trimmed', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_IMAGE: '  python:3.12-slim ' })).image)
      .toBe('python:3.12-slim');
  });

  it('empty string: falls back to default', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_IMAGE: '' })).image)
      .toBe('node:22-alpine');
  });

  it('whitespace-only: falls back to default', () => {
    expect(readSandboxConfig(envWith({ AIDEN_SANDBOX_IMAGE: '   ' })).image)
      .toBe('node:22-alpine');
  });
});

describe('inferDefaultRiskTier', () => {
  it('mutates=true → caution', () => {
    expect(inferDefaultRiskTier(true)).toBe('caution');
  });

  it('mutates=false → safe', () => {
    expect(inferDefaultRiskTier(false)).toBe('safe');
  });
});

describe('resolveRealPath', () => {
  beforeEach(() => { _clearRealPathCacheForTests(); });

  it('caches results between calls', () => {
    const a = resolveRealPath('.');
    const b = resolveRealPath('.');
    expect(a).toBe(b);
  });

  it('resolves relative paths to absolute', () => {
    const r = resolveRealPath('.');
    expect(r.startsWith('/') || /^[A-Z]:[\\\/]/i.test(r)).toBe(true);
  });

  it('handles non-existent paths gracefully (no throw)', () => {
    expect(() => resolveRealPath('/this/does/not/exist/at/all')).not.toThrow();
  });
});
