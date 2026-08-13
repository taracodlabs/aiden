/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserDialog.ts — v4.12 B4.2a.
 *
 * Respond to a PARKED JS dialog (a spontaneous prompt held open by the dialog
 * supervisor, surfaced in browser_snapshot). action: accept | dismiss | respond
 * (respond carries `text` for a prompt — round-trips the actual string into page
 * JS). Accepting a destructive dialog is confirm-gated: the executor pre-classifies
 * browser_dialog accept/respond to the parked dialog's risk tier (B5.2 reuse).
 */
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwRespondDialog, pwDialogPending } from '../../../core/playwrightBridge';
import { withBrowserState } from './_observer';

const _browserDialogTool: ToolHandler = {
  schema: {
    name: 'browser_dialog',
    description:
      'Respond to a parked browser dialog (from browser_snapshot). action: "accept" | "dismiss" | "respond" (respond supplies "text" for a prompt). Accepting a destructive dialog is confirm-gated.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss', 'respond'], description: 'How to settle the dialog.' },
        text: { type: 'string', description: 'Prompt response text (for action="respond").' },
      },
      required: ['action'],
    },
  },
  category: 'browser',
  mutates: true,
  toolset: 'browser',
  riskTier: 'caution',
  buildPreview(args) {
    const pending = pwDialogPending();
    return {
      tool: 'browser_dialog',
      args,
      riskTier: pending?.tier ?? 'caution',
      sideEffects: [{ type: 'browser_action', action: 'dialog', target: String(args.action ?? '') }],
      detectedRisks: pending && pending.tier === 'dangerous' ? [pending.message] : [],
      summary: `Would ${String(args.action ?? 'respond to')} the ${pending?.type ?? ''} dialog: "${pending?.message ?? ''}"`,
    };
  },
  async execute(args) {
    const action = String(args.action ?? '');
    if (action !== 'accept' && action !== 'dismiss' && action !== 'respond') {
      return { success: false, error: 'action must be accept | dismiss | respond' };
    }
    const r = await pwRespondDialog(action, typeof args.text === 'string' ? args.text : undefined);
    return r.ok ? { success: true } : { success: false, error: r.error };
  },
};

export const browserDialogTool = withBrowserState(_browserDialogTool);
