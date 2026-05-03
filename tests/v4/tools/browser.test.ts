import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../core/playwrightBridge', () => ({
  pwScreenshot: vi.fn(),
  pwSnapshot: vi.fn(),
  pwGetUrl: vi.fn(),
}));

import {
  pwScreenshot,
  pwSnapshot,
  pwGetUrl,
} from '../../../core/playwrightBridge';
import { browserScreenshotTool } from '../../../tools/v4/browser/browserScreenshot';
import { browserExtractTool } from '../../../tools/v4/browser/browserExtract';
import { browserGetUrlTool } from '../../../tools/v4/browser/browserGetUrl';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const ctx: ToolContext = {
  cwd: process.cwd(),
  paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-test-root' }),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('browser tools', () => {
  it('1. all three are categorised as browser, mutates=false, toolset=browser', () => {
    for (const tool of [
      browserScreenshotTool,
      browserExtractTool,
      browserGetUrlTool,
    ]) {
      expect(tool.category).toBe('browser');
      expect(tool.mutates).toBe(false);
      expect(tool.toolset).toBe('browser');
    }
  });

  it('2. browser_screenshot returns the bridge file path on success', async () => {
    (pwScreenshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      path: '/tmp/screenshot_123.png',
    });
    const result = (await browserScreenshotTool.execute({}, ctx)) as {
      success: boolean;
      path: string;
    };
    expect(result.success).toBe(true);
    expect(result.path).toBe('/tmp/screenshot_123.png');
  });

  it('3. browser_screenshot surfaces bridge errors', async () => {
    (pwScreenshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'no active page',
    });
    const result = (await browserScreenshotTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('no active page');
  });

  it('4. browser_extract returns visible text', async () => {
    (pwSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: 'page body',
    });
    const result = (await browserExtractTool.execute({}, ctx)) as {
      success: boolean;
      text: string;
    };
    expect(result.success).toBe(true);
    expect(result.text).toBe('page body');
  });

  it('5. browser_extract returns empty string when bridge gives no text', async () => {
    (pwSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
    });
    const result = (await browserExtractTool.execute({}, ctx)) as {
      success: boolean;
      text: string;
    };
    expect(result.success).toBe(true);
    expect(result.text).toBe('');
  });

  it('6. browser_get_url returns the current URL', async () => {
    (pwGetUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      url: 'https://example.com/page',
    });
    const result = (await browserGetUrlTool.execute({}, ctx)) as {
      success: boolean;
      url: string;
    };
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://example.com/page');
  });

  it('7. browser_get_url surfaces bridge error', async () => {
    (pwGetUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'no page',
    });
    const result = (await browserGetUrlTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('no page');
  });
});
