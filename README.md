```
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝

Autonomous AI Operating System

89+ Tools • 14+ Providers • AGPL-3.0

Windows • Linux • WSL • macOS (API Mode)

Self-Healing • Browser Automation • Terminal Control • Persistent Memory
```

<p align="center">
  <a href="https://github.com/taracodlabs/aiden-releases/releases/latest"><img src="https://img.shields.io/github/v/release/taracodlabs/aiden-releases?color=f97316&label=version" alt="Latest version" /></a>
  <a href="https://github.com/taracodlabs/aiden-releases/releases"><img src="https://img.shields.io/github/downloads/taracodlabs/aiden-releases/total?color=f97316&label=downloads" alt="Downloads" /></a>
  <a href="https://discord.gg/gMZ3hUnQTm"><img src="https://img.shields.io/badge/chat-discord-7289da?logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-orange" alt="License: AGPL-3.0" /></a>
  <a href="https://github.com/taracodlabs/aiden/stargazers"><img src="https://img.shields.io/github/stars/taracodlabs/aiden?style=flat&color=f9d71c" alt="Stars" /></a>
  <a href="https://www.npmjs.com/package/aiden-os"><img src="https://img.shields.io/npm/v/aiden-os?color=f97316&label=npm" alt="npm" /></a>
</p>

<p align="center">
  <a href="https://aiden.taracod.com"><b>Website</b></a> &nbsp;·&nbsp;
  <a href="https://aiden.taracod.com/contact"><b>Contact</b></a> &nbsp;·&nbsp;
  <a href="https://discord.gg/gMZ3hUnQTm"><b>Discord</b></a> &nbsp;·&nbsp;
  <a href="https://github.com/taracodlabs/aiden-releases/releases/latest"><b>Download</b></a>
</p>

---

> **v3.19.0 "ALIVE" — identity refreshes every turn · real-time state via tools · honest failure diagnostics · plugin slash commands**
> Type `/` for 91 commands or `@` for 89 tools with instant dropdown. SOUL/USER/GOALS refresh every turn (not every 40 messages). Tool failures name the provider, retries, and fallback. Plugins extend slash commands via `commandCatalog.register()`. See [changelog](#changelog) below.

---

## Support Aiden

Solo-built, AGPL-3.0. If Aiden saves you time, consider sponsoring development.

[Sponsor →](https://razorpay.me/@whitelotus9625)

Funds go to ongoing development, infrastructure costs, and contributor bounties.

---

## Why Aiden

Most AI agents answer questions. Aiden executes work.

- **Runs on your machine** — local-first, no telemetry, no cloud required
- **Controls your desktop** — vision loop, mouse, keyboard, window management
- **Automates any browser** — navigate, click, extract via playwright-cli
- **Learns from every session** — writes skills from successes, lessons from failures
- **Works fully offline** — Ollama support, zero cloud dependency
- **One command to start** — `npx aiden-os` installs, configures, runs everything
- **Lives where you do** — identity (SOUL/USER/GOALS) refreshes every turn, not every 40 messages; edit `USER.md` mid-conversation and the change lands within one reply
- **Real-time state via tools** — `now_playing` and friends query live system state instead of returning stale snapshots cached at startup
- **Honest failures** — every tool failure names the tool, provider, retry count, fallback chain, error, and next step; no silent swallowing
- **Plugin extension** — drop a `.js` file into `workspace/plugins/` and call `ctx.commandCatalog.register('/mycommand', …)` to add slash commands without touching core

---

Aiden is a local-first AI operating system. It runs entirely on
your machine — no cloud account required, no telemetry, no data leaving your
hardware unless you configure a cloud provider. It ships with a signed Windows
installer, and runs in headless API mode on Linux, WSL, and macOS. Features:
1,400+ composable skills, 80+ built-in tools, a 6-layer memory architecture,
self-healing provider routing, and the ability to control your screen, browse
the web, run code, send emails, manage files, and hold a full conversation —
offline via Ollama.

## Platform support

| Platform | GUI app | API + CLI | Skills available |
|---|---|---|---|
| **Windows 10/11** | ✅ signed installer | ✅ | All 1,400+ (including Windows-only skills) |
| **Linux** | — | ✅ headless | ~1380 (Windows-only skills auto-skipped) |
| **WSL 2** | — | ✅ headless | ~1380 (Windows-only skills auto-skipped) |
| **macOS** | — | ✅ headless | ~1380 (Windows-only skills auto-skipped) |

Windows-only skills (clipboard history, Defender, OneNote, Outlook COM, registry, etc.) are tagged `platform: windows` and are silently skipped on other platforms at load time.

## Quick Start

### Fastest — `npx` (no install needed)

```bash
npx aiden-os
```

That's it. Node.js 18+ is the only prerequisite. On first run it asks which AI provider you want (Groq is free), validates your key, saves config to `~/.aiden/app/`, and starts both the server and CLI together in one terminal. Subsequent runs skip the wizard and go straight to the assistant.

Or install globally for the `aiden` command:

```bash
npm install -g aiden-os
aiden
```

### Prerequisites (for installer / manual builds)
- Node.js 18+
- Git
- Ollama (optional, for offline mode): [ollama.ai](https://ollama.ai)

### Windows — signed installer

```powershell
irm aiden.taracod.com/install.ps1 | iex
```

Or [download the signed installer](https://github.com/taracodlabs/aiden-releases/releases/latest) manually. Windows 10/11, 64-bit, ~500 MB disk space.

### Linux / WSL / macOS — one-line install

```bash
curl -fsSL aiden.taracod.com/install.sh | bash
```

### Manual install (all platforms)

```bash
git clone https://github.com/taracodlabs/aiden.git
cd aiden
npm install
cp .env.example .env
# Edit .env — add at minimum one API key (Groq is free: console.groq.com)
```

### Run (manual install)

```bash
# Terminal 1 — build and start server
npm run build
npm start

# Terminal 2 — start CLI
npm run cli
```

### After pulling updates (manual install)

```bash
git pull
npm run build
npm start
```

### Uninstall

**Windows**
Open *Settings → Apps* (or *Control Panel → Programs*) and uninstall **Aiden**.
To also remove user data:
```powershell
Remove-Item -Recurse -Force "$env:APPDATA\aiden"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\aiden"
```

**Linux / macOS / WSL**
```bash
curl -fsSL aiden.taracod.com/uninstall.sh | bash
```
Or manually:
```bash
rm -rf ~/.local/share/aiden ~/.config/aiden
npm uninstall -g devos-ai   # if installed via npm
```

### Minimum .env to get started

```
GROQ_API_KEY=your_key_here   # free at console.groq.com/keys
```

Set `AIDEN_HEADLESS=true` to suppress the Electron GUI when running the packaged app.

---

## Known Limitations (v4.0.0)

We're shipping honest. Things that work, things that don't:

**Tested and working:**

- Windows 10/11 native (primary platform, full QA)
- Linux via WSL2 (cross-platform paths verified)
- Together AI (default provider, fast)
- ChatGPT Plus OAuth (verified end-to-end with Codex backend)

**Untested at launch:**

- macOS native — best-effort, may need user reports
- Linux distributions beyond Ubuntu (Snap/Flatpak Chrome detection)
- Claude Pro OAuth — routing layer fixed, upstream untested

**Beta features:**

- OAuth providers — provider-side gates may apply, use API keys as fallback
- Auto-update — notifies on outdated version, doesn't auto-install

**Coming in v4.1:**

- Cron + scheduled tasks
- Messaging gateway (Telegram, Discord, Slack)
- Voice mode
- Subagent delegation
- ACP integration (VSCode, Zed, JetBrains)
- 18+ items in [v4.1-roadmap.md](docs/v4.1-roadmap.md)

Found a bug? Report at https://github.com/taracodlabs/Aiden-v4/issues with output of `aiden doctor` for fast triage.

---

## Getting Started

Once Aiden is running, type these in the chat prompt:

| First thing to do | What to type |
|---|---|
| See all available commands | `/help` |
| Check which AI provider is active | `/switch` |
| See your daily token budget | `/budget` |
| Browse available skills | `/skills` |
| Install a skill from the registry | `/install <skill-name>` |
| Open the web UI in a browser | navigate to `localhost:4200/ui` |
| Check model availability | `/models` |

**Ask anything in plain English** — no special syntax needed for regular tasks:

```
summarize the PDF on my desktop
open chrome and search for latest AI news
close spotify
take a screenshot and describe what you see
what files did I download today
```

Type `/` to browse all 91 commands with instant search. Type `@` to select any of 89 tools directly.

---

## Troubleshooting

**"Cannot find module" or TypeScript errors**
```bash
npm run build   # always rebuild after git pull
```

**"npm run serve" not found**
There is no `serve` script. Use `npm start` instead.

**Server not responding**
```bash
# Check if server is running on port 4200
netstat -ano | findstr :4200   # Windows
lsof -i :4200                  # Linux/macOS
```

**Ollama not connecting**
```bash
ollama serve             # make sure Ollama is running
ollama pull qwen2.5:7b   # pull your chosen model
```

**Changing Ollama model or inference settings** (no recompile needed — edit `.env`):
```
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_TEMPERATURE=0.3
OLLAMA_CONTEXT_LENGTH=4096
OLLAMA_NUM_GPU=99
```

**Use with any OpenAI client (Open WebUI, Chatbox, Cursor, etc.)**
```
Base URL:  http://localhost:4200
API Key:   none required
Model:     aiden-3.13
```

## Screenshots

### Terminal (TUI)

![TUI](docs/images/tui.png)

Full command palette, 1,400+ skills, 89+ tools, automatic provider routing (Groq → OpenRouter → Ollama). Runs in any terminal.

### Desktop app

![Desktop](docs/images/dashboard.png)

Full chat interface with live activity panel. Local-first, connects to Ollama or any of 15+ cloud providers via your own API key.

### Memory graph

![Memory graph](docs/images/memory-graph.png)

6-layer memory visualized — every conversation, task, and learned pattern becomes a node in the knowledge graph. Fully local, persisted to disk, searchable.

---

## Features

| Category | What Aiden does |
|---|---|
| **Inference & providers** | Local Ollama (Llama 3, Mistral, Qwen, Gemma, Phi…) with optional cloud fallback to OpenAI, Anthropic, Groq, Cerebras, NVIDIA NIM, OpenRouter, and more — 15+ providers including custom OpenAI-compatible endpoints |
| **80+ tools** | Web search, file read/write, shell execution, Playwright browser automation (`open_browser`, `browser_click`, `browser_type`, `browser_extract`, `browser_get_url`), screen capture & OCR, calendar, email (IMAP/SMTP), code execution sandbox, clipboard, LocalSend LAN transfer, system info |
| **1,400+ skills** | Composable plugins each with a `SKILL.md` prompt, tool implementations, and optional sandbox runner — install per-session or globally. Includes: LocalSend (AirDrop-style LAN transfer), Decepticon security scanner (opt-in), and more |
| **Subagent swarm** | Spawn N parallel agents on any task; vote, merge, or pick the best result automatically |
| **6-layer memory** | Episodic (in-context), BM25 keyword, vector semantic, procedural (skill), goal tracking, and `LESSONS.md` permanent-failure moat that grows every session |
| **Voice** | Speech-to-text (Groq → OpenAI → local Whisper.cpp) + text-to-speech (Edge TTS → ElevenLabs → Windows SAPI); full offline voice loop |
| **Channel adapters** | Discord, Slack, Telegram, WhatsApp, Email, Webhook, Twilio — any channel triggers the same agent loop |
| **Computer use** | Screenshots, screen state reader, GUI automation via keyboard/mouse when asked — full OS control mode |

---

## What Aiden is

Aiden runs locally on your machine. It controls your desktop, browser, and terminal through natural conversation. It learns from your work and remembers what matters across sessions.

- **Local-first** — your conversations and data stay on your machine. No cloud account required.
- **Real desktop control** — vision, mouse, keyboard, browser, terminal, files. Not a chatbot wrapped in a sandbox.
- **Persistent memory** — Aiden remembers facts, preferences, and lessons from prior sessions. The longer you use it, the better it knows your work.
- **Honest by design** — when a tool fails, Aiden surfaces the failure rather than fabricating success.
- **Open source** — AGPL-3.0. Read every line, modify anything, contribute back.

---

## Architecture

```
User input (any channel)
        │
        ▼
  ┌─────────────┐
  │  Planner    │  ← breaks task into steps
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐     ┌──────────────────┐
  │  Agent loop │────▶│  Tool dispatcher │──▶ 80+ tools
  │  agentLoop  │     └──────────────────┘
  └──────┬──────┘
         │
         ▼
  ┌─────────────────────────────────┐
  │  Memory (6 layers)              │
  │  episodic · BM25 · vector ·     │
  │  procedural · goal · LESSONS.md │
  └─────────────────────────────────┘
         │
         ▼
  ┌─────────────┐
  │  Provider   │  ← self-healing chain, 15+ providers
  │  router     │
  └─────────────┘
         │
         ▼
     Response (streamed to originating channel)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full layer-by-layer breakdown, data flow diagrams, and the skill system design.

---

## Configuration

Copy `.env.example` to `.env` in the Aiden data directory.

```bash
cp .env.example .env
```

Key environment variables:

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Override if Ollama runs on a different host/port |
| `OLLAMA_MODEL` | `mistral-nemo:12b` | Default chat model |
| `ANTHROPIC_API_KEY` | — | Optional cloud fallback |
| `OPENAI_API_KEY` | — | Optional cloud fallback |
| `GROQ_API_KEY` | — | Free tier: fast Llama 3 inference |
| `DAILY_BUDGET_USD` | `5.00` | Hard cap on daily cloud API spend |

See `.env.example` for the full list of ~90 variables covering voice, messaging integrations, search, computer use, and more.

---

## Use with any OpenAI client

Aiden exposes an OpenAI-compatible API at `localhost:4200`. Point any OpenAI client at Aiden to get the full 89-tool agent instead of raw GPT:

| Setting | Value |
|---|---|
| **Base URL** | `http://localhost:4200` |
| **API Key** | *(none required locally)* |
| **Model** | `aiden-3.13` |

Works with: **Open WebUI** · **LibreChat** · **Chatbox** · **Continue.dev** · **Cursor** · **TypingMind** · any app using the OpenAI SDK.

```python
# Python example — zero config
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4200", api_key="none")
response = client.chat.completions.create(
    model="aiden-3.13",
    messages=[{"role": "user", "content": "search news about AI agents"}]
)
print(response.choices[0].message.content)
```

Optional: set `AIDEN_API_KEY=your-secret` in `.env` to require Bearer token authentication.

---

## Security & Sandbox

Aiden includes an opt-in Docker sandbox backend that runs `shell_exec` and `run_python` tool calls inside isolated containers instead of directly on the host.

### Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/macOS) or Docker Engine (Linux)

### Modes

| `AIDEN_SANDBOX_MODE` | Behaviour |
|---|---|
| `off` *(default)* | Tools run on the host — no Docker required |
| `auto` | Try Docker first; silently fall back to host if Docker is unavailable |
| `strict` | Require Docker — error if Docker is not available |

### Enable

```bash
# In .env
AIDEN_SANDBOX_MODE=auto
```

Or toggle live from the Aiden CLI without restarting:

```
/sandbox auto     # switch to auto mode
/sandbox strict   # require Docker
/sandbox off      # disable
/sandbox status   # show current mode + Docker availability
/sandbox build    # pre-build the container image
```

### What the container provides

- `--network=none` — no outbound network access (configurable per-call)
- `--memory=512m --cpus=1` — hard resource caps
- `--read-only --tmpfs /tmp` — immutable FS, only `/tmp` is writable
- `--rm` — container removed immediately after each tool call
- Host `workspace/` bind-mounted at `/workspace` so results are accessible

---

## Commands

### Start Aiden
| Command | Description |
|---------|-------------|
| `npx aiden-os` | Install, configure, and start (recommended) |
| `npm start` | Start API server (port 4200) |
| `npm run cli` | Start TUI (connect to running server) |
| `npm run build` | Rebuild after source changes |
| `aiden --reconfigure` | Re-run setup wizard, change providers |

### In-chat commands
| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/switch <provider>` | Change primary provider live |
| `/budget` | Show daily token spend + remaining |
| `/budget set <n>` | Set daily limit in USD |
| `/memory` | View distilled facts and memory stats |
| `/memory search <q>` | Search remembered facts |
| `/profile` | View structured user profile |
| `/failed [reason]` | Teach Aiden from a wrong answer |
| `/skills` | List loaded skills |
| `/install <skill>` | Install from community registry |
| `/publish <skill>` | Publish skill to registry |
| `/skills validate <n>` | Validate agentskills.io compliance |
| `/sandbox status` | Docker sandbox mode |
| `/sandbox auto` | Enable sandboxed shell/python |
| `/permissions` | View permission mode |
| `/permissions ask` | Require approval for destructive ops |
| `/permissions allow` | Allow all operations silently |
| `/retry` | Retry last query |
| `/exit` | Save memory and exit |

---

## CLI vs Dashboard Quick Reference

Both the terminal TUI and the browser dashboard (`localhost:4200/ui`) expose the full feature set. Use whichever fits your workflow.

| Feature | Terminal CLI | Browser (`localhost:4200/ui`) |
|---|---|---|
| Chat | ✅ inline prompt | ✅ chat panel |
| Streaming responses | ✅ token-by-token | ✅ live SSE |
| Markdown rendering | ✅ | ✅ |
| Slash commands | ✅ `/help`, `/switch`, `/budget`… | ✅ same commands |
| `/` command dropdown | ✅ instant, 91 commands | ✅ |
| `@` tool picker | ✅ instant, 89 tools | ✅ |
| Provider panel | `/switch` | ✅ Providers tab |
| Memory panel | `/memory` | ✅ Memory tab |
| Skills panel | `/skills` | ✅ Skills tab |
| Plugin hooks | ✅ | ✅ |
| MCP server mode | `aiden mcp` | — |
| OpenAI-compatible API | — | ✅ `localhost:4200/v1` |

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

**Quickstart:**

```bash
git clone https://github.com/taracodlabs/aiden.git
cd aiden
npm install
cp .env.example .env   # add at minimum one API key (Groq is free: console.groq.com/keys)
npm run build
npm start              # server on :4200
npm run cli            # TUI in a second terminal
```

- Bug fixes and new skills are the easiest entry points
- All contributors sign the [CLA](.github/CLA.md) once via PR comment
- Follow [Conventional Commits](https://www.conventionalcommits.org/)
- Run `npx tsc --noEmit` before opening a PR

---

## Community

| | |
|---|---|
| **Discord** | [discord.gg/gMZ3hUnQTm](https://discord.gg/gMZ3hUnQTm) — chat, support, share what you build |
| **Skills registry** | [agentskills.io](https://agentskills.io) — 1,500+ community skills |
| **Bug reports & features** | [github.com/taracodlabs/aiden/issues](https://github.com/taracodlabs/aiden/issues) |
| **Star the repo** | [github.com/taracodlabs/aiden](https://github.com/taracodlabs/aiden) ⭐ |
| **npm** | [`npm install -g aiden-os`](https://www.npmjs.com/package/aiden-os) |
| **Sponsor** | [github.com/sponsors/taracodlabs](https://github.com/sponsors/taracodlabs) |

---

## Documentation

| Document | Description |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layer-by-layer breakdown, data flow diagrams, skill system design |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute — skills, tools, providers, docs |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Planned features and milestone tracker |
| [docs/mcp/](docs/mcp/) | MCP server setup — Claude Code, Cursor, VS Code integration |
| [.env.example](.env.example) | All ~90 environment variables with descriptions |
| [workspace-templates/](workspace-templates/) | Starter workspace configs and example plugins |
| **Download installer** | [github.com/taracodlabs/aiden-releases/releases/latest](https://github.com/taracodlabs/aiden-releases/releases/latest) |
| **Releases & changelog** | [github.com/taracodlabs/aiden-releases](https://github.com/taracodlabs/aiden-releases) |
| **License** | AGPL-3.0 core · Apache-2.0 skills |

---

## Migration from Other Agents

> Short version (no breaking changes in v3.18 or v3.19 — existing plugins and `.env` files continue to work):

- **Skills** — Aiden is fully compatible with [agentskills.io](https://agentskills.io). Any skill with a valid `skill.json` manifest loads automatically via `/install <name>`.
- **API clients** — Aiden exposes an OpenAI-compatible API at `localhost:4200/v1`. If you pointed your client at another agent, update the base URL and you're done.
- **Config / env** — Most standard keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, etc.) are recognized as-is. Copy your existing `.env` and Aiden picks them up on first start.

---

## Changelog

### v3.19.0 — 2026-05-01 "ALIVE"

**Source-of-truth tool registry**
- 13 hand-maintained tool lists collapsed into a single `TOOL_REGISTRY`; every derived list is generated, not maintained
- Validator throws on drift at startup — no more silent orphan tools
- 12 previously-unreachable tools now reachable by the planner (`fetch_url`, `cmd`, `ps`, `wsl`, `git_status`, `manage_goals`, `get_calendar`, `read_email`, `send_email`, `ingest_youtube`, `schedule_reminder`, `compact_context`)

**Per-turn protected context refresh**
- SOUL / USER / GOALS / STANDING_ORDERS / LESSONS refresh every turn instead of every 40 messages
- Hash-based file-level cache — 24× token reduction on stable turns (3,860 → 159 tokens)
- Edit `USER.md` mid-conversation; Aiden picks up changes within one reply

**Honesty enforcement**
- 5 fake InstantActions removed (`screenshot`, `volume_up/down/mute`, `lock_screen`) — now route to real handlers, surface real errors
- Action-verb planner guard: prevents respond-only plans for action intents
- Diagnostic failure messages: every failure names tool, provider, retries, fallback, error, suggestion
- Hidden bug fixed: `fastPath` was bypassing the planner for short action messages

**Real-time state via tools**
- `now_playing` tool: live media query via Windows `WinRT GlobalSystemMediaTransportControlsSessionManager`
- Volatile startup state dump removed from system prompt
- SOUL.md lazy-state rule: model calls tools for current state instead of using cached values

**Registry-backed slash completer**
- `commandCatalog` is the single source of truth for slash commands (91 total)
- 6 previously-invisible commands now in dropdown (`/plugins`, `/profile`, `/failed`, `/install`, `/publish`, `/sandbox`)
- Plugin contribution path live: plugins call `commandCatalog.register()` to add commands
- Generation-cached dropdown: rebuild only when catalog changes

**Provider chain expansion**
- NVIDIA NIM promoted from executor-only to chat slots (`nvidia-1`, `nvidia-2`)
- Chain order: `groq → gemini → nvidia → openrouter → together → ollama`

---

### v3.18.0 — 2026-04-30

**Live dropdown UX**
- Type `/` for instant command dropdown (63 commands)
- Type `@` for tool dropdown (61 tools)
- Prefix-match filter, arrow nav, Tab to select, Esc to close

**Real PC control**
- `close chrome` / `spotify` / `notepad` → actually closes via taskkill
- `increase/decrease volume by N` → actually changes
- `mute/unmute` → actually toggles
- 30+ app name → exe map
- `system_volume` detects intent from any natural input

**YouTube auto-plays**
- `play X on youtube` → opens browser, auto-clicks first result
- Bypasses fast-path that was blocking it

**Anti-confabulation rules**
- SOUL.md updated: never claim actions completed without tool calls
- InstantAction shortcuts that faked actions removed
- Honest fallback messages when providers fail

**Smart provider failover**
- 3-strike rule: provider disabled for 15 min after 3 rate limits
- Permanent disable on 401/403 (invalid key)
- All cloud failed → automatic Ollama fallback

**Smart model selection**
- Free tier defaults per provider (Llama 70B free, Gemini 2.5 Flash, etc.)
- Per-model failover within provider before marking provider rate-limited
- Override with `PROVIDER_MODEL` env var
- `/models` command shows per-provider table with FREE/PAID badges

**Server logs no longer leak into chat**
- `console.log` redirected to stderr
- CLI output is clean even with both in same terminal

**Skill loader fix**
- 1,484 skills now load (was blocking 1,445 due to overly broad patterns)

---

### v3.17.0 — 2026-04-28

**Local web dashboard**
- Browser UI at localhost:4200/ui — no terminal needed
- Chat, Providers, Memory, Skills panels
- Live SSE streaming, markdown rendering

**Plugin system**
- Drop workspace/plugins/<name>.js → auto-loads
- preTool/postTool hooks, custom tool registration
- Session lifecycle hooks (onSessionStart/onSessionEnd)
- Hot-reload with /plugins reload
- Examples: audit-log.js, hello-tool.js

**MCP server mode**
- Expose Aiden's tools to Claude Code, Cursor, VS Code
- Run: node dist-bundle/cli.js mcp
- 28 safe tools exposed by default
- MCP_ALLOW_DESTRUCTIVE=true for full tool access
- Config examples in docs/mcp/

**Bug fixes**
- Dashboard chat showed "(no response)" for every message — SSE event field names in the browser client (`ev.type`) didn't match the server's wire format (`ev.token`, `ev.done`, `ev.tool`). All event handlers rewritten to match actual shapes.
- SOUL.md provider honesty: removed stale BayOfAssets reference, added explicit rule against claiming Ollama when running on Groq/OpenRouter.

---

### v3.16.0 — 2026-04-28

**One-command install**
- `npx aiden-os` — zero-install launcher; works on Windows, macOS, Linux (Node.js 18+)
- `aiden-os` npm package bootstraps `aiden-runtime` automatically, no git clone needed
- Setup wizard on first run with `--reconfigure` flag to re-run anytime

**Security**
- Shell blocklist — dangerous commands flagged before execution
- Permission mode — explicit user approval gate for destructive actions
- Token budget enforcement — per-request ceiling to prevent runaway loops

**Memory**
- Conflict resolution — contradictory memories detected and reconciled automatically
- `/memory` command — inspect, edit, and prune the memory store from the CLI

**UX**
- Aiden branded banner replaces DevOS; orange `#FF6B35` identity throughout CLI
- `--reconfigure` flag to re-run first-time setup without reinstalling

---

### v3.15.0 — 2026-04-28

**Browser & Automation**
- Centralised Playwright session (`core/playwrightBridge.ts`) — single persistent Chromium context shared across all browser tools, idle auto-close after 5 min, clean shutdown on SIGINT/SIGTERM
- `browser_get_url` — new tool to read the URL currently loaded in the browser
- All browser tools now in `ALLOWED_TOOLS` and `NO_RETRY_TOOLS`; `send_file_local` / `receive_file_local` added to planner allow-list

**Community & OSS**
- `CONTRIBUTING.md`, issue templates (bug, feature, skill submission), CLA workflow
- Public roadmap (`docs/ROADMAP.md`), architecture docs (`docs/ARCHITECTURE.md`), skill development guide
- GitHub labels automated + 5 good-first-issues pinned

**New skills**
- **LocalSend** — AirDrop-style LAN file transfer (`send_file_local` / `receive_file_local`); works over WiFi with no cloud
- **Security scanner** — opt-in Decepticon integration with safety guards for scanning your own servers

**Security**
- 9 npm audit vulnerabilities resolved (safe + vitest chain)
- Security headers + rate limiting on `aiden.taracod.com` landing worker (CSP, HSTS, X-Frame-Options)

---

### v3.14.0 — 2026-04-27

**Ecosystem & Interoperability**
- OpenAI-compatible API — `/v1/chat/completions` + `/v1/models`. Point Open WebUI, LibreChat, Cursor, or any OpenAI SDK at `localhost:4200` and get Aiden's full 89-tool agent (not just raw LLM inference)
- agentskills.io compatibility — skills now ship with `skill.json` manifest. Compatible with the agentskills.io specification. 1,515 existing skills backfilled automatically
- Streaming tool output — shell commands, Python scripts, and browser extraction stream live progress lines as they execute. Set `AIDEN_SHOW_TOOL_OUTPUT=false` to suppress

---

### v3.13.0 — 2026-04-27

**Community & Intelligence**
- Public skill registry — `/install <skill>` pulls from [skills.taracod.com](https://skills.taracod.com); browse with `/skills registry <query>`; publish with `/publish <skill>`
- Deep GEPA — learns from failures, not just successes; `/failed` analyzes the exchange trace, writes a permanent lesson to `LESSONS.md`, degrades responsible skill confidence; skills failing 3× are auto-deprecated
- Honcho user modeling — structured cross-session profile (identity, projects, goals, preferences); only the relevant slice injected per query; view and edit with `/profile`
- Docker sandbox — opt-in sandboxed `shell_exec` and `run_python` execution; `AIDEN_SANDBOX_MODE=auto|strict|off`; containers run `--network=none --memory=512m --cpus=1 --read-only`
- GitHub CI/CD — TypeScript type-check + full build + secret scan on every PR to main
- CODEOWNERS — sensitive files auto-request maintainer review on every PR
- Sponsor button — Razorpay + GitHub Sponsors

---

### v3.12.0 — 2026-04-26

**Memory & Agents**
- Post-task skill writer (GEPA-lite) — writes a new skill after every multi-step success
- Session-end memory distillation — 5–15 durable facts extracted per session
- Progressive token budget — tool names only; schema loaded on demand
- Real parallel subagents — isolated context, LLM synthesis pass
- Streaming verbs — "Pondering…", "Hunting…" in real time
- Real scheduler — `remind me in N minutes` actually waits
- Path C-lite — YouTube/Google/DDG/Bing search + click first result
- Electron auto-updater
- Identity honesty — transparent about inference provider
- Capacity fallback — auto-switches provider on 503/rate-limit

---

### v3.11.0 — 2026-04-25

**Custom provider routing**
- Full support for custom OpenAI-compatible endpoints via `customProviders` in `devos.config.json` — add any endpoint with a `baseUrl`, `apiKey`, and `model`; no code changes required
- Fixed silent Groq fallback bug in `callLLM`: custom providers now correctly route to their configured `baseUrl` instead of falling back to the Groq URL
- Fixed `raceProviders` pin-first logic: `primaryProvider` is now resolved from `customProviders` list when not found in `providers.apis`
- Fixed health/status endpoint (`/api/providers`) to include custom providers in the returned list, tier-sorted

**BayOfAssets Claude Haiku 4.5 as default primary**
- Swapped default primary provider to BayOfAssets Claude Haiku 4.5 (`claude-haiku-4-5`) at tier 1
- Groq and Gemini remain as tier-2 fallback chain

**Memory & greeting**
- Fixed `buildGreetingPreamble` double-label bug: `"Active goals: Active goals:\n..."` → compact single-line goal titles
- Added empty-string guard on greeting reply: blank preamble no longer produces `"Currently tracking: . What do you need?"`

---

### v3.10.0 — 2026-04-09

See [releases page](https://github.com/taracodlabs/aiden-releases/releases) for older changelogs.

---

## Sponsors

Aiden is built and maintained by one person.
If it saves you time, consider sponsoring:

[![Sponsor on GitHub](https://img.shields.io/badge/sponsor-❤-pink)](https://github.com/sponsors/shivadeore111-design)
[![Donate via Razorpay](https://img.shields.io/badge/donate-Razorpay-blue)](https://razorpay.me/@shivadeore)

---

## License

| Component | License |
|---|---|
| Core (`src/`, `cli/`, `api/`, `core/`, `providers/`, `dashboard-next/`) | [AGPL-3.0-only](LICENSE) |
| Skills (`skills/`) | [Apache-2.0](LICENSE-SKILLS.md) |

## Commercial use

Aiden's core is **AGPL-3.0**. You can self-host, modify, and study it freely. Embedding it in a commercial product or offering it as a hosted service requires either releasing your modifications under AGPL-3.0 or purchasing a commercial license.

Skills in `skills/` are **Apache-2.0** and can be used in commercial products without copyleft obligations.

For commercial licensing and enterprise deployments: **[aiden.taracod.com/contact?type=enterprise](https://aiden.taracod.com/contact?type=enterprise)**

---

Built by [Taracod](https://taracod.com) · Built by Shiva Deore ·  AGPL-3.0
