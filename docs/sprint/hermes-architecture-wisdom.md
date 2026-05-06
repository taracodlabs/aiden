# Hermes architecture wisdom — retrospective + Aiden delta

**Source:** Hermes Agent's own architectural retrospective, captured 2026-05-06 via direct chat. References point at `references/hermes-agent/` file:line where applicable.

---

## Hermes transcript (verbatim)

**Source:** Hermes Agent v0.0.0, running gpt-5.3-codex via ChatGPT Plus OAuth, 2026-05-06. Direct chat in WSL Ubuntu at `/mnt/c/Users/shiva/references/hermes-agent`. Token usage at time of response: 68.7K/272K, 8 minutes elapsed.

**User prompt:**
> I'm building Aiden, a TypeScript fork of your architecture for native Windows. Help me understand your design choices for production agentic CLIs. Specifically: [10 questions about architecture, tool selection, memory, honesty, skill triggering, approval UX, provider secrets, plugins, streaming, retrospective]

**Hermes response (verbatim):**

Awesome prompt. I'll give you the non-marketing version, with concrete behavior and where it shows up in Hermes code.

Short framing:
Hermes is optimized for production reliability under flaky models/providers, not theoretical purity. Most choices are "protect prompt cache + preserve agent continuity + fail loudly when unverifiable".

1) ARCHITECTURE — single loop vs multi-loop/scratchpad

Why single loop:
- Multi-loop (planner/responder split) tended to create responsibility gaps:
  - Planner says "done", executor did partial work.
  - Responder summarizes stale state (or imagined state) from scratchpad.
  - Tool traces get fragmented across loops, so auditability drops.
- Single loop keeps one authoritative trajectory:
  user -> model -> tool calls -> tool outputs -> model -> final.
  No second "narrator" LLM to drift.

Concrete:
- Core loop sits in run_agent.py run_conversation() (see AGENTS summary and run_agent.py tool-call handling around 13026+).
- Invalid/hallucinated tool calls are caught in-loop, returned to same model for correction, bounded by retry budget (run_agent.py:13035-13068).

What model sees vs hidden:
- Model sees: system prompt + conversation + tool schemas + tool outputs.
- Hidden: internal runtime state (spinner, approval queues, provider recovery internals, some callbacks, etc.).
- Important boundary: ephemeral system text can be injected at API-call time but not persisted into cached/stored system prompt (run_agent.py:4950-4952).
- This is deliberate: stable prefix for caching, transient control outside long-lived prompt body.

2) TOOL SELECTION — why not per-turn filtering

Reason:
- Prompt-cache economics and behavioral stability beat micro-optimization.
- If tool inventory changes mid-session, you invalidate cached prefixes and destabilize model behavior ("tool disappeared" effects).

Concrete signals:
- Hermes explicitly avoids mid-conversation toolset mutation; changes apply on /reset (cli.py:4645-4647).
- Docs/skill text also emphasizes "don't break prompt caching".
- Static tool schema pattern appears in tool implementations too (e.g., todo tool comment about cached static schema).

Did filtering get tried?
- Yes, historically in many agent systems. Typical regression: higher local accuracy for simple turns, but worse long-horizon autonomy due to tool omission/false negatives.
- Hermes bias is "full inventory + strong prompting" over "predictive gating".

3) MEMORY — frozen snapshot mid-session vs invalidate-on-write

Current design:
- System prompt built once per session and cached; includes persistent memory snapshot at build time (run_agent.py:4865-4873, 4955+).
- Memory/session provider teardown/flush occurs at session boundaries, not each turn (run_agent.py:4624-4630).

Why:
- Rebuilding system prompt each write/turn kills prefix cache and increases cost/latency variance.
- Refresh-per-turn can cause instruction drift ("moving system prompt") and hard-to-debug behavior changes.
- Frozen snapshot gives deterministic session behavior.

Failure mode avoided:
- "I just wrote memory, why did model suddenly change style/plans this turn?" due to live prompt mutation.
- Cache miss storms on long sessions.

User expectation for same-session recall:
- Hermes handles this with conversation-local state + explicit memory tools.
- New memory facts are durable for next sessions; same-session behavior is mostly from current chat context.
- If you need immediate "authoritative recall", call memory/session tools explicitly rather than expecting system prompt rebuild.

4) HONESTY — how "no fabrication" is actually enforced

Not just prompt text. It's layered:
a) Prompt discipline:
- Tool-use enforcement and anti-hallucination execution rules injected for model families (prompt_builder.py:243+ and 266+).
b) Runtime guardrails:
- Unknown tool names detected/repaired/rejected in-loop (run_agent.py:13035+).
- If model outputs malformed tool intent, Hermes returns explicit tool error back into loop for self-correction.
c) Adapter-level recovery:
- Codex "leaked tool call as plain text" detection; treated as incomplete and continued, not accepted as final answer (codex_responses_adapter.py:942-999).

Failure mode when model still lies:
- Hermes can still output a lie if it never emits tool calls and produces plausible text.
- Mitigation is "mandatory tool use" guidance + retries + constraints, but this is probabilistic, not formal verification.
- Production answer: enforce verification-by-tool for claims that matter (file writes, external side effects, system facts).

5) SKILL TRIGGERING — how to get activation on fuzzy intent

Hermes uses multiple channels:
- System-level mandatory instruction to load relevant skills before answering (your current runtime prompt is exactly this pattern).
- Explicit tools (skills_list / skill_view) so loading is an observable action, not implicit lore.
- Slash skill commands generated from installed skill metadata for user-triggered fast path (cli.py references around skill_commands scan/dispatch).

What works best:
- "Mandatory framing + explicit tool call" outperforms examples-only prompting.
- Examples help, but explicit enforcement text drastically increases activation reliability.

Activation rate:
- I can't give you a trusted global % without telemetry dataset. Locally it's strongly model-dependent.
- Practical truth: with hard instruction + tool enforcement, activation is high; without hard instruction, fuzzy intents are missed often.

6) APPROVAL UX — smart mode design

Both rule-based and model-based:
- Rule/pattern + Tirith checks identify risky commands first.
- In smart mode, auxiliary LLM gives approve/deny/escalate (tools/approval.py:1001-1025).
- Escalate falls back to human approval prompt.

Avoiding fatigue:
- Auto-approve low-risk repeated patterns at session scope.
- Keep hardline blocks that cannot be bypassed by yolo/off modes (covered by tests referenced in search results).

Avoiding silent dangerous execution:
- Even smart mode can deny outright.
- Gateway/CLI approval path is synchronous from agent perspective: agent either gets output or blocked message; no ambiguous "pending" state leaked to model (tools/approval.py:1035-1039).

7) PROVIDER SECRETS — Codex/ChatGPT backend gotchas

Useful non-obvious ones from code behavior:
- Codex credentials can exist in two stores (Hermes auth + ~/.codex/auth.json); deleting one can resurrect via reseed unless source-suppressed (credential_sources.py:268-297).
- Responses transport uses prompt_cache_key=session_id for non-GitHub backends (agent/transports/codex.py:102-105).
- Codex backend can emit tool calls as plain text instead of structured function_call; must detect/recover (codex_responses_adapter.py:942+).
- Reasoning payload differences across backends (GitHub/Codex/xAI) require per-backend kwargs shaping in transport.

Model slug rotation handling:
- Hermes treats model string as runtime config and has fallback/provider recovery logic, but slug churn is still a live ops issue; don't hardcode assumptions into core loop.
- Keep adapter normalization strict and fail loudly when required fields are missing (codex adapter validates required fields, including non-empty model).

8) PLUGINS — in-process vs worker isolation

Why in-process today:
- Lowest friction for ecosystem growth.
- Direct access to shared registries/config/tool runtime without IPC ceremony.
- Better performance and simpler deployment cross-platform.

Tradeoff:
- Blast radius is larger (plugin bug can impact agent process).
- Hermes mitigates with hooks, gating, and optional enabling, but this is not hard sandbox isolation.

Heuristic: plugin vs core
- Core if it is load-bearing for baseline agent correctness (loop, transport, tool dispatch, approvals, session store).
- Plugin if domain-specific integration or optional capability (memory providers, dashboards, niche services).
- If many users need it and it affects correctness/safety invariants, promote toward core.

9) STREAMING — tool calls mid-stream

Hermes strategy is hybrid by provider:
- For providers that support structured tool deltas well, stream and accumulate.
- For flaky paths, buffer until a coherent assistant/tool-call object can be formed.
- If incomplete, continue turn instead of surfacing broken partials (Codex incomplete continuation, bounded retries: run_agent.py around 13006+).

Edge cases that bit hard:
- Anthropic via OpenRouter silent buffering causing upstream timeout; fixed by fine-grained tool-streaming beta header (run_agent.py:1523-1539).
- Codex tool-call leak in plain text (adapter recovery above).
- Duplicate interim messages during continuation; dedup logic required (run_agent.py:12993+).

10) What I'd do differently starting today

a) Smaller core earlier
- run_agent.py is too large; transport extraction happened but more decomposition should've happened sooner.

b) First-class trace schema from day 1
- Standardized, machine-checkable execution trace for every claim would make honesty enforcement less prompt-dependent.

c) Stronger plugin isolation mode
- Optional process sandbox for untrusted plugins/MCP servers would reduce operational risk.

d) Unified policy engine
- Approvals, blocklists, and verification rules could be consolidated into one declarative policy layer instead of partly distributed logic.

e) Skill quality telemetry
- Automatic measurement of skill activation/usefulness/drift would reduce stale-skill entropy.

For Aiden specifically (since you're on native Windows):
- Keep your single-loop and strict tool-trace model.
- Freeze system prompt/memory per session unless you can preserve cache keys.
- Treat provider adapters as hostile boundaries: normalize aggressively, retry conservatively, fail explicitly.
- Put your honesty checks in runtime mechanics, not only instruction text.

[End Hermes response]

---

## Aiden vs Hermes delta

| # | Area | Aiden state | Classification | Notes |
|---|---|---|---|---|
| 1 | Single-loop architecture | One `runConversation` loop in `core/v4/aidenAgent.ts`; tool dispatch + stream + retry inside the loop | ✅ MATCHES | Phase 16 architecture port; mirrors Hermes `agent_loop.py`. |
| 2 | Tool selection | After Phase 16g revert: full tool inventory on no-rule-match. Earlier Phase 16g attempt at "rule-bound subset" caused starvation; reverted. | ✅ MATCHES (now) | Hermes confirms full-inventory is the correct default. Phase 16g audit doc covers the divergence and revert. |
| 3 | Memory: frozen vs invalidate-on-write | Aiden Phase 16d invalidates `MemorySnapshot` on tool-driven write, then refreshes prompt next turn. Phase 18 caching adds preflight refresh window. | 🔴 DIVERGES against Hermes lesson | Hermes warns: refresh-per-turn causes instruction drift (moving system prompt) and cache-miss storms on long sessions. Aiden chose invalidate-on-write because the REPL UX requires "✓ Saved" confirmation to reflect on the next turn. **v4.0 ships with invalidate-on-write per UX requirement** (single-REPL session model expects "remember X" to be queryable in next turn). Hermes pattern is correct for gateway/multi-session deployments; Aiden's REPL-only v4.0 has different constraints. **v4.1 review item:** revisit if drift surfaces in production logs — evaluate frozen-snapshot + explicit `/refresh` slash command vs auto-invalidate. Track in `v4.1-roadmap.md` § "Phase 16d revisit". |
| 4 | Honesty enforcement | `moat/honestyEnforcement.ts` (prompt-shaping + post-turn trace check) + `moat/memoryGuard.ts` (verified flag) + Phase 21 #4 Hermes parser port for `<tool_call>` content leaks. | ✅ MATCHES | Phase 21 #4 closed the codex tool-call-leak gap (`providers/v4/chatCompletionsAdapter.ts::extractHermesToolCalls`). |
| 5 | Skill triggering | Phase 16g: mandatory `skill_view` tool + system-prompt framing telling the model to view-then-execute. | ✅ MATCHES | Hermes uses identical pattern. |
| 6 | Approval modes | `moat/approvalEngine.ts` smart mode = rule-based (`BUILTIN_SAFE_TOOLS`, `BUILTIN_SAFE_DOMAINS`, `dangerousPatterns`). Auxiliary-LLM risk assess wired but disabled by default. | ⚠ DIVERGES with documented reason | Aiden ships rules-only for v4.0 free tier; auxiliary-LLM gating already in `core/v4/license/featureGate.ts::MULTI_TOOL_APPROVAL` for Pro tier (v4.1 enable path). |
| 7 | Provider secrets / adapter normalization | The Phase 21 #6 chain (a/b/c) hit exactly what Hermes warned about — Cloudflare headers missing, max_output_tokens wrongly sent, tool-call leakage. Each fix was a "fail-loud-on-required-field" addition. | ⚠ DIVERGES — corrected mid-Phase-21 | Adapter normalization is now strict for the Codex backend. Audit the rest of the providers in v4.1 for similar latent gaps. |
| 8 | Plugins | Phase 17: in-process Node plugins, no spawned subprocess. Permission gates at `pluginContext.registerTool`. | ✅ MATCHES | Hermes also in-process; OS-sandbox is acknowledged as v4.1 deferral on both sides. |
| 9 | Streaming | Phase 16c: buffer-and-suppress (one strategy across all providers). | ⚠ DIVERGES with documented reason | Hermes uses hybrid (stream when provider reliable, buffer when flaky). Per-provider strategy is v4.1 polish; current strategy is correct-by-default and never produces broken output. |
| 10 | What Hermes would do differently | n/a | — Tracked in v4.1 backlog | First-class trace schema · OS-level plugin sandbox · unified policy engine · skill activation telemetry. |

---

## Phase 21 #6 chain — Hermes confirmed gotchas

These bugs we hit this session match Hermes's own retrospective gotchas (per the user's structured summary in the Phase 21 prompt):

| Bug | Hermes gotcha | Aiden fix commit |
|---|---|---|
| #5 — `/auth login` succeeded but `/model` resolved through legacy auth.json | "Codex credentials can exist in two stores — pick one canonical reader" | `5a9b585` (paths threading) + `2457a19` (registry unification) |
| #6a — Wrong Codex slugs (`gpt-5-mini`, `gpt-5-codex`) | "Codex slugs ≠ direct OpenAI API slugs" | `2457a19` |
| #6b — Codex Cloudflare headers missing | "First-party originator + ChatGPT-Account-ID extracted from JWT" | `3756cc9` |
| #6c — Stream-required path (next user retest) | "Codex backend may require `stream: true`" | TBD per retest |
| #4 — Tool-call JSON leaked into content | "Codex backend can emit tool calls as plain text — parse defensively" | `639ced6` |

Reasoning payload differences (`reasoning: {effort, summary}`, `include: ['reasoning.encrypted_content']`) are banked for v4.1 polish — the user-blocking 400s are addressed; reasoning config is quality-of-life.
