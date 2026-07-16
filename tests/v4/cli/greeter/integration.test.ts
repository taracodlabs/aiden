/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.3 SLICE 1a — renderGreeter end-to-end coverage.
 *
 * Real fs against tmpdir. Display is a write-capture fake — we assert
 * the EXACT strings the orchestrator emits, not return values. This is
 * the explicit fix for the Slice 2 mock-blindness pattern (snapshot of
 * a closure's return value insufficient — assert what reaches the
 * caller). Slice 1b adds the real-subprocess test on top to also
 * verify the bytes actually reach a real terminal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { renderGreeter, type GreeterDisplay } from '../../../../cli/v4/greeter';
import { historyPath, readHistory, writeHistory } from '../../../../cli/v4/greeter/history';
import { WELCOME_FALLBACKS } from '../../../../cli/v4/greeter/welcomeLine';
import type { AidenPaths, GreeterHistory } from '../../../../cli/v4/greeter/types';

let root: string;
let paths: AidenPaths;
let writes: string[];
let display: GreeterDisplay;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-greeter-int-'));
  paths = { root } as unknown as AidenPaths;
  writes = [];
  display = {
    write: (t: string) => { writes.push(t); },
    paint: (t: string, _kind) => t,   // identity paint so assertions stay readable
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = new Date(2026, 4, 25, 19, 30, 0);   // local 7:30pm
const VERSION = '4.9.3';

function mkHistory(over: Partial<GreeterHistory> = {}): GreeterHistory {
  return {
    v: 1,
    firstLaunchAt:  '2026-05-23T16:30:00.000Z',
    lastGreetingAt: '2026-05-24T09:14:00.000Z',
    offers: [], disabled: false,
    ...over,
  };
}

describe('renderGreeter — silence on first-ever launch', () => {
  it('writes ZERO bytes when history file is missing, and initializes the file', async () => {
    // No prior history → first launch.
    expect(await readHistory(paths)).toBeNull();

    await renderGreeter({ paths, version: VERSION, display, now: NOW });

    // Nothing rendered.
    expect(writes).toEqual([]);
    // History file now exists.
    const h = await readHistory(paths);
    expect(h).not.toBeNull();
    expect(h!.firstLaunchAt).toBe(NOW.toISOString());
    expect(h!.offers).toEqual([]);
    expect(h!.disabled).toBe(false);
  });
});

describe('renderGreeter — silence when disabled', () => {
  it('writes ZERO bytes when history.disabled === true', async () => {
    await writeHistory(paths, mkHistory({ disabled: true }));
    await renderGreeter({ paths, version: VERSION, display, now: NOW });
    expect(writes).toEqual([]);
  });

  it('the disabled flag persists across the silent run', async () => {
    await writeHistory(paths, mkHistory({ disabled: true }));
    await renderGreeter({ paths, version: VERSION, display, now: NOW });
    const h = await readHistory(paths);
    expect(h!.disabled).toBe(true);
  });
});

describe('renderGreeter — warm fallback when nothing else fires (v4.14)', () => {
  it('shows a warm rotating greeting (not cold silence) on a no-signal boot', async () => {
    // Morning, no update cache, no distillations, a RECENT session (so no
    // welcome-back regardless of the runner timezone), cwd unchanged.
    const NOON = new Date(2026, 4, 25, 12, 0, 0);
    await writeHistory(paths, mkHistory({
      lastCwd: process.cwd(),
      lastSessionAt: new Date(NOON.getTime() - 3 * 3600 * 1000).toISOString(),
    }));
    await renderGreeter({ paths, version: VERSION, display, now: NOON });
    expect(writes).toHaveLength(1);
    expect(WELCOME_FALLBACKS).toContain(writes[0].trim());
  });

  it('rotates the fallback across consecutive boots — never the same line twice running', async () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);   // hour 9 → no time-of-day tier
    await writeHistory(paths, mkHistory({
      lastCwd: process.cwd(),
      lastSessionAt: new Date(MORN.getTime() - 3 * 3600 * 1000).toISOString(),  // recent → no welcome-back
    }));
    const lines: string[] = [];
    for (let i = 0; i < WELCOME_FALLBACKS.length + 1; i++) {
      writes.length = 0;
      await renderGreeter({ paths, version: VERSION, display, now: MORN });
      lines.push((writes[0] ?? '').trim());
    }
    // Every boot showed a warm fallback…
    for (const l of lines) expect(WELCOME_FALLBACKS).toContain(l);
    // …and never repeated the previous boot's line.
    for (let i = 1; i < lines.length; i++) expect(lines[i]).not.toBe(lines[i - 1]);
    // The rotation index is persisted so it survives across boots.
    expect(typeof (await readHistory(paths))!.lastFallbackIndex).toBe('number');
  });
});

describe('renderGreeter — speaks when an offer wins', () => {
  it('emits the offer speech with 2-space indent and trailing blank line', async () => {
    // Seed an update cache → tier-4 fires (no tier-2/3 available because
    // hour is 9am and no continuity, no distillations).
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    await fs.writeFile(
      path.join(root, '.update_check.json'),
      JSON.stringify({ latest: '4.9.4' }), 'utf8',
    );
    await writeHistory(paths, mkHistory({ lastCwd: process.cwd() }));
    await renderGreeter({ paths, version: VERSION, display, now: MORN });

    // One write call, with the canonical layout + the warm advisory voice.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(
      "  There's a newer version of me available (4.9.3 → 4.9.4). Run /update install to upgrade — or just say the word.\n\n",
    );
  });

  it('bounds a long greeting to the startup viewport when width is available', async () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    await fs.writeFile(
      path.join(root, '.update_check.json'),
      JSON.stringify({ latest: '4.9.4' }), 'utf8',
    );
    await writeHistory(paths, mkHistory({ lastCwd: process.cwd() }));
    display.terminalColumns = () => 48;

    await renderGreeter({ paths, version: VERSION, display, now: MORN });

    const line = writes[0].split('\n')[0];
    expect(line.length).toBeLessThanOrEqual(46);
    expect(line).toContain('Update 4.9.4');
    expect(line).toContain('/update install');
  });

  it('persists the offered offer with no response (pending) so next boot can reconcile', async () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    await fs.writeFile(
      path.join(root, '.update_check.json'),
      JSON.stringify({ latest: '4.9.4' }), 'utf8',
    );
    await writeHistory(paths, mkHistory({ lastCwd: process.cwd() }));
    await renderGreeter({ paths, version: VERSION, display, now: MORN });
    const h = await readHistory(paths);
    expect(h!.offers).toHaveLength(1);
    expect(h!.offers[0].id).toBe('update-available-4.9.4');
    expect(h!.offers[0].expectedAction).toBe('/update install');
    expect(h!.offers[0].response).toBeUndefined();   // pending
  });
});

describe('renderGreeter — continuity from distillation', () => {
  it('reads newest distillation and emits the warm recall welcome from open_items[0]', async () => {
    // Seed a distillation.
    const distDir = path.join(root, 'distillations');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, 'session-2026-05-24.json'),
      JSON.stringify({
        open_items: ['decide redis vs postgres for session store'],
        decisions:  ['shipped v4.9.2'],
      }),
      'utf8',
    );
    await writeHistory(paths, mkHistory({ lastCwd: process.cwd() }));
    await renderGreeter({ paths, version: VERSION, display, now: NOW });

    // v4.14 Bug 1 — the recall tier now renders buildWelcomeLine (identity
    // paint), not the old "Last session left this open" template.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(
      '  Welcome back! Last time: decide redis vs postgres for session store. Continue, or something new?\n\n',
    );
  });
});

describe('renderGreeter — reconciliation closes pending offers from prior boots', () => {
  it('marks a prior update-available-4.9.3 as accepted when running version is now >= 4.9.3', async () => {
    await writeHistory(paths, mkHistory({
      offers: [{
        id:             'update-available-4.9.3',
        offeredAt:      '2026-05-20T08:00:00.000Z',
        expectedAction: '/update install',
        // response: undefined — pending
      }],
    }));
    // Running 4.9.3 now → should reconcile as accepted. (The warm fallback
    // also fires this boot and appends its own offer, so assert on the
    // reconciled update offer specifically rather than array length.)
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    await renderGreeter({ paths, version: '4.9.3', display, now: MORN });
    const h = await readHistory(paths);
    expect(h!.offers.find((o) => o.id === 'update-available-4.9.3')?.response).toBe('accepted');
  });
});

describe('renderGreeter — durable last-session marker (v4.14 Bug 1)', () => {
  it('refreshes lastSessionAt to ~now on every boot (the stuck-timestamp fix)', async () => {
    // Seed a STALE marker — the exact failure mode of the bug (a frozen
    // timestamp that never moved). A real session must refresh it.
    const OLD = '2026-05-01T00:00:00.000Z';
    await writeHistory(paths, mkHistory({
      lastSessionAt: OLD, lastGreetingAt: OLD, lastCwd: process.cwd(),
    }));
    await renderGreeter({ paths, version: VERSION, display, now: NOW });

    const h = await readHistory(paths);
    expect(h!.lastSessionAt).toBe(NOW.toISOString());   // refreshed on use
    expect(h!.lastSessionAt).not.toBe(OLD);             // no longer frozen
  });

  it('first-ever launch seeds lastSessionAt so the NEXT boot has a real gap', async () => {
    expect(await readHistory(paths)).toBeNull();         // first launch
    await renderGreeter({ paths, version: VERSION, display, now: NOW });
    const h = await readHistory(paths);
    expect(h!.lastSessionAt).toBe(NOW.toISOString());
  });

  it('writes lastSessionAt even for a pre-v4.14 file that lacks it', async () => {
    // Old file: lastGreetingAt present, lastSessionAt absent (mkHistory omits it).
    await writeHistory(paths, mkHistory({ lastCwd: process.cwd() }));
    const before = await readHistory(paths);
    expect(before!.lastSessionAt).toBeUndefined();       // absent in the old file

    await renderGreeter({ paths, version: VERSION, display, now: NOW });
    const after = await readHistory(paths);
    expect(after!.lastSessionAt).toBe(NOW.toISOString()); // now durable
  });
});

describe('renderGreeter — greets by stored name (v4.14 Personality L1)', () => {
  it('reads USER.md and addresses the user by name on a returning boot', async () => {
    // Returning user: a stale gap so the time-gap welcome fires, plus a name
    // stored by onboarding in the exact durable format.
    await writeHistory(paths, mkHistory({ lastSessionAt: '2026-05-20T00:00:00.000Z', lastCwd: process.cwd() }));
    await fs.mkdir(path.join(root, 'memories'), { recursive: true });
    await fs.writeFile(path.join(root, 'memories', 'USER.md'), "User's name is Shiva. (source: onboarding)", 'utf8');

    await renderGreeter({ paths, version: VERSION, display, now: NOW });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Welcome back, Shiva');
  });

  it('no stored name → the plain welcome (no dangling comma)', async () => {
    await writeHistory(paths, mkHistory({ lastSessionAt: '2026-05-20T00:00:00.000Z', lastCwd: process.cwd() }));
    await renderGreeter({ paths, version: VERSION, display, now: NOW });
    expect(writes[0]).toContain('Welcome back —');
    expect(writes[0]).not.toContain('Welcome back,');
  });
});

describe('renderGreeter — never throws', () => {
  it('returns cleanly when the paths root is read-only / inaccessible (does not crash REPL)', async () => {
    // Construct a paths object pointing at a definitely-nonexistent root
    // under an unreachable parent. writeHistory's mkdir will fail; the
    // outer try/catch in renderGreeter must swallow.
    const badRoot = path.join(root, 'definitely', 'does', 'not', 'exist');
    // To make writeHistory itself fail, place a FILE where the root should
    // be a directory.
    const blocker = path.join(root, 'blocker');
    await fs.writeFile(blocker, 'i am a file, not a dir');
    const blockedPaths = { root: path.join(blocker, 'inside') } as unknown as AidenPaths;

    // Must resolve, not throw. No writes either.
    await expect(renderGreeter({ paths: blockedPaths, version: VERSION, display, now: NOW }))
      .resolves.toBeUndefined();
    expect(writes).toEqual([]);
    void badRoot;
  });
});
