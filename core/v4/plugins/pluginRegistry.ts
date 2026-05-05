/**
 * core/v4/plugins/pluginRegistry.ts — Aiden v4.0.0 (Phase 17)
 *
 * Tracks the set of discovered + loaded plugins, their lifecycle state,
 * and any registration errors. Read by `/plugins list` and `/plugins info`,
 * mutated only by `PluginLoader`.
 *
 * Hermes reference: hermes_cli/plugins.py::PluginManager._plugins (L601).
 *
 * Status: PHASE 17 Task 1.
 */

import type { PluginManifest } from './pluginManifest';
import type { PluginContributions } from './pluginContext';

/** Lifecycle state of one plugin. */
export type PluginStatus =
  | 'discovered'      // manifest parsed, not yet loaded
  | 'loaded'          // module imported + register() ran successfully
  | 'activated'       // onActivate fired without error
  | 'disabled'        // user opt-out via config
  | 'pending-grant'   // Phase 17 Task 4: no granted-permissions file yet
                      //  → tools registered but execute returns refusal
  | 'suspended'       // Phase 17 Task 4: manifest declares permissions
                      //  the granted file does not cover (upgrade case)
                      //  → tools NOT registered; user must /plugins grant
  | 'error';          // any failure during discover/load/activate

export interface LoadedPlugin {
  manifest: PluginManifest;
  status: PluginStatus;
  contributions: PluginContributions;
  /** First error message captured during this plugin's lifecycle, if any. */
  error?: string;
  /**
   * Permissions declared by the manifest that the persisted granted file
   * does not cover. Populated for `pending-grant` and `suspended`
   * statuses; empty otherwise. /plugins commands and the boot card
   * surface render this directly.
   */
  missingPermissions?: string[];
}

export class PluginRegistry {
  private readonly plugins = new Map<string, LoadedPlugin>();

  /** Add a freshly discovered plugin. Replaces any prior entry with the same name. */
  upsert(entry: LoadedPlugin): void {
    this.plugins.set(entry.manifest.name, entry);
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  remove(name: string): boolean {
    return this.plugins.delete(name);
  }

  /** All plugins, sorted by name for stable list rendering. */
  list(): LoadedPlugin[] {
    return [...this.plugins.values()].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    );
  }

  /** Count by status. Useful for the boot card surface. */
  countByStatus(): Record<PluginStatus, number> {
    const counts: Record<PluginStatus, number> = {
      discovered: 0,
      loaded: 0,
      activated: 0,
      disabled: 0,
      'pending-grant': 0,
      suspended: 0,
      error: 0,
    };
    for (const p of this.plugins.values()) counts[p.status]++;
    return counts;
  }

  /** Reset the registry. Tests use this between cases. */
  clear(): void {
    this.plugins.clear();
  }
}
