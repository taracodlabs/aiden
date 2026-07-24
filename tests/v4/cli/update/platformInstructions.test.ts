/**
 * v4.9.1 — per-platform EPERM remediation text.
 * Windows = PowerShell syntax; darwin/linux = bash/zsh syntax. NO
 * cross-contamination of `export PATH=…` into the Windows branch
 * (the v4.9.0 regression we're hot-fixing).
 */
import { describe, it, expect } from 'vitest';
import {
  permissionDeniedInstructions,
  detectShell,
  detectStalePrefix,
} from '../../../../core/v4/update/platformInstructions';

describe('permissionDeniedInstructions — Windows', () => {
  const win = permissionDeniedInstructions({
    platform: 'win32',
    home: 'C:\\Users\\shiva',
    prefix: 'C:\\Program Files\\nodejs',
  });
  it('reports the actual prefix without assuming elevation', () => {
    expect(win.headline).toContain('C:\\Program Files\\nodejs');
    expect(win.headline).not.toMatch(/Administrator|sudo/);
  });
  it('does not invent a replacement prefix', () => {
    const steps = win.steps.join('\n');
    expect(steps).not.toMatch(/\$env:USERPROFILE|~\//);
  });
  it('does not alter PATH or npm configuration', () => {
    const steps = win.steps.join('\n');
    expect(steps).not.toMatch(/\[Environment\]::SetEnvironmentVariable/);
    expect(steps).not.toMatch(/config set prefix/);
    expect(steps).not.toMatch(/^export /m);
  });
  it('provides a precise manual retry', () => {
    const steps = win.steps.join('\n');
    expect(steps).toContain('npm install -g aiden-runtime@latest');
  });
});

describe('permissionDeniedInstructions — darwin/zsh', () => {
  const mac = permissionDeniedInstructions({
    platform: 'darwin', home: '/Users/shiva', env: { SHELL: '/bin/zsh' },
  });
  it('does not assume sudo or Administrator', () => {
    expect(mac.headline).not.toMatch(/sudo|Administrator/);
  });
  it('does not rewrite shell configuration', () => {
    const steps = mac.steps.join('\n');
    expect(steps).not.toMatch(/export PATH|\.zshrc/);
    expect(steps).not.toMatch(/PowerShell/);
    expect(steps).not.toMatch(/\$env:/);
  });
  it('detects zsh shell', () => {
    expect(mac.shell).toBe('zsh');
  });
});

describe('permissionDeniedInstructions — linux/bash', () => {
  const lin = permissionDeniedInstructions({
    platform: 'linux', home: '/home/shiva', env: { SHELL: '/bin/bash' },
  });
  it('does not rewrite bash configuration', () => {
    const steps = lin.steps.join('\n');
    expect(steps).not.toMatch(/export PATH|\.bashrc/);
    expect(steps).not.toMatch(/PowerShell/);
  });
  it('detects bash shell', () => {
    expect(lin.shell).toBe('bash');
  });
});

describe('detectShell', () => {
  it('returns the basename of $SHELL', () => {
    expect(detectShell({ SHELL: '/bin/zsh'  })).toBe('zsh');
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
  });
  it('returns null when SHELL is unset', () => {
    expect(detectShell({})).toBeNull();
  });
});

describe('detectStalePrefix', () => {
  it('Windows + Program Files → warns', () => {
    const r = detectStalePrefix({
      platform: 'win32', prefix: 'C:\\Program Files\\nodejs',
      writable: false, home: 'C:\\Users\\shiva',
    });
    expect(r).not.toBeNull();
    expect(r!.warning).toMatch(/not writable/);
    expect(r!.switchSteps.join('\n')).not.toMatch(/Administrator|config set prefix/);
  });
  it('Windows + user-local prefix → no warning', () => {
    const r = detectStalePrefix({
      platform: 'win32', prefix: 'C:\\Users\\shiva\\AppData\\Roaming\\npm',
      writable: true, home: 'C:\\Users\\shiva',
    });
    expect(r).toBeNull();
  });
  it('Mac + /usr/local + not writable → warns with zsh/bash syntax', () => {
    const r = detectStalePrefix({
      platform: 'darwin', prefix: '/usr/local', writable: false,
      home: '/Users/shiva', env: { SHELL: '/bin/zsh' },
    });
    expect(r).not.toBeNull();
    expect(r!.warning).toMatch(/sudo every time/);
    expect(r!.switchSteps.join('\n')).not.toMatch(/\.zshrc|config set prefix/);
  });
  it('Linux + /usr + not writable → warns', () => {
    const r = detectStalePrefix({
      platform: 'linux', prefix: '/usr', writable: false,
      home: '/home/shiva', env: { SHELL: '/bin/bash' },
    });
    expect(r).not.toBeNull();
    expect(r!.switchSteps.join('\n')).not.toMatch(/\.bashrc|config set prefix/);
  });
  it('Mac + /usr/local but writable → no warning', () => {
    const r = detectStalePrefix({
      platform: 'darwin', prefix: '/usr/local', writable: true,
      home: '/Users/shiva',
    });
    expect(r).toBeNull();
  });
});
