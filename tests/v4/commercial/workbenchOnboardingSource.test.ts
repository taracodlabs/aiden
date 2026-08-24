import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('commercial Workbench onboarding source contract', () => {
  const component = readFileSync(path.resolve(__dirname, '../../../dashboard-next/components/OnboardingModal.tsx'), 'utf8');
  const page = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');
  const product = readFileSync(path.resolve(__dirname, '../../../dashboard-next/lib/workbenchProduct.ts'), 'utf8');
  const bridge = readFileSync(path.resolve(__dirname, '../../../core/v4/workbench/bridgeServer.ts'), 'utf8');

  it('uses the existing Workbench readiness endpoint rather than a second readiness implementation', () => {
    expect(component).toContain('aiden.loadSystemReadiness()');
    expect(component).not.toContain('/api/providers/add');
    expect(component).not.toContain('gsk_');
  });

  it('keeps browser, coding, and Apps optional and offers outcome-oriented first success', () => {
    expect(component).toContain("{ id: 'browser', title: 'Browser access', readinessId: 'browser', optional: true }");
    expect(component).toContain("{ id: 'coding', title: 'Coding setup', readinessId: 'coding-provider', optional: true }");
    expect(component).toContain("{ id: 'apps', title: 'Apps', readinessId: 'apps', optional: true }");
    expect(component).toContain('projectStarterActions(readiness?.items ?? [])');
    expect(product).toContain("title: 'Work on a codebase'");
    expect(product).toContain("title: 'Use my browser'");
  });

  it('shows actionable recovery and persists only a local completion marker', () => {
    expect(component).toContain('What failed:');
    expect(component).toContain('What Aiden knows:');
    expect(component).toContain('Recheck');
    expect(page).toContain("window.localStorage.setItem('aiden:first-run:v1', 'complete')");
  });

  it('temporarily releases onboarding for durable readiness and Apps deep links without marking setup complete', () => {
    expect(page).toContain('setOnboardingVisible(false)');
    expect(page).toContain('onOpenSettings={(tab) => { openWorkbenchDestination({ settings: tab }) }}');
    expect(page).toContain("openWorkbenchDestination({ view: 'apps' })");
    expect(page).toContain('parseWorkbenchDestination(window.location.search)');
  });

  it('renders the authoritative runtime edition in Workbench chrome', () => {
    expect(page).toContain('runtimeEdition');
    expect(page).toContain("runtimeEdition === 'community' ? 'Community'");
    expect(page).not.toContain('>Aiden Pro</div>');
    expect(bridge).toContain("edition: runtime.edition ?? 'community'");
  });
});

