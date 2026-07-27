import { describe, expect, it } from 'vitest';

import {
  renderStartupDashboard,
  resolveStartupDashboardTier,
  startupVisibleWidth,
  type StartupDashboardData,
} from '../../../cli/v4/startupDashboard';
import { SkinEngine } from '../../../cli/v4/skinEngine';

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
  '███████║██║██║  ██║█████╗  ██╔██╗ ██║',
  '██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║',
  '██║  ██║██║██████╔╝███████╗██║ ╚████║',
  '╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝',
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

  it('renders a stacked medium dashboard while preserving the bordered project card', () => {
    const lines = render(80);
    const text = lines.join('\n');
    expect(text).toContain('Environment');
    expect(text).toContain('Capabilities');
    expect(text).toContain('77 tools');
    expect(text).toContain('76 skills');
    expect(text).toContain('github.com/taracodlabs/aiden');
    expect(text).toContain('╭');
    expect(text).toContain('╯');
    assertBounded(lines, 80);
  });

  it('keeps the compact narrow layout, full project details, and bounded card', () => {
    const lines = render(48);
    const text = lines.join('\n');
    expect(text).toContain(banner.split('\n')[0]);
    expect(text).toContain('Partner');
    expect(text).toContain('gpt-5.6-sol');
    expect(text).toContain('Built solo');
    expect(text).toContain('github.com/taracodlabs/aiden');
    expect(text).toContain('aiden.taracod.com');
    expect(text).toContain('contact@taracod.com');
    expect(text).not.toContain('Environment');
    expect(text).not.toContain('Capabilities');
    expect(text).toContain('╭');
    expect(text).toContain('╯');
    assertBounded(lines, 48);
  });

  it.each([160, 120, 100, 80, 60, 44])(
    'preserves the golden startup identity at %i columns',
    (columns) => {
      const lines = render(columns);
      const text = lines.join('\n');
      const logoFits = startupVisibleWidth(banner.split('\n')[0]) <= columns - 2;
      expect(text).toContain(logoFits ? banner.split('\n')[0] : 'Aiden');
      expect(text).toContain('Autonomous AI Engine');
      expect(text).toContain('Built solo');
      expect(text).toContain('GitHub:');
      expect(text).toContain('Web:');
      expect(text).toContain('Contact:');
      expect(text).toContain('╭');
      expect(text).toContain('╯');
      expect(text).toContain('Ready when you are.');
      assertBounded(lines, columns);
    },
  );

  it.each([160, 120, 100, 80, 60, 44])(
    'keeps the Built solo card compact and indented at %i columns',
    (columns) => {
      const lines = render(columns);
      const top = lines.find((line) => line.includes('╭')) ?? '';
      const card = lines.filter((line) => /^[ ]{2}[╭│╰]/u.test(line));
      expect(top.startsWith('  ╭')).toBe(true);
      expect(card.length).toBeGreaterThanOrEqual(6);
      expect(startupVisibleWidth(top)).toBeLessThanOrEqual(Math.min(columns, 74));
    },
  );

  it.each([160, 120, 100, 80, 60, 44])(
    'keeps the complete logo on the Aiden orange accent at %i columns',
    (columns) => {
      const skin = new SkinEngine({ colorDepth: 'truecolor' });
      const coloredBanner = banner.split('\n').map((line) => skin.applyColors(line, 'brand')).join('\n');
      const lines = renderStartupDashboard({
        columns,
        data: base,
        banner: coloredBanner,
        style: {
          brand: (value) => skin.applyColors(value, 'brand'),
          muted: (value) => skin.applyColors(value, 'muted'),
          text: (value) => skin.applyColors(value, 'agent'),
          success: (value) => skin.applyColors(value, 'success'),
        },
      }).lines;
      const plainLines = lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ''));
      for (const logoLine of banner.split('\n')) expect(plainLines).toContain(logoLine);
      const logo = lines.slice(0, banner.split('\n').length).join('\n');
      expect(logo).toContain('\x1b[38;2;255;107;53m');
    },
  );

  it('wraps the welcome and helper instead of truncating either message', () => {
    const lines = render(44, {
      ...base,
      greeting: 'Welcome back. What would you like to build with Aiden today?',
      helper: 'Type your message · /help for commands · /skills to add more',
    });
    const text = lines.join('\n');
    expect(text).toContain('Welcome back. What would you like to build');
    expect(text).toContain('with Aiden today?');
    expect(text).toContain('/skills to add more');
    assertBounded(lines, 44);
  });

  it.each([160, 120, 100, 80, 60, 44])(
    'keeps startup geometry independent of theme color at %i columns',
    (columns) => {
      const plain = renderStartupDashboard({ columns, data: base, banner }).lines;
      const styled = renderStartupDashboard({
        columns,
        data: base,
        banner,
        style: {
          brand: (value) => `\x1b[38;2;255;107;53m${value}\x1b[39m`,
          muted: (value) => `\x1b[38;2;184;168;154m${value}\x1b[39m`,
          text: (value) => `\x1b[38;2;232;235;240m${value}\x1b[39m`,
          success: (value) => `\x1b[38;2;127;194;139m${value}\x1b[39m`,
        },
      }).lines;
      expect(styled).toHaveLength(plain.length);
      expect(styled.map(startupVisibleWidth)).toEqual(plain.map(startupVisibleWidth));
      expect(plain.some((line, index) => line === '' && plain[index + 1] === '')).toBe(false);
    },
  );

  it('is safe at minimal widths and never creates negative padding or broken borders', () => {
    const lines = render(20);
    expect(lines.join('\n')).toContain('Aiden');
    expect(lines.join('\n')).not.toMatch(/undefined|null|NaN/);
    expect(lines.join('\n')).toContain('╭');
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
