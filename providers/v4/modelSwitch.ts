/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/modelSwitch.ts — Aiden v4.0.0
 *
 * Shared `/model` pipeline used by the CLI (Phase 13) and the future
 * gateway (v4.1). Parses a spec like `'anthropic:claude-opus-4-7'` (or
 * a bare model id like `'llama-3.3-70b-versatile'`), resolves it through
 * `RuntimeResolver`, and returns the new adapter alongside metadata.
 *
 * Status: PHASE 5.
 *
 * Hermes reference: hermes_cli/model_switch.py — switch_model().
 *
 * Divergence from Hermes: Aiden v4 supports a `provider:model` colon
 * syntax that Hermes deliberately rejected (Hermes uses `--provider`
 * and reserves the colon for OpenRouter variant tags). We can do this
 * because OpenRouter variant tags (`:free`, `:fast`) live entirely
 * inside the modelId — `openrouter:meta-llama/llama-3.3-70b-instruct:free`
 * still parses unambiguously since we split on the FIRST colon.
 */

import { ProviderAdapter } from './types';
import { ProviderError } from './errors';
import { PROVIDER_REGISTRY, ProviderRegistryEntry } from './registry';
import {
  ModelEntry,
  findModel,
  findProvidersForModelId,
} from './modelCatalog';
import { RuntimeResolver } from './runtimeResolver';

export interface ModelSwitchRequest {
  /**
   * Either `'provider:model'` (e.g. `'anthropic:claude-opus-4-7'`) or
   * a bare `'model'` that the resolver will look up across the catalog.
   */
  spec: string;
  /** Current adapter state — used to detect no-op switches. */
  currentProviderId?: string;
  currentModelId?: string;
}

export interface ModelSwitchResult {
  newProvider: ProviderRegistryEntry;
  newModel: ModelEntry;
  newAdapter: ProviderAdapter;
  /** False when (newProvider.id, newModel.id) matches the current state. */
  changed: boolean;
}

export interface ParsedSpec {
  providerId: string | null;
  modelId: string;
}

export class ModelSwitcher {
  constructor(private readonly resolver: RuntimeResolver) {}

  /**
   * Parse a spec into (providerId, modelId). Splits on the FIRST colon so
   * OpenRouter variant tags (`provider:vendor/model:variant`) round-trip.
   * Throws on empty / whitespace-only specs.
   */
  parse(spec: string): ParsedSpec {
    const trimmed = (spec ?? '').trim();
    if (trimmed.length === 0) {
      throw new ProviderError(
        'Model spec is empty. Use "provider:model" or just "model".',
        'unknown',
      );
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const candidateProvider = trimmed.slice(0, colonIdx).trim();
      const candidateModel = trimmed.slice(colonIdx + 1).trim();
      // Treat the prefix as a provider id only when it actually IS one —
      // otherwise the colon is part of the model id (e.g. `qwen2.5:7b`
      // for ollama, `gemma2:2b`, OpenRouter `:free` variants when the
      // user typed the full bare model).
      if (
        candidateProvider.length > 0 &&
        candidateModel.length > 0 &&
        Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, candidateProvider)
      ) {
        return { providerId: candidateProvider, modelId: candidateModel };
      }
    }

    // Bare model: resolve via catalog walk.
    const matches = findProvidersForModelId(trimmed);
    if (matches.length === 0) {
      throw new ProviderError(
        `Model '${trimmed}' not found. Try "provider:model" form, e.g. "anthropic:claude-opus-4-7".`,
        'unknown',
      );
    }
    if (matches.length > 1) {
      const options = matches.map((m) => `${m.providerId}:${m.id}`).join(', ');
      throw new ProviderError(
        `Model '${trimmed}' is ambiguous — served by multiple providers. ` +
          `Did you mean one of: ${options}?`,
        'unknown',
      );
    }
    return { providerId: matches[0].providerId, modelId: matches[0].id };
  }

  /**
   * Parse, resolve, and instantiate the new adapter.
   * `changed` reflects whether the (provider, model) pair actually moved.
   */
  async switch(req: ModelSwitchRequest): Promise<ModelSwitchResult> {
    const parsed = this.parse(req.spec);
    if (parsed.providerId === null) {
      // parse() always fills in providerId for valid specs (or throws).
      // This branch is unreachable but documents the invariant.
      throw new ProviderError(
        `Could not resolve a provider for model '${parsed.modelId}'.`,
        'unknown',
      );
    }

    const newAdapter = await this.resolver.resolve({
      providerId: parsed.providerId,
      modelId: parsed.modelId,
    });

    // Resolution succeeded — pull the entries for the result. These are
    // guaranteed present since resolve() already validated them.
    const newProvider = PROVIDER_REGISTRY[parsed.providerId];
    const newModel = findModel(parsed.providerId, parsed.modelId)!;

    const changed =
      req.currentProviderId !== parsed.providerId ||
      req.currentModelId !== parsed.modelId;

    return { newProvider, newModel, newAdapter, changed };
  }
}
