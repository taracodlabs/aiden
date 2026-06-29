/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/uiLeakSanitizer.ts — v4.11 UI leak safety net
 *
 * Weak instruct models (llama-3.x, mistral, gemma, …) sometimes
 * misimitate the `## UI events` prompt guidance and emit pseudo
 * tool-call markup as TEXT content instead of firing a real
 * structured tool_call. Observed example from groq llama-3.3-70b
 * for a bare `"hi"`:
 *
 *     <ui_toast{"kind": "info", "message": "Hello!"}</ui_toast>
 *
 * This shape is NOT recognised by any of the three existing
 * legacy-syntax recovery parsers in chatCompletionsAdapter
 * (`<function=...>` paren / xml-obj / xml-arr · `<tool_call>` xml),
 * so it flows straight from `output.content` to `finalContent` to
 * `display.write(display.agentTurn(...))` and renders raw.
 *
 * `shouldInjectUiEventsGuidance` (in promptBuilder.ts) is the
 * primary defence — it gates the prompt block off for known-weak
 * model IDs so they're never taught the pattern. This file is the
 * safety net for any model that slips past the gate AND for the
 * cases where a model emits the markup despite not being taught.
 *
 * v1 policy: SILENT STRIP. Leak blocks are removed from the text
 * stream entirely; the JSON inside is NOT parsed and `onUiEvent`
 * is NOT fired (would risk a hallucinated event firing on the user's
 * UI). Surrounding text content is preserved verbatim.
 *
 * The match shape requires ALL of:
 *   - `<ui_NAME` opening (lowercase + underscore name)
 *   - optional whitespace
 *   - balanced `{ … }` JSON-like body (string-aware brace matching)
 *   - optional whitespace
 *   - `</ui_NAME>` closer with the SAME name
 *
 * A bare JSON example in prose like `Here's: {"foo": 1}` does NOT
 * match because the opening/closing `<ui_NAME>` tags are absent —
 * verified by the test suite.
 */

const UI_TAG_OPEN_PREFIX = '<ui_';
const UI_TAG_CLOSE_PREFIX = '</ui_';
/**
 * Streaming filter safety valve. If a `<ui_` opener appears in the
 * buffer and isn't matched within this many chars, give up and
 * flush the buffer as-is. Prevents indefinite hold-back on a real
 * stray `<ui_` in some other context (should never happen, but
 * better to leak markup than to hang the display).
 */
const STREAM_BUFFER_FLUSH_LIMIT = 4096;
/**
 * If the trailing N chars of the buffer COULD be the start of a
 * `<ui_` open tag (e.g. `<u`, `<ui`, `<ui_t`), hold them back until
 * the next chunk arrives. Beyond this length we know we're not
 * sitting on a partial opener. Length: longest possible prefix is
 * `<ui_` + a name char = 5; keep 16 for safety.
 */
const STREAM_TAIL_HOLDBACK = 16;

/**
 * Parse a tool name starting at `start` (the index of the first
 * character AFTER `<ui_`). Returns the end index + the name, or
 * `null` when the run is empty or contains a character outside
 * `[a-z_]`.
 */
function readUiToolName(text: string, start: number): { name: string; end: number } | null {
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    const isLower = ch >= 97 && ch <= 122;   // a-z
    const isUnder = ch === 95;               // _
    if (!isLower && !isUnder) break;
    i += 1;
  }
  if (i === start) return null;
  return { name: text.slice(start, i), end: i };
}

/**
 * Maximum scan window between an `<ui_NAME` opener and its matching
 * `</ui_NAME>` closer. Bounds the false-positive cost of an `<ui_`
 * appearing in unrelated prose with no real closer — without a cap
 * we'd scan to end-of-text on every hit. 8KB easily covers every
 * realistic ui_* event payload (the largest, `ui_artifact_created`
 * with a 200-char preview, is well under 1KB).
 */
const MAX_LEAK_ENVELOPE_CHARS = 8192;

/**
 * Try to recognise a single ui-leak envelope starting at `<ui_`
 * index `openIdx`. Returns the end-index (exclusive) of the
 * recognised envelope, or `null` when no complete leak is present
 * (caller treats the `<ui_` as ordinary text and advances past it).
 *
 * **Envelope-based matching (v4.11.1 widening).** The earlier
 * "name then `{`" matcher failed on the variant Llama-3.3 emitted
 * after the first ship — `<ui_toast>{...}</ui_toast>` with a
 * proper XML closer on the opening tag. Models can produce
 * arbitrary variants (`<ui_toast id="x">{…}</ui_toast>`,
 * `<ui_toast />{…}</ui_toast>`, whitespace/newlines, etc.); the
 * pattern that's actually invariant is the envelope:
 * `<ui_NAME…</ui_NAME>` with a JSON-looking payload inside.
 *
 * Recognition rule:
 *   1. Opener:  `<ui_NAME` where NAME matches [a-z_]+
 *   2. Closer:  the FIRST `</ui_NAME>` (matching name) within the
 *               envelope cap
 *   3. Payload: contains at least one `{` between opener and
 *               closer — pin to "looks like a tool call" so a
 *               pure-prose `<ui_about>` reference can't be eaten
 *
 * No brace-balance check on the payload — the closer tag bounds
 * the envelope regardless of malformed JSON. This is by design:
 * weak-model hallucinations may produce JSON with mismatched
 * quotes / unbalanced braces, and we'd rather strip them than
 * leave broken markup on screen.
 */
function tryMatchUiLeak(text: string, openIdx: number): number | null {
  // 1. Read the opening tool name.
  const nameInfo = readUiToolName(text, openIdx + UI_TAG_OPEN_PREFIX.length);
  if (!nameInfo) return null;
  const { name, end: afterName } = nameInfo;

  // 2. Find the matching closer within the envelope cap.
  const closer    = `${UI_TAG_CLOSE_PREFIX}${name}>`;
  const limit     = Math.min(text.length, openIdx + MAX_LEAK_ENVELOPE_CHARS);
  const closerIdx = text.indexOf(closer, afterName);
  if (closerIdx === -1 || closerIdx + closer.length > limit) return null;

  // 3. Verify the envelope payload contains a `{` — pins this to a
  //    tool-call-shaped emission and not stray prose. (We do NOT
  //    require brace-balance; weak-model output may be malformed
  //    JSON inside an otherwise-clear envelope.)
  const payload = text.slice(afterName, closerIdx);
  if (payload.indexOf('{') === -1) return null;

  return closerIdx + closer.length;
}

/**
 * Synchronous one-shot strip. Walks `text` looking for ui-leak
 * blocks and removes them. Non-matching `<ui_` runs are passed
 * through unchanged. Surrounding text is preserved byte-identical.
 *
 * Cheap fast-path: returns `text` unchanged when there's no `<ui_`
 * substring at all (the common case).
 *
 * Used at:
 *   - `aidenAgent.ts:1318` — `finalContent` assignment (catches the
 *     persisted/displayed final content for both non-stream and
 *     streaming paths, since both funnel through `output.content`).
 */
export function stripLeakedUiMarkup(text: string): string {
  if (!text || text.indexOf(UI_TAG_OPEN_PREFIX) === -1) return text;
  let out    = '';
  let cursor = 0;
  while (cursor < text.length) {
    const next = text.indexOf(UI_TAG_OPEN_PREFIX, cursor);
    if (next === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, next);
    const blockEnd = tryMatchUiLeak(text, next);
    if (blockEnd === null) {
      // Not a complete leak — emit the `<ui_` literally and advance
      // past it (so an embedded `<ui_partial` in prose doesn't loop).
      out    += UI_TAG_OPEN_PREFIX;
      cursor  = next + UI_TAG_OPEN_PREFIX.length;
    } else {
      // Skip the matched block entirely.
      cursor = blockEnd;
    }
  }
  return out;
}

// ── Streaming filter ───────────────────────────────────────────────────

/**
 * Per-call streaming filter. The display layer paints `onDelta`
 * chunks live, so a `<ui_toast{…}</ui_toast>` block split across
 * chunks would briefly render to screen before `stripLeakedUiMarkup`
 * cleans the final/archived content. This filter holds back
 * potentially-leak text in a buffer and only emits content that's
 * known-safe.
 *
 * Construction is per-call (each turn / each provider stream gets
 * its own filter — state is the in-flight buffer). Typical usage
 * inside aidenAgent's streaming consumer:
 *
 *     const filter = createStreamingUiLeakFilter();
 *     for await (const evt of stream) {
 *       if (evt.type === 'delta') {
 *         const safe = filter.feed(evt.content);
 *         if (safe) runOptions.onDelta?.(safe);
 *       }
 *       …
 *     }
 *     const trailing = filter.flush();
 *     if (trailing) runOptions.onDelta?.(trailing);
 *
 * Emit semantics:
 *   - chunk has no `<ui_` partial → emitted immediately
 *   - chunk contains a complete leak block → stripped before emit
 *   - chunk contains an in-progress leak (opener but no closer yet)
 *     → buffered until the closer arrives (or the buffer exceeds
 *     `STREAM_BUFFER_FLUSH_LIMIT`, at which point we flush as-is)
 *   - chunk ends with a possible-partial-opener (e.g. `…<ui`) → the
 *     trailing fragment is held back; the rest is emitted
 *
 * The filter is conservative: anything that could be the start of a
 * leak is held back. Anything we're confident is NOT a leak is
 * emitted promptly so streaming feels live.
 */
export interface StreamingUiLeakFilter {
  /** Append `chunk` and return whatever is safe to emit right now. */
  feed(chunk: string): string;
  /** End of stream — return whatever's buffered (no further holds). */
  flush(): string;
}

export function createStreamingUiLeakFilter(): StreamingUiLeakFilter {
  let buf = '';
  return {
    feed(chunk: string): string {
      buf += chunk;
      // Fast path: no `<ui_` anywhere — emit everything except a
      // trailing fragment that could BE the start of a `<ui_`.
      const openIdx = buf.indexOf(UI_TAG_OPEN_PREFIX);
      if (openIdx === -1) {
        // Hold back the tail in case the next chunk completes a `<ui_`.
        const safeLen = Math.max(0, buf.length - STREAM_TAIL_HOLDBACK);
        const emit    = buf.slice(0, safeLen);
        buf           = buf.slice(safeLen);
        return emit;
      }
      // Emit everything BEFORE the first `<ui_` immediately.
      let out = buf.slice(0, openIdx);
      buf     = buf.slice(openIdx);
      // Now buf starts with `<ui_`. Try to match a complete block.
      // If matched, strip it. If not yet complete but within the
      // buffer-flush limit, keep buffering. If buffer too long, give
      // up and flush — better to leak markup than hang display.
      while (buf.startsWith(UI_TAG_OPEN_PREFIX)) {
        const blockEnd = tryMatchUiLeak(buf, 0);
        if (blockEnd !== null) {
          // Strip the block, continue scanning the rest of the buffer.
          buf = buf.slice(blockEnd);
          // Find the next `<ui_` in the remainder; emit everything
          // before it; loop continues if another open is present.
          const nextOpen = buf.indexOf(UI_TAG_OPEN_PREFIX);
          if (nextOpen === -1) {
            const safeLen = Math.max(0, buf.length - STREAM_TAIL_HOLDBACK);
            out += buf.slice(0, safeLen);
            buf  = buf.slice(safeLen);
            return out;
          }
          out += buf.slice(0, nextOpen);
          buf  = buf.slice(nextOpen);
          continue;
        }
        // Not a complete block yet. Decide: keep buffering (waiting
        // for the closer) or flush as malformed.
        if (buf.length >= STREAM_BUFFER_FLUSH_LIMIT) {
          // Give up — emit the `<ui_` literally and advance past it
          // so we don't re-trigger. The rest of buf keeps scanning.
          out += UI_TAG_OPEN_PREFIX;
          buf  = buf.slice(UI_TAG_OPEN_PREFIX.length);
          const nextOpen = buf.indexOf(UI_TAG_OPEN_PREFIX);
          if (nextOpen === -1) {
            const safeLen = Math.max(0, buf.length - STREAM_TAIL_HOLDBACK);
            out += buf.slice(0, safeLen);
            buf  = buf.slice(safeLen);
            return out;
          }
          out += buf.slice(0, nextOpen);
          buf  = buf.slice(nextOpen);
          continue;
        }
        // Hold the buffer for more input.
        return out;
      }
      return out;
    },
    flush(): string {
      // End-of-stream — emit everything buffered. If the trailing
      // content is an incomplete leak we still emit it (better to
      // show the user something than swallow real content).
      const trailing = buf;
      buf = '';
      // BUT — one last chance to strip a complete leak (the closer
      // may have arrived in the final chunk but we held it back
      // pending the holdback tail). Run the one-shot strip too.
      return stripLeakedUiMarkup(trailing);
    },
  };
}
