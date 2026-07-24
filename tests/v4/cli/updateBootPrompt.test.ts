/**
 * v4.5 update system — boot prompt UX tests.
 */
import { describe, it, expect } from 'vitest';
import {
  renderBootUpdateBox,
  showBootUpdatePrompt,
} from '../../../cli/v4/updateBootPrompt';
import type { UpdateStatus } from '../../../core/v4/update/checkUpdate';
import type { UpdateInstallPlan } from '../../../core/v4/update/installPreflight';

const STATUS_UPDATE_AVAILABLE: UpdateStatus = {
  installed: '4.5.0',
  latest:    '4.5.1',
  updateAvailable: true,
  fromCache: false,
  firstRun:  false,
  releaseNotes: 'Fixed IMAP reconnect on Windows.',
  releaseUrl:   'https://gh/r/v4.5.1',
  skipped:   false,
};

const PLAN_NPM_GLOBAL: UpdateInstallPlan = {
  provenance: 'npm-global',
  scope: 'user',
  targetVersion: '4.5.1',
  installAllowed: true,
  reason: 'ready',
  npmExecutable: 'C:\\Users\\x\\AppData\\Roaming\\npm\\npm.cmd',
  prefix: 'C:\\Users\\x\\AppData\\Roaming\\npm',
  globalRoot: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules',
  packagePath: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\aiden-runtime',
  currentPackagePath: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\aiden-runtime',
  guidance: [],
};

function mkDisplay() {
  const lines: string[] = [];
  return {
    write: (s: string) => { lines.push(s); },
    dim:   (s: string) => { lines.push(s); },
    _lines: lines,
  };
}

describe('renderBootUpdateBox — box rendering', () => {
  it('renders top/bottom box borders + current/latest line', () => {
    const lines = renderBootUpdateBox(STATUS_UPDATE_AVAILABLE, PLAN_NPM_GLOBAL);
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[lines.length - 1]).toMatch(/^└─+┘$/);
    const joined = lines.join('\n');
    expect(joined).toContain('Aiden 4.5.1 available');
    expect(joined).toContain("you're on 4.5.0");
  });

  it('includes release notes line when releaseNotes present', () => {
    const lines = renderBootUpdateBox(STATUS_UPDATE_AVAILABLE, PLAN_NPM_GLOBAL);
    const joined = lines.join('\n');
    expect(joined).toContain("What's new: Fixed IMAP reconnect on Windows.");
  });

  it('omits release notes section when releaseNotes absent', () => {
    const status: UpdateStatus = { ...STATUS_UPDATE_AVAILABLE, releaseNotes: undefined };
    const lines = renderBootUpdateBox(status, PLAN_NPM_GLOBAL);
    const joined = lines.join('\n');
    expect(joined).not.toContain("What's new");
  });

  it('shows three-option footer with default-in-5s annotation', () => {
    const lines = renderBootUpdateBox(STATUS_UPDATE_AVAILABLE, PLAN_NPM_GLOBAL);
    const joined = lines.join('\n');
    expect(joined).toContain('Update now? (y/n/later)');
    expect(joined).toContain('y       — install to');
    expect(joined).toContain("n       — skip 4.5.1 (don't ask again)");
    expect(joined).toContain('later   — remind me next session (default in 5s)');
  });
});

describe('showBootUpdatePrompt — short-circuit paths', () => {
  it('renders guidance without offering or capturing y when preflight is unavailable', async () => {
    const display = mkDisplay();
    const plan: UpdateInstallPlan = {
      provenance: 'npm-global',
      scope: 'system',
      targetVersion: '4.5.1',
      installAllowed: false,
      reason: 'prefix-not-writable',
      prefix: 'C:\\Program Files\\nodejs',
      guidance: ['The configured prefix is not writable: C:\\Program Files\\nodejs'],
    };
    const choice = await showBootUpdatePrompt({
      status: STATUS_UPDATE_AVAILABLE,
      plan,
      display,
      isTTY: true,
      columns: 44,
    });
    expect(choice).toBe('unavailable');
    const output = display._lines.join('');
    expect(output).toContain('In-app update unavailable');
    expect(output).not.toContain('y       —');
    expect(output.split('\n').every((line) => line.length <= 44)).toBe(true);
  });

  it('returns "later" immediately when stdin is not a TTY', async () => {
    const display = mkDisplay();
    const choice = await showBootUpdatePrompt({
      status: STATUS_UPDATE_AVAILABLE,
      plan: PLAN_NPM_GLOBAL,
      display,
      isTTY: false,
    });
    expect(choice).toBe('later');
    // Nothing should have been rendered when we bailed early.
    expect(display._lines).toEqual([]);
  });

  it('returns "later" when no update is available', async () => {
    const display = mkDisplay();
    const status: UpdateStatus = { ...STATUS_UPDATE_AVAILABLE, updateAvailable: false };
    const choice = await showBootUpdatePrompt({
      status, plan: PLAN_NPM_GLOBAL, display, isTTY: true,
    });
    expect(choice).toBe('later');
    expect(display._lines).toEqual([]);
  });

  it('returns "later" when skipped=true (user already opted out for this version)', async () => {
    const display = mkDisplay();
    const status: UpdateStatus = { ...STATUS_UPDATE_AVAILABLE, skipped: true };
    const choice = await showBootUpdatePrompt({
      status, plan: PLAN_NPM_GLOBAL, display, isTTY: true,
    });
    expect(choice).toBe('later');
    expect(display._lines).toEqual([]);
  });

  it('test seam — _testChoice short-circuits and returns the supplied choice', async () => {
    const display = mkDisplay();
    const choice = await showBootUpdatePrompt({
      status: STATUS_UPDATE_AVAILABLE,
      plan: PLAN_NPM_GLOBAL,
      display,
      _testChoice: 'install',
    });
    expect(choice).toBe('install');
    // Test seam fires BEFORE rendering — nothing on display.
    expect(display._lines).toEqual([]);
  });
});
