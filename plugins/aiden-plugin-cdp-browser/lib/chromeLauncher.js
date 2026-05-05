/**
 * plugins/aiden-plugin-cdp-browser/lib/chromeLauncher.js
 *
 * Locate a Chrome-family binary, probe whether port 9222 has a live CDP
 * endpoint, and (if not) launch a separate Chrome instance with a
 * dedicated --user-data-dir so the user's regular browser session is
 * never disrupted.
 *
 * Direct port of Hermes hermes_cli/browser_connect.py (audit doc has the
 * lineage). Same flag set, same separate-profile pattern, same
 * /json/version probe. Detached subprocess on Windows so closing the
 * REPL does not kill the debug Chrome.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 9222;

/**
 * Returns a list of Chrome-family binary candidates ranked by preference.
 * Mirrors Hermes get_chrome_debug_candidates() (browser_connect.py:43).
 */
function getChromeCandidates() {
  const sys = process.platform;
  const candidates = [];
  const seen = new Set();

  const add = (p) => {
    if (!p) return;
    const norm = path.normalize(p);
    if (seen.has(norm.toLowerCase())) return;
    try {
      if (fs.statSync(norm).isFile()) {
        candidates.push(norm);
        seen.add(norm.toLowerCase());
      }
    } catch {
      /* not a file */
    }
  };

  if (sys === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Chromium.app/Contents/MacOS/Chromium');
    add('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    return candidates;
  }

  if (sys === 'win32') {
    const installParts = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ];
    const bases = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const base of bases) {
      for (const parts of installParts) add(path.join(base, ...parts));
    }
    return candidates;
  }

  // Linux + other POSIX
  for (const name of [
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
    'brave-browser',
    'microsoft-edge',
  ]) {
    add(`/usr/bin/${name}`);
    add(`/usr/local/bin/${name}`);
  }
  return candidates;
}

/**
 * Probe http://127.0.0.1:<port>/json/version. Resolves with the parsed
 * JSON on a 200 response, or null on any failure (timeout, refused,
 * non-200, parse error). Never throws.
 */
function probeCdp(port = DEFAULT_PORT, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Build the dedicated debug-profile dir. Pass paths.root from the loader context. */
function chromeDebugDataDir(aidenRoot) {
  return path.join(aidenRoot, 'chrome-debug');
}

function chromeDebugArgs(port, aidenRoot) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${chromeDebugDataDir(aidenRoot)}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/**
 * Attempt to launch a debug-mode Chrome in the background.
 *
 * Returns: { launched: true } on spawn success, { launched: false, reason }
 * if no binary or spawn failed. Does NOT wait for the port to come up —
 * caller polls probeCdp() until it returns non-null (or times out).
 */
function tryLaunchChromeDebug(port = DEFAULT_PORT, aidenRoot = os.homedir()) {
  const candidates = getChromeCandidates();
  if (candidates.length === 0) {
    return {
      launched: false,
      reason: 'no Chrome-family binary found on PATH or standard install dirs',
      manualCommand: null,
    };
  }
  const dataDir = chromeDebugDataDir(aidenRoot);
  fs.mkdirSync(dataDir, { recursive: true });

  const argv = chromeDebugArgs(port, aidenRoot);
  const detachOpts =
    process.platform === 'win32'
      ? {
          detached: true,
          // Hide the console window. CRI driving will still work.
          windowsHide: true,
          stdio: 'ignore',
        }
      : { detached: true, stdio: 'ignore' };

  try {
    const child = spawn(candidates[0], argv, detachOpts);
    child.unref();
    return {
      launched: true,
      pid: child.pid,
      binary: candidates[0],
      manualCommand: `${candidates[0]} ${argv.join(' ')}`,
    };
  } catch (err) {
    return {
      launched: false,
      reason: `spawn failed: ${err.message}`,
      manualCommand: `${candidates[0]} ${argv.join(' ')}`,
    };
  }
}

/**
 * Ensure a CDP endpoint is reachable on `port`. If already responsive,
 * return immediately. Otherwise try to launch and poll until either
 * `/json/version` answers or `timeoutMs` elapses.
 *
 * Returns: { ok: true, alreadyRunning, version, launched } on success,
 *          { ok: false, reason, manualCommand } on failure.
 */
async function ensureCdpReady({
  port = DEFAULT_PORT,
  aidenRoot,
  timeoutMs = 8000,
  pollIntervalMs = 250,
} = {}) {
  const initial = await probeCdp(port);
  if (initial) {
    return { ok: true, alreadyRunning: true, version: initial };
  }

  const launchResult = tryLaunchChromeDebug(port, aidenRoot);
  if (!launchResult.launched) {
    return {
      ok: false,
      reason: launchResult.reason,
      manualCommand: launchResult.manualCommand,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const v = await probeCdp(port);
    if (v) return { ok: true, alreadyRunning: false, version: v, launched: true };
  }
  return {
    ok: false,
    reason: `Chrome spawned (pid ${launchResult.pid}) but /json/version did not answer within ${timeoutMs}ms`,
    manualCommand: launchResult.manualCommand,
  };
}

module.exports = {
  DEFAULT_PORT,
  getChromeCandidates,
  probeCdp,
  chromeDebugDataDir,
  chromeDebugArgs,
  tryLaunchChromeDebug,
  ensureCdpReady,
};
