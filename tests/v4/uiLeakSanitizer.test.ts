/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/uiLeakSanitizer.test.ts — v4.11 UI leak safety net
 *
 * Covers `stripLeakedUiMarkup` (one-shot) +
 * `createStreamingUiLeakFilter` (chunked) +
 * `shouldInjectUiEventsGuidance` (predicate gate).
 *
 * Anchor case — the literal symptom from groq llama-3.3 for a
 * bare "hi" turn must strip to empty content.
 */
import { describe, it, expect } from 'vitest';
import {
  stripLeakedUiMarkup,
  createStreamingUiLeakFilter,
} from '../../core/v4/uiLeakSanitizer';
import { shouldInjectUiEventsGuidance } from '../../core/v4/promptBuilder';

// ── shouldInjectUiEventsGuidance predicate ────────────────────────────

describe('shouldInjectUiEventsGuidance', () => {
  it('returns OFF for known-weak instruct models', () => {
    expect(shouldInjectUiEventsGuidance('llama-3.3-70b-versatile')).toBe(false);
    expect(shouldInjectUiEventsGuidance('llama-3.1-8b-instant')).toBe(false);
    expect(shouldInjectUiEventsGuidance('llama-3.2-90b-vision')).toBe(false);
    expect(shouldInjectUiEventsGuidance('llama3.0-70b')).toBe(false);
    expect(shouldInjectUiEventsGuidance('mistral-7b-instruct')).toBe(false);
    expect(shouldInjectUiEventsGuidance('mistral-large-2407')).toBe(false);
    expect(shouldInjectUiEventsGuidance('gemma-2-9b')).toBe(false);
    expect(shouldInjectUiEventsGuidance('qwen2.5-7b-instruct')).toBe(false);
    expect(shouldInjectUiEventsGuidance('qwen2-14b-instruct')).toBe(false);
    expect(shouldInjectUiEventsGuidance('phi-3-mini')).toBe(false);
    expect(shouldInjectUiEventsGuidance('phi-4-multimodal')).toBe(false);
  });

  it('returns ON for capable models that handle the guidance', () => {
    expect(shouldInjectUiEventsGuidance('claude-opus-4-7')).toBe(true);
    expect(shouldInjectUiEventsGuidance('claude-sonnet-4-6')).toBe(true);
    expect(shouldInjectUiEventsGuidance('claude-haiku-4-5')).toBe(true);
    expect(shouldInjectUiEventsGuidance('gpt-4o-2024-11-20')).toBe(true);
    expect(shouldInjectUiEventsGuidance('gpt-5')).toBe(true);
    expect(shouldInjectUiEventsGuidance('o1-pro')).toBe(true);
  });

  it('returns ON for larger Qwen variants (the gate is small-only)', () => {
    expect(shouldInjectUiEventsGuidance('qwen2.5-32b-instruct')).toBe(true);
    expect(shouldInjectUiEventsGuidance('qwen3-72b')).toBe(true);
  });

  it('returns ON for undefined / empty modelId (default)', () => {
    expect(shouldInjectUiEventsGuidance(undefined)).toBe(true);
    expect(shouldInjectUiEventsGuidance('')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(shouldInjectUiEventsGuidance('LLAMA-3.3-70B-VERSATILE')).toBe(false);
    expect(shouldInjectUiEventsGuidance('Mistral-7B')).toBe(false);
  });
});

// ── stripLeakedUiMarkup one-shot ──────────────────────────────────────

describe('stripLeakedUiMarkup — required assertions', () => {
  it('strips the literal symptom string (groq llama-3.3 bare "hi", v1 variant)', () => {
    // v1 leak: name then JSON directly, no `>` closer on the opener.
    const symptom = '<ui_toast{"kind": "info", "message": "Hello!"}</ui_toast>';
    expect(stripLeakedUiMarkup(symptom)).toBe('');
  });

  it('strips the v2 variant (proper `>` opener — observed after the first ship)', () => {
    // v2 leak Llama-3.3 emitted after the v4.11 first ship: the
    // opener carries the XML closing `>`, JSON sits between proper
    // open/close tags. Envelope-based matcher must catch this.
    const v2 = '<ui_toast>{"kind": "info", "message": "Hello!"}</ui_toast>';
    expect(stripLeakedUiMarkup(v2)).toBe('');
  });

  it('strips XML-attribute variants (defensive, not yet observed)', () => {
    const attrs = '<ui_toast id="x" class="y">{"k":"v"}</ui_toast>';
    expect(stripLeakedUiMarkup(attrs)).toBe('');
  });

  it('strips self-closing-style + JSON variants (defensive)', () => {
    const sc = '<ui_toast />{"k":"v"}</ui_toast>';
    expect(stripLeakedUiMarkup(sc)).toBe('');
  });

  it('does NOT strip valid JSON-in-text that is not a ui_* event', () => {
    const benign = 'Here is an example: {"foo": 1}';
    expect(stripLeakedUiMarkup(benign)).toBe(benign);
  });

  it('does NOT strip JSON in markdown code fences', () => {
    const code = 'Use this config:\n```json\n{"key": "value"}\n```\nDone.';
    expect(stripLeakedUiMarkup(code)).toBe(code);
  });

  it('preserves surrounding text byte-identically when stripping', () => {
    const input = 'Before <ui_toast{"k":"v"}</ui_toast> after';
    expect(stripLeakedUiMarkup(input)).toBe('Before  after');
  });

  it('strips every recognised ui_* tool name', () => {
    const inputs = [
      '<ui_task_update{"a":1}</ui_task_update>',
      '<ui_task_done{"a":1}</ui_task_done>',
      '<ui_command_result{"a":1}</ui_command_result>',
      '<ui_test_result{"a":1}</ui_test_result>',
      '<ui_approval_request{"a":1}</ui_approval_request>',
      '<ui_artifact_created{"a":1}</ui_artifact_created>',
    ];
    for (const x of inputs) expect(stripLeakedUiMarkup(x)).toBe('');
  });

  it('strips multiple leaks in one text', () => {
    const multi =
      'Start <ui_toast{"a":1}</ui_toast> middle ' +
      '<ui_task_done{"b":2}</ui_task_done> end';
    expect(stripLeakedUiMarkup(multi)).toBe('Start  middle  end');
  });

  it('handles JSON-with-braces-inside-strings correctly', () => {
    // The `}` inside the string literal must NOT close the brace early.
    const tricky =
      '<ui_toast{"message": "an object: {nested: true}"}</ui_toast>';
    expect(stripLeakedUiMarkup(tricky)).toBe('');
  });

  it('handles escaped quotes inside JSON strings', () => {
    const escaped =
      '<ui_toast{"message": "he said \\"hi\\""}</ui_toast>';
    expect(stripLeakedUiMarkup(escaped)).toBe('');
  });

  it('leaves incomplete/malformed leak markers as-is', () => {
    // Missing closer → not a complete leak.
    const incomplete = '<ui_toast{"k":"v"}';
    expect(stripLeakedUiMarkup(incomplete)).toBe(incomplete);
    // Mismatched name in closer.
    const mismatched = '<ui_toast{"k":"v"}</ui_other>';
    expect(stripLeakedUiMarkup(mismatched)).toBe(mismatched);
    // No `{` in payload → prose reference, not a leak (envelope guard).
    const proseOnly = 'See <ui_toast></ui_toast> in the docs.';
    expect(stripLeakedUiMarkup(proseOnly)).toBe(proseOnly);
  });

  it('fast-path returns input unchanged when no `<ui_` substring', () => {
    const plain = 'Just a normal reply. No markup here.';
    expect(stripLeakedUiMarkup(plain)).toBe(plain);
  });

  it('handles empty / falsy input', () => {
    expect(stripLeakedUiMarkup('')).toBe('');
  });

  it('whitespace flexibility (tabs, newlines, spaces between parts)', () => {
    const ws = '<ui_toast\n  {"k": "v"}\n</ui_toast>';
    expect(stripLeakedUiMarkup(ws)).toBe('');
  });
});

// ── Streaming filter (chunked delivery) ────────────────────────────────

describe('createStreamingUiLeakFilter', () => {
  it('strips a leak split across multiple delta chunks', () => {
    const filter = createStreamingUiLeakFilter();
    // Simulate the symptom split mid-block.
    let emitted = '';
    emitted += filter.feed('<ui_toa');
    emitted += filter.feed('st{"kind"');
    emitted += filter.feed(': "info", "message": "Hi!"}');
    emitted += filter.feed('</ui_toast>');
    emitted += filter.flush();
    expect(emitted).toBe('');
  });

  it('emits prose before a leak immediately', () => {
    const filter = createStreamingUiLeakFilter();
    // Long enough chunk that the holdback tail leaves a healthy
    // early-emit (holdback is 16 chars).
    const first = filter.feed(
      'Greetings! Here is a long leading sentence well past the holdback tail',
    );
    expect(first.length).toBeGreaterThan(0);
    expect(first.startsWith('Greetings! Here is a')).toBe(true);
    // Now finish off — leak block + closer.
    let rest  = filter.feed(' followed by <ui_toast{"k":"v"}</ui_toast>!');
    rest     += filter.flush();
    // Combined, the leak is stripped, everything else preserved.
    expect(first + rest).toBe(
      'Greetings! Here is a long leading sentence well past the holdback tail followed by !',
    );
  });

  it('passes through valid JSON-in-text without false-positive strip', () => {
    const filter = createStreamingUiLeakFilter();
    let out  = filter.feed('Here is an example: ');
    out     += filter.feed('{"foo": 1}');
    out     += filter.flush();
    expect(out).toBe('Here is an example: {"foo": 1}');
  });

  it('passes plain text through with only the holdback tail buffered', () => {
    const filter = createStreamingUiLeakFilter();
    const out = filter.feed('hello world, this is just plain text');
    // Holdback is ~16 chars, but everything before that is emitted live.
    expect(out.length).toBeGreaterThan(15);
    expect(out + filter.flush()).toBe('hello world, this is just plain text');
  });

  it('flushes incomplete leak as text on stream end (safety valve)', () => {
    const filter = createStreamingUiLeakFilter();
    let out  = filter.feed('<ui_toast{"k":"v"}');   // no closer
    out     += filter.flush();
    // No matching close arrived; v1 silent-strip never fires for
    // partial leaks → the buffered text is emitted as-is on flush.
    expect(out).toBe('<ui_toast{"k":"v"}');
  });

  it('strips two leaks back-to-back across chunks', () => {
    const filter = createStreamingUiLeakFilter();
    let out  = filter.feed('A <ui_toast{"x":1}</ui_toast> B ');
    out     += filter.feed('<ui_task_done{"y":2}</ui_task_done> C');
    out     += filter.flush();
    expect(out).toBe('A  B  C');
  });

  it('does not break a chunk that contains both a leak and a tail-partial', () => {
    const filter = createStreamingUiLeakFilter();
    let out  = filter.feed('text <ui_toast{"a":1}</ui_toast> end <u');
    // `<u` is held back (could be `<ui_`).
    out     += filter.feed('nrelated text');
    out     += filter.flush();
    expect(out).toBe('text  end <unrelated text');
  });
});
