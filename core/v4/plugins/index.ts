/**
 * core/v4/plugins/index.ts — Aiden v4.0.0 (Phase 17)
 *
 * Public re-exports for the plugin module set. Callers import from this
 * file rather than reaching into individual submodules.
 */

export {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  PERMISSION_TYPES,
  PLUGIN_KINDS,
  LIFECYCLE_HOOKS,
  readManifest,
  validateManifest,
} from './pluginManifest';
export type {
  PluginManifest,
  PluginPermission,
  PluginKind,
  LifecycleHook,
  ManifestValidationResult,
} from './pluginManifest';

export { PluginContext, PluginContextError, CATEGORY_TO_PERMISSION } from './pluginContext';
export type { PluginContributions } from './pluginContext';

export { PluginRegistry } from './pluginRegistry';
export type { LoadedPlugin, PluginStatus } from './pluginRegistry';

export { PluginLoader } from './pluginLoader';
export type { PluginLoaderOptions } from './pluginLoader';

export {
  GRANTED_FILE,
  GRANTED_VERSION,
  loadGrantedPermissions,
  saveGrantedPermissions,
  buildPermissionChecker,
  evaluatePermissionState,
  formatInstallSummary,
} from './pluginPermissions';
export type {
  PermissionState,
  PermissionEvaluation,
} from './pluginPermissions';
