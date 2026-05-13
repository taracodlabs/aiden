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
 * /quit and re-launching aiden. Hermes consult was explicit:
 * "never claim the current process is upgraded after install."
 */

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { VERSION as INSTALLED_VERSION } from '../../../core/version';
import { checkForUpdate } from '../../../core/v4/update/checkUpdate';
import { executeInstall } from '../../../core/v4/update/executeInstall';

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
    `Installing aiden-runtime v${status.latest} (current: v${status.installed})…\n`,
  );
  const result = await executeInstall();

  if (result.success) {
    const v = result.installedVersion ?? status.latest;
    ctx.display.write(`\n  ✓ aiden-runtime v${v} installed.\n`);
    ctx.display.dim('Restart Aiden to apply: type /quit then re-run `aiden`.');
    return;
  }

  ctx.display.warn(result.error ?? 'Install failed (no error message).');
}

export const update: SlashCommand = {
  name: 'update',
  description: 'Check for / install the latest aiden-runtime. Use "install" subcommand to apply.',
  category: 'system',
  icon: '⬆',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (sub === 'install') {
      await runInstall(ctx);
    } else {
      await printStatus(ctx);
    }
  },
};
