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
import type { FetchModelsResult } from '../../../core/v4/providers/modelFetch';
import { termWidth } from '../../../core/v4/ui/theme';

export type ProviderTier = 'pro' | 'free' | 'paid' | 'local' | 'subscription';
export type ProviderAccessState =
  | 'not_configured'
  | 'authentication_missing'
  | 'authentication_expired'
  | 'authentication_valid'
  | 'readiness_verified'
  | 'readiness_failed';

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
  isProviderAuthed?: (providerId: string) => boolean | ProviderAccessState | Promise<boolean | ProviderAccessState>;
  /** Live local-inventory seam. Production uses global fetch. */
  fetchImpl?: typeof fetch;
  ollamaBaseUrl?: string;
}

interface PickerChoice {
  name: string;
  value: string;
  description?: string;
  disabled?: boolean | string;
}

export interface PickerPrompts {
  select(opts: {
    message: string;
    choices: PickerChoice[];
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
const OLLAMA_UNAVAILABLE_VALUE = '__ollama_unavailable__';

/** Auth badge rendered into stage-1 provider rows. */
function authBadge(entry: ProviderRegistryEntry, access: boolean | ProviderAccessState): string {
  const state: ProviderAccessState = typeof access === 'boolean'
    ? access ? 'authentication_valid' : 'authentication_missing'
    : access;
  switch (state) {
    case 'readiness_verified': return '✓ ready';
    case 'readiness_failed': return '⚠ readiness failed';
    case 'authentication_expired': return '⚠ authentication expired';
    case 'authentication_valid': return entry.oauth ? '✓ auth valid (OAuth)' : '✓ auth valid';
    case 'not_configured': return '⚠ not configured';
    case 'authentication_missing':
      if (entry.tier === 'local') return '⚠ no daemon';
      return entry.oauth ? '⚠ authentication missing' : '⚠ no API key';
  }
}

/** Map a provider entry to a stage-1 picker row. */
function providerChoice(
  entry: ProviderRegistryEntry,
  modelCount: number,
  access: boolean | ProviderAccessState,
  isCurrent: boolean,
  width: number,
): { name: string; value: string; description?: string } {
  const badge = TIER_BADGE[entry.tier] ?? entry.tier;
  const ab = authBadge(entry, access);
  const count = `(${modelCount} model${modelCount === 1 ? '' : 's'})`;
  const current = isCurrent ? '  ← current' : '';
  const available = Math.max(12, width - 4);
  const wide = `${entry.displayName.padEnd(28)} ${count.padEnd(11)} ${ab.padEnd(24)} ${badge}${current}`;
  const compactStatus = `${ab}${current}`;
  const compactNameWidth = Math.max(8, available - compactStatus.length - 2);
  return {
    name: width >= 84
      ? truncate(wide, available)
      : `${truncate(entry.displayName, compactNameWidth).padEnd(compactNameWidth)}  ${compactStatus}`,
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
const PROVIDER_W = 14;
const TOOLS_W = 5;
const NAME_MIN = 16;
const NAME_MAX = 30;

interface PickerLayout {
  mode:  'full' | 'plain';
  nameW: number;
  providerW: number;
  statusW: number;
}

/** Decide columns + name width from terminal width. Robust at any size. */
function pickerLayout(width: number): PickerLayout {
  if (width < 76) {
    return { mode: 'plain', nameW: Math.max(10, width - 18), providerW: 0, statusW: 14 };
  }
  const providerW = PROVIDER_W;
  const fixed = 2 + providerW + CTX_W + TOOLS_W + 5;
  const nameW = Math.max(NAME_MIN, Math.min(NAME_MAX, width - fixed - 12));
  const statusW = Math.max(8, width - fixed - nameW);
  return { mode: 'full', nameW, providerW, statusW };
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
  const provider = 'Provider'.padEnd(layout.providerW);
  const ctx  = 'Context'.padEnd(CTX_W);
  const cols = `${name} ${provider} ${ctx} ${'Tools'.padEnd(TOOLS_W)} Status`;
  return `  ${cols}`;
}

function modelChoice(
  modelId: string,
  providerId: string,
  isCurrent: boolean,
  layout: PickerLayout,
  availability?: 'installed' | 'not_installed',
): PickerChoice {
  const m = listModelsForProvider(providerId).find((x) => x.id === modelId);
  if (!m) {
    const flags = [
      availability === 'installed' ? '✓ installed' : null,
      isCurrent ? '← current' : null,
    ].filter((flag): flag is string => flag !== null);
    return {
      name: flags.length > 0 ? `${modelId}  ${flags.join('  ')}` : modelId,
      value: modelId,
    };
  }

  // Strip "(deprecating <date>)" from the Name cell → trailing flag, so the
  // marker doesn't bloat the padded Name column.
  const depM = m.displayName.match(/^(.*?)\s*\(deprecating\s+([\d-]+)\)\s*$/);
  const baseName = depM ? depM[1] : m.displayName;

  const disabled = availability === 'not_installed'
    ? `Run ollama pull ${m.id} first`
    : undefined;

  const status = availability === 'not_installed'
    ? 'not installed'
    : isCurrent
      ? '← current'
      : availability === 'installed'
        ? '✓ installed'
        : depM
          ? `⚠ deprecating ${depM[2]}`
          : m.isDefault
            ? '⭐ recommended'
            : 'available';

  if (layout.mode === 'plain') {
    // Narrow-terminal fallback preserves the two highest-priority fields:
    // full usable model identity (within the physical row) and semantic status.
    const budget = Math.max(8, layout.nameW);
    return {
      name: `${truncate(baseName, budget).padEnd(budget)}  ${status}`,
      value: m.id,
      description: m.notes,
      disabled,
    };
  }

  const name = truncate(baseName, layout.nameW).padEnd(layout.nameW);
  const provider = truncate(providerId, layout.providerW).padEnd(layout.providerW);
  const ctx  = `${(m.contextLength / 1000).toFixed(0)}K`.padEnd(CTX_W);
  // Tools: plain ✓/✗ from supportsToolCalling. NOTE (v4.11): this is
  // provider-DECLARED, not live-verified — e.g. deepseek-v4-pro shows ✓
  // optimistically (tool-calling in its mandatory reasoning mode is
  // unconfirmed, key-blocked). An honest ✓-vs-✓* split needs a
  // ModelEntry.toolCallingVerified field — tracked as a follow-up chip.
  const tools = m.supportsToolCalling ? '✓' : '✗';

  const row = `${name} ${provider} ${ctx} ${tools.padEnd(TOOLS_W)} ${truncate(status, layout.statusW)}`;
  return { name: row, value: m.id, description: m.notes, disabled };
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
  // Injected prompts alone are the legacy unit-test seam and remain offline.
  // Production and tests that explicitly inject fetch use the live local
  // inventory so a curated catalog row is never mistaken for an installation.
  const useLiveOllamaInventory = opts.promptModule === undefined || opts.fetchImpl !== undefined;
  let ollamaInventory: FetchModelsResult | null = null;
  const loadOllamaInventory = async (): Promise<FetchModelsResult | null> => {
    if (!useLiveOllamaInventory) return null;
    if (ollamaInventory) return ollamaInventory;
    ollamaInventory = await resolver.getLocalModelInventory({
      baseUrl: opts.ollamaBaseUrl,
      fetchImpl: opts.fetchImpl,
      forceRefresh: true,
    });
    return ollamaInventory;
  };

  if (currentProviderId === 'ollama') await loadOllamaInventory();

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
      if (currentProviderId === 'ollama' && ollamaInventory?.source !== 'live') {
        hintParts.push(`Configured: ollama on ${currentModelId} (inventory unavailable)`);
      } else {
        const currentInstalled = currentProviderId !== 'ollama'
          || ollamaInventory === null
          || ollamaInventory.models.some((model) => model.id === currentModelId);
        hintParts.push(currentInstalled
          ? `Current: ${currentProviderId} on ${currentModelId}`
          : `Configured: ollama on ${currentModelId} (not installed)`);
      }
    }
    const stage1Message =
      hintParts.length > 0
        ? `⚙ Model Picker — Select Provider · ${hintParts.join(' · ')}`
        : '⚙ Model Picker — Select Provider';

    const providerChoices = await Promise.all(providerEntries.map(async (e) => {
      const localModels = e.id === 'ollama' && ollamaInventory
        ? ollamaInventory.models
        : null;
      const currentInstalled = e.id !== 'ollama'
        || localModels === null
        || ollamaInventory?.source !== 'live'
        || !currentModelId
        || localModels.some((model) => model.id === currentModelId);
      return providerChoice(
        e,
        localModels?.length ?? listModelsForProvider(e.id).length,
        await isAuthed(e.id),
        e.id === currentProviderId && currentInstalled,
        termWidth(),
      );
    }));
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

    const catalogModels = listModelsForProvider(providerId);
    const liveOllama = providerId === 'ollama' ? await loadOllamaInventory() : null;
    const inventoryAvailable = liveOllama?.source === 'live';
    const installedModels = inventoryAvailable ? liveOllama.models : [];
    const installedIds = inventoryAvailable
      ? new Set(installedModels.map((model) => model.id))
      : null;
    const models = liveOllama ? installedModels : catalogModels;
    const pullableModels = inventoryAvailable
      ? catalogModels.filter((model) => !installedIds?.has(model.id))
      : [];
    if (!liveOllama && models.length === 0) return null;

    // Stage 2 — model picker with breadcrumb.
    const providerEntry = PROVIDER_REGISTRY[providerId];
    const breadcrumb = providerEntry?.displayName ?? providerId;
    // v4.11 — compute the table layout ONCE so the header + all rows share
    // the same column widths; degrades by terminal width.
    const layout = pickerLayout(termWidth());
    const header = modelTableHeader(layout);
    const availabilitySummary = liveOllama
      ? inventoryAvailable
        ? `${models.length} installed · ${pullableModels.length} available to pull`
        : 'inventory unavailable · start Ollama and reopen /model'
      : `${models.length} available`;
    const stage2Message = header
      ? `⚙ Model Picker — ${breadcrumb} · Select a model (${availabilitySummary})\n${header}`
      : `⚙ Model Picker — ${breadcrumb} · Select a model (${availabilitySummary})`;

    const modelChoices = models.map((m) =>
      modelChoice(
        m.id,
        providerId,
        providerId === currentProviderId && m.id === currentModelId,
        layout,
        inventoryAvailable ? 'installed' : undefined,
      ),
    );
    for (const model of pullableModels) {
      modelChoices.push(modelChoice(
        model.id,
        providerId,
        false,
        layout,
        'not_installed',
      ));
    }
    if (liveOllama && !inventoryAvailable) {
      modelChoices.push({
        name: 'Ollama unavailable · start `ollama serve`, then reopen /model',
        value: OLLAMA_UNAVAILABLE_VALUE,
        disabled: 'Installed models cannot be verified while Ollama is offline',
      });
    }
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
    if (modelId === OLLAMA_UNAVAILABLE_VALUE) continue;
    if (installedIds && !installedIds.has(modelId)) continue;

    return { providerId, modelId };
  }
}
