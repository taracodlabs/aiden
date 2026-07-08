/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/workbench/openBrowser.ts — best-effort "open this URL in the default
 * browser." Cross-platform (Windows `start`, macOS `open`, Linux `xdg-open`).
 * Never throws and never blocks — the URL is always printed as a fallback.
 */
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === 'win32') {
      // `start` is a cmd builtin; the empty "" is the window title (required so a
      // quoted URL isn't consumed as the title).
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no browser available — the printed URL is the fallback */ });
    child.unref();
  } catch {
    /* best-effort only */
  }
}
