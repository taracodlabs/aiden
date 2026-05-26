# Memory

Memory is the layer that lets Aiden remember things about you across
sessions. It's distinct from per-session conversation history (which
lives only as long as you're chatting) and from skills (which are
reusable instruction sets, not facts).

Three principles guide the design:

- **Local only.** Memory lives in plain markdown files in `~/.aiden/`.
  Nothing leaves your machine.
- **User-approved writes.** The model can propose a memory write, but
  the durable file isn't touched without your consent (or your
  explicit YOLO-off override).
- **Inspectable + editable.** Everything is markdown. Open your editor
  whenever you want to see or change what Aiden remembers.

---

## What gets remembered, and where

Three files in `~/.aiden/memory/`:

| File | What's in it | When written | When read |
|---|---|---|---|
| `MEMORY.md` | Durable facts about the user + their projects. Compression-protected — never auto-deleted. | At `/quit` (session distillation) or when the agent calls `memory` tool with user approval. | Loaded into every system prompt. |
| `USER.md` | Optional user-controlled persona. Style preferences, communication norms, fixed identity facts. | You edit this manually. Aiden never writes here. | Loaded into every system prompt. |
| `SOUL.md` | Aiden's own persona — voice, ethics, defaults. Edit to customize personality globally. | You edit this manually. Aiden never writes here. | Loaded into every system prompt. |

The system prompt build merges them in a fixed order: `SOUL.md` (who
Aiden is) → `USER.md` (who you are) → `MEMORY.md` durable section →
`MEMORY.md` recent-session distillations.

On Windows: `%LOCALAPPDATA%\aiden\memory\`.

---

## Session distillation

At `/quit`, Aiden runs a small auxiliary-model call to summarize the
session. The output gets appended to `MEMORY.md` under the recent-
sessions section.

Two kinds of facts come out:

1. **Durable facts.** "User's Postgres database is named `acme_prod`."
   "User prefers tabs over spaces." Stable, future-relevant, non-PII.
2. **Recent-session distillations.** "Spent today debugging the
   webhook retry handler in `~/code/aiden-webhook/`." Useful next
   session, not necessarily forever.

Durable facts get promoted into a compression-protected section at the
top of `MEMORY.md`; recent distillations live in a rolling section
below that gets pruned over time.

### What you see

After a clean `/quit`:

```
session summary written to ~/.aiden/memory/MEMORY.md
  durable promotions:    3
  recent distillation:   ~210 tokens
```

Distillation runs automatically when `shouldAutoSummarize()`
determines the session is substantive enough (recent message
volume, memory growth, time elapsed). There's no user flag to
skip it today — to undo a distillation, edit
`~/.aiden/memory/MEMORY.md` directly (see § Editing `SOUL.md` and
`USER.md` for the same edit-then-reload pattern).

---

## The `memory` tool

Inside a turn, Aiden can call the `memory` tool to propose a write
mid-conversation rather than waiting for `/quit`:

```
You: My GitHub username is shiva-dev.
Aiden: Got it. Let me save that.
       [memory write: action=add, content="user's github username is shiva-dev"]
       Saved.
```

The actual write goes through the memory guard:

- **Default approval mode** (`yolo manual` or `smart`): the write is
  proposed; you see a confirmation row + Enter to commit.
- **`yolo off`**: writes commit immediately (use with care).

To inspect what Aiden has written:

```bash
cat ~/.aiden/memory/MEMORY.md
```

Or from inside the REPL:

```
/identity
```

That prints both `USER.md` and `MEMORY.md` in a single view.

---

## Cross-session lookup — `recall_session`

When Aiden needs to find something from a past session, it uses the
`recall_session` tool. The lookup hits an FTS index over every past
session's transcript:

```
You: What was the bug we found in the webhook retry logic two weeks
ago?
Aiden: [recall_session: query="webhook retry bug"]
       Found it — session 4a21-xxx, 2026-05-05. The bug was in
       backoff calculation when the response was a 429...
```

The model gets back excerpts + session IDs. It can pull a full
transcript with `aiden sessions show <id>` (run by a tool call, not
something you have to type).

This is broader than memory — memory holds curated facts, while
`recall_session` is brute-force search over raw history.

---

## The memory consent contract

Aiden's memory guard enforces a hard rule: **autonomous deletion is
blocked.**

The model can:

- Propose adding to memory.
- Propose updating an existing entry.
- Ask you whether to delete something old.

The model cannot:

- Silently delete memory entries.
- Bypass the approval gate when `yolo` is `manual` or `smart`.
- Modify `MEMORY.md`'s compression-protected section without explicit
  user confirmation, regardless of YOLO mode.

This is structural. Even in `yolo off` mode, deletes from the protected
section require an explicit acknowledgement step the model can't
forge.

If you want to forget something:

```bash
edit ~/.aiden/memory/MEMORY.md
```

Open the file, delete the line, save. That's the canonical "make Aiden
forget" path. The next session's prompt build won't see the deleted
fact.

---

## `/clear` vs. memory

`/clear` is a session-scoped command: it empties the in-memory message
array for the current session. **It does not touch `MEMORY.md`** — your
durable facts survive `/clear`.

| Action | What clears | What survives |
|---|---|---|
| `/clear` | Current session's message history | `MEMORY.md`, `USER.md`, `SOUL.md`, past sessions |
| `/quit` | (Distills the session first, then exits) | Everything; distillation appends to `MEMORY.md` |
| Delete `~/.aiden/memory/MEMORY.md` | Durable facts | Past session transcripts, USER.md, SOUL.md |
| Delete `~/.aiden/sessions.db` | Past session transcripts | Memory files, USER.md, SOUL.md |
| Delete `~/.aiden/` entirely | Everything | (Aiden re-bootstraps on next run) |

If you want a totally fresh start, the last option works — Aiden's
setup wizard runs again on next boot.

---

## Editing `SOUL.md` and `USER.md`

Both files are intended to be hand-edited. After editing:

```
/reload-soul
```

Re-reads `SOUL.md` without a restart. (No equivalent for `USER.md` —
it's read fresh every turn, so edits take effect on the next message.)

### Example `USER.md`

```markdown
# User profile

- Name: Shiva
- Location: Pune, India (Asia/Kolkata)
- Tech stack: TypeScript, Python, Postgres, Docker
- Prefer concise replies. No emojis. Match my casing in code.
- Working on Aiden (https://github.com/taracodlabs/aiden)
```

That stable identity gets injected into every system prompt. The agent
adapts its replies without you re-explaining the context each session.

### Example `SOUL.md` (excerpt)

`SOUL.md` ships pre-populated; edit to customize. A common minimal
override:

```markdown
# Operating defaults

- Always show citations when answering web-grounded questions.
- Default to imperial units for distance/weight.
- When in doubt, ask before mutating the filesystem.
```

---

## Memory architecture (one-screen overview)

The internals, for the curious:

```
~/.aiden/memory/
├── MEMORY.md              # durable facts + recent session distillations
├── USER.md                # user-controlled persona (optional)
└── SOUL.md                # Aiden's persona (editable)

~/.aiden/sessions.db       # SQLite — every session row + messages + FTS index
                           # backs recall_session tool

~/.aiden/daemon.db         # SQLite — runs / run_events / recovery_reports
                           # not strictly memory, but holds long-term failure
                           # signatures (see features/sub-agents.md § Recovery)
```

The prompt builder loads from `MEMORY.md` + `USER.md` + `SOUL.md` on
every turn. It does NOT re-query `sessions.db` per turn — that only
fires when the model calls `recall_session` explicitly.

Memory budget per turn is bounded — the durable section is allowed up
to ~2k tokens; recent-session distillations get up to ~1k tokens. If
the file is longer than the budget, the prompt builder truncates with
a soft signal in the prompt ("[older entries truncated]").

---

## Privacy

- **No upload.** Nothing in `~/.aiden/` is sent to a Taracod-controlled
  server. Aiden has no central account.
- **Provider visibility.** The text Aiden sends to your chosen provider
  per turn DOES include the prompt — which contains `SOUL.md` +
  `USER.md` + `MEMORY.md` excerpts. If a provider logs prompts, those
  facts are visible to them. This is true for every LLM tool, not
  specific to Aiden.
- **Per-provider routing.** Some providers (OpenAI Codex, Anthropic
  Workspace) offer zero-retention modes. Aiden routes through whatever
  policy your provider enforces; it doesn't override it.
- **OAuth subscription routing** (`claude-pro`, `chatgpt-plus`) uses
  the same retention policy your consumer subscription has — typically
  more restrictive than API tier.
- **Local-only mode.** Use the `ollama` provider for prompts that
  must never leave your machine.

---

## See also

- [`../reference/slash-commands.md`](../reference/slash-commands.md) — `/clear`, `/identity`, `/reload-soul`.
- [`../reference/cli-commands.md`](../reference/cli-commands.md) — `aiden sessions search` for cross-session FTS.
- [`skills.md`](./skills.md) — skills are reusable playbooks, not facts.
- [`../reference/env-vars.md`](../reference/env-vars.md) — `AIDEN_HOME`, `AIDEN_SUMMARY_TIMEOUT_MS`.

---

## What memory isn't

- **Not vector-search RAG.** Aiden's memory is text + FTS; no
  embeddings, no vector store. The model reads facts directly from
  the prompt. This trades retrieval sophistication for transparency
  — you can `cat MEMORY.md` and see exactly what the model sees.
- **Not infinite.** The token budget caps how much of `MEMORY.md` makes
  it into a turn. Heavy users should periodically prune (or let the
  compression layer prune for them).
- **Not shared across machines.** Your Aiden install on laptop A and
  desktop B have independent memory files. Sync them via your usual
  dotfiles flow (git, syncthing, etc.) if you want one persona across
  machines.
- **Not a knowledge base.** For "facts I want to look up later," use
  notes + `recall_session` over the session that wrote them. Memory
  is for things Aiden should _know_ at every turn.
