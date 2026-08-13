/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserSnapshot.ts — `browser_snapshot` (v4.12 B1.1).
 *
 * Read-only accessibility snapshot: enumerates the page's interactive
 * elements as numbered refs (@e1, @e2, …) with role + accessible name,
 * grouped by frame. The raw DOM walk lives in playwrightBridge.pwAxSnapshot;
 * the numbered refs + ElementLease construction live in core/v4/browserState
 * (the lease store). B1.2 will let click/type/fill target these @eN refs.
 *
 * Status: B1.1 — perception only. Nothing about acting changes here.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { pwAxSnapshot, pwDialogPending, pwDialogRecent, pwFileEvents } from '../../../core/playwrightBridge';
import { formatAxSnapshot, projectStructuredForms } from '../../../core/v4/browserState';
import { currentBrowserLeaseStore } from '../../../core/v4/browser/browserLeaseScope';
import { sanitizeExtracted } from './redactContent';
import { withBrowserState } from './_observer';

const _browserSnapshotTool: ToolHandler = {
  schema: {
    name: 'browser_snapshot',
    description:
      'Capture a numbered list of the current page\'s interactive elements (buttons, links, inputs) as @e1, @e2, … with their ARIA role and accessible name, grouped by frame. Read-only. The @eN refs identify elements for later browser actions.',
    inputSchema: { type: 'object', properties: {} },
  },
  category: 'browser',
  mutates: false,
  toolset: 'browser',
  riskTier: 'safe',
  async execute() {
    const r = await pwAxSnapshot();
    if (!r.ok) return { success: false, error: r.error };
    const leases = currentBrowserLeaseStore().refresh(Date.now(), r.url ?? '', r.elements ?? []);
    // B5.1 — element names are page-derived: redact secrets + fence as untrusted.
    // The @eN refs stay intact (act-by-ref uses the store, not this text).
    const out: Record<string, unknown> = {
      success: true,
      count: leases.length,
      snapshot: sanitizeExtracted(formatAxSnapshot(leases)),
      forms: projectStructuredForms(leases),
    };
    // B4.2a — surface dialog + file-event state alongside the element list.
    const pending = pwDialogPending();
    const recent = pwDialogRecent();
    const files = pwFileEvents();
    if (pending) out.pending_dialog = pending;          // awaiting a browser_dialog response
    if (recent.length) out.recent_dialogs = recent;     // fired+settled since last snapshot
    if (files.length) out.file_events = files;          // file-chooser/download (passive)
    return out;
  },
};

// v4.3 observer HOC — consistent with every other browser tool.
export const browserSnapshotTool = withBrowserState(_browserSnapshotTool);
