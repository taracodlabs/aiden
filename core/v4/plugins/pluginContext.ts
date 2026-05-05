/**
 * core/v4/plugins/pluginContext.ts — Aiden v4.0.0 (Phase 17)
 *
 * Facade handed to a plugin's `register(ctx)` function. The plugin uses
 * it to contribute tools, lifecycle hooks, and (later) skills/providers
 * into the running agent.
 *
 * Hermes reference: hermes_cli/plugins.py::PluginContext (L233). Aiden's
 * version is leaner — fewer surfaces (no slash commands, no CLI commands,
 * no message injection) until those needs are concrete. Tool registration
 * is the load-bearing surface for Phase 17 Task 2 (CDP browser plugin).
 *
 * Tool registration goes through the existing `ToolRegistry`. The context
 * adds a thin permission-declaration check: a plugin that registers a tool
 * with `category: 'network'` but does not declare `network` in its
 * manifest's `permissions[]` is rejected at registration time. Catches
 * honest manifest mistakes; a malicious plugin can still bypass since
 * v4.0 has no OS sandbox (per audit).
 *
 * Status: PHASE 17 Task 1.
 */

import type { ToolHandler, ToolRegistry, ToolCategory } from '../toolRegistry';
import type {
  PluginManifest,
  PluginPermission,
  LifecycleHook,
} from './pluginManifest';

/**
 * Map a tool category to the permission(s) a plugin must declare to be
 * allowed to register a tool of that category. `read` and `execute` map
 * to coarse categories — they're informational for the install summary
 * but every plugin tool already needs at least one explicit permission.
 *
 * Centralised here so Task 4 can reuse the same map for runtime checks.
 */
export const CATEGORY_TO_PERMISSION: Record<ToolCategory, PluginPermission> = {
  read: 'filesystem',
  write: 'filesystem',
  execute: 'shell',
  network: 'network',
  browser: 'browser',
};

/**
 * Internal record kept by the manager for each plugin: which tools and
 * hooks the plugin successfully registered. Used by `/plugins info` and
 * for clean teardown on `/plugins remove`.
 */
export interface PluginContributions {
  tools: string[];
  hooks: LifecycleHook[];
}

export class PluginContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginContextError';
  }
}

/**
 * Per-plugin context. The plugin manager constructs one of these and
 * passes it to the plugin's exported `register(ctx)` function.
 */
export class PluginContext {
  readonly manifest: PluginManifest;
  private readonly toolRegistry: ToolRegistry;
  private readonly hookRegistry: Map<LifecycleHook, Array<() => void | Promise<void>>>;
  private readonly contributions: PluginContributions = { tools: [], hooks: [] };

  constructor(
    manifest: PluginManifest,
    toolRegistry: ToolRegistry,
    hookRegistry: Map<LifecycleHook, Array<() => void | Promise<void>>>,
  ) {
    this.manifest = manifest;
    this.toolRegistry = toolRegistry;
    this.hookRegistry = hookRegistry;
  }

  /** What this plugin has registered so far. Returned by reference; do not mutate. */
  getContributions(): Readonly<PluginContributions> {
    return this.contributions;
  }

  /**
   * Register a tool. The handler must already conform to the v4 ToolHandler
   * shape — plugins import the same types as built-in tool wrappers.
   *
   * Validation:
   * - the tool name must appear in `manifest.tools` (declared-equals-actual)
   * - the tool's category must map to a permission declared in
   *   `manifest.permissions` (advisory)
   *
   * Throws PluginContextError on either failure. The loader catches and
   * surfaces the error via `LoadedPlugin.error`.
   */
  registerTool(handler: ToolHandler): void {
    const name = handler.schema.name;

    if (!this.manifest.tools.includes(name)) {
      throw new PluginContextError(
        `plugin "${this.manifest.name}" tried to register tool "${name}" not declared in manifest.tools`,
      );
    }

    const requiredPerm = CATEGORY_TO_PERMISSION[handler.category];
    if (requiredPerm && !this.manifest.permissions.includes(requiredPerm)) {
      throw new PluginContextError(
        `plugin "${this.manifest.name}" tried to register tool "${name}" (category=${handler.category}) ` +
          `but did not declare permission "${requiredPerm}" in manifest.permissions`,
      );
    }

    this.toolRegistry.register(handler);
    this.contributions.tools.push(name);
  }

  /**
   * Register a lifecycle hook callback. v4.0 hooks: onLoad, onActivate,
   * onTeardown. The plugin manager invokes them at the appropriate
   * point with all callbacks wrapped in try/catch (Hermes pattern).
   *
   * `onLoad` fires synchronously inside `register()`. Plugins typically
   * use `onActivate` for setup that may fail (e.g. spawn subprocesses)
   * and `onTeardown` for cleanup on shutdown or `/plugins remove`.
   */
  registerHook(name: LifecycleHook, fn: () => void | Promise<void>): void {
    if (!this.hookRegistry.has(name)) {
      this.hookRegistry.set(name, []);
    }
    this.hookRegistry.get(name)!.push(fn);
    if (!this.contributions.hooks.includes(name)) {
      this.contributions.hooks.push(name);
    }
  }
}
