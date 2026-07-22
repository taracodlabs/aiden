'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const npmCli = process.env.AIDEN_TEST_NPM_CLI;
if (!npmCli) throw new Error('AIDEN_TEST_NPM_CLI is required.');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-token-package-'));
const packDir = path.join(tempRoot, 'pack');
const globalPrefix = path.join(tempRoot, 'global');
const localRoot = path.join(tempRoot, 'local');
const aidenHome = path.join(tempRoot, 'home');
const cwd = path.join(tempRoot, 'workspace');
const readyPath = path.join(tempRoot, 'provider-ready.txt');
const countPath = path.join(tempRoot, 'provider-count.txt');
const fixturePath = path.join(cwd, 'fixture.txt');
for (const directory of [packDir, globalPrefix, localRoot, aidenHome, cwd]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(fixturePath, 'packaged tool fixture\n', 'utf8');
fs.writeFileSync(path.join(aidenHome, '.onboarding-shown'), 'package-smoke\n', 'utf8');
fs.writeFileSync(path.join(aidenHome, 'config.yaml'), [
  'model:',
  '  provider: custom_openai',
  '  modelId: custom-default',
  'providers:',
  '  custom_openai:',
  '    apiKey: controlled-package-value',
  'display:',
  '  streaming: false',
  '  renderer: legacy',
].join('\n') + '\n', 'utf8');

const nodeEnvironment = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
};
const childEnvironment = {
  ...nodeEnvironment,
  AIDEN_HOME: aidenHome,
  CUSTOM_OPENAI_API_KEY: 'controlled-package-value',
  AIDEN_NO_UPDATE_CHECK: '1',
  TELEGRAM_BOT_TOKEN: '',
  FORCE_COLOR: '0',
  NO_COLOR: '1',
};

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? childEnvironment,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${path.basename(executable)} ${args.join(' ')} exited ${result.status}`,
      result.stdout,
      result.stderr,
    ].join('\n'));
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8').trim();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}

function assertContains(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label} did not contain ${JSON.stringify(expected)}:\n${actual}`);
  }
}

let provider;
try {
  provider = spawn(process.execPath, [path.join(__dirname, 'controlledProviderServer.cjs')], {
    env: {
      ...process.env,
      AIDEN_TEST_PROVIDER_READY: readyPath,
      AIDEN_TEST_PROVIDER_COUNT: countPath,
      AIDEN_TEST_TOOL_FIXTURE: fixturePath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let providerError = '';
  provider.stderr.on('data', (chunk) => { providerError += String(chunk); });
  const baseUrl = waitForFile(readyPath);

  const packed = run(process.execPath, [npmCli, 'pack', '--pack-destination', packDir], {
    env: nodeEnvironment,
    timeout: 300_000,
  });
  const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`Expected one tarball, found ${tarballs.length}.\n${packed.stdout}`);
  const tarball = path.join(packDir, tarballs[0]);

  run(process.execPath, [npmCli, 'install', '--global', '--prefix', globalPrefix, tarball, '--no-audit', '--no-fund'], {
    env: nodeEnvironment,
    timeout: 300_000,
  });
  const globalBin = path.join(globalPrefix, 'aiden-runtime.cmd');
  if (!fs.existsSync(globalBin)) throw new Error('Global package binary shim was not installed.');
  const globalRoot = globalPrefix;
  const globalEnv = {
    ...childEnvironment,
    AIDEN_TEST_INSTALLED_ROOT: globalRoot,
    AIDEN_TEST_PROVIDER_BASE_URL: baseUrl,
    AIDEN_TEST_PROVIDER_COUNT: countPath,
    NODE_OPTIONS: `--require=${path.join(__dirname, 'installedProviderPreload.cjs')}`,
  };
  const globalVersion = run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', globalBin, '--version'], {
    cwd,
    env: globalEnv,
  });
  assertContains(globalVersion.stdout, '4.15.0', 'global --version');
  const globalHelp = run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', globalBin, '--help'], {
    cwd,
    env: globalEnv,
  });
  assertContains(globalHelp.stdout, '--query', 'global --help');
  const simple = run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', globalBin, '-q', 'reply simply'], {
    cwd,
    env: globalEnv,
  });
  assertContains(simple.stdout, 'PACKAGED SIMPLE PASS', 'global plain turn');
  const tool = run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', globalBin, '-q', 'use a tool'], {
    cwd,
    env: globalEnv,
  });
  assertContains(tool.stdout, 'PACKAGED TOOL PASS', 'global tool turn');
  const restart = run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', globalBin, '-q', 'RESTART'], {
    cwd,
    env: globalEnv,
  });
  assertContains(restart.stdout, 'PACKAGED RESTART PASS', 'global restart turn');

  const interactive = run(process.execPath, [path.join(__dirname, 'packagedInteractiveTokenSmoke.cjs')], {
    cwd,
    env: {
      ...globalEnv,
      AIDEN_TEST_REPO_ROOT: repoRoot,
      AIDEN_TEST_PACKAGE_CWD: cwd,
    },
    timeout: 180_000,
  });
  assertContains(interactive.stdout, '"restartResume":"PASS"', 'global interactive usage/compression restart');

  run(process.execPath, [npmCli, 'install', '--prefix', localRoot, tarball, '--no-audit', '--no-fund'], {
    env: nodeEnvironment,
    timeout: 300_000,
  });
  const localEnv = {
    ...childEnvironment,
    AIDEN_TEST_INSTALLED_ROOT: localRoot,
    AIDEN_TEST_PROVIDER_BASE_URL: baseUrl,
    NODE_OPTIONS: `--require=${path.join(__dirname, 'installedProviderPreload.cjs')}`,
  };
  const localVersion = run(process.execPath, [npmCli, 'exec', '--prefix', localRoot, '--offline', '--', 'aiden-runtime', '--version'], {
    cwd,
    env: localEnv,
  });
  assertContains(localVersion.stdout, '4.15.0', 'local package runner --version');
  const localTurn = run(process.execPath, [npmCli, 'exec', '--prefix', localRoot, '--offline', '--', 'aiden-runtime', '-q', 'reply simply'], {
    cwd,
    env: localEnv,
  });
  assertContains(localTurn.stdout, 'PACKAGED SIMPLE PASS', 'local package runner turn');

  const callCount = Number.parseInt(fs.readFileSync(countPath, 'utf8'), 10);
  if (callCount !== 16) throw new Error(`Expected sixteen physical provider calls; received ${callCount}.`);
  const combinedOutput = [simple, tool, restart, interactive, localTurn]
    .flatMap((result) => [result.stdout, result.stderr])
    .join('\n');
  if (combinedOutput.includes('controlled-package-value')) {
    throw new Error('Credential sentinel leaked into package smoke output.');
  }

  const databasePath = path.join(aidenHome, 'sessions.db');
  if (!fs.existsSync(databasePath)) throw new Error('Packaged execution did not create sessions.db.');
  const Database = require(path.join(repoRoot, 'node_modules', 'better-sqlite3'));
  const database = new Database(databasePath, { readonly: true });
  const ledgerRows = database.prepare(
    "SELECT entry_point, status, COUNT(*) AS count FROM provider_attempts GROUP BY entry_point, status",
  ).all();
  const activeState = database.prepare(
    `SELECT messages_json, compression_count, cumulative_input_tokens, cumulative_output_tokens
       FROM session_active_state
      ORDER BY updated_at DESC
      LIMIT 1`,
  ).get();
  database.close();
  const successfulOneShot = ledgerRows.find(
    (row) => row.entry_point === 'oneshot' && row.status === 'success',
  );
  if (!successfulOneShot || successfulOneShot.count !== 5) {
    throw new Error(`Packaged ledger mismatch: ${JSON.stringify(ledgerRows)}`);
  }
  const successfulInteractive = ledgerRows.find(
    (row) => row.entry_point === 'cli' && row.status === 'success',
  );
  if (!successfulInteractive || successfulInteractive.count !== 10) {
    throw new Error(`Packaged interactive ledger mismatch: ${JSON.stringify(ledgerRows)}`);
  }
  const successfulAuxiliary = ledgerRows.find(
    (row) => row.entry_point === 'auxiliary' && row.status === 'success',
  );
  if (!successfulAuxiliary || successfulAuxiliary.count !== 1) {
    throw new Error(`Packaged compression ledger mismatch: ${JSON.stringify(ledgerRows)}`);
  }
  const restoredMessages = activeState ? JSON.parse(activeState.messages_json) : [];
  if (!activeState || activeState.compression_count !== 1
      || activeState.cumulative_input_tokens < 1_000
      || activeState.cumulative_output_tokens < 100
      || !Array.isArray(restoredMessages)
      || restoredMessages.length === 0) {
    throw new Error(`Packaged active-state restoration mismatch: ${JSON.stringify(activeState)}`);
  }

  process.stdout.write(JSON.stringify({
    package: path.basename(tarball),
    globalVersion: globalVersion.stdout.trim(),
    localVersion: localVersion.stdout.trim(),
    providerCalls: callCount,
    ledgerRows,
    restoredActiveState: {
      compressionCount: activeState.compression_count,
      cumulativeInputTokens: activeState.cumulative_input_tokens,
      cumulativeOutputTokens: activeState.cumulative_output_tokens,
      messageCount: restoredMessages.length,
    },
    plain: 'PASS',
    tool: 'PASS',
    restart: 'PASS',
    interactive: JSON.parse(interactive.stdout.trim()),
    localPackageRunner: 'PASS',
  }, null, 2) + '\n');
  if (providerError) process.stderr.write(providerError);
} finally {
  if (provider && !provider.killed) provider.kill('SIGTERM');
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedOsTemp = path.resolve(os.tmpdir());
  if (resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}`)) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
}
