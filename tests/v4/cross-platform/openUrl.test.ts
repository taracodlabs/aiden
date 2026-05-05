/**
 * Phase 19 — open_url platform-command tests.
 *
 * Pure unit tests against resolveOpenCommand. Verifies the Phase 16f
 * shape is still correct + cross-platform-symmetric.
 */
import { describe, it, expect } from 'vitest';
import { resolveOpenCommand } from '../../../tools/v4/web/openUrl';

describe('open_url — resolveOpenCommand', () => {
  const url = 'https://example.com/path?q=1';

  it('9. win32 uses cmd.exe /c start "" <url>', () => {
    const r = resolveOpenCommand('win32', url);
    expect(r.cmd).toBe('cmd.exe');
    expect(r.args).toEqual(['/c', 'start', '""', url]);
  });

  it('10. darwin uses open <url>', () => {
    const r = resolveOpenCommand('darwin', url);
    expect(r.cmd).toBe('open');
    expect(r.args).toEqual([url]);
  });

  it('11. linux uses xdg-open <url>', () => {
    const r = resolveOpenCommand('linux', url);
    expect(r.cmd).toBe('xdg-open');
    expect(r.args).toEqual([url]);
  });

  it('12. unknown POSIX (freebsd) falls through to xdg-open', () => {
    const r = resolveOpenCommand('freebsd' as NodeJS.Platform, url);
    expect(r.cmd).toBe('xdg-open');
    expect(r.args).toEqual([url]);
  });
});
