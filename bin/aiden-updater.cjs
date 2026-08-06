#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function isExactVersion(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function withActiveNodeOnPath(env, nodeExecutable) {
  const next = { ...env };
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const existing = typeof next[pathKey] === 'string' ? next[pathKey] : '';
  next[pathKey] = [path.dirname(nodeExecutable), existing].filter(Boolean).join(path.delimiter);
  return next;
}

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function classifyInstallFailure(text, code) {
  const value = String(text || '').toLowerCase();
  if (code === 'ENOENT') return 'npm-unavailable';
  if (/(eacces|eperm|permission denied|operation not permitted|access is denied)/.test(value)) return 'permission';
  if (/(etarget|no matching version|version not found)/.test(value)) return 'version-not-found';
  if (/(econnreset|econnrefused|enotfound|etimedout|network request|socket hang up|dns lookup failed)/.test(value)) return 'network';
  if (/(node-gyp|gyp err!|prebuild-install|native build|build failed)/.test(value)) return 'native-build';
  if (/(registry|http (401|403|404|429|5\d\d)|npm err! code e40[134])/.test(value)) return 'registry';
  return 'package-manager';
}

function requiresBootstrap(version) {
  if (!isExactVersion(version)) return true;
  const core = version.split('-')[0].split('.').map(Number);
  if (core[0] !== 4) return core[0] > 4;
  if (core[1] !== 19) return core[1] > 19;
  return core[2] >= 1;
}

function createRenderer(options = {}) {
  const output = options.output || process.stdout;
  const tty = options.tty !== undefined ? options.tty : Boolean(output.isTTY);
  const color = options.color !== undefined ? options.color : Boolean(tty && !process.env.NO_COLOR);
  const animated = Boolean(tty && color && options.motion !== false && process.env.AIDEN_REDUCED_MOTION !== '1');
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let timer = null;
  let index = 0;
  let active = false;
  let label = '';
  let lastSettled = null;
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const clear = () => {
    if (animated) output.write('\r\x1b[2K');
  };
  const draw = () => {
    if (!active || !animated) return;
    clear();
    output.write(`${paint('38;5;208', frames[index % frames.length])} ${label}`);
    index += 1;
  };
  return {
    start(nextLabel) {
      this.stop(false);
      label = nextLabel;
      lastSettled = null;
      active = true;
      if (!animated) {
        output.write(`${nextLabel}\n`);
        return;
      }
      draw();
      timer = setInterval(draw, 90);
    },
    settle(nextLabel, success = true) {
      this.stop(false);
      if (lastSettled === nextLabel) return;
      lastSettled = nextLabel;
      output.write(`${paint(success ? '32' : '31', success ? '✓' : '×')} ${nextLabel}\n`);
    },
    stop(restore = true) {
      if (timer) clearInterval(timer);
      timer = null;
      if (active && animated) clear();
      active = false;
      if (restore && animated) output.write('\x1b[?25h');
    },
    hasTimer() { return timer !== null; },
  };
}

function runChild(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = (options.spawnImpl || spawn)(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const limit = options.outputLimit || 1_000_000;
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < limit) stdout += chunk.toString().slice(0, limit - stdout.length);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < limit) stderr += chunk.toString().slice(0, limit - stderr.length);
    });
    let timer = null;
    let settled = false;
    const terminate = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
        } else {
          child.kill('SIGTERM');
        }
      } catch {}
    };
    const onAbort = () => terminate();
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      resolve({ ...value, stdout, stderr, child });
    };
    child.once('error', (error) => finish({ code: -1, error }));
    child.once('exit', (code, signal) => finish({ code: code ?? (signal ? -1 : 0), signal }));
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        terminate();
        finish({ code: -1, timeout: true });
      }, options.timeoutMs);
    }
  });
}

function verifyFiles(state) {
  const manifest = safeReadJson(path.join(state.packagePath, 'package.json'));
  if (!manifest || manifest.name !== state.packageName || manifest.version !== state.targetVersion) {
    return { ok: false, kind: 'version-verification' };
  }
  const required = [
    path.join(state.packagePath, 'dist', 'cli', 'v4', 'aidenCLI.js'),
    path.join(state.packagePath, 'dist', 'core', 'version.js'),
  ];
  if (requiresBootstrap(state.targetVersion)) {
    required.push(
      path.join(state.packagePath, 'bin', 'aiden-bootstrap.cjs'),
      path.join(state.packagePath, 'bin', 'aiden-updater.cjs'),
    );
  }
  if (required.some((file) => !fs.existsSync(file))) return { ok: false, kind: 'file-verification' };
  return { ok: true, manifest };
}

async function verifyInstalledPackage(state) {
  const files = verifyFiles(state);
  if (!files.ok) return files;
  const bootstrap = path.join(state.packagePath, 'bin', 'aiden-bootstrap.cjs');
  const realCli = path.join(state.packagePath, 'dist', 'cli', 'v4', 'aidenCLI.js');
  const commandEntry = fs.existsSync(bootstrap) ? bootstrap : realCli;
  const versionResult = await runChild(state.nodeExecutable, [commandEntry, '--version'], {
    env: { ...process.env, AIDEN_BOOTSTRAP_SKIP_UPDATE: '1', AIDEN_NO_UPDATE_CHECK: '1' },
    timeoutMs: 20_000,
  });
  if (versionResult.code !== 0 || versionResult.stdout.trim() !== state.targetVersion) {
    return { ok: false, kind: 'command-verification', detail: versionResult.stderr };
  }
  const nativeRoot = path.join(state.packagePath, 'node_modules', 'better-sqlite3');
  const nativeScript = [
    "const Database=require(process.argv[1]);",
    "const db=new Database(':memory:');",
    "db.prepare('select 1 as ok').get();",
    'db.close();',
  ].join('');
  const nativeResult = await runChild(state.nodeExecutable, ['-e', nativeScript, nativeRoot], {
    env: { ...process.env, AIDEN_BOOTSTRAP_SKIP_UPDATE: '1', AIDEN_NO_UPDATE_CHECK: '1' },
    timeoutMs: 20_000,
  });
  if (nativeResult.code !== 0) {
    return { ok: false, kind: 'native-verification', detail: nativeResult.stderr };
  }
  return { ok: true };
}

async function installVersion(state, version, options = {}) {
  if (!isExactVersion(version)) return { ok: false, kind: 'invalid-version' };
  const args = [
    state.npmCli,
    'install',
    '--global',
    '--prefix',
    state.prefix,
    `${state.packageName}@${version}`,
    '--no-audit',
    '--no-fund',
  ];
  const outcome = await runChild(state.nodeExecutable, args, {
    env: withActiveNodeOnPath(
      { ...process.env, ...options.env, AIDEN_BOOTSTRAP_SKIP_UPDATE: '1' },
      state.nodeExecutable,
    ),
    timeoutMs: 180_000,
    signal: options.signal,
  });
  if (outcome.timeout) return { ok: false, kind: 'timeout', detail: outcome.stderr };
  if (outcome.code !== 0) {
    return {
      ok: false,
      kind: classifyInstallFailure(`${outcome.stderr}\n${outcome.stdout}`, outcome.error?.code),
      detail: outcome.stderr,
    };
  }
  return { ok: true };
}

function repairText(state) {
  return [
    'Aiden could not complete the update.',
    '',
    'Your workspaces, settings and history were not deleted.',
    '',
    'Repair:',
    'npm uninstall -g aiden-runtime',
    'npm install -g aiden-runtime@latest',
    '',
  ].join('\n');
}

async function runUpdater(state, options = {}) {
  const output = options.output || process.stdout;
  const renderer = options.renderer || createRenderer({ output, tty: state.tty, color: state.color });
  const install = options.installVersion || installVersion;
  const verify = options.verifyInstalledPackage || verifyInstalledPackage;
  let interrupted = false;
  const controller = new AbortController();
  const onInterrupt = () => {
    interrupted = true;
    controller.abort();
    renderer.stop();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  const restorePrevious = async () => {
    output.write('Attempting to restore the previous public version...\n');
    const restored = await install(state, state.previousVersion, { signal: controller.signal });
    const restoredVerification = restored.ok
      ? await verify({ ...state, targetVersion: state.previousVersion })
      : { ok: false };
    if (restored.ok && restoredVerification.ok) {
      output.write(`✓ Aiden ${state.previousVersion} was restored and verified.\n`);
      return true;
    }
    output.write('The previous version could not be verified.\n');
    return false;
  };
  try {
    if (!isExactVersion(state.targetVersion) || !isExactVersion(state.previousVersion)) {
      renderer.settle('Update request rejected.', false);
      return 2;
    }
    output.write(`\nUpdating Aiden to v${state.targetVersion}...\n\n`);
    renderer.start('Checking installation');
    if (!fs.existsSync(state.npmCli) || !fs.existsSync(state.nodeExecutable)) {
      renderer.settle('Checking failed', false);
      output.write(repairText(state));
      return 1;
    }
    renderer.settle('Checking complete');
    if (interrupted) return 130;

    renderer.start('Installing package');
    const installed = await install(state, state.targetVersion, { signal: controller.signal });
    if (!installed.ok || interrupted) {
      renderer.settle(interrupted ? 'Update cancelled' : `Installation failed (${installed.kind})`, false);
      if (!interrupted) {
        await restorePrevious();
        output.write(repairText(state));
      }
      return interrupted ? 130 : 1;
    }
    renderer.settle('Installation complete');

    renderer.start('Verifying installation');
    const verified = await verify(state);
    if (!verified.ok || interrupted) {
      renderer.settle(interrupted ? 'Update cancelled' : `Verification failed (${verified.kind})`, false);
      if (!interrupted) {
        await restorePrevious();
        output.write(repairText(state));
      }
      return interrupted ? 130 : 1;
    }
    renderer.settle('Verification complete');
    output.write([
      '',
      '✓ Aiden was updated successfully',
      `✓ Installed version: ${state.targetVersion}`,
      '✓ Installation verified',
      '',
      'Restart Aiden to use the updated version:',
      '',
      'aiden',
      '',
    ].join('\n'));
    return 0;
  } finally {
    renderer.stop();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}

function cleanupTemporary(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

module.exports = {
  classifyInstallFailure,
  createRenderer,
  installVersion,
  isExactVersion,
  requiresBootstrap,
  runChild,
  runUpdater,
  verifyFiles,
  verifyInstalledPackage,
  withActiveNodeOnPath,
};

if (require.main === module) {
  const statePath = process.argv[2];
  const state = statePath ? safeReadJson(statePath) : null;
  if (!state || !state.tempDir || path.dirname(statePath) !== state.tempDir) {
    process.stderr.write('Aiden update state is invalid. No installation was changed.\n');
    process.exitCode = 2;
  } else {
    runUpdater(state).then(
      (code) => {
        process.exitCode = code;
        cleanupTemporary(state.tempDir);
      },
      () => {
        process.stderr.write(repairText(state));
        process.exitCode = 1;
        cleanupTemporary(state.tempDir);
      },
    );
  }
}
