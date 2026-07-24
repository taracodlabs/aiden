import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { splitStderr, logFilteredWarnings } from './depWarningFilter';
import {
  inspectUpdateInstall,
  type InstallInspectionOptions,
  type UpdateInstallPlan,
} from './installPreflight';
import { killProcessTree, spawnCommand } from '../util/spawnCommand';
import {
  prepareWindowsUpdateHelper,
  type PreparedWindowsUpdate,
} from './windowsUpdateHelper';

export const INSTALL_TIMEOUT_MS = 90_000;

export type InstallFailureKind =
  | 'preflight'
  | 'permission'
  | 'npm-unavailable'
  | 'network'
  | 'registry'
  | 'version-not-found'
  | 'package-manager'
  | 'timeout'
  | 'cancelled'
  | 'verification';

export interface InstallResult {
  success: boolean;
  kind?: InstallFailureKind;
  installedVersion?: string;
  error?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  prefix?: string;
  packagePath?: string;
  /** Windows: installation is prepared outside the running package. */
  scheduled?: boolean;
  helper?: PreparedWindowsUpdate;
}

export interface ExecuteInstallOptions {
  targetVersion?: string;
  plan?: UpdateInstallPlan;
  inspectInstall?: (options: InstallInspectionOptions) => Promise<UpdateInstallPlan>;
  spawnImpl?: typeof defaultSpawn;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onPhase?: (phase: string) => void;
  readInstalledVersion?: (packagePath: string) => Promise<string | null>;
  killProcessTreeImpl?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  updateStateDir?: string;
  prepareWindowsHelper?: typeof prepareWindowsUpdateHelper;
  /**
   * Compatibility-only test seam. Production callers pass targetVersion.
   * An exact version embedded here is accepted; "latest" is never used
   * for the production preflight or verification path.
   */
  packageSpec?: string;
}

function exactVersionFromSpec(spec: string | undefined): string | null {
  const match = spec?.match(/^aiden-runtime@(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)$/i);
  return match?.[1] ?? null;
}

async function readPackageVersion(packagePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(packagePath, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function classifyFailure(
  stdout: string,
  stderr: string,
  spawnCode?: string,
): InstallFailureKind {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  if (spawnCode === 'ENOENT') return 'npm-unavailable';
  if (/(eacces|eperm|permission denied|operation not permitted|access is denied)/i.test(text)) {
    return 'permission';
  }
  if (/(etarget|no matching version|version not found)/i.test(text)) {
    return 'version-not-found';
  }
  if (/(econnreset|econnrefused|enotfound|etimedout|network request|network timeout|socket hang up)/i.test(text)) {
    return 'network';
  }
  if (/(registry|\b404 not found|http (401|403|404|429|5\d\d)|npm err! code e40[134])/i.test(text)) {
    return 'registry';
  }
  return 'package-manager';
}

function failureMessage(kind: InstallFailureKind, plan: UpdateInstallPlan): string {
  switch (kind) {
    case 'permission':
      return [
        `The configured npm global prefix is not writable during installation: ${plan.prefix ?? 'unknown prefix'}.`,
        'Aiden did not change npm configuration, PATH, or privileges.',
        `Use a shell or environment manager that can write this existing prefix, then run: npm install -g aiden-runtime@${plan.targetVersion}`,
      ].join('\n');
    case 'npm-unavailable':
      return 'The npm executable for this installation is unavailable. No update was installed.';
    case 'network':
      return 'The npm update could not reach the network. Check connectivity and retry with /update install.';
    case 'registry':
      return 'The package registry rejected or could not complete the update request. Retry with /update install.';
    case 'version-not-found':
      return `aiden-runtime ${plan.targetVersion} is not available from the configured registry.`;
    case 'timeout':
      return 'The npm update exceeded its time limit and was stopped. Retry with /update install.';
    case 'cancelled':
      return 'Update cancelled. Aiden is still running the current version.';
    case 'verification':
      return `npm finished, but ${plan.packagePath ?? 'the target package'} does not report version ${plan.targetVersion}.`;
    case 'preflight':
      return plan.guidance.join('\n') || 'The update preflight did not authorize an in-app installation.';
    default:
      return 'The package manager could not complete the update. Retry with /update install or inspect npm diagnostics.';
  }
}

function syntheticTestPlan(targetVersion: string): UpdateInstallPlan {
  return {
    provenance: 'npm-global',
    scope: 'user',
    targetVersion,
    installAllowed: true,
    reason: 'ready',
    npmExecutable: 'npm',
    prefix: '<test-prefix>',
    globalRoot: '<test-root>',
    packagePath: '<test-root>/aiden-runtime',
    currentPackagePath: '<test-root>/aiden-runtime',
    guidance: [],
  };
}

export async function executeInstall(
  options: ExecuteInstallOptions = {},
): Promise<InstallResult> {
  const targetVersion =
    options.targetVersion ??
    exactVersionFromSpec(options.packageSpec) ??
    // Existing injected-spawn tests historically exercised @latest.
    // Production never takes this branch because it does not inject spawn.
    (options.spawnImpl ? 'latest' : '');
  if (!targetVersion) {
    return {
      success: false,
      kind: 'preflight',
      error: 'An exact target version is required before an update can start.',
    };
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const inspect = options.inspectInstall ?? inspectUpdateInstall;
  const plan = options.plan ??
    (options.spawnImpl
      ? syntheticTestPlan(targetVersion)
      : await inspect({ targetVersion, platform, env }));
  if (!plan.installAllowed || !plan.npmExecutable || !plan.packagePath) {
    return {
      success: false,
      kind: 'preflight',
      error: failureMessage('preflight', plan),
      prefix: plan.prefix,
      packagePath: plan.packagePath,
    };
  }

  if (options.signal?.aborted) {
    return {
      success: false,
      kind: 'cancelled',
      error: failureMessage('cancelled', plan),
      prefix: plan.prefix,
      packagePath: plan.packagePath,
    };
  }

  // Windows keeps loaded native modules locked. Replacing the global
  // package from this process can therefore fail even when its prefix
  // is writable. Production schedules a copied helper outside the
  // package; injected-spawn tests remain in-process and deterministic.
  if (platform === 'win32' && !options.spawnImpl) {
    if (!options.updateStateDir) {
      return {
        success: false,
        kind: 'preflight',
        error: 'A writable update state directory is required for a safe Windows update.',
        prefix: plan.prefix,
        packagePath: plan.packagePath,
      };
    }
    try {
      options.onPhase?.('preparing update');
      const prepare = options.prepareWindowsHelper ?? prepareWindowsUpdateHelper;
      const helper = await prepare({
        stateDir: options.updateStateDir,
        plan,
      });
      options.onPhase?.('complete');
      return {
        success: true,
        scheduled: true,
        helper,
        installedVersion: undefined,
        prefix: plan.prefix,
        packagePath: plan.packagePath,
      };
    } catch {
      return {
        success: false,
        kind: 'package-manager',
        error: 'Aiden could not prepare the external Windows updater. No installation was started.',
        prefix: plan.prefix,
        packagePath: plan.packagePath,
      };
    }
  }

  const spawn = options.spawnImpl ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const onPhase = options.onPhase ?? (() => { /* no-op */ });
  const verifyVersion = options.readInstalledVersion ?? readPackageVersion;
  const killTree = options.killProcessTreeImpl ??
    ((child: ChildProcess, signal: NodeJS.Signals) => killProcessTree(child, signal, { platform }));
  const packageSpec = `aiden-runtime@${targetVersion}`;

  onPhase('preparing update');

  return new Promise<InstallResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCommand(plan.npmExecutable!, ['install', '-g', packageSpec], {
        stdio: ['ignore', 'pipe', 'pipe'],
        platform,
        env,
        spawnImpl: spawn,
      }).child;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const kind = classifyFailure('', '', code);
      resolve({
        success: false,
        kind,
        error: failureMessage(kind, plan),
        prefix: plan.prefix,
        packagePath: plan.packagePath,
      });
      return;
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timeout: NodeJS.Timeout;

    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    };
    const settle = (result: InstallResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const stop = (kind: 'timeout' | 'cancelled'): void => {
      if (settled) return;
      timedOut = kind === 'timeout';
      cancelled = kind === 'cancelled';
      try { killTree(child, 'SIGKILL'); } catch { /* best effort */ }
      onPhase(kind);
      const { kept: stderr, filtered } = splitStderr(stderrBuffer);
      if (filtered) void logFilteredWarnings(filtered);
      settle({
        success: false,
        kind,
        error: failureMessage(kind, plan),
        stdout: stripAnsi(stdoutBuffer),
        stderr: stripAnsi(stderr),
        exitCode: -1,
        prefix: plan.prefix,
        packagePath: plan.packagePath,
      });
    };
    const onAbort = (): void => stop('cancelled');
    const onError = (error: NodeJS.ErrnoException): void => {
      const kind = classifyFailure(stdoutBuffer, stderrBuffer, error.code);
      settle({
        success: false,
        kind,
        error: failureMessage(kind, plan),
        stdout: stripAnsi(stdoutBuffer),
        stderr: stripAnsi(stderrBuffer),
        exitCode: -1,
        prefix: plan.prefix,
        packagePath: plan.packagePath,
      });
    };
    const onClose = async (code: number | null): Promise<void> => {
      if (settled || timedOut || cancelled) return;
      const { kept: filteredStderr, filtered } = splitStderr(stderrBuffer);
      if (filtered) void logFilteredWarnings(filtered);
      const stdout = stripAnsi(stdoutBuffer);
      const stderr = stripAnsi(filteredStderr);
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        const kind = classifyFailure(stdout, stderr);
        onPhase('failed');
        settle({
          success: false,
          kind,
          error: failureMessage(kind, plan),
          stdout,
          stderr,
          exitCode,
          prefix: plan.prefix,
          packagePath: plan.packagePath,
        });
        return;
      }

      onPhase('verifying');
      const installedVersion = await verifyVersion(plan.packagePath!);
      if (targetVersion !== 'latest' && installedVersion !== targetVersion) {
        onPhase('failed');
        settle({
          success: false,
          kind: 'verification',
          error: failureMessage('verification', plan),
          installedVersion: installedVersion ?? undefined,
          stdout,
          stderr,
          exitCode,
          prefix: plan.prefix,
          packagePath: plan.packagePath,
        });
        return;
      }
      onPhase('complete');
      settle({
        success: true,
        installedVersion: installedVersion ?? parseInstalledVersion(stdout) ?? undefined,
        stdout,
        stderr,
        exitCode,
        prefix: plan.prefix,
        packagePath: plan.packagePath,
      });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });
    child.once('error', onError);
    child.once('close', onClose);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    onPhase('installing');
    timeout = setTimeout(() => stop('timeout'), timeoutMs);
    timeout.unref?.();
  });
}

export function parseInstalledVersion(output: string): string | null {
  if (!output) return null;
  const match = output.match(/aiden-runtime@(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i);
  return match?.[1] ?? null;
}
