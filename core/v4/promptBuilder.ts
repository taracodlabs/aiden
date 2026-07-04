/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * core/v4/promptBuilder.ts
 *
 * Slot-ordered system-prompt assembler. Aiden builds its system prompt
 * once per session by stacking eight optional slots in a fixed order:
 *
 *   1. SOUL.md          (identity — falls back to DEFAULT_SOUL_MD)
 *   2. Personality      (overlay set by /personality)
 *   3. MEMORY.md        (agent's personal notes; identity-framed)
 *   4. USER.md          (user profile; identity-framed)
 *   5. Active skills    (compact list; gated by Skills (mandatory) header)
 *   6. Llama-3.3 hint   (only when modelId matches; defends the tool path)
 *   7. Iteration budget (initial counter)
 *   8. Environment      (platform / cwd / date)
 *
 * The whole string is deterministic given identical options — Anthropic's
 * prefix cache and OpenAI's implicit cache both index on the prompt
 * prefix, so a stable build means we hit cache on every subsequent turn
 * within the same session.
 *
 * Empty slots vanish from the output entirely; they don't leave blank-line
 * gaps (tests 6, 4d). The rendering layer also exposes two turn-time
 * helpers that are NOT part of the frozen prompt:
 *
 *   renderToolsForTurn(tools)  — `## Active tools` block per turn.
 *   renderBudgetSnippet(used, max) — counter line for live progress.
 */

import { promises as fs }  from 'node:fs';
import os                  from 'node:os';
import type { AidenPaths }      from './paths';
import type { ConfigManager }   from './config';
import type { MemorySnapshot }  from './memoryProvider';
import type { ToolSchema }      from '../../providers/v4/types';
import { isWeakModel }          from './modelCapability';
// When SOUL.md is missing or whitespace-only the bundled default takes
// over so a fresh install still has a working identity.
import { DEFAULT_SOUL_MD } from '../../cli/v4/defaultSoul';
// Phase v4.1.2-followup: runtime-injected version + capabilities slot.
import { buildRuntimeManifest, renderRuntimeSlot } from './capabilities';

// ── Public types ───────────────────────────────────────────────────────

export interface PromptSlot {
  name:     string;
  content:  string;
  optional: boolean;
}

export interface PromptBuilderOptions {
  paths:                AidenPaths;
  config?:              ConfigManager;
  memorySnapshot?:      MemorySnapshot;
  // v4.12 OM.1 — category/trustLevel/userModified drive posture-aware names-only
  // demotion (off-posture / low-trust entries keep their NAME but drop the teaser).
  skillsList?:          Array<{
    name: string;
    description: string;
    category?: string;
    trustLevel?: string;
    userModified?: boolean;
  }>;
  /**
   * Phase v4.1.2 alive-core: which tool-set tags are currently loaded
   * in the agent's ToolRegistry. Each known toolset unlocks a paragraph
   * of behavioural guidance (slot 4.5). Caller builds this from
   * `toolRegistry.list().map(name => registry.get(name)?.toolset)`.
   */
  toolsetsLoaded?:      Set<string>;
  /**
   * Phase v4.1.2-followup self-awareness: count of tools currently
   * registered. Drives the `Tools loaded: N` line in the `## Runtime`
   * slot. Caller passes `toolRegistry.list().length`.
   */
  toolCount?:           number;
  /**
   * Phase v4.1.2-followup self-awareness: current provider id (e.g.
   * 'chatgpt-plus', 'groq'). Drives the `Provider:` line in the
   * `## Runtime` slot. `modelId` already exists below.
   */
  providerId?:          string;
  personalityOverlay?:  string;
  initialBudget?:       { used: number; max: number };
  platform?:            'windows' | 'linux' | 'macos';
  cwd?:                 string;
  /** When true the SOUL.md disk read is skipped entirely (used by tests). */
  skipFilesystem?:      boolean;
  /**
   * Target model id. When it matches `/llama-?3\.3/i` an extra slot warns
   * the model away from the legacy `<function=name({args})>` syntax —
   * Llama-3.3 fine-tunes (notably Groq's `llama-3.3-70b-versatile`)
   * regress to that format under tool pressure. The chat-completions
   * adapter recovers anyway, but the prompt nudge prevents the round trip.
   */
  modelId?:             string;
}

// ── Section header / sentinel string contract ─────────────────────────
//
// Every literal here is part of the API contract pinned by tests. Header
// strings drive the model's attention; changing them silently is a
// behavioural change disguised as a string edit.

const HEADER_SKILLS         = '## Skills (mandatory)';
const HEADER_TOOLS          = '## Active tools';
const HEADER_BUDGET         = '## Iteration budget';
const HEADER_ENVIRONMENT    = '## Environment';

const TAG_AVAILABLE_SKILLS  = 'available_skills';

const RULE_HEAVY            = '═'.repeat(60);
const RULE_LIGHT            = '─'.repeat(60);

const NOTE_USER_LIVE        = '[System note: Treat as live identity, not past conversation.]';
const NOTE_MEMORY_LIVE      = '[System note: Treat as live working memory, not past conversation.]';

const SKILLS_LOAD_NOTE =
  'You MUST load it first via the `skill_view` tool before invoking ' +
  'the underlying capability. Skills carry the procedure the tools alone don\'t.';

// v4.11 Skill Injection Narrowing — the index below carries only a
// first-sentence teaser per skill (see `narrowSkillDesc`). This line
// closes the routing gap that creates: when the teaser is too thin to
// disambiguate, the model pulls the full descriptions on demand rather
// than guessing. `skills_list` stays a full, un-narrowed copy.
const SKILLS_MATCH_NUDGE =
  'If no skill above clearly matches the task, call `skills_list` for the ' +
  'full descriptions before deciding.';

/**
 * Phase v4.1.2 alive-core: when the user has authored a real SOUL.md
 * (not the bundled default), prepend a one-line embodiment directive
 * to its content. The directive tells the model to *be* the identity,
 * not narrate about it — closes the most common "stiff generic reply"
 * failure mode where the model paraphrases SOUL.md back at the user.
 *
 * Intentionally suppressed when the identity slot falls back to
 * DEFAULT_SOUL_MD: that text is generic by design and the directive
 * would coach the model to perform a flat persona.
 */
const EMBODIMENT_DIRECTIVE =
  'Embody this identity and tone. Speak as Aiden, not about Aiden. ' +
  'Avoid generic, stiff replies.';

/**
 * Phase v4.1.2 alive-core: tool-conditional guidance blocks. Each one
 * is injected only when the corresponding toolset tag is in
 * `opts.toolsetsLoaded`. Replaces the "fixed slot order regardless of
 * capability" assumption — persona shape-shifts per available
 * capability (prior-art pattern surfaced during v4.2 recon).
 *
 * Key match strings:
 *   - 'memory'         → MEMORY_GUIDANCE
 *   - 'session-search' → SESSION_SEARCH_GUIDANCE
 *   - 'skills'         → SKILLS_GUIDANCE
 *
 * Match the strings in `ToolHandler.toolset` on the registered tools
 * (tools/v4/memory/*.ts ships `toolset: 'memory'`,
 * tools/v4/sessions/sessionSearch.ts ships `toolset: 'session-search'`,
 * skill tools ship `toolset: 'skills'`).
 */
const MEMORY_GUIDANCE = [
  '## Persistent memory',
  '',
  'You have persistent memory across sessions. Save durable facts using `memory_add`:',
  'user preferences, environment details, stable conventions. Memory is injected into',
  'every turn; keep it compact and focused on facts that will still matter later.',
  'Prioritize what reduces future user steering.',
].join('\n');

const SESSION_SEARCH_GUIDANCE = [
  '## Session recall',
  '',
  'When the user references something from a past conversation or you suspect',
  'relevant cross-session context exists, use `session_search` to recall it before',
  'asking them to repeat themselves.',
].join('\n');

const SKILLS_GUIDANCE = [
  '## Skill upkeep',
  '',
  'After completing a complex task (5+ tool calls), fixing a tricky error, or',
  'discovering a non-trivial workflow, save it as a skill so you can reuse it next',
  'time. When using an existing skill and finding it outdated, patch it immediately',
  '— don\'t wait to be asked.',
].join('\n');

/**
 * Phase v4.1.2 alive-core: execution-discipline prose. Counters the
 * "I'll run the tests" → no tool call → end-of-turn failure mode by
 * making the contract explicit. Injected when
 * `shouldInjectExecutionDiscipline(modelId)` is true (currently always).
 */
const EXECUTION_DISCIPLINE_PROSE = [
  '## Tool use enforcement',
  '',
  'When you say you will perform an action ("I\'ll run the tests", "let me check the',
  'file"), you MUST immediately make the corresponding tool call in the same response.',
  'Never end your turn with a promise of future action — execute it now. Every',
  'response should either contain tool calls that make progress, or deliver a final',
  'result. When the user requests an action, take it. When the user requests',
  'discussion, discuss.',
].join('\n');

/**
 * v4.8.0 Phase 2.6 — UI events nudge. Without this, the model only
 * emits ui_* tools when explicitly told to (e.g. "call ui_task_update
 * with ..."). With it, events fire during normal multi-step work —
 * research, file creation, test runs, command execution. Always-on:
 * every model that sees the ui_* tools benefits.
 */
const UI_EVENTS_GUIDANCE = [
  '## UI events',
  '',
  'When doing multi-step work, emit structured progress signals INSTEAD OF',
  'writing them as text. The user sees these as inline rows separate from',
  'your prose reply.',
  '',
  'WRONG (do NOT do this):',
  '  "✓ Done — found 3 results"',
  '  "⟳ Searching the web..."',
  '  "Created hello.py"',
  '',
  'RIGHT:',
  '  ui_task_update {task_id, label, status: "running"}',
  '  ui_task_done   {task_id, status: "success", summary}',
  '  ui_artifact_created {path, kind: "file", preview}',
  '',
  'When to fire each:',
  '- ui_task_update + ui_task_done for any multi-step task (pair them by task_id)',
  '- ui_command_result after shell_exec when the output is interesting',
  '- ui_test_result after running tests',
  '- ui_toast for transient notices (e.g. "switched to dark mode")',
  '- ui_artifact_created when you create or modify a file/skill',
  '- ui_approval_request fires automatically for risky tools — NEVER emit it manually',
  '',
  'Markdown text in your reply is for explanation, not status. Status goes',
  'through events. Skip events entirely on single-shot queries that aren\'t',
  'multi-step work.',
  '',
  '## Comparison formatting',
  '',
  'For comparison requests, prefer sectioned lists or narrow tables (3 cols max).',
  'Wide tables (4+ columns or cells over ~30 chars) render imperfectly in the',
  'CLI grid — break long content into sections with headers + bullets instead.',
].join('\n');

/**
 * Llama-3.3-specific tool-call format guard. Adapter-side recovery picks
 * up failures, but we'd rather avoid the 400 round-trip.
 */
const LLAMA_33_TOOL_CALL_HINT =
  'When using tools, ALWAYS use the OpenAI tool_calls JSON format. ' +
  'NEVER emit `<function=name({args})>` syntax inline in your text — ' +
  'that is a legacy format that will be rejected.';

// ── Public helpers ────────────────────────────────────────────────────

/** Exposed for tests. Recognises every Llama-3.3 ID we route through. */
export function shouldInjectLlama33ToolHint(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return /llama-?3\.3/i.test(modelId);
}

/**
 * Phase v4.1.2: predicate for the execution-discipline prose slot.
 * Currently always-on — the "act, don't narrate" directive helps every
 * tool-using model we route through. Narrow this if a specific model
 * proves counter-productive; better to over-apply a useful prompt than
 * guess incorrectly which models need it.
 */
export function shouldInjectExecutionDiscipline(_modelId: string | undefined): boolean {
  return true;
}

/**
 * v4.11 — predicate for the `## UI events` guidance slot.
 *
 * Default ON. Disabled for known-weak instruct models that imitate
 * the `name {args}` pseudocode as XML-wrapped text instead of firing
 * proper tool_calls — e.g. groq llama-3.3 emitting
 * `<ui_toast{"kind":"info"}</ui_toast>` literally in the assistant
 * reply for a bare "hi". The guidance teaches a conditional rule
 * ("skip events on single-shot queries") that weak models don't
 * follow reliably; removing the guidance removes the temptation.
 *
 * Bonus side-effect: ~250 prompt tokens saved per turn on weak
 * models (the block is the third-largest static section).
 *
 * The sibling sanitizer `stripLeakedUiMarkup`
 * (core/v4/uiLeakSanitizer.ts) is the safety net for the cases this
 * gate misses — any future model that imitates the pattern is
 * caught by the post-hoc scrub.
 *
 * v4.11 — the weak-model decision now lives in `isWeakModel`
 * (core/v4/modelCapability.ts) so this guidance gate and the boot
 * tool-catalog `ui` strip share ONE predicate and can never disagree.
 */
export function shouldInjectUiEventsGuidance(modelId: string | undefined): boolean {
  return !isWeakModel(modelId);
}

// ── Internal helpers ──────────────────────────────────────────────────

function detectPlatform(): 'windows' | 'linux' | 'macos' {
  const p = os.platform();
  if (p === 'win32')  return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

/**
 * Read a file and return its contents — or `null` when the file is
 * missing, unreadable, or whitespace-only. SOUL.md/MEMORY.md/USER.md
 * all share this contract so an empty file behaves the same as a
 * missing one.
 */
async function readNonEmpty(filePath: string): Promise<string | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Build a date stamp that's stable within a session. Day-precision is
 * sufficient for the model and keeps `build()` deterministic across
 * within-day calls so prompt-cache hits are predictable.
 */
function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
}

// ── Section formatters ────────────────────────────────────────────────

/**
 * Identity-framed wrapper around a memory blob. Both heavy `═══` rules
 * and the live-vs-past system note are part of the test contract — they
 * stop the model from reading MEMORY.md / USER.md as transcript replay.
 */
function frameIdentityBlock(
  title:       string,
  systemNote:  string,
  body:        string,
): string {
  return [
    RULE_HEAVY,
    title,
    systemNote,
    RULE_LIGHT,
    body.trim(),
    RULE_HEAVY,
  ].join('\n');
}

function formatMemorySection(memoryMd: string): string {
  return frameIdentityBlock(
    'MEMORY (your personal notes)',
    NOTE_MEMORY_LIVE,
    memoryMd,
  );
}

function formatUserSection(userMd: string): string {
  return frameIdentityBlock(
    'USER PROFILE (who the user is)',
    NOTE_USER_LIVE,
    userMd,
  );
}

/**
 * v4.12 — speaks-first onboarding nudge. Injected (in place of the USER
 * PROFILE block) only when USER.md is empty: the user hasn't been onboarded
 * yet. Instructs honest extraction — save ONLY the facts the user actually
 * states, never inferred ones — into USER.md via the existing memory_add
 * tool. Personalization (work-relevant facts), not companionship.
 */
const ONBOARDING_NUDGE = [
  '## Getting to know the user',
  '',
  'You have no saved profile for this user yet (USER.md is empty). If they',
  'tell you who they are or what they work on, save ONLY the facts they',
  'actually state — their name, projects, and stated preferences/conventions',
  '— to USER.md via memory_add(file: "user"). Never invent or infer facts',
  'they did not say. Keep it work-relevant; do not record feelings or mood.',
].join('\n');

/**
 * v4.11 Skill Injection Narrowing — hard per-entry cap for the
 * system-prompt skill index. The cap actually fires (the pre-v4.11
 * `.slice(0, 120)` never did: avg description is ~62 chars), so this is
 * the lever that shrinks the ~1.5k-token block.
 */
export const SKILL_DESC_CAP = 60;

/**
 * Narrow a full skill description to a routing-sufficient teaser for the
 * `<available_skills>` index.
 *
 * Routing depends on this text (it is the sole signal weak models —
 * groq/llama — use to pick a skill), so we keep the discriminator: the
 * first sentence. Everything after the first `.` or newline is dropped,
 * then the result is hard-capped at `SKILL_DESC_CAP` chars with an
 * ellipsis when the cap bites. The full description is never lost — it
 * stays one `skills_list` / `skill_view` call away.
 *
 * Pure and idempotent: safe to call on already-narrowed text. Empty /
 * non-string input yields `''`.
 */
export function narrowSkillDesc(desc: string): string {
  if (typeof desc !== 'string') return '';
  const trimmed = desc.trim();
  if (trimmed.length === 0) return '';
  // First sentence: stop at the first sentence-ending period or newline.
  // Fall back to the whole trimmed string if the split yields nothing
  // useful (e.g. a description that opens with punctuation).
  const firstSentence = (trimmed.split(/[.\n]/, 1)[0] ?? '').trim() || trimmed;
  if (firstSentence.length <= SKILL_DESC_CAP) return firstSentence;
  return firstSentence.slice(0, SKILL_DESC_CAP).trimEnd() + '…';
}

export interface SkillIndexEntry {
  name: string;
  description: string;
  category?: string;
  trustLevel?: string;
  userModified?: boolean;
  /**
   * v4.14 Pillar 6 Slice A — precondition status shown to the model so it isn't
   * told a skill is usable when its env/binary/platform preconditions aren't
   * met (e.g. "needs setup: CENSYS_API_ID"). Absent ⇒ ready ⇒ no marker.
   */
  readinessNote?: string;
}

/**
 * v4.12 OM.1 — posture-aware demotion. A demoted skill keeps its NAME in the
 * index (never hidden — war-story #3) but drops the teaser. Conservative: when
 * relevance is ambiguous we KEEP the teaser (blinding the model is the failure
 * mode, not a few extra tokens).
 *
 *   - user-modified (project-local / user-touched) → KEEP teaser.
 *   - category matches a loaded toolset (posture-relevant) → KEEP teaser.
 *   - low-trust 'community' + off-posture → names-only.
 *   - categorized but off-posture (any trust) → names-only.
 *   - no category + not low-trust → KEEP (ambiguous → conservative).
 */
export function shouldDemoteSkill(
  skill: { category?: string; trustLevel?: string; userModified?: boolean },
  loadedToolsets: ReadonlySet<string>,
): boolean {
  if (skill.userModified) return false;                    // project-local / user-touched
  const cat = (skill.category ?? '').trim().toLowerCase();
  if (cat && loadedToolsets.has(cat)) return false;        // posture-relevant
  if (skill.trustLevel === 'community') return true;       // low-trust + off-posture
  if (cat) return true;                                    // categorized but off-posture (any trust)
  return false;                                            // uncategorized + non-community → conservative keep
}

function formatSkillsSection(
  skills: ReadonlyArray<SkillIndexEntry>,
  loadedToolsets: ReadonlySet<string>,
): string {
  // Demoted entries render NAME-ONLY (teaser dropped); full entries keep the
  // teaser. v4.14 — a non-ready skill appends its readiness note so the model
  // knows it must be set up before it can be used.
  const lines = skills.map((s) => {
    const base = shouldDemoteSkill(s, loadedToolsets) ? `- ${s.name}` : `- ${s.name}: ${s.description}`;
    return s.readinessNote ? `${base}  [${s.readinessNote}]` : base;
  });
  return [
    HEADER_SKILLS,
    '',
    SKILLS_LOAD_NOTE,
    '',
    `<${TAG_AVAILABLE_SKILLS}>`,
    ...lines,
    `</${TAG_AVAILABLE_SKILLS}>`,
    '',
    SKILLS_MATCH_NUDGE,
  ].join('\n');
}

function formatBudgetSection(used: number, max: number): string {
  return [HEADER_BUDGET, '', renderBudgetLine(used, max)].join('\n');
}

function formatEnvironmentSection(platform: string, cwd: string): string {
  return [
    HEADER_ENVIRONMENT,
    '',
    `Platform: ${platform}`,
    `Working directory: ${cwd}`,
    `Date: ${dateStamp()}`,
  ].join('\n');
}

/** Single source of truth for the budget snippet (frozen + live). */
function renderBudgetLine(used: number, max: number): string {
  const remaining = Math.max(0, max - used);
  return `Used ${used} of ${max} turns · ${remaining} remaining`;
}

// ── Public class ──────────────────────────────────────────────────────

export class PromptBuilder {
  /**
   * Compose the slot-ordered system prompt. Stateless: instances may be
   * shared. The frozen-snapshot guarantee is on the OUTPUT — given the
   * same `opts` (within the same UTC day), this returns byte-identical
   * strings so prefix caches stay warm.
   */
  async build(opts: PromptBuilderOptions): Promise<string> {
    const slots: PromptSlot[] = [];

    // ── 1. Identity (SOUL.md or default) ──────────────────────────────
    let identity: string | null = null;
    if (!opts.skipFilesystem) {
      identity = await readNonEmpty(opts.paths.soulMd);
    }
    // Phase v4.1.2: track whether the identity came from a real
    // user-authored SOUL.md so the embodiment directive only fires
    // when there's a meaningful persona to embody.
    const identityFromDisk = identity !== null;
    if (!identity) identity = DEFAULT_SOUL_MD;
    const identityContent = identityFromDisk
      ? `${EMBODIMENT_DIRECTIVE}\n\n${identity.trim()}`
      : identity.trim();
    slots.push({ name: 'identity', content: identityContent, optional: false });

    // ── 2. Personality overlay ────────────────────────────────────────
    const overlay = opts.personalityOverlay?.trim();
    if (overlay) {
      slots.push({ name: 'personality', content: overlay, optional: true });
    }

    // ── 3. MEMORY.md ──────────────────────────────────────────────────
    const memoryMd = opts.memorySnapshot?.memoryMd?.trim();
    if (memoryMd) {
      slots.push({
        name:     'memory',
        content:  formatMemorySection(memoryMd),
        optional: true,
      });
    }

    // ── 4. USER.md ────────────────────────────────────────────────────
    const userMd = opts.memorySnapshot?.userMd?.trim();
    if (userMd) {
      slots.push({
        name:     'user',
        content:  formatUserSection(userMd),
        optional: true,
      });
    } else {
      // v4.12 — onboarding nudge. USER.md is empty (user not yet onboarded).
      // If the user states who they are or what they're working on, save the
      // STATED facts to USER.md via memory_add(file:'user'). Self-limiting:
      // disappears once USER.md has content. Same anti-fabrication bar as the
      // verifier — only what the user actually said, never inferred.
      slots.push({
        name:     'user-onboarding',
        content:  ONBOARDING_NUDGE,
        optional: true,
      });
    }

    // ── 4.25. Runtime manifest (self-awareness) ───────────────────────
    // High-signal facts about what Aiden actually has loaded right now:
    // version, tool count, skill count, channel/surface list, current
    // provider/model. Always present so "what version are you" /
    // "what tools do you have" answers come from facts in context,
    // not from whatever stale text used to live in SOUL.md.
    const runtimeManifest = buildRuntimeManifest({
      toolCount:  opts.toolCount ?? 0,
      skillCount: opts.skillsList?.length ?? 0,
      providerId: opts.providerId,
      modelId:    opts.modelId,
    });
    slots.push({
      name:     'runtime',
      content:  renderRuntimeSlot(runtimeManifest),
      optional: false,
    });

    // ── 4.5. Tool-conditional guidance ────────────────────────────────
    // Each block fires only when its corresponding toolset is loaded.
    // Order is deterministic so the prefix cache stays stable across
    // turns with the same toolset set.
    const toolsets = opts.toolsetsLoaded;
    if (toolsets && toolsets.size > 0) {
      if (toolsets.has('memory')) {
        slots.push({
          name:     'guidance.memory',
          content:  MEMORY_GUIDANCE,
          optional: true,
        });
      }
      if (toolsets.has('session-search')) {
        slots.push({
          name:     'guidance.sessionSearch',
          content:  SESSION_SEARCH_GUIDANCE,
          optional: true,
        });
      }
      if (toolsets.has('skills')) {
        slots.push({
          name:     'guidance.skills',
          content:  SKILLS_GUIDANCE,
          optional: true,
        });
      }
    }

    // ── 5. Skills ─────────────────────────────────────────────────────
    if (opts.skillsList && opts.skillsList.length > 0) {
      slots.push({
        name:     'skills',
        content:  formatSkillsSection(opts.skillsList, opts.toolsetsLoaded ?? new Set()),
        optional: true,
      });
    }

    // ── 6. Llama-3.3 tool-call hint ───────────────────────────────────
    if (shouldInjectLlama33ToolHint(opts.modelId)) {
      slots.push({
        name:     'llama33Hint',
        content:  LLAMA_33_TOOL_CALL_HINT,
        optional: true,
      });
    }

    // ── 6.5. Execution discipline ─────────────────────────────────────
    // Phase v4.1.2: closes the "promise without acting" failure mode.
    // Model-conditional via shouldInjectExecutionDiscipline so we can
    // narrow later if a specific model proves counter-productive.
    if (shouldInjectExecutionDiscipline(opts.modelId)) {
      slots.push({
        name:     'executionDiscipline',
        content:  EXECUTION_DISCIPLINE_PROSE,
        optional: true,
      });
    }

    // ── 6.6. UI events nudge (v4.8.0 Phase 2.6) ───────────────────────
    // Teaches structured-event emission for multi-step work instead of
    // relying on text status formatting.
    //
    // v4.11 — gated by `shouldInjectUiEventsGuidance(modelId)`. Weak
    // instruct models (llama-3.x, mistral, gemma, qwen2-7B/14B, phi)
    // misimitate the `name {args}` pseudocode as XML-wrapped text
    // (e.g. `<ui_toast{...}</ui_toast>`) instead of firing a proper
    // tool_call. The sibling `stripLeakedUiMarkup` sanitizer is the
    // safety net for any model that slips past this gate.
    if (shouldInjectUiEventsGuidance(opts.modelId)) {
      slots.push({
        name:     'uiEvents',
        content:  UI_EVENTS_GUIDANCE,
        optional: true,
      });
    }

    // ── 7. Iteration budget ───────────────────────────────────────────
    if (opts.initialBudget) {
      const { used, max } = opts.initialBudget;
      slots.push({
        name:     'budget',
        content:  formatBudgetSection(used, max),
        optional: true,
      });
    }

    // ── 8. Environment ────────────────────────────────────────────────
    const platform = opts.platform ?? detectPlatform();
    const cwd      = opts.cwd      ?? process.cwd();
    slots.push({
      name:     'environment',
      content:  formatEnvironmentSection(platform, cwd),
      optional: false,
    });

    // Drop any slot whose content is empty (defence-in-depth on top of
    // the per-slot guards above) and join with a single blank line so
    // the output never grows triple-newlines (test 6).
    return slots
      .map((s) => s.content.trimEnd())
      .filter((c) => c.length > 0)
      .join('\n\n');
  }

  /**
   * Per-turn `## Active tools` block. NOT part of the frozen system
   * prompt — the agent loop renders this inline at turn time so tool
   * descriptions can change between turns without invalidating the
   * cache prefix.
   */
  renderToolsForTurn(tools: ReadonlyArray<ToolSchema>): string {
    if (!tools || tools.length === 0) return '';
    const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
    return [HEADER_TOOLS, '', ...lines].join('\n');
  }

  /**
   * Live budget snippet for status displays and turn boundaries. Same
   * format as the frozen `Iteration budget` block's body line so
   * progress display is consistent across surfaces.
   */
  renderBudgetSnippet(used: number, max: number): string {
    return renderBudgetLine(used, max);
  }
}
