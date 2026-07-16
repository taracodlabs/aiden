import type { CommandRegistry } from './commandRegistry';
import { resolveStartupDashboardTier, startupVisibleWidth, fitStartupLine } from './startupDashboard';
import { scrubString } from '../../core/v4/logger/redact';
import { ProviderError, classifyProviderError } from '../../providers/v4/errors';

export type StartupNoticeSeverity = 'info' | 'action' | 'warning' | 'blocking';
export type StartupNoticeSource =
  | 'provider'
  | 'model'
  | 'authentication'
  | 'local-runtime'
  | 'mcp'
  | 'plugin'
  | 'system';

export interface StartupNotice {
  readonly id: string;
  readonly severity: StartupNoticeSeverity;
  readonly title: string;
  readonly detail?: string;
  readonly command?: string;
  readonly source: StartupNoticeSource;
  readonly blocking: boolean;
  readonly dedupeKey: string;
}

export interface StartupNoticeRenderOptions {
  columns: number;
}

const SAFE_MARGIN = 2;
const COMMAND_PREFIX = /^\/([a-z][a-z0-9-]*)(?:\s+(.+))?$/i;

// Redaction patterns that are broader than the logger's durable-token patterns
// and specific to short-lived startup notice details.
const EXTRA_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:access[_-]?token|refresh[_-]?token|authorization[_-]?code|cookie|set-cookie|credential|api[_-]?key|apikey|password|secret)=\S+/gi,
  /\b(?:access[_-]?token|refresh[_-]?token|authorization[_-]?code|cookie|credential|api[_-]?key|apikey|password|secret)\s*:\s*\S+/gi,
  /Bearer\s+\S+/gi,
];

export function startupNoticeVisibleWidth(value: string): number {
  return startupVisibleWidth(value);
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitize(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  let out = scrubString(raw);
  for (const pattern of EXTRA_SECRET_PATTERNS) out = out.replace(pattern, (match) => {
    const sep = match.includes(':') ? ':' : '=';
    const head = match.split(sep)[0];
    return `${head}${sep}[REDACTED]`;
  });
  return out;
}

function notice(input: StartupNotice): StartupNotice {
  return Object.freeze({
    ...input,
    title: sanitize(input.title) ?? input.title,
    detail: sanitize(input.detail),
    command: clean(input.command),
  });
}

export function buildNoProviderNotice(): StartupNotice {
  return notice({
    id: 'provider:none',
    severity: 'blocking',
    title: 'Provider setup required',
    detail: 'Choose a provider or local runtime before starting normal chat.',
    command: '/model',
    source: 'provider',
    blocking: true,
    dedupeKey: 'provider:none',
  });
}

export function buildAuthenticationNotice(opts: {
  providerId: string;
  state: 'missing-api-key' | 'oauth-required' | 'oauth-expired' | 'unknown';
  detail?: string;
}): StartupNotice {
  const provider = clean(opts.providerId) ?? 'provider';
  if (opts.state === 'oauth-required') {
    return notice({
      id: `auth:${provider}:login`,
      severity: 'action',
      title: `${provider} authorization required`,
      detail: opts.detail ?? 'Authorize this provider before using it.',
      command: `/auth login ${provider}`,
      source: 'authentication',
      blocking: false,
      dedupeKey: `auth:${provider}`,
    });
  }
  if (opts.state === 'oauth-expired') {
    return notice({
      id: `auth:${provider}:expired`,
      severity: 'action',
      title: `${provider} session expired`,
      detail: opts.detail ?? 'Reconnect the provider session.',
      command: `/auth refresh ${provider}`,
      source: 'authentication',
      blocking: false,
      dedupeKey: `auth:${provider}`,
    });
  }
  if (opts.state === 'unknown') {
    return notice({
      id: `auth:${provider}:unknown`,
      severity: 'warning',
      title: `Could not confirm ${provider} authentication`,
      detail: opts.detail,
      command: '/doctor',
      source: 'authentication',
      blocking: false,
      dedupeKey: `auth:${provider}`,
    });
  }
  return notice({
    id: `auth:${provider}:api-key`,
    severity: 'action',
    title: `${provider} credential required`,
    detail: opts.detail ?? 'Add or refresh the credential for this provider.',
    command: '/auth status',
    source: 'authentication',
    blocking: false,
    dedupeKey: `auth:${provider}`,
  });
}

export function buildSavedModelNotice(opts: {
  savedModel: string;
  activeModel?: string;
  available: boolean;
  fallbackActive?: boolean;
}): StartupNotice | null {
  const saved = clean(opts.savedModel);
  if (!saved) return null;
  const active = clean(opts.activeModel);
  if (opts.available) {
    return notice({
      id: `model:saved:${saved}`,
      severity: 'info',
      title: `Saved model: ${saved}`,
      command: undefined,
      source: 'model',
      blocking: false,
      dedupeKey: `model:saved:${saved}`,
    });
  }
  if (opts.fallbackActive && active) {
    return notice({
      id: `model:fallback:${saved}`,
      severity: 'action',
      title: `Saved model unavailable: ${saved}`,
      detail: `Using ${active} for this session.`,
      command: '/model',
      source: 'model',
      blocking: false,
      dedupeKey: `model:fallback:${saved}`,
    });
  }
  return notice({
    id: `model:blocking:${saved}`,
    severity: 'blocking',
    title: `No usable model for saved selection: ${saved}`,
    detail: 'Choose another model before starting normal chat.',
    command: '/model',
    source: 'model',
    blocking: true,
    dedupeKey: `model:blocking:${saved}`,
  });
}

export function buildLocalRuntimeNotice(opts: {
  providerId: string;
  modelId?: string;
  state: 'service-unreachable' | 'service-unhealthy' | 'model-missing' | 'request-failed';
}): StartupNotice {
  const provider = clean(opts.providerId) ?? 'local runtime';
  const model = clean(opts.modelId);
  if (opts.state === 'model-missing') {
    return notice({
      id: `local:${provider}:model-missing:${model ?? 'unknown'}`,
      severity: 'action',
      title: `${provider} model missing`,
      detail: model ? `Configured model ${model} is not installed.` : 'Configured model is not installed.',
      command: '/model',
      source: 'local-runtime',
      blocking: false,
      dedupeKey: `local:${provider}:model-missing:${model ?? 'unknown'}`,
    });
  }
  const title = opts.state === 'service-unreachable'
    ? `${provider} runtime unavailable`
    : opts.state === 'service-unhealthy'
      ? `${provider} runtime unhealthy`
      : `${provider} request failed`;
  return notice({
    id: `local:${provider}:${opts.state}`,
    severity: 'warning',
    title,
    detail: 'Run diagnostics before relying on this local runtime.',
    command: '/doctor',
    source: 'local-runtime',
    blocking: false,
    dedupeKey: `local:${provider}:${opts.state}`,
  });
}

function classifyProviderResolutionMessage(providerId: string, message: string): StartupNotice | null {
  const provider = clean(providerId) ?? 'provider';
  const lower = message.trim().toLowerCase();
  const providerLower = provider.toLowerCase();
  if (lower.includes('requires oauth login') || lower.includes('oauth credentials missing')) {
    return buildAuthenticationNotice({ providerId: provider, state: 'oauth-required' });
  }
  if (
    lower.includes(`oauth token for ${providerLower}`) &&
    (lower.includes('expired') || lower.includes('refresh'))
  ) {
    return buildAuthenticationNotice({ providerId: provider, state: 'oauth-expired' });
  }
  if (
    lower.startsWith(`no api key found for ${providerLower}`) ||
    lower.startsWith(`no credentials found for ${providerLower}`)
  ) {
    return buildAuthenticationNotice({ providerId: provider, state: 'missing-api-key' });
  }
  if (
    providerLower === 'ollama' &&
    (lower.includes('econnrefused') || lower.includes('connection refused') || lower.includes('fetch failed'))
  ) {
    return buildLocalRuntimeNotice({ providerId: provider, state: 'service-unreachable' });
  }
  return null;
}

export function buildProviderResolutionNotice(providerId: string, error: unknown): StartupNotice {
  const provider = clean(providerId) ?? 'provider';
  if (error instanceof ProviderError) {
    const cls = classifyProviderError(error);
    if (cls === 'auth') {
      return buildAuthenticationNotice({ providerId: provider, state: 'unknown' });
    }
    if (cls === 'transport' && provider.toLowerCase() === 'ollama') {
      return buildLocalRuntimeNotice({ providerId: provider, state: 'service-unreachable' });
    }
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const fallback = message ? classifyProviderResolutionMessage(provider, message) : null;
  return fallback ?? buildAuthenticationNotice({ providerId: provider, state: 'unknown' });
}

export function buildProviderFallbackNotice(opts: {
  requestedProvider: string;
  requestedModel?: string;
  activeProvider: string;
  activeModel: string;
  reason?: string;
  explicit?: boolean;
}): StartupNotice {
  const requested = [clean(opts.requestedProvider) ?? 'provider', clean(opts.requestedModel)]
    .filter((part): part is string => !!part)
    .join('/');
  const active = `${clean(opts.activeProvider) ?? 'provider'}/${clean(opts.activeModel) ?? 'model'}`;
  return notice({
    id: `provider:fallback:${requested}:${active}`,
    severity: 'action',
    title: opts.explicit ? 'Requested provider unavailable' : 'Provider fallback active',
    detail: `${requested} failed${opts.reason ? `: ${opts.reason}` : ''}. Using ${active} for this session.`,
    command: '/model',
    source: 'provider',
    blocking: false,
    dedupeKey: `provider:fallback:${requested}`,
  });
}

export function buildMcpAuthNotice(serverName: string): StartupNotice {
  const server = clean(serverName) ?? 'server';
  return notice({
    id: `mcp:auth:${server}`,
    severity: 'action',
    title: `${server} MCP authorization required`,
    command: `/mcp auth ${server}`,
    source: 'mcp',
    blocking: false,
    dedupeKey: `mcp:auth:${server}`,
  });
}

export function buildPluginGrantNotice(pluginName: string): StartupNotice {
  const plugin = clean(pluginName) ?? 'plugin';
  return notice({
    id: `plugin:grant:${plugin}`,
    severity: 'action',
    title: `${plugin} plugin grant required`,
    command: `/plugins grant ${plugin}`,
    source: 'plugin',
    blocking: false,
    dedupeKey: `plugin:grant:${plugin}`,
  });
}

export function commandIsRegisteredOrVerified(command: string | undefined, registry: CommandRegistry): boolean {
  const value = clean(command);
  if (!value) return true;
  const match = COMMAND_PREFIX.exec(value);
  if (!match) return false;
  const name = match[1].toLowerCase();
  const args = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
  if (!registry.get(name)) return false;
  if (name === 'mcp') {
    return args.length === 2 && args[0] === 'auth' && args[1].length > 0;
  }
  if (name === 'plugins') {
    return args.length === 2 && args[0] === 'grant' && args[1].length > 0;
  }
  return true;
}

function priority(n: StartupNotice): number {
  if (n.blocking || n.severity === 'blocking') return 0;
  if (n.source === 'authentication') return 1;
  if (n.source === 'model' || n.source === 'provider' || n.source === 'local-runtime') return 2;
  if (n.source === 'mcp') return 3;
  if (n.source === 'plugin') return 4;
  return 5;
}

export function prepareStartupNotices(
  notices: ReadonlyArray<StartupNotice | null | undefined>,
  registry: CommandRegistry,
): StartupNotice[] {
  const byKey = new Map<string, StartupNotice>();
  for (const raw of notices) {
    if (!raw) continue;
    if (!commandIsRegisteredOrVerified(raw.command, registry)) {
      throw new Error(`unregistered startup notice command: ${raw.command}`);
    }
    const key = raw.dedupeKey || raw.id;
    if (!byKey.has(key)) byKey.set(key, notice(raw));
  }
  return [...byKey.values()].sort((a, b) => priority(a) - priority(b));
}

function safeWidth(columns: number): number {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  return Math.max(1, width - SAFE_MARGIN);
}

function fit(value: string, width: number): string {
  return fitStartupLine(value, width);
}

export function renderStartupNoticeLines(
  notices: ReadonlyArray<StartupNotice>,
  opts: StartupNoticeRenderOptions,
): string[] {
  if (notices.length === 0) return [];
  const width = safeWidth(opts.columns);
  const tier = resolveStartupDashboardTier(opts.columns);
  const lines: string[] = [];

  if (tier === 'wide') {
    lines.push('Setup and notices', '');
    for (const n of notices) {
      lines.push(fit(`! ${n.title}`, width));
      if (n.detail) lines.push(fit(`  ${n.detail}`, width));
      if (n.command) lines.push(fit(`  Run: ${n.command}`, width));
      lines.push('');
    }
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  if (tier === 'medium') {
    lines.push('Notices');
    for (const n of notices) {
      const action = n.command ? `: ${n.command}` : n.detail ? `: ${n.detail}` : '';
      lines.push(fit(`! ${n.title}${action}`, width));
    }
    return lines;
  }

  if (tier === 'narrow') {
    for (const n of notices) {
      const action = n.command ? `: ${n.command}` : '';
      lines.push(fit(`! ${compactTitle(n)}${action}`, width));
    }
    return lines;
  }

  const first = notices.find((n) => n.blocking || n.severity !== 'info') ?? notices[0];
  lines.push(fit('! Setup required', width));
  lines.push(fit(`Run ${first.command ?? '/doctor'}`, width));
  return lines;
}

function compactTitle(n: StartupNotice): string {
  if (n.source === 'mcp') return 'MCP auth';
  if (n.source === 'plugin') return 'Plugin grant';
  if (n.source === 'authentication') return n.title.replace(/\s+authorization required/i, ' auth');
  if (n.source === 'provider') return n.title.replace(/^Provider /, '');
  return n.title;
}
