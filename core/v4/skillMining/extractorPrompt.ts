/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillMining/extractorPrompt.ts — Phase v4.1-skill-mining
 *
 * Optional LLM refinement pass on top of `proposalBuilder.draft()`.
 * The skeleton SKILL.md the builder produces is already a valid
 * v4 skill; the refiner only polishes prose. Two hard rules:
 *
 *   1. Structural fields are sacred — name, description, version,
 *      metadata.aiden.* must round-trip unchanged. We re-parse the
 *      refined output and discard it if any required field drifts.
 *
 *   2. Never write attribution tokens or "portions adapted from..." /
 *      "original copyright" strings. The permanent attribution
 *      sweep validates this; if a refined output contains any
 *      forbidden token, we fall back to the skeleton.
 *
 * If the auxiliary client is unavailable, the call times out, or
 * the refined output fails validation, the function returns the
 * skeleton unchanged. Mining works fully offline — refinement is
 * best-effort polish.
 */

import type { AuxiliaryClient } from '../auxiliaryClient';
import { parseSkillContent } from '../skillSpec';

const BANNED_TOKENS = [
  'portions adapted from',
  'original copyright',
  'derived from',
  'based on the',
  'adapted from',
];
const FORBIDDEN_TOKENS_RE = new RegExp(
  `\\b(${BANNED_TOKENS.join('|')})\\b`,
  'i',
);

const REFINER_SYSTEM_PROMPT = `
You polish auto-generated skill markdown for a local-first AI agent.

Your job is to improve the WORDING ONLY of an already-valid SKILL.md
file. The frontmatter (everything between the leading "---" markers)
must round-trip BYTE-FOR-BYTE unchanged. The "# <name>" heading must
stay first in the body. The numbered "## Steps" list must remain
numbered and in the same order; you may rephrase step descriptions
but must NOT add or remove steps.

Hard rules:
- Output the COMPLETE SKILL.md, not a diff.
- Do not add boilerplate, citations, or attribution to any other
  agent or codebase. The skill is 100% the user's own.
- Do not introduce mock/fake values into commands.
- Keep total length under 6000 characters.
`.trim();

export interface RefineOptions {
  /** Auxiliary client. When undefined, refine() returns the skeleton. */
  client?:    AuxiliaryClient;
  /** Override the auxiliary purpose (default 'skill_describe'). */
  maxTokens?: number;
  /** Override timeout (default 20000 ms). */
  timeoutMs?: number;
}

/**
 * Refine `skeleton` via the auxiliary client. Always returns a
 * valid SKILL.md string — either the refined output (if it passes
 * round-trip + no-attribution validation) or the original skeleton.
 */
export async function refine(
  skeleton: string,
  opts: RefineOptions = {},
): Promise<string> {
  const client = opts.client;
  if (!client || client.isUnavailable()) {
    return skeleton;
  }

  // Parse the skeleton up front to lock the canonical frontmatter
  // shape we'll require the refined output to match.
  let skeletonParsed;
  try {
    skeletonParsed = parseSkillContent(skeleton);
  } catch {
    // If the skeleton itself is invalid, refining can only make it
    // worse; bubble the skeleton out and let the caller decide.
    return skeleton;
  }

  const prompt =
    `${REFINER_SYSTEM_PROMPT}\n\n` +
    `INPUT SKILL.md:\n\`\`\`\n${skeleton}\n\`\`\`\n\n` +
    `Output the refined SKILL.md only — no commentary, no code fences.`;

  let refined: string;
  try {
    const result = await client.call({
      purpose:   'skill_describe',
      prompt,
      maxTokens: opts.maxTokens ?? 1500,
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
    refined = (result.content ?? '').trim();
  } catch {
    return skeleton;
  }

  if (refined.length === 0) return skeleton;

  // Strip a wrapping ```...``` if the model returned one.
  refined = refined.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '');

  // Validation 1 — attribution sweep. Refined output must not
  // contain any forbidden token. The permanent sweep would catch
  // this at ship time; we catch it earlier so a single noisy
  // refinement doesn't pollute the candidate queue.
  if (FORBIDDEN_TOKENS_RE.test(refined)) return skeleton;

  // Validation 2 — round-trip through parseSkillContent and verify
  // the canonical fields match the skeleton.
  let refinedParsed;
  try {
    refinedParsed = parseSkillContent(refined);
  } catch {
    return skeleton;
  }
  if (
    refinedParsed.frontmatter.name        !== skeletonParsed.frontmatter.name ||
    refinedParsed.frontmatter.version     !== skeletonParsed.frontmatter.version
  ) {
    return skeleton;
  }

  return refined;
}
