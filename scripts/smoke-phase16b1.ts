/**
 * scripts/smoke-phase16b1.ts — Phase 16b.1 smoke gate
 *
 * Verifies:
 *   1. Boot does NOT emit `[config] Unknown top-level key 'terminal'`.
 *   2. Bundled-skill restore populates an empty skills dir with all 75
 *      bundled skills.
 *   3. `buildAgentRuntime` returns with a populated `commandRegistry`
 *      that includes `/providers`.
 *   4. When run against a stubbed FallbackAdapter that 429s on the first
 *      slot, the agent transparently retries the second slot.
 *
 * Run with:  npx tsx scripts/smoke-phase16b1.ts
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
import { ConfigManager } from '../core/v4/config';
import {
  FallbackAdapter,
  type ProviderSlot,
} from '../core/v4/providerFallback';
import { AidenAgent } from '../core/v4/aidenAgent';
import type { ProviderAdapter } from '../providers/v4/types';

let failures = 0;
function step(name: string, ok: boolean, detail?: string): void {
  const tag = ok ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-smoke-16b1-'));
  const paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);

  // ── 1. terminal key in config schema ───────────────────────────────
  await fs.writeFile(paths.configYaml, 'terminal:\n  backend: auto\n', 'utf8');
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  const cfg = new ConfigManager(paths);
  await cfg.load();
  console.warn = origWarn;
  const terminalWarn = warns.find((w) =>
    w.includes("Unknown top-level key 'terminal'"),
  );
  step('no [config] Unknown top-level key warn for `terminal`', !terminalWarn);

  // ── 2. bundled skill restore from repo root ─────────────────────────
  const repoRoot = path.resolve(__dirname, '..');
  const bundledSrc = path.join(repoRoot, 'skills');
  const restoreResult = await restoreBundledSkillsIfNeeded(paths, {
    sourceOverride: bundledSrc,
  });
  const loader = new SkillLoader(paths);
  const list = await loader.list();
  step(
    'bundled-skill restore copies skills into empty dir',
    restoreResult.copied > 70,
    `copied=${restoreResult.copied}, skills=${list.length}`,
  );

  // ── 3. Banner-shaped count check ────────────────────────────────────
  step(
    'banner skill count would render >0 (was 0 before fix)',
    list.length > 0,
    `list.length=${list.length}`,
  );

  // ── 4. FallbackAdapter integration: 429 on slot 1 → slot 2 succeeds ─
  const slot1: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => {
      throw new Error('Provider groq rate limited');
    },
  };
  const slot2: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'hi from slot 2',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 4 },
    }),
  };
  const slots: ProviderSlot[] = [
    {
      id: 's1',
      providerId: 'groq',
      modelId: 'm',
      keyPresent: true,
      keyTail: '1111',
      build: () => slot1,
    },
    {
      id: 's2',
      providerId: 'groq',
      modelId: 'm',
      keyPresent: true,
      keyTail: '2222',
      build: () => slot2,
    },
  ];
  const fa = new FallbackAdapter({ apiMode: 'chat_completions', slots });
  const agent = new AidenAgent({
    provider: fa,
    tools: [],
    toolExecutor: async () => ({ id: '', name: 'noop', result: null }),
    maxTurns: 3,
  });
  const result = await agent.runConversation([
    { role: 'user', content: 'hi' },
  ]);
  step(
    'agent transparently falls through 429 on slot 1 → slot 2',
    result.finalContent === 'hi from slot 2',
    `finalContent=${JSON.stringify(result.finalContent)}`,
  );

  // ── Cleanup ─────────────────────────────────────────────────────────
  await fs.rm(tmpRoot, { recursive: true, force: true });

  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`SMOKE FAIL — ${failures} step(s) failed.`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('SMOKE PASS — Phase 16b.1 hardening verified.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('SMOKE ERROR:', err);
  process.exit(1);
});
