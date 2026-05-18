<img width="1672" height="941" alt="AIDEN BOOTUP LOGO" src="https://github.com/user-attachments/assets/c0809009-73e2-4d58-9292-12fbd0324952" />

```
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝

Autonomous AI Engine — local-first, Windows-native, yours to own

74 skills · 60 tools · 19 providers · 9 channels · AGPL-3.0

Windows · Linux · WSL · macOS (API Mode)
```

<p align="center">
  <a href="https://github.com/taracodlabs/aiden/releases/latest"><img src="https://img.shields.io/badge/version-v4.6.0-f97316?style=for-the-badge" alt="v4.6.0" /></a>
  <a href="https://www.npmjs.com/package/aiden-runtime"><img src="https://img.shields.io/npm/v/aiden-runtime?color=f97316&label=npm&style=for-the-badge" alt="npm" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-orange?style=for-the-badge" alt="License: AGPL-3.0" /></a>
  <a href="https://discord.gg/gMZ3hUnQTm"><img src="https://img.shields.io/badge/chat-discord-7289da?logo=discord&logoColor=white&style=for-the-badge" alt="Discord" /></a>
  <a href="https://github.com/taracodlabs/aiden/stargazers"><img src="https://img.shields.io/github/stars/taracodlabs/aiden?style=for-the-badge&color=f9d71c" alt="Stars" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white&style=for-the-badge" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-18+-43853d?logo=node.js&logoColor=white&style=for-the-badge" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/SQLite-003b57?logo=sqlite&logoColor=white&style=for-the-badge" alt="SQLite" />
  <img src="https://img.shields.io/badge/Playwright-1.58-2ea44f?logo=playwright&logoColor=white&style=for-the-badge" alt="Playwright" />
  <img src="https://img.shields.io/badge/MCP-1.27-7c3aed?style=for-the-badge" alt="Model Context Protocol" />
</p>

---

## What's new in v4.6

Aiden now spawns workers and learns from itself.

- **Sub-agents.** `spawn_sub_agent` runs a focused child with an isolated context + intersected toolset; `subagent_fanout` runs N children in parallel (ensemble or partition) with merge strategies (`all` / `vote` / `pick-best` / `combine`) and provider rotation across configured fallback slots.
- **Operator kill-switch.** `/spawn-pause on|off|status` blocks new sub-agent spawning while in-flight children continue. Marker file at `~/.aiden/spawn.paused` so the state survives restart and is shared across REPL, daemon, and MCP runtimes. Optional reason field captured in the typed `SUBAGENT_SPAWN_PAUSED` error envelope.
- **Self-improvement loop foundation.** TCE classifications + recoveries persist to two new SQLite tables (`failure_signatures`, `recovery_reports`); `/recovery list|show|clear` surfaces recurring failure patterns across sessions.
- **REPL parent-run lineage.** Each REPL turn writes its own `runs` row; sub-agent children link back via `spawned_from_run_id`. `aiden runs list` hides children by default and shows a `(N children, M OK)` badge per parent; `--include-children` flips to flat view.
- **PlannerGuard opt-in.** The keyword-based per-turn tool narrower is OFF by default in v4.6 (modern models pick well from the full catalog). Enable via `/planner-guard on` or `AIDEN_PLANNER_GUARD=1` for smaller local models.

Phase 2 also fixed an MCP-mode `subagent_fanout` regression that had silently broken in the v4.5 refactor.

---

## What's new in v4.5

Aiden now wakes up by itself.

- **Persistent daemon mode (opt-in).** `AIDEN_DAEMON=1` boots a background service with a SQLite-backed trigger bus. File watchers, webhook endpoints, IMAP polling, and cron schedules all feed the same durable queue.
- **Autonomous trigger dispatch.** When a trigger fires, a real AidenAgent turn runs end-to-end — same tools, same sandbox, same recovery pipeline as your interactive REPL. Surface the chain with `aiden runs show <id>`.
- **Execution sandbox with risk tiers.** Filesystem allowlist + Docker session backend + dry-run preflight. Default on; flip live with `/sandbox on|off`.
- **State-aware browser depth.** URL + DOM + iframe-tree capture before/after every browser tool call. Stale-ref auto-retry. Surfaces login / 2FA / captcha / consent blockers as structured cards.
- **Continuous error recovery (TCE).** 16 failure categories classified per tool call. Smart retry with cooldown. Dead-letter for permanent failures. Recovery report enriches the REPL's capability card.
- **Live-flip slash commands.** `/sandbox`, `/tce`, `/browser-depth`, `/daemon status`, `/suggestions`, `/update` — toggle every subsystem without restart. Choices persist to `config.yaml`.
- **Update notification + `/update` CLI.** Boot prompt when a newer version is on npm. Skip-this-version persistence. Install-method detection (npm-global / npx / standalone). Q-U6: spawn directly when supported, print command when not.

Full v4.5 internals: `docs/v4.5/` (overview, triggers, architecture, daemon on Linux/macOS/Windows, troubleshooting).

---

## Try it in 60 seconds

```bash
npm install -g aiden-runtime
aiden
```

That's it. Pick a provider (Groq is free + fastest), paste your key, and start chatting.

Want autonomous triggers?

```bash
export AIDEN_DAEMON=1          # PowerShell: $env:AIDEN_DAEMON = "1"
aiden trigger add file --path ~/Documents/inbox --label "watch-inbox" --include "*.txt"
aiden                          # boots the REPL + dispatcher
```

Drop a file in `~/Documents/inbox/anything.txt` and Aiden acts on it. The agent turn is visible via `aiden runs list`.

---

## Core capabilities

| Category | What Aiden does |
|---|---|
| **Inference & providers** | 19 providers: Anthropic, OpenAI, Groq, Gemini, OpenRouter, Together, NVIDIA NIM, DeepSeek, Mistral, Z.ai, Kimi, MiniMax, Hugging Face, Ollama (fully offline), custom OpenAI-compatible endpoints. OAuth subscription routing for Claude Pro and ChatGPT Plus. |
| **59 built-in tools** | Web search & fetch, deep research, YouTube search, Playwright browser automation (10 tools), file ops, process control, shell exec, code execution, system info, screenshot, clipboard, app launch, media keys, MCP bridge, memory ops, session list/search/summary/recall, skill view/list/manage, `aiden_self_update`. |
| **74 bundled skills** | Composable workflows each with a `SKILL.md` prompt, optional helper scripts, and tool requirements. GitHub PR/issue workflows, NSE / Upstox / Zerodha trading, Censys / Shodan / VirusTotal lookups, Windows Defender / Task Scheduler, Docker management, YouTube content tools, and more. |
| **Self-promoting memory** | `USER.md` + `SOUL.md` identity, plus `MEMORY.md` split between durable facts (compression-protected) and recent-session distillations. Each session ends with a structured summary that graduates durable facts into the protected section. Semantic recall over past sessions via `recall_session`. |
| **Voice** | Edge TTS / Windows SAPI text-to-speech, speech-to-text helpers. |
| **Channel adapters** | Discord, Slack, Telegram, WhatsApp, Email (IMAP+SMTP), Webhook, Twilio SMS, iMessage (macOS), Signal — any channel triggers the same agent loop. |
| **Computer use** | Screenshot capture, screen-state vision loop, browser automation. Mouse/keyboard automation partial. |
| **v4.5 daemon mode (opt-in)** | File watcher / webhook / email IMAP / scheduled triggers route through a durable trigger bus consumed by the Phase 5a dispatcher. Triggers fire → real agent runs → tool calls execute → `run_events` captures the chain. Off by default. |
| **Plugins** | Three bundled plugins: Chrome DevTools Protocol bridge, Claude Pro OAuth, ChatGPT Plus OAuth. Permission-state machine (pending-grant / loaded / suspended). |
| **MCP** | Model Context Protocol bridge — stdio + HTTP transports, schema discovery, tool dispatch. |
| **Security moat** | Tiered approval engine (safe / caution / dangerous), dangerous-command pattern classifier, honesty enforcement (post-loop scan rewrites false claims), memory guard, planner-guard tool narrowing, SSRF-safe URL fetcher, secret/PII pre-write scanner, skill-teacher (auto-create skills from successful flows). |

---

## Architecture (one paragraph)

Aiden is a local-first agent loop: provider adapters feed a 90-turn ceiling, every tool call passes through verification + failure classification + recovery, and tool results stream back as structured envelopes the model can reason over. v4.5 added a SQLite daemon foundation alongside the REPL — file watchers and webhook endpoints write to a durable trigger bus, a single-worker dispatcher claims events, and each trigger fires a fresh agent turn keyed by a stable session id. Sandboxed execution (filesystem allow/deny + Docker session backend), state-aware browser observation, and continuous error recovery apply to daemon-fired turns identically to REPL turns. Detailed diagrams + module map in [`docs/v4.5/architecture.md`](./docs/v4.5/architecture.md).

---

## Install + first run

### Linux / WSL / macOS (one-line)

```bash
npm install -g aiden-runtime
aiden            # interactive setup wizard fires on first run
```

### Windows (one-line)

```powershell
npm install -g aiden-runtime
aiden
```

If you hit native-build errors on Windows, install the [windows-build-tools](https://github.com/felixrieseberg/windows-build-tools) prerequisite first.

### Try without installing

```bash
npx aiden-runtime
```

### After pulling updates

```bash
npm install -g aiden-runtime@latest
```

Or, from inside a running session, the slash command:

```
/update install
```

(Aiden also prompts you on boot when a newer version is on npm — see `/update auto off` to silence.)

### Daemon mode (opt-in)

**Linux:** install a systemd `--user` unit.

```bash
export AIDEN_DAEMON=1
aiden daemon install
loginctl enable-linger $USER     # keep running between sessions
```

**macOS:** install a launchd plist.

```bash
export AIDEN_DAEMON=1
aiden daemon install
```

**Windows:** see [`docs/v4.5/daemon-windows.md`](./docs/v4.5/daemon-windows.md). Recommended: foreground (`aiden daemon start`) or `pm2` for background.

---

## Configuration

Aiden reads `~/.aiden/config.yaml` (Linux/macOS) or `%LOCALAPPDATA%\aiden\config.yaml` (Windows). The setup wizard writes a starter config on first boot; subsequent edits are diff-merged.

### Common env vars

| Variable | Default | Effect |
|---|---|---|
| `AIDEN_DAEMON` | `0` | Set to `1` to boot the daemon foundation alongside the REPL |
| `AIDEN_DAEMON_PORT` | `4200` | Daemon HTTP listener port |
| `AIDEN_DAEMON_BIND` | `127.0.0.1` | Loopback-only by default; non-loopback requires `AIDEN_API_KEY` |
| `AIDEN_DAEMON_DAILY_BUDGET` | unset | Hard daily token cap across daemon turns; resets midnight UTC |
| `AIDEN_DAEMON_MODEL` | unset | Override model for daemon turns (`<provider>/<model>`) |
| `AIDEN_SANDBOX` | `1` | `0` to disable filesystem allowlist + Docker session backend |
| `AIDEN_TCE` | `1` | `0` to disable continuous error recovery |
| `AIDEN_BROWSER_DEPTH` | `1` | `0` to disable state-aware browser observation |
| `AIDEN_API_KEY` | unset | Required for non-loopback daemon bind |
| `AIDEN_NO_UPDATE_CHECK` | `0` | Set to `1` to silence the boot-time update probe |

Most flags are also flippable live via slash commands:

| Slash command | Effect |
|---|---|
| `/sandbox on\|off\|status` | Filesystem + execution sandbox |
| `/tce on\|off\|status` | Continuous error recovery |
| `/browser-depth on\|off\|status` | State-aware browser observer |
| `/suggestions on\|off\|status` | Contextual capability hints |
| `/daemon status` | Read-only daemon snapshot (port, triggers, recent runs, daily budget) |
| `/update check\|install\|skip <v>\|auto on\|off` | Update probe + install |
| `/cron add\|list\|show\|run\|remove` | Scheduled jobs |
| `/runs list\|show <id>\|interrupt\|stats` | Daemon run history |

Full reference: [`docs/v4.5/`](./docs/v4.5/).

---

## In-chat slash commands (38 total)

Type `/help` inside Aiden for the full list grouped by category. Highlights:

- **Configuration** — `/model`, `/personality`, `/skin`, `/streaming`, `/reasoning`, `/verbose`, `/debug-prompt`, `/identity`
- **Session** — `/clear`, `/compress`, `/save`, `/title`, `/usage`
- **System** — `/sandbox`, `/tce`, `/browser-depth`, `/daemon`, `/suggestions`, `/update`, `/skills`, `/tools`, `/plugins`, `/cron`, `/runs`, `/trigger`, `/doctor`, `/status`, `/show`, `/history`
- **Auth** — `/auth login`, `/auth status`, `/auth refresh`
- **MCP** — `/reload-mcp`, `/setup`

---

## Troubleshooting

Common issues live in [`docs/v4.5/troubleshooting.md`](./docs/v4.5/troubleshooting.md). Quick reference:

- **"daemon already running"** — stale `~/.aiden/daemon/runtime.lock`; remove it
- **Webhook 401 despite valid HMAC** — check format (`github` / `gitlab` / `generic`)
- **IMAP auth failure** — Gmail / Outlook require app passwords, not account passwords
- **High RSS / slow drain** — run the 72-hour soak (`tests/v4/daemon/soak/README.md`)
- **Boot stuck on wizard** — non-TTY stdin (CI / piped); set provider env var or use `--no-ui`
- **`/help` doesn't list a command** — that command likely needs an active session field; run from a real REPL

---

## Acknowledgements

Built solo by **Shiva Deore** at [Taracod](https://taracod.com).

Aiden builds on the open-source giants: TypeScript, Node, SQLite, better-sqlite3, Playwright, Chromium, chokidar, croner, inquirer, marked, kleur, the Model Context Protocol, and every provider SDK. Thank you.

If you use Aiden in production, on a side project, or just to learn — a star on the repo is appreciated. Bug reports and feature ideas go on the [GitHub issue tracker](https://github.com/taracodlabs/aiden/issues).

---

## License

- **Core runtime**: [AGPL-3.0](./LICENSE).
- **Bundled skills**: [Apache-2.0](./skills/LICENSE). The future `skills.taracod.com` marketplace will ship community skills under the same permissive terms.

AGPL-3.0 means: you can self-host, modify, and distribute Aiden as long as your modifications stay under AGPL. Commercial licensing for closed-source derivatives: contact <hello@taracod.com>.

---

## Links

- Website: [aiden.taracod.com](https://aiden.taracod.com)
- Docs: [`docs/v4.5/`](./docs/v4.5/) (in this repo)
- Discord: [discord.gg/gMZ3hUnQTm](https://discord.gg/gMZ3hUnQTm)
- Source: [github.com/taracodlabs/aiden](https://github.com/taracodlabs/aiden)
- Standalone releases: [github.com/taracodlabs/aiden-releases](https://github.com/taracodlabs/aiden-releases)
- npm: [aiden-runtime](https://www.npmjs.com/package/aiden-runtime)
- Author's book: [_Omega_](https://amzn.to/4tpiXwM)

---

<p align="center">
  <em>Local-first. Windows-native. Yours to own.</em>
</p>
