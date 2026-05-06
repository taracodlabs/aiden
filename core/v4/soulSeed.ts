/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/soulSeed.ts — Phase 16b.3
 *
 * First-run seed for `<aiden-home>/SOUL.md`. Idempotent: only writes when the
 * file is missing or empty so user edits are never overwritten.
 *
 * Hermes reference: `hermes_cli/config.py::_ensure_default_soul_md`. Same
 * shape: read path → bail if exists → write the bundled default. We add an
 * explicit empty-file check (zero bytes / whitespace) because some test
 * setups create the file as a placeholder.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from './paths';
import {
  DEFAULT_SOUL_MD,
  PREVIOUS_BUNDLED_SOULS,
} from '../../cli/v4/defaultSoul';

export interface SoulSeedResult {
  /**
   * 'seeded'   — file was missing/empty; default written.
   * 'upgraded' — Phase 16g: file matched a prior bundled default
   *               verbatim, silently replaced with the new default.
   * 'preserved'— file exists and looks user-edited (doesn't match any
   *               prior bundled hash). Left alone; caller may emit a
   *               one-time notice via `notice` field.
   * 'unchanged'— file already matches the current bundled default.
   */
  outcome: 'seeded' | 'upgraded' | 'preserved' | 'unchanged';
  /** Path that was checked / written. */
  soulPath: string;
  /** When set, the caller should display this once on boot. */
  notice?: string;
  /** Backwards-compat: true when the seeder wrote the file. */
  seeded: boolean;
}

/** Normalise line endings + trailing whitespace for cross-version compare. */
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

/**
 * Seed `<root>/SOUL.md` with the bundled default identity. Phase 16g:
 *  - If file is missing/empty: seed.
 *  - If file matches the *current* default verbatim: no-op.
 *  - If file matches a *previous* bundled default (e.g. 16b.3): silently
 *    upgrade to the new default — the user never edited it.
 *  - Else: preserve and surface a one-time `notice` so the user can
 *    review the new directives at their leisure.
 */
export async function ensureSoulMdSeeded(
  paths: AidenPaths,
): Promise<SoulSeedResult> {
  const soulPath = paths.soulMd;
  let existing: string | null = null;
  try {
    existing = await fs.readFile(soulPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Permission errors etc. — bail without seeding; promptBuilder will
      // still fall back to DEFAULT_IDENTITY in-process.
      return {
        outcome: 'preserved',
        seeded: false,
        soulPath,
      };
    }
  }

  const writeDefault = async (): Promise<void> => {
    await fs.mkdir(path.dirname(soulPath), { recursive: true });
    await fs.writeFile(soulPath, DEFAULT_SOUL_MD, { encoding: 'utf8' });
  };

  // Missing or empty → fresh seed.
  if (existing === null || !existing.trim()) {
    await writeDefault();
    return { outcome: 'seeded', seeded: true, soulPath };
  }

  const cur = normalise(existing);
  const target = normalise(DEFAULT_SOUL_MD);
  if (cur === target) {
    return { outcome: 'unchanged', seeded: false, soulPath };
  }

  // Phase 16g: silent upgrade when the user has a prior bundled default
  // verbatim (e.g. 16b.3 default). This catches the common "I never
  // touched SOUL.md after install" case.
  for (const prior of PREVIOUS_BUNDLED_SOULS) {
    if (normalise(prior) === cur) {
      await writeDefault();
      return { outcome: 'upgraded', seeded: true, soulPath };
    }
  }

  // User-edited content — preserve. Notice is one-time-display for
  // the chat session boot card.
  return {
    outcome: 'preserved',
    seeded: false,
    soulPath,
    notice:
      `Aiden's recommended SOUL.md has new autonomy directives ` +
      `(act_dont_ask / prerequisite_checks / missing_context / keep_going). ` +
      `Your edited copy at ${soulPath} was preserved. Run /identity to ` +
      `view your current SOUL.md or replace it manually to adopt the ` +
      `new defaults.`,
  };
}
