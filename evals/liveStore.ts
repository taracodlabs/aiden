/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/liveStore.ts — v4.14 Pillar 5 Slice B.
 *
 * Disk I/O for the live path: the committed pass-rate baseline
 * (evals/baseline-live.json) and the rolling per-scenario reliability record
 * (evals/reliability.json). Pure JSON, no schema engine. Kept separate from the
 * pure logic in live.ts so that module stays fs-free + trivially unit-testable.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { LiveBaselineEntry, ReliabilityRecord } from './live';

export const LIVE_BASELINE_PATH = path.join(__dirname, 'baseline-live.json');
export const RELIABILITY_PATH   = path.join(__dirname, 'reliability.json');

/** The committed pass-rate baseline: subset ids + expected rate + band. */
export interface LiveBaselineFile {
  model:     string;
  provider:  string;
  /** Scenario ids the live subset runs (the cheap subset). */
  subset:    string[];
  /** Default noise band when an entry omits its own. */
  band:      number;
  entries:   Record<string, LiveBaselineEntry>;
}

export async function loadLiveBaseline(p = LIVE_BASELINE_PATH): Promise<LiveBaselineFile | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as LiveBaselineFile;
  } catch {
    return null;
  }
}

export type ReliabilityFile = Record<string, ReliabilityRecord>;

export async function loadReliability(p = RELIABILITY_PATH): Promise<ReliabilityFile> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as ReliabilityFile;
  } catch {
    return {};
  }
}

export async function saveReliability(records: ReliabilityFile, p = RELIABILITY_PATH): Promise<void> {
  await fs.writeFile(p, JSON.stringify(records, null, 2) + '\n', 'utf8');
}
