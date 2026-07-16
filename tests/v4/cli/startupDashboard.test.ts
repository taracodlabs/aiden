import { describe, expect, it } from 'vitest';

import {
  renderStartupDashboard,
  resolveStartupDashboardTier,
  startupVisibleWidth,
  type StartupDashboardData,
} from '../../../cli/v4/startupDashboard';

const base: StartupDashboardData = {
  trust: 'Partner',
  model: 'gpt-5.6-sol',
  memory: 'active',
  version: '4.14.9',
  providerReady: true,
  environment: {
    os: 'Windows 11',
    shell: 'PowerShell',
    runtime: 'local-first',
    tools: 77,
    skills: 76,
  },
  capabilities: {
    web: 'research · extract',
    browser: 'navigate · automate',
    files: 'read · patch · organize',
    execution: 'shell · code · workflows',
    memory: 'persistent recall',
  },
  project: {
    identity: 'Built solo',
    github: 'github.com/taracodlabs/aiden',
    website: 'aiden.taracod.com',
    contact: 'contact@taracod.com',
  },
  greeting: 'Ready when you are.',
  helper: 'Type your message · /help for commands · /skills to add more',
};

const banner = [
  '█████╗  ██╗██████╗ ███████╗███╗   ██╗',
  '██╔══██╗██║██╔══██╗██╔════╝████╗  ██║',
].join('\n');

function render(columns: number, data: StartupDashboardData = base): string[] {
  return renderStartupDashboard({ columns, data, banner }).lines;
}

function assertBounded(lines: string[], columns: number): void {
  for (const line of lines) {
    expect(startupVisibleWidth(line), line).toBeLessThanOrEqual(Math.max(1, columns - 2));
  }
}

describe('responsive startup dashboard', () => {
  it.each([
    [120, 'wide'],
    [80, 'medium'],
    [48, 'narrow'],
    [20, 'minimal'],
  ] as const)('selects the deterministic %s-column tier', (columns, tier) => {
    expect(resolveStartupDashboardTier(columns)).toBe(tier);
  });

  it('renders the wide dashboard with complete runtime and project state', () => {
    const lines = render(120);
    const text = lines.join('\n');
    expect(text).toContain('Autonomous AI Engine');
    expect(text).toContain('Environment');
    expect(text).toContain('Capabilities');
    expect(text).toContain('Partner');
    expect(text).toContain('gpt-5.6-sol');
    expect(text).toContain('memory active');
    expect(text).toContain('v4.14.9');
    expect(text).toContain('77 loaded');
    expect(text).toContain('76 loaded');
    expect(text).toContain('Built solo');
    expect(text).toContain('╭');
    expect(text).toContain('╯');
    assertBounded(lines, 120);
  });

  it('renders a stacked medium dashboard without forcing the wide table or frame', () => {
    const lines = render(80);
    const text = lines.join('\n');
    expect(text).toContain('Environment');
    expect(text).toContain('Capabilities');
    expect(text).toContain('77 tools');
    expect(text).toContain('76 skills');
    expect(text).toContain('github.com/taracodlabs/aiden');
    expect(text).not.toContain('╭');
    assertBounded(lines, 80);
  });

  it('keeps the compact narrow layout and omits detailed sections', () => {
    const lines = render(48);
    const text = lines.join('\n');
    expect(text).toContain('AIDEN');
    expect(text).toContain('Partner');
    expect(text).toContain('gpt-5.6-sol');
    expect(text).toContain('built solo');
    expect(text).not.toContain('Environment');
    expect(text).not.toContain('Capabilities');
    expect(text).not.toContain('╭');
    assertBounded(lines, 48);
  });

  it('is safe at minimal widths and never creates negative padding or broken borders', () => {
    const lines = render(20);
    expect(lines.join('\n')).toContain('AIDEN');
    expect(lines.join('\n')).not.toMatch(/undefined|null|NaN/);
    expect(lines.join('\n')).not.toContain('╭');
    assertBounded(lines, 20);
  });

  it('truncates long model names and large counts without hiding trust', () => {
    const lines = render(48, {
      ...base,
      model: 'provider/extraordinarily-long-model-name-that-cannot-fit',
      environment: { ...base.environment, tools: 1234567, skills: 9876543 },
    });
    const text = lines.join('\n');
    expect(text).toContain('Partner');
    expect(text).toContain('…');
    assertBounded(lines, 48);
  });

  it('omits unavailable optional values without leaking placeholders', () => {
    const lines = render(120, {
      ...base,
      memory: undefined,
      version: undefined,
      persistedModelNote: undefined,
      capabilities: undefined,
      project: { ...base.project, contact: undefined },
    });
    const text = lines.join('\n');
    expect(text).not.toMatch(/undefined|null|NaN/);
    expect(text).not.toContain('Contact:');
    expect(text).not.toContain('Capabilities');
    assertBounded(lines, 120);
  });

  it('renders a persisted-model notice and bounded greeting only when supplied', () => {
    const lines = render(80, {
      ...base,
      persistedModelNote: 'persisted from prior session — /model to change',
      greeting: 'A deliberately long readiness greeting that must never wrap into the composer area at medium width',
    });
    const text = lines.join('\n');
    expect(text).toContain('persisted from prior session');
    expect(text).toContain('A deliberately long readiness greeting');
    assertBounded(lines, 80);
  });
});
