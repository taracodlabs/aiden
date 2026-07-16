/** Central lifecycle owner for live CLI tool activity rows. */
import type { LiveActivityRowHandle, ToolRowHandle } from './display';
import { turnIdleDiagnostic } from './turnIdleDiagnostics';
import type {
  ToolActivityPhase,
  ToolActivityTiming,
  ToolActivityUpdate,
  ToolTerminalClassification,
} from '../../providers/v4/types';

export type ActivityState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface ActivityEntry {
  id: string;
  name: string;
  state: ActivityState;
  lifecycleStartedAt: number;
  phase: ToolActivityPhase;
  phaseStartedAt: number;
  phasePausedAt?: number;
  phasePausedMs: number;
  timing?: ToolActivityTiming;
  repaintEligible: boolean;
  handle: ToolRowHandle;
}

export interface ModalActivityOptions<T> {
  /** Return false when the settled modal outcome makes the paused activity terminal. */
  resumeActivityWhen?: (result: T) => boolean;
}

export interface ActivitySnapshot {
  phase: ToolActivityPhase;
  phaseElapsedMs: number;
  lifecycleElapsedMs: number;
  approvalWaitMs: number;
  executionDurationMs: number;
  verificationDurationMs: number;
  retryBackoffMs: number;
  attemptCount: number;
  terminalClassification?: ToolTerminalClassification;
}

type TimingOutcome = { timing?: ToolActivityTiming };
export type ActivityOutcome = (
  | { state: 'completed'; retries?: number; dismiss?: boolean }
  | { state: 'failed'; retries?: number }
  | { state: 'cancelled'; dismiss?: boolean }
  | { state: 'blocked' }
  | { state: 'degraded'; reason?: string }
) & TimingOutcome;

export class ActivityRegistry {
  private readonly entries = new Map<string, ActivityEntry>();
  private readonly terminalStates = new Map<string, ActivityState>();
  private readonly pendingUpdates = new Map<string, ToolActivityUpdate>();
  private turnActivity?: LiveActivityRowHandle;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private tickerFrame = 0;
  private modalDepth = 0;
  private static readonly MAX_TERMINAL_TOMBSTONES = 2_048;

  constructor(
    private readonly createRow: (
      name: string,
      args: unknown,
      read: () => ActivitySnapshot,
    ) => ToolRowHandle,
    private readonly now: () => number = Date.now,
    private readonly createTurnRow?: (verb: string) => LiveActivityRowHandle,
  ) {}

  startTurnActivity(verb: string): boolean {
    if (this.turnActivity?.isActive() || !this.createTurnRow) return false;
    this.turnActivity = this.createTurnRow(verb);
    if (this.modalDepth > 0) this.turnActivity.pause();
    this.ensureTicker();
    return true;
  }

  setTurnPhase(verb: string): void {
    this.turnActivity?.setVerb(verb);
  }

  settleTurnActivity(): boolean {
    if (!this.turnActivity) return false;
    const row = this.turnActivity;
    this.turnActivity = undefined;
    row.stop();
    this.stopTickerIfIdle();
    return true;
  }

  invalidateLayout(): void {
    this.turnActivity?.invalidateLayout();
    for (const entry of this.entries.values()) entry.handle.refresh?.();
  }

  start(id: string, name: string, args: unknown): boolean {
    if (this.entries.has(id) || this.terminalStates.has(id)) return false;
    const pending = this.pendingUpdates.get(id);
    this.pendingUpdates.delete(id);
    const startedAt = pending?.timing?.dispatchStartedAt ?? this.now();
    const initialPhase = pending && pending.phase !== 'terminal' ? pending.phase : 'queued';
    const entry: ActivityEntry = {
      id,
      name,
      state: 'pending',
      lifecycleStartedAt: startedAt,
      phase: initialPhase,
      phaseStartedAt: pending?.at ?? startedAt,
      phasePausedMs: 0,
      timing: pending?.timing ? cloneTiming(pending.timing) : undefined,
      repaintEligible: true,
      handle: undefined as unknown as ToolRowHandle,
    };
    this.entries.set(id, entry);
    entry.handle = this.createRow(name, args, () => this.snapshot(id));
    entry.state = 'running';
    if (this.modalDepth > 0) entry.handle.pause();
    this.ensureTicker();
    turnIdleDiagnostic('activity.start', {
      id, name, activeCount: this.entries.size, modalDepth: this.modalDepth,
    });
    return true;
  }

  observe(id: string, update: ToolActivityUpdate): void {
    const entry = this.entries.get(id);
    if (!entry) {
      if (!this.terminalStates.has(id)) this.pendingUpdates.set(id, cloneUpdate(update));
      return;
    }
    if (update.timing) entry.timing = cloneTiming(update.timing);
    if (update.phase !== 'terminal') {
      entry.phase = update.phase;
      entry.phaseStartedAt = update.at;
      entry.phasePausedAt = this.modalDepth > 0 ? update.at : undefined;
      entry.phasePausedMs = 0;
    }
    entry.handle.refresh?.();
  }

  settle(id: string, outcome: ActivityOutcome): boolean {
    const entry = this.entries.get(id);
    if (!entry || this.terminalStates.has(id)) return false;
    p2aDiag('activity.settle.start', {
      id, name: entry.name, outcome: outcome.state,
      modalDepth: this.modalDepth, activeCount: this.entries.size,
    });
    this.entries.delete(id);
    if (outcome.timing) entry.timing = cloneTiming(outcome.timing);
    entry.phase = 'terminal';
    const summary = this.snapshotEntry(entry);
    const duration = summary.executionDurationMs;
    const dismiss = 'dismiss' in outcome && outcome.dismiss === true;
    if (dismiss) {
      entry.handle.dismiss();
    } else if (entry.handle.finish && entry.timing) {
      entry.handle.finish(summary);
    } else if (outcome.state === 'completed') {
      entry.handle.ok(duration, outcome.retries ?? 0, summary);
    } else if (outcome.state === 'failed') {
      entry.handle.fail(duration, outcome.retries ?? 0, summary);
    } else if (outcome.state === 'cancelled') {
      entry.handle.cancel(duration, summary);
    } else if (outcome.state === 'blocked') {
      entry.handle.blocked();
    } else {
      entry.handle.degraded(duration, outcome.reason, summary);
    }
    if (outcome.state === 'completed') {
      entry.state = 'completed';
      this.rememberTerminal(id, entry.state);
    } else if (outcome.state === 'failed') {
      entry.state = 'failed';
      this.rememberTerminal(id, entry.state);
    } else if (outcome.state === 'cancelled') {
      entry.state = 'cancelled';
      this.rememberTerminal(id, entry.state);
    } else if (outcome.state === 'blocked') {
      entry.state = 'failed';
      this.rememberTerminal(id, entry.state);
    } else {
      entry.state = 'completed';
      this.rememberTerminal(id, entry.state);
    }
    p2aDiag('activity.settle.complete', {
      id, state: entry.state, modalDepth: this.modalDepth,
      activeCount: this.entries.size,
    });
    turnIdleDiagnostic('activity.settle', {
      id, name: entry.name, state: entry.state,
      activeCount: this.entries.size, modalDepth: this.modalDepth,
    });
    this.stopTickerIfIdle();
    return true;
  }

  pauseForModal(): void {
    this.modalDepth += 1;
    p2aDiag('activity.modal.pause', {
      modalDepth: this.modalDepth, activeCount: this.entries.size,
      activities: [...this.entries.values()].map((entry) => ({ id: entry.id, name: entry.name, state: entry.state })),
    });
    if (this.modalDepth !== 1) return;
    this.stopTicker();
    const now = this.now();
    for (const entry of this.entries.values()) {
      entry.phasePausedAt ??= now;
      entry.handle.pause();
    }
    this.turnActivity?.pause();
  }

  resumeAfterModal(): void {
    if (this.modalDepth === 0) return;
    this.modalDepth -= 1;
    p2aDiag('activity.modal.resume', {
      modalDepth: this.modalDepth, activeCount: this.entries.size,
      activities: [...this.entries.values()].map((entry) => ({ id: entry.id, name: entry.name, state: entry.state })),
    });
    if (this.modalDepth !== 0) return;
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.phasePausedAt !== undefined) {
        entry.phasePausedMs += Math.max(0, now - entry.phasePausedAt);
        entry.phasePausedAt = undefined;
      }
      if (entry.repaintEligible) entry.handle.resume();
    }
    this.turnActivity?.resume();
    this.ensureTicker();
  }

  async runModal<T>(run: () => Promise<T>, options: ModalActivityOptions<T> = {}): Promise<T> {
    this.pauseForModal();
    try {
      const result = await run();
      if (options.resumeActivityWhen?.(result) === false) {
        // The modal result already made the paused operation terminal. Keep its
        // row paused until the normal tool callback records the exact outcome;
        // releasing the modal must not resurrect an older provider/tool frame.
        for (const entry of this.entries.values()) entry.repaintEligible = false;
        this.settleTurnActivity();
      }
      return result;
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
    this.settleTurnActivity();
    this.stopTicker();
    this.modalDepth = 0;
    this.pendingUpdates.clear();
    turnIdleDiagnostic('activity.sweep.complete', {
      activeCount: this.entries.size, modalDepth: this.modalDepth,
    });
  }

  activeCount(): number { return this.entries.size; }
  timerCount(): number { return this.ticker === null ? 0 : 1; }
  modalPauseDepth(): number { return this.modalDepth; }
  stateOf(id: string): ActivityState | null {
    return this.entries.get(id)?.state ?? this.terminalStates.get(id) ?? null;
  }

  snapshot(id: string): ActivitySnapshot {
    const entry = this.entries.get(id);
    if (!entry) {
      return {
        phase: 'terminal', phaseElapsedMs: 0, lifecycleElapsedMs: 0,
        approvalWaitMs: 0, executionDurationMs: 0, verificationDurationMs: 0,
        retryBackoffMs: 0, attemptCount: 0,
        terminalClassification: this.terminalStates.get(id) === 'cancelled' ? 'cancelled' : undefined,
      };
    }
    return this.snapshotEntry(entry);
  }

  private snapshotEntry(entry: ActivityEntry): ActivitySnapshot {
    const now = this.now();
    const phaseEnd = entry.phasePausedAt ?? now;
    const timing = entry.timing;
    const executionDurationMs = timing?.executionDurationMs ?? timing?.executionAttempts.reduce(
      (total, attempt) => total + Math.max(0, (attempt.endedAt ?? now) - attempt.startedAt), 0,
    ) ?? (entry.phase === 'running' ? Math.max(0, phaseEnd - entry.phaseStartedAt - entry.phasePausedMs) : 0);
    return {
      phase: entry.phase,
      phaseElapsedMs: Math.max(0, phaseEnd - entry.phaseStartedAt - entry.phasePausedMs),
      lifecycleElapsedMs: Math.max(0, now - entry.lifecycleStartedAt),
      approvalWaitMs: timing?.approvalWaitMs ?? (
        timing?.approvalStartedAt !== undefined && timing.approvalEndedAt !== undefined
          ? Math.max(0, timing.approvalEndedAt - timing.approvalStartedAt)
          : 0
      ),
      executionDurationMs,
      verificationDurationMs: timing?.verificationDurationMs ?? 0,
      retryBackoffMs: timing?.retryBackoffMs ?? 0,
      attemptCount: timing?.attemptCount ?? timing?.executionAttempts.length ?? 0,
      terminalClassification: timing?.terminalClassification,
    };
  }

  private rememberTerminal(id: string, state: ActivityState): void {
    this.terminalStates.set(id, state);
    if (this.terminalStates.size <= ActivityRegistry.MAX_TERMINAL_TOMBSTONES) return;
    const oldest = this.terminalStates.keys().next().value as string | undefined;
    if (oldest !== undefined) this.terminalStates.delete(oldest);
  }

  private ensureTicker(): void {
    if (this.ticker !== null || this.modalDepth > 0 || !this.hasRepaintableActivity()) return;
    this.ticker = setInterval(() => {
      this.tickerFrame = (this.tickerFrame + 1) % 4;
      this.turnActivity?.refresh(this.tickerFrame);
      if (this.tickerFrame === 0) {
        for (const entry of this.entries.values()) {
          if (entry.repaintEligible) entry.handle.refresh?.();
        }
      }
    }, 250);
    this.ticker.unref?.();
  }

  private stopTickerIfIdle(): void {
    if (!this.hasRepaintableActivity()) this.stopTicker();
  }

  private hasRepaintableActivity(): boolean {
    return !!this.turnActivity || [...this.entries.values()].some((entry) => entry.repaintEligible);
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    clearInterval(this.ticker);
    this.ticker = null;
    this.tickerFrame = 0;
  }
}

function cloneTiming(timing: ToolActivityTiming): ToolActivityTiming {
  return {
    ...timing,
    executionAttempts: timing.executionAttempts.map((attempt) => ({ ...attempt })),
  };
}

function cloneUpdate(update: ToolActivityUpdate): ToolActivityUpdate {
  return {
    ...update,
    timing: update.timing ? cloneTiming(update.timing) : undefined,
  };
}

function p2aDiag(event: string, data: Record<string, unknown>): void {
  if (process.env.AIDEN_P2A_DIAG !== '1') return;
  try {
    const monoMs = Number(process.hrtime.bigint() / 1_000_000n);
    process.stderr.write(`[p2a] ${JSON.stringify({ monoMs, event, ...data })}\n`);
  } catch { /* diagnostics must never affect activity lifecycle */ }
}
