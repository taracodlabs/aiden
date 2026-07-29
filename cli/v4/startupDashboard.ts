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
  info?(value: string): string;
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
  info: (value) => value,
};

export function startupVisibleWidth(value: string): number {
  return stringWidth(value.replace(ANSI, ''));
}

export function resolveStartupDashboardTier(columns: number): StartupDashboardTier {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  if (width >= 80) return 'wide';
  if (width >= 56) return 'medium';
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

/** Wrap plain startup copy without dropping words or splitting wide glyphs. */
function wrapPlain(value: string, maxWidth: number): string[] {
  const width = Math.max(1, Math.floor(maxWidth));
  const words = value.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let line = '';
  const pushLongWord = (word: string): string => {
    let rest = word;
    while (startupVisibleWidth(rest) > width) {
      let chunk = '';
      for (const point of rest) {
        if (startupVisibleWidth(chunk + point) > width) break;
        chunk += point;
      }
      lines.push(chunk);
      rest = rest.slice(chunk.length);
    }
    return rest;
  };
  for (const rawWord of words) {
    const word = startupVisibleWidth(rawWord) > width ? pushLongWord(rawWord) : rawWord;
    if (!word) continue;
    if (!line) {
      line = word;
    } else if (startupVisibleWidth(`${line} ${word}`) <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
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
  const info = style.info ?? style.text;
  const healthy = style.success('●');
  const trustGlyph = info('◇');
  const modelGlyph = info('◆');
  const model = data.providerReady ? clean(data.model) ?? 'not configured' : 'not configured';
  const segments = tier === 'wide' && width >= 98
    ? [
        `${healthy} ${style.muted('core')} ${style.success('online')}`,
        `${trustGlyph} ${style.muted('trust')} ${info(clean(data.trust) ?? 'Assistant')}`,
        `${modelGlyph} ${style.muted('model')} ${info(model)}`,
        clean(data.memory) ? `${healthy} ${style.muted('memory')} ${style.success(data.memory!)}` : undefined,
        clean(data.version) ? style.muted(`v${data.version}`) : undefined,
      ]
    : [
        `${trustGlyph} ${info(clean(data.trust) ?? 'Assistant')}`,
        `${modelGlyph} ${info(model)}`,
        clean(data.memory) ? `${healthy} ${style.success(`memory ${data.memory}`)}` : undefined,
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
  valueStyle: (value: string) => string = style.text,
): string {
  const label = style.muted(key.padEnd(keyWidth));
  return fit(label + valueStyle(value), width);
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

  const separator = style.muted(' │ ');
  const columnWidth = Math.max(1, Math.floor((width - startupVisibleWidth(separator)) / 2));
  const leftLines = [style.brand('Environment'), ...left.map(([key, value]) => renderKeyValue(
    key,
    value,
    style,
    columnWidth,
    10,
    key === 'tools' || key === 'skills' ? style.success : style.text,
  ))];
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
  const lines: string[] = [];
  const environment = environmentRows(data.environment);
  if (environment.length > 0) {
    lines.push(style.brand('Environment'));
    lines.push(...environment.map(([key, value]) => renderKeyValue(
      key,
      value,
      style,
      width,
      10,
      key === 'tools' || key === 'skills' ? style.success : style.text,
    )));
  }
  const capabilities = capabilityRows(data.capabilities);
  if (capabilities.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(style.brand('Capabilities'));
    lines.push(...capabilities.map(([key, value]) => renderKeyValue(key, value, style, width)));
  }
  return lines;
}

function renderProject(
  data: StartupProjectData,
  style: StartupDashboardStyle,
  _tier: StartupDashboardTier,
  width: number,
): string[] {
  const identity = clean(data.identity) ?? 'Built solo';
  const indent = width >= 36 ? '  ' : '';
  const frameWidth = Math.max(4, Math.min(width - startupVisibleWidth(indent), 72));
  const inside = Math.max(2, frameWidth - 2);
  const contentWidth = Math.max(1, inside - 2);
  const rows: string[] = [`♥  ${identity}`, ''];
  const addDetail = (label: string, value: string | undefined): void => {
    if (!value) return;
    const labelWidth = Math.min(9, contentWidth);
    const firstPrefix = `${label}:`.padEnd(labelWidth);
    const continuationPrefix = ' '.repeat(labelWidth);
    const valueWidth = Math.max(1, contentWidth - labelWidth);
    const wrapped = wrapPlain(value, valueWidth);
    wrapped.forEach((line, index) => rows.push(`${index === 0 ? firstPrefix : continuationPrefix}${line}`));
  };
  addDetail('GitHub', clean(data.github));
  addDetail('Web', clean(data.website));
  addDetail('Contact', clean(data.contact));
  return [
    `${indent}${style.muted(`╭${'─'.repeat(inside)}╮`)}`,
    ...rows.map((row) => {
      const colored = row.startsWith('♥')
        ? `${style.brand('♥')}${style.text(row.slice(1))}`
        : style.text(row);
      return `${indent}${style.muted('│')} ${pad(colored, contentWidth)} ${style.muted('│')}`;
    }),
    `${indent}${style.muted(`╰${'─'.repeat(inside)}╯`)}`,
  ];
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
  const bannerLines = normalizeBanner(options.banner, width);

  if (bannerLines.length > 0) {
    lines.push(...bannerLines, style.muted('Autonomous AI Engine'), '');
  } else {
    lines.push(style.brand('Aiden'));
    lines.push(style.muted('Autonomous AI Engine'));
  }

  lines.push(statusLine(data, style, tier, width));
  if (clean(data.persistedModelNote)) lines.push(style.muted(fit(data.persistedModelNote!, width)));

  if (tier === 'wide' || tier === 'medium' || tier === 'narrow') {
    lines.push('', style.muted('─'.repeat(width)), '');
    lines.push(...(tier === 'wide'
      ? renderWideSections(data, style, width)
      : renderMediumSections(data, style, width)));
    lines.push('', style.muted('─'.repeat(width)), '');
  }

  lines.push(...renderProject(data.project, style, tier, width));
  if (clean(data.greeting)) {
    lines.push('', ...wrapPlain(data.greeting!, width).map((line) => style.text(line)));
  }
  if (clean(data.helper)) {
    lines.push(...wrapPlain(data.helper!, width).map((line) => style.muted(line)));
  }

  return {
    tier,
    lines: lines.map((line) => fit(line, width)),
  };
}
