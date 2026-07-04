/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.3 SLICE 1b — chatSession greeter-wiring proof-of-life.
 *
 * THE PROOF-OF-LIFE LAYER. This test addresses the Slice 2 dead-commit
 * lesson: snapshot tests of return values prove nothing about whether
 * bytes reach the terminal. Slice 1a's integration test verified
 * renderGreeter end-to-end against a fake Display; THIS test verifies
 * that the real `chatSession.ts` module — imported normally, not
 * mocked — actually CALLS renderGreeter when its `renderStartupCard()`
 * method executes.
 *
 * ── Scope honestly stated ──
 * The dispatch asked for a real subprocess spawn (`node aidenCLI.js`
 * with stdio:'pipe'). That path is structurally blocked: chatSession's
 * `renderStartupCard` returns early when `!process.stdout.isTTY` (line
 * 1781), so a piped-stdout subprocess never reaches the greeter call
 * site. A proper PTY-spawn test would need `node-pty` as a dev dep —
 * deferred to v4.10 testing infrastructure.
 *
 * What this test DOES verify:
 *   • The greeter module is wired into chatSession (no mock of ./greeter).
 *   • Running renderStartupCard under forced-TTY conditions emits the
 *     greeter speech to display.write.
 *   • The greeter writes its history file to the real fs (tmpdir).
 *   • A seeded distillation drives the continuity-open-item template
 *     into the rendered output — the wiring works in concert with
 *     the rest of the boot sequence.
 *
 * Compared to Slice 1a integration.test.ts: that test called
 * renderGreeter() directly. THIS test calls the real chatSession
 * method that contains the renderGreeter call site. If the wiring is
 * ever accidentally removed, this test fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  ChatSession,
  type ChatSessionOptions,
  type ChatPromptApi,
} from '../../../../cli/v4/chatSession';
import { CommandRegistry } from '../../../../cli/v4/commandRegistry';
import { Display } from '../../../../cli/v4/display';
import { SkinEngine } from '../../../../cli/v4/skinEngine';
import { readHistory, writeHistory } from '../../../../cli/v4/greeter/history';
import type { AidenPaths, GreeterHistory } from '../../../../cli/v4/greeter/types';
import { VERSION as AIDEN_VERSION } from '../../../../core/version';

// The greeter's update banner fires only when the cached `latest` is
// strictly NEWER than the running Aiden version (scanUpdate → isNewer).
// A hardcoded literal (the old `4.9.99`) rots on every release: once the
// package version passed it, `latest` was no longer newer and the banner
// stopped rendering, failing this test on all platforms. Derive a version
// guaranteed newer than whatever `core/version.ts` reports at run time —
// the same source the product compares against — so the test tracks the
// real comparison instead of a soon-stale constant.
const NEWER_VERSION = `${Number(AIDEN_VERSION.split('.')[0] || '0') + 1}.0.0`;

// YYYY-MM-DD in local time — must match selectOffer.isoDateLocal so we can
// build the exact per-day offer id the greeter uses for decay lookups.
function isoDateLocal(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

let root: string;
let paths: AidenPaths;
let prevIsTTY: boolean | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-greeter-boot-'));
  // Greeter only needs `root`; full AidenPaths is satisfied via cast.
  paths = { root } as unknown as AidenPaths;
  // v4.12 — these tests model a RETURNING, already-onboarded user (they
  // seed greeter history). Write the onboarding marker so the speaks-first
  // intro is suppressed and the greeter runs as the subject under test.
  // (Without this, an empty USER.md + absent marker would trigger
  // onboarding, which now suppresses the greeter — see the dedicated
  // suppression test below, which clears this marker.)
  await fs.writeFile(path.join(root, '.onboarding-shown'), new Date().toISOString() + '\n', 'utf8');
  // Force process.stdout.isTTY=true for the duration of the test —
  // chatSession.renderStartupCard's gate at line 1781 reads the real
  // process.stdout, not our wrapped stream. Without this, the whole
  // method returns early and the greeter never runs.
  prevIsTTY = process.stdout.isTTY;
  (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
});

afterEach(async () => {
  (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = prevIsTTY;
  await fs.rm(root, { recursive: true, force: true });
});

/** Build a forced-TTY display capturing every write into a string[]. */
function mkTtyDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(_chunk, _enc, cb) { cb(); },
  }) as unknown as NodeJS.WriteStream;
  // CRITICAL: force isTTY=true. The greeter's call site sits inside
  // renderStartupCard, which returns early on non-TTY. The Slice 1a
  // tests didn't need this because they called renderGreeter directly;
  // this test exercises the chatSession code path so the TTY gate has
  // to be open.
  (out as unknown as { isTTY: boolean }).isTTY = true;
  (err as unknown as { isTTY: boolean }).isTTY = true;
  const display = new Display({
    skin:   new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, chunks };
}

function mkPromptApi(): ChatPromptApi {
  return {
    async readLine() { throw new Error('User force closed'); },
    async selectSlashCommand() { return null; },
  };
}

function buildOpts(over: Partial<ChatSessionOptions> = {}): ChatSessionOptions {
  const registry = new CommandRegistry();
  return {
    agent: {
      runConversation: vi.fn(),
      setProvider:     vi.fn(),
      setActiveModel:  vi.fn(() => true),
    } as never,
    display:          mkTtyDisplay().display,    // replaced by caller
    commandRegistry:  registry,
    callbacks:        {} as never,
    sessionManager:   {
      startSession:  vi.fn(() => ({ id: 'sess-test', title: null } as never)),
      recordTurn:    vi.fn(),
      resumeLatest:  vi.fn(),
      resumeById:    vi.fn(),
      listSessions:  vi.fn(() => []),
      setSessionTitle: vi.fn(),
      search:        vi.fn(() => []),
    } as never,
    approvalEngine: {
      setMode:        vi.fn(),
      getMode:        () => 'manual' as const,
      checkApproval:  vi.fn(async () => true),
      allowForSession: vi.fn(),
      allowAlways:    vi.fn(),
      resetSession:   vi.fn(),
    } as never,
    skin:             new SkinEngine({ forceMono: true }),
    toolRegistry: {
      list:          () => [],
      get:           () => undefined,
      getSchemas:    () => [],
      register:      vi.fn(),
      unregister:    vi.fn(),
      byCategory:    () => [],
      buildExecutor: () => async () => ({ id: '1', name: 'noop', result: null }),
    } as never,
    skillLoader: {
      list:           vi.fn(async () => []),
      load:           vi.fn(),
      loadAll:        vi.fn(async () => []),
      readSkillFile:  vi.fn(),
    } as never,
    resolver: {
      resolve:       vi.fn(async () => ({ call: vi.fn() })),
      describe:      vi.fn(),
      listProviders: vi.fn(() => []),
      listModels:    vi.fn(() => []),
    } as never,
    config:           {} as never,
    initialProviderId: 'groq',
    initialModelId:   'llama-3.3-70b-versatile',
    installSignalHandler: false,
    paths,                                       // ← greeter needs this
    promptApi:        mkPromptApi(),
    ...over,
  };
}

function mkHistory(over: Partial<GreeterHistory> = {}): GreeterHistory {
  return {
    v: 1,
    firstLaunchAt:  '2026-05-23T16:30:00.000Z',
    lastGreetingAt: '2026-05-24T09:14:00.000Z',
    offers: [], disabled: false,
    ...over,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('renderStartupCard — greeter wiring', () => {
  it('on first-ever launch: greeter is invoked, writes history, stays silent (no greeter speech in output)', async () => {
    const { display, chunks } = mkTtyDisplay();
    const session = new ChatSession(buildOpts({ display }));
    await session.renderStartupCard();

    // History file MUST exist after first-launch invocation — proves
    // renderGreeter was reached from the real chatSession code path.
    const h = await readHistory(paths);
    expect(h).not.toBeNull();
    expect(h!.offers).toEqual([]);

    // First-launch is SILENT (per Phase B refinement 1) — none of the
    // active greeter templates should appear in the output.
    const text = chunks.join('');
    expect(text).not.toMatch(/Welcome back/);
    expect(text).not.toMatch(/Last session left this open/);
    expect(text).not.toMatch(/aiden-runtime .* available/);
  });

  it('with history.disabled=true: greeter is invoked but emits NOTHING', async () => {
    await writeHistory(paths, mkHistory({ disabled: true }));
    const { display, chunks } = mkTtyDisplay();
    const session = new ChatSession(buildOpts({ display }));
    await session.renderStartupCard();

    const text = chunks.join('');
    expect(text).not.toMatch(/Welcome back|Last session|aiden-runtime/);
    // History stays disabled across the run.
    const h = await readHistory(paths);
    expect(h!.disabled).toBe(true);
  });

  it('with seeded distillation containing open_items[0]: the warm recall welcome appears in real chatSession output', async () => {
    // Pre-seed: a prior history file (so we're not in first-launch path)
    // + a distillation with an open item. Force lastCwd to match
    // process.cwd() so the cwd-changed offer doesn't shadow Tier 2.
    await writeHistory(paths, mkHistory({ lastCwd: process.cwd() }));
    const distDir = path.join(root, 'distillations');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(distDir, 'session-2026-05-24.json'),
      JSON.stringify({
        open_items: ['decide on redis vs postgres for session store'],
        decisions:  ['shipped v4.9.2'],
      }),
      'utf8',
    );

    const { display, chunks } = mkTtyDisplay();
    const session = new ChatSession(buildOpts({ display }));
    await session.renderStartupCard();

    const text = chunks.join('');
    // The exact greeter speech must appear in the captured output.
    // This is the proof-of-life: the chatSession's real boot path invoked
    // renderGreeter, which built the recall welcome (buildWelcomeLine) from
    // the distillation's open item, which wrote to display.
    expect(text).toContain('Welcome back! Last time: decide on redis vs postgres for session store');
  });

  it('with seeded update cache: update-available appears in real chatSession output', async () => {
    // update-available is Tier 4 (lowest); it only surfaces when no
    // higher tier fires. The greeter reads the REAL local clock (no
    // injection on the boot path), so a run in the evening (hour >= 18)
    // would otherwise fire the Tier-3 time-of-day-evening offer and
    // shadow update — flaky by wall-clock (incl. CI running in the
    // evening in UTC). Suppress that Tier-3 offer via the product's own
    // decay path: seed an `ignored` record for today's evening id
    // (selectOffer.isDecayedRecently). lastCwd = cwd suppresses the other
    // Tier-3 offer (cwd-changed); no distillation is seeded so Tier 2
    // (continuity / welcome-back) stays silent. Update then wins
    // deterministically.
    const now = new Date();
    await writeHistory(paths, mkHistory({
      lastCwd: process.cwd(),
      // v4.14 — a RECENT last session so the Tier-2 time-gap welcome doesn't
      // fire and shadow the update (the greeter reads the real clock; the
      // default seed's old lastGreetingAt would otherwise read as a >24h gap).
      lastSessionAt: now.toISOString(),
      offers: [{
        id:        `time-of-day-evening-${isoDateLocal(now)}`,
        offeredAt: now.toISOString(),
        response:  'ignored',
      }],
    }));
    await fs.writeFile(
      path.join(root, '.update_check.json'),
      JSON.stringify({ latest: NEWER_VERSION }),
      'utf8',
    );

    const { display, chunks } = mkTtyDisplay();
    const session = new ChatSession(buildOpts({ display }));
    await session.renderStartupCard();

    const text = chunks.join('');
    const escapedNewer = NEWER_VERSION.replace(/\./g, '\\.');
    expect(text).toMatch(new RegExp(`aiden-runtime .* → ${escapedNewer} available\\.`));
    expect(text).toContain('/update install');
  });

  it('v4.12 — suppresses the greeter when onboarding fires (no contradictory "welcome back")', async () => {
    // Onboarding-eligible state: clear the marker beforeEach wrote, and the
    // {root} paths cast leaves USER.md absent (= empty). Seed greeter history
    // that WOULD trigger the Tier-2 "welcome back" offer, to prove the greeter
    // is skipped entirely (not merely offer-less) when the speaks-first intro
    // owns the boot — the upgrade-cohort contradiction the fix prevents.
    await fs.rm(path.join(root, '.onboarding-shown'), { force: true });
    await writeHistory(paths, mkHistory({ lastCwd: process.cwd() }));

    const { display, chunks } = mkTtyDisplay();
    const session = new ChatSession(buildOpts({ display }));
    await session.renderStartupCard();

    // The greeter writes to `display` (captured here); the onboarding intro
    // writes to process.stdout. So an empty-of-greeter-speech display proves
    // the greeter was suppressed.
    const text = chunks.join('');
    expect(text).not.toMatch(/Welcome back/);
    expect(text).not.toMatch(/Last session/);
  });
});

describe('renderStartupCard — greeter never breaks boot', () => {
  it('if paths.root is unwritable, greeter swallows + boot continues', async () => {
    // Place a FILE where the root should be a directory so writeHistory
    // mkdir fails. renderGreeter must swallow; renderStartupCard
    // must complete; chatSession must not throw.
    const blocker = path.join(root, 'blocker');
    await fs.writeFile(blocker, 'file not dir');
    const blockedPaths = { root: path.join(blocker, 'inside') } as unknown as AidenPaths;

    const { display, chunks } = mkTtyDisplay();
    const session = new ChatSession(buildOpts({ display, paths: blockedPaths }));
    await expect(session.renderStartupCard()).resolves.toBeUndefined();
    // Boot can still render other things (banner, pills, etc.) so we
    // don't assert chunks.length === 0 — just that no greeter speech
    // crashed through.
    const text = chunks.join('');
    expect(text).not.toMatch(/Last session left this open/);
  });
});
