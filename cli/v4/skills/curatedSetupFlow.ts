/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/skills/curatedSetupFlow.ts — v4.9.5 Slice 1.5.
 *
 * Shared three-tier confirm + per-skill picker flow for installing
 * curated skills. Used by:
 *   - cli/v4/setupWizard.ts          (onboarding Step 4, via finalizeWithCuratedStep)
 *   - cli/v4/commands/skills.ts      (/skills setup re-invoke)
 *
 * Slice 1 shipped a binary yes/no Stage 2. Slice 1.5 replaces that
 * with three-tier choice + multi-select picker so users can pick
 * exactly which skills they want — discovered when the user
 * requested per-skill selection. Also wires runLoadingSequence
 * (the v4.6.1 onboarding animation) into the manifest fetch + the
 * per-skill install loop, so author names flash by in the status
 * column.
 *
 * Flow:
 *   1. Animated fetch via runLoadingSequence (one row, status =
 *      "N skills · commit abc1234")
 *   2. Render preview table (Name | Author | Category | License | Size)
 *   3. Three-tier prompt:  (A)ll, (p)ick, (s)kip  →
 *      - A or <Enter>  → install everything
 *      - p             → checkbox picker, install selection
 *      - s/n/no        → skip with reason line
 *      - garbage       → re-prompt once; second garbage = skip
 *   4. runLoadingSequence again — one row per chosen skill
 *   5. Summary line: "Installed X of N · Y KB" or "X of N · Y KB · Z failed"
 *
 * Per Phase B Q3 (cut #2): no "already installed" reconciliation in
 * v4.9.5 — just install what was chosen. SkillsHub's _installHash +
 * user-modified-check makes re-install idempotent for unmodified
 * skills; the proper /skills update command ships in v4.10.
 */

import kleur from 'kleur';

import type { SkillsHub } from '../../../core/v4/skillsHub';
import type { CuratedManifestEntry } from '../../../core/v4/skills/curatedManifest';
import {
  renderManifestPreview,
  type CuratedManifest,
} from '../../../core/v4/skills/curatedManifest';
import { runLoadingSequence, type LoadingStep } from '../onboarding/loading';

/**
 * Minimal display surface — keeps the helper testable without dragging
 * in the whole Display class. Real callers pass `ctx.display` or the
 * setupWizard's display. `paint` is needed for the warn-tinted `?`
 * glyph on the three-tier prompt (matches v4.9.2 Slice 3 confirm
 * primitive chrome).
 */
export interface CuratedSetupDisplay {
  write(text: string):    void;
  dim(text: string):      void;
  warn(text: string):     void;
  success(text: string):  void;
  printError(text: string, hint?: string): void;
  /** v4.9.5 Slice 1.5 — added for the three-tier `?` glyph. */
  paint(text: string, kind: 'brand' | 'success' | 'warn' | 'error' | 'muted'): string;
}

/**
 * Minimal prompts shape — only `input` is used; the same shape the
 * wizard's PromptIO provides. v4.9.5 Slice 1.5 replaces the prior
 * `confirm: CuratedConfirm` parameter because the three-tier Stage 2
 * no longer maps cleanly to a boolean.
 */
export interface CuratedSetupPrompts {
  input(question: string, opts?: { default?: string; mask?: boolean }): Promise<string>;
}

export interface RunCuratedSetupOptions {
  hub:        SkillsHub;
  display:    CuratedSetupDisplay;
  prompts:    CuratedSetupPrompts;
  /** Optional pre-fetched manifest (test seam) so callers that already
   *  have a manifest can skip the SkillsHub roundtrip. Tests use this;
   *  production callers always omit it (the SkillsHub cache handles
   *  per-process dedup). */
  manifest?:  CuratedManifest;
  /** Test-only — override the multi-select picker. Production callers
   *  always omit; the real implementation lazy-loads @inquirer/prompts
   *  and requires a real TTY. */
  pickerOverride?: (manifest: CuratedManifest) => Promise<CuratedManifestEntry[]>;
}

export interface CuratedSetupResult {
  /** True iff the user accepted Stage 2 AND at least one skill installed. */
  ranInstall:  boolean;
  installed:   number;
  failed:      number;
  /** True when the user declined at the three-tier prompt (`s` or garbage). */
  skipped:     boolean;
  /** Set when the manifest fetch itself failed. */
  fetchError?: string;
  /** Slice 1.5 — which Stage 2 path the user took. */
  stage2:      'all' | 'pick' | 'skip' | 'fetch-failed' | 'empty';
}

/** Stage 2 choice returned by the three-tier prompt. */
type Stage2Choice = 'all' | 'pick' | 'skip';

/**
 * Run the flow. NEVER throws — failure paths return structured results
 * so the caller can render appropriate UX.
 */
export async function runCuratedSetupFlow(
  opts: RunCuratedSetupOptions,
): Promise<CuratedSetupResult> {
  // ── Stage A: fetch manifest (or use pre-fetched) ──────────────────
  let manifest: CuratedManifest | null = opts.manifest ?? null;
  if (!manifest) {
    let cache: { commit: string; entries: ReadonlyMap<string, CuratedManifestEntry> } | null = null;
    const fetchResult = await runLoadingSequence(
      [
        {
          label: 'Fetching curated catalog',
          run: async (): Promise<{ status: string }> => {
            cache = await opts.hub.getCuratedManifest();
            return {
              status: `${cache.entries.size} skills · commit ${cache.commit.slice(0, 7)}`,
            };
          },
        },
      ],
      { out: process.stdout, heading: 'Loading curated skills…' },
    );
    if (!fetchResult.ok || !cache) {
      const reason = fetchResult.steps[0]?.status ?? 'unknown error';
      opts.display.warn(`Could not fetch curated skills: ${reason}.`);
      opts.display.dim('  Skipping. You can re-try later with /skills setup.\n');
      return {
        ranInstall: false, installed: 0, failed: 0,
        skipped: true, fetchError: reason, stage2: 'fetch-failed',
      };
    }
    manifest = {
      schema_version: 1,
      snapshot_at:    '',
      commit:         (cache as { commit: string }).commit,
      skills:         Array.from((cache as { entries: ReadonlyMap<string, CuratedManifestEntry> }).entries.values()),
    };
  }

  if (manifest.skills.length === 0) {
    opts.display.dim('Curated catalog is empty. Nothing to install.');
    return { ranInstall: false, installed: 0, failed: 0, skipped: false, stage2: 'empty' };
  }

  // ── Stage B: render preview ───────────────────────────────────────
  const preview = renderManifestPreview(manifest);
  opts.display.write('\n  Available curated skills:\n\n');
  opts.display.write(preview.table + '\n');
  opts.display.write(
    `  ${preview.count} skills · ${(preview.totalBytes / 1024).toFixed(1)} KB total · ` +
    `pinned to commit ${manifest.commit.slice(0, 7)}\n\n`,
  );

  // ── Stage C: three-tier prompt ────────────────────────────────────
  const choice = await promptStage2Choice(
    opts.prompts,
    opts.display,
    preview.count,
    (preview.totalBytes / 1024).toFixed(1),
  );

  let chosen: readonly CuratedManifestEntry[];
  if (choice === 'skip') {
    opts.display.dim('  Skipped curated skills.');
    return { ranInstall: false, installed: 0, failed: 0, skipped: true, stage2: 'skip' };
  } else if (choice === 'all') {
    chosen = manifest.skills;
  } else {
    // 'pick' — open the checkbox picker
    const picker = opts.pickerOverride ?? pickIndividualSkills;
    chosen = await picker(manifest);
    if (chosen.length === 0) {
      // Picker already printed its own "skipped" reason.
      return { ranInstall: false, installed: 0, failed: 0, skipped: true, stage2: 'pick' };
    }
  }

  // ── Stage D: animated install via runLoadingSequence ──────────────
  const installSteps: LoadingStep[] = chosen.map((entry) => ({
    label: `Installing ${entry.name}`,
    run:   async (): Promise<{ status: string }> => {
      const result = await opts.hub.install(`official/${entry.name}`);
      if (!result.ok) throw new Error(result.reason ?? 'install failed');
      return { status: `${entry.author} · ${(entry.size_bytes / 1024).toFixed(1)} KB` };
    },
  }));
  const installResult = await runLoadingSequence(installSteps, {
    out:     process.stdout,
    heading: `Installing ${chosen.length} curated skill${chosen.length === 1 ? '' : 's'}…`,
  });

  // ── Stage E: summary ──────────────────────────────────────────────
  const installed = installResult.steps.filter((s) => s.ok).length;
  const failed    = installResult.steps.length - installed;
  const totalKB   = chosen.reduce((sum, s) => sum + s.size_bytes, 0) / 1024;
  if (failed === 0) {
    opts.display.success(
      `Installed ${installed} of ${chosen.length} curated skills · ${totalKB.toFixed(1)} KB.`,
    );
  } else {
    // Surface each failure so the user knows what dropped.
    for (const step of installResult.steps) {
      if (!step.ok) opts.display.warn(`  ✗ ${step.label.replace(/^Installing /, '')}: ${step.status}`);
    }
    opts.display.warn(
      `Installed ${installed} of ${chosen.length} curated skills · ${totalKB.toFixed(1)} KB · ${failed} failed.`,
    );
  }
  return {
    ranInstall: installed > 0,
    installed, failed,
    skipped:    false,
    stage2:     choice,
  };
}

// ─── Three-tier prompt ─────────────────────────────────────────────

/**
 * Ask the (A)ll / (p)ick / (s)kip prompt. Capital A = default per the
 * (y/N) convention from v4.9.2 Slice 3 — Enter alone installs all
 * because the user already said yes at Stage 1.
 *
 * Garbage input gets ONE re-prompt with the user's input echoed back
 * (so they realize the mismatch — e.g. typed "y" thinking yes/no);
 * second garbage = skip with explicit reason.
 *
 * Never throws.
 */
async function promptStage2Choice(
  promptApi: CuratedSetupPrompts,
  display:   CuratedSetupDisplay,
  count:     number,
  kb:        string,
): Promise<Stage2Choice> {
  const parse = (raw: unknown): Stage2Choice | 'invalid' => {
    const t = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
    if (t === '' || t === 'a' || t === 'all')                 return 'all';
    if (t === 'p' || t === 'pick')                            return 'pick';
    if (t === 's' || t === 'skip' || t === 'n' || t === 'no') return 'skip';
    return 'invalid';
  };

  const decoratedFirst =
    `${display.paint('?', 'warn')} Install ${count} curated skills (${kb} KB): (A)ll, (p)ick, (s)kip  →  `;
  const firstRaw   = await promptApi.input(decoratedFirst);
  const firstParse = parse(firstRaw);
  if (firstParse !== 'invalid') return firstParse;

  // Second attempt — echo input back so the user sees the mismatch.
  display.dim(`  Could not parse "${(firstRaw ?? '').toString().trim()}" — type a, p, or s.`);
  const decoratedSecond =
    `${display.paint('?', 'warn')} (A)ll, (p)ick, (s)kip  →  `;
  const secondRaw   = await promptApi.input(decoratedSecond);
  const secondParse = parse(secondRaw);
  if (secondParse !== 'invalid') return secondParse;

  display.dim(`  Could not parse "${(secondRaw ?? '').toString().trim()}" — skipping curated skills.`);
  return 'skip';
}

// ─── Per-skill checkbox picker ─────────────────────────────────────

/**
 * Multi-select picker. Pattern adapted from cli/v4/promotionPrompt.ts —
 * dynamic `await import('@inquirer/prompts')` (vitest's vi.mock can
 * intercept), try/catch converts Esc / Ctrl+C ("User force closed
 * the prompt") into an empty selection.
 *
 * Default-checked rationale: the user has already said yes twice
 * (Stage 1 opt-in + Stage 2 "pick"). Defaulting all checked matches
 * intent; the user un-checks the few they want to exclude. Forcing
 * the user to check-up-from-zero would be friction theater.
 */
async function pickIndividualSkills(
  manifest: CuratedManifest,
): Promise<CuratedManifestEntry[]> {
  // Dynamic ES import (not CommonJS require) so vitest's vi.mock can
  // intercept the call in tests. Same pattern as promotionPrompt.ts.
  const inq = await import('@inquirer/prompts') as unknown as {
    checkbox: (opts: {
      message:  string;
      choices:  Array<{ name: string; value: number; checked?: boolean }>;
      loop?:    boolean;
      pageSize?: number;
    }) => Promise<number[]>;
  };

  try {
    const selected = await inq.checkbox({
      message: 'Pick curated skills to install (space toggles · enter confirms · esc cancels)',
      choices: manifest.skills.map((s, i) => ({
        name:    `${s.name}  —  ${kleur.dim(`${s.author} · ${s.category} · ${s.license} · ${(s.size_bytes / 1024).toFixed(1)} KB`)}`,
        value:   i,
        checked: true,        // R1 alignment: opt-in implies "I want these"
      })),
      loop:     false,
      pageSize: Math.min(15, manifest.skills.length),
    });
    if (selected.length === 0) {
      // Will be reported by the caller's branch.
      return [];
    }
    return selected.map((i) => manifest.skills[i]);
  } catch {
    // Esc / Ctrl+C → "User force closed the prompt".
    return [];
  }
}
