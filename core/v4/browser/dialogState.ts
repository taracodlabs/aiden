/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/browser/dialogState.ts — v4.12 B4.2a (dialog / file-event supervisor).
 *
 * JS dialogs (alert/confirm/prompt/beforeunload) block the page thread and wedge
 * automation. Playwright auto-dismisses them UNLESS a 'dialog' listener handles
 * them — so the bridge registers one that routes through this supervisor.
 *
 * Model (the dialog event data shape, no thread): pending + recent-history + policy.
 *   - alert                       → accept (nothing to decide).
 *   - ARMED (an Aiden action that already passed B5.2 is in-flight, OR the model
 *     pre-supplied a prompt response) → accept (consent inherited).
 *   - spontaneous confirm/beforeunload → dismiss (conservative).
 *   - spontaneous prompt          → PARK (hold open) for a browser_dialog response;
 *     a watchdog dismisses it so the JS thread never wedges.
 *
 * file-chooser / download events are recorded PASSIVELY here (detect + surface) —
 * never auto-fulfilled; uploading/saving is a separate consent-gated action.
 */
import { classifyDialog } from '../browserState';

export interface DialogRecord {
  type: string;
  message: string;
  tier: 'safe' | 'caution' | 'dangerous';
  outcome: 'accepted' | 'dismissed' | 'pending';
  responseText?: string;
  error?: string; // settle failure (e.g. the dialog was already gone) — observability
}
export interface FileEventRecord { kind: 'filechooser' | 'download'; info: string }

const RECENT_CAP = 10;
const WATCHDOG_MS = 30_000;
const ARM_WINDOW_MS = 1_500; // a triggered dialog fires synchronously, well within this

class DialogSupervisor {
  private pending: { dialog: any; rec: DialogRecord; watchdog: any } | null = null;
  private recent: DialogRecord[] = [];
  private fileEvents: FileEventRecord[] = [];
  private armedUntil = 0;                    // window during which a dialog is action-caused
  private preArmedText: string | null = null; // model pre-supplied a prompt response

  // A mutating Aiden action (already B5.2-approved) opens a short window: a dialog
  // it triggers fires synchronously (within ms), so it's classified action-caused
  // and inherits the consent. A later spontaneous dialog falls outside the window.
  arm(): void { this.armedUntil = Date.now() + ARM_WINDOW_MS }
  disarm(): void { this.armedUntil = 0 }
  private isArmed(): boolean { return Date.now() < this.armedUntil }
  setPromptResponse(text: string | null): void { this.preArmedText = text }

  /** The page.on('dialog') handler — ALWAYS settles the dialog (or parks it). */
  async handle(dialog: any): Promise<void> {
    let type = 'dialog'; let message = '';
    try { type = dialog.type(); message = dialog.message(); } catch { /* race */ }
    const { tier } = classifyDialog(type, message);
    const rec: DialogRecord = { type, message, tier, outcome: 'pending' };

    if (type === 'alert') { await this.settle(dialog, rec, 'accept'); return }

    if (type === 'prompt' && this.preArmedText !== null) {
      const t = this.preArmedText; this.preArmedText = null;
      await this.settle(dialog, rec, 'accept', t); return;
    }
    if (this.isArmed()) {
      // action-armed: accept (prompt with no pre-armed text proceeds with '').
      await this.settle(dialog, rec, 'accept', type === 'prompt' ? '' : undefined); return;
    }
    if (type === 'prompt') {
      // spontaneous prompt → PARK for browser_dialog; watchdog dismisses on timeout.
      const watchdog = setTimeout(() => { void this.settle(dialog, rec, 'dismiss').catch(() => {}); this.pending = null; }, WATCHDOG_MS);
      this.pending = { dialog, rec, watchdog };
      return;
    }
    await this.settle(dialog, rec, 'dismiss'); // spontaneous confirm/beforeunload
  }

  private async settle(dialog: any, rec: DialogRecord, action: 'accept' | 'dismiss', text?: string): Promise<void> {
    try {
      if (action === 'accept') {
        await (text === undefined ? dialog.accept() : dialog.accept(text));
        rec.outcome = 'accepted';
        if (text !== undefined) rec.responseText = text;
      } else {
        await dialog.dismiss();
        rec.outcome = 'dismissed';
      }
    } catch (e: any) { rec.error = e?.message ?? String(e) }
    this.recent.unshift(rec);
    if (this.recent.length > RECENT_CAP) this.recent.pop();
  }

  /** browser_dialog tool → respond to the PARKED pending dialog (round-trip). */
  async respond(action: 'accept' | 'dismiss' | 'respond', text?: string): Promise<{ ok: boolean; error?: string; tier?: string }> {
    if (!this.pending) return { ok: false, error: 'No pending dialog to respond to.' };
    const { dialog, rec, watchdog } = this.pending;
    clearTimeout(watchdog);
    this.pending = null;
    if (action === 'dismiss') { await this.settle(dialog, rec, 'dismiss'); return { ok: true, tier: rec.tier } }
    await this.settle(dialog, rec, 'accept', action === 'respond' ? (text ?? '') : undefined);
    return { ok: true, tier: rec.tier };
  }

  /** Tier of the currently parked dialog (for the executor's B5.2 gate on accept). */
  pendingTier(): 'safe' | 'caution' | 'dangerous' | null { return this.pending?.rec.tier ?? null }
  getPending(): DialogRecord | null { return this.pending?.rec ?? null }
  getRecent(): DialogRecord[] { return [...this.recent] }

  // ── file-chooser / download: PASSIVE record only (never auto-fulfill) ──
  recordFileEvent(kind: 'filechooser' | 'download', info: string): void {
    this.fileEvents.unshift({ kind, info });
    if (this.fileEvents.length > RECENT_CAP) this.fileEvents.pop();
  }
  getFileEvents(): FileEventRecord[] { return [...this.fileEvents] }

  clear(): void {
    if (this.pending?.watchdog) clearTimeout(this.pending.watchdog);
    this.pending = null; this.recent = []; this.fileEvents = [];
    this.armedUntil = 0; this.preArmedText = null;
  }
}

const _supervisors = new Map<string, DialogSupervisor>();
export function getDialogSupervisor(browserSessionId = 'legacy'): DialogSupervisor {
  let supervisor = _supervisors.get(browserSessionId);
  if (!supervisor) {
    supervisor = new DialogSupervisor();
    _supervisors.set(browserSessionId, supervisor);
  }
  return supervisor;
}

export function clearDialogSupervisors(): void {
  for (const supervisor of _supervisors.values()) supervisor.clear();
  _supervisors.clear();
}
