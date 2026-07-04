/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/history.ts — v4.9.3 SLICE 1a.
 *
 * Greeter state persistence. Single JSON file at
 * `<paths.root>/.greeter-history.json` — matches the existing
 * `.first-run-shown` / `.recent-commands.json` precedent rather than
 * carving out a `state/` subdirectory for one file.
 *
 * Three exported helpers:
 *   - readHistory   → null when the file does not exist (first launch)
 *   - writeHistory  → atomic via tmp + rename, matches the v4
 *                     `upsertEnv` pattern
 *   - reconcilePending → pure function that walks the history and
 *                       resolves pending offers (no `response` yet)
 *                       using passive next-boot signals from the scan
 *                       result. No fs IO inside; caller writes after.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from '../../../core/v4/paths';
import {
  type GreeterHistory,
  type ScanResult,
  DECAY_DAYS_ENVIRONMENT,
  DECAY_DAYS_UPDATE,
} from './types';

const FILE_NAME = '.greeter-history.json';

/** Absolute path to the greeter history file. Exported for tests. */
export function historyPath(paths: AidenPaths): string {
  return path.join(paths.root, FILE_NAME);
}

/**
 * Read the history file. Returns null when:
 *   - the file does not exist (first launch — caller stays silent), OR
 *   - the JSON fails to parse (treat as corrupt → start fresh)
 *
 * Returns the parsed object on success. Schema version is checked; an
 * unknown `v` value also returns null so a forward-incompatible file
 * doesn't crash an older Aiden mid-boot. Real schema migrations get
 * their own seam in a future slice.
 */
export async function readHistory(
  paths: AidenPaths,
  fsImpl: typeof fs = fs,
): Promise<GreeterHistory | null> {
  try {
    const raw = await fsImpl.readFile(historyPath(paths), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GreeterHistory>;
    if (parsed?.v !== 1) return null;
    return {
      v:               1,
      firstLaunchAt:   typeof parsed.firstLaunchAt   === 'string' ? parsed.firstLaunchAt   : new Date().toISOString(),
      lastGreetingAt:  typeof parsed.lastGreetingAt  === 'string' ? parsed.lastGreetingAt  : new Date().toISOString(),
      // Optional durable session marker; absent in files written before v4.14.
      lastSessionAt:   typeof parsed.lastSessionAt   === 'string' ? parsed.lastSessionAt   : undefined,
      lastCwd:         typeof parsed.lastCwd === 'string' ? parsed.lastCwd : undefined,
      offers:          Array.isArray(parsed.offers) ? parsed.offers : [],
      disabled:        parsed.disabled === true,
    };
  } catch {
    // ENOENT or parse error — caller decides what null means.
    return null;
  }
}

/**
 * Atomically write the history file. tmp + rename so a process crash
 * mid-write never leaves a half-written JSON the next boot trips on.
 * Errors are swallowed at the boundary by callers (orchestrator) so
 * a read-only disk doesn't crash the REPL.
 */
export async function writeHistory(
  paths:   AidenPaths,
  history: GreeterHistory,
  fsImpl:  typeof fs = fs,
): Promise<void> {
  await fsImpl.mkdir(paths.root, { recursive: true });
  const dst = historyPath(paths);
  const tmp = `${dst}.${process.pid}.tmp`;
  await fsImpl.writeFile(tmp, JSON.stringify(history, null, 2) + '\n', 'utf8');
  await fsImpl.rename(tmp, dst);
}

/**
 * Walk pending offers (response === undefined) and resolve them using
 * passive next-boot signals. Pure — no IO, no clock peek (now is a
 * parameter). Caller writes the returned history via writeHistory.
 *
 * Resolution rules:
 *   • update-available-<X>:
 *       installed >= X         → accepted
 *       offeredAt > 7 days ago → ignored
 *       else                   → still pending
 *
 *   • greeting-only offers (no expectedAction — welcome-back,
 *     time-of-day-evening, cwd-changed):
 *       always → ignored (decay window applies separately on the
 *       NEXT offer attempt via selectOffer; reconciliation just
 *       flips the response flag so the record is closed).
 *
 *   • Tier-1 stubs (daemon-crashed, hook-auto-disabled) — Slice 1
 *     scanners never produce these, so reconciliation never sees them.
 *     The branch is omitted; v4.10 adds it alongside the scanners.
 *
 * Decay windows themselves live in `selectOffer` — this function just
 * closes the response field. Decay is computed against `offeredAt`
 * by the selector at next-greet time, NOT here.
 */
export interface ReconcileInput {
  history:           GreeterHistory;
  scan:              ScanResult;
  /** Currently-running Aiden version. Used to detect update acceptance. */
  installedVersion:  string;
  now:               Date;
}

export function reconcilePending(input: ReconcileInput): GreeterHistory {
  const { history, installedVersion, now } = input;
  const ageDays = (offeredAt: string): number =>
    (now.getTime() - Date.parse(offeredAt)) / (1000 * 60 * 60 * 24);

  const resolved = history.offers.map((o) => {
    if (o.response) return o;            // already settled
    // update-available-<targetVersion> — accepted if running >= target.
    if (o.id.startsWith('update-available-')) {
      const target = o.id.slice('update-available-'.length);
      if (semverGte(installedVersion, target)) {
        return { ...o, response: 'accepted' as const };
      }
      if (ageDays(o.offeredAt) > DECAY_DAYS_UPDATE) {
        return { ...o, response: 'ignored' as const };
      }
      return o;
    }
    // Greeting-only offers (no expectedAction) — close immediately on
    // next boot. Decay against future offers of the same id happens at
    // selectOffer time, not here.
    if (!o.expectedAction) {
      return { ...o, response: 'ignored' as const };
    }
    // Other environment offers with an expectedAction — decay by env
    // window. (Slice 1 has none in this category; v4.10 may add.)
    if (ageDays(o.offeredAt) > DECAY_DAYS_ENVIRONMENT) {
      return { ...o, response: 'ignored' as const };
    }
    return o;
  });

  return { ...history, offers: resolved };
}

/**
 * Lightweight semver-`>=` for dot-separated numeric versions. Enough
 * for the v4.X.Y space; does not handle pre-release tags (offer ids
 * never carry them — they're built from `UpdateStatus.latest` which
 * the npm registry returns as a clean release version).
 */
function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => Number(s) || 0);
  const pb = b.split('.').map((s) => Number(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true;  // equal
}
