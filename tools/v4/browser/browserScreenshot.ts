/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserScreenshot.ts — `browser_screenshot` wrapper.
 *
 * Captures a screenshot of the current Playwright page. The bridge
 * (`core/playwrightBridge.ts`) maintains one persistent Chromium
 * context across all browser tools — no fresh browser is launched
 * per call. The screenshot file lives under `workspace/screenshots/`.
 *
 * Read-only because no DOM is mutated, even though the underlying
 * browser process is long-lived. The navigation tools (browserNavigate/
 * Click/Fill/Type/Scroll) DO mutate observable state and are gated by the
 * approval engine; this screenshot is not.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwScreenshot } from '../../../core/playwrightBridge';
import { withBrowserState } from './_observer';

const _browserScreenshotTool: ToolHandler = {
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
  riskTier: 'safe',   // v4.4 Phase 1
  async execute() {
    const r = await pwScreenshot();
    if (r.ok) return { success: true, path: r.path };
    return { success: false, error: r.error };
  },
};

// v4.3 Phase 1 — observer HOC.
export const browserScreenshotTool = withBrowserState(_browserScreenshotTool);
