# Aiden 4.5 — Your AI engine now works while you sleep

> _Banner image placeholder — drop a `docs/v4.5/banner.png` here before publishing._

## What this means

Aiden used to be interactive — you ask, it acts. v4.5 makes Aiden **autonomous**. Register a trigger once, then Aiden wakes up and does real work when files change, webhooks arrive, emails come in, or a cron tick fires. You can sleep, work on other things, gym, dinner. Aiden's still processing.

The daemon runs locally on your machine. Your data never leaves your laptop unless you point Aiden at a hosted provider. Triggers persist across reboots. Failures are recovered automatically.

## Headline features

### 🤖 Daemon mode + 4 trigger sources

File watcher, webhook (HMAC-verified — GitHub, GitLab, generic), email IMAP (with sender allowlist and `noreply@` filter), and a cron scheduler. Each fires real agent turns with per-trigger session isolation, so concurrent triggers don't trample each other's state.

### 🛡️ Execution sandbox

Three risk tiers — `safe`, `caution`, `dangerous`. File operations run against an allowlist. Docker isolation for shell execution. Dry-run support for destructive ops. Per-trigger approval policies mean untrusted ingress (webhooks) defaults to `safe-only`, while local cron jobs can opt up.

### 🌐 Browser depth

Aiden observes page state, retries stale element references automatically, and tracks multi-tab context cleanly. Web tasks recover from the common failure modes — DOM mutations, slow loads, lost selectors — without bailing on the turn.

### ♻️ Continuous error recovery (TCE)

Every agent turn is classified across 16 failure categories. Recovery happens automatically with structured retry decisions. No more silent dead-ends in long workflows.

### ⚡ Slash command UX

`/sandbox on`, `/tce off`, `/browser-depth status`, `/daemon status`, `/suggestions on` — toggle subsystems live, no env-var hunting, no restarts.

### 💡 Contextual capability suggestions

Doing something destructive? Aiden suggests `/sandbox on`. Asking for daily, weekly, or scheduled work? Aiden suggests `aiden cron add` + a trigger setup. Surface the right tool at the right time.

### 📦 Update notifications

Boot-time prompt: `Aiden 4.5.1 available — y/n/later`. Five-second timeout defaults to `later`. Skip a version semantically and Aiden won't bug you about it again until the next release.

## Quick start

```bash
# Install
npm install -g aiden-runtime@4.5.0

# Run interactively (just like before)
aiden

# Enable autonomous mode
AIDEN_DAEMON=1 aiden

# Register your first trigger
aiden trigger add file \
  --path ~/Downloads \
  --label "csv-watcher" \
  --include "*.csv" \
  --prompt-template "Analyze {{absPath}} and write a summary"
```

## Try a real autonomous workflow

```bash
# Watch your downloads folder for CSVs
aiden trigger add file \
  --path ~/Downloads \
  --label "csv-analyzer" \
  --include "*.csv" \
  --prompt-template "A CSV arrived at {{absPath}}. Read it, identify
                     the columns, find any anomalies, and write a
                     summary to ~/Downloads/analysis.md"

# Every weekday at 9am, check the market
aiden cron add \
  --label "nse-morning" \
  --schedule "0 9 * * 1-5" \
  --prompt-template "Research the top 5 movers on NSE and their key news"

# Now drop a CSV → Aiden processes it autonomously.
# 9am tomorrow → Aiden delivers the brief.
```

## Architecture (briefly)

Local-first daemon with a SQLite-backed durable trigger bus and dispatcher rails. Per-trigger `sessionId` isolates docker contexts, browser state, and error recovery history. Two-phase bootstrap means the daemon foundation runs regardless of REPL state — systemd-friendly, launchd-friendly, no TTY required.

Full details: [`docs/v4.5/architecture.md`](docs/v4.5/architecture.md).

## What didn't change

- `AIDEN_DAEMON=0` default — the interactive REPL works exactly like 4.0.2.
- All your existing skills, plugins, providers, and memory carry over.
- Zero breaking changes. Every new subsystem is opt-in via env var or slash command.

## Stats

- **38 commits** since v4.0.2
- **3432 tests** passing, zero failures
- **~22,000 LOC** added
- **14 internal version arcs** bundled

## Try it

```bash
npm install -g aiden-runtime@4.5.0
```

Or run without installing:

```bash
npx aiden-runtime@4.5.0
```

## Built with

Built solo by [Shiva at Taracod](https://taracod.com). AGPL-3.0 core, Apache-2.0 skills.

[Discord](https://discord.gg/aiden) · [Docs](https://github.com/taracodlabs/aiden/tree/main/docs/v4.5) · [Star us on GitHub](https://github.com/taracodlabs/aiden)
