import type { SystemReadinessItem, SystemReadinessProjection, WorkbenchArtifact } from './aidenClient';

export type WorkbenchAppearance = 'system' | 'light' | 'dark' | 'midnight' | 'warm';
export type WorkbenchDensity = 'comfortable' | 'compact';

export const APPEARANCE_OPTIONS: ReadonlyArray<{
  id: WorkbenchAppearance;
  label: string;
  detail: string;
}> = [
  { id: 'system', label: 'System', detail: 'Follow your operating-system appearance.' },
  { id: 'light', label: 'Light', detail: 'A warm, readable workspace for bright rooms.' },
  { id: 'dark', label: 'Dark', detail: 'Aiden’s balanced dark workspace.' },
  { id: 'midnight', label: 'Midnight', detail: 'An OLED-friendly near-black workspace.' },
  { id: 'warm', label: 'Warm', detail: 'A softer charcoal workspace with warm surfaces.' },
] as const;

export function normalizeAppearance(value: unknown): WorkbenchAppearance {
  return APPEARANCE_OPTIONS.some((option) => option.id === value) ? value as WorkbenchAppearance : 'system';
}

export function normalizeDensity(value: unknown): WorkbenchDensity {
  return value === 'compact' ? 'compact' : 'comfortable';
}

export function detectWorkbenchLocale(input?: { timeZone?: string; locale?: string }): { timeZone: string; locale: string } {
  const resolved = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions() : undefined;
  const timeZone = input?.timeZone?.trim() || resolved?.timeZone?.trim() || 'UTC';
  const locale = input?.locale?.trim() || resolved?.locale?.trim() || 'en';
  return { timeZone, locale };
}

export type SanitizedDiagnosticInput = {
  runtimeVersion: string;
  connection: string;
  provider: string;
  model: string;
  executionAvailable: boolean;
  queue: { pending: number; claimed: number; inflight: number; workerCount: number };
  readiness: SystemReadinessProjection;
};

export function buildSanitizedDiagnosticSummary(input: SanitizedDiagnosticInput): string {
  const readiness = input.readiness.items.map((item) => (
    `${item.title ?? item.id}: ${item.ready || item.healthy ? 'ready' : 'needs attention'}`
  ));
  return [
    'Aiden Workbench diagnostic summary',
    `Runtime: ${input.runtimeVersion || 'unknown'}`,
    `Connection: ${input.connection || 'unknown'}`,
    `Provider: ${input.provider || 'not configured'}`,
    `Model: ${input.model || 'not configured'}`,
    `Execution: ${input.executionAvailable ? 'available' : 'unavailable'}`,
    `Queue: ${input.queue.inflight} running, ${input.queue.pending} pending, ${input.queue.claimed} claimed, ${input.queue.workerCount} workers`,
    `Readiness: ${input.readiness.overall}`,
    ...readiness,
  ].join('\n');
}

export function presentReadinessSummary(readiness: SystemReadinessProjection): {
  title: string;
  detail: string;
  tone: 'ready' | 'attention';
} {
  const required = readiness.items.filter((item) => item.blocking && !item.ready);
  const optional = readiness.items.filter((item) => !item.blocking && !item.ready);
  if (required.length > 0 || readiness.overall === 'needs_attention') {
    const count = required.length || readiness.issues.filter((item) => item.blocking).length;
    return {
      title: 'Needs action',
      detail: `${count || 1} required ${count === 1 ? 'item needs' : 'items need'} your attention`,
      tone: 'attention',
    };
  }
  return {
    title: 'Ready to use',
    detail: optional.length === 0
      ? 'Core features are ready'
      : `${optional.length} optional ${optional.length === 1 ? 'feature is' : 'features are'} not set up`,
    tone: 'ready',
  };
}

export type StarterAction = {
  id: 'codebase' | 'research' | 'browser' | 'apps';
  title: string;
  detail: string;
  prompt: string;
  available: boolean;
  setup: { settings: 'coding' | 'runtime' } | { view: 'apps' } | null;
};

function readinessById(items: readonly SystemReadinessItem[], id: string): SystemReadinessItem | undefined {
  return items.find((item) => item.id === id);
}

export function projectStarterActions(items: readonly SystemReadinessItem[]): StarterAction[] {
  const coding = readinessById(items, 'coding-provider');
  const browser = readinessById(items, 'browser');
  const apps = readinessById(items, 'apps');
  return [
    {
      id: 'codebase', title: 'Work on a codebase', detail: 'Inspect a repository, make a safe change, and verify it.',
      prompt: 'Work on a codebase', available: coding?.ready === true, setup: coding?.ready ? null : { settings: 'coding' },
    },
    {
      id: 'research', title: 'Research and deliver', detail: 'Search, compare sources, and produce a useful brief.',
      prompt: 'Research and deliver', available: true, setup: null,
    },
    {
      id: 'browser', title: 'Use my browser', detail: 'Work in the browser with visible, approval-aware actions.',
      prompt: 'Research using my browser', available: browser?.ready === true, setup: browser?.ready ? null : { settings: 'runtime' },
    },
    {
      id: 'apps', title: 'Work with my Apps', detail: 'Use a connected account without exposing infrastructure details.',
      prompt: 'Work with my Apps', available: apps?.ready === true, setup: apps?.ready ? null : { view: 'apps' },
    },
  ];
}

type SkillInput = {
  name: string;
  description: string;
  version: string;
  category?: string;
  trustLevel?: string;
  readiness?: unknown;
};

export type WorkbenchSkillPresentation = SkillInput & {
  source: string;
  status: 'Enabled' | 'Disabled' | 'Available' | 'Needs review' | 'Needs setup';
  usable: boolean;
};

function readinessRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function projectWorkbenchSkill(skill: SkillInput): WorkbenchSkillPresentation {
  const readiness = readinessRecord(skill.readiness);
  const state = typeof readiness.state === 'string' ? readiness.state : '';
  const enabled = readiness.enabled;
  const source = skill.category === 'learned'
    ? 'Learned'
    : skill.trustLevel === 'builtin' || skill.category === 'built-in'
      ? 'Bundled'
      : skill.category === 'workspace'
        ? 'Workspace'
        : skill.trustLevel === 'community'
          ? 'Third-party'
          : 'Installed';
  if (state === 'needs_review' || state === 'pending_review') return { ...skill, source, status: 'Needs review', usable: false };
  if (state === 'needs_setup' || state === 'unavailable' || state === 'degraded') return { ...skill, source, status: 'Needs setup', usable: false };
  if (enabled === false || state === 'disabled') return { ...skill, source, status: 'Disabled', usable: false };
  if (enabled === true || state === 'ready') return { ...skill, source, status: 'Enabled', usable: true };
  return { ...skill, source, status: 'Available', usable: true };
}

function humanKind(value: string): string {
  const normalized = (value || 'file').replace(/[_-]+/g, ' ').trim();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'File';
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function artifactMeta(artifact: Pick<WorkbenchArtifact, 'kind' | 'tool' | 'bytes' | 'createdAt'>): string[] {
  const values = [humanKind(artifact.kind)];
  if (artifact.bytes !== null) values.push(formatBytes(artifact.bytes));
  values.push(`Created ${new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(artifact.createdAt))}`);
  return values;
}

export function artifactUnavailableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP\s+404|not found|unavailable/i.test(message)) {
    return 'File is no longer available. Its task and evidence history are still preserved.';
  }
  return 'This file could not be opened. Try again, or review its source task and evidence.';
}

export const AUTOMATION_TEMPLATES = [
  { id: 'daily-research', label: 'Daily research brief', prompt: 'Research the selected topic and prepare a concise daily brief.', expression: '0 9 * * *' },
  { id: 'weekly-repository', label: 'Weekly repository summary', prompt: 'Review the repository and summarize meaningful changes from this week.', expression: '0 9 * * 5' },
  { id: 'morning-review', label: 'Morning review', prompt: 'Prepare a morning review of the work that needs my attention.', expression: '0 8 * * 1-5' },
  { id: 'watch-website', label: 'Watch a website', prompt: 'Check the selected website for meaningful changes and report only when something changed.', expression: '0 */6 * * *' },
] as const;
