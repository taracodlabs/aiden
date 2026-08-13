/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwSetControl } from '../../../core/playwrightBridge';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { withBrowserState } from './_observer';

const OPERATIONS = ['check', 'uncheck', 'radio', 'select', 'choose', 'autocomplete'] as const;
type Operation = typeof OPERATIONS[number];

const _browserControlTool: ToolHandler = {
  schema: {
    name: 'browser_control',
    description: 'Set and verify a checkbox, radio, native select, custom option, or autocomplete without submitting the form.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
        selector: { type: 'string', description: 'CSS selector when ref is not supplied.' },
        operation: { type: 'string', enum: [...OPERATIONS] },
        value: { type: 'string', description: 'Option or autocomplete value.' },
      },
      required: ['operation'],
    },
  },
  category: 'browser', mutates: true, toolset: 'browser', riskTier: 'caution',
  buildPreview(args) {
    const target = String(args.ref ?? args.selector ?? 'control');
    return {
      tool: 'browser_control', args, riskTier: 'caution',
      sideEffects: [{ type: 'browser_action', action: String(args.operation ?? ''), target }],
      detectedRisks: [], summary: `Would ${String(args.operation ?? 'set')} ${target}`,
    };
  },
  async execute(args) {
    const operation = String(args.operation ?? '') as Operation;
    if (!OPERATIONS.includes(operation)) return { success: false, error: 'Unsupported control operation' };
    const ref = String(args.ref ?? '').trim();
    const lease = ref ? currentBrowserLeaseStore().get(ref) : undefined;
    if (ref && !lease) return { success: false, error: `Element ref ${ref} is stale. Run browser_snapshot before retrying.` };
    const selector = lease?.css_path ?? String(args.selector ?? '').trim();
    if (!selector) return { success: false, error: 'ref or selector is required' };
    const value = typeof args.value === 'string' ? args.value : undefined;
    if (['select', 'choose', 'autocomplete'].includes(operation) && !value) {
      return { success: false, error: `value is required for ${operation}` };
    }
    const result = await pwSetControl({ selector, operation, value });
    return result.ok
      ? { success: true, verified: result.verified === true, value: result.value, checked: result.checked }
      : { success: false, error: result.error, value: result.value, checked: result.checked };
  },
};

export const browserControlTool = withBrowserState(_browserControlTool);
