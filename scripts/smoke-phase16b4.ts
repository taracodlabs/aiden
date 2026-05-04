/**
 * scripts/smoke-phase16b4.ts — Phase 16b.4 smoke gate
 *
 * Verifies the two integration fixes that 16b.4 ships:
 *
 *   1. SOUL.md content actually lands in the LLM's system prompt — assert
 *      it's there, then send "who are you" and check the live Groq
 *      response identifies as Aiden (not "I am a large language model").
 *   2. /personality switching swaps slot 2 without breaking slot 1 (SOUL.md
 *      identity preserved).
 *
 * Boots `buildAgentRuntime` the same way `runInteractiveChat` does so the
 * wire-up under test is exactly what the user sees.
 *
 * Run with:  npx tsx scripts/smoke-phase16b4.ts
 *
 * Requires: at least one Groq slot in `%LOCALAPPDATA%\\aiden\\.env`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildAgentRuntime } from '../cli/v4/aidenCLI';
import { resolveAidenPaths } from '../core/v4/paths';

let failures = 0;
function step(name: string, ok: boolean, detail?: string): void {
  const tag = ok ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-smoke-16b4-'));
  await fs.mkdir(tmpRoot, { recursive: true });

  // Borrow the user's real .env + config.yaml so providers actually resolve.
  const realPaths = resolveAidenPaths();
  try {
    const envBuf = await fs.readFile(realPaths.envFile, 'utf8');
    await fs.writeFile(path.join(tmpRoot, '.env'), envBuf, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[warn] could not copy .env: ${(err as Error).message}`);
  }
  try {
    const cfgBuf = await fs.readFile(realPaths.configYaml, 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'config.yaml'), cfgBuf, 'utf8');
  } catch {
    // first-run wizard would fire — fail loudly later
  }

  process.env.AIDEN_HOME = tmpRoot;
  const sandbox = resolveAidenPaths({ rootOverride: tmpRoot });
  // eslint-disable-next-line no-console
  console.log(`[smoke] sandbox AIDEN_HOME = ${tmpRoot}`);

  // Bundle a personality dir into the sandbox so /personality switching has
  // something to load. Mirror the real `personalities/` so behavior is the
  // same as production.
  const repoPersDir = path.resolve(__dirname, '..', 'personalities');
  const sandboxPersDir = path.join(tmpRoot, 'personalities');
  try {
    await fs.mkdir(sandboxPersDir, { recursive: true });
    for (const file of await fs.readdir(repoPersDir)) {
      if (!file.endsWith('.md')) continue;
      await fs.copyFile(
        path.join(repoPersDir, file),
        path.join(sandboxPersDir, file),
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[warn] could not copy personalities: ${(err as Error).message}`);
  }

  const cliOpts = { yolo: true };
  const runtime = await buildAgentRuntime(cliOpts, { pathsOverride: sandbox });

  // ── 1. SOUL.md is in the system prompt ───────────────────────────────
  const sysPrompt = await runtime.agent.getSystemPromptForDebug();
  step(
    'system prompt is built (PromptBuilder wired)',
    sysPrompt !== null && sysPrompt.length > 0,
    sysPrompt ? `${sysPrompt.length} chars` : 'null',
  );
  step(
    'SOUL.md content present in system prompt',
    !!sysPrompt && /Aiden/.test(sysPrompt) && /Taracod/.test(sysPrompt),
    sysPrompt ? sysPrompt.split('\n').slice(0, 3).join(' / ') : '',
  );

  // ── 2. Live Groq round-trip: "who are you" identifies as Aiden ───────
  const q1 = 'who are you';
  // eslint-disable-next-line no-console
  console.log(`\n[smoke] >>> ${q1}`);
  let r1;
  try {
    r1 = await runtime.agent.runConversation([{ role: 'user', content: q1 }]);
  } catch (err) {
    step('turn 1 ran without throwing', false, (err as Error).message);
    await teardown(tmpRoot);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[smoke] <<< ${r1.finalContent}`);

  step(
    'turn 1: response identifies as Aiden (case-insensitive)',
    /aiden/i.test(r1.finalContent),
    r1.finalContent.slice(0, 120),
  );

  // ── 3. Switch personality → concise. Cache invalidated. ──────────────
  const switched = runtime.personalityManager
    ? await runtime.personalityManager.setCurrent('concise')
    : { ok: false, reason: 'manager not wired' };
  step(
    '/personality switched to concise',
    switched.ok,
    switched.ok ? 'ok' : (switched.reason ?? '?'),
  );
  if (switched.ok) {
    const newOverlay = await runtime.personalityManager.getActiveOverlay();
    runtime.agent.setPersonalityOverlay(newOverlay);
  }

  // Re-read system prompt: SOUL.md still slot 1, concise body in slot 2.
  const sysPrompt2 = await runtime.agent.getSystemPromptForDebug();
  step(
    'after switch: SOUL.md identity preserved (slot 1)',
    !!sysPrompt2 && /Aiden/.test(sysPrompt2),
  );
  step(
    'after switch: concise overlay body in slot 2',
    !!sysPrompt2 && /brief|brevity|prioritize/i.test(sysPrompt2),
  );

  // ── 4. Live round-trip with concise: still identifies as Aiden ───────
  const q2 = 'who are you';
  // eslint-disable-next-line no-console
  console.log(`\n[smoke] >>> ${q2} (personality=concise)`);
  let r2;
  try {
    r2 = await runtime.agent.runConversation([{ role: 'user', content: q2 }]);
  } catch (err) {
    step('turn 2 ran without throwing', false, (err as Error).message);
    await teardown(tmpRoot);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`[smoke] <<< ${r2.finalContent}`);

  step(
    'turn 2 (concise): response still identifies as Aiden',
    /aiden/i.test(r2.finalContent),
    r2.finalContent.slice(0, 120),
  );
  step(
    'turn 2 (concise): response shorter than turn 1 (tone proxy)',
    r2.finalContent.length <= r1.finalContent.length + 20, // a small slack
    `len1=${r1.finalContent.length} len2=${r2.finalContent.length}`,
  );

  // ── Final verbatim block ─────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n=== SMOKE HARNESS RESPONSES (verbatim) ===');
  // eslint-disable-next-line no-console
  console.log(`Q1 (default):  ${q1}`);
  // eslint-disable-next-line no-console
  console.log(`A1:            ${r1.finalContent}`);
  // eslint-disable-next-line no-console
  console.log(`Q2 (concise):  ${q2}`);
  // eslint-disable-next-line no-console
  console.log(`A2:            ${r2.finalContent}`);
  // eslint-disable-next-line no-console
  console.log('=== END ===\n');

  await teardown(tmpRoot);

  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`SMOKE FAIL — ${failures} step(s) failed.`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('SMOKE PASS — Phase 16b.4 SOUL injection + /personality wiring verified.');
}

async function teardown(tmpRoot: string): Promise<void> {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('SMOKE ERROR:', err);
  process.exit(1);
});
