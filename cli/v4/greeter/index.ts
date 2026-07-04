/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/index.ts — v4.9.3 SLICE 1a.
 *
 * Boot-time greeter orchestrator. One shot per process.
 *
 * Behaviour contract (per Phase A/B):
 *   1. SILENT on first-ever launch (history file missing). Writes a
 *      fresh v:1 history then returns. The existing renderFirstRunHint
 *      owns the first-boot moment.
 *   2. SILENT when history.disabled === true (kill switch).
 *   3. SILENT when no offer wins (nothing noticeable).
 *   4. NEVER throws — internal errors are swallowed; a broken greeter
 *      must not crash the REPL.
 *   5. Reconciles pending offers from prior boots against current
 *      scan state BEFORE selecting a new offer; the new offer (if any)
 *      is appended to history with `response` undefined (pending).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from '../../../core/v4/paths';
import { c } from '../../../core/v4/ui/theme';
import { readHistory, writeHistory, reconcilePending } from './history';
import { runScans } from './scan';
import { selectOffer } from './selectOffer';
import type { GreeterHistory, Offer } from './types';

/**
 * Minimal Display surface the greeter needs. We accept this narrow
 * type rather than importing the full Display so tests can supply a
 * write-capture fake without satisfying ~30 unused methods.
 */
export interface GreeterDisplay {
  write(text: string): void;
  paint(text: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted'): string;
}

export interface RenderGreeterOptions {
  paths:    AidenPaths;
  version:  string;
  display:  GreeterDisplay;
  /** Test seam — defaults to new Date(). */
  now?:     Date;
  /** Test seam — defaults to process.cwd(). */
  cwd?:     string;
  /** Test seam — defaults to node:fs.promises. */
  fsImpl?:  typeof fs;
}

/**
 * Run the greeter exactly once. Always resolves; never throws.
 *
 * Returns nothing — speech (or silence) is written via display.write.
 * Tests assert against captured display.write calls, NOT a return
 * value (Slice 2 lesson: return-value snapshots prove nothing about
 * what reaches the terminal).
 */
export async function renderGreeter(opts: RenderGreeterOptions): Promise<void> {
  try {
    await renderGreeterUnsafe(opts);
  } catch {
    // Greeter must never crash the REPL. Silent on any internal error.
  }
}

async function renderGreeterUnsafe(opts: RenderGreeterOptions): Promise<void> {
  const fsImpl = opts.fsImpl ?? fs;
  const now    = opts.now    ?? new Date();
  const cwd    = opts.cwd    ?? process.cwd();

  // ── First-launch path: write fresh history, stay silent --------------
  const existing = await readHistory(opts.paths, fsImpl);
  if (existing === null) {
    const fresh: GreeterHistory = {
      v:               1,
      firstLaunchAt:   now.toISOString(),
      lastGreetingAt:  now.toISOString(),
      lastSessionAt:   now.toISOString(),   // durable marker — seeds the NEXT boot's gap
      lastCwd:         cwd,
      offers:          [],
      disabled:        false,
    };
    await writeHistory(opts.paths, fresh, fsImpl);
    return;  // SILENT — renderFirstRunHint owns this moment
  }

  // ── Reconcile pending offers from prior boots ------------------------
  const scanForReconcile = await runScans({
    paths:   opts.paths,
    cwd,
    now,
    version: opts.version,
    history: existing,
    fsImpl,
  });
  const reconciled = reconcilePending({
    history:          existing,
    scan:             scanForReconcile,
    installedVersion: opts.version,
    now,
  });

  // ── Pick at most one offer to render this boot ----------------------
  // v4.14 Bug 1 — the durable "previous session" timestamp. `lastSessionAt`
  // is written every boot; on files predating it, fall back to
  // `lastGreetingAt` (also rewritten every boot) so the first upgraded boot
  // still shows a real gap instead of the old frozen distillation-mtime value.
  const lastSessionAt = existing.lastSessionAt ?? existing.lastGreetingAt ?? null;
  const distillation = await loadLatestDistillation(opts.paths, fsImpl);
  const offer: Offer | null = selectOffer({
    scan:          scanForReconcile,
    history:       reconciled,
    now,
    paintMuted:    (s) => opts.display.paint(s, 'muted'),
    paintAccent:   (s) => c.accent(s),
    openItem:      distillation?.openItem,
    lastDecision:  distillation?.lastDecision,
    lastSessionAt,
    // Deterministic per-day rotation for the no-history fallback line.
    rotateSeed:    now.getDate(),
  });

  // ── Render (or stay silent) -----------------------------------------
  if (offer) {
    // 2-space indent + trailing blank to match firstRunHint layout.
    opts.display.write('  ' + offer.speech + '\n\n');
  }

  // ── Persist updated history -----------------------------------------
  // v4.14 Bug 1 — refresh the durable session marker on EVERY boot. This is
  // the write that was missing: because the old code leaned on distillation
  // mtime (rarely written), the gap froze. Session-start is the durable
  // write point — it always runs, unlike a clean-exit handler.
  const updated: GreeterHistory = {
    ...reconciled,
    lastGreetingAt: now.toISOString(),
    lastSessionAt:  now.toISOString(),
    lastCwd:        cwd,
    offers: offer
      ? [...reconciled.offers, {
          id:             offer.id,
          offeredAt:      now.toISOString(),
          expectedAction: offer.expectedAction,
        }]
      : reconciled.offers,
  };
  await writeHistory(opts.paths, updated, fsImpl);
}

/**
 * Read the newest distillation file and extract (open_items[0],
 * decisions[0]). Returns null when no distillations exist or any IO
 * fails — caller (selectOffer) treats null as "no continuity signal".
 *
 * Slice 1 strategy: list distillationsDir, sort by filename desc (the
 * existing distillation naming convention timestamps the filename so
 * lexicographic sort is reverse-chronological), read the newest, parse,
 * extract. No schema dependency on the distillation index — just the
 * field shape.
 */
async function loadLatestDistillation(
  paths:  AidenPaths,
  fsImpl: typeof fs,
): Promise<{ openItem: string | null; lastDecision: string | null } | null> {
  try {
    const dir = path.join(paths.root, 'distillations');
    const entries = await fsImpl.readdir(dir);
    if (entries.length === 0) return null;
    const newest = [...entries].sort().reverse()[0];
    const raw = await fsImpl.readFile(path.join(dir, newest), 'utf8');
    const parsed = JSON.parse(raw) as { open_items?: unknown; decisions?: unknown };
    const openItem = Array.isArray(parsed.open_items) && typeof parsed.open_items[0] === 'string'
      ? parsed.open_items[0] as string
      : null;
    const lastDecision = Array.isArray(parsed.decisions) && typeof parsed.decisions[0] === 'string'
      ? parsed.decisions[0] as string
      : null;
    return { openItem, lastDecision };
  } catch {
    return null;
  }
}
