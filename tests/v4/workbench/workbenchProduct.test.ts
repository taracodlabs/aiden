import { describe, expect, it } from 'vitest';

import {
  APPEARANCE_OPTIONS,
  AUTOMATION_TEMPLATES,
  artifactMeta,
  artifactUnavailableMessage,
  buildSanitizedDiagnosticSummary,
  detectWorkbenchLocale,
  normalizeAppearance,
  normalizeDensity,
  presentReadinessSummary,
  projectStarterActions,
  projectWorkbenchSkill,
} from '../../../dashboard-next/lib/workbenchProduct';

describe('Workbench v2 product contracts', () => {
  it('supports complete token-driven appearance choices and safe persistence fallbacks', () => {
    expect(APPEARANCE_OPTIONS.map((option) => option.id)).toEqual([
      'system', 'light', 'dark', 'midnight', 'warm',
    ]);
    expect(normalizeAppearance('midnight')).toBe('midnight');
    expect(normalizeAppearance('unknown')).toBe('system');
    expect(normalizeDensity('compact')).toBe('compact');
    expect(normalizeDensity('dense')).toBe('comfortable');
  });

  it('detects the customer timezone and locale without a regional default', () => {
    expect(detectWorkbenchLocale({ timeZone: 'Europe/Tallinn', locale: 'et-EE' })).toEqual({
      timeZone: 'Europe/Tallinn', locale: 'et-EE',
    });
    const detected = detectWorkbenchLocale({ timeZone: '', locale: '' });
    expect(detected.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    expect(detected.locale).toBe(Intl.DateTimeFormat().resolvedOptions().locale || 'en');
  });

  it('summarizes readiness in customer language and counts optional setup honestly', () => {
    const summary = presentReadinessSummary({
      overall: 'ready',
      checkedAt: 1,
      issues: [],
      items: [
        { id: 'chat-provider', ready: true, blocking: true, state: 'ready' },
        { id: 'browser', ready: false, blocking: false, state: 'needs_setup' },
        { id: 'apps', ready: false, blocking: false, state: 'setup_available' },
      ],
    } as never);

    expect(summary).toEqual({
      title: 'Ready to use',
      detail: '2 optional features are not set up',
      tone: 'ready',
    });
  });

  it('makes starter actions readiness-aware instead of sending users into avoidable failure', () => {
    const actions = projectStarterActions([
      { id: 'coding-provider', ready: false, blocking: false, state: 'needs_setup', availableActions: ['manage_coding'] },
      { id: 'browser', ready: true, blocking: false, state: 'ready', availableActions: [] },
      { id: 'apps', ready: false, blocking: false, state: 'setup_available', availableActions: ['manage_apps'] },
    ] as never);

    expect(actions.find((action) => action.id === 'codebase')).toMatchObject({ available: false, setup: { settings: 'coding' } });
    expect(actions.find((action) => action.id === 'browser')).toMatchObject({ available: true, prompt: 'Research using my browser' });
    expect(actions.find((action) => action.id === 'apps')).toMatchObject({ available: false, setup: { view: 'apps' } });
  });

  it('projects skill inventory semantics without claiming every discovered skill is enabled', () => {
    expect(projectWorkbenchSkill({
      name: 'repository-review', description: 'Review repository changes.', version: '1.2.0',
      category: 'workspace', trustLevel: 'builtin', readiness: { state: 'ready', enabled: true },
    })).toMatchObject({ source: 'Bundled', status: 'Enabled', usable: true });

    expect(projectWorkbenchSkill({
      name: 'candidate-skill', description: 'Candidate.', version: '0.1.0',
      category: 'learned', trustLevel: 'community', readiness: { state: 'needs_review' },
    })).toMatchObject({ source: 'Learned', status: 'Needs review', usable: false });

    expect(projectWorkbenchSkill({
      name: 'discovered-skill', description: 'Discovered.', version: '1.0.0',
    })).toMatchObject({ source: 'Installed', status: 'Available', usable: true });
  });

  it('omits unknown artifact size and translates missing content into product copy', () => {
    expect(artifactMeta({ kind: 'report', tool: 'file_write', bytes: null, createdAt: 0 })).toEqual(['Report', 'Created Jan 1, 1970']);
    expect(artifactMeta({ kind: 'report', tool: 'file_write', bytes: 1_536, createdAt: 0 })[1]).toContain('1.5 KB');
    expect(artifactUnavailableMessage(new Error('artifact content unavailable (HTTP 404)'))).toBe(
      'File is no longer available. Its task and evidence history are still preserved.',
    );
  });

  it('provides safe automation templates that only prefill real prompt schedules', () => {
    expect(AUTOMATION_TEMPLATES.map((template) => template.id)).toEqual([
      'daily-research', 'weekly-repository', 'morning-review', 'watch-website',
    ]);
    expect(AUTOMATION_TEMPLATES.every((template) => template.prompt.length > 0 && template.expression.length > 0)).toBe(true);
  });

  it('creates a useful diagnostic summary from an explicit non-sensitive allowlist', () => {
    const summary = buildSanitizedDiagnosticSummary({
      runtimeVersion: '4.20.0', connection: 'connected', provider: 'OpenAI', model: 'GPT-5.5',
      executionAvailable: true, queue: { pending: 1, claimed: 0, inflight: 1, workerCount: 2 },
      readiness: {
        overall: 'ready', checkedAt: 1, issues: [],
        items: [{ id: 'chat-provider', title: 'Chat', ready: true, healthy: true, blocking: true, state: 'ready' }],
      } as never,
      credential: 'must-not-appear', prompt: 'must-not-appear', privatePath: 'must-not-appear',
    } as never);
    expect(summary).toContain('Runtime: 4.20.0');
    expect(summary).toContain('Chat: ready');
    expect(summary).not.toContain('must-not-appear');
  });
});
