# Hermes Codex SSE event audit (Phase 21 #6d)

**Source:** `references/hermes-agent/run_agent.py::_run_codex_stream` (lines 5829–5952) and `_run_codex_create_stream_fallback` (5954–6010). Captured 2026-05-06.

## Hermes event-type handlers (verbatim list)

| Event type | What Hermes does |
|---|---|
| `response.output_text.delta` (or any event_type containing `output_text.delta`) | Append `event.delta` to `_codex_streamed_text_parts`; fire visible-stream callback unless tool calls have started |
| `response.output_item.done` | Append `event.item` to local `collected_output_items` — **the critical event for backfill** when `response.completed.output` is empty |
| `response.output_item.added` | Implicitly handled by the SDK — no special branch in Hermes, but events are not dropped |
| Any event_type containing `function_call` | Set `has_tool_calls = True` to suppress text streaming |
| Any event_type containing `reasoning` AND `delta` | Fire reasoning-delta callback (`_fire_reasoning_delta`) |
| `response.completed` | Terminal — proceed to `stream.get_final_response()` |
| `response.incomplete` | **Terminal — log and continue to backfill path.** Codex backend often sends this instead of `completed`. |
| `response.failed` | Terminal — log and raise |
| `response.created` | Implicitly handled by the SDK; no special branch |
| Other event types | Touched activity timer; otherwise ignored |

## The critical patch — backfill on empty `output[]`

`run_agent.py:5895-5917` is the single most important block:

```python
final_response = stream.get_final_response()
# PATCH: ChatGPT Codex backend streams valid output items
# but get_final_response() can return an empty output list.
# Backfill from collected items or synthesize from deltas.
_out = getattr(final_response, "output", None)
if isinstance(_out, list) and not _out:
    if collected_output_items:
        final_response.output = list(collected_output_items)
        logger.debug("Codex stream: backfilled %d output items from stream events", ...)
    elif self._codex_streamed_text_parts and not has_tool_calls:
        assembled = "".join(self._codex_streamed_text_parts)
        final_response.output = [SimpleNamespace(
            type="message",
            role="assistant",
            status="completed",
            content=[SimpleNamespace(type="output_text", text=assembled)],
        )]
        logger.debug("Codex stream: synthesized output from %d text deltas (%d chars)", ...)
```

**Three-stage recovery:**
1. Trust `response.completed.response.output` if non-empty — happy path.
2. **Backfill** from `output_item.done` events collected during the stream.
3. **Synthesize** a single assistant message from accumulated `output_text.delta` text.

## Aiden gap (pre-fix)

`providers/v4/codexResponsesAdapter.ts::collectStreamedResponse` listens for the right events but **trusts `response.completed.response.output` verbatim**. When Codex sends `completed` with empty `output[]`, Aiden's `parseResponse` then throws "Provider chatgpt-plus returned no output items" — exactly the user-reported failure.

The text deltas Aiden collected go nowhere because `response.completed` overrides the local accumulator unconditionally.

## Decision

Port Hermes's three-stage recovery exactly. After collecting all events:

1. If `response.completed` arrived AND `event.response.output` is non-empty → use it.
2. Else if `output_item.done` events were collected → use them.
3. Else if `output_text.delta` events accumulated → synthesize one message item.
4. Else → throw the existing "no output items" error (genuine failure).

Also: log unknown event types (don't silently drop) per Hermes "fail loud" guidance. Gate behind `AIDEN_DEBUG_CODEX=1` so prod logs aren't noisy.
