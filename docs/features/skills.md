# Skills

A skill is a loadable, reusable instruction set that primes Aiden for
a specific job. Each skill is a single `SKILL.md` file (optionally
with helper scripts and templates) that gets injected into the agent's
system prompt for the next turn or session.

Aiden ships 74 bundled skills covering GitHub workflows, trading
research, security lookups, Windows admin, Docker management, YouTube
content tools, and more. You can also write your own.

---

## Skills vs. tools vs. memory

These three are often confused. The distinction matters:

| Concept | What it is | When it fires | Lives where |
|---|---|---|---|
| **Tool** | A piece of code (HTTP fetch, file write, shell exec). | When the model emits a tool call. | `tools/v4/` (built-in) or plugins. |
| **Skill** | A reusable instruction set (SKILL.md prompt + tool list). | When you activate it via `/skills <name>`. | `skills/` (bundled) or `~/.aiden/skills/` (custom). |
| **Memory** | Facts Aiden remembers across sessions. | Read at every turn's prompt build. | `~/.aiden/memory/MEMORY.md` + `USER.md`. |

A useful analogy: **tools are verbs, memory is who you are, skills are
playbooks.** When you tell Aiden "follow the github-pr-review playbook
for this PR," that's a skill.

---

## Activate a skill

From inside the REPL:

```
/skills
```

Lists all 74 bundled + custom skills with one-line descriptions. Filter
by typing — the picker narrows as you type. Press Enter to activate.

```
/skills github-pr-review
```

Activates one directly by name. The skill's `SKILL.md` is prepended to
your next turn's system prompt. The instructions stay active until
you switch skills or `/clear` the session.

From the shell:

```bash
aiden skills list                # bundled + user skills
aiden skills show github-pr-review
aiden skills add ~/my-skill/
aiden skills remove my-old-skill
```

`aiden skills review` (covered below) is the curation surface for
skill candidates Aiden mines from your usage.

---

## What's in a SKILL.md

The simplest possible skill:

```markdown
---
name: hello-world
description: A skill that makes Aiden greet you in Japanese.
category: experimental
required_tools: []
---

You're Aiden. When the user sends any message, reply with a greeting
in formal Japanese (use `ohayou gozaimasu` / `konnichiwa` /
`konbanwa` per time of day) and then answer their question
normally.
```

The YAML frontmatter is required. Recognized fields:

| Field | Required | What |
|---|---|---|
| `name` | yes | Slug; matches the filename's parent dir name. Lowercase, hyphens. |
| `description` | yes | One-line summary shown in `/skills` picker. |
| `category` | yes | One of: `development`, `data`, `creative`, `productivity`, `system`, `media`, `security`, `trading`, `experimental`, `meta`. |
| `required_tools` | no | Array of tool names the skill needs. If a required tool isn't available, activation warns. |
| `recommended_models` | no | Hint about which model fits best. Surfaced in `/skills show`. |
| `disabled_tools` | no | Array of tool names to filter OUT for this skill's turns. |
| `triggers` | no | (Experimental) Auto-activate hints based on user-message patterns. |

Below the frontmatter is plain markdown — the instruction text Aiden
injects into the system prompt.

---

## Bundled skill categories

The 74 shipped skills cluster into these groups. Run `aiden skills list`
for the full inventory.

| Category | What's in it | Examples |
|---|---|---|
| **Development** | Code review, testing, debugging, refactoring patterns. | github-pr-review, software-development-node-inspect-debugger, git-bisect-helper |
| **Data** | Database introspection, schema migration, query optimization. | postgres-introspect, sqlite-analyze, csv-pivot |
| **Creative** | Image / video / ASCII art / architecture diagrams. | ascii-art, architecture-diagram, baoyu-comic, ascii-video |
| **Productivity** | Note-taking, email triage, calendar. | apple-notes, apple-reminders, imessage |
| **System** | OS admin, process control, scheduled tasks. | macos-computer-use, findmy, windows-defender |
| **Media** | Music control, video search, podcast. | media-spotify, youtube-content |
| **Security** | OSINT, threat intel lookups, secret scanning. | censys-scan, shodan-host, virustotal-file |
| **Trading** | Stock + crypto research, broker integrations. | nse-screener, upstox-orders, zerodha-quote |
| **Meta** | Skills about using Aiden itself. | self-improvement-loop, agent-handoff |

A skill activates its instruction set + optionally constrains the tool
surface. `disabled_tools` removes specific tools for the skill's
duration; `required_tools` is a soft contract the skill assumes.

---

## Where skills live

| Path | What |
|---|---|
| `<install>/skills/` (in the npm package) | The 74 bundled skills. Read-only — package upgrades replace them. |
| `~/.aiden/skills/` | Your custom skills. Survives upgrades. |
| `~/.aiden/skills/.curator_state` | Skill-curation scheduler state (covered below). |

On Windows: `%LOCALAPPDATA%\aiden\skills\`.

Each skill is a directory containing at minimum a `SKILL.md`. Optional
sub-paths:

```
my-skill/
├── SKILL.md                # required
├── references/             # extra read-only docs the skill references
│   └── api-cheatsheet.md
└── templates/              # reusable file templates
    └── pr-checklist.md
```

Aiden's skill loader reads `SKILL.md` plus any explicitly-referenced
files when the skill activates. Helper directories don't get pulled
into the prompt unless `SKILL.md` references them.

---

## Write your own skill

Create a directory:

```bash
mkdir -p ~/.aiden/skills/inbox-zero
cat > ~/.aiden/skills/inbox-zero/SKILL.md <<'EOF'
---
name: inbox-zero
description: Triage Gmail inbox — categorize, file, or draft replies.
category: productivity
required_tools: [email_imap, email_send, file_write]
recommended_models: [groq:llama-3.3-70b-versatile, anthropic:claude-sonnet-4.5]
---

You're triaging the user's Gmail inbox. For each unread thread:

1. Read it via `email_imap`.
2. Classify into one of: urgent / personal / newsletter / receipt / spam.
3. For urgent: write a one-line summary to `~/triage/urgent-today.md`.
4. For personal: mark UNREAD (preserve user attention).
5. For newsletter / receipt: file via IMAP move.
6. For spam: ignore (don't mark as spam — leave it for Gmail's filter).

Never reply automatically. Drafts only.
EOF
```

Then:

```
/skills inbox-zero
```

The skill is active. Your next turn uses these instructions.

---

## Skill mining

Aiden watches your sessions for successful tool sequences and
generates skill candidates from patterns worth reusing. Mining runs
post-turn — every successful turn with 3+ tool calls is scanned.

### What ships today

- `core/v4/skillMining/skillMiner.ts` observes the tool trace of every
  successful turn and computes a confidence score.
- Patterns above the confidence threshold queue as **candidates** —
  the proposal is generated by `proposalBuilder.ts` based on the
  trace fingerprint + the source session's conversation.
- `core/v4/skillMining/candidateStore.ts` persists pending candidates
  to `~/.aiden/skills/learned/.candidates.json`; rejected candidates'
  fingerprints are recorded at
  `~/.aiden/skills/learned/.rejected.json` so the same shape won't
  re-queue.
- `core/v4/skillOutcomeTracker.ts` measures per-skill success / failure
  rates over time. The data is operator-readable but isn't surfaced
  via a slash command yet.

Operator surface — slash commands from inside the REPL:

```
/skills review                    list pending candidates
/skills view-candidate <id>       preview a candidate's SKILL.md
/skills accept <id>               promote the candidate to ~/.aiden/skills/<name>/
/skills reject <id> [reason]      record rejection (dedup-aware via fingerprint)
/skills propose                   summary of the mining hook + pending count
```

Accepted candidates land at `<aidenHome>/skills/<name>/SKILL.md` and
the skill loader's cache is invalidated so they show up in
`/skills list` on the next call.

### What's roadmap (not shipped)

- **Long-cycle skill maintenance**: archive stale skills, consolidate
  duplicates, prune unused, restore archived. No scheduler exists
  today.
- **Idle-triggered background curation**: a cadenced "review my
  agent-created skills" pass. Not wired.
- **Pinned-skill protection**: explicit operator pinning that
  bypasses auto-transitions. Not wired.

Track at <https://github.com/taracodlabs/aiden>.

---

## Skill enforcement tracker

Some skills declare `required_tools`. When you activate one and the
agent strays into a different tool, Aiden's skill-enforcement tracker
nudges (or in YOLO-off mode, blocks) the off-pattern call.

The behavior is **soft by default** — the agent gets a system message
hint to use the required tool instead. Switch to hard enforcement:

```bash
aiden config set skills.enforcement strict
```

In strict mode, off-pattern tool calls are rejected before dispatch
with a structured error envelope the model can see.

Debug the enforcement decisions:

```bash
export AIDEN_DEBUG_SKILL_ENFORCEMENT=1
aiden
```

Logs each enforcement check + decision to `~/.aiden/logs/agent.log`.

---

## Skill marketplace — planned

A community skill marketplace (`skills.taracod.com`) is on the roadmap
but **not shipped yet**. The intent is Apache-2.0 community skills
discoverable via `aiden skills install <name>`. No ETA — track
[GitHub Discussions](https://github.com/taracodlabs/aiden/discussions)
for updates.

For now, share custom skills by:

- Pasting `SKILL.md` content into a GitHub gist.
- Sharing the skill directory as a tar.gz.
- Contributing back to the bundled set via PR (Apache-2.0 license
  required on contributed skills).

---

## See also

- [`../reference/slash-commands.md`](../reference/slash-commands.md) — `/skills` invocation surface.
- [`../reference/cli-commands.md`](../reference/cli-commands.md) — `aiden skills` shell verb.
- [`memory.md`](./memory.md) — for "facts Aiden should remember", which is memory's job, not skills'.
- [`sub-agents.md`](./sub-agents.md) — skills are sometimes a better fit than spawning a sub-agent.

---

## What skills aren't

- **Not custom tools.** Skills can't add new tool implementations.
  They reference existing tools via `required_tools` and inject
  prompts that direct the agent toward those tools. To add tool code,
  write a plugin.
- **Not durable state.** Skills are stateless — the same skill
  activated twice produces no shared state across the two activations.
  For "remember this fact," use memory.
- **Not always-on.** Bundled skills are available but inactive until
  you `/skills <name>`. The full catalog isn't injected into every
  prompt — that would blow context.
- **Not the same as personalities.** A personality (`/personality`)
  is a style overlay. A skill is a job-specific playbook. You can
  stack one personality + one skill simultaneously.
