/**
 * scripts/smoke-streaming-visibility.ts — Phase 16c.2
 *
 * Focused smoke for the question 16c.1's user couldn't answer from the
 * combined gate: "do tokens actually arrive incrementally for a non-tool
 * prompt, or did 16c just buffer everything?"
 *
 * Run with:  npx tsx scripts/smoke-streaming-visibility.ts
 *
 * Sends a NON-tool-calling prompt with streaming ON and reports:
 *   - delta count (>5 expected for a 5-sentence story)
 *   - first-delta latency (ms from request to first onDelta)
 *   - inter-delta gap distribution (median + max) — confirms tokens are
 *     genuinely incremental, not one big flush
 *
 * Tool-call prompts buffer per Phase 16c spec (). That's
 * by design and tested by `smoke-phase16c.ts`. THIS script complements
 * by isolating the pure-text streaming behaviour.
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
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'aiden-smoke-stream-'),
  );
  const realPaths = resolveAidenPaths();
  try {
    const envBuf = await fs.readFile(realPaths.envFile, 'utf8');
    await fs.writeFile(path.join(tmpRoot, '.env'), envBuf, 'utf8');
  } catch {
    // ok — env may live in user shell only
  }
  try {
    const cfgBuf = await fs.readFile(realPaths.configYaml, 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'config.yaml'), cfgBuf, 'utf8');
  } catch {
    // ok
  }
  process.env.AIDEN_HOME = tmpRoot;
  const sandbox = resolveAidenPaths({ rootOverride: tmpRoot });
  // eslint-disable-next-line no-console
  console.log(`[smoke] sandbox AIDEN_HOME = ${tmpRoot}`);

  const runtime = await buildAgentRuntime({ yolo: true }, { pathsOverride: sandbox });
  const adapter = runtime.fallbackAdapter;
  if (!adapter) {
    console.error('[smoke] no provider adapter available — abort');
    process.exit(2);
  }

  const deltas: Array<{ t: number; len: number }> = [];
  const t0 = Date.now();
  let firstDeltaAt: number | null = null;
  let finishReason = '';
  let total = '';

  // Direct adapter stream — bypasses agent loop, isolates the streaming
  // wire from agent logic. We're testing token arrival cadence here.
  if (typeof (adapter as any).callStream !== 'function') {
    console.error('[smoke] adapter has no callStream — Phase 16c regressed?');
    process.exit(3);
  }

  const stream = (adapter as any).callStream({
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. Reply in plain text.',
      },
      {
        role: 'user',
        content:
          'Tell me a 5-sentence story about a cat who learns to swim. Plain text, no markdown.',
      },
    ],
    tools: [],
  });

  for await (const ev of stream) {
    if (ev.type === 'delta') {
      const now = Date.now();
      if (firstDeltaAt === null) firstDeltaAt = now - t0;
      deltas.push({ t: now - t0, len: ev.content.length });
      total += ev.content;
      process.stdout.write(ev.content);
    } else if (ev.type === 'done') {
      // Adapter shape (Phase 16c): `done` events wrap a ProviderCallOutput
      // under `output`, which carries finishReason + usage.
      finishReason = ev.output?.finishReason ?? ev.finishReason ?? '';
    } else if (ev.type === 'tool_call') {
      // The non-tool prompt should NOT trigger this; if it does, the
      // model is being weird and the test still tells us streaming
      // works (just with a tool turn).
      step('non-tool prompt unexpectedly fired a tool call', false);
    }
  }
  process.stdout.write('\n');

  const gaps: number[] = [];
  for (let i = 1; i < deltas.length; i++) {
    gaps.push(deltas[i].t - deltas[i - 1].t);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const max = gaps.length ? gaps[gaps.length - 1] : 0;

  step('finishReason === stop', finishReason === 'stop', `got "${finishReason}"`);
  step(
    'more than 5 deltas (real streaming, not single flush)',
    deltas.length > 5,
    `count=${deltas.length}`,
  );
  step('first delta arrived', firstDeltaAt !== null, `${firstDeltaAt}ms`);
  step('inter-delta median < 500ms (token-rate sanity)', median < 500, `${median}ms`);
  step('content non-empty', total.length > 0, `${total.length}ch`);
  // eslint-disable-next-line no-console
  console.log(
    `[smoke] summary: deltas=${deltas.length} firstDelta=${firstDeltaAt}ms gapMedian=${median}ms gapMax=${max}ms totalCh=${total.length}`,
  );

  if (failures > 0) {
    console.error(`SMOKE FAIL — ${failures} step(s) failed.`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('SMOKE PASS — pure-text streaming yields incremental tokens.');
}

main().catch((err) => {
  console.error('[smoke] crashed:', err);
  process.exit(1);
});
