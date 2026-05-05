/**
 * Phase 19 cross-platform path-resolution tests.
 *
 * Mocks process.platform and asserts resolveAidenRoot returns the
 * platform-correct root for each of Win / macOS / Linux. Includes the
 * Phase 19 Linux additions: XDG_CONFIG_HOME honoring, ~/.config/aiden
 * default, legacy ~/.aiden migration when present.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAidenRoot } from '../../../core/v4/paths';

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const ORIGINAL_AIDEN_HOME = process.env.AIDEN_HOME;

let tmpHome: string;

function mockPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-xplat-'));
  // Force os.homedir() to return tmpHome for deterministic tests.
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  delete process.env.AIDEN_HOME;
  delete process.env.LOCALAPPDATA;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  vi.restoreAllMocks();
  restorePlatform();
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_LOCALAPPDATA !== undefined)
    process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
  if (ORIGINAL_XDG !== undefined) process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  if (ORIGINAL_AIDEN_HOME !== undefined)
    process.env.AIDEN_HOME = ORIGINAL_AIDEN_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('resolveAidenRoot — Windows', () => {
  it('1. uses %LOCALAPPDATA%/aiden when LOCALAPPDATA is set', () => {
    mockPlatform('win32');
    process.env.LOCALAPPDATA = path.join(tmpHome, 'AppData', 'Local');
    const root = resolveAidenRoot();
    expect(root).toBe(path.join(tmpHome, 'AppData', 'Local', 'aiden'));
  });

  it('2. falls back to ~/AppData/Local/aiden when LOCALAPPDATA is unset', () => {
    mockPlatform('win32');
    delete process.env.LOCALAPPDATA;
    const root = resolveAidenRoot();
    expect(root).toBe(path.join(tmpHome, 'AppData', 'Local', 'aiden'));
  });
});

describe('resolveAidenRoot — macOS', () => {
  it('3. uses ~/Library/Application Support/aiden', () => {
    mockPlatform('darwin');
    const root = resolveAidenRoot();
    expect(root).toBe(
      path.join(tmpHome, 'Library', 'Application Support', 'aiden'),
    );
  });
});

describe('resolveAidenRoot — Linux + XDG', () => {
  it('4. defaults to ~/.config/aiden when XDG_CONFIG_HOME is unset', () => {
    mockPlatform('linux');
    const root = resolveAidenRoot();
    expect(root).toBe(path.join(tmpHome, '.config', 'aiden'));
  });

  it('5. honors XDG_CONFIG_HOME when set', () => {
    mockPlatform('linux');
    process.env.XDG_CONFIG_HOME = path.join(tmpHome, 'custom-xdg');
    const root = resolveAidenRoot();
    expect(root).toBe(path.join(tmpHome, 'custom-xdg', 'aiden'));
  });

  it('6. migration: prefers legacy ~/.aiden when it exists and XDG path does not', async () => {
    mockPlatform('linux');
    // Create the legacy dir; do not create the XDG path.
    await fs.mkdir(path.join(tmpHome, '.aiden'), { recursive: true });
    const root = resolveAidenRoot();
    expect(root).toBe(path.join(tmpHome, '.aiden'));
  });

  it('7. when both legacy and XDG paths exist, XDG wins (post-migration default)', async () => {
    mockPlatform('linux');
    await fs.mkdir(path.join(tmpHome, '.aiden'), { recursive: true });
    await fs.mkdir(path.join(tmpHome, '.config', 'aiden'), { recursive: true });
    const root = resolveAidenRoot();
    expect(root).toBe(path.join(tmpHome, '.config', 'aiden'));
  });

  it('8. AIDEN_HOME env override wins over everything (Linux)', () => {
    mockPlatform('linux');
    process.env.AIDEN_HOME = path.join(tmpHome, 'custom-aiden-root');
    process.env.XDG_CONFIG_HOME = path.join(tmpHome, 'should-be-ignored');
    const root = resolveAidenRoot();
    expect(root).toBe(path.join(tmpHome, 'custom-aiden-root'));
  });
});
