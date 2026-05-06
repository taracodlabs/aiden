/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserNavigate.ts — `browser_navigate` wrapper.
 *
 * Wraps `pwNavigate` from the v3 playwright bridge. Mutates because
 * navigating changes user-observable browser state (history, cookies,
 * outgoing requests).
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwNavigate, pwSnapshot } from '../../../core/playwrightBridge';
import { detectCaptchaMarkers } from './captchaCheck';

export const browserNavigateTool: ToolHandler = {
  schema: {
    name: 'browser_navigate',
    description:
      'Navigate the browser to a URL. Reuses the active tab; opens one if none exists. ' +
      'Returns success:false when the loaded page appears to be a CAPTCHA / bot challenge ' +
      '— in that case prefer `open_url` (real user profile, no detection).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Destination URL.' },
      },
      required: ['url'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!url) return { success: false, error: 'No URL provided' };
    const r = await pwNavigate(url);
    if (!r.ok) return { success: false, error: r.error, url };

    // Phase 16f Task 3: post-load CAPTCHA detection. Without this check
    // browser_navigate returned success:true on Cloudflare-walled pages
    // and the agent confidently said "search completed." Bias toward
    // sensitivity — false negatives caused the original bug; false
    // positives just nudge the agent to retry via open_url.
    try {
      const snap = await pwSnapshot();
      if (snap.ok && snap.text) {
        const check = detectCaptchaMarkers(snap.text);
        if (check.detected) {
          return {
            success: false,
            url: r.url,
            error:
              `Page appears to be a CAPTCHA / bot challenge ` +
              `(matched: ${check.markers.slice(0, 3).join(', ')}). ` +
              `Try open_url instead — it launches your real browser ` +
              `with your existing cookies/login state, no detection.`,
            captcha_detected: true,
            captcha_markers: check.markers,
          };
        }
      }
    } catch {
      // Snapshot failure is not a navigation failure. Fall through to
      // success — better to occasionally miss a CAPTCHA than to break
      // navigation when the snapshot path has an unrelated bug.
    }

    return { success: true, url: r.url };
  },
};
