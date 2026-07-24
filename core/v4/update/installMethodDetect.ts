/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/installMethodDetect.ts — v4.5 update system.
 *
 * Identify how the user installed Aiden so the update path can do
 * the right thing without false promises:
 *
 *   npm-global        — `npm install -g aiden-runtime`
 *                       → run `npm install -g aiden-runtime@<v>`
 *   npm-local         — local install in a project's node_modules
 *                       → run `npm install aiden-runtime@<v>` in that
 *                          project (printed to user; we don't dispatch
 *                          a project-local install from the global path)
 *   npx               — running via `npx aiden-runtime`
 *                       → tell user to re-run with the new version pinned
 *   standalone-binary — packaged binary (aiden-releases artefact)
 *                       → point at the GitHub releases page
 *   unknown           — fallback: print the install command verbatim
 *
 * Pure detection logic — no I/O, no spawning. Caller dispatches.
 */

import path from 'node:path';

export type InstallMethod =
  | 'npm-global'
  | 'npm-local'
  | 'npx'
  | 'source'
  | 'standalone-binary'
  | 'unknown';

export interface DetectInstallMethodInput {
  /** Override `process.execPath`. Tests inject. */
  execPath?:    string;
  /** Override `__dirname` (or equivalent for the running entry point). */
  moduleDir?:   string;
  /** Override `process.argv[1]`. */
  argvScript?:  string;
  /** Override `process.platform`. */
  platform?:    NodeJS.Platform;
  /** Override `process.env`. */
  env?:         NodeJS.ProcessEnv;
}

export interface InstallMethodResult {
  method:        InstallMethod;
  /**
   * The shell command (or instruction) the user should run to
   * install the supplied target version. For methods we can
   * dispatch in-process (npm-global / npm-local), this is what
   * we'd spawn. For methods we can't (npx / standalone), it's the
   * instruction to surface verbatim.
   */
  updateCommand: (version: string) => string;
  /**
   * `true` when the update can be dispatched directly via
   * `executeInstall`; `false` when we must show the user the
   * command and exit.
   */
  inProcessInstallSupported: boolean;
  /** Diagnostic — single-line description for `/update` status. */
  description: string;
}

const NPX_CACHE_HINT = /[/\\]_npx[/\\]/;
const NPM_GLOBAL_HINTS = [
  /[/\\]npm[/\\]node_modules[/\\]aiden-runtime\b/,
  /[/\\]npm-global[/\\]/,
  /[/\\]\.nvm[/\\]versions[/\\]node[/\\][^/\\]+[/\\]lib[/\\]node_modules\b/,
  /Program Files[/\\]nodejs[/\\]node_modules[/\\]aiden-runtime\b/i,
  // v4.8.1 Slice 2 — Windows user-mode `npm install -g` lands in
  // `C:\Users\<u>\AppData\Roaming\npm\node_modules\aiden-runtime\`.
  // The leading `[/\\]npm[/\\]node_modules` hint above usually catches
  // it, but tests on a non-default `npm config prefix` setup
  // (Cmder, Scoop, etc.) can land outside the canonical path. The
  // extra hint here is a belt-and-suspenders explicit AppData match.
  /[/\\]AppData[/\\]Roaming[/\\]npm[/\\]/i,
];

function inferDirs(input: DetectInstallMethodInput): {
  execPath: string;
  moduleDir: string;
  argvScript: string;
} {
  return {
    execPath:   input.execPath ?? process.execPath,
    moduleDir:  input.moduleDir ?? (typeof __dirname === 'string' ? __dirname : ''),
    argvScript: input.argvScript ?? (process.argv[1] ?? ''),
  };
}

/**
 * Pure detection. Order matters — npx and standalone-binary are
 * checked first because they have distinctive path markers; npm
 * variants are detected by their node_modules location.
 */
export function detectInstallMethod(
  input: DetectInstallMethodInput = {},
): InstallMethodResult {
  const { moduleDir, argvScript } = inferDirs(input);
  const platform = input.platform ?? process.platform;
  const env      = input.env      ?? process.env;
  void platform;

  // npx — running from npm's npx cache directory.
  if (NPX_CACHE_HINT.test(moduleDir) || NPX_CACHE_HINT.test(argvScript)) {
    return {
      method:                    'npx',
      inProcessInstallSupported: false,
      description:               'running via npx (no installed copy to update)',
      updateCommand: (v) =>
        `npx aiden-runtime@${v}    # re-run the CLI with the pinned version`,
    };
  }

  // Standalone binary — env var set by the release scripts when
  // packaging via pkg / nexe / similar. Future-proof; no current
  // releases set it, so we don't accidentally classify a normal
  // node install as standalone.
  if (env.AIDEN_STANDALONE_BINARY === '1') {
    return {
      method:                    'standalone-binary',
      inProcessInstallSupported: false,
      description:               'standalone binary install (not from npm)',
      updateCommand: (_v) =>
        'Download the latest release from https://github.com/taracodlabs/aiden/releases',
    };
  }

  // npm-global — moduleDir / argvScript live under a global
  // node_modules path.
  const haystack = `${moduleDir} ${argvScript}`;
  if (NPM_GLOBAL_HINTS.some((rx) => rx.test(haystack))) {
    return {
      method:                    'npm-global',
      inProcessInstallSupported: true,
      description:               'global npm install (aiden-runtime)',
      updateCommand: (v) => `npm install -g aiden-runtime@${v}`,
    };
  }

  // npm-local — `node_modules/aiden-runtime/` somewhere in the
  // moduleDir's ancestry but NOT under npm/global paths above.
  if (/[/\\]node_modules[/\\]aiden-runtime\b/.test(moduleDir) ||
      /[/\\]node_modules[/\\]aiden-runtime\b/.test(argvScript)) {
    // Walk up to find the project root (parent of `node_modules`).
    const idx = moduleDir.search(/[/\\]node_modules[/\\]aiden-runtime\b/);
    const projectRoot = idx >= 0 ? moduleDir.slice(0, idx) : '<project>';
    return {
      method:                    'npm-local',
      inProcessInstallSupported: false,
      description:               `local npm install in project (${path.basename(projectRoot)})`,
      updateCommand: (v) =>
        `cd ${projectRoot} && npm install aiden-runtime@${v}`,
    };
  }

  // Repository/source execution. This deliberately checks the live
  // TypeScript CLI shape only; compiled copies outside node_modules
  // remain unknown until the async preflight can inspect them.
  if (
    /[/\\]cli[/\\]v4[/\\]aidenCLI\.ts$/i.test(argvScript) ||
    env.AIDEN_SOURCE_CHECKOUT === '1'
  ) {
    return {
      method:                    'source',
      inProcessInstallSupported: false,
      description:               'repository/source execution',
      updateCommand: (_v) =>
        'Update this source checkout with its repository workflow; no npm-global install was started.',
    };
  }

  // Unknown — fallback to the verbatim global-install command. The
  // user sees it; we don't spawn. Most accurate default for a
  // fresh `npx tsx cli/v4/aidenCLI.ts` dev-mode invocation, which
  // is also the path the maintainer (and many CI environments)
  // use day-to-day.
  return {
    method:                    'unknown',
    inProcessInstallSupported: false,
    description:               'install method not detected (running from source?)',
    updateCommand: (v) =>
      `npm install -g aiden-runtime@${v}    # if installed via npm, otherwise see docs`,
  };
}
