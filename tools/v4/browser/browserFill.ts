/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserFill.ts — `browser_fill` wrapper.
 *
 * Fill multiple form fields in a single call. Internally fans out to
 * `pwType` per selector. Stops at the first failing selector and
 * reports which fields succeeded.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwType, pwActByLease } from '../../../core/playwrightBridge';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { withBrowserState } from './_observer';

const _browserFillTool: ToolHandler = {
  schema: {
    name: 'browser_fill',
    description:
      'Fill multiple form fields. Pass `fields` as an object mapping each field to its text — keys may be "@eN" refs (from browser_snapshot, preferred) or CSS selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description:
            'Object mapping "@eN" refs (preferred) or CSS selectors to the text to enter in each.',
        },
      },
      required: ['fields'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'caution',   // v4.4 Phase 1
  buildPreview(args) {
    const fields = (args.fields ?? {}) as Record<string, unknown>;
    const keys = fields && typeof fields === 'object' ? Object.keys(fields) : [];
    return {
      tool: 'browser_fill',
      args,
      riskTier: 'caution',
      sideEffects: [{ type: 'browser_action', action: 'fill', target: keys.join(', ') }],
      detectedRisks: [],
      summary: `Would fill ${keys.length} form field${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}`,
    };
  },
  async execute(args) {
    const fields = (args.fields ?? {}) as Record<string, unknown>;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return { success: false, error: 'fields must be an object' };
    }
    const filled: string[] = [];
    let verified = true;
    for (const [key, value] of Object.entries(fields)) {
      const text = value == null ? '' : String(value);
      // B1.2 — "@eN" keys resolve via the lease store; CSS keys use the old path.
      if (key.startsWith('@e')) {
        const lease = currentBrowserLeaseStore().get(key);
        if (!lease) {
          return { success: false, error: `Element ref ${key} is not in the current snapshot. Run browser_snapshot to refresh element refs, then retry.`, selector: key, filled };
        }
        const r = await pwActByLease(lease, { kind: 'fill', text });
        if (!r.ok) return { success: false, error: r.error, selector: key, filled };
        verified = verified && r.verified === true;
      } else {
        const r = await pwType(key, text);
        if (!r.ok) return { success: false, error: r.error, selector: key, filled };
        verified = verified && r.verified === true;
      }
      filled.push(key);
    }
    return { success: true, filled, count: filled.length, verified };
  },
};

// v4.3 Phase 1 — observer HOC.
export const browserFillTool = withBrowserState(_browserFillTool);
