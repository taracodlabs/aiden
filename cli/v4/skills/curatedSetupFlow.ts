/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/skills/curatedSetupFlow.ts — v4.9.5 Slice 1.
 *
 * Shared two-stage confirm flow for installing curated skills. Used by:
 *   - cli/v4/setupWizard.ts                 (onboarding Step 4)
 *   - cli/v4/commands/skills.ts             (/skills setup re-invoke)
 *
 * Both surfaces share this orchestration so the install UX is
 * identical regardless of entry point. Module-locality > line-locality
 * (same reasoning as v4.9.4's fillRemainingAsBlocked extraction).
 *
 * Flow:
 *   1. Fetch manifest (one HTTP, cached by SkillsHub per-process)
 *   2. Render preview table (Name | Author | Category | License | Size)
 *   3. Confirm with the v4.9.2 Slice 3 primitive
 *   4. Sequential install via SkillsHub.install('official/<name>')
 *   5. Report counts (installed / failed) via display.success / warn
 *
 * Per Phase B Q3 (cut #2): no "already installed" reconciliation in
 * v4.9.5 — just install everything. SkillsHub's _installHash + user-
 * modified-check makes re-install idempotent for unmodified skills;
 * the proper /skills update command ships in v4.10.
 */

import type { SkillsHub } from '../../../core/v4/skillsHub';
import {
  renderManifestPreview,
  type CuratedManifest,
} from '../../../core/v4/skills/curatedManifest';

/**
 * Minimal display surface — keeps the helper testable without dragging
 * in the whole Display class. Real callers pass `ctx.display` or the
 * setupWizard's display.
 */
export interface CuratedSetupDisplay {
  write(text: string):    void;
  dim(text: string):      void;
  warn(text: string):     void;
  success(text: string):  void;
  printError(text: string, hint?: string): void;
}

/**
 * Confirmation primitive shape (v4.9.2 Slice 3). Both setupWizard
 * and /skills handlers have access to a confirm function in their
 * native context; this helper accepts the same shape.
 */
export type CuratedConfirm = (msg: string) => Promise<boolean>;

export interface RunCuratedSetupOptions {
  hub:        SkillsHub;
  display:    CuratedSetupDisplay;
  confirm:    CuratedConfirm;
  /** Optional pre-fetched manifest (test seam) so callers that already
   *  have a manifest can skip the SkillsHub roundtrip. Tests use this;
   *  production callers always omit it (the SkillsHub cache handles
   *  per-process dedup). */
  manifest?:  CuratedManifest;
}

export interface CuratedSetupResult {
  /** True iff the user accepted Stage 2 AND at least one skill installed. */
  ranInstall: boolean;
  installed:  number;
  failed:     number;
  skipped:    boolean;          // true when user declined Stage 2
  fetchError?: string;          // set when the manifest fetch itself failed
}

/**
 * Run the two-stage flow. NEVER throws — failure paths return
 * structured results so the caller can render appropriate UX.
 */
export async function runCuratedSetupFlow(
  opts: RunCuratedSetupOptions,
): Promise<CuratedSetupResult> {
  // Stage 1 caller is responsible (wizard already asked "Install curated
  // skills?"). This helper picks up at Stage 2 — fetch + preview + confirm.

  let manifest: CuratedManifest | null = opts.manifest ?? null;
  if (!manifest) {
    opts.display.write('\n  Fetching curated skills manifest…\n');
    try {
      // Use SkillsHub's cached manifest — one fetch per process,
      // shared between preview and install. Also avoids a fetchImpl
      // parameter that would have to be threaded through every
      // caller (and that diverged from SkillsHub's own fetch in
      // testing — Slice 1 implementation drift).
      const cache = await opts.hub.getCuratedManifest();
      manifest = {
        schema_version: 1,
        snapshot_at:    '',   // not surfaced in preview — would require widening hub API; not blocking
        commit:         cache.commit,
        skills:         Array.from(cache.entries.values()),
      };
    } catch (err) {
      const reason = (err as Error).message;
      opts.display.warn(`Could not fetch curated skills: ${reason}.`);
      opts.display.dim('  Skipping. You can re-try later with /skills setup.\n');
      return { ranInstall: false, installed: 0, failed: 0, skipped: true, fetchError: reason };
    }
  }

  if (manifest.skills.length === 0) {
    opts.display.dim('Curated catalog is empty. Nothing to install.');
    return { ranInstall: false, installed: 0, failed: 0, skipped: false };
  }

  // Stage 2: preview + confirm.
  const preview = renderManifestPreview(manifest);
  opts.display.write('\n  Available curated skills:\n\n');
  opts.display.write(preview.table + '\n');
  opts.display.write(
    `  ${preview.count} skills · ${(preview.totalBytes / 1024).toFixed(1)} KB total · ` +
    `pinned to commit ${manifest.commit.slice(0, 7)}\n\n`,
  );

  const proceed = await opts.confirm(
    `Install these ${preview.count} skills (${(preview.totalBytes / 1024).toFixed(1)} KB)?`,
  );
  if (!proceed) {
    // confirm() primitive already printed the cancellation reason.
    return { ranInstall: false, installed: 0, failed: 0, skipped: true };
  }

  // Sequential install.
  let installed = 0;
  let failed   = 0;
  for (const entry of manifest.skills) {
    const result = await opts.hub.install(`official/${entry.name}`);
    if (result.ok) {
      installed += 1;
    } else {
      failed += 1;
      opts.display.warn(`  ✗ ${entry.name}: ${result.reason ?? 'install failed'}`);
    }
  }
  if (failed === 0) {
    opts.display.success(`Installed ${installed} curated skills.`);
  } else {
    opts.display.warn(`Installed ${installed} of ${manifest.skills.length} curated skills (${failed} failed).`);
  }
  return { ranInstall: true, installed, failed, skipped: false };
}
