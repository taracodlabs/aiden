/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/debugPrompt.ts — Phase 16b.4
 *
 * `/debug-prompt` — dump the EXACT system message the agent will send to the
 * LLM on the next turn. Reads from the same cache `runConversation` uses
 * (`AidenAgent.getSystemPromptForDebug`) so what you see is what the model
 * sees. No provider call is triggered.
 *
 * Redaction: the system prompt should never contain credentials today —
 * every slot in `core/v4/promptBuilder.ts` is read from SOUL.md / MEMORY.md /
 * USER.md / personality overlays / skills metadata, none of which are key
 * stores. The redaction sweep below is defense-in-depth: if any future slot
 * accidentally injects an env-substituted value, this command never prints
 * the raw secret. Patterns cover OpenAI / Groq / xAI / Cerebras / Google /
 * generic Bearer tokens / 3-segment JWTs.
 *
 * Hermes diverges — Hermes has no equivalent command. Aiden adds it because
 * 16b.4 surfaced a real "SOUL.md never reaches the LLM" bug that an
 * in-REPL diagnostic would have caught immediately.
 */
import type { SlashCommand } from '../commandRegistry';

const REDACTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openai', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: 'groq', re: /gsk_[A-Za-z0-9]{20,}/g },
  { name: 'xai', re: /xai-[A-Za-z0-9-]{20,}/g },
  { name: 'cerebras', re: /csk-[A-Za-z0-9-]{20,}/g },
  { name: 'google', re: /AIza[A-Za-z0-9_-]{30,}/g },
  { name: 'bearer', re: /(Bearer\s+)[A-Za-z0-9._-]{20,}/g },
  // JWTs: header.payload.signature, base64url-ish
  { name: 'jwt', re: /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
];

export function redactSecrets(input: string): { redacted: string; hits: number } {
  let out = input;
  let hits = 0;
  for (const { re } of REDACTION_PATTERNS) {
    out = out.replace(re, (match) => {
      hits += 1;
      // Preserve the leading "Bearer " when matched so the structure is
      // still readable.
      if (match.toLowerCase().startsWith('bearer ')) {
        return 'Bearer [REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return { redacted: out, hits };
}

export const debugPrompt: SlashCommand = {
  name: 'debug-prompt',
  description: 'Dump the system prompt that will be sent on the next LLM turn (redacted).',
  category: 'system',
  icon: '🔍',
  handler: async (ctx) => {
    if (!ctx.agent) {
      ctx.display.warn('Agent not wired in this context — /debug-prompt unavailable.');
      return {};
    }
    let prompt: string | null;
    try {
      prompt = await ctx.agent.getSystemPromptForDebug();
    } catch (err) {
      ctx.display.printError(
        `Could not build system prompt: ${(err as Error).message}`,
        'Check that PromptBuilder is wired (see buildAgentRuntime).',
      );
      return {};
    }
    if (prompt === null) {
      ctx.display.warn(
        'No PromptBuilder wired — agent runs without a system prompt (Phase 12 mode).',
      );
      return {};
    }

    const { redacted, hits } = redactSecrets(prompt);
    ctx.display.info(`System prompt (${redacted.length} chars):`);
    ctx.display.write('\n');
    ctx.display.write('────── BEGIN SYSTEM PROMPT ──────\n');
    ctx.display.write(redacted);
    if (!redacted.endsWith('\n')) ctx.display.write('\n');
    ctx.display.write('────── END SYSTEM PROMPT ──────\n');
    ctx.display.write('\n');
    ctx.display.dim(
      hits > 0
        ? `(${hits} secret-shaped string(s) redacted before display)`
        : '(no secret-shaped strings detected)',
    );
    return {};
  },
};
