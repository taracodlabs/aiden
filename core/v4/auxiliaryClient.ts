/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
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
 * resolution chain (main provider → OpenRouter → portal subscription →
 * custom → Anthropic). Aiden v4.0.0 keeps a single resolved adapter for simplicity;
 * the multi-provider fallback chain comes back in v4.1.
 *
 * Failure mode: when the cheap model is unavailable, returns empty content
 * + zero usage instead of throwing. Callers (compressor, moat layers) all
 * handle empty content by skipping their optional behaviour — the agent
 * keeps running.
 */

import type { ProviderAdapter, Message } from '../../providers/v4/types';

export interface AuxiliaryResolver {
  /** Resolve once, lazily, when the first auxiliary operation is requested. */
  resolve(opts: {
    providerId: string;
    modelId: string;
  }): Promise<ProviderAdapter>;
}

/**
 * v4.8.0 Slice 11 — single provider+model attempt. The resolution
 * chain (default → fallbacks[]) is tried in order; the first
 * adapter that resolves wins. Used to route auxiliary cheap-LLM
 * calls through Groq when configured, falling back to the parent
 * loop's provider when Groq is absent. Fixes the ChatGPT Plus +
 * gpt-5 routing bug where parent inheritance forced auxiliary
 * traffic through an adapter that doesn't accept `gpt-5`.
 */
export interface AuxiliaryAttempt {
  providerId: string;
  modelId: string;
}

export interface AuxiliaryClientOptions {
  defaultProvider: string;
  defaultModel: string;
  /**
   * v4.8.0 Slice 11 — ordered list of secondary attempts. Tried only
   * if the default provider/model resolution throws. First successful
   * resolution wins and is cached for the lifetime of the client.
   */
  fallbacks?: AuxiliaryAttempt[];
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
  | 'skill_describe'
  // Phase v4.1.2 session-summary-followup: deterministic auto-summary
  // on /quit. Bypasses the main agent loop so the model can't decline
  // to call the tool — auxiliary generates the bullets, ChatSession
  // hands them straight to sessionSummaryTool.
  | 'session_summary';

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
  private activeAttemptIndex: number | null = null;
  private nextAttemptIndex = 0;
  private readonly usage = new Map<AuxiliaryPurpose, PurposeUsage>();
  private adapterUnavailable = false;

  constructor(opts: AuxiliaryClientOptions) {
    this.opts = opts;
  }

  private adapter(): Promise<ProviderAdapter | null> {
    this.adapterPromise ??= this.resolveOnce();
    return this.adapterPromise;
  }

  private async resolveOnce(): Promise<ProviderAdapter | null> {
    if (this.opts.adapter) {
      this.activeAttemptIndex = 0;
      return this.opts.adapter;
    }
    if (!this.opts.resolver) return null;

    // v4.8.0 Slice 11 — resolution chain: default first, then each
    // fallback in order. The first attempt that resolves wins. This
    // is the routing-fix entry point for the chatgpt-plus + gpt-5
    // bug: aidenCLI hands us Groq as the default and the parent
    // provider/model as the fallback, so auxiliary calls land on
    // Groq when configured and the parent only sees traffic when
    // Groq is absent.
    const attempts = this.attempts();
    const failures: string[] = [];
    for (let index = this.nextAttemptIndex; index < attempts.length; index += 1) {
      const att = attempts[index];
      this.resolveCallCount += 1;
      try {
        const adapter = await this.opts.resolver.resolve({
          providerId: att.providerId,
          modelId: att.modelId,
        });
        this.activeAttemptIndex = index;
        this.nextAttemptIndex = index;
        this.warn(`auxiliary resolved via ${att.providerId}/${att.modelId}`);
        return adapter;
      } catch (err) {
        failures.push(`${att.providerId}/${att.modelId}: ${(err as Error).message}`);
      }
    }
    this.warn(
      `auxiliary client unavailable (tried ${attempts.length}): ${failures.join('; ')}`,
    );
    this.adapterUnavailable = true;
    return null;
  }

  /** Resolve count for tests (verifies single-resolution behaviour). */
  _resolveCallCount(): number {
    return this.resolveCallCount;
  }

  async call(opts: AuxiliaryCallOptions): Promise<AuxiliaryCallResult> {
    const messages: Message[] = [
      {
        role: 'system',
        content: `You are an assistant performing a ${opts.purpose.replace('_', ' ')} task. Respond concisely.`,
      },
      { role: 'user', content: opts.prompt },
    ];

    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let adapter = await this.adapter();
    while (adapter) {
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
        if (!this.advanceAfterCallFailure()) break;
        adapter = await this.adapter();
      }
    }

    if (!adapter) {
      this.warn(
        `auxiliary client unavailable for ${opts.purpose}`,
      );
    }
    this.adapterUnavailable = true;
    this.recordUsage(opts.purpose, 0, 0);
    return { content: '', usage: { inputTokens: 0, outputTokens: 0 } };
  }

  /** Per-purpose usage breakdown. Used by /usage command (Phase 14). */
  getUsage(): Record<string, PurposeUsage> {
    const out: Record<string, PurposeUsage> = {};
    for (const [purpose, u] of this.usage.entries()) {
      out[purpose] = { ...u };
    }
    return out;
  }

  /** True after a requested lazy resolution failed. */
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

  private attempts(): AuxiliaryAttempt[] {
    return [
      { providerId: this.opts.defaultProvider, modelId: this.opts.defaultModel },
      ...(this.opts.fallbacks ?? []),
    ];
  }

  /** Adapter construction is not a liveness proof; advance only after a real call fails. */
  private advanceAfterCallFailure(): boolean {
    if (this.opts.adapter || !this.opts.resolver || this.activeAttemptIndex === null) return false;
    const next = this.activeAttemptIndex + 1;
    if (next >= this.attempts().length) return false;
    this.nextAttemptIndex = next;
    this.activeAttemptIndex = null;
    this.adapterPromise = null;
    return true;
  }

  private warn(msg: string) {
    // v4.8.0 Slice 5 — gate console output behind AIDEN_VERBOSE.
    // Auxiliary failures are recoverable (the main loop continues;
    // result content is just empty), so the warning is pure noise
    // for end users. Power users set AIDEN_VERBOSE=1 to surface them.
    // Inline env-read preserves the core → cli no-import invariant;
    // canonical isVerbose() lives at cli/v4/design/tokens.ts.
    //
    // v4.8.0 Slice 11 — if opts.warn is explicitly injected, always
    // forward (tests + advanced callers register their own sink and
    // expect every message). The AIDEN_VERBOSE gate now applies only
    // to the default console.warn fallback that end-users see.
    if (this.opts.warn) {
      this.opts.warn(msg);
      return;
    }
    if (process.env.AIDEN_VERBOSE !== '1') return;
    console.warn(`[auxiliary] ${msg}`);
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
