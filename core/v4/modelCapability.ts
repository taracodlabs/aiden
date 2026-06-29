/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/modelCapability.ts — v4.11
 *
 * Single source of truth for "is this a weak instruct model?" — the
 * predicate that drives BOTH prompt-guidance narrowing and tool-catalog
 * narrowing so the two never disagree.
 *
 * "Weak" here means: instruct-tuned models observed to imitate Aiden's
 * `name {args}` tool pseudocode as XML-wrapped TEXT instead of firing
 * real tool_calls — e.g. groq llama-3.3 emitting a literal
 * `<ui_toast{"kind":"info"}</ui_toast>` in the assistant reply for a
 * bare "hi". These models can't follow the conditional ui_* usage rules
 * reliably, so we (a) drop the `## UI events` guidance block and (b)
 * strip the `ui` toolset from their catalog entirely — removing the
 * temptation and the markup at the source. The `stripLeakedUiMarkup`
 * sanitizer (core/v4/uiLeakSanitizer.ts) stays as defense-in-depth for
 * any model this list doesn't yet enumerate.
 *
 * Keyed on the model id string only — no provider coupling, no network.
 * Unknown / missing id → treated as capable (false): better to over-ship
 * tools to an unrecognised model (the sanitizer still guards output) than
 * to silently strip capability from a model we simply don't recognise.
 */

/**
 * True when `modelId` names a known-weak instruct family that leaks ui_*
 * markup / mishandles conditional tool rules. Used by the prompt builder
 * (guidance gate) and the boot tool-catalog assembly (ui toolset strip).
 */
export function isWeakModel(modelId: string | undefined): boolean {
  if (!modelId) return false;                   // unknown → assume capable
  const id = modelId.toLowerCase();
  // Llama 3.0 / 3.1 / 3.2 / 3.3 — observed leak source.
  if (/llama-?3\.[0-3]/.test(id))             return true;
  // Mistral instruct family — same conditional-rule failure pattern.
  if (/\bmistral\b/.test(id))                 return true;
  // Gemma — same.
  if (/\bgemma\b/.test(id))                   return true;
  // Smaller Qwen variants (7B / 14B). Larger Qwen3-32B+ handle it.
  if (/\bqwen2(\.5)?[-_](7|14)b\b/.test(id))  return true;
  // Phi instruct family.
  if (/\bphi-?\d/.test(id))                   return true;
  return false;
}
