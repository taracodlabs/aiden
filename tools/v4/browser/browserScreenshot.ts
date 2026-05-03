/**
 * tools/v4/browser/browserScreenshot.ts — `browser_screenshot` wrapper.
 *
 * Captures a screenshot of the current Playwright page. The bridge
 * (`core/playwrightBridge.ts`) maintains one persistent Chromium
 * context across all browser tools — no fresh browser is launched
 * per call. The screenshot file lives under `workspace/screenshots/`.
 *
 * Read-only because no DOM is mutated, even though the underlying
 * browser process is long-lived. Phase 8 will add navigation tools
 * (which DO mutate observable state) behind the approval engine.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwScreenshot } from '../../../core/playwrightBridge';

export const browserScreenshotTool: ToolHandler = {
  schema: {
    name: 'browser_screenshot',
    description:
      'Take a screenshot of the current browser page (the page you previously navigated to). Saves to disk and returns the file path. Requires that the browser was opened earlier in this session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'browser',
  mutates: false,
  toolset: 'browser',
  async execute() {
    const r = await pwScreenshot();
    if (r.ok) return { success: true, path: r.path };
    return { success: false, error: r.error };
  },
};
