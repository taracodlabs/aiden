/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserType.ts — `browser_type` wrapper.
 *
 * Type/fill text into a single input element identified by selector.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwType } from '../../../core/playwrightBridge';
import { pwActByLease } from '../../../core/playwrightBridge';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { withBrowserState } from './_observer';

const _browserTypeTool: ToolHandler = {
  schema: {
    name: 'browser_type',
    description:
      'Type text into a browser input. Preferred: pass ref="@eN" from browser_snapshot. Or pass a CSS selector. Replaces existing value.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Input element ref from browser_snapshot, e.g. "@e2". Preferred addressing mode.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the input field. Used when ref is not given.',
        },
        text: { type: 'string', description: 'Text to enter.' },
      },
      required: ['text'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const target = String(args.ref ?? '').trim() || String(args.selector ?? 'input');
    const text = String(args.text ?? '');
    return {
      tool: 'browser_type',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'browser_action', action: 'type', target }],
      detectedRisks: [],
      summary: `Would type ${text.length} chars into ${target}`,
    };
  },
  async execute(args) {
    const text = String(args.text ?? '');
    // B1.2 — ref-based addressing (additive; selector path below unchanged).
    const ref = String(args.ref ?? '').trim();
    if (ref) {
      const lease = currentBrowserLeaseStore().get(ref);
      if (!lease) {
        return { success: false, error: `Element ref ${ref} is not in the current snapshot. Run browser_snapshot to refresh element refs, then retry.` };
      }
      const r = await pwActByLease(lease, { kind: 'fill', text });
      if (r.ok) return { success: true, ref, value: r.value, verified: r.verified === true };
      return { success: false, error: r.error, ref };
    }

    const selector = String(args.selector ?? 'input').trim();
    const r = await pwType(selector, text);
    if (r.ok) return { success: true, selector, value: r.value, verified: r.verified === true };
    return { success: false, error: r.error, selector };
  },
};

// v4.3 Phase 1 — observer HOC captures pre/post page state.
export const browserTypeTool = withBrowserState(_browserTypeTool);
