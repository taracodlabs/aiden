/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * Portions adapted from NousResearch/hermes-agent (MIT).
 * Original copyright (c) NousResearch.
 */
/**
 * core/v4/providerFallback.ts — Aiden v4.0.0 (Phase 16b.1)
 *
 * Shared provider fallback chain. Used by both:
 *   - the runtime path (AidenAgent provider call site, via aidenCLI boot)
 *   - the test helper (tests/v4/_helpers/testProvider.ts)
 *
 * Pattern: ordered list of provider "slots". When a slot's call throws a
 * rate-limit-shaped error, advance to the next slot. Non-rate-limit errors
 * propagate immediately — those are real bugs, not transient quota.
 *
 * Why a separate module: 16b's smoke gate revealed Groq was rate-limiting
 * the FIRST "hi" of every session. Test infra had a multi-tier fallback
 * (Groq → Groq2 → Groq3 → Groq4 → Together) that made tests robust; the
 * runtime path surfaced the raw "Provider groq rate limited" to the user.
 * This module lets the runtime borrow the same chain.
 *
 * Design note: this module is provider-agnostic. Slots carry an opaque
 * `id` for diagnostics (`/providers` reads it) plus a synchronous adapter
 * builder. The chain runner accepts a `requestFn(adapter)` and a list of
 * slots; both consumers wire the same primitives differently.
 */

import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
} from '../../providers/v4/types';

/**
 * One slot in the fallback chain. `id` is a short stable key for
 * diagnostics ('groq', 'groq2', 'groq3', 'together'). `build()` returns
 * a ready-to-call adapter when the slot is reachable, or null when the
 * slot's credentials aren't configured (the chain skips it).
 *
 * `keyPresent` and `keyTail` feed `/providers` rendering. `keyTail` is
 * the masked tail (last 4 chars) — never the whole key.
 */
export interface ProviderSlot {
  id: string;
  /** Null when no key is configured for this slot. */
  build(): ProviderAdapter | null;
  /** True when an API key (or OAuth) is configured. */
  keyPresent: boolean;
  /** Last 4 chars of the key, or null when keyPresent is false. */
  keyTail: string | null;
  /** Provider id understood by the resolver/registry (e.g. 'groq'). */
  providerId: string;
  /** Model id valid for `providerId`. */
  modelId: string;
  /**
   * Phase 16c.2: env var name this slot reads from (e.g. `GROQ_API_KEY_2`).
   * Populated by `buildDefaultSlots`; left undefined for synthetic slots
   * (the runtime's `primary`). `/providers` uses this to render which env
   * file the key came from when the user has multiple sources of truth.
   */
  envVar?: string;
}

/**
 * Loose 429 / rate-limit detector. Matches:
 *   - `ProviderRateLimitError` instances (constructor name check)
 *   - error messages containing '429', 'rate limit', 'rate-limit',
 *     'rate_limit', 'too many requests', 'quota'
 *   - explicit `(err as any).rateLimit === true`
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; name?: string; rateLimit?: unknown; statusCode?: unknown };
  if (e.rateLimit === true) return true;
  if (e.statusCode === 429) return true;
  if (typeof e.name === 'string' && e.name.toLowerCase().includes('ratelimit')) {
    return true;
  }
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota exceeded')
  );
}

/**
 * Mask an API key for display. Returns `null` for empty/falsy input.
 * Keeps the last 4 chars and replaces the rest with `•` (one mid-dot per
 * masked char, capped at 8 to keep the line short).
 */
export function maskKey(key: string | null | undefined): string | null {
  if (!key || typeof key !== 'string') return null;
  if (key.length <= 4) return '••••';
  const tail = key.slice(-4);
  const masked = '•'.repeat(Math.min(8, key.length - 4));
  return `${masked}${tail}`;
}

export interface ChainRunResult<T> {
  /** Successful slot id, when one returned. */
  slotId: string;
  value: T;
}

/**
 * Phase 16b.3: default per-slot cooldown after a 429.
 *
 * Hermes uses 60 minutes (`agent/credential_pool.py::EXHAUSTED_TTL_429_SECONDS`)
 * because its fleet runs cron + multi-day tasks against the provider's full
 * reset window. Aiden's REPL is interactive and Groq's free-tier TPM cap
 * recovers in well under a minute, so a 60-minute freeze would lock a slot
 * out for the rest of an interactive session pointlessly.
 *
 * 60 seconds matches Groq's rolling-window token cap and lets the chain
 * recover the primary slot mid-session. See
 * `docs/sprint/hermes-soul-cooldown-audit.md` for the divergence rationale.
 */
export const DEFAULT_SLOT_COOLDOWN_MS = 60_000;

/**
 * Read the slot cooldown duration. Wrapped in a function so tests can stub
 * the env var; consumers that don't care about the env override (i.e. all
 * production paths) just get the default.
 */
export function resolveSlotCooldownMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AIDEN_SLOT_COOLDOWN_MS;
  if (!raw) return DEFAULT_SLOT_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SLOT_COOLDOWN_MS;
  return parsed;
}

/**
 * Optional per-slot cooldown bookkeeping passed into `runFallbackChain`.
 * The caller owns the map; the chain reads `cooldownUntil[slotId]` to
 * decide whether to skip a slot, and writes a fresh cooldown when the
 * slot 429s. Skipping is purely advisory — the chain will still try the
 * slot if it's the only one with a key.
 */
export interface ChainCooldownState {
  /** Wall-clock ms timestamp at/after which the slot becomes pickable again. */
  cooldownUntil: Map<string, number>;
  /** Cooldown duration applied when a 429 fires. Default 60s. */
  cooldownMs: number;
  /** Optional clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Phase 16e: per-slot request counter for least-used selection. When
   * provided, `runFallbackChain` sorts fresh (non-cooling) slots ascending
   * by count before picking, spreading multi-call turns across slots so a
   * burst doesn't hammer slot 0 to TPM-cap.
   *
   * The chain increments on every pick (success OR rate-limit) — TPM is
   * burned the moment the request goes out, not just on success. Cooldown
   * still kicks in on 429 as before.
   *
   * Mirrors Hermes `STRATEGY_LEAST_USED` (`agent/credential_pool.py:906`)
   * but using an in-process Map instead of persisted pool state.
   */
  requestCount?: Map<string, number>;
}

/**
 * Run `requestFn` against each slot in order until one succeeds. Skips
 * slots whose `build()` returns null (no key). On rate-limit errors,
 * advances to the next slot. On any other error, rethrows immediately.
 *
 * When `cooldown` is provided, slots in cooldown are skipped on the first
 * pass — only after every other slot fails do we retry a cooling slot,
 * matching the spec's "drops slot-1 load 80%+" guidance without ever
 * making the chain harder to recover from.
 *
 * Throws a `ChainExhaustedError` after the last configured slot fails
 * with a rate-limit error.
 */
export async function runFallbackChain<T>(
  slots: ProviderSlot[],
  requestFn: (adapter: ProviderAdapter, slot: ProviderSlot) => Promise<T>,
  observers: { onRateLimit?: (slotId: string, err: Error) => void } = {},
  cooldown?: ChainCooldownState,
): Promise<ChainRunResult<T>> {
  const now = cooldown?.now ?? Date.now;

  // Two passes: first only slots whose cooldown has expired, then any
  // remaining cooling slots as a last resort. Same pattern as Hermes'
  // _select_unlocked → _available_entries(clear_expired=True) plus the
  // implicit "fall back to whatever you have" on degraded fleets.
  const fresh: ProviderSlot[] = [];
  const cooling: ProviderSlot[] = [];
  for (const slot of slots) {
    if (cooldown) {
      const until = cooldown.cooldownUntil.get(slot.id) ?? 0;
      if (until > now()) {
        cooling.push(slot);
        continue;
      }
    }
    fresh.push(slot);
  }

  // Phase 16e: when a request counter is provided, sort fresh slots by
  // ascending request count (least-used first). Spreads burst-tool turns
  // across slots so call 1 hits slot 0, call 2 hits slot 1, etc. — instead
  // of all calls hammering slot 0 to its TPM cap. Stable sort preserves
  // the configured slot order as the tiebreaker.
  if (cooldown?.requestCount && fresh.length > 1) {
    const counts = cooldown.requestCount;
    const decorated = fresh.map((s, idx) => ({
      slot: s,
      count: counts.get(s.id) ?? 0,
      idx,
    }));
    decorated.sort((a, b) =>
      a.count !== b.count ? a.count - b.count : a.idx - b.idx,
    );
    fresh.length = 0;
    for (const d of decorated) fresh.push(d.slot);
  }

  let lastErr: Error | null = null;
  let attemptedAny = false;

  const tryOne = async (slot: ProviderSlot): Promise<ChainRunResult<T> | null> => {
    const adapter = slot.build();
    if (!adapter) return null;
    attemptedAny = true;
    // Phase 16e: bump the request counter the moment we commit to a slot —
    // TPM/RPM burns whether the call succeeds or 429s, so least-used must
    // count attempts, not just successes.
    if (cooldown?.requestCount) {
      cooldown.requestCount.set(
        slot.id,
        (cooldown.requestCount.get(slot.id) ?? 0) + 1,
      );
    }
    try {
      const value = await requestFn(adapter, slot);
      // Successful call clears any lingering cooldown for the slot.
      cooldown?.cooldownUntil.delete(slot.id);
      return { slotId: slot.id, value };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (isRateLimitError(e)) {
        observers.onRateLimit?.(slot.id, e);
        if (cooldown) {
          cooldown.cooldownUntil.set(
            slot.id,
            now() + cooldown.cooldownMs,
          );
        }
        lastErr = e;
        return null;
      }
      throw e;
    }
  };

  for (const slot of fresh) {
    const r = await tryOne(slot);
    if (r) return r;
  }
  for (const slot of cooling) {
    const r = await tryOne(slot);
    if (r) return r;
  }

  if (!attemptedAny) {
    throw new ChainExhaustedError(
      'No provider slots configured (no API keys found). Set GROQ_API_KEY or TOGETHER_API_KEY.',
      [],
    );
  }
  throw new ChainExhaustedError(
    `All provider slots rate-limited. Last error: ${lastErr?.message ?? 'unknown'}`,
    slots.map((s) => s.id),
    lastErr ?? undefined,
  );
}

/** Thrown by `runFallbackChain` when every configured slot rate-limits. */
export class ChainExhaustedError extends Error {
  readonly slotsTried: string[];
  readonly cause?: Error;
  constructor(message: string, slotsTried: string[], cause?: Error) {
    super(message);
    this.name = 'ChainExhaustedError';
    this.slotsTried = slotsTried;
    this.cause = cause;
  }
}

// ─── Default slot builders for Groq → Groq2 → Groq3 → Together ──────

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
// Phase 16f: Qwen3-235B replaces Llama-3.3-Turbo as the Together primary.
// Strong tool calling, MoE 22B active, throughput tier ~$0.20/M.
const DEFAULT_TOGETHER_MODEL = 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput';
const TOGETHER_FALLBACK_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

export interface DefaultSlotsOptions {
  /** Optional override for Groq model id. */
  groqModel?: string;
  /** Optional override for Together primary model id (default: Qwen3-235B). */
  togetherModel?: string;
  /**
   * Phase 16f: optional override for the secondary Together slot's model.
   * Defaults to Llama-3.3-70B-Instruct-Turbo so the Together $10 credit
   * has a flagship fallback when Qwen3 is rate-limited.
   */
  togetherFallbackModel?: string;
  /**
   * Adapter factory. Tests inject a stub; the runtime passes a closure that
   * builds a ChatCompletionsAdapter. Keeping this injectable means this
   * file has zero hard dependency on a specific adapter class.
   */
  adapterFactory: (config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    providerName: string;
  }) => ProviderAdapter;
  /** Read env vars from this object (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * Build the default 5-tier slot list:
 *   GROQ_API_KEY → GROQ_API_KEY_2 → GROQ_API_KEY_3 → GROQ_API_KEY_4
 *     → TOGETHER_API_KEY
 *
 * Slots without a configured key are still included (so `/providers` can
 * render them as "unset"); their `build()` returns null and the chain
 * runner skips them.
 */
export function buildDefaultSlots(opts: DefaultSlotsOptions): ProviderSlot[] {
  const env = opts.env ?? process.env;
  const groqModel = opts.groqModel ?? env.GROQ_TEST_MODEL ?? DEFAULT_GROQ_MODEL;
  const togetherModel = opts.togetherModel ?? env.TOGETHER_TEST_MODEL ?? DEFAULT_TOGETHER_MODEL;

  const buildGroqSlot = (id: string, envVar: string): ProviderSlot => {
    const key = env[envVar];
    return {
      id,
      providerId: 'groq',
      modelId: groqModel,
      keyPresent: !!key,
      keyTail: key ? key.slice(-4) : null,
      envVar,
      build: () =>
        key
          ? opts.adapterFactory({
              baseUrl: GROQ_BASE_URL,
              apiKey: key,
              model: groqModel,
              providerName: 'groq',
            })
          : null,
    };
  };

  const togetherKey = env.TOGETHER_API_KEY;
  const buildTogetherSlot = (id: string, model: string): ProviderSlot => ({
    id,
    providerId: 'together',
    modelId: model,
    keyPresent: !!togetherKey,
    keyTail: togetherKey ? togetherKey.slice(-4) : null,
    envVar: 'TOGETHER_API_KEY',
    build: () =>
      togetherKey
        ? opts.adapterFactory({
            baseUrl: TOGETHER_BASE_URL,
            apiKey: togetherKey,
            model,
            providerName: 'together',
          })
        : null,
  });

  // Phase 16f: Together + Qwen3 is the new default primary; Groq slots stay
  // in the chain as legacy fallbacks (activate only when the env vars are
  // set). User cleared the Groq slots in 16f after they kept hammering all
  // 4 within 2 turns of normal use; least-used spreading helped but Groq's
  // free-tier TPM cap is too tight for browser-tool-heavy turns. Together
  // ($10 paid credit, throughput tier) is the practical primary.
  const togetherFallbackModel =
    opts.togetherFallbackModel ?? TOGETHER_FALLBACK_MODEL;
  return [
    buildTogetherSlot('together', togetherModel),
    buildTogetherSlot('together-fallback', togetherFallbackModel),
    buildGroqSlot('groq', 'GROQ_API_KEY'),
    buildGroqSlot('groq2', 'GROQ_API_KEY_2'),
    buildGroqSlot('groq3', 'GROQ_API_KEY_3'),
    buildGroqSlot('groq4', 'GROQ_API_KEY_4'),
  ];
}

// ─── Runtime adapter wrapper ──────────────────────────────────────────

/**
 * Tracks per-slot rate-limit state so `/providers` can render which slots
 * are currently active vs. cooling off. Cooldown is enforced at pick time
 * (Phase 16b.3) — slots in cooldown are skipped on the first pass.
 */
export interface SlotState {
  rateLimited: boolean;
  /** Wall-clock ms when the slot last rate-limited. */
  lastRateLimitAt: number | null;
  /**
   * Phase 16b.3: wall-clock ms at/after which this slot is pickable again.
   * Null when the slot is not in cooldown. Display this minus `Date.now()`
   * in `/providers` as a remaining countdown.
   */
  cooldownUntil: number | null;
  /** Total successful calls observed for this slot. */
  successCount: number;
  /** Total rate-limit events observed for this slot. */
  rateLimitCount: number;
}

/**
 * `ProviderAdapter` implementation that fronts a list of slots and falls
 * through on rate-limit errors. The first slot's `apiMode` is used as the
 * declared mode — every slot in the chain MUST share the same `apiMode`
 * for the agent loop's tool-call wiring to stay consistent.
 *
 * Currently used at the runtime path in `cli/v4/aidenCLI.ts::buildAgentRuntime`
 * to harden the AidenAgent against transient Groq quota.
 */
export class FallbackAdapter implements ProviderAdapter {
  readonly apiMode: ProviderAdapter['apiMode'];
  private readonly slots: ProviderSlot[];
  private readonly state: Map<string, SlotState> = new Map();
  /** Phase 16b.3: cooldown deadlines shared with `runFallbackChain`. */
  private readonly cooldownUntil: Map<string, number> = new Map();
  /**
   * Phase 16e: per-slot request counter for least-used selection. Spreads
   * burst-tool-turns across slots so 4 calls in 5s don't all hit slot 0.
   */
  private readonly requestCount: Map<string, number> = new Map();
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;
  private lastSuccessfulSlot: string | null = null;
  private readonly onRateLimit?: (slotId: string, err: Error) => void;
  private readonly onFallback?: (
    fromSlotId: string,
    toSlotId: string,
  ) => void;

  constructor(opts: {
    /** First slot's apiMode. Must match every other slot. */
    apiMode: ProviderAdapter['apiMode'];
    slots: ProviderSlot[];
    onRateLimit?: (slotId: string, err: Error) => void;
    onFallback?: (fromSlotId: string, toSlotId: string) => void;
    /** Phase 16b.3: override cooldown duration for tests. */
    cooldownMs?: number;
    /** Phase 16b.3: clock injection for deterministic tests. */
    now?: () => number;
  }) {
    this.apiMode = opts.apiMode;
    this.slots = opts.slots;
    this.onRateLimit = opts.onRateLimit;
    this.onFallback = opts.onFallback;
    this.cooldownMs = opts.cooldownMs ?? resolveSlotCooldownMs();
    this.nowFn = opts.now ?? Date.now;
    for (const s of opts.slots) {
      this.state.set(s.id, {
        rateLimited: false,
        lastRateLimitAt: null,
        cooldownUntil: null,
        successCount: 0,
        rateLimitCount: 0,
      });
    }
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    let lastSlotTried: string | null = null;
    const result = await runFallbackChain(
      this.slots,
      async (adapter, slot) => {
        if (lastSlotTried && lastSlotTried !== slot.id) {
          this.onFallback?.(lastSlotTried, slot.id);
        }
        lastSlotTried = slot.id;
        return adapter.call(input);
      },
      {
        onRateLimit: (slotId, err) => {
          const s = this.state.get(slotId);
          if (s) {
            s.rateLimited = true;
            s.lastRateLimitAt = this.nowFn();
            s.cooldownUntil = this.nowFn() + this.cooldownMs;
            s.rateLimitCount += 1;
          }
          this.onRateLimit?.(slotId, err);
        },
      },
      {
        cooldownUntil: this.cooldownUntil,
        cooldownMs: this.cooldownMs,
        now: this.nowFn,
        requestCount: this.requestCount,
      },
    );
    const s = this.state.get(result.slotId);
    if (s) {
      s.rateLimited = false;
      s.cooldownUntil = null;
      s.successCount += 1;
    }
    this.lastSuccessfulSlot = result.slotId;
    return result.value;
  }

  /**
   * Phase 16c: streaming variant. Mirrors `call()` slot iteration but
   * relays `StreamEvent`s as the active slot streams. Strategy:
   *
   *   - For each slot in fresh-then-cooling order, build the adapter
   *     and verify it implements `callStream`. If not, fall through to
   *     non-streaming `.call()` on that slot, wrap the result in a
   *     synthetic `done` event, and yield it.
   *   - Begin streaming. If the FIRST awaited iteration throws a
   *     rate-limit error, treat it like a 429 on the non-streaming path:
   *     mark the slot, advance to the next slot. No tokens were yielded,
   *     so no client-visible state is corrupted.
   *   - If a rate-limit error fires AFTER tokens have already been
   *     yielded (genuinely mid-stream 429), we re-throw — partial
   *     duplication is worse UX than a clear failure, per Phase 16c
   *     audit decision. In practice this is vanishingly rare; Groq's
   *     proxy closes the SSE without an explicit 429 frame.
   *   - Non-rate-limit errors propagate immediately whether tokens
   *     were yielded or not.
   *
   * The agent loop only consumes streaming events; it never calls both
   * `.call` and `.callStream` for the same turn.
   */
  async *callStream(
    input: ProviderCallInput,
  ): AsyncGenerator<StreamEvent, void, void> {
    const now = this.nowFn;

    const fresh: ProviderSlot[] = [];
    const cooling: ProviderSlot[] = [];
    for (const slot of this.slots) {
      const until = this.cooldownUntil.get(slot.id) ?? 0;
      if (until > now()) {
        cooling.push(slot);
      } else {
        fresh.push(slot);
      }
    }
    // Phase 16e: same least-used sort as the non-streaming path.
    if (fresh.length > 1) {
      const counts = this.requestCount;
      fresh
        .map((s, idx) => ({ slot: s, count: counts.get(s.id) ?? 0, idx }))
        .sort((a, b) =>
          a.count !== b.count ? a.count - b.count : a.idx - b.idx,
        )
        .forEach((d, i) => (fresh[i] = d.slot));
    }
    const ordered = [...fresh, ...cooling];

    let attemptedAny = false;
    let lastErr: Error | null = null;
    let lastSlotTried: string | null = null;

    for (const slot of ordered) {
      const adapter = slot.build();
      if (!adapter) continue;
      attemptedAny = true;
      if (lastSlotTried && lastSlotTried !== slot.id) {
        this.onFallback?.(lastSlotTried, slot.id);
      }
      lastSlotTried = slot.id;
      // Phase 16e: bump count on every committed pick (success or 429).
      this.requestCount.set(
        slot.id,
        (this.requestCount.get(slot.id) ?? 0) + 1,
      );

      // Per spec stop condition: if the slot adapter doesn't implement
      // streaming, fall back to non-streaming on this slot. Wrap the
      // result in a synthetic stream so the caller sees a consistent
      // event flow.
      if (typeof adapter.callStream !== 'function') {
        try {
          const out = await adapter.call(input);
          this.cooldownUntil.delete(slot.id);
          const s = this.state.get(slot.id);
          if (s) {
            s.rateLimited = false;
            s.cooldownUntil = null;
            s.successCount += 1;
          }
          this.lastSuccessfulSlot = slot.id;
          yield { type: 'done', output: out };
          return;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          if (isRateLimitError(e)) {
            this.markRateLimited(slot.id, e);
            lastErr = e;
            continue;
          }
          throw e;
        }
      }

      // Streaming path. We iterate the generator manually so we can
      // distinguish "rate-limited before any event" from "rate-limited
      // after some deltas".
      let yieldedAny = false;
      let stream: AsyncGenerator<StreamEvent, void, void>;
      try {
        stream = adapter.callStream(input) as AsyncGenerator<
          StreamEvent,
          void,
          void
        >;
      } catch (err) {
        // Synchronous throw before iteration begins — e.g. validation.
        const e = err instanceof Error ? err : new Error(String(err));
        if (isRateLimitError(e)) {
          this.markRateLimited(slot.id, e);
          lastErr = e;
          continue;
        }
        throw e;
      }

      try {
        while (true) {
          let next: IteratorResult<StreamEvent, void>;
          try {
            next = await stream.next();
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            if (isRateLimitError(e) && !yieldedAny) {
              this.markRateLimited(slot.id, e);
              lastErr = e;
              break;
            }
            throw e;
          }
          if (next.done) {
            // Successful stream completion.
            this.cooldownUntil.delete(slot.id);
            const s = this.state.get(slot.id);
            if (s) {
              s.rateLimited = false;
              s.cooldownUntil = null;
              s.successCount += 1;
            }
            this.lastSuccessfulSlot = slot.id;
            return;
          }
          yieldedAny = true;
          // `next.done === false` narrows `next.value` to StreamEvent.
          yield next.value as StreamEvent;
        }
      } finally {
        // Defensive: ensure the generator is closed if the caller bailed.
        try {
          await stream.return?.();
        } catch {
          // ignore
        }
      }
      // Fell through after a 429-before-any-event — try next slot.
    }

    if (!attemptedAny) {
      throw new ChainExhaustedError(
        'No provider slots configured (no API keys found). Set GROQ_API_KEY or TOGETHER_API_KEY.',
        [],
      );
    }
    throw new ChainExhaustedError(
      `All provider slots rate-limited (streaming). Last error: ${lastErr?.message ?? 'unknown'}`,
      this.slots.map((s) => s.id),
      lastErr ?? undefined,
    );
  }

  private markRateLimited(slotId: string, err: Error): void {
    const s = this.state.get(slotId);
    if (s) {
      s.rateLimited = true;
      s.lastRateLimitAt = this.nowFn();
      s.cooldownUntil = this.nowFn() + this.cooldownMs;
      s.rateLimitCount += 1;
    }
    this.cooldownUntil.set(slotId, this.nowFn() + this.cooldownMs);
    this.onRateLimit?.(slotId, err);
  }

  /** Diagnostic snapshot for `/providers`. */
  getDiagnostics(): {
    slots: Array<{
      id: string;
      providerId: string;
      modelId: string;
      keyPresent: boolean;
      keyTail: string | null;
      /** Phase 16c.2: env var this slot reads from (for `/providers`). */
      envVar?: string;
      state: SlotState;
      /** Remaining cooldown in seconds (0 when not cooling). Phase 16b.3. */
      cooldownRemainingSec: number;
      active: boolean;
    }>;
    activeSlotId: string | null;
    /** Phase 16b.3: configured cooldown duration in seconds. */
    cooldownSec: number;
  } {
    const now = this.nowFn();
    return {
      slots: this.slots.map((s) => {
        const st = this.state.get(s.id)!;
        // Re-sync state.cooldownUntil from the shared map — tests can
        // mutate cooldownUntil through the chain, and we want /providers
        // to reflect the same source of truth.
        const until = this.cooldownUntil.get(s.id) ?? st.cooldownUntil ?? 0;
        const remainingSec =
          until > now ? Math.ceil((until - now) / 1000) : 0;
        return {
          id: s.id,
          providerId: s.providerId,
          modelId: s.modelId,
          keyPresent: s.keyPresent,
          keyTail: s.keyTail,
          envVar: s.envVar,
          state: { ...st, cooldownUntil: until > now ? until : null },
          cooldownRemainingSec: remainingSec,
          active: s.id === this.lastSuccessfulSlot,
        };
      }),
      activeSlotId: this.lastSuccessfulSlot,
      cooldownSec: Math.round(this.cooldownMs / 1000),
    };
  }
}
