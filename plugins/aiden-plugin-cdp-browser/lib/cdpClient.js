/**
 * plugins/aiden-plugin-cdp-browser/lib/cdpClient.js
 *
 * Thin wrapper over chrome-remote-interface that the three browser_real_*
 * tool handlers share. One persistent CDP client per plugin instance —
 * matches Hermes's CDPSupervisor (one WS per task; tools/browser_supervisor.py)
 * but without the dialog-bridge layer (Aiden v4.0 doesn't surface dialogs).
 *
 * Tools call connect() on first use; the singleton is cached and reused.
 * On disconnect (Chrome closed, network glitch) the next call reconnects.
 *
 * The class is split out so plugin tests can substitute a fake CRI module
 * via the `criFactory` option.
 */

'use strict';

const realCDP = require('chrome-remote-interface');

class CdpClient {
  constructor(opts = {}) {
    this.port = opts.port ?? 9222;
    this.host = opts.host ?? '127.0.0.1';
    this.criFactory = opts.criFactory ?? realCDP;
    this._client = null;
    this._connecting = null;
  }

  async connect() {
    if (this._client) return this._client;
    if (this._connecting) return this._connecting;
    this._connecting = (async () => {
      try {
        const client = await this.criFactory({ port: this.port, host: this.host });
        await client.Page.enable();
        await client.Runtime.enable();
        await client.DOM.enable();
        client.on?.('disconnect', () => {
          if (this._client === client) this._client = null;
        });
        this._client = client;
        return client;
      } finally {
        this._connecting = null;
      }
    })();
    return this._connecting;
  }

  async close() {
    const c = this._client;
    this._client = null;
    if (c?.close) {
      try {
        await c.close();
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * Navigate the active tab and wait for load. Useful for tests that
   * compose Aiden's existing open_url with the new browser_real_* tools.
   */
  async navigate(url) {
    const client = await this.connect();
    await client.Page.navigate({ url });
    await client.Page.loadEventFired();
  }

  /**
   * Click the first element matching `selector`. Uses DOM.querySelector
   * so the call works on any document the user already has open — no
   * Page.navigate needed if the tab is already where the agent wants it.
   *
   * Returns: { clicked: true, nodeId } on success.
   * Throws with a clear message if the selector matches nothing.
   */
  async click(selector) {
    const client = await this.connect();
    const { root } = await client.DOM.getDocument();
    const { nodeId } = await client.DOM.querySelector({
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) {
      throw new Error(`no element matches selector: ${selector}`);
    }
    // Resolve to a JS object so we can dispatch a real click via Runtime —
    // DOM.click does not exist; instead resolve and call .click().
    const { object } = await client.DOM.resolveNode({ nodeId });
    await client.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: 'function() { this.click(); }',
      returnByValue: true,
    });
    return { clicked: true, nodeId };
  }

  /**
   * Extract text content from the page. If `selector` is given, returns
   * the innerText of the first matching element. Without a selector
   * returns the document title and the first 4kB of document.body.innerText.
   */
  async extract(selector) {
    const client = await this.connect();
    if (selector) {
      const expr = `(() => { const el = document.querySelector(${JSON.stringify(
        selector,
      )}); return el ? el.innerText : null; })()`;
      const { result, exceptionDetails } = await client.Runtime.evaluate({
        expression: expr,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(`extract eval failed: ${exceptionDetails.text}`);
      }
      return { selector, value: result.value };
    }
    const { result } = await client.Runtime.evaluate({
      expression: `({ title: document.title, text: (document.body && document.body.innerText || '').slice(0, 4096), url: location.href })`,
      returnByValue: true,
    });
    return result.value;
  }

  /**
   * Run arbitrary JS in the page context. High-permission — the caller
   * must have already prompted the user via the approval engine.
   *
   * Always passes `awaitPromise: true` so handlers that return a promise
   * resolve before we report back.
   */
  async evaluate(script) {
    const client = await this.connect();
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`eval failed: ${exceptionDetails.text}`);
    }
    return { value: result.value, type: result.type };
  }
}

module.exports = { CdpClient };
