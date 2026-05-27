/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * core/v4/providerFallback.ts
 *
 * Cross-provider fallback chain for the inference path.
 *
 * Aiden treats one logical "provider" as an ordered list of slots, each of
 * which is an independently-keyed adapter (e.g. Together primary, Together
 * fallback, Groq #1..#4). When a slot rate-limits, the chain advances to
 * the next viable slot — without surfacing the 429 to the user. Errors
 * that aren't rate-limit-shaped are real bugs and rethrow immediately.
 *
 * Two layers live here:
 *
 *   - `runFallbackChain` — the pure walk: takes a slot list and a per-call
 *     function, returns the first non-429 result. Used by tests and any
 *     future code that wants its own request shape.
 *
 *   - `FallbackAdapter` — `ProviderAdapter` implementation that wraps a
 *     slot list. The runtime instantiates one of these and hands it to the
 *     agent loop. Adds per-slot cooldowns, request-count balancing, and a
 *     diagnostics snapshot the `/providers` slash command renders.
 *
 * Both layers pick slots with a least-used-first policy: every pick burns
 * TPM regardless of outcome, so choosing the slot with the lowest pick
 * count spreads bursty multi-tool turns across the available keys instead
 * of hammering slot 0 to its rate-limit window.
 */

import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
} from '../../providers/v4/types';

// ── Public types ────────────────────────────────────────────────────────

/**
 * One slot in the chain. `build()` returns `null` when the slot has no
 * credentials — the chain skips it but it stays in the list so
 * `/providers` can show it as "unset".
 *
 * `keyTail` is the last 4 chars of the configured key (or `null`); never
 * carries the full key. `envVar` records which environment variable the
 * key came from, when applicable.
 */
export interface ProviderSlot {
  id:          string;
  providerId:  string;
  modelId:     string;
  keyPresent:  boolean;
  keyTail:     string | null;
  envVar?:     string;
  build():     ProviderAdapter | null;
}

/** Per-slot bookkeeping the FallbackAdapter exposes to `/providers`. */
export interface SlotState {
  rateLimited:      boolean;
  lastRateLimitAt:  number | null;
  cooldownUntil:    number | null;
  successCount:     number;
  rateLimitCount:   number;
}

/** Result of a successful chain walk. */
export interface ChainRunResult<T> {
  slotId: string;
  value:  T;
}

/**
 * Optional bookkeeping that gives the chain memory across calls. Both
 * maps are read AND written by `runFallbackChain`. Callers that don't
 * need cooldown / least-used can omit this argument entirely.
 */
export interface ChainCooldownState {
  cooldownUntil:  Map<string, number>;
  cooldownMs:     number;
  now?:           () => number;
  requestCount?:  Map<string, number>;
}

/** Inputs to `buildDefaultSlots`. */
export interface DefaultSlotsOptions {
  groqModel?:              string;
  togetherModel?:          string;
  togetherFallbackModel?:  string;
  adapterFactory: (config: {
    baseUrl:       string;
    apiKey:        string;
    model:         string;
    providerName:  string;
  }) => ProviderAdapter;
  env?: Record<string, string | undefined>;
}

// ── Constants ───────────────────────────────────────────────────────────

/**
 * 60 seconds. Matches Groq's free-tier rolling-window TPM cap so a
 * cooled slot becomes pickable again mid-session — long enough that we
 * don't spin on the same slot, short enough that an interactive REPL
 * recovers without restart.
 */
export const DEFAULT_SLOT_COOLDOWN_MS = 60_000;

const COOLDOWN_ENV_VAR = 'AIDEN_SLOT_COOLDOWN_MS';

const TOGETHER_BASE_URL       = 'https://api.together.xyz/v1';
const GROQ_BASE_URL           = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL      = 'llama-3.3-70b-versatile';
const DEFAULT_TOGETHER_MODEL  = 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput';
const TOGETHER_FALLBACK_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

/** Substrings that flag rate-limit-shaped error messages. */
const RATE_LIMIT_PHRASES: readonly string[] = [
  '429',
  'rate limit',
  'rate-limit',
  'rate_limit',
  'too many requests',
  'quota exceeded',
];

// ── Errors ──────────────────────────────────────────────────────────────

/** Thrown when every slot the chain attempted came back rate-limited. */
export class ChainExhaustedError extends Error {
  readonly slotsTried: string[];
  readonly cause?:     Error;
  constructor(message: string, slotsTried: string[], cause?: Error) {
    super(message);
    this.name = 'ChainExhaustedError';
    this.slotsTried = slotsTried;
    this.cause = cause;
  }
}

// ── Detection helpers ───────────────────────────────────────────────────

/**
 * Loose 429 detector. Recognises (in order):
 *   1. explicit `rateLimit: true`
 *   2. `statusCode === 429`
 *   3. error name containing "ratelimit" (case-insensitive)
 *   4. message containing one of RATE_LIMIT_PHRASES
 *
 * Stays narrow on purpose — generic 4xx like Groq's `tool_use_failed` 400
 * are bugs the agent should see, not transient quota events to retry past.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    rateLimit?:  unknown;
    statusCode?: unknown;
    name?:       unknown;
    message?:    unknown;
  };
  if (e.rateLimit  === true) return true;
  if (e.statusCode === 429)  return true;
  if (typeof e.name === 'string' && e.name.toLowerCase().includes('ratelimit')) {
    return true;
  }
  if (typeof e.message !== 'string') return false;
  const lower = e.message.toLowerCase();
  for (const phrase of RATE_LIMIT_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

/**
 * Mask a credential for display. Empty/non-string → `null`. Short keys
 * (≤4 chars) → fixed-width "••••". Otherwise: 1–8 dots + last 4 chars.
 * Never returns the full key.
 */
export function maskKey(key: string | null | undefined): string | null {
  if (!key || typeof key !== 'string') return null;
  if (key.length <= 4) return '••••';
  const tail   = key.slice(-4);
  const dots   = Math.min(8, key.length - 4);
  return '•'.repeat(dots) + tail;
}

/**
 * Resolve the per-slot cooldown duration. Honours the
 * `AIDEN_SLOT_COOLDOWN_MS` env override when it parses cleanly to a
 * non-negative integer; otherwise returns the 60s default.
 */
export function resolveSlotCooldownMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[COOLDOWN_ENV_VAR];
  if (!raw) return DEFAULT_SLOT_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SLOT_COOLDOWN_MS;
  return parsed;
}

// ── Slot ordering ───────────────────────────────────────────────────────

/**
 * Compute the trial order for a chain walk:
 *
 *   1. Partition slots into "fresh" (cooldown elapsed) and "cooling".
 *   2. Sort fresh ascending by request count when bookkeeping is provided
 *      — least-used wins, stable on tie via Array.prototype.sort.
 *   3. Append cooling at the end so a fully-rate-limited chain still
 *      makes a second-pass attempt before giving up.
 *
 * When no cooldown bookkeeping is supplied, returns slots in their input
 * order.
 */
function prioritiseSlots(
  slots:    ProviderSlot[],
  cooldown: ChainCooldownState | undefined,
  now:      () => number,
): ProviderSlot[] {
  if (!cooldown) return [...slots];

  const fresh:   ProviderSlot[] = [];
  const cooling: ProviderSlot[] = [];
  for (const slot of slots) {
    const until = cooldown.cooldownUntil.get(slot.id) ?? 0;
    (until > now() ? cooling : fresh).push(slot);
  }

  const counts = cooldown.requestCount;
  if (counts && fresh.length > 1) {
    fresh.sort((a, b) =>
      (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0),
    );
  }

  return [...fresh, ...cooling];
}

/** Increment the request counter for a slot, when bookkeeping is wired. */
function bumpCount(cooldown: ChainCooldownState | undefined, slotId: string): void {
  if (!cooldown?.requestCount) return;
  cooldown.requestCount.set(slotId, (cooldown.requestCount.get(slotId) ?? 0) + 1);
}

/** Mark `slotId` as cooling for the configured duration. */
function markCooldown(
  cooldown: ChainCooldownState | undefined,
  slotId:   string,
  now:      () => number,
): void {
  if (!cooldown) return;
  cooldown.cooldownUntil.set(slotId, now() + cooldown.cooldownMs);
}

// ── Chain runner (non-streaming) ────────────────────────────────────────

/**
 * Walk `slots` in priority order, invoking `requestFn(adapter, slot)`
 * for each that has a usable adapter. The first non-rate-limit result
 * wins. Rate-limit failures advance; non-rate-limit failures rethrow.
 *
 * `observers.onRateLimit` fires once per 429-shaped failure, before the
 * chain advances. `cooldown`, when supplied, gates the slot's eligibility
 * on the next call too.
 *
 * Throws `ChainExhaustedError` when every viable slot rate-limits.
 */
export async function runFallbackChain<T>(
  slots:      ProviderSlot[],
  requestFn:  (adapter: ProviderAdapter, slot: ProviderSlot) => Promise<T>,
  observers:  { onRateLimit?: (slotId: string, err: Error) => void } = {},
  cooldown?:  ChainCooldownState,
  options?:   { signal?: AbortSignal },
): Promise<ChainRunResult<T>> {
  const now     = cooldown?.now ?? Date.now;
  const ordered = prioritiseSlots(slots, cooldown, now);

  const tried:   string[] = [];
  let   lastErr: Error | null = null;

  for (const slot of ordered) {
    // v4.11 Slice 3 — A6.4 amendment per the Phase A audit: pre-flight
    // signal check between slots so an abort that fires AFTER one
    // slot's adapter throws (e.g. timed-out request) and BEFORE the
    // next slot's adapter.call() starts does NOT spin into another
    // wasted slot attempt. The synthetic AbortError uses the same
    // `name: 'AbortError'` shape the v4 provider adapters surface on
    // external abort, so aidenAgent's catch at line 1164 routes it
    // identically (finishReason='interrupted', no fallback re-arm).
    if (options?.signal?.aborted) {
      const abortErr = new Error('Provider fallback chain aborted between slots');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const adapter = slot.build();
    if (!adapter) continue;

    // Bumped on every pick — TPM is consumed the moment the request
    // departs, regardless of whether the response is a success or 429.
    bumpCount(cooldown, slot.id);
    tried.push(slot.id);

    try {
      const value = await requestFn(adapter, slot);
      // A successful slot is no longer cooling — drop any deadline so
      // subsequent calls treat it as fresh again. (Tests assert this.)
      cooldown?.cooldownUntil.delete(slot.id);
      return { slotId: slot.id, value };
    } catch (raw) {
      const err = raw instanceof Error ? raw : new Error(String(raw));
      // v4.11 Slice 3 — AbortError from a per-slot adapter call short-
      // circuits the chain. We do NOT retry across slots after an
      // explicit cancel; the user wants the turn dead.
      if (err.name === 'AbortError') throw err;
      if (!isRateLimitError(err)) throw err;
      observers.onRateLimit?.(slot.id, err);
      markCooldown(cooldown, slot.id, now);
      lastErr = err;
    }
  }

  const summary = tried.length > 0 ? tried.join(', ') : 'none with credentials';
  throw new ChainExhaustedError(
    `Provider fallback chain exhausted (tried: ${summary})`,
    tried,
    lastErr ?? undefined,
  );
}

// ── Default slot builder ────────────────────────────────────────────────

/**
 * Build the default 6-slot chain Aiden ships with:
 *
 *   together → together-fallback → groq → groq2 → groq3 → groq4
 *
 * Together (with paid credit) is the practical primary; Groq slots stay
 * in the chain as legacy free-tier fallbacks. Slots without configured
 * keys are still emitted (their `build()` returns `null`) so
 * `/providers` can render the full configured surface.
 */
export function buildDefaultSlots(opts: DefaultSlotsOptions): ProviderSlot[] {
  const env             = opts.env ?? process.env;
  const groqModel       = opts.groqModel       ?? env.GROQ_TEST_MODEL     ?? DEFAULT_GROQ_MODEL;
  const togetherModel   = opts.togetherModel   ?? env.TOGETHER_TEST_MODEL ?? DEFAULT_TOGETHER_MODEL;
  const togetherFallbackModel = opts.togetherFallbackModel ?? TOGETHER_FALLBACK_MODEL;

  const togetherKey = env.TOGETHER_API_KEY;

  function makeTogetherSlot(id: string, model: string): ProviderSlot {
    return {
      id,
      providerId: 'together',
      modelId:    model,
      keyPresent: Boolean(togetherKey),
      keyTail:    togetherKey ? togetherKey.slice(-4) : null,
      envVar:     'TOGETHER_API_KEY',
      build: () =>
        togetherKey
          ? opts.adapterFactory({
              baseUrl:      TOGETHER_BASE_URL,
              apiKey:       togetherKey,
              model,
              providerName: 'together',
            })
          : null,
    };
  }

  function makeGroqSlot(id: string, envVar: string): ProviderSlot {
    const key = env[envVar];
    return {
      id,
      providerId: 'groq',
      modelId:    groqModel,
      keyPresent: Boolean(key),
      keyTail:    key ? key.slice(-4) : null,
      envVar,
      build: () =>
        key
          ? opts.adapterFactory({
              baseUrl:      GROQ_BASE_URL,
              apiKey:       key,
              model:        groqModel,
              providerName: 'groq',
            })
          : null,
    };
  }

  return [
    makeTogetherSlot('together',          togetherModel),
    makeTogetherSlot('together-fallback', togetherFallbackModel),
    makeGroqSlot('groq',  'GROQ_API_KEY'),
    makeGroqSlot('groq2', 'GROQ_API_KEY_2'),
    makeGroqSlot('groq3', 'GROQ_API_KEY_3'),
    makeGroqSlot('groq4', 'GROQ_API_KEY_4'),
  ];
}

// ── FallbackAdapter (ProviderAdapter implementation) ────────────────────

interface FallbackAdapterOptions {
  apiMode:        ProviderAdapter['apiMode'];
  slots:          ProviderSlot[];
  onRateLimit?:   (slotId: string, err: Error) => void;
  onFallback?:    (fromSlotId: string, toSlotId: string) => void;
  cooldownMs?:    number;
  now?:           () => number;
}

/**
 * Drop-in `ProviderAdapter` that fronts a list of slots.
 *
 *  - `call()`        → delegates to `runFallbackChain` for non-streaming.
 *  - `callStream()`  → mirrors the same priority order but yields events
 *                      directly. A 429 BEFORE any token has flowed
 *                      advances to the next slot; a 429 AFTER tokens
 *                      have flowed re-throws — partial duplication is
 *                      worse than a clean failure.
 *  - `getDiagnostics()` → snapshot for the `/providers` slash command.
 *
 * Every slot in the chain MUST share the same `apiMode` so the agent
 * loop's tool-call wiring stays consistent across slot transitions.
 */
export class FallbackAdapter implements ProviderAdapter {
  readonly apiMode: ProviderAdapter['apiMode'];

  private readonly slots:          ProviderSlot[];
  private readonly slotState:      Map<string, SlotState> = new Map();
  private readonly cooldownUntil:  Map<string, number>    = new Map();
  private readonly requestCount:   Map<string, number>    = new Map();
  private readonly cooldownMs:     number;
  private readonly clock:          () => number;
  private readonly onRateLimit?:   (slotId: string, err: Error) => void;
  private readonly onFallback?:    (fromSlotId: string, toSlotId: string) => void;
  private          activeSlotId:   string | null = null;

  constructor(opts: FallbackAdapterOptions) {
    this.apiMode      = opts.apiMode;
    this.slots        = opts.slots;
    this.cooldownMs   = opts.cooldownMs ?? resolveSlotCooldownMs();
    this.clock        = opts.now        ?? Date.now;
    this.onRateLimit  = opts.onRateLimit;
    this.onFallback   = opts.onFallback;

    for (const slot of opts.slots) {
      this.slotState.set(slot.id, {
        rateLimited:     false,
        lastRateLimitAt: null,
        cooldownUntil:   null,
        successCount:    0,
        rateLimitCount:  0,
      });
    }
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    let pendingFromId: string | null = null;

    const result = await runFallbackChain(
      this.slots,
      async (adapter, slot) => {
        if (pendingFromId !== null && pendingFromId !== slot.id) {
          this.onFallback?.(pendingFromId, slot.id);
        }
        pendingFromId = slot.id;
        return adapter.call(input);
      },
      {
        onRateLimit: (slotId, err) => this.recordRateLimit(slotId, err),
      },
      this.cooldownState(),
      // v4.11 Slice 3 — thread the external signal into the chain
      // walker so the between-slot pre-flight check (A6.4 amendment)
      // sees it without us having to refactor the requestFn shape.
      { signal: input.signal },
    );

    this.recordSuccess(result.slotId);
    return result.value;
  }

  async *callStream(
    input: ProviderCallInput,
  ): AsyncGenerator<StreamEvent, void, void> {
    const cooldown = this.cooldownState();
    const ordered  = prioritiseSlots(this.slots, cooldown, this.clock);

    const tried:   string[] = [];
    let   lastErr: Error | null = null;
    let   prevSlotId: string | null = null;

    for (const slot of ordered) {
      // v4.11 Slice 3 — A6.4 amendment: between-slot pre-flight signal
      // check, mirrored from runFallbackChain above. Mid-stream aborts
      // are already covered by each adapter's internal AbortController
      // wiring (lines 213/584 in ollama, 281 in chat completions, etc.)
      // — this guard closes the BETWEEN-slot race where one slot's
      // throw + the next slot's startup can sandwich a Ctrl+C.
      if (input.signal?.aborted) {
        const abortErr = new Error('Provider fallback chain (stream) aborted between slots');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const adapter = slot.build();
      if (!adapter) continue;

      bumpCount(cooldown, slot.id);
      tried.push(slot.id);

      if (prevSlotId !== null && prevSlotId !== slot.id) {
        this.onFallback?.(prevSlotId, slot.id);
      }
      prevSlotId = slot.id;

      let yielded = false;
      try {
        if (typeof adapter.callStream === 'function') {
          for await (const evt of adapter.callStream(input)) {
            yielded = true;
            yield evt;
          }
        } else {
          // Adapter doesn't speak SSE — fall back to a single-shot call
          // and synthesise a terminal `done` event so consumers see the
          // same event shape regardless of which slot won.
          const out = await adapter.call(input);
          yielded = true;
          yield { type: 'done', output: out };
        }
        // Clear any prior cooldown deadline on this slot — see runFallbackChain.
        cooldown.cooldownUntil.delete(slot.id);
        this.recordSuccess(slot.id);
        return;
      } catch (raw) {
        const err = raw instanceof Error ? raw : new Error(String(raw));
        // v4.11 Slice 3 — AbortError from a per-slot stream short-
        // circuits. Even mid-stream: we want the cancel to surface
        // immediately, not to re-arm fallback against the next slot.
        if (err.name === 'AbortError') throw err;
        if (!isRateLimitError(err)) throw err;
        this.recordRateLimit(slot.id, err);
        markCooldown(cooldown, slot.id, this.clock);
        if (yielded) {
          // A genuine mid-stream rate-limit. We've already shipped tokens
          // to the consumer; replaying them on the next slot would be
          // worse UX than a clear failure.
          throw err;
        }
        lastErr = err;
      }
    }

    const summary = tried.length > 0 ? tried.join(', ') : 'none with credentials';
    throw new ChainExhaustedError(
      `Provider fallback chain exhausted (tried: ${summary})`,
      tried,
      lastErr ?? undefined,
    );
  }

  /** Build the cooldown bookkeeping handed to `runFallbackChain`. */
  private cooldownState(): ChainCooldownState {
    return {
      cooldownUntil: this.cooldownUntil,
      cooldownMs:    this.cooldownMs,
      now:           this.clock,
      requestCount:  this.requestCount,
    };
  }

  private recordRateLimit(slotId: string, err: Error): void {
    const state = this.slotState.get(slotId);
    if (state) {
      state.rateLimited     = true;
      state.lastRateLimitAt = this.clock();
      state.cooldownUntil   = this.clock() + this.cooldownMs;
      state.rateLimitCount += 1;
    }
    this.onRateLimit?.(slotId, err);
  }

  private recordSuccess(slotId: string): void {
    const state = this.slotState.get(slotId);
    if (state) {
      state.rateLimited   = false;
      state.cooldownUntil = null;
      state.successCount += 1;
    }
    this.activeSlotId = slotId;
  }

  /**
   * Phase v4.1-subagent — clone the adapter with FRESH mutable state
   * but SHARED slot configs. Subagent fanout uses this so each
   * subagent gets its own rate-limit bookkeeping (slotState,
   * cooldownUntil, requestCount, activeSlotId all reset) without
   * paying for slot-config rebuilds. The slot list and the cooldownMs
   * / clock / observer callbacks are read-only and safely shared
   * across clones.
   *
   * One subagent hitting a 429 marks ITS clone's slot as cooled-down;
   * the parent and sibling clones still see the slot as available.
   * That's a deliberate tradeoff: tighter contention on the same
   * provider key, but isolation prevents one slow subagent from
   * starving siblings via parent-side cooldown state.
   */
  clone(opts?: { providerId?: string }): FallbackAdapter {
    // v4.6 Phase 2P — optional `providerId` filter restricts the clone
    // to slots matching the named provider. Used by `spawn_sub_agent`'s
    // per-spawn provider override: fanout (and future callers) pass a
    // specific provider name so the child's FallbackAdapter rotates
    // only within that provider's slots, preserving the diversity
    // invariant fanout depends on. When omitted, full-slot clone is
    // the Phase 1 behaviour (unchanged).
    //
    // Caller is responsible for validating `providerId` against
    // `getProviderIds()` before calling — an unknown providerId
    // here yields a degenerate clone (zero slots), which the
    // FallbackAdapter's own dispatch path treats as "no providers"
    // and would error on first call. Defending here would mask the
    // upstream validation gap; we prefer fail-loud at the validation
    // layer instead.
    const slots = opts?.providerId
      ? this.slots.filter((s) => s.providerId === opts.providerId)
      : this.slots;
    return new FallbackAdapter({
      apiMode:     this.apiMode,
      slots,
      cooldownMs:  this.cooldownMs,
      now:         this.clock,
      onRateLimit: this.onRateLimit,
      onFallback:  this.onFallback,
    });
  }

  /**
   * v4.6 Phase 2P — return the set of provider IDs the adapter knows
   * about (deduplicated, key-present slots only). Used by
   * `spawn_sub_agent`'s per-spawn provider override validation: the
   * spec's `provider` field must name one of these. Sorted for
   * stable diagnostic output in error messages.
   */
  getProviderIds(): string[] {
    const seen = new Set<string>();
    for (const slot of this.slots) {
      if (slot.keyPresent) seen.add(slot.providerId);
    }
    return [...seen].sort();
  }

  /**
   * Diagnostic snapshot for `/providers`. Per-slot cooldown is reported
   * in seconds remaining (0 when the slot is fresh) so the slash command
   * can render a human countdown without doing wall-clock math itself.
   */
  getDiagnostics(): {
    slots: Array<{
      id:                    string;
      providerId:            string;
      modelId:               string;
      keyPresent:            boolean;
      keyTail:               string | null;
      envVar?:               string;
      state:                 SlotState;
      cooldownRemainingSec:  number;
      active:                boolean;
    }>;
    activeSlotId:  string | null;
    cooldownSec:   number;
  } {
    const now = this.clock();
    return {
      slots: this.slots.map((slot) => {
        const state = this.slotState.get(slot.id)!;
        const until = this.cooldownUntil.get(slot.id) ?? state.cooldownUntil ?? 0;
        const remainingSec = until > now ? Math.ceil((until - now) / 1000) : 0;
        return {
          id:                   slot.id,
          providerId:           slot.providerId,
          modelId:              slot.modelId,
          keyPresent:           slot.keyPresent,
          keyTail:              slot.keyTail,
          envVar:               slot.envVar,
          state:                { ...state, cooldownUntil: until > now ? until : null },
          cooldownRemainingSec: remainingSec,
          active:               slot.id === this.activeSlotId,
        };
      }),
      activeSlotId: this.activeSlotId,
      cooldownSec:  Math.round(this.cooldownMs / 1000),
    };
  }
}
