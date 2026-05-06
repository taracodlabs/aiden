/**
 * tests/v4/tools/openUrl.test.ts — Phase 16f Task 1E
 *
 * Locks platform-aware launch command resolution + URL validation.
 * Doesn't actually spawn a browser — that's interactive and tests
 * shouldn't pop windows. The execute() path is covered by the
 * integration smoke gate.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveOpenCommand,
  isLaunchableUrl,
  openUrlTool,
} from '../../../tools/v4/web/openUrl';

describe('open_url — platform launcher resolution', () => {
  it('uses cmd.exe /c start "" <url> on Windows', () => {
    const r = resolveOpenCommand('win32', 'https://example.com');
    expect(r.cmd).toBe('cmd.exe');
    expect(r.args).toEqual(['/c', 'start', '""', 'https://example.com']);
  });

  it('uses `open <url>` on macOS', () => {
    const r = resolveOpenCommand('darwin', 'https://example.com');
    expect(r.cmd).toBe('open');
    expect(r.args).toEqual(['https://example.com']);
  });

  it('uses xdg-open on Linux', () => {
    const r = resolveOpenCommand('linux', 'https://example.com');
    expect(r.cmd).toBe('xdg-open');
    expect(r.args).toEqual(['https://example.com']);
  });

  it('uses xdg-open as fallback for unknown platforms', () => {
    const r = resolveOpenCommand('freebsd' as NodeJS.Platform, 'https://example.com');
    expect(r.cmd).toBe('xdg-open');
  });
});

describe('open_url — URL validation', () => {
  it('accepts http and https URLs', () => {
    expect(isLaunchableUrl('https://example.com')).toBe(true);
    expect(isLaunchableUrl('http://localhost:3000/foo')).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(isLaunchableUrl('javascript:alert(1)')).toBe(false);
    expect(isLaunchableUrl('data:text/html,foo')).toBe(false);
    expect(isLaunchableUrl('file:///etc/passwd')).toBe(false);
    expect(isLaunchableUrl('ftp://example.com')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isLaunchableUrl('')).toBe(false);
    expect(isLaunchableUrl('not a url')).toBe(false);
    expect(isLaunchableUrl('//example.com')).toBe(false);
  });
});

describe('open_url — execute() validation surface', () => {
  it('returns success: false for an invalid URL without spawning', async () => {
    const r = (await openUrlTool.execute({ url: 'javascript:alert(1)' }, {} as any)) as any;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid URL/);
  });

  it('source uses shell:false for the launcher spawn (DEP0190)', async () => {
    // Phase 22 Task 9: explicit cmd.exe invocation makes shell:true
    // redundant on Windows AND tripped Node 22's deprecation. Source
    // assertion is the cheapest way to pin this without firing a real
    // browser-launching spawn from the test runner.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../../tools/v4/web/openUrl.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('shell: false');
    expect(src).not.toMatch(/shell:\s*process\.platform\s*===\s*['"]win32['"]/);
  });

  it('returns success: false for missing/empty url arg', async () => {
    const r = (await openUrlTool.execute({}, {} as any)) as any;
    expect(r.success).toBe(false);
  });

  it('schema declares url as required string', () => {
    expect(openUrlTool.schema.name).toBe('open_url');
    expect(openUrlTool.schema.inputSchema.required).toEqual(['url']);
    expect(openUrlTool.toolset).toBe('web');
    expect(openUrlTool.mutates).toBe(false);
  });
});
