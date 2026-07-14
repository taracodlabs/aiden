/** Central lifecycle owner for live CLI tool activity rows. */
import type { ToolRowHandle } from './display';
import { turnIdleDiagnostic } from './turnIdleDiagnostics';

export type ActivityState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface ActivityEntry {
  id: string;
  name: string;
  state: ActivityState;
  startedAt: number;
  handle: ToolRowHandle;
}

export type ActivityOutcome =
  | { state: 'completed'; retries?: number; dismiss?: boolean }
  | { state: 'failed'; retries?: number }
  | { state: 'cancelled'; dismiss?: boolean }
  | { state: 'blocked' }
  | { state: 'degraded'; reason?: string };

export class ActivityRegistry {
  private readonly entries = new Map<string, ActivityEntry>();
  private readonly terminalStates = new Map<string, ActivityState>();
  private modalDepth = 0;
  private static readonly MAX_TERMINAL_TOMBSTONES = 2_048;

  constructor(
    private readonly createRow: (name: string, args: unknown) => ToolRowHandle,
    private readonly now: () => number = Date.now,
  ) {}

  start(id: string, name: string, args: unknown): boolean {
    if (this.entries.has(id) || this.terminalStates.has(id)) return false;
    const entry: ActivityEntry = {
      id,
      name,
      state: 'pending',
      startedAt: this.now(),
      handle: this.createRow(name, args),
    };
    entry.state = 'running';
    this.entries.set(id, entry);
    if (this.modalDepth > 0) entry.handle.pause();
    turnIdleDiagnostic('activity.start', {
      id, name, activeCount: this.entries.size, modalDepth: this.modalDepth,
    });
    return true;
  }

  settle(id: string, outcome: ActivityOutcome): boolean {
    const entry = this.entries.get(id);
    if (!entry || this.terminalStates.has(id)) return false;
    p2aDiag('activity.settle.start', {
      id, name: entry.name, outcome: outcome.state,
      modalDepth: this.modalDepth, activeCount: this.entries.size,
    });
    this.entries.delete(id);
    const duration = Math.max(0, this.now() - entry.startedAt);
    if (outcome.state === 'completed') {
      entry.state = 'completed';
      this.rememberTerminal(id, entry.state);
      if (outcome.dismiss) entry.handle.dismiss();
      else entry.handle.ok(duration, outcome.retries ?? 0);
    } else if (outcome.state === 'failed') {
      entry.state = 'failed';
      this.rememberTerminal(id, entry.state);
      entry.handle.fail(duration, outcome.retries ?? 0);
    } else if (outcome.state === 'cancelled') {
      entry.state = 'cancelled';
      this.rememberTerminal(id, entry.state);
      if (outcome.dismiss) entry.handle.dismiss();
      else entry.handle.cancel(duration);
    } else if (outcome.state === 'blocked') {
      entry.state = 'failed';
      this.rememberTerminal(id, entry.state);
      entry.handle.blocked();
    } else {
      entry.state = 'completed';
      this.rememberTerminal(id, entry.state);
      entry.handle.degraded(duration, outcome.reason);
    }
    p2aDiag('activity.settle.complete', {
      id, state: entry.state, modalDepth: this.modalDepth,
      activeCount: this.entries.size,
    });
    turnIdleDiagnostic('activity.settle', {
      id, name: entry.name, state: entry.state,
      activeCount: this.entries.size, modalDepth: this.modalDepth,
    });
    return true;
  }

  pauseForModal(): void {
    this.modalDepth += 1;
    p2aDiag('activity.modal.pause', {
      modalDepth: this.modalDepth, activeCount: this.entries.size,
      activities: [...this.entries.values()].map((entry) => ({ id: entry.id, name: entry.name, state: entry.state })),
    });
    if (this.modalDepth !== 1) return;
    for (const entry of this.entries.values()) entry.handle.pause();
  }

  resumeAfterModal(): void {
    if (this.modalDepth === 0) return;
    this.modalDepth -= 1;
    p2aDiag('activity.modal.resume', {
      modalDepth: this.modalDepth, activeCount: this.entries.size,
      activities: [...this.entries.values()].map((entry) => ({ id: entry.id, name: entry.name, state: entry.state })),
    });
    if (this.modalDepth !== 0) return;
    for (const entry of this.entries.values()) entry.handle.resume();
  }

  async runModal<T>(run: () => Promise<T>): Promise<T> {
    this.pauseForModal();
    try {
      return await run();
    } finally {
      this.resumeAfterModal();
    }
  }

  sweep(): void {
    turnIdleDiagnostic('activity.sweep.start', {
      activeCount: this.entries.size, modalDepth: this.modalDepth,
    });
    for (const id of [...this.entries.keys()]) {
      this.settle(id, { state: 'cancelled', dismiss: true });
    }
    this.modalDepth = 0;
    turnIdleDiagnostic('activity.sweep.complete', {
      activeCount: this.entries.size, modalDepth: this.modalDepth,
    });
  }

  activeCount(): number { return this.entries.size; }
  timerCount(): number { return this.entries.size; }
  modalPauseDepth(): number { return this.modalDepth; }
  stateOf(id: string): ActivityState | null {
    return this.entries.get(id)?.state ?? this.terminalStates.get(id) ?? null;
  }

  private rememberTerminal(id: string, state: ActivityState): void {
    this.terminalStates.set(id, state);
    if (this.terminalStates.size <= ActivityRegistry.MAX_TERMINAL_TOMBSTONES) return;
    const oldest = this.terminalStates.keys().next().value as string | undefined;
    if (oldest !== undefined) this.terminalStates.delete(oldest);
  }
}

function p2aDiag(event: string, data: Record<string, unknown>): void {
  if (process.env.AIDEN_P2A_DIAG !== '1') return;
  try {
    const monoMs = Number(process.hrtime.bigint() / 1_000_000n);
    process.stderr.write(`[p2a] ${JSON.stringify({ monoMs, event, ...data })}\n`);
  } catch { /* diagnostics must never affect activity lifecycle */ }
}
