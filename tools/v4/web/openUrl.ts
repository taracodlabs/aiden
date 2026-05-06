/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/web/openUrl.ts — `open_url` (Phase 16f Task 1E)
 *
 * Platform-aware shell launch of a URL in the user's default browser.
 * For an interactive single-user CLI, the shell-launch pattern carried
 * over from Aiden v3 gives the same anti-detection / real-profile win
 * as a CDP-managed Chrome path without requiring
 * `chrome --remote-debugging-port=9222` setup.
 *
 * Use cases:
 *   - User says "open google.com" → no Playwright, no CAPTCHA, just
 *     `start chrome google.com` in the user's default-profile browser.
 *   - User says "search latest AI news" → agent constructs
 *     `https://www.google.com/search?q=latest+AI+news` and launches it.
 *
 * NOT for use cases that need to extract / click / type — those still
 * go through `browser_navigate` and the Playwright stack.
 *
 * Approval: pre-flagged as a built-in safe tool in
 * `moat/approvalEngine.ts::BUILTIN_SAFE_TOOLS`. Auto-approved in smart
 * mode. Same trust level as the user clicking a link.
 */

import { spawn } from 'node:child_process';
import type { ToolHandler } from '../../../core/v4/toolRegistry';

/** Resolve the launch command for the current platform. */
export function resolveOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    // `start ""` — the empty title arg is required when the URL would
    // otherwise be parsed as the window title. cmd.exe is the host.
    return { cmd: 'cmd.exe', args: ['/c', 'start', '""', url] };
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: [url] };
  }
  // Linux / BSD / etc. — xdg-open is the freedesktop standard.
  return { cmd: 'xdg-open', args: [url] };
}

/** Validate URL shape — http/https only, no javascript: / data: / file:. */
export function isLaunchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const openUrlTool: ToolHandler = {
  schema: {
    name: 'open_url',
    description:
      "Open a URL in the user's default browser via the OS shell (start/open/xdg-open). " +
      'Uses the real user profile — no CAPTCHA, no Playwright detection. ' +
      'Returns immediately after launching; does NOT wait for the page to load and ' +
      'does NOT support extraction or interaction. Use browser_navigate for those.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to open.',
        },
      },
      required: ['url'],
    },
  },
  category: 'network',
  mutates: false,
  toolset: 'web',
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!isLaunchableUrl(url)) {
      return {
        success: false,
        error: `Invalid URL: ${JSON.stringify(args.url)}. Must be http: or https:.`,
      };
    }
    const { cmd, args: spawnArgs } = resolveOpenCommand(process.platform, url);
    return new Promise<Record<string, unknown>>((resolve) => {
      try {
        const child = spawn(cmd, spawnArgs, {
          detached: true,
          stdio: 'ignore',
          // Phase 22 Task 9 (DEP0190 fix): we already invoke `cmd.exe`
          // explicitly on Windows for the `start ""` builtin; shell:true
          // was redundant and tripped Node 22's deprecation warning.
          // macOS/Linux call the launcher binary (`open` / `xdg-open`)
          // directly. shell:false everywhere now.
          shell: false,
          windowsHide: false,
        });
        child.on('error', (err) => {
          resolve({
            success: false,
            error: `Failed to launch browser: ${err.message}`,
          });
        });
        child.unref();
        // Return immediately — `start`/`open`/`xdg-open` exit fast and
        // there's no page-load signal to wait on.
        resolve({
          success: true,
          url,
          launcher: `${cmd} ${spawnArgs.join(' ')}`,
        });
      } catch (err) {
        resolve({
          success: false,
          error: `Spawn failed: ${(err as Error).message}`,
        });
      }
    });
  },
};
