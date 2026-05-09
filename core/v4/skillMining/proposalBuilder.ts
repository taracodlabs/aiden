/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillMining/proposalBuilder.ts — Phase v4.1-skill-mining
 *
 * Pure-function skeleton SKILL.md generator from a successful tool-
 * call trace. Used by skillMiner BEFORE optional LLM refinement —
 * the skeleton must already be a valid v4 skill (parseSkillContent
 * round-trips), so that mining works offline when the auxiliary
 * client is unavailable.
 *
 * Invariants:
 *   - emits required fields `name`, `description`, `version`
 *   - emits `metadata.aiden` with the mining provenance fields
 *   - body is numbered tool-call steps in markdown
 *   - never writes attribution strings — the banned-token regex
 *     strips them at extraction time and the permanent attribution
 *     sweep validates the result
 */

export interface ProposalTraceEntry {
  name:    string;
  args?:   Record<string, unknown> | unknown;
  result?: unknown;
  error?:  unknown;
  toolset?: string | undefined;
}

export interface ProposalContext {
  /** First user message of the turn — used as the skill-name seed. */
  firstUserPrompt: string;
  /** Session id for provenance. */
  sourceSessionId: string;
  /** Turn index for provenance. */
  sourceTurnIdx:   number;
  /** Trace fingerprint for dedup metadata. */
  traceFingerprint: string;
  /** Confidence score 0..1 from skillMiner heuristics. */
  candidateConfidence: number;
  /** Optional override for the skill name (e.g. user-provided via /skills propose <name>). */
  nameOverride?: string;
}

const STOP_WORDS = new Set([
  'the','a','an','to','for','of','on','at','in','by','and','or','but','with',
  'from','please','can','you','will','do','does','my','our','this','that','these',
  'is','are','be','was','were','it','its','as','if','then','else','some','any',
  'me','i','your','their','his','her','him',
]);

/**
 * Derive a kebab-case skill-name from the first user message.
 * Conservative — keeps only [a-z0-9-], collapses runs, max 40 chars.
 * Falls back to `learned-skill-<short-fingerprint>` if extraction
 * yields nothing usable.
 */
export function deriveName(firstUserPrompt: string, fingerprint: string): string {
  const lowered = firstUserPrompt.toLowerCase();
  // Pull out non-stopword tokens, max 5 of them.
  const tokens = lowered
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    .slice(0, 5);
  let stem = tokens.join('-');
  // Strict alphanum-and-dash, collapse multiple dashes, trim leading/trailing.
  stem = stem.replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (stem.length === 0) {
    return `learned-skill-${fingerprint.slice(0, 8)}`;
  }
  return stem.slice(0, 40);
}

/**
 * Build the description line — single sentence summarising what the
 * trace did. Keep it under 200 chars (the skill loader caps the
 * displayed description in /skills list).
 */
export function deriveDescription(trace: ProposalTraceEntry[]): string {
  if (trace.length === 0) return 'Learned workflow.';
  const tools = trace.map((e) => e.name).filter(Boolean);
  const distinct = Array.from(new Set(tools));
  if (distinct.length === 1) {
    return `Learned workflow: ${distinct[0]} (${tools.length}x).`;
  }
  const head = distinct.slice(0, 4).join(' → ');
  const more = distinct.length > 4 ? ` (+${distinct.length - 4} more)` : '';
  return `Learned workflow: ${head}${more}.`;
}

/**
 * Render the body as numbered tool-call steps. Args are JSON-stringified
 * and clipped at 120 chars per step so a chatty trace doesn't bloat
 * SKILL.md to multi-MB.
 */
function renderBody(trace: ProposalTraceEntry[]): string {
  if (trace.length === 0) {
    return '## Steps\n\n_(empty trace)_\n';
  }
  const out: string[] = ['## Steps', ''];
  trace.forEach((entry, i) => {
    const idx = i + 1;
    const argSummary = (() => {
      if (entry.args == null || typeof entry.args !== 'object') return '';
      try {
        const json = JSON.stringify(entry.args);
        if (json.length <= 120) return `  \\\`${json}\\\``;
        return `  \\\`${json.slice(0, 117)}…\\\``;
      } catch {
        return '';
      }
    })();
    out.push(`${idx}. **${entry.name}**${argSummary}`);
  });
  out.push('');
  out.push('## Notes', '');
  out.push('Mined from a successful turn — review the steps above before relying on it.');
  out.push('');
  return out.join('\n');
}

/**
 * Build a full SKILL.md (frontmatter + body) ready for parseSkillContent.
 * The output is deterministic for a given (trace, context) input —
 * smokes assert this for stable round-trip behaviour.
 */
export function draft(
  trace: ProposalTraceEntry[],
  ctx:   ProposalContext,
): string {
  const name        = ctx.nameOverride?.trim() || deriveName(ctx.firstUserPrompt, ctx.traceFingerprint);
  const description = deriveDescription(trace);
  const version     = '0.1.0';
  const createdAt   = new Date().toISOString();

  // YAML frontmatter — keep field order stable so smokes can pin
  // shape without depending on YAML library output ordering.
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    `version: ${version}`,
    'category: learned',
    'metadata:',
    '  aiden:',
    '    learned: true',
    `    sourceSessionId: ${JSON.stringify(ctx.sourceSessionId)}`,
    `    sourceTurnIdx: ${ctx.sourceTurnIdx}`,
    `    createdAt: ${JSON.stringify(createdAt)}`,
    `    traceFingerprint: ${JSON.stringify(ctx.traceFingerprint)}`,
    `    candidateConfidence: ${ctx.candidateConfidence.toFixed(3)}`,
    '---',
    '',
    `# ${name}`,
    '',
    description,
    '',
  ].join('\n');

  return frontmatter + renderBody(trace);
}
