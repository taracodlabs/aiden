import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../core/tools/nowPlaying', () => ({
  getNowPlaying: vi.fn(),
}));

import { getNowPlaying } from '../../../core/tools/nowPlaying';
import { systemInfoTool } from '../../../tools/v4/system/systemInfo';
import { nowPlayingTool } from '../../../tools/v4/system/nowPlaying';
import { naturalEventsTool } from '../../../tools/v4/system/naturalEvents';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const ctx: ToolContext = {
  cwd: process.cwd(),
  paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-test-root' }),
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('system tools', () => {
  it('1. system_info returns an info object with CPU/OS/User keys', async () => {
    const result = (await systemInfoTool.execute({}, ctx)) as {
      success: boolean;
      info: Record<string, unknown>;
    };
    expect(result.success).toBe(true);
    expect(result.info).toBeDefined();
    // Both branches (Windows JSON, posix object) populate CPU/OS/User.
    expect(result.info).toHaveProperty('CPU');
    expect(result.info).toHaveProperty('OS');
    expect(result.info).toHaveProperty('User');
  });

  it('2. now_playing delegates to getNowPlaying and merges its payload', async () => {
    (getNowPlaying as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      isPlaying: true,
      app: 'Spotify',
      title: 'Test',
      artist: 'Test Artist',
    });
    const result = (await nowPlayingTool.execute({}, ctx)) as {
      success: boolean;
      isPlaying: boolean;
      app: string;
      title: string;
    };
    expect(result.success).toBe(true);
    expect(result.isPlaying).toBe(true);
    expect(result.app).toBe('Spotify');
    expect(result.title).toBe('Test');
  });

  it('3. now_playing returns error when underlying throws', async () => {
    (getNowPlaying as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('SMTC unavailable'),
    );
    const result = (await nowPlayingTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('SMTC unavailable');
  });

  it('4. get_natural_events normalises the EONET payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        events: [
          {
            id: 'EONET_1',
            title: 'Wildfire',
            categories: [{ title: 'Wildfires' }],
            geometry: [{ date: '2026-05-01' }],
            sources: [{ url: 'https://example.com/x' }],
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const result = (await naturalEventsTool.execute({ limit: 5 }, ctx)) as {
      success: boolean;
      count: number;
      events: { id: string; title: string; category: string; date: string; link: string }[];
    };
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.events[0]).toEqual({
      id: 'EONET_1',
      title: 'Wildfire',
      category: 'Wildfires',
      date: '2026-05-01',
      link: 'https://example.com/x',
    });
  });

  it('5. get_natural_events returns error when EONET responds with non-OK', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
    }) as unknown as typeof fetch;
    const result = (await naturalEventsTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/EONET/);
  });
});
