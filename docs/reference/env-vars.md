# Environment variables

Every environment variable Aiden reads, grouped by what they control.
All variables are optional — Aiden boots with sensible defaults if
none are set.

Aiden reads env vars from:

1. Your shell's exported environment (highest precedence).
2. `~/.aiden/.env` (gitignored; populated by the setup wizard).
3. The project's `.env` if you boot from a project root.
4. Compiled-in defaults (lowest precedence).

A reload is needed for most vars — restart `aiden` after changing them.
A few are read at call time and update live; those are flagged below.

---

## Behavior toggles

Switches that turn whole subsystems on or off.

### `AIDEN_DAEMON`

- **Values**: `0` / `1` (or `true` / `false`)
- **Default**: unset (= off)
- **Effect**: Boots the background dispatcher alongside the REPL.
  Required for file watchers, webhooks, IMAP, and cron triggers.
- **Live-flippable**: no (restart required).
- **See**: [`../features/daemon-mode.md`](../features/daemon-mode.md).

### `AIDEN_TCE`

- **Values**: `0` / `1`
- **Default**: `1` (on)
- **Effect**: Continuous error recovery — 16-category failure
  classifier + smart retry. Off = every failure surfaces immediately.
- **Live-flippable**: yes, via `/tce on|off`.

### `AIDEN_BROWSER_DEPTH`

- **Values**: `0` / `1`
- **Default**: `1` (on)
- **Effect**: State-aware browser observation — URL + DOM + iframe
  snapshot before/after every browser tool call. Off = no stale-ref
  retry, no captcha/login detection.
- **Live-flippable**: yes, via `/browser-depth on|off`.

### `AIDEN_BROWSER_HEADLESS`

- **Values**: `true` / `false`
- **Default**: `false` (visible browser window)
- **Effect**: Headless mode for Playwright Chromium. Set to `true` in
  CI / on servers where no display is available.
- **Live-flippable**: read at module load.

### `AIDEN_PLANNER_GUARD`

- **Values**: `0` / `1`
- **Default**: `0` (off; modern models pick well from the full tool catalog)
- **Effect**: Keyword-based per-turn tool narrowing. Opt-in for smaller
  local models (Llama 3 8B, etc.) overwhelmed by 60+ tool schemas.
- **Live-flippable**: yes, via `/planner-guard on|off`.

### `AIDEN_SUGGESTIONS`

- **Values**: `0` / `1`
- **Default**: `1`
- **Effect**: Contextual capability hints during chat — Aiden suggests
  `/daemon` when you say "every day at 9am", etc.
- **Live-flippable**: yes, via `/suggestions on|off`.

### `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: When `1`, drops the hard 5-name blocklist for sub-agent
  children (`spawn_sub_agent`, `clarify`, `memory`, `execute_code`,
  `send_message`). Children inherit the parent's full toolset. Use
  with care.
- **Live-flippable**: read at every spawn dispatch (no restart needed
  after `.env` change).
- **See**: [`../features/sub-agents.md`](../features/sub-agents.md).

### `AIDEN_FANOUT_DRY_RUN`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: `aiden fanout` uses synthetic in-process stub adapters
  instead of real providers. Useful for CI smoke tests.

### `AIDEN_NO_UI`

- **Values**: any truthy
- **Default**: unset
- **Effect**: Skip the startup card + interactive picker. Equivalent
  to the `--no-ui` CLI flag. Required for piped stdin / CI.

### `AIDEN_NO_UPDATE_CHECK`

- **Values**: any truthy
- **Default**: unset
- **Effect**: Skip the boot-time npm version probe.

### `AIDEN_NO_REFORMAT`

- **Values**: any truthy
- **Default**: unset
- **Effect**: Disable the post-reply markdown reformatter.

### `AIDEN_BANNER`

- **Values**: `off` / `minimal` / `full`
- **Default**: `full`
- **Effect**: Controls the boot card. `off` = no banner. `minimal` =
  one-line status. `full` = the ASCII art + status pills.

### `AIDEN_THEME` / `AIDEN_SKIN`

- **Values**: `default` / `nord` / `dracula`
- **Default**: `default`
- **Effect**: Terminal color scheme.
- **Live-flippable**: yes, via `/skin <name>`.

### `AIDEN_CITATIONS`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: Append citation footnotes to web-grounded replies when
  the provider supports them.

---

## Budgets + timeouts

Numeric caps that bound resource use.

### `AIDEN_SUBAGENT_TIMEOUT_MS`

- **Values**: positive integer
- **Default**: `90000` (90 s for fanout children)
- **Effect**: Per-child timeout for `subagent_fanout`. `spawn_sub_agent`
  has its own `timeoutMs` field at the schema level (default 600,000;
  10 min) and isn't affected by this var.

### `AIDEN_SUBAGENT_AGGREGATOR_MODEL`

- **Values**: `provider:model` (e.g. `groq:llama-3.3-70b-versatile`)
- **Default**: parent's active model
- **Effect**: Override the model used for fanout's `vote/pick-best/combine`
  aggregator call. Useful when you want cheap children + a smart judge.

### `AIDEN_SUMMARY_TIMEOUT_MS`

- **Values**: positive integer
- **Default**: `12000` (12 s)
- **Effect**: Hard cap on the auxiliary-model session-distillation
  call at `/quit`. Above this, Aiden writes the deterministic-only
  summary and skips the LLM half.

### `AIDEN_BROWSER_TIMEOUT`

- **Values**: positive integer (ms)
- **Default**: `15000` (15 s)
- **Effect**: Navigation / action timeout for Playwright operations.

### `AIDEN_CRON_TICK_MS`

- **Values**: positive integer
- **Default**: `1000` (1 s)
- **Effect**: How often the cron scheduler checks for due jobs.

### `AIDEN_CRON_TIMEOUT_MS`

- **Values**: positive integer
- **Default**: `300000` (5 min)
- **Effect**: Max wall-clock for a single cron-fired agent turn.

### `AIDEN_DAEMON_DRAIN_TIMEOUT_MS`

- **Values**: positive integer
- **Default**: `30000` (30 s)
- **Effect**: How long `aiden daemon stop` waits for in-flight runs
  to finish before forcing exit.

### `AIDEN_DAEMON_EMAIL_RETENTION_DAYS`

- **Values**: positive integer
- **Default**: `30`
- **Effect**: How long the daemon keeps seen-message rows in the
  email-forensic table before pruning.

### `AIDEN_DAEMON_WEBHOOK_RETENTION_DAYS`

- **Values**: positive integer
- **Default**: `30`
- **Effect**: How long the daemon keeps webhook-delivery rows before
  pruning.

### `AIDEN_DAEMON_RESTART_FAILURE_THRESHOLD`

- **Values**: positive integer
- **Default**: `3`
- **Effect**: How many consecutive daemon crashes before auto-restart
  gives up.

### `OLLAMA_*` (when using the Ollama provider)

| Var | Effect | Range |
|---|---|---|
| `OLLAMA_TEMPERATURE` | Sampling temperature | 0.0 – 2.0 |
| `OLLAMA_CONTEXT_LENGTH` | `num_ctx` tokens | > 0 |
| `OLLAMA_NUM_GPU` | GPU layers offloaded | ≥ 0 |
| `OLLAMA_NUM_THREAD` | CPU threads | > 0 |
| `OLLAMA_TOP_P` | Top-p sampling | 0.0 – 1.0 |
| `OLLAMA_REPEAT_PENALTY` | Repeat penalty | ≥ 0 |

Read at call time — no restart needed after `.env` change.

---

## Debugging + tracing

Flags that crank up logging or write trace artifacts.

### `AIDEN_DEBUG_LOOP`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: When `1`, captures a trace snapshot of any turn that
  shows loop symptoms (10+ tool calls or 5+ consecutive same-name).
  Output lands in `~/.aiden/logs/loop-traces/`.

### `AIDEN_DEBUG_OAUTH`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: Verbose logging for OAuth flows. Tokens are redacted but
  every request/response shape is logged.

### `AIDEN_DEBUG_CODEX`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: Verbose logging for the OpenAI Codex / Responses API
  path. Useful when chatgpt-plus OAuth requests fail mysteriously.

### `AIDEN_DEBUG_SKILL_ENFORCEMENT`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: Logs every skill-enforcement decision (which tool the
  agent reached for vs which the skill required).

### `AIDEN_DEBUG_URL_PROVENANCE`

- **Values**: `0` / `1`
- **Default**: `0`
- **Effect**: Logs the URL-ledger ingest path — useful when the agent
  hallucinates a URL and you want to see where the ID came from.

---

## OAuth + auth + provider keys

How Aiden picks up credentials. Per-provider keys live alongside the
two OAuth-controlled providers.

### Per-provider API key env vars

Aiden's setup wizard writes keys to `~/.aiden/.env`. Set them in your
shell instead if you prefer:

| Provider | Env var | Notes |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Direct API. |
| OpenAI | `OPENAI_API_KEY` | Direct API. |
| Groq | `GROQ_API_KEY` | Free tier — fastest setup. |
| Google Gemini | `GOOGLE_AI_STUDIO_API_KEY` | Free tier via AI Studio. |
| OpenRouter | `OPENROUTER_API_KEY` | Aggregator; some models free. |
| Together | `TOGETHER_API_KEY` | Paid. |
| Mistral | `MISTRAL_API_KEY` | Paid. |
| DeepSeek | `DEEPSEEK_API_KEY` | Paid. |
| NVIDIA NIM | `NVIDIA_API_KEY` | Paid. |
| Hugging Face | `HF_TOKEN` | Token from huggingface.co. |
| Z.ai | `ZAI_API_KEY` | Paid. |
| Kimi (Moonshot) | `MOONSHOT_API_KEY` | Paid. |
| MiniMax | `MINIMAX_API_KEY` | Paid. |
| Vercel AI Gateway | `VERCEL_API_KEY` + `VERCEL_BASE_URL` | Aggregator. |
| Nous Portal | `NOUS_PORTAL_API_KEY` | Third-party subscription. |
| Custom OpenAI-compatible | `OPENAI_BASE_URL` + `OPENAI_API_KEY` | Any compatible endpoint. |
| Ollama | (none — local socket) | Set `OLLAMA_HOST` to override the default `http://localhost:11434`. |

See [`providers.md`](./providers.md) for per-provider setup walkthroughs.

### OAuth state

The two OAuth-controlled providers (claude-pro, chatgpt-plus) write
their token state to `~/.aiden/auth.json` after a successful browser
flow. No env vars are involved in their happy path; use
`/auth status` to inspect.

If `auth.json` gets corrupted, you can delete it and re-run
`/auth login <provider>` to refresh.

### `AIDEN_API_KEY`

- **Values**: bearer token string
- **Default**: unset
- **Effect**: Required when you boot the OpenAI-compatible HTTP API
  (Aiden's `/v1/chat/completions` shim). Unset = unauthenticated local
  access. Has no effect on Aiden's outbound calls to providers.

---

## Paths + system

Where Aiden stores state.

### `AIDEN_HOME`

- **Values**: filesystem path
- **Default**: `~/.aiden` (Linux/macOS), `%LOCALAPPDATA%\aiden` (Windows)
- **Effect**: Root directory for all Aiden data — sessions, daemon DB,
  config, memory, skills, plugins, logs. Override for multi-instance
  setups or non-standard install layouts.

### `AIDEN_PORT`

- **Values**: TCP port
- **Default**: `7820`
- **Effect**: Port for Aiden's OpenAI-compatible HTTP API (`/v1/*`).
  Bound to `127.0.0.1` by default; see `AIDEN_DAEMON_BIND` to change.

### `AIDEN_DAEMON_BIND`

- **Values**: IP address
- **Default**: `127.0.0.1`
- **Effect**: Bind address for the daemon's webhook + API endpoints.
  `0.0.0.0` exposes to the LAN; do this only behind a real firewall.

### `AIDEN_DAEMON_PORT`

- **Values**: TCP port
- **Default**: `7821`
- **Effect**: Daemon's webhook router port (separate from the API).

### `AIDEN_DAEMON_MODEL`

- **Values**: `provider:model` (e.g. `groq:llama-3.3-70b-versatile`)
- **Default**: REPL's active model
- **Effect**: Override the model daemon-fired turns use. Lets you run
  cheap daemon turns + expensive REPL turns from one Aiden install.

### `AIDEN_DAEMON_AUTO_RESTART`

- **Values**: `0` / `1`
- **Default**: `1`
- **Effect**: Whether the service manager auto-restarts the daemon
  after a non-clean exit. Off = manual recovery required.

---

## See also

- [`cli-commands.md`](./cli-commands.md) — CLI flags that mirror env vars (e.g. `--no-ui`).
- [`providers.md`](./providers.md) — per-provider env var details.
- [`../features/daemon-mode.md`](../features/daemon-mode.md) — full daemon configuration story.
- [`../features/sub-agents.md`](../features/sub-agents.md) — `AIDEN_SUBAGENT_*` deep dive.

---

## What this isn't

- **Not a full list of system env vars.** Aiden also reads standard
  Node / npm vars (`NODE_OPTIONS`, `npm_config_*`, etc.). Those are
  Node concerns, not Aiden concerns.
- **Not a hot-reload contract.** Most vars require restart. Where
  live-flippable behavior exists, it's a slash command, not an env
  var watch.
- **Not stable across major versions.** Boolean / value formats are
  stable within a major (v4.x), but new vars get added and old ones
  retired between majors.
