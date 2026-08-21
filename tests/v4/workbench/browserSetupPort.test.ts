import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../core/v4/plugins/pluginPermissions', () => ({
  saveGrantedPermissions: vi.fn(async () => undefined),
}));

import { saveGrantedPermissions } from '../../../core/v4/plugins/pluginPermissions';
import { createWorkbenchBrowserSetupPort } from '../../../core/v4/workbench/browserSetupPort';

describe('Workbench browser setup port', () => {
  it('routes a confirmed grant through the existing plugin permission authority and reloads once', async () => {
    const entry = {
      status: 'pending-grant', error: null,
      manifest: { name: 'aiden-plugin-cdp-browser', path: 'C:/plugins/browser', permissions: ['browser', 'subprocess', 'network'] },
    };
    const loader = {
      getRegistry: () => ({ get: () => entry }),
      teardown: vi.fn(async () => undefined),
      discoverAndLoad: vi.fn(async () => { entry.status = 'loaded'; }),
      fireHook: vi.fn(async () => undefined),
    };
    const port = createWorkbenchBrowserSetupPort(loader as any);
    expect(await port.snapshot()).toMatchObject({ ready: false, grantRequired: true });
    expect(await port.grant({ confirmed: true })).toMatchObject({ ready: true, grantRequired: false });
    expect(saveGrantedPermissions).toHaveBeenCalledWith('C:/plugins/browser', ['browser', 'subprocess', 'network']);
    expect(loader.teardown).toHaveBeenCalledOnce();
    expect(loader.discoverAndLoad).toHaveBeenCalledOnce();
    expect(loader.fireHook).toHaveBeenCalledWith('onActivate');
  });
});
