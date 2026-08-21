import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('commercial Workbench onboarding source contract', () => {
  const component = readFileSync(path.resolve(__dirname, '../../../dashboard-next/components/OnboardingModal.tsx'), 'utf8');
  const page = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');

  it('uses the existing Workbench readiness endpoint rather than a second readiness implementation', () => {
    expect(component).toContain('aiden.loadSystemReadiness()');
    expect(component).not.toContain('/api/providers/add');
    expect(component).not.toContain('gsk_');
  });

  it('keeps browser, coding, and Apps optional and offers outcome-oriented first success', () => {
    expect(component).toContain("{ id: 'browser', title: 'Browser access', readinessId: 'browser', optional: true }");
    expect(component).toContain("{ id: 'coding', title: 'Coding setup', readinessId: 'coding-provider', optional: true }");
    expect(component).toContain("{ id: 'apps', title: 'Apps', readinessId: 'apps', optional: true }");
    expect(component).toContain('Work on a codebase');
    expect(component).toContain('Research using browser');
  });

  it('shows actionable recovery and persists only a local completion marker', () => {
    expect(component).toContain('What failed:');
    expect(component).toContain('What Aiden knows:');
    expect(component).toContain('Recheck');
    expect(page).toContain("window.localStorage.setItem('aiden:first-run:v1', 'complete')");
  });
});

