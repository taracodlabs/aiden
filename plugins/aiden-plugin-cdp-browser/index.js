/**
 * plugins/aiden-plugin-cdp-browser/index.js — Aiden v4.0.0 (Phase 17 Task 2)
 *
 * Bundled plugin: real-Chrome control via the Chrome DevTools Protocol.
 *
 * Closes the gap diagnosed in Phase 16h: Playwright's headless context
 * could open URLs but never click the actual /watch?v= links, so the
 * "play me a song" loop ended at "I opened YouTube" with no playback.
 * The CDP path attaches to the user's running Chrome (or a dedicated
 * debug instance we spawn), does real DOM clicks, real eval, real
 * extraction.
 *
 * Tools registered:
 *   browser_real_click   — click(selector)              category: browser
 *   browser_real_extract — extract([selector])          category: browser
 *   browser_real_eval    — evaluate(script)             category: browser
 *
 * onActivate: ensure CDP is reachable on port 9222. If port already
 * answers /json/version, attach. Otherwise spawn a separate Chrome
 * with --user-data-dir=<aiden-home>/chrome-debug — never disturbs the
 * user's regular browser. If no Chrome binary found, surface the
 * manual command for the user.
 */

'use strict';

const path = require('node:path');
const os = require('node:os');

const { CdpClient } = require('./lib/cdpClient');
const {
  ensureCdpReady,
  DEFAULT_PORT,
} = require('./lib/chromeLauncher');

const TOOL_DESCRIPTIONS = {
  click:
    'Click an element in the user\'s real Chrome via the Chrome DevTools Protocol. Use this when the browser_* (Playwright headless) click tools cannot reach the page — e.g. YouTube /watch?v= results behind anti-bot rendering.',
  extract:
    'Extract text content from the user\'s real Chrome page. Returns innerText of a CSS selector, or document title + first 4kB of body when no selector is given.',
  eval:
    'Run JavaScript in the user\'s real Chrome page context. High-permission — the runtime gates this through the approval engine on every call.',
};

/**
 * Resolve the Aiden home directory the launcher should put the dedicated
 * chrome-debug profile under. Plugin's register(ctx) doesn't get a path
 * handle directly, so we fall back to AIDEN_HOME / platform default —
 * matches core/v4/paths.ts logic without importing it (plugin is JS, not TS).
 */
function resolveAidenRoot() {
  if (process.env.AIDEN_HOME && process.env.AIDEN_HOME.trim().length > 0) {
    return path.resolve(process.env.AIDEN_HOME.trim());
  }
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const lad = process.env.LOCALAPPDATA;
      const base = lad && lad.length > 0 ? lad : path.join(home, 'AppData', 'Local');
      return path.join(base, 'aiden');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'aiden');
    default:
      return path.join(home, '.aiden');
  }
}

/**
 * Build the three browser_real_* ToolHandlers. Pulled out for testing —
 * tests can construct handlers with an injected CdpClient that wraps a
 * fake CRI factory, no real Chrome needed.
 */
function buildToolHandlers(cdpClient) {
  return [
    {
      schema: {
        name: 'browser_real_click',
        description: TOOL_DESCRIPTIONS.click,
        input_schema: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector for the element to click. Required.',
            },
          },
          required: ['selector'],
        },
      },
      category: 'browser',
      mutates: true,
      toolset: 'browser',
      async execute(args) {
        const { selector } = args ?? {};
        if (typeof selector !== 'string' || selector.length === 0) {
          return { error: 'selector is required' };
        }
        try {
          const r = await cdpClient.click(selector);
          return r;
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    {
      schema: {
        name: 'browser_real_extract',
        description: TOOL_DESCRIPTIONS.extract,
        input_schema: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description:
                'Optional CSS selector. When omitted, returns title + first 4kB of body innerText.',
            },
          },
          required: [],
        },
      },
      category: 'browser',
      mutates: false,
      toolset: 'browser',
      async execute(args) {
        try {
          const r = await cdpClient.extract(args?.selector);
          return r;
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    {
      schema: {
        name: 'browser_real_eval',
        description: TOOL_DESCRIPTIONS.eval,
        input_schema: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
              description: 'JavaScript expression or statement to evaluate in the page.',
            },
          },
          required: ['script'],
        },
      },
      category: 'browser',
      mutates: true,
      toolset: 'browser',
      async execute(args) {
        const { script } = args ?? {};
        if (typeof script !== 'string' || script.length === 0) {
          return { error: 'script is required' };
        }
        try {
          const r = await cdpClient.evaluate(script);
          return r;
        } catch (err) {
          return { error: err.message };
        }
      },
    },
  ];
}

/**
 * Plugin entrypoint. The loader awaits this and reports success/failure
 * via PluginRegistry.
 */
async function register(ctx) {
  const cdpClient = new CdpClient({ port: DEFAULT_PORT });

  for (const handler of buildToolHandlers(cdpClient)) {
    ctx.registerTool(handler);
  }

  ctx.registerHook('onActivate', async () => {
    const aidenRoot = resolveAidenRoot();
    const r = await ensureCdpReady({
      port: DEFAULT_PORT,
      aidenRoot,
      timeoutMs: 8000,
    });
    if (!r.ok) {
      // Surface a helpful diagnostic. Loader logs warnings; we also include
      // the manual command so a savvy user can launch Chrome themselves.
      const cmd = r.manualCommand
        ? ` Manual launch: ${r.manualCommand}`
        : '';
      throw new Error(`CDP not ready on port ${DEFAULT_PORT}: ${r.reason}.${cmd}`);
    }
  });

  ctx.registerHook('onTeardown', async () => {
    await cdpClient.close();
  });
}

module.exports = {
  register,
  // Exposed for tests:
  buildToolHandlers,
  resolveAidenRoot,
};
