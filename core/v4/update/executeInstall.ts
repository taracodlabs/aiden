/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/executeInstall.ts — Phase v4.1.2-update.
 *
 * Shared in-process installer for `npm install -g aiden-runtime@latest`.
 * Used by two surfaces:
 *   - `/update install` slash command (cli/v4/commands/update.ts)
 *   - `aiden_self_update` tool (tools/v4/system/aidenSelfUpdate.ts)
 *
 * Both call this single executor so install behavior — timeout,
 * permission-denied fallback, version detection — has ONE source of
 * truth. Future v4.1.3+ rollback / package-manager-swap work edits
 * one file.
 *
 * Behavior:
 *   - Spawns `npm install -g aiden-runtime@latest` with INSTALL_TIMEOUT_MS
 *     wall-clock cap.
 *   - Captures stdout/stderr; returns both for diagnostics regardless
 *     of outcome.
 *   - Detects the installed version from npm's `+ aiden-runtime@x.y.z`
 *     output line; null when not parseable.
 *   - On permission-denied (EACCES / "EACCES" / Windows ENOPRIV /
 *     "operation not permitted"): returns structured failure with
 *     platform-specific copy-paste commands so the user can run the
 *     install manually with proper privileges.
 *
 * Honest about what it doesn't do:
 *   - No auto-restart of the running REPL (Hermes consult: "never
 *     claim current process is upgraded after install"). Caller
 *     prints the "type /quit and rerun aiden" hint.
 *   - No self-escalation to UAC/sudo. We try once; on permission
 *     failure we surface the right copy-paste, not silent escalation.
 *   - No registry probe — call `checkForUpdate` first if you need to
 *     know whether an install is warranted.
 */

import { spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';

/** 90 s wall-clock cap. Generous on cold caches / slow networks. */
export const INSTALL_TIMEOUT_MS = 90_000;

/**
 * What the install attempt returned. `success` true → `installedVersion`
 * is set when parseable. `success` false → `error` is a single-string
 * user-readable failure plus actionable next steps (copy-paste commands
 * for permission failures). `stdout` / `stderr` are preserved for
 * diagnostics in both cases.
 */
export interface InstallResult {
  success:           boolean;
  /** Parsed from npm output: "+ aiden-runtime@4.1.3" → "4.1.3". */
  installedVersion?: string;
  /** Single-string user-readable failure summary, includes copy-paste
   *  remediations for permission errors. */
  error?:            string;
  /** Raw stdout for diagnostics. */
  stdout?:           string;
  /** Raw stderr for diagnostics. */
  stderr?:           string;
  /** Exit code from npm; -1 if the process was killed by the timeout. */
  exitCode?:         number;
}

export interface ExecuteInstallOptions {
  /**
   * Override `child_process.spawn` for tests. Real callers leave this
   * unset; defaults to the node:child_process spawn function.
   */
  spawnImpl?:   typeof defaultSpawn;
  /** Override the wall-clock cap (defaults to INSTALL_TIMEOUT_MS). */
  timeoutMs?:   number;
  /**
   * Override the target spec. Defaults to `aiden-runtime@latest`. Tests
   * use this to verify the command shape; production never passes it.
   */
  packageSpec?: string;
  /**
   * Override platform for the permission-denied remediation. Defaults
   * to `process.platform`. Tests use this to assert the Windows /
   * macOS / Linux branches independently.
   */
  platform?:    NodeJS.Platform;
}

const DEFAULT_PACKAGE_SPEC = 'aiden-runtime@latest';

/**
 * Run the install. Returns a structured result; NEVER throws — the
 * outer surface (slash command / tool) renders the result to the user.
 *
 * Error path is intentionally string-typed (single user-visible
 * paragraph). The structured fields (stdout/stderr/exitCode) are for
 * diagnostics; callers that want to surface them to the user can
 * compose their own message from those.
 */
export async function executeInstall(
  opts: ExecuteInstallOptions = {},
): Promise<InstallResult> {
  const spawn       = opts.spawnImpl   ?? defaultSpawn;
  const timeoutMs   = opts.timeoutMs   ?? INSTALL_TIMEOUT_MS;
  const packageSpec = opts.packageSpec ?? DEFAULT_PACKAGE_SPEC;
  const platform    = opts.platform    ?? process.platform;

  return new Promise<InstallResult>((resolve) => {
    const args: string[] = ['install', '-g', packageSpec];
    // shell: true on Windows so npm.cmd is found via PATHEXT; on
    // POSIX we spawn npm directly. Either way the args are validated
    // (only npm + install + a hardcoded spec by default) — no user
    // input flows into argv.
    const spawnOpts: SpawnOptions = {
      shell: platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    let child;
    try {
      child = spawn('npm', args, spawnOpts);
    } catch (err) {
      resolve({
        success: false,
        error:   `Could not launch npm: ${(err as Error).message}. ` +
                 `Run \`npm install -g aiden-runtime@latest\` manually.`,
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuf += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuf += chunk.toString();
    });

    // Timeout — kill the child + resolve as a failure with the captured
    // output so the user sees what npm was doing.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      // Spawn-level error (ENOENT — npm not on PATH).
      resolve({
        success: false,
        error:   `npm spawn failed: ${err.message}. Is npm installed and on PATH?`,
        stderr:  stderrBuf,
        stdout:  stdoutBuf,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = stdoutBuf;
      const stderr = stderrBuf;
      const exitCode = code ?? -1;

      if (timedOut) {
        resolve({
          success: false,
          error:   `Install timed out after ${timeoutMs}ms. ` +
                   `Try \`npm install -g aiden-runtime@latest\` manually.`,
          stdout, stderr, exitCode: -1,
        });
        return;
      }

      // Permission-denied: surface platform-specific remediations.
      if (isPermissionDenied(stdout, stderr, exitCode)) {
        resolve({
          success: false,
          error:   permissionDeniedMessage(platform),
          stdout, stderr, exitCode,
        });
        return;
      }

      if (exitCode !== 0) {
        resolve({
          success: false,
          error:   `Install failed (npm exit ${exitCode}). ` +
                   (stderr.trim().slice(0, 200) ||
                    'See stderr/stdout for details. Try `npm install -g aiden-runtime@latest` manually.'),
          stdout, stderr, exitCode,
        });
        return;
      }

      // Success — parse installed version from npm output. Pattern:
      // "+ aiden-runtime@4.1.3" or "added 1 package ... aiden-runtime@4.1.3"
      const installedVersion = parseInstalledVersion(stdout) ?? parseInstalledVersion(stderr) ?? undefined;
      resolve({
        success: true,
        installedVersion,
        stdout, stderr, exitCode,
      });
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Did npm fail because of a permission error? Heuristics across the
 * three platforms — npm doesn't return a single canonical exit code
 * for this, so we sniff the captured streams.
 */
function isPermissionDenied(
  stdout:   string,
  stderr:   string,
  exitCode: number,
): boolean {
  const haystack = `${stderr}\n${stdout}`.toLowerCase();
  // POSIX: "EACCES", "permission denied", "operation not permitted"
  if (haystack.includes('eacces'))            return true;
  if (haystack.includes('permission denied')) return true;
  if (haystack.includes('operation not permitted')) return true;
  // Windows: usually exit 1 with stderr containing "EPERM" or
  // "operation not permitted" or "access is denied"
  if (haystack.includes('eperm'))             return true;
  if (haystack.includes('access is denied'))  return true;
  // exit 243 is the npm conventional "permission" code on some setups;
  // we don't gate on exit code alone (too noisy) but combined with
  // any of the above strings it's a clear signal.
  void exitCode;
  return false;
}

/**
 * Build the platform-specific copy-paste remediation. Hermes recommends
 * three distinct paths — system-wide-with-elevation, sudo, or
 * user-local-prefix — so the user has options without us trying to
 * self-escalate.
 */
function permissionDeniedMessage(platform: NodeJS.Platform): string {
  const userLocal =
    'Or use a user-local npm prefix to avoid privileges entirely:\n' +
    '              npm config set prefix ~/.npm-global\n' +
    '              export PATH=~/.npm-global/bin:$PATH    # add to your shell profile\n' +
    '              npm install -g aiden-runtime@latest';

  if (platform === 'win32') {
    return [
      'Install failed: permission denied (npm needs Administrator for global install).',
      '',
      'To update manually:',
      '  Windows:  Open PowerShell as Administrator, then:',
      '              npm install -g aiden-runtime@latest',
      '',
      userLocal,
    ].join('\n');
  }
  // darwin / linux / others — sudo path.
  return [
    'Install failed: permission denied (npm needs sudo for global install).',
    '',
    'To update manually:',
    '  macOS / Linux:',
    '              sudo npm install -g aiden-runtime@latest',
    '',
    userLocal,
  ].join('\n');
}

/**
 * Find the installed version in npm output. Two common patterns:
 *   "+ aiden-runtime@4.1.3"
 *   "added 1 package in 12s ... aiden-runtime@4.1.3"
 * Returns the bare version string (no `v` prefix) or null.
 */
export function parseInstalledVersion(out: string): string | null {
  if (!out) return null;
  const m = out.match(/aiden-runtime@(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i);
  return m ? m[1] : null;
}
