/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/frame/composerModel.ts — the ONE composer's state → view mapping.
 *
 * Idle and busy use the SAME composer component; only the SUBMIT POLICY and the
 * plain-language HINT differ. This pure function derives both from the frame
 * state, so the Ink component just renders what it returns — no idle-vs-busy
 * branching in the view. Reusable by the future dashboard's composer too.
 */

/** What pressing Enter does right now. */
export type SubmitPolicy = 'send' | 'queue' | 'steer' | 'stop';

export interface ComposerView {
  /** The plain-language hint line under the input (never cryptic tokens). */
  hint:   string;
  /** What Enter does now — the caller wires it to the real action. */
  submit: SubmitPolicy;
}

const ENTER_ACTION: Record<'queue' | 'interrupt' | 'redirect', SubmitPolicy> = {
  queue: 'queue', interrupt: 'stop', redirect: 'steer',
};

/**
 * Derive the composer view. IDLE → send + calm hint. BUSY → the active mode's
 * Enter action + steering hint (Ctrl+Enter always queues; Ctrl+C always stops).
 * PAUSED (busy) → a resume-first hint, Enter still does the mode action.
 */
export function composerView(opts: {
  phase:    'idle' | 'busy';
  busyMode: 'queue' | 'interrupt' | 'redirect';
  paused:   boolean;
}): ComposerView {
  if (opts.phase === 'idle') {
    return { submit: 'send', hint: 'Type your message · /help · /mode to change' };
  }
  const submit = ENTER_ACTION[opts.busyMode];
  if (opts.paused) {
    return { submit, hint: 'Paused · /resume to continue · Ctrl+C stop' };
  }
  return { submit, hint: `Enter → ${submit} · Ctrl+Enter queue · Ctrl+C stop` };
}
