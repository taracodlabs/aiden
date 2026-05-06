/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
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
import type {
  OAuthProvider,
  OAuthProviderRegistry,
} from '../auth/providerAuth';
import {
  runCopyPasteFlow,
  runDeviceCodeFlow,
  refreshTokens,
  generatePkce,
} from '../auth/oauthFlow';

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
 * Permission state passed to PluginContext to drive tool-execute
 * wrapping. Mirrors `PermissionState` in pluginPermissions.ts but kept
 * as a string union here so this module does not import the permissions
 * helper (avoids a circular concern; the loader threads the value in).
 */
export type ContextPermissionState = 'granted' | 'pending-grant';

/**
 * Phase 18: helpers exposed to plugin code via `ctx.auth`. Plugins must NOT
 * reach into `core/v4/auth/*` directly — the package layout differs between
 * dev (TS source) and runtime (compiled `dist/`), and a future v4.x might
 * sandbox plugins to a different module graph entirely.
 *
 * Tests can substitute mocked helpers via the PluginContext constructor's
 * `authHelpersOverride`.
 */
export interface PluginAuthHelpers {
  runCopyPasteFlow: typeof runCopyPasteFlow;
  runDeviceCodeFlow: typeof runDeviceCodeFlow;
  refreshTokens: typeof refreshTokens;
  generatePkce: typeof generatePkce;
}

const DEFAULT_AUTH_HELPERS: PluginAuthHelpers = {
  runCopyPasteFlow,
  runDeviceCodeFlow,
  refreshTokens,
  generatePkce,
};

/**
 * Per-plugin context. The plugin manager constructs one of these and
 * passes it to the plugin's exported `register(ctx)` function.
 */
export class PluginContext {
  readonly manifest: PluginManifest;
  /** Phase 18: HTTP + PKCE primitives plugins use to implement OAuth flows. */
  readonly auth: PluginAuthHelpers;
  private readonly toolRegistry: ToolRegistry;
  private readonly hookRegistry: Map<LifecycleHook, Array<() => void | Promise<void>>>;
  private readonly contributions: PluginContributions = { tools: [], hooks: [] };
  private readonly permissionState: ContextPermissionState;
  private readonly oauthRegistry?: OAuthProviderRegistry;
  private readonly registeredOAuthProviderIds: string[] = [];

  constructor(
    manifest: PluginManifest,
    toolRegistry: ToolRegistry,
    hookRegistry: Map<LifecycleHook, Array<() => void | Promise<void>>>,
    permissionState: ContextPermissionState = 'granted',
    oauthRegistry?: OAuthProviderRegistry,
    authHelpersOverride?: PluginAuthHelpers,
  ) {
    this.manifest = manifest;
    this.toolRegistry = toolRegistry;
    this.hookRegistry = hookRegistry;
    this.permissionState = permissionState;
    this.oauthRegistry = oauthRegistry;
    this.auth = authHelpersOverride ?? DEFAULT_AUTH_HELPERS;
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

    if (this.permissionState === 'pending-grant') {
      // Wrap execute so the LLM sees the tool but cannot use it. The
      // refusal points at the exact slash command the user must run —
      // honest, actionable. Underlying handler.execute is never called.
      const refusalMessage =
        `permissions not granted for plugin "${this.manifest.name}". ` +
        `Run: /plugins grant ${this.manifest.name}`;
      const wrapped: ToolHandler = {
        ...handler,
        async execute() {
          return { error: refusalMessage };
        },
      };
      this.toolRegistry.register(wrapped);
    } else {
      this.toolRegistry.register(handler);
    }
    this.contributions.tools.push(name);
  }

  /**
   * Phase 18: register an OAuth provider (Claude Pro, ChatGPT Plus, ...).
   *
   * Validation:
   * - manifest must declare the `auth-providers` permission
   * - the runtime must have wired an OAuthProviderRegistry through to this
   *   plugin context (otherwise the plugin loaded too early in boot — bug
   *   on the runtime side, not the plugin's, but we still throw so it's
   *   visible)
   *
   * The provider is added to the registry; tokens are NOT issued here —
   * the user runs `/auth login <provider>` (Task 5) or the setup wizard
   * (Task 4) to actually authorise.
   */
  registerOAuthProvider(provider: OAuthProvider): void {
    if (!this.manifest.permissions.includes('auth-providers')) {
      throw new PluginContextError(
        `plugin "${this.manifest.name}" tried to register OAuth provider ` +
          `"${provider.id}" but did not declare permission "auth-providers" ` +
          `in manifest.permissions`,
      );
    }
    if (!this.oauthRegistry) {
      throw new PluginContextError(
        `plugin "${this.manifest.name}" tried to register OAuth provider ` +
          `"${provider.id}" but the runtime has no OAuthProviderRegistry wired in`,
      );
    }
    this.oauthRegistry.register(provider);
    this.registeredOAuthProviderIds.push(provider.id);
  }

  /** Read-only list of OAuth provider ids this context registered. Used by /plugins info. */
  getRegisteredOAuthProviderIds(): readonly string[] {
    return this.registeredOAuthProviderIds;
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
