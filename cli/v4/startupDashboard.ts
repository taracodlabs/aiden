/**
 * Pure, one-shot startup dashboard renderer.
 *
 * The dashboard is transcript content: callers render it once at boot. Live
 * resize handling remains owned by the composer and activity surfaces.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (value: string) => number = require('string-width');

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SAFE_MARGIN = 2;

export type StartupDashboardTier = 'wide' | 'medium' | 'narrow' | 'minimal';

export interface StartupEnvironmentData {
  os?: string;
  shell?: string;
  runtime?: string;
  tools?: number;
  skills?: number;
}

export interface StartupCapabilityData {
  web?: string;
  browser?: string;
  files?: string;
  execution?: string;
  memory?: string;
}

export interface StartupProjectData {
  identity: string;
  github?: string;
  website?: string;
  contact?: string;
}

export interface StartupDashboardData {
  trust: string;
  model: string;
  memory?: string;
  version?: string;
  providerReady: boolean;
  environment?: StartupEnvironmentData;
  capabilities?: StartupCapabilityData;
  project: StartupProjectData;
  persistedModelNote?: string;
  greeting?: string;
  helper?: string;
}

export interface StartupDashboardStyle {
  brand(value: string): string;
  muted(value: string): string;
  text(value: string): string;
  success(value: string): string;
}

export interface RenderStartupDashboardOptions {
  columns: number;
  data: StartupDashboardData;
  banner?: string;
  style?: StartupDashboardStyle;
}

export interface RenderedStartupDashboard {
  tier: StartupDashboardTier;
  lines: string[];
}

const PLAIN_STYLE: StartupDashboardStyle = {
  brand: (value) => value,
  muted: (value) => value,
  text: (value) => value,
  success: (value) => value,
};

export function startupVisibleWidth(value: string): number {
  return stringWidth(value.replace(ANSI, ''));
}

export function resolveStartupDashboardTier(columns: number): StartupDashboardTier {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  if (width >= 100) return 'wide';
  if (width >= 64) return 'medium';
  if (width >= 32) return 'narrow';
  return 'minimal';
}

function safeWidth(columns: number): number {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  return Math.max(1, width - SAFE_MARGIN);
}

/** Truncate by terminal cells while preserving ANSI control sequences. */
export function fitStartupLine(value: string, maxWidth: number): string {
  const width = Math.max(1, Math.floor(maxWidth));
  if (startupVisibleWidth(value) <= width) return value;
  if (width === 1) return '…';

  let result = '';
  let plain = '';
  let index = 0;
  let sawAnsi = false;
  while (index < value.length) {
    if (value[index] === '\x1b' && value[index + 1] === '[') {
      const match = value.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        result += match[0];
        index += match[0].length;
        sawAnsi = true;
        continue;
      }
    }

    const point = String.fromCodePoint(value.codePointAt(index) ?? 0);
    if (stringWidth(plain + point) > width - 1) break;
    result += point;
    plain += point;
    index += point.length;
  }
  return `${result}…${sawAnsi ? '\x1b[0m' : ''}`;
}

function fit(value: string, width: number): string {
  return fitStartupLine(value, Math.max(1, width));
}

function pad(value: string, width: number): string {
  const fitted = fit(value, width);
  return fitted + ' '.repeat(Math.max(0, width - startupVisibleWidth(fitted)));
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function countLabel(value: number | undefined, noun: string, suffix = ''): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return `${Math.max(0, Math.floor(value!))} ${noun}${suffix}`;
}

function statusLine(
  data: StartupDashboardData,
  style: StartupDashboardStyle,
  tier: StartupDashboardTier,
  width: number,
): string {
  const dot = style.success('●');
  const model = data.providerReady ? clean(data.model) ?? 'not configured' : 'not configured';
  const segments = tier === 'wide'
    ? [
        `${dot} ${style.muted('core')} ${style.text('online')}`,
        `${dot} ${style.muted('trust')} ${style.text(clean(data.trust) ?? 'Assistant')}`,
        `${dot} ${style.muted('model')} ${style.text(model)}`,
        clean(data.memory) ? `${dot} ${style.muted('memory')} ${style.text(data.memory!)}` : undefined,
        clean(data.version) ? `${dot} ${style.text(`v${data.version}`)}` : undefined,
      ]
    : [
        `${dot} ${style.text(clean(data.trust) ?? 'Assistant')}`,
        `${style.text(model)}`,
        clean(data.memory) ? style.muted(`memory ${data.memory}`) : undefined,
        clean(data.version) ? style.muted(`v${data.version}`) : undefined,
      ];
  return fit(segments.filter((entry): entry is string => !!entry).join(' · '), width);
}

function environmentRows(data: StartupEnvironmentData | undefined): Array<[string, string]> {
  if (!data) return [];
  return [
    ['OS', clean(data.os)],
    ['shell', clean(data.shell)],
    ['runtime', clean(data.runtime)],
    ['tools', countLabel(data.tools, 'loaded')],
    ['skills', countLabel(data.skills, 'loaded')],
  ].filter((row): row is [string, string] => !!row[1]);
}

function capabilityRows(data: StartupCapabilityData | undefined): Array<[string, string]> {
  if (!data) return [];
  return [
    ['web', clean(data.web)],
    ['browser', clean(data.browser)],
    ['files', clean(data.files)],
    ['execution', clean(data.execution)],
    ['memory', clean(data.memory)],
  ].filter((row): row is [string, string] => !!row[1]);
}

function renderKeyValue(
  key: string,
  value: string,
  style: StartupDashboardStyle,
  width: number,
  keyWidth = 10,
): string {
  const label = style.muted(key.padEnd(keyWidth));
  return fit(label + style.text(value), width);
}

function renderWideSections(
  data: StartupDashboardData,
  style: StartupDashboardStyle,
  width: number,
): string[] {
  const left = environmentRows(data.environment);
  const right = capabilityRows(data.capabilities);
  if (left.length === 0 && right.length === 0) return [];
  if (right.length === 0) {
    return [style.brand('Environment'), ...left.map(([key, value]) => renderKeyValue(key, value, style, width))];
  }
  if (left.length === 0) {
    return [style.brand('Capabilities'), ...right.map(([key, value]) => renderKeyValue(key, value, style, width))];
  }

  const separator = '    ';
  const columnWidth = Math.max(1, Math.floor((width - startupVisibleWidth(separator)) / 2));
  const leftLines = [style.brand('Environment'), ...left.map(([key, value]) => renderKeyValue(key, value, style, columnWidth))];
  const rightLines = [style.brand('Capabilities'), ...right.map(([key, value]) => renderKeyValue(key, value, style, columnWidth))];
  const count = Math.max(leftLines.length, rightLines.length);
  return Array.from({ length: count }, (_, index) =>
    fit(pad(leftLines[index] ?? '', columnWidth) + separator + fit(rightLines[index] ?? '', columnWidth), width));
}

function renderMediumSections(
  data: StartupDashboardData,
  style: StartupDashboardStyle,
  width: number,
): string[] {
  const environment = data.environment;
  const lines: string[] = [];
  const summary = [clean(environment?.os), clean(environment?.shell), clean(environment?.runtime)]
    .filter((entry): entry is string => !!entry);
  const counts = [countLabel(environment?.tools, 'tools'), countLabel(environment?.skills, 'skills')]
    .filter((entry): entry is string => !!entry);
  if (summary.length > 0 || counts.length > 0) {
    lines.push(style.brand('Environment'));
    if (summary.length > 0) lines.push(fit(style.text(summary.join(' · ')), width));
    if (counts.length > 0) lines.push(fit(style.muted(counts.join(' · ')), width));
  }
  const capabilities = capabilityRows(data.capabilities).map(([, value]) => value);
  if (capabilities.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(style.brand('Capabilities'));
    lines.push(fit(style.text(Object.keys(data.capabilities ?? {}).join(' · ')), width));
  }
  return lines;
}

function renderProject(
  data: StartupProjectData,
  style: StartupDashboardStyle,
  tier: StartupDashboardTier,
  width: number,
): string[] {
  const identity = clean(data.identity) ?? 'Built solo';
  if (tier === 'wide') {
    const frameWidth = Math.min(width, 72);
    const inside = Math.max(1, frameWidth - 2);
    const rows = [
      `${style.brand('♥')}  ${style.text(identity)}`,
      '',
      clean(data.github) ? `${style.brand('GitHub:'.padEnd(10))}${style.text(data.github!)}` : undefined,
      clean(data.website) ? `${style.brand('Web:'.padEnd(10))}${style.text(data.website!)}` : undefined,
      clean(data.contact) ? `${style.brand('Contact:'.padEnd(10))}${style.text(data.contact!)}` : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    return [
      style.muted(`╭${'─'.repeat(inside)}╮`),
      ...rows.map((row) => `${style.muted('│')}${pad(` ${row}`, inside)}${style.muted('│')}`),
      style.muted(`╰${'─'.repeat(inside)}╯`),
    ];
  }
  if (tier === 'medium') {
    return [
      `${style.brand('♥')} ${style.text(identity)}`,
      ...[clean(data.github), clean(data.website), clean(data.contact)]
        .filter((entry): entry is string => !!entry)
        .map((entry) => fit(style.muted(entry), width)),
    ];
  }
  const repo = clean(data.github)?.replace(/^github\.com\//, '') ?? clean(data.website) ?? '';
  return [fit(`${style.brand('♥')} ${style.muted(`${identity.toLowerCase()}${repo ? ` · ${repo}` : ''}`)}`, width)];
}

function normalizeBanner(banner: string | undefined, width: number): string[] {
  if (!banner) return [];
  const lines = banner.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.some((line) => startupVisibleWidth(line) > width)) return [];
  return lines;
}

export function renderStartupDashboard(options: RenderStartupDashboardOptions): RenderedStartupDashboard {
  const style = options.style ?? PLAIN_STYLE;
  const width = safeWidth(options.columns);
  const tier = resolveStartupDashboardTier(options.columns);
  const data = options.data;
  const lines: string[] = [];
  const bannerLines = tier === 'wide' || tier === 'medium'
    ? normalizeBanner(options.banner, width)
    : [];

  if (bannerLines.length > 0) {
    lines.push(...bannerLines, style.muted('Autonomous AI Engine'), '');
  } else {
    lines.push(style.brand('AIDEN'));
    if (tier !== 'minimal') lines.push(style.muted('Autonomous AI Engine'));
  }

  lines.push(statusLine(data, style, tier, width));
  if (clean(data.persistedModelNote)) lines.push(style.muted(fit(data.persistedModelNote!, width)));

  if (tier === 'wide' || tier === 'medium') {
    lines.push('', style.muted('─'.repeat(width)), '');
    lines.push(...(tier === 'wide'
      ? renderWideSections(data, style, width)
      : renderMediumSections(data, style, width)));
    lines.push('', style.muted('─'.repeat(width)), '');
  }

  lines.push(...renderProject(data.project, style, tier, width));
  if (clean(data.greeting)) lines.push('', fit(style.text(data.greeting!), width));
  if (clean(data.helper)) lines.push(fit(style.muted(data.helper!), width));

  return {
    tier,
    lines: lines.map((line) => fit(line, width)),
  };
}
