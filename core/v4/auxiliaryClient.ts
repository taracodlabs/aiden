/**
 * core/v4/auxiliaryClient.ts — Aiden v4.0.0 (Phase 13)
 *
 * Routes cheap "side-task" LLM calls to a separate small model so the
 * main turn budget stays focused on the user's intent. Used by:
 *   - ContextCompressor   (purpose: 'compression')
 *   - PlannerGuard        (purpose: 'plan_classify')
 *   - HonestyEnforcement  (purpose: 'honesty_classify')
 *   - SkillTeacher        (purpose: 'skill_describe')
 *   - smart approval      (purpose: 'risk_assess', wired in Phase 14)
 *
 * Hermes reference: agent/auxiliary_client.py — call_llm() with auto
 * resolution chain (main provider → OpenRouter → Nous Portal → custom →
 * Anthropic). Aiden v4.0.0 keeps a single resolved adapter for simplicity;
 * the multi-provider fallback chain comes back in v4.1.
 *
 * Failure mode: when the cheap model is unavailable, returns empty content
 * + zero usage instead of throwing. Callers (compressor, moat layers) all
 * handle empty content by skipping their optional behaviour — the agent
 * keeps running.
 */

import type { ProviderAdapter, Message } from '../../providers/v4/types';

export interface AuxiliaryResolver {
  /** Resolve once at AuxiliaryClient construction. */
  resolve(opts: {
    providerId: string;
    modelId: string;
  }): Promise<ProviderAdapter>;
}

export interface AuxiliaryClientOptions {
  defaultProvider: string;
  defaultModel: string;
  resolver?: AuxiliaryResolver;
  /**
   * Pre-resolved adapter — if provided, the resolver is not called.
   * Useful for tests + when the caller wants full control over routing.
   */
  adapter?: ProviderAdapter;
  /**
   * Logger sink for warnings. Defaults to console.warn. Tests inject a noop.
   */
  warn?: (msg: string) => void;
}

export type AuxiliaryPurpose =
  | 'compression'
  | 'risk_assess'
  | 'plan_classify'
  | 'honesty_classify'
  | 'skill_describe';

export interface AuxiliaryCallOptions {
  purpose: AuxiliaryPurpose;
  prompt: string;
  /** Default 200. */
  maxTokens?: number;
  /** Default 30000ms. */
  timeoutMs?: number;
}

export interface AuxiliaryCallResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface PurposeUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

const DEFAULT_MAX_TOKENS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

export class AuxiliaryClient {
  private readonly opts: AuxiliaryClientOptions;
  private adapterPromise: Promise<ProviderAdapter | null> | null = null;
  private resolveCallCount = 0;
  private readonly usage = new Map<AuxiliaryPurpose, PurposeUsage>();
  private adapterUnavailable = false;

  constructor(opts: AuxiliaryClientOptions) {
    this.opts = opts;
    // Resolve eagerly (single call) so concurrent first-call requests don't
    // each kick off their own resolution.
    this.adapterPromise = this.resolveOnce();
  }

  private async resolveOnce(): Promise<ProviderAdapter | null> {
    if (this.opts.adapter) return this.opts.adapter;
    if (!this.opts.resolver) return null;
    this.resolveCallCount += 1;
    try {
      const adapter = await this.opts.resolver.resolve({
        providerId: this.opts.defaultProvider,
        modelId: this.opts.defaultModel,
      });
      return adapter;
    } catch (err) {
      this.warn(
        `auxiliary client unavailable (${this.opts.defaultProvider}/${this.opts.defaultModel}): ${(err as Error).message}`,
      );
      this.adapterUnavailable = true;
      return null;
    }
  }

  /** Resolve count for tests (verifies single-resolution behaviour). */
  _resolveCallCount(): number {
    return this.resolveCallCount;
  }

  async call(opts: AuxiliaryCallOptions): Promise<AuxiliaryCallResult> {
    const adapter = await this.adapterPromise;
    if (!adapter) {
      this.recordUsage(opts.purpose, 0, 0);
      return { content: '', usage: { inputTokens: 0, outputTokens: 0 } };
    }

    const messages: Message[] = [
      {
        role: 'system',
        content: `You are an assistant performing a ${opts.purpose.replace('_', ' ')} task. Respond concisely.`,
      },
      { role: 'user', content: opts.prompt },
    ];

    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const result = await this.withTimeout(
        adapter.call({
          messages,
          tools: [],
          maxTokens,
        }),
        timeoutMs,
      );
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      this.recordUsage(opts.purpose, inputTokens, outputTokens);
      return {
        content: result.content ?? '',
        usage: { inputTokens, outputTokens },
      };
    } catch (err) {
      this.warn(
        `auxiliary call failed (${opts.purpose}): ${(err as Error).message}`,
      );
      this.recordUsage(opts.purpose, 0, 0);
      return { content: '', usage: { inputTokens: 0, outputTokens: 0 } };
    }
  }

  /** Per-purpose usage breakdown. Used by /usage command (Phase 14). */
  getUsage(): Record<string, PurposeUsage> {
    const out: Record<string, PurposeUsage> = {};
    for (const [purpose, u] of this.usage.entries()) {
      out[purpose] = { ...u };
    }
    return out;
  }

  /** True after construction-time resolution failed. */
  isUnavailable(): boolean {
    return this.adapterUnavailable;
  }

  private recordUsage(purpose: AuxiliaryPurpose, input: number, output: number) {
    const cur = this.usage.get(purpose) ?? {
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
    };
    cur.inputTokens += input;
    cur.outputTokens += output;
    cur.calls += 1;
    this.usage.set(purpose, cur);
  }

  private warn(msg: string) {
    (this.opts.warn ?? ((m: string) => console.warn(`[auxiliary] ${m}`)))(msg);
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}
