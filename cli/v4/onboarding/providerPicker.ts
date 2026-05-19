/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/onboarding/providerPicker.ts — ONB1 slice 5.
 *
 * Rich provider picker for the redesigned first-run flow. Replaces
 * the wizard's plain `prompts.choose(question, labels[])` call with
 * an @inquirer/prompts `select` that renders:
 *
 *     ❯ Claude (Anthropic)             Best for code · API key
 *       ChatGPT (OpenAI)                Most popular  · API key
 *       Groq                            Free, fast    · Free
 *       Gemini (Google)                 Free tier     · Free
 *       Ollama                          Offline       · Local
 *       Claude Pro                      Subscription  · OAuth
 *       ChatGPT Plus                    Subscription  · OAuth
 *       Other                            Custom URL    · Custom
 *
 * Badge → colour:
 *   Free   → success green
 *   API key → accent (light orange)
 *   OAuth  → primary brand orange
 *   Local  → muted
 *   Custom → muted
 *
 * Esc / Ctrl+C handling: inquirer raises a "force closed" Error; the
 * wizard's outer loop already converts that to a graceful explore-mode
 * exit, so we re-raise unchanged.
 */

import { c, termWidth } from '../../../core/v4/ui/theme';
import type { ProviderOption } from '../setupWizard';

export interface RichChoice {
  /** Unique provider id (matches ProviderOption.id). */
  id: string;
  /** Short display label, e.g. "Groq". */
  title: string;
  /** Short description, e.g. "Free · fast · no card". */
  description: string;
  /** Badge category drives colour + suffix label. */
  badge: 'free' | 'api' | 'oauth' | 'local' | 'custom';
}

/**
 * Derive a RichChoice from a `ProviderOption`. The existing wizard
 * labels are `<shortLabel> — <description>` strings — we split on the
 * em-dash to get a clean description, and map `kind` to a badge.
 */
export function toRichChoice(p: ProviderOption): RichChoice {
  const parts = p.label.split(' — ');
  const description = parts.length > 1 ? parts.slice(1).join(' — ') : p.shortLabel;
  let badge: RichChoice['badge'];
  if (p.kind === 'local') badge = 'local';
  else if (p.kind === 'custom') badge = 'custom';
  else if (p.kind === 'pro' || p.kind === 'oauth') badge = 'oauth';
  else if (/free/i.test(p.label)) badge = 'free';
  else badge = 'api';
  return { id: p.id, title: p.shortLabel, description, badge };
}

const BADGE_LABEL: Record<RichChoice['badge'], string> = {
  free:   'Free',
  api:    'API key',
  oauth:  'OAuth',
  local:  'Local',
  custom: 'Custom',
};

function paintBadge(b: RichChoice['badge']): string {
  switch (b) {
    case 'free':   return c.success(BADGE_LABEL[b]);
    case 'api':    return c.accent(BADGE_LABEL[b]);
    case 'oauth':  return c.primary(BADGE_LABEL[b]);
    case 'local':  return c.muted(BADGE_LABEL[b]);
    case 'custom': return c.muted(BADGE_LABEL[b]);
  }
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Format one choice row for the picker. Layout:
 *
 *   <title pad to titleW>  <description pad to descW>  · <badge>
 *
 * inquirer's `select` highlights the entire row when hovered; the
 * title gets emphasised colour, description stays muted.
 */
function formatChoiceRow(rc: RichChoice, titleW: number, descW: number): string {
  const title = c.text(rpad(rc.title, titleW));
  const desc = c.muted(rpad(rc.description, descW));
  const badge = paintBadge(rc.badge);
  return `${title}  ${desc}  · ${badge}`;
}

export interface PickProviderOptions {
  /** All providers to offer. Order is preserved. */
  providers: ProviderOption[];
  /** Provider id to pre-select (cursor default). */
  defaultId?: string;
  /** Test injection of inquirer module. */
  inquirerImpl?: typeof import('@inquirer/prompts');
}

export interface PickProviderResult {
  /** Selected provider id. */
  id: string;
  /** Index inside the input `providers` array (0-based). */
  index: number;
  /** The rich choice computed for the selection. */
  choice: RichChoice;
}

/**
 * Show the rich picker and return the selected provider. The wizard's
 * outer loop converts thrown "force closed" errors into the skipped
 * explore-mode exit, so we re-raise unchanged on Ctrl+C / Esc.
 */
export async function pickProvider(
  opts: PickProviderOptions,
): Promise<PickProviderResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = opts.inquirerImpl ?? (require('@inquirer/prompts') as typeof import('@inquirer/prompts'));

  const rich = opts.providers.map(toRichChoice);
  const w = termWidth();
  const titleW = Math.min(22, Math.max(...rich.map((r) => r.title.length)) + 2);
  const descAvail = Math.max(20, w - titleW - 14);
  const descW = Math.min(40, descAvail);

  const choices = rich.map((rc, i) => ({
    name:  formatChoiceRow(rc, titleW, descW),
    value: String(i),
    description: c.muted(`Select ${rc.title} (${BADGE_LABEL[rc.badge].toLowerCase()})`),
  }));

  const defaultIdx = opts.defaultId
    ? Math.max(0, opts.providers.findIndex((p) => p.id === opts.defaultId))
    : 0;

  const answer = (await inq.select({
    message: c.text('Pick a provider:'),
    choices,
    default: String(defaultIdx),
    loop: false,
  })) as string;

  const idx = Number.parseInt(answer, 10);
  return {
    id: opts.providers[idx].id,
    index: idx,
    choice: rich[idx],
  };
}
