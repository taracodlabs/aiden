/**
 * core/v4/promptBuilder.ts — Aiden v4.0.0 (Phase 13)
 *
 * Slot-ordered system-prompt assembler, frozen at session start.
 *
 * Hermes reference: agent/prompt_builder.py — _build_system_prompt() with
 * its identity / memory / skills / platform sections. Aiden simplifies
 * Hermes' multiple branches into a single ordered slot list because v4
 * doesn't have Hermes' Kanban / acp_adapter / hermes-md layering.
 *
 * Slot order (top → bottom):
 *   1. SOUL.md          (identity)
 *   2. Personality      (overlay — Phase 16)
 *   3. MEMORY.md        (agent's environment notes)
 *   4. USER.md          (user profile)
 *   5. Active skills    (compact list)
 *   6. Active toolset   (rendered separately per turn — see renderToolsForTurn)
 *   7. Iteration budget (initial value at session start)
 *   8. Date / platform / cwd
 *
 * "Frozen snapshot": once `build()` returns, the same options object will
 * produce a byte-identical prompt — that lets the Anthropic prefix cache
 * (and OpenAI's implicit cache) hit on subsequent runConversation calls
 * within the session.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { AidenPaths } from './paths';
import type { ConfigManager } from './config';
import type { MemorySnapshot } from './memoryProvider';
import type { ToolSchema } from '../../providers/v4/types';
// Phase 16b.3: when SOUL.md is missing/unreadable at slot-1 build time, fall
// back to the same bundled identity that `ensureSoulMdSeeded` writes on first
// run. Keeping the two strings identical means the in-memory fallback can't
// drift from the on-disk template.
import { DEFAULT_SOUL_MD as DEFAULT_IDENTITY } from '../../cli/v4/defaultSoul';

export interface PromptSlot {
  name: string;
  content: string;
  optional: boolean;
}

export interface PromptBuilderOptions {
  paths: AidenPaths;
  config?: ConfigManager;
  memorySnapshot?: MemorySnapshot;
  skillsList?: Array<{ name: string; description: string }>;
  personalityOverlay?: string;
  initialBudget?: { used: number; max: number };
  platform?: 'windows' | 'linux' | 'macos';
  cwd?: string;
  /** When true, don't read SOUL.md from disk even if present. Used by tests. */
  skipFilesystem?: boolean;
  /**
   * Phase 16b.2: target model id (e.g. `llama-3.3-70b-versatile`). When the
   * id matches `/llama-3.3/i`, an extra slot warns the model away from the
   * legacy `<function=name({args})>` syntax some Llama-3.3 fine-tunes still
   * emit by default. See `chatCompletionsAdapter` for the belt-and-braces
   * recovery on the response side.
   */
  modelId?: string;
}

/**
 * Phase 16b.2: Llama-3.3 fine-tunes (notably Groq's `llama-3.3-70b-versatile`)
 * sometimes ignore the OpenAI tool_calls schema and emit
 *   `<function=tool_name({"arg":"value"})>`
 * inline. Groq returns HTTP 400 with `tool_use_failed` and the raw text
 * lives in `failed_generation`. The prompt-side guard tells the model the
 * right format up front; the adapter-side recovery handles the case where
 * it ignores us anyway.
 */
const LLAMA_33_TOOL_CALL_HINT =
  'When using tools, ALWAYS use the OpenAI tool_calls JSON format. ' +
  'NEVER emit `<function=name({args})>` syntax inline in your text — that ' +
  'is a legacy format that will be rejected.';

/** Exposed for tests. */
export function shouldInjectLlama33ToolHint(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return /llama-?3\.3/i.test(modelId);
}

function detectPlatform(): 'windows' | 'linux' | 'macos' {
  const p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

export class PromptBuilder {
  /**
   * Build the slot-ordered system prompt as a single string. Caller is
   * responsible for caching the result for the session — PromptBuilder
   * itself is stateless so it can be used from tests + main loop alike.
   */
  async build(opts: PromptBuilderOptions): Promise<string> {
    const slots: PromptSlot[] = [];

    // ── Slot 1: SOUL.md ──────────────────────────────────────────────
    let soul: string | null = null;
    if (!opts.skipFilesystem) {
      soul = await readMaybe(opts.paths.soulMd);
    }
    slots.push({
      name: 'identity',
      content: soul ?? DEFAULT_IDENTITY,
      optional: false,
    });

    // ── Slot 2: Personality overlay ──────────────────────────────────
    if (opts.personalityOverlay && opts.personalityOverlay.trim()) {
      slots.push({
        name: 'personality',
        content: opts.personalityOverlay.trim(),
        optional: true,
      });
    }

    // ── Slot 3: MEMORY.md ────────────────────────────────────────────
    // Phase 16e: framing copied/adapted from Hermes
    // (`tools/memory_tool.py:393-409`). The parenthetical in the header
    // ("your personal notes") tells the model this is its own working
    // memory, not transcript snippets — `## Agent memory` alone read as
    // "previous conversation log" and the model said "I don't have any
    // information from our previous conversations" even when content was
    // present. The system note line is borrowed from Hermes's external-
    // provider context block (`memory_manager.py:184-188`).
    if (opts.memorySnapshot && opts.memorySnapshot.memoryMd.trim()) {
      const sep = '═'.repeat(51);
      slots.push({
        name: 'memory',
        content:
          `${sep}\nMEMORY (your personal notes)\n${sep}\n` +
          `[System note: The following are your own notes from prior ` +
          `interactions. Treat as live working memory, not past ` +
          `conversation transcript.]\n\n` +
          opts.memorySnapshot.memoryMd.trim(),
        optional: true,
      });
    }

    // ── Slot 4: USER.md ──────────────────────────────────────────────
    // Same pattern as slot 3 but framed as user identity. "(who the user
    // is)" matches Hermes verbatim — it's the framing that prevents the
    // model from treating this as transcript history.
    if (opts.memorySnapshot && opts.memorySnapshot.userMd.trim()) {
      const sep = '═'.repeat(51);
      slots.push({
        name: 'user',
        content:
          `${sep}\nUSER PROFILE (who the user is)\n${sep}\n` +
          `[System note: The following is what you currently know about ` +
          `the user. Treat as live identity, not past conversation ` +
          `transcript.]\n\n` +
          opts.memorySnapshot.userMd.trim(),
        optional: true,
      });
    }

    // ── Slot 5: Active skills list ───────────────────────────────────
    if (opts.skillsList && opts.skillsList.length > 0) {
      const lines = opts.skillsList.map(
        (s) => `- ${s.name}: ${s.description}`,
      );
      slots.push({
        name: 'skills',
        content: `## Available skills\n\n${lines.join('\n')}`,
        optional: true,
      });
    }

    // ── Slot 6: Iteration budget snippet (initial) ───────────────────
    if (opts.initialBudget) {
      slots.push({
        name: 'budget',
        content: this.renderBudgetSnippet(
          opts.initialBudget.used,
          opts.initialBudget.max,
        ),
        optional: true,
      });
    }

    // ── Slot 6.5: Llama-3.3 tool-call format hint (Phase 16b.2) ──────
    if (shouldInjectLlama33ToolHint(opts.modelId)) {
      slots.push({
        name: 'llama33-tool-format',
        content: LLAMA_33_TOOL_CALL_HINT,
        optional: true,
      });
    }

    // ── Slot 7: Environment block (date / platform / cwd) ────────────
    const platform = opts.platform ?? detectPlatform();
    const cwd = opts.cwd ?? process.cwd();
    const date = new Date().toISOString().slice(0, 10);
    slots.push({
      name: 'environment',
      content:
        `## Environment\n\n` +
        `- Date: ${date}\n` +
        `- Platform: ${platform}\n` +
        `- Working directory: ${cwd}`,
      optional: false,
    });

    // Assemble slots, separated by blank lines. Empty slots already
    // filtered (only required slots can have empty content; we never
    // push an optional empty slot, so this is safe).
    return slots
      .map((s) => s.content.trim())
      .filter((s) => s.length > 0)
      .join('\n\n');
  }

  /**
   * Render the active toolset as a compact, deterministic block. Called
   * per-turn (not at session start) because PlannerGuard may narrow the
   * set on a per-message basis.
   */
  renderToolsForTurn(tools: ToolSchema[]): string {
    if (!tools || tools.length === 0) return '';
    const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
    return `## Active tools (this turn)\n\n${lines.join('\n')}`;
  }

  /** "Used N of M turns" snippet. Used both at session start and mid-loop. */
  renderBudgetSnippet(used: number, max: number): string {
    const remaining = Math.max(0, max - used);
    return `## Iteration budget\n\nUsed ${used} of ${max} turns (${remaining} remaining).`;
  }
}
