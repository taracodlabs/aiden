/**
 * v4.4 Phase 2 — sandboxFs.ts unit tests.
 *
 * Coverage:
 *   1. Short-circuit when sandbox disabled
 *   2. Denylist wins for read AND write
 *   3. Allowlist gates write/delete only
 *   4. Read passes after clearing denylist (no allowlist requirement)
 *   5. Symlink-escape detection (real fs symlink)
 *   6. realpathWithFallback walks up to first existing ancestor
 *   7. isWithin boundary correctness (no `/home/user-evil` false hit)
 *   8. violationEnvelope shape & required keys
 *   9. AIDEN_SANDBOX_ALLOW extension reaches the policy
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isPathAllowed,
  isWithin,
  realpathWithFallback,
  violationEnvelope,
} from '../../../core/v4/sandboxFs';
import {
  readSandboxConfig,
  resolveRealPath,
  _clearRealPathCacheForTests,
} from '../../../core/v4/sandboxConfig';

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aiden-sbx-${prefix}-`));
  return fs.realpathSync(dir);
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

describe('isWithin — boundary correctness', () => {
  it('child strictly inside parent', () => {
    expect(isWithin('/home/user/x', '/home/user')).toBe(true);
  });

  it('child === parent', () => {
    expect(isWithin('/home/user', '/home/user')).toBe(true);
  });

  it('sibling prefix collision (the classic startsWith bug)', () => {
    expect(isWithin('/home/user-evil', '/home/user')).toBe(false);
  });

  it('parent of child returns false', () => {
    expect(isWithin('/home', '/home/user')).toBe(false);
  });

  it('empty strings return false', () => {
    expect(isWithin('', '/home')).toBe(false);
    expect(isWithin('/home', '')).toBe(false);
  });
});

describe('realpathWithFallback', () => {
  let root: string;
  beforeEach(() => { _clearRealPathCacheForTests(); root = tmpDir('rpf'); });
  afterEach(() => { cleanup(root); });

  // Reference the product's OWN canonicaliser (resolveRealPath, which uses
  // fs.realpathSync.native) rather than raw fs.realpathSync. On Windows they
  // diverge — .native normalises 8.3 short names + drive-letter casing that the
  // CI runner's temp path exposes (e.g. RUNNER~1) — so comparing against raw
  // realpathSync failed on the Windows CI leg while passing on dev machines.
  it('existing path: returns realpath directly', () => {
    const real = realpathWithFallback(root);
    expect(real).toBe(resolveRealPath(root));
  });

  it('non-existent leaf under existing parent: parent-realpath + basename', () => {
    const target = path.join(root, 'does-not-exist.txt');
    const real = realpathWithFallback(target);
    expect(real).toBe(path.join(resolveRealPath(root), 'does-not-exist.txt'));
  });

  it('non-existent nested path: walks up to first existing ancestor', () => {
    const target = path.join(root, 'a', 'b', 'c', 'leaf.txt');
    const real = realpathWithFallback(target);
    expect(real).toBe(path.join(resolveRealPath(root), 'a', 'b', 'c', 'leaf.txt'));
  });
});

describe('isPathAllowed — sandbox disabled (opt-out via AIDEN_SANDBOX=0)', () => {
  // v4.4 Phase 6 — sandbox is on by default. These tests exercise the
  // opt-out path (`AIDEN_SANDBOX=0`) to confirm short-circuit semantics.
  beforeEach(() => { _clearRealPathCacheForTests(); });

  it('returns allowed=true regardless of path when AIDEN_SANDBOX=0', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '0' });
    const d = isPathAllowed('/etc/passwd', 'read', process.cwd(), cfg);
    expect(d.allowed).toBe(true);
    expect(d.violation).toBeUndefined();
  });

  it('still resolves the path (so callers can use resolvedPath uniformly)', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '0' });
    const d = isPathAllowed('./relative/path', 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(true);
    expect(path.isAbsolute(d.resolvedPath)).toBe(true);
  });
});

describe('isPathAllowed — denylist (read & write)', () => {
  beforeEach(() => { _clearRealPathCacheForTests(); });

  it('refuses read of /etc when enabled', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const d = isPathAllowed('/etc/hosts', 'read', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.sensitive_path');
  });

  it('refuses write of ~/.ssh/key when enabled', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const target = path.join(os.homedir(), '.ssh', 'id_rsa');
    const d = isPathAllowed(target, 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.sensitive_path');
  });

  it('denylist wins even when path is also in allowlist', () => {
    // Custom allow that includes /etc, but denylist still wins.
    const cfg = readSandboxConfig({
      AIDEN_SANDBOX: '1',
      AIDEN_SANDBOX_ALLOW: '/etc',
    });
    const d = isPathAllowed('/etc/passwd', 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.sensitive_path');
  });

  // ─── v4.12 SH.1 — hardened cross-platform credential-store denylist ──
  it('★ SH.1 — file_read of a Windows credential store (%APPDATA%\\Microsoft\\Credentials) is denied', () => {
    // Inject a synthetic Windows env so the test is deterministic on any OS.
    const appData = path.join('C:', 'Users', 'test', 'AppData', 'Roaming');
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1', APPDATA: appData });
    const target = path.join(appData, 'Microsoft', 'Credentials', 'DFBE70A7.bin');
    const d = isPathAllowed(target, 'read', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.sensitive_path');
  });

  it('★ SH.1 — file_read of a Windows SAM/SYSTEM hive (System32\\config) is denied', () => {
    const winDir = path.join('C:', 'Windows');
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1', SystemRoot: winDir });
    const target = path.join(winDir, 'System32', 'config', 'SAM');
    const d = isPathAllowed(target, 'read', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.sensitive_path');
  });

  it('★ SH.1 — cloud/cluster creds (~/.kube, ~/.docker, ~/.azure) are denied cross-platform', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    for (const rel of [['.kube', 'config'], ['.docker', 'config.json'], ['.azure', 'accessTokens.json']]) {
      const target = path.join(os.homedir(), ...rel);
      const d = isPathAllowed(target, 'read', process.cwd(), cfg);
      expect(d.allowed, `${rel.join('/')} should be denied`).toBe(false);
      expect(d.violation?.code).toBe('fs.sensitive_path');
    }
  });

  it('★ SH.1 — Windows cred paths are omitted when APPDATA is unset (no bogus entries)', () => {
    // No APPDATA/LOCALAPPDATA/SystemRoot → no Windows-specific deny entries.
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const hasWinCredEntry = cfg.fsDenyList.some((p) => /Microsoft[\\/]Credentials/i.test(p));
    // On a real Windows dev box process.env leaks in only via the singleton
    // path (env === process.env); here we pass a custom env, so none appear.
    expect(hasWinCredEntry).toBe(false);
  });
});

describe('isPathAllowed — allowlist (write/delete only)', () => {
  let workspace: string;
  beforeEach(() => {
    _clearRealPathCacheForTests();
    workspace = tmpDir('ws');
  });
  afterEach(() => { cleanup(workspace); });

  it('write inside cwd (in default allowlist) permitted', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const target = path.join(process.cwd(), 'aiden-test-write.txt');
    const d = isPathAllowed(target, 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(true);
  });

  it('write outside any allowlist root refused', () => {
    // /opt is not in default allowlist on most systems.
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const d = isPathAllowed('/opt/aiden-test.txt', 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.write_outside_allowlist');
  });

  it('delete outside any allowlist root refused', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const d = isPathAllowed('/opt/aiden-test.txt', 'delete', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.write_outside_allowlist');
  });

  it('read outside allowlist permitted (denylist not hit)', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    // /opt is outside both default allowlist and denylist — read OK.
    const d = isPathAllowed('/opt/some-file.txt', 'read', process.cwd(), cfg);
    expect(d.allowed).toBe(true);
  });

  it('AIDEN_SANDBOX_ALLOW extension permits writes there', () => {
    const cfg = readSandboxConfig({
      AIDEN_SANDBOX: '1',
      AIDEN_SANDBOX_ALLOW: workspace,
    });
    const target = path.join(workspace, 'out.txt');
    const d = isPathAllowed(target, 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(true);
  });
});

// Symlink test is OS-conditional: Windows requires elevated rights to
// create symlinks. Skip on Windows where we can't reliably set one up.
const symlinkable = process.platform !== 'win32';
const symdescribe = symlinkable ? describe : describe.skip;

symdescribe('isPathAllowed — symlink escape', () => {
  let allow: string;
  let outside: string;
  // The default allowlist in sandboxConfig.ts:155-167 includes os.tmpdir().
  // Both `allow` and `outside` cannot both live in /tmp/ — `outside` would
  // be under the default allowlist via the tmpdir entry, and the symlink-
  // escape check would correctly report `realUnderAllow: true`, masking the
  // bug we're trying to test. Place `outside` under os.homedir() (which is
  // NOT in the default allowlist — only home/Documents|Downloads|Desktop
  // are) so the symlink target is genuinely outside every allowlist entry.
  beforeEach(() => {
    _clearRealPathCacheForTests();
    allow   = tmpDir('allow');
    outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.homedir(), '.aiden-sbx-outside-')),
    );
  });
  afterEach(() => { cleanup(allow); cleanup(outside); });

  it('symlink inside allowlist pointing outside → fs.symlink_escape', () => {
    const linkPath = path.join(allow, 'escape');
    fs.symlinkSync(outside, linkPath, 'dir');
    const cfg = readSandboxConfig({
      AIDEN_SANDBOX: '1',
      AIDEN_SANDBOX_ALLOW: allow,
    });
    const target = path.join(linkPath, 'pwned.txt');
    const d = isPathAllowed(target, 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(false);
    expect(d.violation?.code).toBe('fs.symlink_escape');
  });

  it('symlink inside allowlist pointing inside same allowlist → permitted', () => {
    const sub = path.join(allow, 'sub');
    fs.mkdirSync(sub);
    const linkPath = path.join(allow, 'inside-link');
    fs.symlinkSync(sub, linkPath, 'dir');
    const cfg = readSandboxConfig({
      AIDEN_SANDBOX: '1',
      AIDEN_SANDBOX_ALLOW: allow,
    });
    const target = path.join(linkPath, 'ok.txt');
    const d = isPathAllowed(target, 'write', process.cwd(), cfg);
    expect(d.allowed).toBe(true);
  });
});

describe('violationEnvelope', () => {
  beforeEach(() => { _clearRealPathCacheForTests(); });

  it('produces the structured wire-format shape on denied decisions', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const d = isPathAllowed('/etc/hosts', 'read', process.cwd(), cfg);
    const env = violationEnvelope(d);
    expect(env.code).toBe('fs.sensitive_path');
    expect(env.category).toBe('sandbox_violation');
    expect(env.retryable).toBe(false);
    expect(env.requested_path).toBe('/etc/hosts');
    expect(typeof env.resolved_path).toBe('string');
    expect(typeof env.matched_policy).toBe('string');
  });

  it('throws when called on an allowed decision (defensive)', () => {
    const cfg = readSandboxConfig({});
    const d = isPathAllowed('/tmp/x', 'read', process.cwd(), cfg);
    expect(() => violationEnvelope(d)).toThrow();
  });
});

describe('isPathAllowed — decision shape', () => {
  beforeEach(() => { _clearRealPathCacheForTests(); });

  it('always carries requestedPath, expandedPath, resolvedPath, op', () => {
    const cfg = readSandboxConfig({ AIDEN_SANDBOX: '1' });
    const d = isPathAllowed('~/Documents/x.txt', 'write', process.cwd(), cfg);
    expect(d.requestedPath).toBe('~/Documents/x.txt');
    expect(path.isAbsolute(d.expandedPath)).toBe(true);
    expect(path.isAbsolute(d.resolvedPath)).toBe(true);
    expect(d.op).toBe('write');
  });
});

// ── v4.12 CI-green — /var narrowed so macOS OS temp isn't swallowed ──────────
//
// Regression for the macOS sandbox bug: the broad `/var` denylist entry
// swallowed os.tmpdir() on macOS (`/var/folders/…` → realpath
// `/private/var/folders`, under `/private/var`), so file_* tools were wrongly
// denied on macOS temp files even though os.tmpdir() is ALLOW-listed. `/var` is
// now narrowed to its sensitive subdirs. The macOS-specific half of this proof
// runs on the macOS CI leg (there os.tmpdir() is under /var/folders).
describe('/var narrowing — OS temp allowed, sensitive /var still denied', () => {
  beforeEach(() => { _clearRealPathCacheForTests(); });
  const cfg = () => readSandboxConfig({ AIDEN_SANDBOX: '1' });

  it('OS temp dir is allowed for read AND write (macOS os.tmpdir() = /var/folders was denied)', () => {
    const tmpFile = path.join(os.tmpdir(), `aiden-var-regress-${process.pid}.txt`);
    expect(isPathAllowed(tmpFile, 'read',  process.cwd(), cfg()).allowed).toBe(true);
    expect(isPathAllowed(tmpFile, 'write', process.cwd(), cfg()).allowed).toBe(true);
  });

  it('sensitive /var paths stay DENIED for read AND write', () => {
    const sensitive = [
      '/var/log/system.log', '/var/spool/cron/root', '/var/mail/u',
      '/var/root/.ssh/id_rsa', '/var/db/sudo/ts/u', '/var/audit/current',
      '/var/backups/shadow.bak', '/var/lib/docker/config.json',
    ];
    for (const p of sensitive) {
      for (const op of ['read', 'write'] as const) {
        const d = isPathAllowed(p, op, process.cwd(), cfg());
        expect(d.allowed, `${p} (${op}) must stay denied`).toBe(false);
        expect(d.violation?.code).toBe('fs.sensitive_path');
      }
    }
  });
});
