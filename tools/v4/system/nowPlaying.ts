/**
 * tools/v4/system/nowPlaying.ts — `now_playing` wrapper.
 *
 * Wraps v3 `getNowPlaying()` which queries Windows
 * GlobalSystemMediaTransportControlsSessionManager via PowerShell
 * WinRT bridge. Picks up Spotify, YouTube-in-browser, Windows
 * Media Player, and any SMTC-registered app. Returns
 * `{ isPlaying: false }` on platforms / setups where SMTC is
 * unavailable rather than throwing.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { getNowPlaying } from '../../../core/tools/nowPlaying';

export const nowPlayingTool: ToolHandler = {
  schema: {
    name: 'now_playing',
    description:
      'Get the currently playing media (song, artist, app). Reads the live Windows MediaSession — call whenever the user asks what is playing, whether music is paused, or what track is on.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'system',
  async execute() {
    try {
      const result = await getNowPlaying();
      return { success: true, ...result };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
