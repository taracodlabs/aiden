/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/modelPicker.ts — Phase 22 Group B Task 3.
 *
 * Two-step interactive provider/model picker. Powers both `aiden model`
 * and `/model` with no args.
 *
 * Stage 1 (Provider): `⚙ Model Picker — Select Provider`
 *   • Each row shows `<name> (N models) <auth-badge> <tier-badge>`
 *   • Hint line above shows `Current: <provider> on <model>` when known
 *   • Unauthed providers stay selectable but render with ⚠ — selecting
 *     one logs a remediation hint via the caller (model.ts)
 *
 * Stage 2 (Model): `⚙ Model Picker — <provider>`
 *   • Lists the provider's models with `(K)K ctx` + pricing
 *   • Recommended model (ModelEntry.isDefault) marked with ⭐
 *   • `← Back` returns to stage 1 (loops); `Cancel` returns null
 *
 * `spec` short-circuits both stages via Phase 5's ModelSwitcher parser.
 */

import type { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import { ModelSwitcher } from '../../../providers/v4/modelSwitch';
import {
  PROVIDER_REGISTRY,
  type ProviderRegistryEntry,
} from '../../../providers/v4/registry';
import { listModelsForProvider } from '../../../providers/v4/modelCatalog';
import { termWidth } from '../../../core/v4/ui/theme';

export type ProviderTier = 'pro' | 'free' | 'paid' | 'local' | 'subscription';

export interface ModelPickerOptions {
  resolver: RuntimeResolver;
  /** Bypass the interactive prompts when set. */
  spec?: string;
  /** Restrict provider list to this tier. */
  tier?: ProviderTier;
  /** Injectable prompt module (for tests). */
  promptModule?: PickerPrompts;
  /**
   * Currently active provider/model — surfaced in the stage-1 hint
   * line and used to mark the active provider with `← current`.
   */
  currentProviderId?: string;
  currentModelId?: string;
  /**
   * Auth-state probe (Phase 22 Task 3). Called per provider id at
   * stage-1 render time. Returns true when credentials are present.
   * Caller wires this up using whatever signals are available
   * (env-var presence, OAuth token file, ollama probe). Defaults to
   * "everyone is authed" when omitted, which keeps existing tests
   * and the `aiden model` CLI path working without extra plumbing.
   */
  isProviderAuthed?: (providerId: string) => boolean;
}

export interface PickerPrompts {
  select(opts: {
    message: string;
    choices: { name: string; value: string; description?: string }[];
  }): Promise<string>;
}

const TIER_BADGE: Record<string, string> = {
  pro: '⭐ Pro',
  free: '🆓 Free',
  paid: '💲 Paid',
  local: '🏠 Local',
  subscription: '🔑 Subscription',
};

const BACK_VALUE = '__back__';
const CANCEL_VALUE = '__cancel__';

/** Auth badge rendered into stage-1 provider rows. */
function authBadge(entry: ProviderRegistryEntry, authed: boolean): string {
  if (authed) {
    // OAuth providers note that authed-state means a stored token, not
    // an env-var key — useful for users debugging "where did my creds
    // come from".
    return entry.oauth ? '✓ authed (OAuth)' : '✓ authed';
  }
  if (entry.tier === 'local') return '⚠ no daemon';
  if (entry.oauth) return '⚠ not signed in';
  return '⚠ no API key';
}

/** Map a provider entry to a stage-1 picker row. */
function providerChoice(
  entry: ProviderRegistryEntry,
  modelCount: number,
  authed: boolean,
  isCurrent: boolean,
): { name: string; value: string; description?: string } {
  const badge = TIER_BADGE[entry.tier] ?? entry.tier;
  const ab = authBadge(entry, authed);
  const count = `(${modelCount} model${modelCount === 1 ? '' : 's'})`;
  const current = isCurrent ? '  ← current' : '';
  return {
    name: `${entry.displayName.padEnd(28)} ${count.padEnd(11)} ${ab.padEnd(18)} ${badge}${current}`,
    value: entry.id,
    description: entry.description,
  };
}

// v4.11 — model-picker table layout. Stock @inquirer/prompts select renders
// each choice's `name` as one line, so the "table" is pad-aligned strings.
// The layout is computed ONCE per picker invocation from termWidth() and
// shared by the header + every row so columns line up; it degrades by
// dropping the price column on medium widths and falling back to a
// single-line concat on narrow terminals (never wraps into a mess).
const CTX_W = 8;     // "131K" / "Context"
const PRICE_W = 13;  // "$0.55/$2.19" / "In/Out $/M"
const NAME_MIN = 16;
const NAME_MAX = 30;

interface PickerLayout {
  mode:  'full' | 'noprice' | 'plain';
  nameW: number;
}

/** Decide columns + name width from terminal width. Robust at any size. */
function pickerLayout(width: number): PickerLayout {
  if (width < 52) return { mode: 'plain', nameW: NAME_MAX };
  const full = width >= 76;
  // Reserve: 2-space row indent + gaps + ctx + [price] + tools + slack.
  const reserve = full ? 32 : 18;
  const nameW = Math.max(NAME_MIN, Math.min(NAME_MAX, width - reserve));
  return { mode: full ? 'full' : 'noprice', nameW };
}

/** Hard-truncate to `n` cols with a trailing ellipsis. */
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/**
 * Aligned column header for the stage-2 select message. Uses the SAME
 * layout as the rows; 2-space indent aligns it under inquirer's `❯ `/`  `
 * row prefix. Null in `plain` mode (no table to head).
 */
function modelTableHeader(layout: PickerLayout): string | null {
  if (layout.mode === 'plain') return null;
  const name = 'Name'.padEnd(layout.nameW);
  const ctx  = 'Context'.padEnd(CTX_W);
  const cols = layout.mode === 'full'
    ? `${name} ${ctx} ${'In/Out $/M'.padEnd(PRICE_W)} Tools`
    : `${name} ${ctx} Tools`;
  return `  ${cols}`;
}

function modelChoice(
  modelId: string,
  providerId: string,
  isCurrent: boolean,
  layout: PickerLayout,
): { name: string; value: string; description?: string } {
  const m = listModelsForProvider(providerId).find((x) => x.id === modelId);
  if (!m) {
    return { name: modelId, value: modelId };
  }

  // Strip "(deprecating <date>)" from the Name cell → trailing flag, so the
  // marker doesn't bloat the padded Name column.
  const depM = m.displayName.match(/^(.*?)\s*\(deprecating\s+([\d-]+)\)\s*$/);
  const baseName = depM ? depM[1] : m.displayName;

  const flags: string[] = [];
  if (depM)         flags.push(`⚠ deprecating ${depM[2]}`);
  // Phase 22 Task 3: ModelEntry.isDefault is the catalog's "recommended" signal.
  if (m.isDefault)  flags.push('⭐');
  if (isCurrent)    flags.push('← current');
  const trail = flags.length ? `  ${flags.join('  ')}` : '';

  if (layout.mode === 'plain') {
    // Narrow-terminal fallback — single-line concat (legacy shape) so a
    // tight terminal never wraps a padded table into a mess.
    const ctx = ` ${(m.contextLength / 1000).toFixed(0)}K ctx`;
    const pricing = m.pricing ? ` $${m.pricing.inputPerM}/$${m.pricing.outputPerM} per M` : '';
    return { name: `${baseName}${ctx}${pricing}${trail}`, value: m.id, description: m.notes };
  }

  const name = truncate(baseName, layout.nameW).padEnd(layout.nameW);
  const ctx  = `${(m.contextLength / 1000).toFixed(0)}K`.padEnd(CTX_W);
  // Tools: plain ✓/✗ from supportsToolCalling. NOTE (v4.11): this is
  // provider-DECLARED, not live-verified — e.g. deepseek-v4-pro shows ✓
  // optimistically (tool-calling in its mandatory reasoning mode is
  // unconfirmed, key-blocked). An honest ✓-vs-✓* split needs a
  // ModelEntry.toolCallingVerified field — tracked as a follow-up chip.
  const tools = m.supportsToolCalling ? '✓' : '✗';

  const row = layout.mode === 'full'
    ? `${name} ${ctx} ${(m.pricing ? `$${m.pricing.inputPerM}/$${m.pricing.outputPerM}` : '—').padEnd(PRICE_W)} ${tools}`
    : `${name} ${ctx} ${tools}`;
  return { name: `${row}${trail}`, value: m.id, description: m.notes };
}

/** Resolve `@inquirer/prompts` lazily so unit tests can swap it out. */
async function defaultPrompts(): Promise<PickerPrompts> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async select(opts) {
      return inq.select(opts);
    },
  };
}

export async function runModelPicker(
  opts: ModelPickerOptions,
): Promise<{ providerId: string; modelId: string } | null> {
  const { resolver, spec, tier, currentProviderId, currentModelId } = opts;

  // Spec branch — use Phase 5's parser, no prompts.
  if (spec && spec.trim().length > 0) {
    try {
      const switcher = new ModelSwitcher(resolver);
      const parsed = switcher.parse(spec);
      if (!parsed.providerId) return null;
      return { providerId: parsed.providerId, modelId: parsed.modelId };
    } catch {
      return null;
    }
  }

  const prompts = opts.promptModule ?? (await defaultPrompts());
  const isAuthed = opts.isProviderAuthed ?? (() => true);

  const providerEntries = Object.values(PROVIDER_REGISTRY).filter(
    (e) => !tier || e.tier === tier,
  );
  if (providerEntries.length === 0) return null;

  // Two-step loop: ← Back from stage 2 returns to stage 1 cleanly.
  // Cancel from either stage returns null.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Stage 1 — provider picker.
    const hintParts: string[] = [];
    if (currentProviderId && currentModelId) {
      hintParts.push(`Current: ${currentProviderId} on ${currentModelId}`);
    }
    const stage1Message =
      hintParts.length > 0
        ? `⚙ Model Picker — Select Provider · ${hintParts.join(' · ')}`
        : '⚙ Model Picker — Select Provider';

    const providerChoices = providerEntries.map((e) =>
      providerChoice(
        e,
        listModelsForProvider(e.id).length,
        isAuthed(e.id),
        e.id === currentProviderId,
      ),
    );
    providerChoices.push({ name: 'Cancel', value: CANCEL_VALUE });

    let providerId: string;
    try {
      providerId = await prompts.select({
        message: stage1Message,
        choices: providerChoices,
      });
    } catch {
      return null; // user cancelled (Ctrl+C / Escape)
    }
    if (providerId === CANCEL_VALUE) return null;

    const models = listModelsForProvider(providerId);
    if (models.length === 0) return null;

    // Stage 2 — model picker with breadcrumb.
    const providerEntry = PROVIDER_REGISTRY[providerId];
    const breadcrumb = providerEntry?.displayName ?? providerId;
    // v4.11 — compute the table layout ONCE so the header + all rows share
    // the same column widths; degrades by terminal width.
    const layout = pickerLayout(termWidth());
    const header = modelTableHeader(layout);
    const stage2Message = header
      ? `⚙ Model Picker — ${breadcrumb} · Select a model (${models.length} available)\n${header}`
      : `⚙ Model Picker — ${breadcrumb} · Select a model (${models.length} available)`;

    const modelChoices = models.map((m) =>
      modelChoice(
        m.id,
        providerId,
        providerId === currentProviderId && m.id === currentModelId,
        layout,
      ),
    );
    modelChoices.push({ name: '← Back', value: BACK_VALUE });
    modelChoices.push({ name: 'Cancel', value: CANCEL_VALUE });

    let modelId: string;
    try {
      modelId = await prompts.select({
        message: stage2Message,
        choices: modelChoices,
      });
    } catch {
      return null;
    }
    if (modelId === CANCEL_VALUE) return null;
    if (modelId === BACK_VALUE) continue; // re-prompt stage 1

    return { providerId, modelId };
  }
}
