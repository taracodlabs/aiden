/**
 * Phase 19 — CDP plugin Chrome binary detection tests.
 *
 * Uses the Phase 19 pure helper getChromeCandidatePaths(platform) to
 * verify the per-platform candidate set without needing fs spies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getChromeCandidatePaths } = require(
  '../../../plugins/aiden-plugin-cdp-browser/lib/chromeLauncher.js',
);

const ORIGINAL_PROGRAM_FILES = process.env.ProgramFiles;
const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
  process.env.ProgramFiles = 'C:\\Program Files';
  process.env.HOME = '/home/test';
});

afterEach(() => {
  if (ORIGINAL_PROGRAM_FILES !== undefined)
    process.env.ProgramFiles = ORIGINAL_PROGRAM_FILES;
  else delete process.env.ProgramFiles;
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
});

describe('Chrome binary detection — cross-platform', () => {
  it('13. macOS candidates include Chrome/Chromium/Brave/Edge in /Applications', () => {
    const candidates = getChromeCandidatePaths('darwin');
    expect(candidates).toContain(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    expect(candidates).toContain(
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
    expect(candidates).toContain(
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
    expect(candidates).toContain(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  });

  it('14. linux candidates include /usr/bin + /usr/local/bin variants', () => {
    const candidates = getChromeCandidatePaths('linux');
    expect(candidates).toContain('/usr/bin/google-chrome');
    expect(candidates).toContain('/usr/bin/google-chrome-stable');
    expect(candidates).toContain('/usr/bin/chromium');
    expect(candidates).toContain('/usr/local/bin/google-chrome');
    expect(candidates).toContain('/usr/bin/microsoft-edge');
  });

  it('15. linux candidates include Snap + Flatpak paths (Phase 19)', () => {
    const candidates = getChromeCandidatePaths('linux');
    expect(candidates).toContain('/snap/bin/chromium');
    expect(candidates).toContain('/snap/bin/google-chrome');
    expect(candidates).toContain(
      '/var/lib/flatpak/exports/bin/com.google.Chrome',
    );
    expect(candidates).toContain(
      '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    );
    // Per-user Flatpak path interpolates $HOME.
    expect(candidates).toContain(
      '/home/test/.local/share/flatpak/exports/bin/com.google.Chrome',
    );
  });

  it('16. windows candidates resolve from Program Files', () => {
    const candidates = getChromeCandidatePaths('win32');
    // Function uses path.join with Windows separators; on a non-Windows
    // host the join produces forward slashes, so test the substring.
    const chromeMatch = candidates.find(
      (c: string) =>
        c.includes('Google') &&
        c.includes('Chrome') &&
        c.toLowerCase().endsWith('chrome.exe'),
    );
    expect(chromeMatch).toBeDefined();
    const edgeMatch = candidates.find(
      (c: string) =>
        c.toLowerCase().endsWith('msedge.exe') && c.includes('Microsoft'),
    );
    expect(edgeMatch).toBeDefined();
  });

  it('17. unknown POSIX (freebsd) falls through to Linux candidates', () => {
    const candidates = getChromeCandidatePaths(
      'freebsd' as NodeJS.Platform,
    );
    expect(candidates).toContain('/usr/bin/google-chrome');
    expect(candidates).toContain('/snap/bin/chromium');
  });
});
