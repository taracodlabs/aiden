import fs from 'node:fs';
import path from 'node:path';

export interface BrowserDiscoveryOptions {
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}

export const NO_SYSTEM_BROWSER_ERROR =
  'No supported system browser found. Install Google Chrome or Microsoft Edge, then retry. Aiden does not download browsers during installation.';

const WINDOWS_CANDIDATES = [
  ['PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ['PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ['PROGRAMFILES', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['LOCALAPPDATA', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
] as const;

const DARWIN_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
] as const;

const UNIX_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
] as const;

function pathEntries(env: NodeJS.ProcessEnv, delimiter: string): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(delimiter).filter(Boolean);
}

function findOnPath(command: string, env: NodeJS.ProcessEnv, exists: (candidate: string) => boolean, pathApi: typeof path.posix): string | null {
  for (const directory of pathEntries(env, pathApi.delimiter)) {
    const candidate = pathApi.join(directory, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Resolve an already-installed Chrome or Edge executable without downloading a browser. */
export function findSystemBrowserExecutable(options: BrowserDiscoveryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'win32') {
    for (const parts of WINDOWS_CANDIDATES) {
      const root = env[parts[0]];
      if (!root) continue;
      const candidate = pathApi.join(root, ...parts.slice(1));
      if (exists(candidate)) return candidate;
    }
    return findOnPath('chrome.exe', env, exists, pathApi) ?? findOnPath('msedge.exe', env, exists, pathApi);
  }

  if (platform === 'darwin') {
    for (const candidate of DARWIN_CANDIDATES) {
      if (exists(candidate)) return candidate;
    }
  }

  for (const command of UNIX_COMMANDS) {
    const candidate = findOnPath(command, env, exists, pathApi);
    if (candidate) return candidate;
  }
  return null;
}
