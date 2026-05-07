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
// When SOUL.md is missing or whitespace-only the bundled default takes
// over so a fresh install still has a working identity.
import { DEFAULT_SOUL_MD } from '../../cli/v4/defaultSoul';

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
  skillsList?:          Array<{ name: string; description: string }>;
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

function formatSkillsSection(
  skills: ReadonlyArray<{ name: string; description: string }>,
): string {
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    HEADER_SKILLS,
    '',
    SKILLS_LOAD_NOTE,
    '',
    `<${TAG_AVAILABLE_SKILLS}>`,
    ...lines,
    `</${TAG_AVAILABLE_SKILLS}>`,
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
    if (!identity) identity = DEFAULT_SOUL_MD;
    slots.push({ name: 'identity', content: identity.trim(), optional: false });

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
    }

    // ── 5. Skills ─────────────────────────────────────────────────────
    if (opts.skillsList && opts.skillsList.length > 0) {
      slots.push({
        name:     'skills',
        content:  formatSkillsSection(opts.skillsList),
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
