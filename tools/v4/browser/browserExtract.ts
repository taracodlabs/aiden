/**
 * tools/v4/browser/browserExtract.ts — `browser_extract` wrapper.
 *
 * Returns the visible text of the current page (Playwright's
 * `page.locator('body').innerText()`). Stale state is the agent's
 * problem — if the page hasn't been navigated, it returns whatever
 * was loaded last. Read-only as far as DOM and network go.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwSnapshot } from '../../../core/playwrightBridge';

export const browserExtractTool: ToolHandler = {
  schema: {
    name: 'browser_extract',
    description:
      'Extract the visible text content of the current browser page. Requires the browser to be on a page (navigate first using a Phase-8 navigation tool, or via the search-then-click flow).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'browser',
  mutates: false,
  toolset: 'browser',
  async execute() {
    const r = await pwSnapshot();
    if (r.ok) return { success: true, text: r.text ?? '' };
    return { success: false, error: r.error };
  },
};
