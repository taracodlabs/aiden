# Providers

Aiden ships 19 first-class provider integrations. You bring your own
key (or OAuth account); your conversations and credentials never leave
your machine.

This page is the configuration reference. For the "how do I switch
mid-session" UX, see [`slash-commands.md`](./slash-commands.md) §
`/model` and `/providers`.

---

## How Aiden talks to providers

Three principles:

- **BYOK** — bring your own key. Aiden has no managed proxy, no
  central account, no usage telemetry. Your API key goes straight
  from your machine to the provider's endpoint.
- **No middle-man.** Aiden's process opens a direct HTTPS connection
  per call. No queue, no aggregator-of-aggregators, no shared
  inference pool.
- **Cost visibility.** Every reply ends with token + cost estimates
  for the providers Aiden knows pricing for. `/usage` totals the
  session.

---

## Picking a provider at boot

Three ways:

1. **Setup wizard** (first boot) — Aiden lists every provider with
   detected credentials and asks you to pick.
2. **Env var override** — set `AIDEN_PROVIDER=<id>` and
   `AIDEN_MODEL=<id>` before booting. Skips the wizard.
3. **CLI flag** — `aiden --provider <id> --model <id>` for one-shot.

After boot:

```
/model
```

opens the live picker — every model your configured providers expose.
Arrow + Enter to switch. No restart, no history loss.

---

## Provider categories

| Category | How auth works | Providers |
|---|---|---|
| **OAuth subscription routing** | One-click browser flow; reuses your existing subscription. | claude-pro, chatgpt-plus |
| **Free-tier API key** | Sign up for a free key; small monthly quota. | groq, gemini, openrouter |
| **Paid API key** | Pay-as-you-go or subscription; full quota. | anthropic, openai, together, mistral, deepseek, nvidia, kimi, minimax, zai, huggingface, nous_portal |
| **Local / self-hosted** | No external auth. | ollama |
| **Routed aggregator** | Bring your own gateway endpoint. | vercel_gateway, custom_openai |

---

## OAuth subscription routing

For the two big chat consumer subscriptions, Aiden lets you re-use
the OAuth account you already have instead of paying again for API
credits.

### `claude-pro`

| Property | Value |
|---|---|
| **Models** | claude-sonnet-4.5, claude-opus-4.5, claude-haiku-4.5, …  |
| **Setup** | `/auth login claude-pro` opens your browser; sign in to your existing Anthropic account; Aiden stores the token in `~/.aiden/auth.json`. |
| **Cost** | Counts against your Claude Pro / Max subscription quota. No API spend. |
| **Notes** | Subscription routing — same auth path Anthropic's official client uses. Refresh happens automatically. |
| **Env var fallback** | None — OAuth-only. |

### `chatgpt-plus`

| Property | Value |
|---|---|
| **Models** | gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.2-codex, gpt-5, …  |
| **Setup** | `/auth login chatgpt-plus` browser flow. |
| **Cost** | Counts against your ChatGPT Plus / Team / Enterprise subscription quota. No API spend. |
| **Notes** | Subscription routing via OpenAI's Codex / Responses API. Refresh happens automatically. |
| **Env var fallback** | None — OAuth-only. |

---

## Free-tier API key providers

Best for getting started. Sign up, copy a key, you're done.

### `groq`

| Property | Value |
|---|---|
| **Models** | llama-3.3-70b-versatile (default), llama-3.1-8b-instant, mixtral-8x7b-32768 |
| **Setup** | <https://console.groq.com> → API Keys → Create Key. `export GROQ_API_KEY=...` or paste in setup wizard. |
| **Cost** | Free tier is generous: ~30 req/min, no monthly cap last I checked. Paid tiers exist for higher RPM. |
| **Notes** | Fastest inference of any provider Aiden supports (sub-second on 70B). Recommended default for new users. |
| **Env var** | `GROQ_API_KEY` |

### `gemini`

| Property | Value |
|---|---|
| **Models** | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, …  |
| **Setup** | <https://aistudio.google.com/apikey> → Create API key → set `GOOGLE_AI_STUDIO_API_KEY`. |
| **Cost** | Free tier: 15 req/min, 1500 req/day on Flash models. Pro models have lower free tier limits. |
| **Notes** | Native multimodal — images / video / audio in prompts work without separate vision API. |
| **Env var** | `GOOGLE_AI_STUDIO_API_KEY` |

### `openrouter`

| Property | Value |
|---|---|
| **Models** | 300+ models from 50+ providers. Some are free; most are paid via OpenRouter's unified billing. |
| **Setup** | <https://openrouter.ai/keys> → Create key → set `OPENROUTER_API_KEY`. |
| **Cost** | Pay-as-you-go aggregator; pre-fund a balance. Free-tier models (`:free` suffix) consume daily quota instead of credits. |
| **Notes** | One key, many models — useful for trying providers without signing up separately. Latency is +1 hop. |
| **Env var** | `OPENROUTER_API_KEY` |

---

## Paid API key providers

Direct API access; pay-as-you-go per token.

### `anthropic`

| Property | Value |
|---|---|
| **Models** | claude-sonnet-4.5, claude-opus-4.5, claude-haiku-4.5, … |
| **Setup** | <https://console.anthropic.com> → API Keys → Create Key. `export ANTHROPIC_API_KEY=...` |
| **Cost** | Pay-as-you-go per token. Pricing at <https://anthropic.com/pricing>. |
| **Notes** | Prompt caching supported (Aiden enables it automatically — see token-usage breakdown). Reasoning effort configurable via `/reasoning`. |
| **Env var** | `ANTHROPIC_API_KEY` |

### `openai`

| Property | Value |
|---|---|
| **Models** | gpt-5.5, gpt-5.4, gpt-5.2, gpt-5, …  |
| **Setup** | <https://platform.openai.com/api-keys> → Create new secret key. `export OPENAI_API_KEY=...` |
| **Cost** | Pay-as-you-go. |
| **Notes** | Direct API access (not subscription routing — for that use `chatgpt-plus`). Codex Responses API supported. |
| **Env var** | `OPENAI_API_KEY` |

### `together`

| Property | Value |
|---|---|
| **Models** | Llama 3.3 70B, Llama 3.1 405B, DeepSeek, Mixtral, Qwen, … (open-weights aggregator) |
| **Setup** | <https://api.together.ai> → Settings → API Keys. `export TOGETHER_API_KEY=...` |
| **Cost** | Pay-as-you-go; per-model pricing. |
| **Notes** | Strong for open-weights models when you don't want to self-host. |
| **Env var** | `TOGETHER_API_KEY` |

### `mistral`

| Property | Value |
|---|---|
| **Models** | mistral-large-2, mistral-medium, codestral, mixtral, … |
| **Setup** | <https://console.mistral.ai/api-keys> |
| **Cost** | Pay-as-you-go. |
| **Notes** | European-hosted; useful for data-residency requirements. |
| **Env var** | `MISTRAL_API_KEY` |

### `deepseek`

| Property | Value |
|---|---|
| **Models** | deepseek-v3, deepseek-r1, deepseek-coder |
| **Setup** | <https://platform.deepseek.com/api_keys> |
| **Cost** | Cheap. R1 reasoning model is significantly cheaper than equivalents elsewhere. |
| **Notes** | Reasoning effort configurable. |
| **Env var** | `DEEPSEEK_API_KEY` |

### `nvidia`

| Property | Value |
|---|---|
| **Models** | NIM-hosted Llama, Nemotron, …  |
| **Setup** | <https://build.nvidia.com> → API Catalog → Generate API Key. |
| **Cost** | Free credits on signup; paid after. |
| **Notes** | OpenAI-compatible endpoint under the hood. |
| **Env var** | `NVIDIA_API_KEY` |

### `kimi`

| Property | Value |
|---|---|
| **Models** | Kimi K2 / K1.5 (Moonshot AI) |
| **Setup** | <https://platform.moonshot.cn/console/api-keys> |
| **Cost** | Pay-as-you-go. |
| **Notes** | Strong long-context handling (up to 128k tokens). |
| **Env var** | `MOONSHOT_API_KEY` |

### `minimax`

| Property | Value |
|---|---|
| **Models** | abab6.5s, abab6.5g |
| **Setup** | <https://api.minimax.chat> → Account → API Keys |
| **Cost** | Pay-as-you-go. |
| **Notes** | Available endpoints: international + China. Set `MINIMAX_BASE_URL` to switch. |
| **Env var** | `MINIMAX_API_KEY` |

### `zai`

| Property | Value |
|---|---|
| **Models** | GLM-4-Plus, GLM-4-Air, GLM-4-Flash |
| **Setup** | <https://open.bigmodel.cn> → API keys |
| **Cost** | Pay-as-you-go. Free tier on Flash. |
| **Env var** | `ZAI_API_KEY` |

### `huggingface`

| Property | Value |
|---|---|
| **Models** | Inference Providers — Llama, Qwen, Phi, … (hosted by HF + partners) |
| **Setup** | <https://huggingface.co/settings/tokens> → Generate fine-grained token with Inference API read access. |
| **Cost** | Free tier on most models; paid for higher quotas + enterprise models. |
| **Env var** | `HF_TOKEN` |

### `nous_portal`

| Property | Value |
|---|---|
| **Models** | Models hosted by the upstream portal at `inference-api.nousresearch.com/v1`. Catalog visible after auth. |
| **Setup** | Subscribe at <https://nousresearch.com> → portal subscription → set `NOUS_PORTAL_API_KEY` to the token you receive. |
| **Cost** | Subscription-based (the upstream portal manages billing; Aiden just forwards the key). |
| **Notes** | Third-party chat-completions endpoint. Configuration shape mirrors any OpenAI-compatible API. |
| **Env var** | `NOUS_PORTAL_API_KEY` |

---

## Local / self-hosted

### `ollama`

| Property | Value |
|---|---|
| **Models** | Whatever you've `ollama pull`-ed locally (Llama 3.3, Mistral, Qwen, DeepSeek-R1, Phi, …). |
| **Setup** | Install Ollama from <https://ollama.com> → `ollama pull llama3.3` → Aiden auto-detects. |
| **Cost** | Free — runs on your machine. Hardware-bound throughput. |
| **Notes** | No internet required after pulling models. Useful for offline / air-gapped workflows. Tuning vars listed in [`env-vars.md`](./env-vars.md) § Ollama. |
| **Env vars** | `OLLAMA_HOST` (default `http://localhost:11434`), `OLLAMA_TEMPERATURE`, `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_NUM_GPU`, `OLLAMA_NUM_THREAD`, `OLLAMA_TOP_P`, `OLLAMA_REPEAT_PENALTY` |

---

## Routed aggregators

### `vercel_gateway`

| Property | Value |
|---|---|
| **Models** | Models exposed by Vercel's AI Gateway (varies by deployment). |
| **Setup** | Configure your gateway at <https://vercel.com/ai-gateway>; set `VERCEL_API_KEY` and `VERCEL_BASE_URL` to the gateway URL. |
| **Cost** | Vercel charges per request; you pay the upstream provider via Vercel. |
| **Env vars** | `VERCEL_API_KEY`, `VERCEL_BASE_URL` |

### `custom_openai`

| Property | Value |
|---|---|
| **Models** | Whatever your endpoint exposes. |
| **Setup** | Set `OPENAI_BASE_URL` to your endpoint + `OPENAI_API_KEY` to its auth token. Aiden uses the OpenAI chat-completions API shape. |
| **Cost** | Whatever your endpoint charges. |
| **Notes** | Use this for self-hosted llama.cpp, vLLM, LM Studio, LocalAI, or any OpenAI-compatible API not in the registry. |
| **Env vars** | `OPENAI_BASE_URL`, `OPENAI_API_KEY` |

---

## Provider fallback chain

When you have multiple providers configured AND a request fails with
a retryable error (rate limit, transient 5xx), Aiden's `FallbackAdapter`
automatically rotates to the next configured slot. Settings:

- **Slot order** — `config.yaml` `providers.fallback_order` (top-down).
- **Cooldown** — failed slots are skipped for the cooldown duration
  (default 60 s).
- **Per-slot rate limits** — tracked locally so multi-key Groq setups
  spread load across keys.

When `subagent_fanout` rotates children across providers (see
[`../features/sub-agents.md`](../features/sub-agents.md) § Provider
rotation), it reads from the same fallback chain.

---

## Switching providers mid-session

Three slash commands cover the day-to-day:

| Command | What |
|---|---|
| `/model` | Open the live picker; switch in one keystroke. |
| `/providers` | Liveness probe — see which configured providers are reachable right now. |
| `/auth status` | OAuth + key status for every configured provider. |

---

## Adding a provider that isn't listed

Aiden's `custom_openai` slot covers any OpenAI-compatible endpoint:

```bash
export OPENAI_BASE_URL=https://your-endpoint.example.com/v1
export OPENAI_API_KEY=sk_yours
aiden
```

Pick `custom_openai` from the wizard. Aiden treats it like any other
OpenAI-shape provider.

For non-OpenAI-shape endpoints, you'd need to write a custom provider
adapter. That's a contributor topic, not a user topic — track via
[GitHub issues](https://github.com/taracodlabs/aiden/issues) if you
want a new built-in provider added.

---

## See also

- [`cli-commands.md`](./cli-commands.md) — `aiden model`, `aiden --provider`, `aiden doctor --providers`.
- [`env-vars.md`](./env-vars.md) — full per-provider env var inventory.
- [`slash-commands.md`](./slash-commands.md) — `/model`, `/providers`, `/auth`.
- [`../getting-started.md`](../getting-started.md) — first-time provider setup walkthrough.

---

## What this isn't

- **Not a model performance comparison.** Capability and pricing
  change weekly across all 19 providers. Run `aiden doctor --providers`
  + check upstream pricing pages for current data.
- **Not a guarantee of model availability.** Aiden's registry lists
  what providers expose to their APIs; specific models can be
  deprecated upstream at any time. `/model` reflects what's actually
  callable right now.
- **Not telemetry-collecting.** No "which providers are popular" data
  flows back to Aiden. Your provider choice is fully local.
