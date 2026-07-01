/**
 * tests/v4/mcp/install/clientPaths.test.ts — v4.9.0 Slice 2a.
 */
import { describe, it, expect } from 'vitest';
import { resolveClientPath } from '../../../../core/v4/mcp/install/clientPaths';

const HOME = '/home/u';
const APPDATA = 'C:\\Users\\u\\AppData\\Roaming';

describe('clientPaths — Slice 2a', () => {
  it('claude on macOS uses Library/Application Support', () => {
    const r = resolveClientPath('claude', { platform: 'darwin', homedir: HOME });
    // path.join on the host uses the host's separator, so compare via
    // forward-slash normalisation rather than literal slash.
    const norm = r.configPath.replace(/\\/g, '/');
    expect(norm).toContain('Library/Application Support/Claude');
    expect(norm).toContain('claude_desktop_config.json');
    expect(r.format).toBe('json');
    expect(r.displayName).toBe('Claude Desktop');
    expect(r.unsupportedOs).toBeFalsy();
  });

  it('claude on win32 uses APPDATA\\Claude', () => {
    const r = resolveClientPath('claude', {
      platform: 'win32',
      homedir:  'C:\\Users\\u',
      env:      { APPDATA },
    });
    expect(r.configPath).toContain('Claude');
    expect(r.configPath).toContain('claude_desktop_config.json');
    expect(r.format).toBe('json');
  });

  // v4.9.0 Slice 2a hotfix #1 — Windows-env regression guard.
  // Locks down the exact path layout shipped to Windows users: when
  // `process.env.APPDATA` is set to the canonical `C:\Users\<u>\AppData
  // \Roaming` form, the resolved parentDir matches the real Claude
  // Desktop install location byte-for-byte. The fielded bug report
  // turned out to be a stale-bin issue (published v4.8.0 doesn't have
  // `mcp init`) rather than a path resolver fault, but the test
  // remains as a sentinel against a future refactor that breaks this
  // case without notice.
  // Cross-platform: the resolved path SEGMENTS are correct on every host
  // (normalise separators before comparing — `path.join` uses the host's
  // separator, so a posix CI host yields `/` where win32 yields `\`).
  it('claude on win32: path segments match Claude Desktop layout (cross-platform)', () => {
    const r = resolveClientPath('claude', {
      platform: 'win32',
      homedir:  'C:\\Users\\shiva',
      env:      { APPDATA: 'C:\\Users\\shiva\\AppData\\Roaming' },
    });
    const normParent = r.parentDir.replace(/\\/g, '/');
    const normConfig = r.configPath.replace(/\\/g, '/');
    expect(normParent).toContain('AppData/Roaming/Claude');
    expect(normConfig).toContain('AppData/Roaming/Claude/claude_desktop_config.json');
    expect(r.unsupportedOs).toBeFalsy();
  });

  // Byte-for-byte backslash layout ONLY holds when `path.join` uses the win32
  // separator, i.e. on a win32 host. Gated to win32 so posix CI doesn't fail on
  // the host separator; the cross-platform segment check above covers all OSes.
  it.skipIf(process.platform !== 'win32')('claude on win32: exact byte-for-byte backslash path (win32 host only)', () => {
    const r = resolveClientPath('claude', {
      platform: 'win32',
      homedir:  'C:\\Users\\shiva',
      env:      { APPDATA: 'C:\\Users\\shiva\\AppData\\Roaming' },
    });
    expect(r.parentDir).toBe('C:\\Users\\shiva\\AppData\\Roaming\\Claude');
    expect(r.configPath).toBe(
      'C:\\Users\\shiva\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
    );
    expect(r.unsupportedOs).toBeFalsy();
  });

  it('claude on win32 falls back to homedir\\AppData\\Roaming when APPDATA env is unset (cross-platform segments)', () => {
    const r = resolveClientPath('claude', {
      platform: 'win32',
      homedir:  'C:\\Users\\u',
      env:      {},
    });
    // Fallback builds homedir + AppData/Roaming/Claude — verify the segments on
    // every host (normalised); the exact backslash form is checked below on win32.
    expect(r.parentDir.replace(/\\/g, '/')).toContain('C:/Users/u/AppData/Roaming/Claude');
  });

  it.skipIf(process.platform !== 'win32')('claude win32 APPDATA-unset fallback: exact backslash path (win32 host only)', () => {
    const r = resolveClientPath('claude', {
      platform: 'win32',
      homedir:  'C:\\Users\\u',
      env:      {},
    });
    expect(r.parentDir).toBe('C:\\Users\\u\\AppData\\Roaming\\Claude');
  });

  it('claude on linux flagged unsupportedOs', () => {
    const r = resolveClientPath('claude', { platform: 'linux', homedir: HOME });
    expect(r.unsupportedOs).toBe(true);
  });

  it('cursor uses ~/.cursor/mcp.json on every OS', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const r = resolveClientPath('cursor', { platform, homedir: HOME });
      expect(r.configPath).toContain('.cursor');
      expect(r.configPath).toContain('mcp.json');
      expect(r.format).toBe('jsonc');
    }
  });
});
