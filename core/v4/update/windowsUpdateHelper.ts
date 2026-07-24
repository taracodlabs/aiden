import { spawn as defaultSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UpdateInstallPlan } from './installPreflight';

const RESULT_FILE = 'update-result.json';
const HELPER_FILE = 'update-helper.cjs';
const STATE_FILE = 'update-helper-state.json';

export interface WindowsUpdateResult {
  success: boolean;
  kind: string;
  targetVersion: string;
  prefix?: string;
  completedAt: number;
}

export interface PreparedWindowsUpdate {
  scheduled: true;
  helperPath: string;
  statePath: string;
  resultPath: string;
}

export interface PrepareWindowsUpdateOptions {
  stateDir: string;
  plan: UpdateInstallPlan;
  parentPid?: number;
  nodeExecutable?: string;
  timeoutMs?: number;
  spawnImpl?: typeof defaultSpawn;
}

const HELPER_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const statePath = process.argv[2];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const resultPath = state.resultPath;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const escapeCmdArg = (value) => {
  if (value.length === 0) return '""';
  if (!/[\s&|<>()@^"]/.test(value)) return value;
  return '"' + value.replace(/"/g, '""') + '"';
};
const writeResult = (value) => {
  const tmp = resultPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, resultPath);
};
const classify = (text) => {
  const value = String(text || '').toLowerCase();
  if (/(eacces|eperm|permission denied|operation not permitted|access is denied)/.test(value)) return 'permission';
  if (/(etarget|no matching version|version not found)/.test(value)) return 'version-not-found';
  if (/(econnreset|econnrefused|enotfound|etimedout|network request|socket hang up)/.test(value)) return 'network';
  if (/(registry|http (401|403|404|429|5\d\d))/.test(value)) return 'registry';
  return 'package-manager';
};
const cleanup = () => {
  try { fs.unlinkSync(statePath); } catch {}
  try { fs.unlinkSync(__filename); } catch {}
};

(async () => {
  try {
    const waitUntil = Date.now() + 60_000;
    while (alive(state.parentPid) && Date.now() < waitUntil) await sleep(100);
    if (alive(state.parentPid)) {
      writeResult({ success: false, kind: 'parent-still-running', targetVersion: state.targetVersion, prefix: state.prefix, completedAt: Date.now() });
      return;
    }

    const installArgs = ['install', '-g', 'aiden-runtime@' + state.targetVersion];
    let command = state.npmExecutable;
    let args = installArgs;
    const options = { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    if (/\.(cmd|bat)$/i.test(command)) {
      const line = '"' + [command, ...installArgs].map(escapeCmdArg).join(' ') + '"';
      command = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', line];
      options.windowsVerbatimArguments = true;
    }

    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 1_000_000) stderr += chunk.toString(); });
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      child.once('error', (error) => finish({ code: -1, error }));
      child.once('close', (code) => finish({ code: code == null ? -1 : code }));
      const timer = setTimeout(() => {
        try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 }); } catch {
          try { child.kill('SIGKILL'); } catch {}
        }
        finish({ code: -1, timeout: true });
      }, state.timeoutMs);
    });

    if (outcome.timeout) {
      writeResult({ success: false, kind: 'timeout', targetVersion: state.targetVersion, prefix: state.prefix, completedAt: Date.now() });
      return;
    }
    if (outcome.code !== 0) {
      const kind = outcome.error && outcome.error.code === 'ENOENT'
        ? 'npm-unavailable'
        : classify(stderr + '\n' + stdout);
      writeResult({ success: false, kind, targetVersion: state.targetVersion, prefix: state.prefix, completedAt: Date.now() });
      return;
    }

    let installed = null;
    try {
      installed = JSON.parse(fs.readFileSync(path.join(state.packagePath, 'package.json'), 'utf8')).version;
    } catch {}
    if (installed !== state.targetVersion) {
      writeResult({ success: false, kind: 'verification', targetVersion: state.targetVersion, prefix: state.prefix, completedAt: Date.now() });
      return;
    }
    writeResult({ success: true, kind: 'complete', targetVersion: state.targetVersion, prefix: state.prefix, completedAt: Date.now() });
  } catch {
    try {
      writeResult({ success: false, kind: 'helper-failure', targetVersion: state.targetVersion, prefix: state.prefix, completedAt: Date.now() });
    } catch {}
  } finally {
    cleanup();
  }
})();
`.trimStart();

export async function prepareWindowsUpdateHelper(
  options: PrepareWindowsUpdateOptions,
): Promise<PreparedWindowsUpdate> {
  if (
    !options.plan.installAllowed ||
    !options.plan.npmExecutable ||
    !options.plan.packagePath ||
    !options.plan.prefix
  ) {
    throw new Error('Windows updater helper requires a verified npm-global install plan.');
  }
  await fs.mkdir(options.stateDir, { recursive: true });
  const helperPath = path.join(options.stateDir, HELPER_FILE);
  const statePath = path.join(options.stateDir, STATE_FILE);
  const resultPath = path.join(options.stateDir, RESULT_FILE);
  const state = {
    parentPid: options.parentPid ?? process.pid,
    npmExecutable: options.plan.npmExecutable,
    packagePath: options.plan.packagePath,
    prefix: options.plan.prefix,
    targetVersion: options.plan.targetVersion,
    timeoutMs: options.timeoutMs ?? 90_000,
    resultPath,
  };
  await fs.writeFile(helperPath, HELPER_SOURCE, 'utf8');
  await fs.writeFile(`${statePath}.tmp`, JSON.stringify(state), 'utf8');
  await fs.rename(`${statePath}.tmp`, statePath);

  const spawn = options.spawnImpl ?? defaultSpawn;
  const child = spawn(
    options.nodeExecutable ?? process.execPath,
    [helperPath, statePath],
    {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
  return { scheduled: true, helperPath, statePath, resultPath };
}

export async function consumeWindowsUpdateResult(
  stateDir: string,
): Promise<WindowsUpdateResult | null> {
  const resultPath = path.join(stateDir, RESULT_FILE);
  try {
    const parsed = JSON.parse(await fs.readFile(resultPath, 'utf8')) as Record<string, unknown>;
    await fs.unlink(resultPath);
    if (
      typeof parsed.success !== 'boolean' ||
      typeof parsed.kind !== 'string' ||
      typeof parsed.targetVersion !== 'string' ||
      typeof parsed.completedAt !== 'number'
    ) return null;
    return {
      success: parsed.success,
      kind: parsed.kind,
      targetVersion: parsed.targetVersion,
      prefix: typeof parsed.prefix === 'string' ? parsed.prefix : undefined,
      completedAt: parsed.completedAt,
    };
  } catch {
    return null;
  }
}
