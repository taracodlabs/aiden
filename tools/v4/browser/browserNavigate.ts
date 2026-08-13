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
import { redactBrowserContent } from './redactContent';
import { withBrowserState } from './_observer';

const _browserNavigateTool: ToolHandler = {
  schema: {
    name: 'browser_navigate',
    description:
      'Navigate the browser to a URL. Reuses the active tab; opens one if none exists. ' +
      'Returns success:false when the loaded page appears to be a CAPTCHA / bot challenge ' +
      'and requests explicit user control instead of bypassing durable browser authority.',
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
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const url = String(args.url ?? '');
    return {
      tool: 'browser_navigate',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'browser_action', action: 'navigate', url }],
      detectedRisks: [],
      summary: `Would navigate browser to: ${url}`,
    };
  },
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!url) return { success: false, error: 'No URL provided' };
    const r = await pwNavigate(url);
    // B5.3 — redact any credential the URL embeds before it reaches the model.
    if (!r.ok) return { success: false, error: r.error, url: redactBrowserContent(url) };

    // Phase 16f Task 3: post-load CAPTCHA detection. Without this check
    // browser_navigate returned success:true on Cloudflare-walled pages
    // and the agent confidently said "search completed." Bias toward
    // sensitivity — false negatives caused the original bug; false
    // positives pause for explicit user control rather than switching to an
    // untracked browser path.
    try {
      const snap = await pwSnapshot();
      if (snap.ok && snap.text) {
        const check = detectCaptchaMarkers(snap.text);
        if (check.detected) {
          return {
            success: false,
            url: redactBrowserContent(r.url),
            error:
              `Page appears to be a CAPTCHA / bot challenge ` +
              `(matched: ${check.markers.slice(0, 3).join(', ')}). ` +
              `User control is required before this durable browser session can continue.`,
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

    return { success: true, url: redactBrowserContent(r.url) };
  },
};

// v4.3 Phase 1 — observer HOC.
export const browserNavigateTool = withBrowserState(_browserNavigateTool);
