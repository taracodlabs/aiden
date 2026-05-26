# CLI command reference

Top-level commands you invoke from your shell as `aiden <verb> [args]`.
Slash commands (typed inside the running REPL) live in
[`slash-commands.md`](./slash-commands.md).

Run `aiden --help` for the live commander.js-generated summary; this
page is the durable narrative reference.

---

## Bare invocation — interactive REPL

```bash
aiden
```

No args = boot the REPL. First boot fires the setup wizard. Subsequent
boots restore the last session if you didn't `/quit` cleanly.

### Useful flags on bare invocation

| Flag | What |
|---|---|
| `--no-ui` | Skip the startup card + interactive picker. Useful in CI / piped stdin / non-TTY. |
| `--yolo` | Boot with approval engine = `off`. Equivalent to running `/yolo off` after boot. |
| `--resume <sessionId>` | Resume a specific past session by id. |
| `--model <id>` | Override the boot model (same effect as `AIDEN_MODEL`). |
| `--provider <id>` | Override the boot provider (same effect as `AIDEN_PROVIDER`). |
| `--tui` | Boot the alternate TUI front-end (overlay UI for live observability). |
| `--version` | Print the installed Aiden version + exit. |

---

## `aiden setup`

```bash
aiden setup
```

Re-run the interactive setup wizard. Useful when:

- You've just rotated provider keys and need to re-auth.
- You added a new provider and want Aiden to detect it.
- Your `config.yaml` got corrupted and you want a clean re-bootstrap.

The wizard is non-destructive: existing valid credentials stay; the
wizard only fills in gaps.

---

## `aiden model [spec]`

```bash
aiden model                              # print current
aiden model groq                         # switch to groq's default model
aiden model anthropic claude-sonnet-4-5  # switch to a specific model
```

Persists the choice to `config.yaml`. Equivalent to running `/model
<spec>` inside the REPL.

---

## `aiden config [action] [key] [value]`

Read or write `config.yaml` values from the command line.

```bash
aiden config get model.provider                # read one key
aiden config set model.provider groq           # write one key
aiden config list                              # dump every key
aiden config edit                              # open in $EDITOR
```

Reads support dotted paths (`runtime_toggles.sandbox`,
`memory.distill_on_quit`, etc.). Writes are atomic (tempfile + rename).

---

## `aiden doctor`

```bash
aiden doctor                             # all checks
aiden doctor --providers                 # provider liveness only
```

Diagnostic probe. Prints pass / fail per check with remediation hints:

- Node version + paths
- Provider liveness (live HTTP probe per configured provider)
- Sandbox config + Docker availability
- Daemon state (installed? running? schema version?)
- MCP servers + plugin permissions
- Required env vars per active provider

Use this first when something feels off — most issues are visible here.

---

## `aiden sessions <action> [arg]`

```bash
aiden sessions list                      # last 20 sessions
aiden sessions list --limit 100          # bigger window
aiden sessions show <sessionId>          # full transcript
aiden sessions search "deploy script"    # FTS across all sessions
aiden sessions delete <sessionId>        # remove (irreversible)
```

Sessions are stored in `~/.aiden/sessions.db`. Each session row carries
title, model, provider, token counts, cost estimate, and the full
message stream.

---

## `aiden skills <action> [arg]`

```bash
aiden skills list                        # bundled + user skills
aiden skills view <name>                 # print SKILL.md contents
```

Other sub-actions (`install`, `audit`, `publish`, `snapshot`,
`update`, `uninstall`, `reset`, `search`, `browse`, `check`) are
scaffolded but deferred to a future release; running them today
prints a "deferred to v4.1 alongside the gateway" note and exits.

For the candidate-review flow (mined skill candidates from
successful tool sequences), use the slash commands from inside the
REPL: `/skills review`, `/skills view-candidate <id>`,
`/skills accept <id>`, `/skills reject <id>`. See
[`../features/skills.md`](../features/skills.md) § Skill mining.

---

## `aiden trigger <action> [args...]`

Daemon-mode triggers — file watchers, webhooks, IMAP, cron. Requires
`AIDEN_DAEMON=1` + `aiden daemon install`.

```bash
aiden trigger list
aiden trigger add <kind> [flags...]      # file | webhook | email | cron
aiden trigger show <id>
aiden trigger pause <id>
aiden trigger resume <id>
aiden trigger remove <id>
aiden trigger logs <id> --limit 50
aiden trigger replay <event-id>          # re-fire a dead-lettered event
```

Full reference: [`../features/daemon-mode.md`](../features/daemon-mode.md)
§ "Trigger sources".

---

## `aiden daemon <action> [args...]`

Manage the background dispatcher.

```bash
aiden daemon install                     # platform-specific install (systemd/launchd/Task Scheduler)
aiden daemon uninstall                   # remove cleanly; data preserved
aiden daemon status                      # running? uptime? trigger count?
aiden daemon stop                        # graceful drain + exit
aiden daemon restart                     # stop + start
aiden daemon logs --limit 100            # tail the daemon log
```

See [`../features/daemon-mode.md`](../features/daemon-mode.md) for the
platform-specific install walkthrough.

---

## `aiden cron <action> [args...]`

Scheduled-job management. Same surface as `/cron` inside the REPL.

```bash
aiden cron add --label daily-summary --schedule "0 9 * * *" --prompt-template "..."
aiden cron list
aiden cron show <id>
aiden cron remove <id>
aiden cron pause <id>
aiden cron resume <id>
aiden cron run <id>                      # one-shot fire NOW
aiden cron logs <id> --limit 50
```

### Schedule formats

- Standard cron: `"0 9 * * *"` (9am every day)
- Shorthand: `"every 5m"`, `"every 1h"`
- One-shot ISO timestamp: `"2026-06-01T09:00:00Z"`

---

## `aiden runs <action> [args...]`

Browse daemon + REPL agent-turn history.

```bash
aiden runs list                          # last 50, top-level only by default
aiden runs list --include-children       # include sub-agent rows inline
aiden runs list --status failed          # filter by status
aiden runs list --source file            # filter by trigger source
aiden runs list --trigger "trigger:webhook:gh-pr:"   # by session prefix
aiden runs list --limit 200              # bigger window

aiden runs show <runId>                  # full run row + events stream
aiden runs interrupt <runId>             # cancel an in-flight run
aiden runs stats                         # status counts + duration aggregates
```

`runs list` hides sub-agent children by default and shows a
`(N children, M OK)` badge next to parents that spawned any.

See [`../features/sub-agents.md`](../features/sub-agents.md) for the
spawn lineage flow.

---

## `aiden mcp <action>`

Model Context Protocol server mode. Used by Claude Desktop, Cursor,
Claude Code, and other MCP clients.

```bash
aiden mcp serve                          # spawn the stdio MCP server
aiden mcp status                         # current build + tool count
aiden mcp tools                          # list every tool the server exposes
```

`aiden mcp serve` blocks on stdio. Configure your MCP client to spawn
it with an explicit `env:` block — MCP clients spawn with an empty
environment, so provider keys must be passed through.

---

## `aiden voice [args...]`

Voice TTS / STT controls. Same surface as `/voice` inside the REPL.

```bash
aiden voice status
aiden voice on
aiden voice off
aiden voice test "hello world"           # speak a test phrase
```

Engines: Edge TTS (cross-platform) + Windows SAPI (Windows-only
fallback).

---

## `aiden subagent <action>`

Sub-agent diagnostics from the shell. Read-only — does not spawn,
pause, or resume.

```bash
aiden subagent status                              # recent spawn lineage + counts
aiden subagent tools                               # tools available to sub-agents
```

To **pause** sub-agent spawning, use the `/spawn-pause` slash command
from inside the REPL (see [`../features/sub-agents.md`](../features/sub-agents.md)
§ "Operator kill-switch"). To **spawn** from the shell, use
`aiden fanout` (below) or pipe a prompt into `aiden` non-
interactively.

---

## `aiden fanout [args...]`

Direct fanout invocation from the shell.

```bash
aiden fanout "compare SQLite vs Postgres for analytics" --n 3 --merge combine
aiden fanout "...query..." --mode partition --tasks "goal1" "goal2" "goal3"
aiden fanout "..." --dry-run             # offline, stub adapters, exercises plumbing
```

| Flag | What |
|---|---|
| `--n <N>` | Number of children. 1-5. Default 3. |
| `--mode <m>` | `ensemble` (same query everyone) or `partition` (per-child goals). Default `ensemble`. |
| `--merge <s>` | `all` / `vote` / `pick-best` / `combine`. Default `combine`. |
| `--timeout-ms <ms>` | Per-child timeout. Default 90,000. |
| `--dry-run` | Synthetic in-process stubs; no provider calls. CI-friendly smoke test. |

Real fanout from the shell: needs at least one provider configured.
Dry-run: no providers needed.

See [`../features/sub-agents.md`](../features/sub-agents.md) for ensemble
vs partition semantics.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Generic runtime failure (provider call failed, command not found, etc.). |
| `2` | Usage error (bad flag, missing required arg). |
| `75` | Daemon clean restart signal — the dispatcher uses this to recycle after a SIGUSR1. Treated as recoverable by service managers. |

---

## Output formatting

Most read-style commands (`sessions show`, `runs show`, `cron list`)
print human-readable text by default. Pipe to `jq` when you want JSON:

```bash
aiden runs show 42 --json | jq .events
```

The `--json` flag is supported on `runs show`, `runs stats`,
`sessions show`, `trigger show`, `cron show`. Where it's not, the
command writes only plain text — pipe to `awk` or similar for
machine parsing.

---

## See also

- [`slash-commands.md`](./slash-commands.md) — the 41 slash commands available inside the REPL
- [`env-vars.md`](./env-vars.md) — environment variables that affect CLI behavior
- [`providers.md`](./providers.md) — provider IDs accepted by `--provider` / `aiden model`
- [`../features/daemon-mode.md`](../features/daemon-mode.md) — `aiden trigger` / `aiden daemon` / `aiden cron` deep-dive
- [`../features/sub-agents.md`](../features/sub-agents.md) — `aiden subagent` / `aiden fanout` deep-dive

---

## What this isn't

- **Not the slash command list.** Those live in
  [`slash-commands.md`](./slash-commands.md) and only work inside a
  running REPL.
- **Not the plugin developer reference.** Custom plugins extend
  the agent loop, not the CLI surface.
- **Not stable across major versions.** Flags can change between
  major versions; pin to the version you ship with.
