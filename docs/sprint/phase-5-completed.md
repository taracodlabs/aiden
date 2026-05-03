# Phase 5 — Completed

**Date:** 2026-05-03
**Branch:** `v4-rewrite`
**Commits:**
- `7393474` — feat(v4): provider registry + model catalog (19 providers)
- `75d316a` — feat(v4): runtime resolver + model switch pipeline
- `d2815ae` — test(v4): registry, model catalog, runtime resolver, model switch
- (this file) — docs(v4): phase 5 summary

## Goal

Wire the catalog of all supported providers and models. After Phase 5,
`new RuntimeResolver(credResolver).resolve({providerId, modelId})`
returns a fully-instantiated `ProviderAdapter` ready to call. This is
the surface the Phase 13 model-picker UI calls into.

## Hermes pattern summary (Task 1)

- **Provider catalog.** Hermes splits the registry between `hermes_cli/auth.py::PROVIDER_REGISTRY` (auth metadata: env vars, base URLs, auth_type) and `hermes_cli/models.py::_PROVIDER_MODELS` (curated model id lists). Aiden v4 collapses to one flat `Record<string, ProviderRegistryEntry>` keyed by id, with model metadata in a separate `MODEL_CATALOG: ModelEntry[]` joined by `providerId` — TypeScript object literals beat Python dataclasses + giant switches when the dispatch fan-out is small and stable.
- **Runtime resolution.** Hermes's `resolve_runtime_provider()` is a 1300-line per-provider switch that handles credential pools, OAuth refresh, URL-based api_mode auto-detection, AWS-SDK chains, Azure key bypass, OpenCode model-family inference. Aiden v4 collapses to one `resolve()` that switches on `apiMode` (4 branches) and consolidates the precedence chain in one `resolveCredentials()` helper. Per-provider quirks (URL stripping, OpenCode mode inference, Azure bypass) are deferred to Phase 8 / 13.
- **Precedence chain.** Hermes order: explicit args → config.yaml model.* → env vars → credential pool / auth store → hardcoded defaults. Aiden v4 mirrors this with a `ConfigProvider` stub — config.yaml lives in Phase 6+, so for now the config slot always returns undefined. `source` label is propagated for `aiden doctor` later.
- **/model parsing.** Hermes deliberately rejects `provider:model` colon syntax (reserves the colon for OpenRouter `:free`/`:fast` variant tags) and uses `--provider <name>` flag instead. Aiden v4 diverges intentionally: the FIRST colon splits prefix from rest, so `openrouter:meta-llama/llama-3.3:free` and ollama `qwen2.5:7b` round-trip cleanly. Bare-model lookup walks the catalog and throws "did you mean X:Y?" on ambiguity — exactly the kind of error message Hermes punts to a flag.

## Public APIs

```ts
// providers/v4/registry.ts (342 lines)
export const PROVIDER_REGISTRY: Record<string, ProviderRegistryEntry>;
export function getProviderEntry(id: string): ProviderRegistryEntry | undefined;
export function listProviderIds(): string[];

// providers/v4/modelCatalog.ts (719 lines)
export const MODEL_CATALOG: ModelEntry[];
export function listModelsForProvider(providerId: string): ModelEntry[];
export function findModel(providerId: string, modelId: string): ModelEntry | undefined;
export function findProvidersForModelId(modelId: string): ModelEntry[];

// providers/v4/runtimeResolver.ts (278 lines)
new RuntimeResolver(credentialResolver);
  resolve(options): Promise<ProviderAdapter>;
  describe(options): Promise<RuntimeResolution>;
  listProviders(): ProviderRegistryEntry[];
  listModels(providerId: string): ModelEntry[];

// providers/v4/modelSwitch.ts (139 lines)
new ModelSwitcher(resolver);
  parse(spec: string): { providerId: string | null; modelId: string };
  switch(req: ModelSwitchRequest): Promise<ModelSwitchResult>;
```

## Provider + model counts

- **Providers registered: 19** — claude_subscription, chatgpt_subscription, nous_portal, anthropic, openai, groq, gemini, nvidia, huggingface, openrouter, together, deepseek, mistral, zai, kimi, minimax, vercel_gateway, custom_openai, ollama.
- **Models registered: 47** across the catalog. Per-provider counts: anthropic 4, claude_subscription 4, chatgpt_subscription 1, openai 4, groq 3, gemini 3, nvidia 2, huggingface 2, openrouter 7, together 4, deepseek 2, mistral 2, zai 2, kimi 2, minimax 2, vercel_gateway 2, custom_openai 1, ollama 3, nous_portal 2.
- All four `ApiMode`s covered: `chat_completions` (15 providers), `anthropic_messages` (anthropic + claude_subscription), `codex_responses` (openai + chatgpt_subscription), `ollama_prompt_tools` (ollama).

## Test coverage

| File | New cases | Pass |
|---|---:|:---:|
| `tests/v4/registry.test.ts` | 6 | ✅ |
| `tests/v4/modelCatalog.test.ts` | 5 | ✅ |
| `tests/v4/runtimeResolver.test.ts` | 16 | ✅ |
| `tests/v4/modelSwitch.test.ts` | 10 | ✅ |
| **Phase 5 unit total** | **37** | **37/37** |

| File | Status | Notes |
|---|---|---|
| `tests/v4/integration/runtimeResolver.real.test.ts` | ✅ passed | Real Groq call via full registry → resolver → adapter chain. Replied "OK", finishReason=stop. |

**Cumulative v4 unit tests:** Phase 4 reported 82 passed; Phase 5 brings the suite to **123 passed, 2 skipped** (full `tests/v4/` run, including all integration tests in their declared skip-when-no-key state).

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run tests/v4/` | ✅ 123 passed, 2 skipped |
| Integration: Groq via full chain | ✅ passed |
| `npm test` (full regression) | ✅ **1539 passed**, 2 skipped, 1 todo. Same 16 pre-existing native-modules/ file failures as Phase 4 (vendored puppeteer/zod with missing dev deps). |
| Zero v3 regressions | ✅ |

## Cost spent

- Groq: ~free tier — single 10-token call. Estimated **<$0.001**.
- No other providers exercised in this session.

## Graphify

| Metric | Pre-Phase 5 | Post-Phase 5 | Δ |
|---|---:|---:|---:|
| Nodes | 1931 | **1956** | +25 |
| Edges | 3497 | 3556 | +59 |
| Communities | 148 | 141 | -7 |

Hook fired on each commit; rebuild ran inline.

## Skipped / deferred (by design)

- **config.yaml parser** (Phase 6+ when SQLite + memory + config land). `ConfigProvider.get()` is a stub — `options.config` slot exists for tests + future wiring.
- **Interactive picker UI / setup wizard** — Phase 13.
- **Provider chain orchestration with multi-provider fallback** — Phase 8 (distinct from Phase 2's one-shot fallback).
- **Reasoning-effort / stream toggles** in resolver options — Phase 13.
- **`aiden doctor` command** — Phase 13. `describe()` is the data surface it'll consume.
- **Model insights / token usage tracking dashboard** — Phase 13.
- **Per-provider URL/api_mode quirks** Hermes handles (OpenCode model-family inference, Azure auth bypass, AWS SDK chain, Anthropic-compat `/anthropic` suffix detection, Kimi `/coding` detection) — deferred until those providers actually ship; current single-`apiMode`-per-row works for the 19 providers in scope.

## What Phase 6 needs to know

**Phase 6 mission:** SQLite session store + FTS5 + memory system.

**Surfaces ready to plug into:**
- `RuntimeResolver` is the shared resolution entry point. Phase 6 doesn't change provider wiring — it adds storage underneath the agent loop so sessions persist across restarts.
- `ConfigProvider` interface in `runtimeResolver.ts` is the slot Phase 6's config.yaml parser plugs into. Its only method is `get(key: string): string | undefined`; tests already stub it to validate config-precedence behaviour.
- `MODEL_CATALOG` carries `pricing` + `contextLength` fields ready for Phase 6 to store usage telemetry per (session, model) without a schema migration.

## Acceptance check (Phase 5)

- [x] Task 1 4-bullet Hermes summary reported BEFORE coding (in chat + this doc)
- [x] `registry.ts` — 19 providers, all 4 ApiModes covered
- [x] `modelCatalog.ts` — minimum models per provider, exactly one default each
- [x] `runtimeResolver.ts` — all 4 public methods (resolve, describe, listProviders, listModels)
- [x] `modelSwitch.ts` — parse() handles `provider:model` and bare-model forms
- [x] 37 new unit tests passing (target ~33+)
- [x] Integration test passes against real Groq when key set
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression: **1539 passed**, zero v3 regressions
- [x] Three commits on `v4-rewrite`, all pushed to `backup`
- [x] `docs/sprint/phase-5-completed.md` under 200 lines
