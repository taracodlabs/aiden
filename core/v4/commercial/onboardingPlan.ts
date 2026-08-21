/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { SystemReadinessProjection } from '../workbench/systemReadiness';

export interface OnboardingStep {
  id: 'computer' | 'ai' | 'browser' | 'coding' | 'apps' | 'ready';
  title: string;
  state: 'complete' | 'action_required' | 'optional' | 'ready';
  detail: string;
  skippable: boolean;
}

export function buildOnboardingPlan(readiness: SystemReadinessProjection): OnboardingStep[] {
  const byId = new Map(readiness.items.map((entry) => [entry.id, entry]));
  const step = (id: OnboardingStep['id'], title: string, readinessId: string, skippable: boolean): OnboardingStep => {
    const item = byId.get(readinessId);
    if (!item) return { id, title, state: skippable ? 'optional' : 'action_required', detail: 'Readiness information is unavailable. Recheck.', skippable };
    return {
      id, title,
      state: item.healthy ? 'complete' : skippable ? 'optional' : 'action_required',
      detail: item.detail,
      skippable,
    };
  };
  return [
    step('computer', 'Check this computer', 'workspace', false),
    step('ai', 'Connect AI', 'chat-provider', false),
    step('browser', 'Browser access', 'browser', true),
    step('coding', 'Coding setup', 'coding-provider', true),
    step('apps', 'Apps', 'apps', true),
    { id: 'ready', title: 'Ready', state: readiness.overall === 'ready' ? 'ready' : 'action_required', detail: readiness.overall === 'ready' ? 'Aiden is ready.' : 'Complete required setup, then recheck.', skippable: false },
  ];
}

export const FIRST_SUCCESS_CHOICES = [
  'Work on a codebase',
  'Research using browser',
  'Work with Apps',
  'Create something',
] as const;

