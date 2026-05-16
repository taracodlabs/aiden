/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/promptTemplate.ts — v4.5 Phase 5a.
 *
 * Minimal `{{var}}` interpolation for trigger prompt templates.
 *
 * Per Q-P5-2(a): NO conditionals, NO loops, NO escapes. A trigger's
 * spec.promptTemplate is a one-line-or-multi-line string with
 * `{{path}}`, `{{event}}`, `{{from}}`, `{{subject}}` placeholders.
 * The dispatcher renders it with payload-derived variables when
 * deliverOnly is true OR the agent's initial message comes from a
 * template.
 *
 * Missing-variable behaviour: the placeholder is LEFT IN PLACE and
 * the name is collected in `missing`. The dispatcher decides what
 * to do — currently it classifies a non-empty `missing` array as
 * `trigger_misconfigured` when the template was non-empty.
 *
 * Whitespace inside braces tolerated: `{{ path }}` ≡ `{{path}}`.
 * Unknown shapes (nested braces, `{{ }}` empty name) fail soft:
 * left in place, not collected.
 *
 * Pure module — no I/O, no side effects, fully synchronous.
 */

/**
 * Result of rendering a template. `rendered` is the substituted
 * string; `missing` is the de-duplicated list of variable names
 * the template referenced but `vars` did not supply.
 */
export interface RenderedTemplate {
  rendered: string;
  missing:  string[];
}

/**
 * Acceptable variable value types. `null` / `undefined` are
 * treated as missing (matches the most common payload-extraction
 * pattern where optional fields land as undefined).
 */
export type TemplateVar = string | number | boolean | null | undefined;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Render a template with `{{var}}` placeholders.
 *
 * - Variables are looked up by exact name (after trimming whitespace).
 * - Numeric / boolean values are stringified via `String(v)`.
 * - `null` / `undefined` are treated as missing → placeholder left
 *   in the output AND the variable name pushed onto `missing`.
 * - Empty / whitespace-only template → returns `{ rendered: '', missing: [] }`.
 *
 * @param template Raw template string (may be empty).
 * @param vars Variable map. Excess keys are ignored.
 */
export function renderPromptTemplate(
  template: string,
  vars: Record<string, TemplateVar>,
): RenderedTemplate {
  if (typeof template !== 'string' || template.length === 0) {
    return { rendered: '', missing: [] };
  }

  const missingSet = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (match, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) {
      missingSet.add(name);
      return match;       // leave placeholder in place
    }
    return String(v);
  });

  return { rendered, missing: [...missingSet] };
}

/**
 * Convenience helper for the common case where the dispatcher
 * already has a TriggerEventRow payload + a few fixed fields
 * and wants to render the template for that event. Caller can
 * also call `renderPromptTemplate` directly with any var map.
 *
 * Variable shape varies by source — this helper just flattens
 * the payload into top-level keys (e.g. `payload.from` →
 * `{{from}}`). String/number/boolean values pass through;
 * objects/arrays are JSON-stringified so they're at least
 * substitutable (though usually undesirable in a user-facing
 * prompt — Phase 5b cron may extend this with `{{json:foo}}`
 * if needed).
 */
export function flattenPayloadToVars(
  payload: Record<string, unknown>,
): Record<string, TemplateVar> {
  const out: Record<string, TemplateVar> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      try { out[k] = JSON.stringify(v); }
      catch { out[k] = String(v); }
    }
  }
  return out;
}
