import path from 'node:path';

import type { ColorKind } from './skinEngine';

export type ActivityPresentationMode = 'summary' | 'full';

export type SemanticActivityPhase =
  | 'ready'
  | 'thinking'
  | 'planning'
  | 'inspecting'
  | 'working'
  | 'testing'
  | 'verifying'
  | 'recovering'
  | 'approval_required'
  | 'blocked'
  | 'completing'
  | 'complete'
  | 'failed';

export interface ActivityFrameInput {
  phase: SemanticActivityPhase;
  frame: number;
  elapsedMs: number;
  unicode: boolean;
  mode: ActivityPresentationMode;
  source?: 'provider' | 'runtime';
}

export interface ActivityFrameProjection {
  glyph: string;
  label: string;
  text: string;
  color: ColorKind;
  animated: boolean;
}

const TERMINAL_PHASES = new Set<SemanticActivityPhase>([
  'ready', 'approval_required', 'blocked', 'complete', 'failed',
]);

export function normalizeActivityPhase(value: string | undefined): SemanticActivityPhase {
  const phase = (value ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_');
  if (!phase) return 'thinking';
  if (phase === 'ready') return 'ready';
  if (/(approval|awaiting_approval|confirmation)/u.test(phase)) return 'approval_required';
  if (/(blocked|stale|conflict)/u.test(phase)) return 'blocked';
  if (/(failed|failure|error)/u.test(phase)) return 'failed';
  if (/(complete|completed|verified)/u.test(phase) && !/verifying/u.test(phase)) return 'complete';
  if (/(verify|readback|proof|evidence)/u.test(phase)) return 'verifying';
  if (/(test|validation|check)/u.test(phase)) return 'testing';
  if (/(recover|retry|resume|reconcile)/u.test(phase)) return 'recovering';
  if (/(inspect|read|search|fetch|list|view|memory|repository)/u.test(phase)) return 'inspecting';
  if (/(plan|prompt|prepare_prompt|understand)/u.test(phase)) return 'planning';
  if (/(work|draft|write|edit|patch|save|run|exec|analyz|change)/u.test(phase)) return 'working';
  if (/(final|complet)/u.test(phase)) return 'completing';
  return 'thinking';
}

export function semanticPhaseForTool(
  toolName: string,
  runtimePhase: string = 'running',
): SemanticActivityPhase {
  const observed = normalizeActivityPhase(runtimePhase);
  if (observed === 'approval_required' || observed === 'verifying' || observed === 'recovering') return observed;
  const name = toolName.toLowerCase();
  if (/(test|lint|typecheck|build|compile)/u.test(name)) return 'testing';
  if (/(read|list|view|get|inspect|search|fetch|status|snapshot)/u.test(name)) return 'inspecting';
  if (/(write|edit|patch|save|create|append|delete|remove|move|rename|shell|exec|run)/u.test(name)) return 'working';
  return observed === 'thinking' ? 'working' : observed;
}

export function phaseColorKind(phase: SemanticActivityPhase): ColorKind {
  switch (phase) {
    case 'thinking': return 'thinking';
    case 'planning': return 'planning';
    case 'inspecting': return 'inspecting';
    case 'working': return 'working';
    case 'testing': return 'testing';
    case 'verifying': return 'verifying';
    case 'recovering': return 'recovering';
    case 'approval_required':
    case 'blocked': return 'warn';
    case 'complete': return 'success';
    case 'failed': return 'error';
    case 'completing': return 'verifying';
    case 'ready': return 'muted';
  }
}

function slowThinkingLabel(elapsedMs: number): string {
  if (elapsedMs >= 25_000) return 'Still working — checking the result before responding…';
  if (elapsedMs >= 10_000) return 'Reviewing repository state and existing user changes…';
  if (elapsedMs >= 3_000) return 'Planning the safest approach…';
  return 'Aiden is thinking…';
}

function phaseLabel(phase: SemanticActivityPhase, elapsedMs: number): string {
  switch (phase) {
    case 'ready': return 'ready';
    case 'thinking': return slowThinkingLabel(elapsedMs);
    case 'planning': return 'Planning the work…';
    case 'inspecting': return 'Inspecting the repository…';
    case 'working': return 'Working on the requested action…';
    case 'testing': return 'Running focused tests…';
    case 'verifying': {
      const labels = ['Checking fresh readback…', 'Verifying test evidence…', 'Building final proof…'];
      return labels[Math.floor(elapsedMs / 1_000) % labels.length]!;
    }
    case 'recovering': return 'Recovering interrupted work…';
    case 'approval_required': return 'Approval required';
    case 'blocked': return 'Blocked — user action required';
    case 'completing': return 'Finalizing…';
    case 'complete': return 'Complete';
    case 'failed': return 'Failed';
  }
}

export function semanticPhaseStatusLabel(phase: SemanticActivityPhase): string {
  switch (phase) {
    case 'approval_required': return 'approval required';
    case 'completing': return 'finalizing';
    case 'complete': return 'complete';
    default: return phase;
  }
}

export function semanticPhaseCompactToken(
  phase: SemanticActivityPhase,
  unicode: boolean,
): string {
  switch (phase) {
    case 'thinking': return 'T';
    case 'planning': return 'P';
    case 'inspecting': return 'I';
    case 'working': return 'W';
    case 'testing': return 'R';
    case 'verifying': return 'V';
    case 'recovering': return 'R';
    case 'approval_required': return 'A';
    case 'blocked': return 'B';
    case 'completing': return 'V';
    case 'ready':
    case 'complete': return unicode ? '✓' : '+';
    case 'failed': return unicode ? '✕' : 'x';
  }
}

function unicodeGlyph(phase: SemanticActivityPhase, frame: number): string {
  switch (phase) {
    case 'thinking': return ['⠋', '⠙', '⠹', '⠸'][frame % 4]!;
    case 'planning': return ['◇ ◆ ◇', '◇ ◇ ◆', '◆ ◇ ◇'][frame % 3]!;
    case 'inspecting': {
      const cells = Array.from({ length: 5 }, (_, index) => index === frame % 5 ? '■' : '□');
      return `[${cells.join('')}]`;
    }
    case 'working': return ['>   ', ' >  ', '  > ', '   >'][frame % 4]!;
    case 'testing': return ['◐', '◓', '◑', '◒'][frame % 4]!;
    case 'verifying': return ['⌁', '⌁·', '⌁··'][frame % 3]!;
    case 'recovering': return ['↶', '↺'][frame % 2]!;
    case 'completing': return ['·', '··', '···'][frame % 3]!;
    case 'approval_required':
    case 'blocked': return '!';
    case 'complete': return '✓';
    case 'failed': return '✕';
    case 'ready': return '◆';
  }
}

function asciiGlyph(phase: SemanticActivityPhase, frame: number): string {
  if (TERMINAL_PHASES.has(phase)) {
    if (phase === 'complete') return '+';
    if (phase === 'failed' || phase === 'blocked' || phase === 'approval_required') return '!';
    return '*';
  }
  return ['|', '/', '-', '\\'][frame % 4]!;
}

export function projectActivityFrame(input: ActivityFrameInput): ActivityFrameProjection {
  const glyph = input.unicode ? unicodeGlyph(input.phase, input.frame) : asciiGlyph(input.phase, input.frame);
  const label = phaseLabel(input.phase, Math.max(0, input.elapsedMs));
  const detail = input.mode === 'full' && input.source === 'provider' ? ' · provider request' : '';
  return {
    glyph,
    label,
    text: `${glyph} ${label}${detail}`,
    color: phaseColorKind(input.phase),
    animated: !TERMINAL_PHASES.has(input.phase),
  };
}

export function shouldDeferActivityTransition(
  current: SemanticActivityPhase,
  next: SemanticActivityPhase,
  currentVisibleMs: number,
): boolean {
  if (current === next || TERMINAL_PHASES.has(next)) return false;
  return currentVisibleMs < 175;
}

export function relativizeActivityText(
  value: string,
  cwd: string,
  mode: ActivityPresentationMode,
): string {
  if (mode === 'full' || !cwd) return value;
  const normalizedRoot = cwd.replace(/[\\/]+$/u, '');
  const escaped = normalizedRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const replaced = value.replace(new RegExp(`${escaped}[\\\\/]`, process.platform === 'win32' ? 'giu' : 'gu'), '');
  return replaced.replace(/\\/gu, '/');
}

function isPowerShellProgressClixml(value: string): boolean {
  const text = value.trim();
  return /^#< CLIXML\s*<Objs\b[\s\S]*<Obj\b[^>]*\bS="progress"[\s\S]*<PR\b[\s\S]*<\/Objs>$/u.test(text);
}

function isGitLineEndingNotice(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return text.split(/\r?\n/u).every((line) => (
    /^warning: in the working copy of .+, (?:LF|CRLF) will be replaced by (?:LF|CRLF) the next time Git touches it$/iu.test(line.trim())
  ));
}

export interface CommandPresentationInput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  mode: ActivityPresentationMode;
}

export interface CommandPresentation {
  lines: string[];
  details: string;
  outcome: 'success' | 'warning' | 'failure';
}

export function projectCommandPresentation(input: CommandPresentationInput): CommandPresentation {
  const command = input.command.trim() || 'command';
  const details = [input.stdout, input.stderr].filter(Boolean).join('\n');
  const progressNoise = input.exitCode === 0 && isPowerShellProgressClixml(input.stderr);
  const lineEndingNoise = input.exitCode === 0 && isGitLineEndingNotice(input.stderr);

  if (input.mode === 'full') {
    const lines = [`${input.exitCode === 0 ? '✓' : '✕'} ${command} — ${input.exitCode === 0 ? 'completed' : 'failed'}`];
    if (input.stdout) lines.push(...input.stdout.split(/\r?\n/u));
    if (input.stderr) lines.push(...input.stderr.split(/\r?\n/u));
    if (input.exitCode !== 0) lines.push(`exit ${input.exitCode}`);
    return { lines, details, outcome: input.exitCode === 0 ? 'success' : 'failure' };
  }

  if (input.exitCode === 0) {
    const lines = [`✓ ${command} — completed`];
    if (progressNoise) lines.push('! PowerShell emitted progress metadata; ignored');
    else if (lineEndingNoise) lines.push('! Git line-ending notice available');
    else if (input.stderr.trim()) lines.push(...input.stderr.split(/\r?\n/u).slice(0, 5));
    if (/^git\s+diff\b/iu.test(command) && input.stdout.trim()) lines.push(...compactDiffLines(input.stdout));
    return { lines, details, outcome: progressNoise || lineEndingNoise || input.stderr.trim() ? 'warning' : 'success' };
  }

  const diagnostics = [
    ...input.stdout.split(/\r?\n/u).filter(Boolean).slice(0, 5),
    ...input.stderr.split(/\r?\n/u).filter(Boolean).slice(0, 5),
  ];
  return {
    lines: [`✕ ${command} — failed`, ...diagnostics, `exit ${input.exitCode}`],
    details,
    outcome: 'failure',
  };
}

export function compactDiffLines(diff: string): string[] {
  const binary = /^Binary files (?:a\/)?(.+?) and (?:b\/)?(.+?) differ$/mu.exec(diff);
  if (binary) return [`Binary change: ${binary[2] ?? binary[1]}`];
  const file = /^\+\+\+\s+b\/(.+)$/mu.exec(diff)?.[1]
    ?? /^diff --git a\/(.+?) b\/(.+)$/mu.exec(diff)?.[2];
  if (!file) return ['Diff available in full activity'];
  const removed = diff.split(/\r?\n/u).find((line) => line.startsWith('-') && !line.startsWith('---'));
  const added = diff.split(/\r?\n/u).find((line) => line.startsWith('+') && !line.startsWith('+++'));
  const lines = [`M ${file}`];
  if (removed) lines.push(`  - ${removed.slice(1).trimStart()}`);
  if (added) lines.push(`  + ${added.slice(1).trimStart()}`);
  return lines;
}

export interface EvidenceProjectionInput {
  evidenceId: string;
  source: string;
  verificationResult: string;
  repositorySnapshotId?: string | null;
  payload?: unknown;
}

function evidencePayload(input: EvidenceProjectionInput): Record<string, unknown> {
  return input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : {};
}

function evidenceKind(source: string): string {
  const value = source.toLowerCase();
  if (/conflict|stale/u.test(value)) return 'Conflict';
  if (/diff|patch/u.test(value)) return 'Diff';
  if (/test|validation/u.test(value)) return 'TestRun';
  if (/snapshot/u.test(value)) return 'Snapshot';
  if (/readback|file_read/u.test(value)) return 'Readback';
  return 'Evidence';
}

export function projectEvidenceLines(
  evidence: readonly EvidenceProjectionInput[],
  mode: ActivityPresentationMode,
): string[] {
  if (evidence.length === 0) return [];
  const lines = ['Evidence'];
  const visible = mode === 'full' ? evidence : evidence.slice(0, 4);
  for (const item of visible) {
    const payload = evidencePayload(item);
    const kind = evidenceKind(item.source);
    const reason = typeof payload.reason === 'string' ? payload.reason
      : typeof payload.message === 'string' ? payload.message : '';
    const pathValue = typeof payload.path === 'string' ? payload.path
      : typeof payload.target === 'string' ? payload.target : '';
    const validationState = typeof payload.state === 'string' ? payload.state : '';
    const snapshot = item.repositorySnapshotId ?? (typeof payload.repositorySnapshotId === 'string'
      ? payload.repositorySnapshotId : '');
    const value = reason
      || (kind === 'Snapshot' && snapshot ? snapshot : '')
      || (kind === 'TestRun' && validationState ? `${validationState} · ${item.verificationResult}` : '')
      || (pathValue ? `${pathValue} · ${item.verificationResult}` : item.verificationResult);
    const id = mode === 'full' ? ` · ${item.evidenceId}` : '';
    lines.push(`  ${kind.padEnd(10)} ${value}${id}`);
    if (kind === 'Conflict') {
      if (payload.userEditPreserved === true || item.source === 'repository.change.conflict') {
        lines.push('  User edit  preserved');
      }
      lines.push('  Effect     reconciliation required');
      lines.push(`  Claim      ${item.verificationResult}`);
      lines.push('  Next step  replan from current snapshot');
    }
  }
  if (mode === 'summary' && evidence.length > visible.length) {
    lines.push(`  +${evidence.length - visible.length} more in full activity`);
  }
  return lines;
}

export function repositoryRelativePath(value: string, cwd: string): string {
  try {
    const relative = path.relative(cwd, value);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return value;
    return relative.replace(/\\/gu, '/');
  } catch {
    return value;
  }
}
