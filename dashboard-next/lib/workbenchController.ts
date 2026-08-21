/**
 * Workbench application state is deliberately smaller than the durable runtime.
 * It owns navigation and presentation intent only; Job/Attempt truth remains in
 * the bridge projections.
 */

import type { TaskAdmission } from './aidenClient';

export interface WorkbenchSelection {
  sessionId: string | null;
  jobId: string | null;
  attemptId: string | null;
  runId: number | null;
}

export interface ActiveJobView extends WorkbenchSelection {
  status:
    | 'queued' | 'running' | 'waiting' | 'approval_required' | 'paused'
    | 'cancelling' | 'recovering' | 'blocked' | 'state_unknown' | 'terminal';
  updatedAt: number;
  title?: string;
  statusDetail?: string;
}

const ACTIVE_STATUSES = new Set<ActiveJobView['status']>([
  'queued', 'running', 'waiting', 'approval_required', 'paused', 'cancelling',
  'recovering', 'blocked', 'state_unknown', 'terminal',
]);

export function normalizeActiveJobStatus(value: string): ActiveJobView['status'] {
  return ACTIVE_STATUSES.has(value as ActiveJobView['status'])
    ? value as ActiveJobView['status']
    : 'state_unknown';
}

/** Only durable states that can still produce foreground execution updates may
 * own the composer lock. Blocked and uncertain Jobs remain visible in Active
 * Work, but they are not evidence that a process is still executing. */
export function isForegroundExecutionStatus(status: ActiveJobView['status']): boolean {
  return status !== 'blocked' && status !== 'state_unknown' && status !== 'terminal';
}

export function foregroundExecutionCount(jobs: readonly ActiveJobView[]): number {
  return jobs.filter((job) => isForegroundExecutionStatus(job.status)).length;
}

export interface WorkbenchControllerSnapshot {
  selected: WorkbenchSelection;
  activeJobs: ActiveJobView[];
  selectionGeneration: number;
}

export function emptySelection(sessionId: string | null = null): WorkbenchSelection {
  return { sessionId, jobId: null, attemptId: null, runId: null };
}

export function shouldAttachAdmission(
  selection: WorkbenchSelection,
  requestSessionId: string,
): boolean {
  return selection.sessionId === requestSessionId && selection.jobId === null;
}

export function selectionFromSearch(search: string): WorkbenchSelection {
  const query = new URLSearchParams(search);
  const jobId = query.get('job') || null;
  const attemptId = jobId ? (query.get('attempt') || null) : null;
  const run = query.get('run');
  const runId = run === null ? null : Number(run);
  return {
    sessionId: query.get('session') || null,
    jobId,
    attemptId,
    runId: jobId && attemptId && Number.isSafeInteger(runId) && (runId as number) >= 0 ? runId : null,
  };
}

export function selectionToSearch(selection: WorkbenchSelection): string {
  const query = new URLSearchParams();
  if (selection.sessionId) query.set('session', selection.sessionId);
  if (selection.jobId) query.set('job', selection.jobId);
  if (selection.attemptId) query.set('attempt', selection.attemptId);
  if (selection.runId !== null) query.set('run', String(selection.runId));
  const value = query.toString();
  return value ? `?${value}` : '';
}

function sameSelection(a: WorkbenchSelection, b: WorkbenchSelection): boolean {
  return a.sessionId === b.sessionId && a.jobId === b.jobId
    && a.attemptId === b.attemptId && a.runId === b.runId;
}

/** Small, synchronous foreground controller. It never writes durable state. */
export class WorkbenchController {
  private selected: WorkbenchSelection = emptySelection();
  private readonly jobs = new Map<string, ActiveJobView>();
  private generation = 0;
  private revision = 0;

  private tick(): number { return Date.now() * 1000 + (++this.revision); }

  snapshot(): WorkbenchControllerSnapshot {
    return {
      selected: { ...this.selected },
      activeJobs: Array.from(this.jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt),
      selectionGeneration: this.generation,
    };
  }

  select(next: WorkbenchSelection): number {
    if (!sameSelection(this.selected, next)) this.generation += 1;
    this.selected = { ...next };
    return this.generation;
  }

  newChat(sessionId: string | null = null): number {
    return this.select(emptySelection(sessionId));
  }

  selectedFor(sessionId: string | null): boolean {
    return this.selected.sessionId === sessionId;
  }

  isCurrent(generation: number, selection: WorkbenchSelection = this.selected): boolean {
    return generation === this.generation && sameSelection(selection, this.selected);
  }

  register(admission: TaskAdmission, sessionId: string | null, title?: string): void {
    this.registerView({
      sessionId, jobId: admission.jobId, attemptId: admission.attemptId,
      runId: admission.runId, status: 'queued', updatedAt: this.tick(), title,
    });
  }

  registerView(view: ActiveJobView): void {
    this.jobs.set(view.jobId, { ...view, updatedAt: view.updatedAt || this.tick() });
  }

  reconcileActive(views: ActiveJobView[]): void {
    const incoming = new Set(views.map((view) => view.jobId));
    for (const jobId of Array.from(this.jobs.keys())) {
      if (!incoming.has(jobId)) this.jobs.delete(jobId);
    }
    for (const view of views) this.registerView(view);
  }

  update(jobId: string, status: ActiveJobView['status']): void {
    const current = this.jobs.get(jobId);
    if (current) this.jobs.set(jobId, { ...current, status, updatedAt: this.tick() });
  }

  settle(jobId: string): void {
    const current = this.jobs.get(jobId);
    if (current) this.jobs.set(jobId, { ...current, status: 'terminal', updatedAt: this.tick() });
  }

  active(): ActiveJobView[] {
    return Array.from(this.jobs.values())
      .filter((job) => job.status !== 'terminal')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  isSelectedJob(jobId: string | null): boolean {
    return !!jobId && this.selected.jobId === jobId;
  }
}
