import { describe, expect, it } from 'vitest';

import {
  renderStartupDashboard,
  resolveStartupDashboardTier,
  resolveStartupLogoTier,
  startupVisibleWidth,
  type StartupDashboardData,
} from '../../../cli/v4/startupDashboard';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { AIDEN_LOGO_LINES } from '../../../core/v4/ui/identity';

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

const banner = AIDEN_LOGO_LINES.join('\n');

function render(columns: number, data: StartupDashboardData = base): string[] {
  return renderStartupDashboard({ columns, data, banner }).lines;
}

function assertBounded(lines: string[], columns: number): void {
  for (const line of lines) {
    expect(startupVisibleWidth(line), line).toBeLessThanOrEqual(Math.max(1, columns - 2));
  }
}

describe('responsive startup dashboard', () => {
  it('preserves the full canonical startup identity at every supported width', () => {
    expect(resolveStartupLogoTier(100, banner)).toBe('full');
    expect(resolveStartupLogoTier(60, banner)).toBe('full');
    expect(resolveStartupLogoTier(44, banner)).toBe('full');
  });

  it.each([
    [120, 'wide'],
    [80, 'wide'],
    [60, 'medium'],
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
    expect(text).toContain('│');
    expect(text).toContain('Built solo');
    expect(text).toContain('╭');
    expect(text).toContain('╯');
    assertBounded(lines, 120);
  });

  it('renders a side-by-side normal-width dashboard while preserving the bordered project card', () => {
    const lines = render(80);
    const text = lines.join('\n');
    expect(text).toContain('Environment');
    expect(text).toContain('Capabilities');
    expect(text).toContain('77 loaded');
    expect(text).toContain('76 loaded');
    expect(text).toContain('│');
    expect(text).toContain('github.com/taracodlabs/aiden');
    expect(text).toContain('╭');
    expect(text).toContain('╯');
    assertBounded(lines, 80);
  });

  it('keeps the full identity, narrow layout, project details, and bounded card', () => {
    const lines = render(48);
    const text = lines.join('\n');
    expect(AIDEN_LOGO_LINES.every((line) => text.includes(line))).toBe(true);
    expect(text).not.toContain('A I D E N');
    expect(text).toContain('Partner');
    expect(text).toContain('gpt-5.6-sol');
    expect(text).toContain('Built solo');
    expect(text).toContain('github.com/taracodlabs/aiden');
    expect(text).toContain('aiden.taracod.com');
    expect(text).toContain('contact@taracod.com');
    expect(text).toContain('Environment');
    expect(text).toContain('Capabilities');
    expect(text).toContain('Windows 11');
    expect(text).toContain('PowerShell');
    expect(text).toContain('web');
    expect(text).toContain('browser');
    expect(text).toContain('╭');
    expect(text).toContain('╯');
    assertBounded(lines, 48);
  });

  it('uses distinct metadata glyphs and semantic colors for runtime state', () => {
    const mark = (code: number) => (value: string): string => `\x1b[${code}m${value}\x1b[39m`;
    const lines = renderStartupDashboard({
      columns: 120,
      data: base,
      banner,
      style: {
        brand: mark(31),
        muted: mark(90),
        text: mark(37),
        success: mark(32),
        info: mark(36),
      } as never,
    }).lines;
    const text = lines.join('\n');
    expect(text).toContain('\x1b[32m●\x1b[39m');
    expect(text).toContain('\x1b[36m◇\x1b[39m');
    expect(text).toContain('\x1b[36m◆\x1b[39m');
    expect(text).toContain('\x1b[32m77 loaded\x1b[39m');
    expect(text).toContain('\x1b[32m76 loaded\x1b[39m');
  });

  it.each([60, 44])('retains labelled environment and capability rows at %i columns', (columns) => {
    const lines = render(columns);
    const text = lines.join('\n');
    expect(text).toContain('Environment');
    expect(text).toContain('Capabilities');
    expect(text).toContain('OS');
    expect(text).toContain('shell');
    expect(text).toContain('web');
    expect(text).toContain('files');
    assertBounded(lines, columns);
  });

  it.each([160, 120, 100, 80, 60, 44])(
    'preserves the golden startup identity at %i columns',
    (columns) => {
      const lines = render(columns);
      const text = lines.join('\n');
      expect(resolveStartupLogoTier(columns, banner)).toBe('full');
      for (const logoLine of AIDEN_LOGO_LINES) expect(text).toContain(logoLine);
      expect(text).not.toContain('A I D E N');
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

  it.each([160, 120, 100, 80])(
    'keeps the complete fitting logo on the Aiden orange accent at %i columns',
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
      for (const logoLine of banner.split('\n')) {
        expect(plainLines.some((line) => line.endsWith(logoLine))).toBe(true);
      }
      const logo = lines.slice(0, banner.split('\n').length).join('\n');
      expect(logo).toContain('\x1b[38;2;255;107;53m');
    },
  );

  it.each([60, 44])('never wraps or replaces the startup identity at %i columns', (columns) => {
    const lines = render(columns);
    const text = lines.join('\n');
    for (const logoLine of AIDEN_LOGO_LINES) expect(text).toContain(logoLine);
    expect(text).not.toContain('A I D E N');
    assertBounded(lines, columns);
  });

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

  it('blocks normal startup below the canonical identity width', () => {
    const lines = render(20);
    const text = lines.join('\n');
    const logicalText = text.replace(/\s+/g, ' ');
    expect(logicalText).toMatch(/Aiden requires at least \d+ columns to display its boot interface\./);
    expect(logicalText).toContain('Widen the terminal to continue.');
    expect(text).not.toContain('A I D E N');
    expect(text).not.toContain('Autonomous AI Engine');
    expect(text).not.toContain('Environment');
    expect(text).not.toContain('Built solo');
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
