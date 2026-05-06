/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/modelPicker.ts — Phase 14b
 *
 * Interactive provider/model picker. Powers both `aiden model` (CLI
 * subcommand wired in 14c) and `/model` with no args. When `spec` is
 * supplied, the picker short-circuits to spec parsing via Phase 5's
 * ModelSwitcher.
 *
 * Hermes reference: hermes_cli/model_switch.py — switch_model() prompts
 * for provider then model and validates each pick against the catalog.
 */

import type { RuntimeResolver } from '../../../providers/v4/runtimeResolver';
import { ModelSwitcher } from '../../../providers/v4/modelSwitch';
import {
  PROVIDER_REGISTRY,
  type ProviderRegistryEntry,
} from '../../../providers/v4/registry';
import { listModelsForProvider } from '../../../providers/v4/modelCatalog';

export type ProviderTier = 'pro' | 'free' | 'paid' | 'local' | 'subscription';

export interface ModelPickerOptions {
  resolver: RuntimeResolver;
  /** Bypass the interactive prompts when set. */
  spec?: string;
  /** Restrict provider list to this tier. */
  tier?: ProviderTier;
  /** Injectable prompt module (for tests). */
  promptModule?: PickerPrompts;
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

/** Map registry entries to picker rows. */
function providerChoice(entry: ProviderRegistryEntry) {
  const badge = TIER_BADGE[entry.tier] ?? entry.tier;
  return {
    name: `${entry.displayName.padEnd(28)} ${badge}`,
    value: entry.id,
    description: entry.description,
  };
}

function modelChoice(modelId: string, providerId: string) {
  const m = listModelsForProvider(providerId).find((x) => x.id === modelId);
  if (!m) {
    return { name: modelId, value: modelId };
  }
  const ctx = m.contextLength ? ` ${(m.contextLength / 1000).toFixed(0)}K ctx` : '';
  let pricing = '';
  if (m.pricing) {
    pricing = ` $${m.pricing.inputPerM}/$${m.pricing.outputPerM} per M`;
  }
  return {
    name: `${m.displayName}${ctx}${pricing}`,
    value: m.id,
    description: m.notes,
  };
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
  const { resolver, spec, tier } = opts;

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

  const providerEntries = Object.values(PROVIDER_REGISTRY).filter(
    (e) => !tier || e.tier === tier,
  );
  if (providerEntries.length === 0) return null;

  let providerId: string;
  try {
    providerId = await prompts.select({
      message: 'Select provider',
      choices: providerEntries.map(providerChoice),
    });
  } catch {
    return null; // user cancelled (Ctrl+C / Escape)
  }

  const models = listModelsForProvider(providerId);
  if (models.length === 0) return null;

  let modelId: string;
  try {
    modelId = await prompts.select({
      message: `Select model for ${providerId}`,
      choices: models.map((m) => modelChoice(m.id, providerId)),
    });
  } catch {
    return null;
  }

  return { providerId, modelId };
}
