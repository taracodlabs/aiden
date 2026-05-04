/**
 * core/v4/modelMetadata.ts — Aiden v4.0.0 (Phase 13)
 *
 * Single source of truth for model context lengths and token estimation.
 * Backed by `providers/v4/modelCatalog.ts` for the per-model context length;
 * adds compression-threshold + reserved-output policy on top.
 *
 * Hermes reference: agent/model_metadata.py — get_model_context_length(),
 * estimate_messages_tokens_rough(). We trim the live models.dev / OpenRouter
 * hydration (Hermes uses both) to keep v4.0.0 offline-first; the catalog
 * is the source of truth.
 *
 * Token estimation strategy:
 *   1. Try `js-tiktoken` (small, no native bindings). All major OpenAI
 *      tokenizers are bundled. We use cl100k_base for everything — close
 *      enough for budgeting purposes across families (Anthropic and Llama
 *      tokenize differently but the magnitude is right).
 *   2. If the SDK fails to load (offline install, missing dep), fall back
 *      to `Math.ceil(text.length / 4)` — the standard char-per-token rule.
 *
 * Per-message overhead: every message in OpenAI / Anthropic wire format
 * carries ~10 tokens of JSON / role envelope, which we add per message.
 * Tool schemas tokenise their JSON.
 */

import { findModel, MODEL_CATALOG } from '../../providers/v4/modelCatalog';
import type { Message, ToolSchema } from '../../providers/v4/types';

export interface ModelLimits {
  /** Total context window in tokens. */
  contextLength: number;
  /** Hard cap on output tokens per turn. */
  maxOutputTokens: number;
  /** Fraction (0..1) at which compression should fire. */
  compressionThreshold: number;
  /** Tokens to keep free for the model's reply. */
  reservedForOutput: number;
}

const DEFAULT_CONTEXT_LENGTH = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;
const DEFAULT_COMPRESSION_THRESHOLD = 0.5;
const PER_MESSAGE_OVERHEAD_TOKENS = 10;

// Lazy tiktoken loader. If install ever fails, getEncoder returns null and
// every estimator drops to char/4. Cached for the lifetime of the process.
type Encoder = { encode: (text: string) => number[] } | null;
let _encoder: Encoder | undefined;

function getEncoder(): Encoder {
  if (_encoder !== undefined) return _encoder;
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const mod = require('js-tiktoken');
    // cl100k_base covers GPT-4 / GPT-4o family; close-enough for budgeting.
    if (typeof mod.encodingForModel === 'function') {
      _encoder = mod.encodingForModel('gpt-4');
    } else if (typeof mod.getEncoding === 'function') {
      _encoder = mod.getEncoding('cl100k_base');
    } else {
      _encoder = null;
    }
  } catch {
    _encoder = null;
  }
  return _encoder;
}

/** True when js-tiktoken loaded successfully. Exposed for tests + diagnostics. */
export function tokenizerAvailable(): boolean {
  return getEncoder() !== null;
}

export class ModelMetadata {
  /**
   * Look up limits for a specific (provider, model) pair. Falls back to
   * conservative defaults when the model is unknown — better to under-use
   * the context than to overflow it.
   */
  getLimits(providerId: string, modelId: string): ModelLimits {
    const entry = findModel(providerId, modelId);
    if (!entry) {
      return this.getDefaults();
    }
    const reservedForOutput = entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT;
    return {
      contextLength: entry.contextLength,
      maxOutputTokens: entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      compressionThreshold: DEFAULT_COMPRESSION_THRESHOLD,
      reservedForOutput,
    };
  }

  /** Estimate token count for a single text blob. Deterministic. */
  estimateTokens(text: string): number {
    if (!text) return 0;
    const enc = getEncoder();
    if (enc) {
      try {
        return enc.encode(text).length;
      } catch {
        // Fall through to char/4 if tokenizer chokes on weird input.
      }
    }
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate the wire-token cost of an entire message array. Adds a flat
   * envelope per message to approximate role + JSON overhead. Tool calls
   * in assistant messages and tool-result content are both counted.
   */
  estimateMessageTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      total += PER_MESSAGE_OVERHEAD_TOKENS;
      if (typeof m.content === 'string' && m.content) {
        total += this.estimateTokens(m.content);
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // Each tool call adds its name + arguments JSON to the wire.
        for (const call of m.toolCalls) {
          total += this.estimateTokens(call.name);
          total += this.estimateTokens(JSON.stringify(call.arguments ?? {}));
        }
      }
    }
    return total;
  }

  /** Estimate tokens spent broadcasting tool schemas to the provider. */
  estimateToolTokens(tools: ToolSchema[]): number {
    let total = 0;
    for (const t of tools) {
      total += this.estimateTokens(t.name);
      total += this.estimateTokens(t.description ?? '');
      total += this.estimateTokens(JSON.stringify(t.inputSchema ?? {}));
    }
    return total;
  }

  /** Conservative defaults for unknown models. */
  getDefaults(): ModelLimits {
    return {
      contextLength: DEFAULT_CONTEXT_LENGTH,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
      compressionThreshold: DEFAULT_COMPRESSION_THRESHOLD,
      reservedForOutput: DEFAULT_MAX_OUTPUT,
    };
  }
}

/** Convenience: ensure every catalog model has valid limits. Used by tests. */
export function _allCatalogIds(): Array<{ providerId: string; modelId: string }> {
  return MODEL_CATALOG.map((m) => ({ providerId: m.providerId, modelId: m.id }));
}
