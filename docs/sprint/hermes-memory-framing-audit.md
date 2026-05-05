# Hermes audit — memory section framing in system prompt (Phase 16e)

**Question:** Even with Phase 16d's invalidate-on-write refresh path firing
correctly, run-1 of the 16d smoke had the LLM say "I don't have any
information about you from our previous conversations" — model interpreted
USER.md content as past conversation history, not current state. What
section header / framing does Hermes use to prevent this?

## Sources
- `tools/memory_tool.py:393-409` — `_render_block(target, entries)` builds the actual system-prompt text
- `tools/memory_tool.py:534` — config doc string: "'user': who the user is — name, role, preferences, communication style, pet peeves"
- `agent/memory_manager.py:176-189` — `build_memory_context_block()` for *external* providers; wraps in `<memory-context>` with explicit "[System note: …recalled memory context, NOT new user input. Treat as informational background data.]"

## Findings
1. **Hermes frames USER.md as identity, not history.**
   Header (verbatim from `memory_tool.py:404`):
   ```
   ═══════════════════════════════════════════════
   USER PROFILE (who the user is) [12% — 25/200 chars]
   ═══════════════════════════════════════════════
   I prefer concise answers.
   ```
   Key: `(who the user is)` parenthetical. It tells the model: this section
   describes *current identity*, not transcript snippets.

2. **MEMORY.md is framed as agent's notes, not chat log.**
   Header (verbatim, `memory_tool.py:406`):
   ```
   ═══════════════════════════════════════════════
   MEMORY (your personal notes) [...]
   ═══════════════════════════════════════════════
   ```
   `(your personal notes)` makes it the agent's notebook, not a passive
   transcript.

3. **Visual ═══ separators stand out.** A `## User profile` markdown header
   blends in with other section headers and prose. `═══` is unmistakably
   structural.

4. **External memory provider context gets an explicit "system note".**
   `memory_manager.py:184-188`: `[System note: The following is recalled
   memory context, NOT new user input. Treat as informational background
   data.]`. This anti-confusion line is added to *external* provider blocks
   (Honcho, Mem0). The built-in MEMORY.md / USER.md doesn't get the same
   line — Hermes relies on the parenthetical framing alone.

5. **Usage indicator is bonus.** `[12% — 25/200 chars]` doubles as a memory-
   pressure cue for the model. Not load-bearing for the framing fix.

## Aiden's current state (the bug)
`core/v4/promptBuilder.ts:131-145`:
```
Slot 3: ## Agent memory\n\n<content>
Slot 4: ## User profile\n\n<content>
```
Plain markdown subsection headers. The model can read `## User profile`
as "a profile from a previous conversation" especially after a long run.
This is exactly what 16d run-1 surfaced.

## Decision: **adopt Hermes's parenthetical framing + add explicit system note**

Adopt the headers literally, plus adopt the `[System note: …]` anti-
confusion line that Hermes uses for external providers (we know the
built-in case needs it too — that's the bug we're fixing).

New format:
```
═══════════════════════════════════════════════════
USER PROFILE (who the user is)
═══════════════════════════════════════════════════
[System note: The following is what you currently know about the user.
Treat as live identity, not past conversation transcript.]

<content>
```

For MEMORY.md:
```
═══════════════════════════════════════════════════
MEMORY (your personal notes)
═══════════════════════════════════════════════════
[System note: The following are your own notes from prior interactions.
Treat as live working memory, not past conversation transcript.]

<content>
```

Skip the usage indicator for now — would need char-counting infra and
isn't load-bearing for the framing fix. Phase 17 polish.

## What we're NOT copying
- Char-count usage indicator — bonus, not load-bearing
- The `<memory-context>` XML envelope — Hermes uses that for the *external*
  provider tail block; built-in sections don't need it.
