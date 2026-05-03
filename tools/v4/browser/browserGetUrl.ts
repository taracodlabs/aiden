/**
 * tools/v4/browser/browserGetUrl.ts — `browser_get_url` wrapper.
 *
 * Returns the URL of the current Playwright page. Cheap; the agent
 * uses it to verify it ended up where it expected after a click.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwGetUrl } from '../../../core/playwrightBridge';

export const browserGetUrlTool: ToolHandler = {
  schema: {
    name: 'browser_get_url',
    description:
      'Return the URL of the page currently loaded in the browser. Useful for verifying navigation succeeded after a click.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'browser',
  mutates: false,
  toolset: 'browser',
  async execute() {
    const r = await pwGetUrl();
    if (r.ok) return { success: true, url: r.url ?? '' };
    return { success: false, error: r.error };
  },
};
