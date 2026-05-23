/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/plugins.ts — Aiden v4.0.0 (Phase 17 Task 3)
 *
 * `/plugins [list|info <name>|install <path>|remove <name>|reload]`
 *
 * Subcommands:
 *   list                — table of installed plugins (default if no sub).
 *   info <name>         — manifest + status + contributions for one plugin.
 *   install <local-path>— copy a plugin dir into paths.pluginsDir, show
 *                         permission summary, prompt y/N, on Allow write
 *                         .granted-permissions.json + reload.
 *                         URLs / package specs are rejected with an
 *                         honest "coming in v4.1" error per Phase 17 scope.
 *   remove <name>       — call loader teardown for the plugin, delete
 *                         its directory (incl. granted-permissions file).
 *   reload              — re-discoverAndLoad the loader; granted
 *                         permissions persist (file lives in plugin dir).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';
import {
  readManifest,
  formatInstallSummary,
  saveGrantedPermissions,
  loadGrantedPermissions,
  GRANTED_FILE,
  type PluginManifest,
} from '../../../core/v4/plugins';

/** Spot a URL-shaped install identifier (http(s) or git@). */
function looksLikeRemote(spec: string): boolean {
  return (
    /^https?:\/\//i.test(spec) ||
    /^git@/i.test(spec) ||
    /^[\w.-]+\/[\w.-]+$/.test(spec) // owner/repo shorthand
  );
}

/** Recursive directory copy. fs.cp is in node 16.7+ but missing some types. */
async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function rmDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Render the table of plugins to ctx.display. */
function renderList(
  ctx: import('../commandRegistry').SlashCommandContext,
  list: ReadonlyArray<{
    manifest: PluginManifest;
    status: string;
    contributions: { tools: string[]; hooks: string[] };
    error?: string;
  }>,
): void {
  if (list.length === 0) {
    ctx.display.dim('(no plugins installed)');
    return;
  }
  ctx.display.info(`Installed plugins (${list.length}):`);
  for (const p of list) {
    const status = p.status === 'error' ? `error: ${p.error ?? '?'}` : p.status;
    const tools =
      p.contributions.tools.length > 0
        ? ` [${p.contributions.tools.length} tool(s)]`
        : '';
    ctx.display.write(
      `  • ${p.manifest.name.padEnd(30)} v${(p.manifest.version || '?').padEnd(10)} ${status}${tools}\n`,
    );
  }
}

export const plugins: SlashCommand = {
  name: 'plugins',
  description: 'List, install, remove, or reload Aiden plugins.',
  category: 'system',
  icon: '🔌',
  handler: async (ctx) => {
    if (!ctx.pluginLoader) {
      ctx.display.warn('Plugin loader not wired (boot may still be in progress).');
      return {};
    }
    const sub = (ctx.args[0] ?? 'list').toLowerCase();

    // ── list ──────────────────────────────────────────────────────
    if (sub === 'list') {
      renderList(ctx, ctx.pluginLoader.getRegistry().list());
      return {};
    }

    // ── info ──────────────────────────────────────────────────────
    if (sub === 'info') {
      const name = ctx.args[1];
      if (!name) {
        ctx.display.printError('Usage: /plugins info <name>');
        return {};
      }
      const entry = ctx.pluginLoader.getRegistry().get(name);
      if (!entry) {
        ctx.display.printError(`Plugin '${name}' is not installed.`);
        return {};
      }
      ctx.display.info(`${entry.manifest.name} v${entry.manifest.version}`);
      if (entry.manifest.author) ctx.display.dim(`by ${entry.manifest.author}`);
      if (entry.manifest.description)
        ctx.display.write(entry.manifest.description + '\n');
      ctx.display.write('\n');
      ctx.display.write(`Source     : ${entry.manifest.source ?? '?'}\n`);
      ctx.display.write(`Status     : ${entry.status}${entry.error ? ' — ' + entry.error : ''}\n`);
      ctx.display.write(`Tools      : ${entry.contributions.tools.join(', ') || '(none)'}\n`);
      ctx.display.write(`Hooks      : ${entry.contributions.hooks.join(', ') || '(none)'}\n`);
      ctx.display.write(
        `Permissions: ${entry.manifest.permissions.join(', ') || '(none)'}\n`,
      );
      if (entry.manifest.path) ctx.display.dim(entry.manifest.path);
      return {};
    }

    // ── install ───────────────────────────────────────────────────
    if (sub === 'install') {
      const spec = ctx.args.slice(1).join(' ').trim();
      if (!spec) {
        ctx.display.printError('Usage: /plugins install <local-path>');
        return {};
      }
      if (looksLikeRemote(spec)) {
        ctx.display.printError(
          'URL install coming in v4.1. For now, git clone the plugin and pass the local path.',
        );
        return {};
      }
      if (!ctx.paths) {
        ctx.display.warn('Plugin install needs paths context (boot may still be in progress).');
        return {};
      }
      const sourcePath = path.resolve(spec);
      try {
        const stat = await fs.stat(sourcePath);
        if (!stat.isDirectory()) {
          ctx.display.printError(`Not a directory: ${sourcePath}`);
          return {};
        }
      } catch {
        ctx.display.printError(`Path does not exist: ${sourcePath}`);
        return {};
      }
      const result = await readManifest(sourcePath);
      if (result.ok === false) {
        const errors: string[] = result.errors;
        ctx.display.printError(`Manifest invalid: ${errors.join('; ')}`);
        return {};
      }
      const manifest = result.manifest;

      // Refuse re-install of an existing plugin name; user must /plugins remove first.
      const existing = ctx.pluginLoader.getRegistry().get(manifest.name);
      if (existing) {
        ctx.display.printError(
          `Plugin '${manifest.name}' is already installed. Run /plugins remove ${manifest.name} first.`,
        );
        return {};
      }

      // Permission summary + confirm.
      ctx.display.info('--- Permission summary ---');
      ctx.display.write(formatInstallSummary(manifest) + '\n');
      ctx.display.write('\n');

      const confirmFn = ctx.confirm ?? (async () => false);
      const allow = await confirmFn(
        `Install ${manifest.name} with the listed permissions? [y/N] `,
      );
      // v4.9.2 Slice 3 — confirm() now owns the rejection message.
      if (!allow) return {};

      // Copy into the user plugins dir.
      const dst = path.join(ctx.paths.pluginsDir, manifest.name);
      try {
        await fs.access(dst);
        ctx.display.printError(
          `Target path already exists: ${dst} (run /plugins remove ${manifest.name} first)`,
        );
        return {};
      } catch {
        // ok, dst doesn't exist
      }
      await copyDir(sourcePath, dst);
      // Write granted file BEFORE reload so the loader's permission
      // checker reads through.
      await saveGrantedPermissions(dst, manifest.permissions);
      // Reload — discoverAndLoad is idempotent for existing entries
      // because we just blew away the cache via teardown.
      await ctx.pluginLoader.teardown();
      await ctx.pluginLoader.discoverAndLoad();
      const after = ctx.pluginLoader.getRegistry().get(manifest.name);
      if (after?.status === 'loaded') {
        ctx.display.success(
          `Installed ${manifest.name} v${manifest.version} (${after.contributions.tools.length} tool(s)).`,
        );
      } else {
        ctx.display.warn(
          `Installed but not loaded: ${after?.error ?? 'unknown error'}`,
        );
      }
      return {};
    }

    // ── remove ────────────────────────────────────────────────────
    if (sub === 'remove') {
      const name = ctx.args[1];
      if (!name) {
        ctx.display.printError('Usage: /plugins remove <name>');
        return {};
      }
      const entry = ctx.pluginLoader.getRegistry().get(name);
      if (!entry) {
        ctx.display.printError(`Plugin '${name}' is not installed.`);
        return {};
      }
      // Block removal of bundled plugins — they ship with the package.
      if (entry.manifest.source === 'bundled') {
        ctx.display.printError(
          `'${name}' is bundled and cannot be removed. Disable via config instead.`,
        );
        return {};
      }
      const dir = entry.manifest.path;
      if (!dir) {
        ctx.display.printError(`Cannot resolve plugin directory for ${name}.`);
        return {};
      }
      await ctx.pluginLoader.teardown();
      await rmDir(dir);
      await ctx.pluginLoader.discoverAndLoad();
      ctx.display.success(`Removed ${name}.`);
      return {};
    }

    // ── grant ─────────────────────────────────────────────────────
    if (sub === 'grant') {
      const name = ctx.args[1];
      if (!name) {
        ctx.display.printError('Usage: /plugins grant <name>');
        return {};
      }
      const entry = ctx.pluginLoader.getRegistry().get(name);
      if (!entry) {
        ctx.display.printError(`Plugin '${name}' is not installed.`);
        return {};
      }
      const dir = entry.manifest.path;
      if (!dir) {
        ctx.display.printError(`Cannot resolve plugin directory for ${name}.`);
        return {};
      }
      const previous = await loadGrantedPermissions(dir);
      const newPerms = entry.manifest.permissions.filter(
        (p) => !previous.includes(p),
      );
      // Phase 17.1: "NEW" framing belongs to the upgrade case only — when a
      // granted file already exists AND the manifest declares perms that
      // weren't covered before. On first install (no granted file),
      // `previous` is [] and every declared perm looks "new" — show plain
      // "Permissions requested: ..." instead.
      const isUpgrade = previous.length > 0 && newPerms.length > 0;

      ctx.display.info(`--- Permission summary for ${name} ---`);
      ctx.display.write(formatInstallSummary(entry.manifest) + '\n');
      if (previous.length > 0) {
        ctx.display.dim(
          `Previously granted: ${previous.join(', ') || '(none)'}`,
        );
      }
      if (isUpgrade) {
        ctx.display.warn(`NEW permissions requested: ${newPerms.join(', ')}`);
      }
      ctx.display.write('\n');

      const confirmFn = ctx.confirm ?? (async () => false);
      const allow = await confirmFn(
        isUpgrade
          ? `Grant the listed permissions (including ${newPerms.length} new)? [y/N] `
          : `Grant the listed permissions? [y/N] `,
      );
      // v4.9.2 Slice 3 — confirm() now owns the rejection message.
      if (!allow) return {};
      await saveGrantedPermissions(dir, entry.manifest.permissions);
      // Reload so the new state takes effect.
      await ctx.pluginLoader.teardown();
      await ctx.pluginLoader.discoverAndLoad();
      const after = ctx.pluginLoader.getRegistry().get(name);
      if (after?.status === 'loaded') {
        ctx.display.success(
          `Granted. ${name} now loaded with ${after.contributions.tools.length} tool(s).`,
        );
      } else {
        ctx.display.warn(
          `Granted but plugin not in 'loaded' status: ${after?.status ?? 'gone'}` +
            (after?.error ? ' — ' + after.error : ''),
        );
      }
      return {};
    }

    // ── reload ────────────────────────────────────────────────────
    if (sub === 'reload') {
      // teardown + re-discover. Granted permissions stay because the
      // .granted-permissions.json file lives inside the plugin dir
      // and is untouched by reload — per Phase 17 spec note 3.
      await ctx.pluginLoader.teardown();
      await ctx.pluginLoader.discoverAndLoad();
      const counts = ctx.pluginLoader.getRegistry().countByStatus();
      ctx.display.success(
        `Reloaded: ${counts.loaded} loaded, ${counts.error} errored.`,
      );
      return {};
    }

    ctx.display.printError(
      `Unknown subcommand: ${sub}`,
      'Try: /plugins list | info <name> | install <path> | grant <name> | remove <name> | reload',
    );
    return {};
  },
};

// Re-export the granted file constant in case other tooling needs it.
export { GRANTED_FILE };
