/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/auth/loadProvider.ts — Aiden v4.0.0 (Phase 18 Task 5)
 *
 * Shared helper module: lazy-load an OAuth provider plugin's
 * `buildProvider(authHelpers)` and produce a ready-to-use `OAuthProvider`.
 * Both the setup wizard (Task 4) and the `/auth login` slash command
 * (Task 5) call into here so OAuth flow logic lives in exactly one place.
 *
 * Plus a cross-platform `openOAuthBrowserUrl` helper that the user agent
 * each caller builds for the OAuth runtime delegates to.
 */

import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  runCopyPasteFlow,
  runDeviceCodeFlow,
  refreshTokens,
  generatePkce,
} from '../../../core/v4/auth/oauthFlow';
import type { OAuthProvider } from '../../../core/v4/auth/providerAuth';
import { resolveBundledPluginsDir } from '../../../core/v4/plugins/pluginBundledRestore';

/** Map provider id → bundled plugin dir name. Source of truth for the wizard
 *  picker and `/auth login`'s argument validation. */
export const PRO_PLUGIN_DIRS: Record<string, string> = {
  'chatgpt-plus': 'aiden-plugin-chatgpt-plus',
};

/** Canonical list of OAuth provider ids Aiden ships in v4.0. */
export const PRO_PROVIDER_IDS = Object.freeze(
  Object.keys(PRO_PLUGIN_DIRS),
);

/** Helpers bundle plugins call through to (matches PluginContext.auth). */
export const PLUGIN_AUTH_HELPERS = Object.freeze({
  runCopyPasteFlow,
  runDeviceCodeFlow,
  refreshTokens,
  generatePkce,
});

/**
 * Lazy-require the plugin's exported buildProvider. Throws when the
 * plugin isn't shipped (developer error — bundled plugins should always
 * be present after npm install).
 */
export async function loadOAuthProvider(
  providerId: string,
): Promise<OAuthProvider> {
  const dirName = PRO_PLUGIN_DIRS[providerId];
  if (!dirName) {
    throw new Error(
      `Unknown OAuth provider: ${providerId}. ` +
        `Known: ${PRO_PROVIDER_IDS.join(', ')}.`,
    );
  }
  const bundledDir = await resolveBundledPluginsDir();
  if (!bundledDir) {
    throw new Error(
      `Bundled plugins dir not found — Aiden installation may be corrupted.`,
    );
  }
  const entry = path.join(bundledDir, dirName, 'index.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(entry);
  if (typeof mod.buildProvider !== 'function') {
    throw new Error(
      `Plugin ${dirName} does not export buildProvider() — Phase 18 contract violated`,
    );
  }
  return mod.buildProvider(PLUGIN_AUTH_HELPERS);
}

/**
 * Best-effort cross-platform browser open.
 *
 * Phase 25.1.5: the prior implementation routed the URL through
 * `cmd.exe /c start "" <url>` on Windows. cmd.exe's `&` is a command-chain
 * separator, and Node's `spawn` does not quote the URL when constructing
 * the Windows command line — so OAuth URLs (which contain `&` between
 * every query param) were truncated at the first `&` before the browser
 * received them. Anthropic then legitimately reported "Missing client_id
 * parameter" because the request really did lack it.
 *
 * The fix is to invoke the OS protocol handler directly so the URL travels
 * as a single argv element and never passes through a shell parser:
 *
 *   Windows  →  rundll32 url.dll,FileProtocolHandler <url>   (ShellExecute)
 *   macOS    →  open <url>                                    (LaunchServices)
 *   Linux    →  xdg-open <url>                                (XDG)
 *
 * Always returns — never throws — so the OAuth flow falls back to the
 * "copy this URL into a browser" path silently when no browser is
 * available (headless servers, sandboxed CI, broken PATH).
 */
export async function openOAuthBrowserUrl(url: string): Promise<void> {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      // url.dll's FileProtocolHandler invokes ShellExecuteW with the URL
      // as a single string. No cmd.exe involvement, no `&` truncation.
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Ignore — flow's log() already printed the URL the user can open manually.
  }
}
