/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserClick.ts — `browser_click` wrapper.
 *
 * Click an element by CSS selector or visible text. Pass
 * `target: "first_result"` for the search-result shortcut on
 * Google/YouTube/DuckDuckGo/Bing.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwClick, pwClickFirstResult, pwActByLease } from '../../../core/playwrightBridge';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { withBrowserState } from './_observer';

/** Shared @eN→lease error (B1.2). */
function staleRefError(ref: string): string {
  return `Element ref ${ref} is not in the current snapshot. Run browser_snapshot to refresh element refs, then retry.`;
}

const _browserClickTool: ToolHandler = {
  schema: {
    name: 'browser_click',
    description:
      'Click an element. Preferred: pass ref="@eN" from browser_snapshot. Or pass target as a CSS selector / visible text / "first_result" (first organic search result on supported engines).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Element ref from browser_snapshot, e.g. "@e3". Preferred addressing mode.',
        },
        target: {
          type: 'string',
          description: 'CSS selector, visible text, or "first_result". Used when ref is not given.',
        },
      },
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const ref = String(args.ref ?? '').trim();
    const target = ref || String(args.target ?? args.selector ?? '');
    return {
      tool: 'browser_click',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'browser_action', action: 'click', target }],
      detectedRisks: [],
      summary: `Would click browser element: ${target}`,
    };
  },
  async execute(args) {
    // B1.2 — ref-based addressing (additive; CSS/text path below is unchanged).
    const ref = String(args.ref ?? '').trim();
    if (ref) {
      const lease = currentBrowserLeaseStore().get(ref);
      if (!lease) return { success: false, error: staleRefError(ref) };
      const r = await pwActByLease(lease, { kind: 'click' });
      if (r.ok) return { success: true, ref };
      return { success: false, error: r.error, ref };
    }

    const target = String(args.target ?? args.selector ?? '').trim();
    if (!target) return { success: false, error: 'No target provided — pass ref="@eN" (from browser_snapshot) or a target selector.' };
    if (target === 'first_result') {
      const r = await pwClickFirstResult();
      if (r.ok) return { success: true, url: r.url };
      return { success: false, error: r.error };
    }
    const r = await pwClick(target);
    if (r.ok) return { success: true, target };
    return { success: false, error: r.error, target };
  },
};

// v4.3 Phase 1 — observer HOC captures pre/post page state when
// browser depth is enabled (default ON; opt-out via
// AIDEN_BROWSER_DEPTH=0) and embeds it as a `browserState` sidecar.
export const browserClickTool = withBrowserState(_browserClickTool);
