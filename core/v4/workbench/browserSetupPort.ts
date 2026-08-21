/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { PluginLoader } from '../plugins/pluginLoader';
import { saveGrantedPermissions } from '../plugins/pluginPermissions';
import type { WorkbenchBrowserSetupPort } from './bridgeServer';

const BROWSER_PLUGIN = 'aiden-plugin-cdp-browser';

export function createWorkbenchBrowserSetupPort(loader: PluginLoader): WorkbenchBrowserSetupPort {
  const snapshot = async () => {
    const plugin = loader.getRegistry().get(BROWSER_PLUGIN);
    if (!plugin) {
      return { ready: false, detail: 'Browser runtime plugin is unavailable.', grantRequired: false, permissions: [] };
    }
    const ready = plugin.status === 'loaded';
    return {
      ready,
      detail: ready
        ? 'Browser runtime and owned-session tools are available.'
        : plugin.status === 'pending-grant' || plugin.status === 'suspended'
          ? 'Browser access requires permission.'
          : plugin.error ?? 'Browser runtime is unavailable.',
      grantRequired: plugin.status === 'pending-grant' || plugin.status === 'suspended',
      permissions: [...plugin.manifest.permissions],
    };
  };
  return {
    snapshot,
    async grant(input) {
      if (!input.confirmed) throw new Error('Browser permission grant was not confirmed');
      const plugin = loader.getRegistry().get(BROWSER_PLUGIN);
      if (!plugin?.manifest.path) throw new Error('Browser runtime plugin is unavailable');
      await saveGrantedPermissions(plugin.manifest.path, plugin.manifest.permissions);
      await loader.teardown();
      await loader.discoverAndLoad();
      await loader.fireHook('onActivate');
      return snapshot();
    },
  };
}

