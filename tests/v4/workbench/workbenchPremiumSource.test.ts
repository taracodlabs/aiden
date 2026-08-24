import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const page = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');
const css = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/globals.css'), 'utf8');
const product = readFileSync(path.resolve(__dirname, '../../../dashboard-next/lib/workbenchProduct.ts'), 'utf8');
const onboardingRoute = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/onboarding/page.tsx'), 'utf8');

describe('Workbench v2 customer-facing source contracts', () => {
  it('does not ship the obsolete localhost onboarding implementation into the Workbench page', () => {
    expect(page).not.toContain("import Onboarding from '../components/Onboarding'");
    expect(page).not.toContain('Configure a provider with the Aiden CLI');
    expect(onboardingRoute).toContain("redirect('/')");
  });

  it('uses accurate Aiden, privacy, and AGPL customer copy', () => {
    expect(page).not.toContain('© 2026 All rights reserved');
    expect(page).not.toContain('Zero telemetry or analytics collected');
    expect(page).not.toContain('DevOS runs entirely on your machine');
    expect(page).toContain('Licensed under AGPL-3.0-only');
    expect(page).toContain('Legal review is required before commercial distribution.');
    expect(page).toContain('Configured providers and connected services receive only the data needed for the action you request.');
  });

  it('provides customer-safe support actions without exporting raw logs or private data', () => {
    expect(page).toContain('Run diagnostics');
    expect(page).toContain('Copy sanitized summary');
    expect(product).toContain('buildSanitizedDiagnosticSummary');
    expect(product).not.toContain('rawLogs');
  });

  it('uses detected timezone and exposes the full appearance and density controls', () => {
    expect(page).not.toContain("useState('Asia/Kolkata')");
    expect(page).toContain('detectWorkbenchLocale()');
    for (const theme of ['System', 'Light', 'Dark', 'Midnight', 'Warm']) expect(product).toContain(theme);
    expect(page).toContain('Comfortable');
    expect(page).toContain('Compact');
  });

  it('keeps the premium action menu flat and avoids emoji navigation', () => {
    expect(page).toContain('Quick web search');
    expect(page).toContain('Deep research');
    expect(page).toContain('Use browser');
    expect(page).toContain('Use Apps');
    expect(page).not.toContain("icon: '📎'");
    expect(page).not.toContain("icon: '🔍'");
  });

  it('defines responsive settings and readable theme tokens', () => {
    expect(css).toContain(":root[data-appearance='light']");
    expect(css).toContain(":root[data-appearance='midnight']");
    expect(css).toContain(":root[data-appearance='warm']");
    expect(css).toContain("[data-density='compact']");
    expect(css).toContain('@media (max-width: 620px)');
  });
});
