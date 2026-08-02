import { describe, expect, it } from 'vitest';

import {
  compactDiffLines,
  normalizeActivityPhase,
  phaseColorKind,
  projectActivityFrame,
  projectCommandPresentation,
  projectEvidenceLines,
  projectSkillInvocation,
  projectWorkerDelegation,
  projectContextCompaction,
  dedupeStructuredActivity,
  relativizeActivityText,
  shouldDeferActivityTransition,
  type SemanticActivityPhase,
} from '../../../cli/v4/semanticActivity';

const animated: SemanticActivityPhase[] = [
  'thinking', 'planning', 'inspecting', 'working', 'testing',
  'verifying', 'recovering', 'completing',
];

describe('semantic activity projection', () => {
  it.each([
    ['calling provider', 'thinking'],
    ['preparing prompt', 'planning'],
    ['refreshing memory', 'inspecting'],
    ['reading', 'inspecting'],
    ['searching', 'inspecting'],
    ['drafting', 'working'],
    ['analyzing', 'working'],
    ['running focused tests', 'testing'],
    ['verifying', 'verifying'],
    ['retrying', 'recovering'],
    ['awaiting_approval', 'approval_required'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(normalizeActivityPhase(input)).toBe(expected);
  });

  it.each(animated)('changes the visible %s frame without changing its purpose', (phase) => {
    const first = projectActivityFrame({ phase, frame: 0, elapsedMs: 1_000, unicode: true, mode: 'summary' });
    const second = projectActivityFrame({ phase, frame: 1, elapsedMs: 1_250, unicode: true, mode: 'summary' });
    expect(first.text).not.toBe(second.text);
    expect(first.label).toBeTruthy();
    expect(second.label).toBeTruthy();
  });

  it.each([
    ['approval_required', 'Approval required'],
    ['blocked', 'Blocked — user action required'],
    ['complete', 'Complete'],
    ['failed', 'Failed'],
    ['ready', 'ready'],
  ] as const)('keeps terminal phase %s static', (phase, label) => {
    const first = projectActivityFrame({ phase, frame: 0, elapsedMs: 0, unicode: true, mode: 'summary' });
    const second = projectActivityFrame({ phase, frame: 3, elapsedMs: 5_000, unicode: true, mode: 'summary' });
    expect(first.text).toBe(second.text);
    expect(first.label).toContain(label);
  });

  it('uses truthful slow-state wording and hides provider mechanics in summary mode', () => {
    expect(projectActivityFrame({ phase: 'thinking', frame: 0, elapsedMs: 2_000, unicode: true, mode: 'summary', source: 'provider' }).text)
      .toContain('Aiden is thinking');
    expect(projectActivityFrame({ phase: 'thinking', frame: 0, elapsedMs: 5_000, unicode: true, mode: 'summary', source: 'provider' }).text)
      .toContain('Planning the safest approach');
    expect(projectActivityFrame({ phase: 'thinking', frame: 0, elapsedMs: 12_000, unicode: true, mode: 'summary', source: 'provider' }).text)
      .toContain('Reviewing repository state');
    const long = projectActivityFrame({ phase: 'thinking', frame: 0, elapsedMs: 26_000, unicode: true, mode: 'summary', source: 'provider' });
    expect(long.text).toContain('Still working');
    expect(long.text).not.toMatch(/provider|model request/iu);

    const full = projectActivityFrame({ phase: 'thinking', frame: 0, elapsedMs: 1_000, unicode: true, mode: 'full', source: 'provider' });
    expect(full.text).toContain('provider request');
  });

  it('provides an ASCII animation fallback and semantic color mapping', () => {
    const frame = projectActivityFrame({ phase: 'testing', frame: 1, elapsedMs: 200, unicode: false, mode: 'summary' });
    expect(frame.text).toMatch(/^[|/\\-]/u);
    expect(phaseColorKind('thinking')).toBe('thinking');
    expect(phaseColorKind('planning')).toBe('planning');
    expect(phaseColorKind('verifying')).toBe('verifying');
    expect(phaseColorKind('complete')).toBe('success');
    expect(phaseColorKind('failed')).toBe('error');
    expect(projectActivityFrame({ phase: 'complete', frame: 0, elapsedMs: 0, unicode: true, mode: 'summary' }).glyphColor).toBe('success');
    expect(projectActivityFrame({ phase: 'failed', frame: 0, elapsedMs: 0, unicode: true, mode: 'summary' }).glyphColor).toBe('error');
    expect(projectActivityFrame({ phase: 'approval_required', frame: 0, elapsedMs: 0, unicode: true, mode: 'summary' }).glyphColor).toBe('warn');
  });

  it.each(['thinking', 'planning', 'inspecting', 'working', 'testing', 'verifying', 'recovering', 'completing'] as SemanticActivityPhase[])('keeps %s animation frames display-width stable', (phase) => {
    const widths = [0, 1, 2, 3].map((frame) => projectActivityFrame({ phase, frame, elapsedMs: 1_000, unicode: true, mode: 'summary' }).glyph.length);
    expect(new Set(widths).size).toBe(1);
  });

  it('defers fast transient phase churn but never delays terminal/user phases', () => {
    expect(shouldDeferActivityTransition('thinking', 'planning', 100)).toBe(true);
    expect(shouldDeferActivityTransition('thinking', 'planning', 200)).toBe(false);
    expect(shouldDeferActivityTransition('working', 'approval_required', 10)).toBe(false);
    expect(shouldDeferActivityTransition('working', 'blocked', 10)).toBe(false);
  });
});

describe('structured skill and Worker projections', () => {
  it('exposes one typed row per real skill and optional reference', () => {
    const lines = projectSkillInvocation({ invocationId: 'inv-1', skillName: 'repository-audit', durationMs: 1250, referenceName: 'repo-layout' });
    expect(lines.map((line) => line.text)).toEqual(['skill     repository-audit 1.3s', 'reference repo-layout']);
    expect(lines[0]?.color).toBe('skill');
    expect(lines[1]?.color).toBe('evidence');
  });

  it('projects actual Worker count and goals without raw payloads', () => {
    const lines = projectWorkerDelegation({
      groupId: 'group-1', workers: [{ goal: 'Runtime ownership' }, { goal: 'TUI inspection' }], state: 'running', elapsedMs: 2000,
    });
    expect(lines.map((line) => line.text)).toEqual([
      'delegate  2 Workers', '1. Runtime ownership', '2. TUI inspection', '2 Workers running · 2s',
    ]);
    expect(lines.join('\n')).not.toContain('{');
    expect(lines[0]?.color).toBe('worker');
  });

  it('deduplicates repeated durable identities and keeps context compaction informational', () => {
    const line = projectContextCompaction();
    expect(line.text).toContain('preserved task state and tool results');
    expect(dedupeStructuredActivity([line, line])).toHaveLength(1);
  });
});

describe('compact command and evidence projection', () => {
  it('collapses successful output in summary mode and retains it in full mode', () => {
    const summary = projectCommandPresentation({ command: 'npm test', stdout: 'line one\nline two', stderr: '', exitCode: 0, mode: 'summary' });
    expect(summary.lines).toEqual(['✓ npm test — completed']);
    expect(summary.details).toContain('line one');
    const full = projectCommandPresentation({ command: 'npm test', stdout: 'line one\nline two', stderr: '', exitCode: 0, mode: 'full' });
    expect(full.lines.join('\n')).toContain('line two');
  });

  it('expands useful diagnostics for failure without hiding the exit code', () => {
    const failed = projectCommandPresentation({
      command: 'npm test', stdout: '', stderr: 'tests/math.test.mjs:7\nExpected 5\nReceived -1', exitCode: 1, mode: 'summary',
    });
    expect(failed.lines[0]).toContain('failed');
    expect(failed.lines.join('\n')).toContain('Expected 5');
    expect(failed.lines.at(-1)).toContain('exit 1');
  });

  it('recognizes only structured PowerShell progress CLIXML', () => {
    const clixml = '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress"><MS><PR N="Record"><AV>Working</AV></PR></MS></Obj></Objs>';
    const projected = projectCommandPresentation({ command: 'pwsh -File task.ps1', stdout: '', stderr: clixml, exitCode: 0, mode: 'summary' });
    expect(projected.lines).toContain('! PowerShell emitted progress metadata; ignored');
    const arbitrary = projectCommandPresentation({ command: 'pwsh', stdout: '', stderr: '#< CLIXML\nnot xml', exitCode: 0, mode: 'summary' });
    expect(arbitrary.lines.join('\n')).toContain('not xml');
  });

  it('classifies Git line-ending output as a notice, not a hard failure', () => {
    const warning = "warning: in the working copy of 'src/math.mjs', LF will be replaced by CRLF the next time Git touches it";
    const projected = projectCommandPresentation({ command: 'git diff', stdout: '', stderr: warning, exitCode: 0, mode: 'summary' });
    expect(projected.lines).toContain('! Git line-ending notice available');
    expect(projected.lines.join('\n')).not.toContain('failed');
    expect(projected.details).toContain('LF will be replaced');
  });

  it('uses repository-relative text in summary mode and exact paths in full mode', () => {
    const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
    const path = process.platform === 'win32' ? 'C:\\repo\\src\\math.mjs' : '/repo/src/math.mjs';
    expect(relativizeActivityText(`read ${path}`, root, 'summary')).toBe('read src/math.mjs');
    expect(relativizeActivityText(`read ${path}`, root, 'full')).toBe(`read ${path}`);
  });

  it('renders a compact one-hunk diff and keeps binary changes explicit', () => {
    expect(compactDiffLines('diff --git a/src/math.mjs b/src/math.mjs\n--- a/src/math.mjs\n+++ b/src/math.mjs\n@@\n-return a - b;\n+return a + b;'))
      .toEqual(['M src/math.mjs', '  - return a - b;', '  + return a + b;']);
    expect(compactDiffLines('Binary files a/logo.png and b/logo.png differ')).toEqual(['Binary change: logo.png']);
  });

  it('projects only real durable evidence and preserves unknown/conflict truth', () => {
    const verified = projectEvidenceLines([{
      evidenceId: 'evidence_1234567890', source: 'fresh_readback', verificationResult: 'verified', payload: { path: 'src/math.mjs' },
    }], 'summary');
    expect(verified).toContain('Evidence');
    expect(verified.join('\n')).toContain('Readback');
    expect(verified.join('\n')).toContain('verified');
    expect(verified.join('\n')).not.toContain('evidence_1234567890');

    const full = projectEvidenceLines([{
      evidenceId: 'evidence_1234567890', source: 'repository.change.conflict', verificationResult: 'unknown',
      payload: { message: 'source changed after approval', target: 'src/math.mjs' },
    }], 'full');
    expect(full.join('\n')).toContain('source changed after approval');
    expect(full.join('\n')).toContain('preserved');
    expect(full.join('\n')).toContain('unknown');
    expect(full.join('\n')).toContain('reconciliation required');
    expect(full.join('\n')).toContain('replan from current snapshot');
    expect(full.join('\n')).toContain('evidence_1234567890');
  });
});
