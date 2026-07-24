/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/update.ts — Phase v4.1.2-update.
 *
 *   /update          — bypass the boot-time 6h cache, probe npm registry
 *                      fresh, print current vs latest with hint.
 *   /update install  — spawn `npm install -g aiden-runtime@latest`
 *                      via the shared executeInstall executor; print
 *                      restart hint on success or platform-specific
 *                      remediation on permission failure.
 *
 * No auto-restart on success — the user keeps control by typing
 * /quit and re-launching aiden. Honest UX: never claim the current
 * process is upgraded after a successful install. Auto-restart of
 * a node REPL via re-exec is also fragile across Windows/macOS/
 * Linux, so the explicit /quit path is both honest and reliable.
 */

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { VERSION as INSTALLED_VERSION } from '../../../core/version';
import { checkForUpdate, updateCacheFile, compareVersions } from '../../../core/v4/update/checkUpdate';
import { executeInstall } from '../../../core/v4/update/executeInstall';
import { detectInstallMethod } from '../../../core/v4/update/installMethodDetect';
import { inspectUpdateInstall } from '../../../core/v4/update/installPreflight';
import { applyUpdateFailure, clearUpdateFailure } from '../../../core/v4/update/failureBackoff';
import { applySkip, clearSkip } from '../../../core/v4/update/skipState';

async function printStatus(ctx: SlashCommandContext): Promise<void> {
  if (!ctx.paths) {
    ctx.display.warn('/update needs Aiden user-data paths — try in a real session.');
    return;
  }
  ctx.display.dim('Checking for updates…');
  // cacheTtlMs: 0 — user explicitly asked, so bypass the 6h boot cache.
  const status = await checkForUpdate({
    paths:            ctx.paths,
    installedVersion: INSTALLED_VERSION,
    cacheTtlMs:       0,
  });

  ctx.display.write(`  installed: v${status.installed}\n`);
  if (status.latest === null) {
    ctx.display.write('  latest:    unknown (registry unreachable)\n');
    ctx.display.dim('Could not reach the npm registry. Check your network and try again.');
    return;
  }
  ctx.display.write(`  latest:    v${status.latest}\n`);
  if (status.updateAvailable) {
    ctx.display.write(
      `\n  update available: v${status.installed} → v${status.latest}\n` +
      `  run \`/update install\` to install, or \`npm install -g aiden-runtime@latest\` manually.\n`,
    );
  } else {
    ctx.display.dim("You're on the latest version.");
  }
}

async function runInstall(ctx: SlashCommandContext): Promise<void> {
  if (!ctx.paths) {
    ctx.display.warn('/update install needs Aiden user-data paths — try in a real session.');
    return;
  }

  // Status probe first so we don't run a no-op install. Also bypasses
  // cache — same rationale as the bare /update path.
  ctx.display.dim('Checking for updates…');
  const status = await checkForUpdate({
    paths:            ctx.paths,
    installedVersion: INSTALLED_VERSION,
    cacheTtlMs:       0,
  });
  if (status.latest === null) {
    ctx.display.warn(
      "Couldn't check for updates (registry unreachable). " +
      'Try `/update` first, or run `npm install -g aiden-runtime@latest` manually.',
    );
    return;
  }
  if (!status.updateAvailable) {
    ctx.display.dim(`You're already on the latest version (v${status.installed}).`);
    return;
  }

  ctx.display.write(
    `Checking installation target for aiden-runtime v${status.latest}…\n`,
  );

  const plan = await inspectUpdateInstall({ targetVersion: status.latest });
  if (!plan.installAllowed) {
    for (const line of plan.guidance) ctx.display.warn(line);
    await updateCacheFile(ctx.paths, (current) =>
      applyUpdateFailure(current, status.latest!));
    return;
  }
  ctx.display.write(`  target prefix: ${plan.prefix}\n`);

  // v4.8.1 Slice 2 — reuse the v4.8.0 sliding-block shimmer indicator
  // so the user sees motion while npm install runs (typically 5–15s
  // on a warm cache, longer on cold). The indicator paints to a TTY
  // only — non-TTY callers (CI, pipes) see the static "Installing…"
  // line above and the result row below, no shimmer.
  const indicator = ctx.display.activityIndicator('resolving installation');
  let result;
  try {
    result = await executeInstall({
      targetVersion: status.latest,
      plan,
      updateStateDir: ctx.paths.root,
      onPhase: (phase) => indicator.resume(phase),
    });
  } finally {
    indicator.stop();
  }

  if (result.success) {
    if (result.scheduled) {
      ctx.display.write(
        `\n  ✓ Update prepared for v${status.latest}. ` +
        'Type /quit so Windows can replace the running package, then re-run `aiden`.\n',
      );
      return;
    }
    const v = result.installedVersion ?? status.latest;
    ctx.display.write(`\n  ✓ aiden-runtime v${v} installed.\n`);
    ctx.display.dim('Restart Aiden to apply: type /quit then re-run `aiden`.');
    await updateCacheFile(ctx.paths, (current) => clearUpdateFailure(current));
    return;
  }

  ctx.display.write(`\n  ✗ Update failed: ${result.error ?? 'no error message'}\n`);
  await updateCacheFile(ctx.paths, (current) =>
    applyUpdateFailure(current, status.latest!));
}

// ── v4.5 update system — skip + auto subcommands ───────────────────────────

async function runSkip(ctx: SlashCommandContext): Promise<void> {
  if (!ctx.paths) {
    ctx.display.warn('/update skip needs Aiden user-data paths — try in a real session.');
    return;
  }
  const version = ctx.args[1];
  if (!version || version.trim().length === 0) {
    ctx.display.printError(
      'Usage: /update skip <version>\n' +
      'Example: /update skip 4.5.1\n' +
      'Suppresses the boot prompt for that version + any older. Newer versions still prompt.',
    );
    return;
  }
  // Reject obviously-bad inputs early so users get a clear error.
  try { compareVersions(version, version); }
  catch {
    ctx.display.printError(`/update skip: "${version}" is not a recognised version (expected MAJOR.MINOR.PATCH).`);
    return;
  }
  try {
    await updateCacheFile(ctx.paths, (current) => applySkip(current, version));
    ctx.display.write(`Skipping ${version}. Boot prompt will resume when a newer version ships.\n`);
  } catch (e) {
    ctx.display.warn(`/update skip: failed to persist (${e instanceof Error ? e.message : String(e)}).`);
  }
}

async function runAuto(ctx: SlashCommandContext): Promise<void> {
  const sub = (ctx.args[1] ?? 'status').toLowerCase();
  if (sub === 'status') {
    const off = process.env.AIDEN_NO_UPDATE_CHECK === '1';
    ctx.display.write(`Update auto-check: ${off ? 'OFF' : 'ON'}   (source: ${off ? 'env' : 'default'})\n`);
    if (off) {
      ctx.display.dim('  unset AIDEN_NO_UPDATE_CHECK or run `/update auto on` to re-enable.');
    }
    return;
  }
  if (sub === 'on' || sub === 'off') {
    // The env var is the authoritative gate (matches existing Phase 20
    // contract). `/update auto on` clears it for the current process;
    // permanent off needs the user's shell to keep it set, since we
    // shouldn't quietly write env vars to user shells. Document this
    // clearly so users aren't confused.
    if (sub === 'on') {
      delete process.env.AIDEN_NO_UPDATE_CHECK;
      ctx.display.write('Update auto-check: ON for this session.\n');
      ctx.display.dim('  To persist: ensure AIDEN_NO_UPDATE_CHECK is unset in your shell init.');
    } else {
      process.env.AIDEN_NO_UPDATE_CHECK = '1';
      ctx.display.write('Update auto-check: OFF for this session.\n');
      ctx.display.dim('  To persist: set AIDEN_NO_UPDATE_CHECK=1 in your shell init.');
    }
    return;
  }
  ctx.display.printError('Usage: /update auto on|off|status');
}

async function runClearSkip(ctx: SlashCommandContext): Promise<void> {
  if (!ctx.paths) {
    ctx.display.warn('/update unskip needs Aiden user-data paths — try in a real session.');
    return;
  }
  try {
    await updateCacheFile(ctx.paths, (current) => clearSkip(current));
    ctx.display.write('Cleared skipped-version state. The boot prompt will re-fire next session.\n');
  } catch (e) {
    ctx.display.warn(`/update unskip: failed to persist (${e instanceof Error ? e.message : String(e)}).`);
  }
}

export const update: SlashCommand = {
  name: 'update',
  description: 'Check, install, or skip aiden-runtime updates.',
  category: 'system',
  icon: '⬆',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    // Display install method on `/update` default so users see how
    // their install will be updated before they trigger one.
    if (sub === 'install') {
      await runInstall(ctx);
      return;
    }
    if (sub === 'skip') {
      await runSkip(ctx);
      return;
    }
    if (sub === 'unskip') {
      await runClearSkip(ctx);
      return;
    }
    if (sub === 'auto') {
      await runAuto(ctx);
      return;
    }
    // Default ('' / 'check') → status probe.
    await printStatus(ctx);
    if (ctx.paths) {
      const method = detectInstallMethod();
      ctx.display.dim(`  install method: ${method.description}`);
    }
  },
};
