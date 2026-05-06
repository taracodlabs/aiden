# Hermes audit — tool-call leak (Phase 21 #4)

**Method:** graphify keyword scan over `references/hermes-agent` (53k nodes / 96k edges); targeted reads on `environments/tool_call_parsers/{__init__,hermes_parser,qwen_parser,qwen3_coder_parser}.py` and `environments/agent_loop.py`. Aiden side: `providers/v4/chatCompletionsAdapter.ts` `{tryRecoverLegacyToolCall, parseLegacyFunctionSyntax, parseResponse, callStream}`.

## Hermes pattern (canonical)

| Concern | Hermes | File:line |
|---|---|---|
| Per-model parser registry | `tool_call_parsers/__init__.py::register_parser` decorator; one parser per family (`hermes`, `qwen`, `qwen3-coder`, `deepseek_v3`, `glm45`, `kimi_k2`, `llama`, `mistral`). Selected via `--env.tool_call_parser hermes` (default `hermes` for Qwen/Hermes finetunes). | `environments/hermes_base_env.py:161` |
| Parser entrypoint | `agent_loop.py` checks `assistant_msg.content` for raw tool-call tags AFTER the OpenAI envelope is parsed, then calls the registered parser to extract synthetic `tool_calls`. | `environments/agent_loop.py:264-281` |
| Hermes/Qwen format | `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`. Regex `re.compile(r"<tool_call>\\s*(.*?)\\s*</tool_call>\|<tool_call>\\s*(.*)", re.DOTALL)` — handles both closed and unclosed (truncated). | `tool_call_parsers/hermes_parser.py:31-33` |
| Content stripping | After extraction: `content = text[: text.find("<tool_call>")].strip()` — visible content is whatever preceded the first tag. Returns `(content_or_none, tool_calls)`. | `hermes_parser.py:71-72` |
| Qwen 2.5 / Qwen3-Instruct | `qwen_parser.py` registers `"qwen"` as a strict subclass of `HermesToolCallParser` with `pass` body. Aiden's Together model `Qwen/Qwen3-235B-A22B-Instruct-2507-tput` falls under this format. | `tool_call_parsers/qwen_parser.py:12-19` |
| Qwen3-Coder | Different format (XML with nested params), separate parser. **Not** what Aiden hits. | `tool_call_parsers/qwen3_coder_parser.py` |
| Buffer drain & inter-turn state | `agent_loop.py` builds a fresh `assistant_msg` per turn; no streaming buffer survives between turns. Tool-call extraction is content-only, applied per-message. No persistent state to leak. | `agent_loop.py:264-281` |

## Aiden gap

`providers/v4/chatCompletionsAdapter.ts`:

- `parseResponse()` (line 795) and the streaming finaliser (line 703) **trust the OpenAI tool_calls envelope** and pass `message.content` through verbatim. They have no fallback for `<tool_call>...</tool_call>` tags or bare JSON tool-call objects inside content.
- `tryRecoverLegacyToolCall` (line 140) and `parseLegacyFunctionSyntax` (line 168) only handle the **Llama-3.3 `<function=NAME(...)>`** legacy format, and only on 4xx error responses.
- When Together's Qwen3 emits `<tool_call>{...}</tool_call>` inside `message.content` of a 200-OK response (which it does intermittently), Aiden surfaces the raw tag text to the user — exactly the user-reported leak.

## Decision

Port `HermesToolCallParser` to TypeScript and call it from both `parseResponse` and the streaming assembly. **Direct copy of Hermes's regex + extraction logic** — no invention. Apply the parser only when the OpenAI tool_calls envelope is empty (so a well-behaved provider response is never re-processed). Ship a registry-style hook so future models with different formats can plug in without touching adapter internals — but Phase 21 #4 ships only the Hermes/Qwen variant.

## Inter-turn echo (`Now playing Rick Astley` showing in next turn)

Hermes builds a fresh `assistant_msg` per turn (`agent_loop.py:264`) and Aiden's `callStream` accumulators are local to each call (`chatCompletionsAdapter.ts:542-547`). No client-side buffer survives between turns. The echo is therefore either:

1. **Model behaviour** — Qwen3 sometimes regurgitates prior conversation when it lacks a clear answer for the current turn. Not a bug; it's the model. Mitigated downstream by the upcoming tool-call interception (the regurgitated text is ALSO the leaked-JSON text in user's report — same surface).
2. **Session rehydration** — `sessionStore` replays prior messages. Not in scope; verified per-turn isolation.

No client-side fix needed for the echo. The tool-call leak fix removes the visible artifact regardless.

## Stop conditions verified

- ✅ Hermes does NOT use a fundamentally different streaming architecture — same per-message pattern.
- ✅ Bare-JSON detection narrowed: require `<tool_call>` tag presence (or `{"name":..., "arguments":...}` literal with both keys) to avoid eating user prose containing JSON.
