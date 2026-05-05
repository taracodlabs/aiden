/**
 * core/v4/plugins/pluginLoader.ts — Aiden v4.0.0 (Phase 17)
 *
 * Discovers, loads, and lifecycle-manages plugins. Two sources:
 *
 *   1. Bundled — `<runtime>/plugins/<name>/` (ships in npm package).
 *      Auto-loads, no opt-in required.
 *   2. User    — `<paths.pluginsDir>/<name>/` (% LOCALAPPDATA %\aiden\plugins\
 *      on Windows, ~/.aiden/plugins/ elsewhere). Loaded by default; users
 *      can disable individual plugins via Task 3's `/plugins` command.
 *
 * On collision (same `manifest.name`), user plugins win — matches Hermes
 * "later wins" rule (plugins.py:680). Per-plugin try/catch isolates
 * failures: one broken plugin sets its own LoadedPlugin.error and the
 * others keep loading. Same isolation pattern Hermes uses (plugins.py:947).
 *
 * Project-local plugins (`./.aiden/plugins/`) are deliberately omitted
 * vs. Hermes — opens an injection vector when running Aiden in a cloned
 * repo, low value for v4.0.
 *
 * Status: PHASE 17 Task 1.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AidenPaths } from '../paths';
import type { ToolRegistry } from '../toolRegistry';
import {
  PluginContext,
  type PluginContributions,
} from './pluginContext';
import {
  MANIFEST_FILENAME,
  readManifest,
  type LifecycleHook,
  type PluginManifest,
} from './pluginManifest';
import {
  PluginRegistry,
  type LoadedPlugin,
} from './pluginRegistry';

export interface PluginLoaderOptions {
  paths: AidenPaths;
  toolRegistry: ToolRegistry;
  /**
   * Filesystem path to the bundled plugins directory shipped with the
   * npm package. Resolved by the caller because we don't want this
   * module guessing about install layout.
   */
  bundledDir?: string;
  /**
   * Optional log sink. Same shape AidenLogger uses. The loader emits
   * one line per discovered plugin and one per error.
   */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Permission check hook. Phase 17 Task 4 wires the granted-permission
   * file into here; until then this is undefined and all permissions
   * pass. Returning false aborts `register()` for that plugin and
   * surfaces a "permission not granted" error.
   */
  isPermissionGranted?: (
    manifest: PluginManifest,
    permission: string,
  ) => boolean;
}

/** Plugin module shape we expect on dynamic import. */
interface PluginModule {
  register?: (ctx: PluginContext) => void | Promise<void>;
}

export class PluginLoader {
  private readonly opts: PluginLoaderOptions;
  private readonly registry = new PluginRegistry();
  private readonly hooks = new Map<
    LifecycleHook,
    Array<() => void | Promise<void>>
  >();

  constructor(opts: PluginLoaderOptions) {
    this.opts = opts;
  }

  getRegistry(): PluginRegistry {
    return this.registry;
  }

  /**
   * Walk both plugin source directories, parse manifests, dynamically
   * import each plugin module, and call its `register(ctx)`. Idempotent:
   * calling twice without `clear()` will skip already-loaded plugins.
   */
  async discoverAndLoad(): Promise<void> {
    const log = this.opts.log ?? (() => {});
    const sources: Array<{ dir: string; source: 'bundled' | 'user' }> = [];

    if (this.opts.bundledDir) {
      sources.push({ dir: this.opts.bundledDir, source: 'bundled' });
    }
    sources.push({ dir: this.opts.paths.pluginsDir, source: 'user' });

    // Walk in order so user plugins overwrite bundled on name collision —
    // matches Hermes "later wins" semantics.
    for (const { dir, source } of sources) {
      const manifests = await this.scanDirectory(dir, source);
      for (const m of manifests) {
        await this.loadOne(m);
      }
    }

    const counts = this.registry.countByStatus();
    log(
      'info',
      `[plugins] discover complete: ${counts.loaded} loaded, ${counts.error} errored, ${counts.disabled} disabled`,
    );
  }

  /**
   * Tear down every loaded plugin: fire onTeardown, drop tool registrations,
   * clear the registry. Best-effort — teardown errors are logged, never thrown.
   */
  async teardown(): Promise<void> {
    await this.fireHook('onTeardown');
    for (const p of this.registry.list()) {
      for (const t of p.contributions.tools) {
        this.opts.toolRegistry.unregister(t);
      }
    }
    this.registry.clear();
    this.hooks.clear();
  }

  /**
   * Fire a lifecycle hook. Each callback is wrapped in its own try/catch
   * so a misbehaving plugin can't take the agent down. Mirrors Hermes
   * `invoke_hook` (plugins.py:1055).
   */
  async fireHook(name: LifecycleHook): Promise<void> {
    const callbacks = this.hooks.get(name) ?? [];
    const log = this.opts.log ?? (() => {});
    for (const cb of callbacks) {
      try {
        await cb();
      } catch (err) {
        log('warn', `[plugins] hook ${name} threw: ${(err as Error).message}`);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  /** Read every plugin manifest under `root`. Missing dir is fine — returns []. */
  private async scanDirectory(
    root: string,
    source: 'bundled' | 'user',
  ): Promise<PluginManifest[]> {
    const out: PluginManifest[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return out; // empty plugins dir is normal
      this.opts.log?.(
        'warn',
        `[plugins] could not scan ${root}: ${e.message}`,
      );
      return out;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(root, entry.name);
      const manifestFile = path.join(pluginDir, MANIFEST_FILENAME);
      try {
        await fs.access(manifestFile);
      } catch {
        continue; // not a plugin dir; skip silently
      }
      const result = await readManifest(pluginDir);
      if (result.ok === false) {
        const errors: string[] = result.errors;
        // Record a discovered-but-broken entry so /plugins list shows it.
        const fallback: PluginManifest = {
          manifestVersion: 0,
          name: entry.name,
          version: '',
          author: '',
          description: '',
          kind: 'standalone',
          tools: [],
          skills: [],
          providers: [],
          permissions: [],
          requiresEnv: [],
          source,
          path: pluginDir,
        };
        this.registry.upsert({
          manifest: fallback,
          status: 'error',
          contributions: { tools: [], hooks: [] },
          error: `manifest invalid: ${errors.join('; ')}`,
        });
        this.opts.log?.(
          'warn',
          `[plugins] ${entry.name}: manifest invalid: ${errors.join('; ')}`,
        );
        continue;
      }
      result.manifest.source = source;
      out.push(result.manifest);
    }
    return out;
  }

  /** Import the plugin module and call its `register(ctx)`. Errors are captured. */
  private async loadOne(manifest: PluginManifest): Promise<void> {
    const log = this.opts.log ?? (() => {});

    // Permission gate — Task 4 wires this. With no hook, every declared
    // permission is implicitly granted (matches "loaded by default" UX).
    if (this.opts.isPermissionGranted) {
      const missing = manifest.permissions.filter(
        (p) => !this.opts.isPermissionGranted!(manifest, p),
      );
      if (missing.length > 0) {
        this.registry.upsert({
          manifest,
          status: 'error',
          contributions: { tools: [], hooks: [] },
          error: `permissions not granted: ${missing.join(', ')}`,
        });
        log(
          'warn',
          `[plugins] ${manifest.name}: permissions not granted: ${missing.join(', ')}`,
        );
        return;
      }
    }

    const ctx = new PluginContext(manifest, this.opts.toolRegistry, this.hooks);
    const contributions: PluginContributions = ctx.getContributions() as PluginContributions;

    let mod: PluginModule;
    try {
      mod = await this.importPluginModule(manifest);
    } catch (err) {
      this.registry.upsert({
        manifest,
        status: 'error',
        contributions,
        error: `import failed: ${(err as Error).message}`,
      });
      log('warn', `[plugins] ${manifest.name}: import failed: ${(err as Error).message}`);
      return;
    }

    if (typeof mod.register !== 'function') {
      this.registry.upsert({
        manifest,
        status: 'error',
        contributions,
        error: 'no register() export',
      });
      log('warn', `[plugins] ${manifest.name}: no register() export`);
      return;
    }

    try {
      await mod.register(ctx);
    } catch (err) {
      // Tools registered before the throw stay registered — clean them up
      // so the registry is consistent with what survived.
      for (const t of contributions.tools) {
        this.opts.toolRegistry.unregister(t);
      }
      this.registry.upsert({
        manifest,
        status: 'error',
        contributions: { tools: [], hooks: [] },
        error: `register() threw: ${(err as Error).message}`,
      });
      log(
        'warn',
        `[plugins] ${manifest.name}: register() threw: ${(err as Error).message}`,
      );
      return;
    }

    this.registry.upsert({
      manifest,
      status: 'loaded',
      contributions: { tools: [...contributions.tools], hooks: [...contributions.hooks] },
    });
    log(
      'info',
      `[plugins] loaded ${manifest.name} v${manifest.version} (${contributions.tools.length} tool(s))`,
    );
  }

  /**
   * Resolve and import a plugin's entry module. We accept either a
   * compiled JS entrypoint declared by the plugin's package.json `main`,
   * or a default `index.js` / `index.cjs` next to plugin.json.
   */
  private async importPluginModule(manifest: PluginManifest): Promise<PluginModule> {
    if (!manifest.path) throw new Error('manifest.path missing (loader bug)');

    let entry: string | undefined;
    try {
      const pkgFile = path.join(manifest.path, 'package.json');
      const pkgText = await fs.readFile(pkgFile, 'utf8');
      const pkg = JSON.parse(pkgText) as { main?: string };
      if (pkg.main && typeof pkg.main === 'string') {
        entry = path.resolve(manifest.path, pkg.main);
      }
    } catch {
      // No package.json — fall through to default index.js
    }

    if (!entry) {
      for (const candidate of ['index.js', 'index.cjs', 'index.mjs']) {
        const p = path.join(manifest.path, candidate);
        try {
          await fs.access(p);
          entry = p;
          break;
        } catch {
          // try next
        }
      }
    }

    if (!entry) {
      throw new Error(
        `no entry point — expected package.json#main or index.{js,cjs,mjs}`,
      );
    }

    // Use file:// URL so node treats this as a path (works for CJS and ESM).
    const url = pathToFileURL(entry).href;
    const imported = (await import(url)) as PluginModule & { default?: PluginModule };
    // Some plugins export `register` as default; accept either shape.
    if (typeof imported.register === 'function') return imported;
    if (imported.default && typeof imported.default.register === 'function') {
      return imported.default;
    }
    return imported;
  }
}
