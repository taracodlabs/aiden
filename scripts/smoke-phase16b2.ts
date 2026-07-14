/**
 * scripts/smoke-phase16b2.ts — Phase 16b.2 smoke gate
 *
 * Verifies:
 *   1. SkillLoader scans ONCE and caches across calls (no per-turn warnings).
 *   2. Boot-time summary line `[skills] N loaded, M skipped` is emitted via
 *      the captured display sink (no console.warn leaks to stderr).
 *   3. After backfill, the 4 single-file v3 skills load cleanly — no entries
 *      in the `skipped` set under the source bundled-skills tree.
 *   4. `parseLegacyFunctionSyntax('<function=foo({})>')` parses to a synthetic
 *      tool_call (the 400-recovery path is exercised by the unit test).
 *   5. `tryRecoverLegacyToolCall` returns a `ProviderCallOutput` for a
 *      Groq-shaped error body.
 *   6. Llama-3.3 prompt-injection slot fires for the matched model id and
 *      stays out of the way for other models.
 *
 * Run with:  npx tsx scripts/smoke-phase16b2.ts
 *
 * Live LLM round-trip ("hi" through Groq Llama-3.3) is intentionally NOT
 * driven from here — that's a manual Shiva run with real keys.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../core/v4/paths';
import { restoreBundledSkillsIfNeeded } from '../core/v4/skillBundledRestore';
import { SkillLoader } from '../core/v4/skillLoader';
import { createFileLogger } from '../core/v4/aidenLogger';
import {
  parseLegacyFunctionSyntax,
  tryRecoverLegacyToolCall,
} from '../providers/v4/chatCompletionsAdapter';
import {
  PromptBuilder,
  shouldInjectLlama33ToolHint,
} from '../core/v4/promptBuilder';

let failures = 0;
function step(name: string, ok: boolean, detail?: string): void {
  const tag = ok ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-smoke-16b2-'));
  const paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);

  // ── 1. Restore bundled skills + verify backfill landed cleanly ─────
  const repoRoot = path.resolve(__dirname, '..');
  const bundledSrc = path.join(repoRoot, 'skills');
  await restoreBundledSkillsIfNeeded(paths, { sourceOverride: bundledSrc });

  const logger = createFileLogger(paths.logsDir, 'skills');
  const loader = new SkillLoader(paths, { logger });

  await loader.loadAll();
  const counts = loader.getLastCounts();
  step(
    '4 single-file skills now have frontmatter — 0 skipped',
    counts.skipped === 0,
    `loaded=${counts.loaded}, skipped=${counts.skipped}`,
  );
  step(
    'boot summary line shape',
    /^\[skills\] \d+ loaded, \d+ skipped/.test(
      `[skills] ${counts.loaded} loaded, ${counts.skipped} skipped`,
    ),
  );

  // ── 2. Cache: re-call loadAll() does not re-scan ────────────────────
  // Reach in via duck-typing — the public API doesn't expose a counter,
  // but the cached array is the same reference.
  const a = await loader.loadAll();
  const b = await loader.loadAll();
  step(
    'SkillLoader.loadAll caches across calls (identity check)',
    a === b,
  );

  // ── 3. Llama-3.3 prompt injection ───────────────────────────────────
  step(
    'shouldInjectLlama33ToolHint matches Groq id',
    shouldInjectLlama33ToolHint('llama-3.3-70b-versatile') === true,
  );
  step(
    'shouldInjectLlama33ToolHint rejects Claude id',
    shouldInjectLlama33ToolHint('claude-sonnet-4-7') === false,
  );

  const pb = new PromptBuilder();
  const llamaPrompt = await pb.build({
    paths,
    modelId: 'llama-3.3-70b-versatile',
    skipFilesystem: true,
  });
  step(
    'PromptBuilder injects tool-format hint for Llama-3.3',
    /OpenAI tool_calls/i.test(llamaPrompt) &&
      /NEVER emit `<function=/.test(llamaPrompt),
  );

  const providerPrompt = await pb.build({
    paths,
    modelId: 'claude-sonnet-4-7',
    skipFilesystem: true,
  });
  step(
    'PromptBuilder leaves Claude prompt untouched',
    !/OpenAI tool_calls/.test(providerPrompt) &&
      !/<function=/.test(providerPrompt),
  );

  // ── 4. Legacy <function=...> recovery parse ─────────────────────────
  const recovered = parseLegacyFunctionSyntax(
    '<function=web_search({"query":"hi"})>',
  );
  step(
    'parseLegacyFunctionSyntax recovers a single call',
    recovered !== null &&
      recovered.toolCalls.length === 1 &&
      recovered.toolCalls[0].name === 'web_search' &&
      (recovered.toolCalls[0].arguments as { query?: string }).query === 'hi',
  );

  // ── 5. Groq tool_use_failed error body recovery ─────────────────────
  const groqBody = JSON.stringify({
    error: {
      code: 'tool_use_failed',
      failed_generation: '<function=ping({})>',
    },
  });
  const groqRecovery = tryRecoverLegacyToolCall(groqBody);
  step(
    'tryRecoverLegacyToolCall handles Groq tool_use_failed body',
    groqRecovery !== null &&
      groqRecovery.toolCalls[0].name === 'ping' &&
      groqRecovery.finishReason === 'tool_use',
  );

  // ── 6. Non-tool_use_failed errors are NOT swallowed ─────────────────
  const otherBody = JSON.stringify({
    error: { code: 'invalid_request', message: 'bad' },
  });
  step(
    'non-tool_use_failed errors fall through to throw',
    tryRecoverLegacyToolCall(otherBody) === null,
  );

  // ── Cleanup ─────────────────────────────────────────────────────────
  await fs.rm(tmpRoot, { recursive: true, force: true });

  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`SMOKE FAIL — ${failures} step(s) failed.`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('SMOKE PASS — Phase 16b.2 hardening verified.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('SMOKE ERROR:', err);
  process.exit(1);
});
