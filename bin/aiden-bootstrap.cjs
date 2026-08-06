#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PACKAGE_NAME = 'aiden-runtime';
const SUPPORTED_NODE_MAJORS = Object.freeze([20, 22]);
const DEFAULT_CHANNEL = 'stable';
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REMIND_DELAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NETWORK_TIMEOUT_MS = 2_000;
const REAL_CLI = path.join('dist', 'cli', 'v4', 'aidenCLI.js');
const REQUIRED_RUNTIME = path.join('dist', 'core', 'version.js');
const STATE_FILE = '.update_check.json';
const REGISTRY_URL = 'https://registry.npmjs.org/aiden-runtime';

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    raw: value.trim(),
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Invalid semantic version.');
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const av = a.prerelease[i];
    const bv = b.prerelease[i];
    if (av === bv) continue;
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) return an - bn;
    if (an !== null) return -1;
    if (bn !== null) return 1;
    return av.localeCompare(bv);
  }
  return 0;
}

function resolveAidenDataRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (typeof env.AIDEN_HOME === 'string' && env.AIDEN_HOME.trim()) {
    return path.resolve(stripOuterQuotes(env.AIDEN_HOME.trim()));
  }
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'aiden');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'aiden');
  }
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? path.resolve(stripOuterQuotes(env.XDG_CONFIG_HOME.trim()))
    : path.join(home, '.config');
  const preferred = path.join(xdg, 'aiden');
  const legacy = path.join(home, '.aiden');
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(preferred)) return legacy;
  } catch {}
  return preferred;
}

function stripOuterQuotes(value) {
  return value.replace(/^["']+/, '').replace(/["']+$/, '').trim();
}

function checkPackageHealth(options) {
  const packageRoot = options.packageRoot;
  const nodeVersion = options.nodeVersion || process.versions.node;
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!SUPPORTED_NODE_MAJORS.includes(major)) {
    return { ok: false, kind: 'unsupported-node' };
  }
  if (!packageRoot || !fs.existsSync(packageRoot)) {
    return { ok: false, kind: 'missing-package' };
  }
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, kind: 'missing-package-json' };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, kind: 'malformed-package' };
  }
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string' || !parseVersion(manifest.version)) {
    return { ok: false, kind: 'inconsistent-package', version: manifest.version };
  }
  if (!fs.existsSync(path.join(packageRoot, REAL_CLI))) {
    return { ok: false, kind: 'missing-cli', version: manifest.version };
  }
  if (!fs.existsSync(path.join(packageRoot, REQUIRED_RUNTIME))) {
    return { ok: false, kind: 'missing-runtime', version: manifest.version };
  }
  if (!fs.existsSync(path.join(packageRoot, 'bin', 'aiden-updater.cjs'))) {
    return { ok: false, kind: 'missing-updater', version: manifest.version };
  }
  return { ok: true, version: manifest.version };
}

function valueToDiagnostic(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (value && typeof value === 'object') {
    const code = typeof value.code === 'string' ? value.code : '';
    const message = typeof value.message === 'string' ? value.message : String(value);
    return `${code}\n${message}`;
  }
  return String(value || '');
}

function classifyStartupFailure(value) {
  const text = valueToDiagnostic(value);
  const abi = text.match(/NODE_MODULE_VERSION\s+(\d+)[\s\S]*?(?:requires|using)\s+NODE_MODULE_VERSION\s+(\d+)/i);
  if (abi) {
    return { kind: 'native-abi', installedAbi: abi[1], requiredAbi: abi[2] };
  }
  const reverseAbi = text.match(/requires\s+NODE_MODULE_VERSION\s+(\d+)[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/i);
  if (reverseAbi) {
    return { kind: 'native-abi', installedAbi: reverseAbi[2], requiredAbi: reverseAbi[1] };
  }
  if (/\bERR_DLOPEN_FAILED\b|invalid win32 application|wrong elf class|file too short|bad native image/i.test(text)) {
    return { kind: 'native-load' };
  }
  if (/\bMODULE_NOT_FOUND\b|\bERR_MODULE_NOT_FOUND\b|cannot find module|cannot find package/i.test(text)) {
    return { kind: 'missing-module' };
  }
  return { kind: 'unknown' };
}

function diagnosticId(detail) {
  return crypto.createHash('sha256').update(String(detail || 'unknown')).digest('hex').slice(0, 10).toUpperCase();
}

function formatStartupFailure(failure, context, options = {}) {
  const repair = [
    'Repair Aiden using the currently active Node version:',
    '',
    'npm uninstall -g aiden-runtime',
    'npm install -g aiden-runtime@latest',
    '',
    'Your Aiden workspaces, settings and history will not be deleted.',
  ];
  let lines;
  if (failure.kind === 'unsupported-node') {
    lines = [
      'Aiden cannot start with this Node version.',
      '',
      `Current runtime: Node ${context.nodeVersion} · ABI ${context.nodeAbi}`,
      'Supported runtimes: Node 20 and Node 22',
      '',
      'Switch to Node 20 or Node 22, then reinstall Aiden with that active Node version:',
      '',
      'npm uninstall -g aiden-runtime',
      'npm install -g aiden-runtime@latest',
    ];
  } else if (failure.kind === 'native-abi') {
    lines = [
      'Aiden was installed using a different Node version.',
      '',
      `Installed version: ${context.installedVersion || 'unknown'}`,
      `Current runtime:   Node ${context.nodeVersion} · ABI ${context.nodeAbi}`,
      failure.installedAbi ? `Installed native module: ABI ${failure.installedAbi}` : '',
      '',
      ...repair,
    ].filter(Boolean);
  } else if (failure.kind === 'native-load') {
    lines = [
      'Aiden could not load a required native component.',
      '',
      `Installed version: ${context.installedVersion || 'unknown'}`,
      `Current runtime:   Node ${context.nodeVersion} · ABI ${context.nodeAbi}`,
      '',
      ...repair,
    ];
  } else if (failure.kind === 'missing-cli' || failure.kind === 'missing-runtime' || failure.kind === 'missing-updater' || failure.kind === 'missing-package' || failure.kind === 'missing-package-json' || failure.kind === 'malformed-package' || failure.kind === 'inconsistent-package' || failure.kind === 'missing-module') {
    lines = [
      'Aiden could not start because its installation is incomplete.',
      '',
      `Installed version: ${context.installedVersion || 'unknown'}`,
      `Node version:      ${context.nodeVersion}`,
      '',
      ...repair,
    ];
  } else {
    const id = diagnosticId(options.detail);
    lines = [
      'Aiden could not complete startup.',
      '',
      `Diagnostic: ${id}`,
      `Installed version: ${context.installedVersion || 'unknown'}`,
      `Node version:      ${context.nodeVersion}`,
      '',
      'Run `aiden doctor` after repairing the installation, or retry with AIDEN_BOOTSTRAP_DEBUG=1 for technical details.',
    ];
  }
  if (options.debug && options.detail) {
    lines.push('', 'Technical details:', String(options.detail));
  }
  return `${lines.join('\n')}\n`;
}

function normalizeUpdateState(value) {
  const input = value && typeof value === 'object' ? value : {};
  const channel = input.channel === 'beta' || input.channel === 'off' || input.channel === 'stable'
    ? input.channel
    : DEFAULT_CHANNEL;
  return {
    ...input,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : channel !== 'off',
    channel,
    ts: Number.isFinite(input.ts) ? input.ts : 0,
    latest: typeof input.latest === 'string' ? input.latest : null,
    beta: typeof input.beta === 'string' ? input.beta : null,
    installed: typeof input.installed === 'string' ? input.installed : '',
    skippedVersion: typeof input.skippedVersion === 'string' ? input.skippedVersion : undefined,
    remindAfter: Number.isFinite(input.remindAfter) ? input.remindAfter : undefined,
  };
}

function readUpdateState(file) {
  try {
    return normalizeUpdateState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeUpdateState(null);
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function selectUpdateCandidate(options) {
  if (options.channel === 'off') return null;
  const candidate = options.channel === 'beta' ? options.beta : options.latest;
  if (!candidate || !parseVersion(candidate)) return null;
  const parsed = parseVersion(candidate);
  if (options.channel === 'stable' && parsed.prerelease.length > 0) return null;
  return compareVersions(candidate, options.installed) > 0 ? candidate : null;
}

function shouldOfferUpdate(options) {
  if (!options.candidate || !parseVersion(options.candidate)) return false;
  if (compareVersions(options.candidate, options.installed) <= 0) return false;
  const state = normalizeUpdateState(options.state);
  if (!state.enabled || state.channel === 'off') return false;
  if (state.skippedVersion === options.candidate) return false;
  if (state.remindAfter && options.now < state.remindAfter) return false;
  return true;
}

function parseUpdateArgs(args) {
  if (args[0] !== 'update') return { mode: 'none', assumeYes: false };
  let mode = 'install';
  let assumeYes = false;
  let version;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--check') mode = 'check';
    else if (arg === '--yes' || arg === '-y') assumeYes = true;
    else if (arg === '--version') {
      version = args[i + 1];
      i += 1;
      if (!parseVersion(version)) return { mode, assumeYes, error: 'A valid exact version is required.' };
    } else {
      return { mode, assumeYes, error: `Unknown update option: ${arg}` };
    }
  }
  return { mode, assumeYes, ...(version ? { version } : {}) };
}

function requestJson(url, timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : https;
    let deadline = null;
    const request = transport.get(parsed, {
      headers: { Accept: 'application/json', 'User-Agent': 'aiden-runtime bootstrap' },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Registry returned HTTP ${response.statusCode || 0}.`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 1_000_000) body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Registry returned invalid JSON.'));
        }
      });
    });
    deadline = setTimeout(() => request.destroy(new Error('Registry request timed out.')), timeoutMs);
    request.once('close', () => {
      if (deadline) clearTimeout(deadline);
      deadline = null;
    });
    request.on('error', reject);
  });
}

async function checkRegistry(options) {
  const state = readUpdateState(options.stateFile);
  if (options.env.AIDEN_UPDATE_CHANNEL === 'stable' || options.env.AIDEN_UPDATE_CHANNEL === 'beta' || options.env.AIDEN_UPDATE_CHANNEL === 'off') {
    state.channel = options.env.AIDEN_UPDATE_CHANNEL;
    state.enabled = state.channel !== 'off';
  }
  const now = typeof options.now === 'function'
    ? options.now()
    : (Number.isFinite(options.now) ? options.now : Date.now());
  const interval = options.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS;
  const force = options.force === true;
  if (!state.enabled || state.channel === 'off' || options.env.AIDEN_NO_UPDATE_CHECK === '1') {
    return { state, candidate: null, checked: false, offline: false };
  }
  if (!force && state.ts > 0 && now - state.ts < interval && state.installed === options.installed) {
    return {
      state,
      candidate: selectUpdateCandidate({ installed: options.installed, latest: state.latest, beta: state.beta, channel: state.channel }),
      checked: false,
      offline: false,
    };
  }
  try {
    const metadata = await requestJson(options.registryUrl || REGISTRY_URL, options.timeoutMs || DEFAULT_NETWORK_TIMEOUT_MS);
    const tags = metadata && typeof metadata === 'object' && metadata['dist-tags'] && typeof metadata['dist-tags'] === 'object'
      ? metadata['dist-tags']
      : {};
    const next = normalizeUpdateState({
      ...state,
      ts: now,
      installed: options.installed,
      latest: typeof tags.latest === 'string' ? tags.latest : null,
      beta: typeof tags.beta === 'string' ? tags.beta : null,
    });
    try { atomicWriteJson(options.stateFile, next); } catch {}
    return {
      state: next,
      candidate: selectUpdateCandidate({ installed: options.installed, latest: next.latest, beta: next.beta, channel: next.channel }),
      checked: true,
      offline: false,
      versions: metadata.versions && typeof metadata.versions === 'object' ? Object.keys(metadata.versions) : [],
    };
  } catch (error) {
    const next = normalizeUpdateState({
      ...state,
      ts: now,
      installed: options.installed,
    });
    try { atomicWriteJson(options.stateFile, next); } catch {}
    return { state: next, candidate: null, checked: true, offline: true, error: error.message };
  }
}

function renderUpdateOffer(installed, candidate) {
  return [
    '',
    'A new Aiden update is available',
    '',
    `Current version: ${installed}`,
    `New version:     ${candidate}`,
    '',
    "What's new:",
    '- Reliable startup and repair guidance',
    '- Built-in updates',
    '- Improved Node compatibility diagnostics',
    '',
    '[U] Update now',
    '[L] Later',
    '[S] Skip this version',
    '',
  ].join('\n');
}

function promptForUpdate(options) {
  if (!options.stdin.isTTY || !options.stdout.isTTY) return Promise.resolve('later');
  options.stdout.write(renderUpdateOffer(options.installed, options.candidate));
  const stdin = options.stdin;
  const wasRaw = stdin.isRaw === true;
  const wasPaused = typeof stdin.isPaused === 'function' ? stdin.isPaused() : false;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('close', onEnd);
      try { if (!wasRaw && stdin.setRawMode) stdin.setRawMode(false); } catch {}
      try { if (stdin.pause) stdin.pause(); } catch {}
      resolve(choice);
    };
    const onData = (chunk) => {
      const key = String(chunk || '').trim().toLowerCase();
      if (key === '\u0003') finish('cancel');
      else if (key === 'u') finish('update');
      else if (key === 's') finish('skip');
      else finish('later');
    };
    const onEnd = () => finish('later');
    try {
      if (!wasRaw && stdin.setRawMode) stdin.setRawMode(true);
      if (wasPaused && stdin.resume) stdin.resume();
      stdin.on('data', onData);
      stdin.once('end', onEnd);
      stdin.once('close', onEnd);
    } catch {
      finish('later');
      return;
    }
    timer = setTimeout(() => finish('later'), options.timeoutMs || 8_000);
    if (timer.unref) timer.unref();
  });
}

function findNpmCli(nodeExecutable = process.execPath, env = process.env) {
  const candidates = [];
  if (typeof env.npm_execpath === 'string') candidates.push(env.npm_execpath);
  const nodeDir = path.dirname(nodeExecutable);
  candidates.push(
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );
  for (const candidate of candidates) {
    try {
      if (path.basename(candidate).toLowerCase() === 'npm-cli.js' && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

function runNpmQuery(nodeExecutable, npmCli, args, env) {
  const result = spawnSync(nodeExecutable, [npmCli, ...args], {
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim().split(/\r?\n/).pop();
  return value || null;
}

function inferOwningPrefix(packageRoot, platform = process.platform) {
  if (!packageRoot) return null;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const modulesRoot = pathApi.dirname(packageRoot);
  if (pathApi.basename(modulesRoot).toLowerCase() !== 'node_modules') return null;
  const parent = pathApi.dirname(modulesRoot);
  if (platform !== 'win32' && pathApi.basename(parent) === 'lib') return pathApi.dirname(parent);
  return parent;
}

function readInstallReceipt(packageRoot) {
  if (!packageRoot) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(packageRoot, '.aiden-install.json'), 'utf8'));
    if (!receipt || receipt.schemaVersion !== 1) return null;
    return receipt;
  } catch {
    return null;
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveNpmEnvironment(options = {}) {
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const env = options.env || process.env;
  const npmCli = findNpmCli(nodeExecutable, env);
  if (!npmCli) return { ok: false, reason: 'npm-unavailable', nodeExecutable };
  if (env.npm_command === 'exec' || /[\\/]_npx[\\/]/i.test(options.packageRoot || '')) {
    return { ok: false, reason: 'temporary-package-runner', nodeExecutable, npmCli };
  }
  const configuredPrefix = runNpmQuery(nodeExecutable, npmCli, ['prefix', '-g'], env);
  const configuredRoot = runNpmQuery(nodeExecutable, npmCli, ['root', '-g'], env);
  const receipt = readInstallReceipt(options.packageRoot);
  if (receipt && receipt.global === false) {
    return { ok: false, reason: 'local-install', nodeExecutable, npmCli };
  }
  const recordedPrefix = typeof receipt?.prefix === 'string' && receipt.prefix.trim()
    ? path.resolve(receipt.prefix)
    : null;
  const inferredPrefix = inferOwningPrefix(options.packageRoot);
  const globalRoot = options.packageRoot ? path.dirname(options.packageRoot) : configuredRoot;
  const packagePath = options.packageRoot || (globalRoot ? path.join(globalRoot, PACKAGE_NAME) : null);
  if (recordedPrefix && packagePath && !isInside(recordedPrefix, packagePath)) {
    return { ok: false, reason: 'install-receipt-mismatch', nodeExecutable, npmCli };
  }
  if (
    options.packageRoot &&
    !receipt &&
    configuredRoot &&
    path.resolve(configuredRoot) !== path.resolve(globalRoot)
  ) {
    return { ok: false, reason: 'unverified-install-prefix', nodeExecutable, npmCli };
  }
  const prefix = recordedPrefix || inferredPrefix || configuredPrefix;
  if (!prefix || !globalRoot || !packagePath) {
    return { ok: false, reason: 'npm-environment', nodeExecutable, npmCli };
  }
  return { ok: true, nodeExecutable, npmCli, prefix, globalRoot, packagePath };
}

function scheduleUpdater(options) {
  const source = path.join(options.packageRoot, 'bin', 'aiden-updater.cjs');
  if (!fs.existsSync(source)) throw new Error('The packaged update helper is missing.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-update-'));
  const helper = path.join(directory, 'aiden-updater.cjs');
  const statePath = path.join(directory, 'state.json');
  fs.copyFileSync(source, helper);
  atomicWriteJson(statePath, {
    targetVersion: options.targetVersion,
    previousVersion: options.previousVersion,
    packageName: PACKAGE_NAME,
    nodeExecutable: options.npmEnvironment.nodeExecutable,
    npmCli: options.npmEnvironment.npmCli,
    prefix: options.npmEnvironment.prefix,
    globalRoot: options.npmEnvironment.globalRoot,
    packagePath: options.npmEnvironment.packagePath,
    tempDir: directory,
    tty: Boolean(process.stdout.isTTY),
    color: Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
  });
  const child = spawn(options.npmEnvironment.nodeExecutable, [helper, statePath], {
    stdio: 'inherit',
    env: { ...process.env, AIDEN_BOOTSTRAP_SKIP_UPDATE: '1' },
    shell: false,
    windowsHide: false,
  });
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

async function handleUpdateCommand(options) {
  const parsed = parseUpdateArgs(options.args);
  if (parsed.error) {
    options.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const status = await checkRegistry({
    stateFile: options.stateFile,
    installed: options.installed,
    env: options.env,
    force: true,
    registryUrl: options.env.AIDEN_UPDATE_REGISTRY_URL,
  });
  if (status.offline) {
    options.stderr.write('Aiden could not reach the package registry. The current installation was not changed.\n');
    return 1;
  }
  if (parsed.mode === 'check') {
    options.stdout.write(`Installed: ${options.installed}\nLatest:    ${status.state.latest || 'unknown'}\n`);
    if (status.candidate) options.stdout.write(`Update available: ${status.candidate}\n`);
    else options.stdout.write('Aiden is up to date.\n');
    return 0;
  }
  let target = parsed.version || status.candidate;
  if (!target) {
    options.stdout.write('Aiden is up to date.\n');
    return 0;
  }
  const targetParsed = parseVersion(target);
  if (!targetParsed || (status.state.channel === 'stable' && targetParsed.prerelease.length > 0)) {
    options.stderr.write('The requested version is not valid for the configured update channel.\n');
    return 2;
  }
  if (Array.isArray(status.versions) && status.versions.length > 0 && !status.versions.includes(target)) {
    options.stderr.write(`aiden-runtime ${target} is not available from the configured registry.\n`);
    return 1;
  }
  if (!parsed.assumeYes) {
    if (!options.stdin.isTTY || !options.stdout.isTTY) {
      options.stderr.write('Use `aiden update --yes` for a non-interactive installation.\n');
      return 2;
    }
    const choice = await promptForUpdate({ stdin: options.stdin, stdout: options.stdout, installed: options.installed, candidate: target });
    if (choice === 'cancel') return 130;
    if (choice !== 'update') return 0;
  }
  const npmEnvironment = resolveNpmEnvironment({ env: options.env, packageRoot: options.packageRoot });
  if (!npmEnvironment.ok) {
    options.stderr.write('Aiden could not locate npm for the active Node installation. No update was installed.\n');
    return 1;
  }
  const result = await scheduleUpdater({
    packageRoot: options.packageRoot,
    targetVersion: target,
    previousVersion: options.installed,
    npmEnvironment,
  });
  return result.code;
}

function spawnRealCli(options) {
  return new Promise((resolve) => {
    const child = spawn(options.nodeExecutable || process.execPath, [options.cliPath, ...options.args], {
      cwd: options.cwd || process.cwd(),
      env: { ...options.env, AIDEN_BOOTSTRAP_UPDATE_CHECKED: '1' },
      stdio: ['inherit', 'inherit', 'pipe', 'ipc'],
      shell: false,
      windowsHide: false,
    });
    let ready = false;
    let buffered = '';
    const limit = 512 * 1024;
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (ready) process.stderr.write(text);
      else if (buffered.length < limit) buffered += text.slice(0, limit - buffered.length);
    });
    child.on('message', (message) => {
      if (!message || message.type !== 'aiden-bootstrap-ready' || ready) return;
      ready = true;
      if (buffered) process.stderr.write(buffered);
      buffered = '';
    });
    child.once('error', (error) => resolve({ code: 1, ready, stderr: `${buffered}\n${valueToDiagnostic(error)}` }));
    child.once('exit', (code, signal) => {
      if (ready && buffered) process.stderr.write(buffered);
      resolve({ code: code ?? (signal ? 1 : 0), signal, ready, stderr: buffered });
    });
  });
}

async function runBootstrap(options = {}) {
  const packageRoot = options.packageRoot || path.resolve(__dirname, '..');
  const args = options.args || process.argv.slice(2);
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const context = { nodeVersion: process.versions.node, nodeAbi: process.versions.modules };
  const health = checkPackageHealth({ packageRoot, nodeVersion: context.nodeVersion, nodeAbi: context.nodeAbi });
  if (!health.ok) {
    stderr.write(formatStartupFailure({ kind: health.kind }, { ...context, installedVersion: health.version }, {
      debug: env.AIDEN_BOOTSTRAP_DEBUG === '1',
      detail: health.kind,
    }));
    return 1;
  }
  context.installedVersion = health.version;
  const dataRoot = resolveAidenDataRoot(env);
  const stateFile = path.join(dataRoot, STATE_FILE);
  const updateArgs = parseUpdateArgs(args);
  if (updateArgs.mode !== 'none') {
    return handleUpdateCommand({ args, env, stdin: options.stdin || process.stdin, stdout, stderr, packageRoot, stateFile, installed: health.version });
  }

  const interactiveStartup = args.length === 0 && (options.stdin || process.stdin).isTTY && stdout.isTTY;
  if (interactiveStartup && env.AIDEN_BOOTSTRAP_SKIP_UPDATE !== '1') {
    const status = await checkRegistry({
      stateFile,
      installed: health.version,
      env,
      force: false,
      registryUrl: env.AIDEN_UPDATE_REGISTRY_URL,
    });
    if (shouldOfferUpdate({ installed: health.version, candidate: status.candidate, state: status.state, now: Date.now() })) {
      const choice = await promptForUpdate({
        stdin: options.stdin || process.stdin,
        stdout,
        installed: health.version,
        candidate: status.candidate,
      });
      if (choice === 'skip') {
        try { atomicWriteJson(stateFile, { ...status.state, skippedVersion: status.candidate, remindAfter: undefined }); } catch {}
      } else if (choice === 'later') {
        try { atomicWriteJson(stateFile, { ...status.state, remindAfter: Date.now() + DEFAULT_REMIND_DELAY_MS }); } catch {}
      } else if (choice === 'update') {
        const npmEnvironment = resolveNpmEnvironment({ env, packageRoot });
        if (!npmEnvironment.ok) {
          stderr.write('Aiden could not locate npm for the active Node installation. Starting the current version.\n');
        } else {
          const result = await scheduleUpdater({ packageRoot, targetVersion: status.candidate, previousVersion: health.version, npmEnvironment });
          return result.code;
        }
      } else if (choice === 'cancel') {
        return 130;
      }
    }
  }

  const result = await spawnRealCli({
    cliPath: path.join(packageRoot, REAL_CLI),
    args,
    env,
    cwd: options.cwd || process.cwd(),
  });
  if (result.code !== 0 && !result.ready && result.stderr.trim()) {
    const failure = classifyStartupFailure(result.stderr);
    stderr.write(formatStartupFailure(failure, context, {
      debug: env.AIDEN_BOOTSTRAP_DEBUG === '1',
      detail: result.stderr,
    }));
  } else if (!result.ready && result.stderr) {
    stderr.write(result.stderr);
  }
  return result.code;
}

module.exports = {
  SUPPORTED_NODE_MAJORS,
  atomicWriteJson,
  checkPackageHealth,
  checkRegistry,
  classifyStartupFailure,
  compareVersions,
  findNpmCli,
  formatStartupFailure,
  handleUpdateCommand,
  normalizeUpdateState,
  inferOwningPrefix,
  readInstallReceipt,
  isInside,
  parseUpdateArgs,
  promptForUpdate,
  resolveAidenDataRoot,
  resolveNpmEnvironment,
  runBootstrap,
  scheduleUpdater,
  selectUpdateCandidate,
  shouldOfferUpdate,
  spawnRealCli,
};

if (require.main === module) {
  runBootstrap().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(formatStartupFailure(classifyStartupFailure(error), {
        nodeVersion: process.versions.node,
        nodeAbi: process.versions.modules,
      }, {
        debug: process.env.AIDEN_BOOTSTRAP_DEBUG === '1',
        detail: valueToDiagnostic(error),
      }));
      process.exitCode = 1;
    },
  );
}
