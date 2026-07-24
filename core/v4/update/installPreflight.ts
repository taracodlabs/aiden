import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectInstallMethod,
  type DetectInstallMethodInput,
} from './installMethodDetect';
import {
  killProcessTree,
  resolveCommand,
  spawnCommand,
  type ResolvedCommand,
} from '../util/spawnCommand';

const PROBE_TIMEOUT_MS = 8_000;

export type InstallProvenance =
  | 'npm-global'
  | 'npm-local'
  | 'package-runner'
  | 'source'
  | 'standalone'
  | 'unknown';

export type InstallPlanReason =
  | 'ready'
  | 'prefix-not-writable'
  | 'npm-unavailable'
  | 'prefix-resolution-failed'
  | 'npm-environment-mismatch'
  | 'package-runner'
  | 'local-install'
  | 'source'
  | 'standalone'
  | 'unknown';

export interface CapturedCommand {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export type RunCapturedCommand = (
  command: string,
  args: readonly string[],
) => Promise<CapturedCommand>;

export interface UpdateInstallPlan {
  provenance: InstallProvenance;
  scope?: 'user' | 'system';
  targetVersion: string;
  installAllowed: boolean;
  reason: InstallPlanReason;
  npmExecutable?: string;
  prefix?: string;
  globalRoot?: string;
  packagePath?: string;
  currentPackagePath?: string;
  elevated?: boolean;
  guidance: string[];
}

export interface InstallInspectionOptions {
  targetVersion: string;
  detectionInput?: DetectInstallMethodInput;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  elevated?: boolean;
  resolveNpm?: () => ResolvedCommand | null;
  runCommand?: RunCapturedCommand;
  probeWritable?: (directory: string) => Promise<boolean>;
  isSourceCheckout?: (input: DetectInstallMethodInput) => Promise<boolean>;
  spawnImpl?: typeof defaultSpawn;
}

function currentPackagePath(input: DetectInstallMethodInput): string | undefined {
  const haystack = `${input.moduleDir ?? ''}\n${input.argvScript ?? ''}`;
  const match = haystack.match(/(^|[\r\n])(.+?[/\\]node_modules[/\\]aiden-runtime)\b/i);
  return match?.[2] ? path.normalize(match[2]) : undefined;
}

function equivalentOrInside(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const a = normalize(candidate);
  const b = normalize(root);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

async function defaultWritableProbe(directory: string): Promise<boolean> {
  const marker = path.join(
    directory,
    `.aiden-update-write-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await fs.access(directory, fsConstants.W_OK);
    const handle = await fs.open(marker, 'wx');
    await handle.close();
    await fs.unlink(marker);
    return true;
  } catch {
    try { await fs.unlink(marker); } catch { /* best-effort cleanup */ }
    return false;
  }
}

function defaultRunCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof defaultSpawn,
): RunCapturedCommand {
  return async (command, args) => new Promise<CapturedCommand>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCommand(command, args, {
        platform,
        env,
        spawnImpl,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).child;
    } catch (error) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: '',
        errorCode: (error as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (result: CapturedCommand): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ exitCode: -1, stdout, stderr, errorCode: error.code ?? 'SPAWN_FAILED' });
    });
    child.once('close', (code) => finish({ exitCode: code ?? -1, stdout, stderr }));
    timer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL', { platform });
      finish({ exitCode: -1, stdout, stderr, errorCode: 'ETIMEDOUT' });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
}

function manualPlan(
  targetVersion: string,
  provenance: InstallProvenance,
  reason: InstallPlanReason,
  guidance: string[],
): UpdateInstallPlan {
  return {
    provenance,
    targetVersion,
    installAllowed: false,
    reason,
    guidance,
  };
}

async function defaultSourceCheckout(input: DetectInstallMethodInput): Promise<boolean> {
  const starts = [
    input.argvScript ? path.dirname(input.argvScript) : '',
    input.moduleDir ?? '',
  ].filter(Boolean);
  for (const start of starts) {
    let cursor = path.resolve(start);
    for (let depth = 0; depth < 10; depth += 1) {
      try {
        const [git, pkg] = await Promise.all([
          fs.stat(path.join(cursor, '.git')),
          fs.readFile(path.join(cursor, 'package.json'), 'utf8'),
        ]);
        const parsed = JSON.parse(pkg) as { name?: unknown };
        if (git && parsed.name === 'aiden-runtime') return true;
      } catch { /* keep walking */ }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return false;
}

export async function inspectUpdateInstall(
  options: InstallInspectionOptions,
): Promise<UpdateInstallPlan> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const detectionInput: DetectInstallMethodInput = {
    platform,
    env,
    execPath: process.execPath,
    moduleDir: typeof __dirname === 'string' ? __dirname : '',
    argvScript: process.argv[1] ?? '',
    ...options.detectionInput,
  };
  const detected = detectInstallMethod(detectionInput);

  if (detected.method === 'npx') {
    return manualPlan(options.targetVersion, 'package-runner', 'package-runner', [
      'This session is running from a package-runner cache; there is no installed copy to replace.',
      `Exit this session, then run: npx --yes aiden-runtime@${options.targetVersion}`,
    ]);
  }
  if (detected.method === 'source') {
    return manualPlan(options.targetVersion, 'source', 'source', [
      'This session is running from a source checkout. No global npm installation was started.',
      'Update the checkout with its repository workflow, then rebuild.',
    ]);
  }
  if (detected.method === 'standalone-binary') {
    return manualPlan(options.targetVersion, 'standalone', 'standalone', [
      'This is a standalone installation. Use the packaged release update path.',
      'https://github.com/taracodlabs/aiden/releases',
    ]);
  }
  if (detected.method === 'unknown') {
    const isSource = await (options.isSourceCheckout ?? defaultSourceCheckout)(detectionInput);
    if (isSource) {
      return manualPlan(options.targetVersion, 'source', 'source', [
        'This session is running from a source checkout. No global npm installation was started.',
        'Update the checkout with its repository workflow, then rebuild.',
      ]);
    }
  }
  if (detected.method !== 'npm-global' && detected.method !== 'npm-local') {
    return manualPlan(options.targetVersion, 'unknown', 'unknown', [
      'Aiden could not prove how this copy was installed, so no installer was started.',
      'Inspect the active executable and installation method, then use the matching package workflow.',
    ]);
  }

  const npm = options.resolveNpm
    ? options.resolveNpm()
    : resolveCommand('npm', { platform, env });
  if (!npm) {
    return manualPlan(options.targetVersion, 'npm-global', 'npm-unavailable', [
      'The npm executable for this environment could not be resolved. No installer was started.',
    ]);
  }

  const runCommand = options.runCommand ??
    defaultRunCommand(platform, env, options.spawnImpl ?? defaultSpawn);
  const [prefixResult, rootResult] = await Promise.all([
    runCommand(npm.path, ['prefix', '-g']),
    runCommand(npm.path, ['root', '-g']),
  ]);
  const prefix = prefixResult.stdout.trim();
  const globalRoot = rootResult.stdout.trim();
  if (
    prefixResult.exitCode !== 0 ||
    rootResult.exitCode !== 0 ||
    !path.isAbsolute(prefix) ||
    !path.isAbsolute(globalRoot)
  ) {
    return {
      ...manualPlan(options.targetVersion, 'npm-global', 'prefix-resolution-failed', [
        'Aiden could not resolve the active npm global prefix and package root. No installer was started.',
      ]),
      npmExecutable: npm.path,
    };
  }

  const packagePath = path.join(globalRoot, 'aiden-runtime');
  const runningPackage = currentPackagePath(detectionInput);
  if (!runningPackage || !equivalentOrInside(runningPackage, packagePath, platform)) {
    if (detected.method === 'npm-local') {
      return {
        ...manualPlan(options.targetVersion, 'npm-local', 'local-install', [
          'This is a project-local installation. Update it from that project with its package workflow.',
          detected.updateCommand(options.targetVersion),
        ]),
        npmExecutable: npm.path,
        prefix,
        globalRoot,
        packagePath,
        currentPackagePath: runningPackage,
      };
    }
    return {
      ...manualPlan(options.targetVersion, 'npm-global', 'npm-environment-mismatch', [
        `The resolved npm environment targets ${packagePath}, but it does not own the running Aiden package.`,
        'Use the package manager associated with the active Aiden executable.',
      ]),
      npmExecutable: npm.path,
      prefix,
      globalRoot,
      packagePath,
      currentPackagePath: runningPackage,
    };
  }

  const probeWritable = options.probeWritable ?? defaultWritableProbe;
  const writable = await Promise.all([
    probeWritable(prefix),
    probeWritable(globalRoot),
    probeWritable(packagePath),
  ]);
  const scope: 'user' | 'system' =
    equivalentOrInside(prefix, home, platform) ? 'user' : 'system';
  if (writable.some((value) => !value)) {
    return {
      provenance: 'npm-global',
      scope,
      targetVersion: options.targetVersion,
      installAllowed: false,
      reason: 'prefix-not-writable',
      npmExecutable: npm.path,
      prefix,
      globalRoot,
      packagePath,
      currentPackagePath: runningPackage,
      elevated: options.elevated,
      guidance: [
        `The configured npm global prefix is not writable: ${prefix}`,
        'Aiden did not start an installation and did not change npm configuration, PATH, or privileges.',
        `Use a shell or environment manager that can write this existing prefix, then run: npm install -g aiden-runtime@${options.targetVersion}`,
      ],
    };
  }

  return {
    provenance: 'npm-global',
    scope,
    targetVersion: options.targetVersion,
    installAllowed: true,
    reason: 'ready',
    npmExecutable: npm.path,
    prefix,
    globalRoot,
    packagePath,
    currentPackagePath: runningPackage,
    elevated: options.elevated,
    guidance: [],
  };
}
