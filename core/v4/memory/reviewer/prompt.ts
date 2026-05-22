/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/reviewer/prompt.ts — v4.9.0 Slice 10.
 *
 * Reviewer system prompt + the on-disk wire format parser. The reviewer
 * LLM is told to emit one candidate per line, pipe-delimited:
 *
 *   <file>|<text>|<rationale>
 *
 * where `<file>` is `memory` or `user`. Lines that don't match the
 * shape, or that propose unknown files, are silently dropped — they
 * count toward the `parser_drops` telemetry counter but don't fail
 * the whole review.
 */

import type { MemoryFile } from '../../memoryManager';
import { listNamespaceNames } from '../namespaceRegistry';

export interface ReviewerCandidate {
  file:      MemoryFile;
  text:      string;
  rationale: string;
}

export interface BuildPromptOptions {
  recentTurns: ReadonlyArray<{ role: string; content: string }>;
  liveMemory:  string;
  liveUser:    string;
  maxCandidates: number;
}

/**
 * Reviewer system prompt. Conservative, skip-rules-first. The LLM is
 * told to follow these rules; the parser + skipRules drop any
 * candidate that slips through anyway.
 */
export function buildReviewerPrompt(opts: BuildPromptOptions): string {
  const turnText = opts.recentTurns
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n');
  return [
    'You are Aiden\'s post-turn memory reviewer. You read the recent',
    'conversation and propose AT MOST ' + String(opts.maxCandidates) +
      ' additions to long-term memory.',
    '',
    'STRICT RULES (a candidate that violates ANY rule is DROPPED):',
    // v4.9.0 Slice 11 — namespaces are now dynamic. The parser drops
    // any candidate whose `<file>` field isn't in the registry; the
    // skip-rule pass drops `project` candidates when no project root
    // is detected.
    '  - <file> must be one of: ' + listNamespaceNames().join(', ') + '.',
    '    `memory` = project / environment / Aiden facts (global).',
    '    `user`   = user identity / preferences / workflow style.',
    '    `project` (when available) = current-repo-specific context.',
    '  - NO negations ("user does not X", "no longer Y"). Skip them.',
    '  - NO transient artifacts ("today", "this session", "just now").',
    '  - NO sensitive inference (health, politics, religion, finance,',
    '    sexual orientation, family planning). NEVER propose these.',
    '  - NO duplicates of what is already in memory below.',
    '  - Each candidate <= 200 chars.',
    '',
    'OUTPUT FORMAT — one candidate per line, exactly:',
    '  <file>|<text>|<rationale>',
    'where <file> ∈ {memory, user}. No prose, no headers, no markdown.',
    'If nothing is worth proposing, return an empty response.',
    '',
    '=== CURRENT live MEMORY.md ===',
    opts.liveMemory || '(empty)',
    '',
    '=== CURRENT live USER.md ===',
    opts.liveUser || '(empty)',
    '',
    '=== RECENT CONVERSATION TURNS ===',
    turnText || '(no turns)',
    '',
    'Now propose candidates:',
  ].join('\n');
}

/**
 * Parse the LLM response into structured candidates. Drops lines that
 * don't match `<file>|<text>|<rationale>` or use an unknown file. The
 * caller's skipRules pass over each result for additional validation.
 */
export function parseReviewerResponse(raw: string): { candidates: ReviewerCandidate[]; parserDrops: number } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const out: ReviewerCandidate[] = [];
  let drops = 0;
  for (const line of lines) {
    // Strip leading bullets / numbering the LLM may have added despite instructions.
    const cleaned = line.replace(/^[-*\d.)\s]+/, '');
    const parts = cleaned.split('|').map((p) => p.trim());
    if (parts.length < 3) { drops += 1; continue; }
    const [file, text, ...rest] = parts;
    // v4.9.0 Slice 11 — accept any registered namespace name. The
    // reviewer orchestrator's skip-rule pass drops `project`
    // candidates when no project root resolves.
    if (!listNamespaceNames().includes(file)) { drops += 1; continue; }
    const rationale = rest.join('|').trim();
    if (!text || !rationale) { drops += 1; continue; }
    out.push({ file: file as MemoryFile, text, rationale });
  }
  return { candidates: out, parserDrops: drops };
}
