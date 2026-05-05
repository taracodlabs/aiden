import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { PluginContext } from '../../../core/v4/plugins/pluginContext';

// The plugin entry is JS — vitest can require() it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pluginEntry = require('../../../plugins/aiden-plugin-cdp-browser/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CdpClient } = require('../../../plugins/aiden-plugin-cdp-browser/lib/cdpClient.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const launcher = require('../../../plugins/aiden-plugin-cdp-browser/lib/chromeLauncher.js');

/**
 * Build a minimal fake chrome-remote-interface client. Captures the calls
 * each tool makes so assertions can verify the wire interaction without
 * touching a real browser.
 */
function buildFakeCriFactory(overrides: Record<string, any> = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  const record = (method: string) => async (args: any) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](args);
    return {};
  };
  const factory: any = vi.fn(async () => ({
    Page: { enable: record('Page.enable'), navigate: record('Page.navigate'), loadEventFired: record('Page.loadEventFired') },
    Runtime: {
      enable: record('Runtime.enable'),
      evaluate: overrides['Runtime.evaluate']
        ? record('Runtime.evaluate')
        : async (args: any) => {
            calls.push({ method: 'Runtime.evaluate', args });
            return { result: { value: 'ok', type: 'string' } };
          },
      callFunctionOn: record('Runtime.callFunctionOn'),
    },
    DOM: {
      enable: record('DOM.enable'),
      getDocument: async () => ({ root: { nodeId: 1 } }),
      querySelector: overrides['DOM.querySelector']
        ? record('DOM.querySelector')
        : async (args: any) => {
            calls.push({ method: 'DOM.querySelector', args });
            return { nodeId: 42 };
          },
      resolveNode: async () => ({ object: { objectId: 'OBJ' } }),
    },
    on: () => {},
    close: async () => {},
  }));
  return { factory, calls };
}

describe('CdpClient (mocked CRI)', () => {
  it('24. click() resolves selector and dispatches click via Runtime.callFunctionOn', async () => {
    const { factory, calls } = buildFakeCriFactory();
    const c = new CdpClient({ criFactory: factory });
    const r = await c.click('.video-result');
    expect(r.clicked).toBe(true);
    expect(r.nodeId).toBe(42);
    const querySelectorCall = calls.find((c) => c.method === 'DOM.querySelector');
    expect(querySelectorCall?.args.selector).toBe('.video-result');
    const fnCall = calls.find((c) => c.method === 'Runtime.callFunctionOn');
    expect(fnCall?.args.functionDeclaration).toContain('click()');
  });

  it('25. click() throws when selector matches nothing', async () => {
    const { factory } = buildFakeCriFactory({
      'DOM.querySelector': async () => ({ nodeId: 0 }),
    });
    const c = new CdpClient({ criFactory: factory });
    await expect(c.click('.missing')).rejects.toThrow(/no element matches/);
  });

  it('26. extract() with selector returns innerText via Runtime.evaluate', async () => {
    const { factory, calls } = buildFakeCriFactory({
      'Runtime.evaluate': async () => ({ result: { value: 'hello world' } }),
    });
    const c = new CdpClient({ criFactory: factory });
    const r = await c.extract('h1');
    expect(r.value).toBe('hello world');
    expect(r.selector).toBe('h1');
    const evalCall = calls.find((c) => c.method === 'Runtime.evaluate');
    expect(evalCall?.args.expression).toContain('document.querySelector');
  });

  it('27. evaluate() surfaces exceptionDetails as thrown error', async () => {
    const { factory } = buildFakeCriFactory({
      'Runtime.evaluate': async () => ({
        result: {},
        exceptionDetails: { text: 'ReferenceError: foo is not defined' },
      }),
    });
    const c = new CdpClient({ criFactory: factory });
    await expect(c.evaluate('foo()')).rejects.toThrow(/ReferenceError/);
  });
});

describe('chromeLauncher.probeCdp', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ Browser: 'fake-chrome/0.0' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('28. returns parsed JSON when /json/version answers', async () => {
    const v = await launcher.probeCdp(port, 1000);
    expect(v?.Browser).toBe('fake-chrome/0.0');
  });

  it('29. returns null on unreachable port (no server)', async () => {
    const v = await launcher.probeCdp(1, 200);
    expect(v).toBeNull();
  });
});

describe('plugin register() integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-cdptools-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('30. buildToolHandlers wires three tools that call into the client', async () => {
    const fakeClient = {
      click: vi.fn(async (sel: string) => ({ clicked: true, sel })),
      extract: vi.fn(async (sel?: string) => ({ value: sel ?? 'doc' })),
      evaluate: vi.fn(async (script: string) => ({ value: `got:${script}` })),
    };
    const handlers = pluginEntry.buildToolHandlers(fakeClient);
    expect(handlers.map((h: any) => h.schema.name)).toEqual([
      'browser_real_click',
      'browser_real_extract',
      'browser_real_eval',
    ]);

    const click = handlers.find((h: any) => h.schema.name === 'browser_real_click');
    const r = await click!.execute({ selector: '.x' });
    expect(r).toEqual({ clicked: true, sel: '.x' });
    expect(fakeClient.click).toHaveBeenCalledWith('.x');

    const extract = handlers.find((h: any) => h.schema.name === 'browser_real_extract');
    const e = await extract!.execute({});
    expect(e).toEqual({ value: 'doc' });

    const evalH = handlers.find((h: any) => h.schema.name === 'browser_real_eval');
    const ev = await evalH!.execute({ script: 'location.href' });
    expect(ev).toEqual({ value: 'got:location.href' });
  });

  it('31. tools return structured error (not throw) when client throws', async () => {
    const fakeClient = {
      click: async () => {
        throw new Error('not connected');
      },
      extract: async () => ({}),
      evaluate: async () => ({}),
    };
    const click = pluginEntry.buildToolHandlers(fakeClient).find(
      (h: any) => h.schema.name === 'browser_real_click',
    );
    const r = await click.execute({ selector: '.x' });
    expect(r.error).toBe('not connected');
  });

  it('32. registerTool gates each tool through the plugin context (declared+permission)', async () => {
    // Smoke that the plugin's register() works end-to-end with the real
    // PluginContext. We bypass onActivate (which would try to launch
    // Chrome) by registering tools directly via a synthetic context.
    const tools = new ToolRegistry();
    const hooks = new Map<any, any>();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifestRaw = require('../../../plugins/aiden-plugin-cdp-browser/plugin.json');
    const ctx = new PluginContext(manifestRaw, tools, hooks);
    await pluginEntry.register(ctx);
    expect(tools.list()).toEqual(
      expect.arrayContaining([
        'browser_real_click',
        'browser_real_extract',
        'browser_real_eval',
      ]),
    );
    // onActivate registered but not fired.
    expect(hooks.get('onActivate')?.length).toBe(1);
    expect(hooks.get('onTeardown')?.length).toBe(1);
  });
});
