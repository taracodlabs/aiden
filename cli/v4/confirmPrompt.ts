/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/confirmPrompt.ts — v4.9.2 SLICE 3.
 *
 * The slash-command `ctx.confirm()` primitive, extracted from the
 * chatSession closure so it has one source of truth + is unit-testable
 * without spinning up a full REPL.
 *
 * Behaviour:
 *   - Canonicalises the y/n hint: strips any caller-appended ` (y/N) `
 *     / ` [y/N] ` / ` (Y/n) ` so the primitive can append exactly one
 *     ` (y/N) ` in canonical lowercase-y / capital-N form.
 *   - Prefixes with a warn-tinted `?` glyph so the confirmation chrome
 *     is visually distinct from the main ▲ chat prompt (Slice 3 root
 *     cause: users couldn't tell a prompt was open).
 *   - Routes through `promptApi.readLine` with `suggestionsDisabled:true`
 *     so the inquirer-input path runs (no ghost-text from outer chat
 *     history, no slash dropdown — irrelevant for y/n).
 *   - Emits a per-input cancellation reason:
 *       empty / Enter alone   → "Cancelled (press 'y' to confirm; …)"
 *       'n' / 'no'            → "Cancelled."  (deliberate decline)
 *       other non-y           → `Cancelled ("<x>" not recognized — …)`
 *       null / non-string     → "Cancelled (no input)."
 *     Callers no longer print their own "Cancelled." line — the
 *     primitive owns the rejection message.
 */

/** Minimal display surface needed for the cancellation reason output. */
export interface ConfirmDisplay {
  paint(text: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted'): string;
  dim(text: string): void;
}

/** Minimal promptApi surface needed for reading the y/n answer. */
export interface ConfirmPromptApi {
  readLine(
    prompt: string,
    opts?: { suggestionsDisabled?: boolean },
  ): Promise<string>;
}

/** Strip any caller-appended `(y/N)` / `[y/N]` / `(Y/n)` so we can
 *  re-append the canonical hint without duplication. */
const TRAILING_YN_HINT_RE = /\s*[\[(](y\/[nN]|Y\/n)[\])]\s*$/i;

/**
 * Run a single confirmation prompt. Resolves to `true` on `y` / `yes`
 * (case insensitive, trimmed); `false` on anything else, with a
 * specific cancellation line written to `display.dim()`.
 *
 * Never throws — readLine errors and non-string returns degrade to
 * `false` with an honest "no input" reason.
 */
export async function runConfirm(
  msg:       string,
  promptApi: ConfirmPromptApi,
  display:   ConfirmDisplay,
): Promise<boolean> {
  const stripped  = msg.replace(TRAILING_YN_HINT_RE, '').trimEnd();
  const decorated = `${display.paint('?', 'warn')} ${stripped} (y/N) `;
  const r = await promptApi.readLine(decorated, { suggestionsDisabled: true });
  if (typeof r !== 'string') {
    display.dim('Cancelled (no input).');
    return false;
  }
  const trimmed = r.trim();
  if (/^(y|yes)$/i.test(trimmed)) return true;
  if (trimmed === '') {
    display.dim(`Cancelled (press 'y' to confirm; Enter alone = no).`);
  } else if (/^(n|no)$/i.test(trimmed)) {
    display.dim('Cancelled.');
  } else {
    display.dim(`Cancelled ("${trimmed}" not recognized — expected y/yes/n/no).`);
  }
  return false;
}
