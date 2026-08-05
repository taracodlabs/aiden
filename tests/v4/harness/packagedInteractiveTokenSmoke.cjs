'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const repoRoot = process.env.AIDEN_TEST_REPO_ROOT;
const installRoot = process.env.AIDEN_TEST_INSTALLED_ROOT;
if (!repoRoot || !installRoot) throw new Error('Packaged interactive smoke paths are required.');
const pty = require(path.join(repoRoot, 'node_modules', 'node-pty'));
const cliPath = path.join(installRoot, 'node_modules', 'aiden-runtime', 'dist', 'cli', 'v4', 'aidenCLI.js');
const readyToken = '__COMPOSER_READY__';

function requestTrace() {
  const tracePath = `${process.env.AIDEN_TEST_PROVIDER_COUNT}.requests.jsonl`;
  try { return fs.readFileSync(tracePath, 'utf8'); } catch { return '(request trace unavailable)'; }
}

function plain(value) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function submit(terminal, value, onComplete) {
  let index = 0;
  let stopped = false;
  let immediate;
  const timers = new Set();
  const schedule = (callback, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) callback();
    }, delay);
    timers.add(timer);
  };
  const writeNext = () => {
    if (index < value.length) {
      terminal.write(value[index++]);
      schedule(writeNext, 10);
      return;
    }
    schedule(() => {
      terminal.write('\r');
      onComplete();
    }, 100);
  };
  immediate = setImmediate(() => {
    immediate = undefined;
    if (!stopped) writeNext();
  });
  return () => {
    stopped = true;
    if (immediate) clearImmediate(immediate);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}

function terminateForFailure(terminal) {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(terminal.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  terminal.kill();
}

async function releaseExitedPty(terminal) {
  if (process.platform !== 'win32') return;
  const agent = terminal._agent;
  agent?.inSocket?.destroy();
  agent?.outSocket?.destroy();
  const worker = agent?._conoutSocketWorker?._worker;
  if (worker && typeof worker.terminate === 'function') {
    await worker.terminate();
  }
}

function activeSmokeHandles() {
  const standardHandles = new Set([process.stdin, process.stdout, process.stderr]);
  return process._getActiveHandles()
    .filter((handle) => !standardHandles.has(handle))
    .map((handle) => handle?.constructor?.name ?? typeof handle);
}

function runFirstSession() {
  return new Promise((resolve, reject) => {
    const terminal = pty.spawn(process.execPath, [cliPath], {
      cwd: process.env.AIDEN_TEST_PACKAGE_CWD,
      cols: 110,
      rows: 40,
      env: { ...process.env, AIDEN_TEST_COMPOSER_READY: '1' },
    });
    let output = '';
    let state = 'boot';
    let historyTurns = 0;
    let historyReadyTarget = 0;
    let compressionReadyTarget = 0;
    let submitting = false;
    let settled = false;
    let dataSubscription;
    let exitSubscription;
    let cancelSubmission;
    const send = (value, afterSent) => {
      submitting = true;
      cancelSubmission = submit(terminal, value, () => {
        cancelSubmission = undefined;
        submitting = false;
        afterSent?.();
      });
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancelSubmission?.();
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      terminateForFailure(terminal);
      finish(new Error(`First packaged interactive session timed out (${state}):\n${plain(output).slice(-12_000)}`));
    }, 90_000);
    dataSubscription = terminal.onData((chunk) => {
      output += chunk;
      if (submitting) return;
      const text = plain(output);
      const readyCount = output.split(readyToken).length - 1;
      if (state === 'boot' && readyCount >= 1) {
        state = 'mode'; send('/mode economy');
      } else if (state === 'mode' && text.includes('Usage mode: economy')) {
        state = 'budget-set'; send('/budget 120');
      } else if (state === 'budget-set' && text.includes('Session token cap set')) {
        state = 'first-turn'; send('package history turn 1');
      } else if (state === 'first-turn' && text.includes('PACKAGED SIMPLE PASS') && readyCount >= 4) {
        state = 'budget-warning'; send('/budget');
      } else if (state === 'budget-warning' && text.includes('Budget warning.')) {
        state = 'budget-expand'; send('/budget 100000');
      } else if (state === 'budget-expand' && text.includes('Session token cap set to 100,000')) {
        historyTurns = 1;
        state = 'history';
        send(`use a tool for package history ${historyTurns}`, () => {
          historyReadyTarget = output.split(readyToken).length;
        });
      } else if (state === 'history' && readyCount >= historyReadyTarget) {
        if (historyTurns < 4) {
          historyTurns += 1;
          send(`use a tool for package history ${historyTurns}`, () => {
            historyReadyTarget = output.split(readyToken).length;
          });
        } else {
          state = 'usage-json'; send('/usage --json');
        }
      } else if (state === 'usage-json' && text.includes('"physicalAttempts":9')) {
        state = 'usage-human'; send('/usage');
      } else if (state === 'usage-human' && text.includes('Usage — Current session')) {
        if (!text.includes('cumulative exposures')) throw new Error('Human usage summary omitted schema exposure context.');
        state = 'usage-details'; send('/usage details');
      } else if (state === 'usage-details' && text.includes('Usage details — Current session')) {
        if (!text.includes('Providers and models') || !text.includes('Purposes')) {
          throw new Error('Detailed usage output omitted required sections.');
        }
        state = 'compress';
        send('/compress', () => {
          compressionReadyTarget = output.split(readyToken).length;
        });
      } else if (state === 'compress'
          && /Compressed \d+ .* \d+ messages/.test(text)
          && readyCount >= compressionReadyTarget) {
        state = 'quit'; send('/quit');
      }
    });
    exitSubscription = terminal.onExit(({ exitCode }) => {
      if (state !== 'quit' || exitCode !== 0) {
        finish(new Error(`First packaged interactive session exited ${exitCode} (${state}):\n${plain(output).slice(-12_000)}`));
        return;
      }
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      dataSubscription = undefined;
      exitSubscription = undefined;
      void releaseExitedPty(terminal).then(
        () => finish(null, output),
        (error) => finish(error),
      );
    });
  });
}

function runRestartSession() {
  return new Promise((resolve, reject) => {
    const terminal = pty.spawn(process.execPath, [cliPath, '--continue'], {
      cwd: process.env.AIDEN_TEST_PACKAGE_CWD,
      cols: 110,
      rows: 40,
      env: { ...process.env, AIDEN_TEST_COMPOSER_READY: '1' },
    });
    let output = '';
    let state = 'boot';
    let submitting = false;
    let settled = false;
    let dataSubscription;
    let exitSubscription;
    let cancelSubmission;
    const send = (value) => {
      submitting = true;
      cancelSubmission = submit(terminal, value, () => {
        cancelSubmission = undefined;
        submitting = false;
      });
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cancelSubmission?.();
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      terminateForFailure(terminal);
      finish(new Error(`Restarted packaged session timed out (${state}):\n${plain(output).slice(-12_000)}\nRequest trace:\n${requestTrace()}`));
    }, 60_000);
    dataSubscription = terminal.onData((chunk) => {
      output += chunk;
      if (submitting) return;
      const text = plain(output);
      const readyCount = output.split(readyToken).length - 1;
      if (state === 'boot' && readyCount >= 1) {
        state = 'usage'; send('/usage --json');
      } else if (state === 'usage' && text.includes('"compression":{"physicalAttempts":1')) {
        state = 'turn'; send('RESTART');
      } else if (state === 'turn' && text.includes('PACKAGED RESTART PASS') && readyCount >= 3) {
        state = 'quit'; send('/quit');
      }
    });
    exitSubscription = terminal.onExit(({ exitCode }) => {
      if (state !== 'quit' || exitCode !== 0) {
        finish(new Error(`Restarted packaged session exited ${exitCode} (${state}):\n${plain(output).slice(-12_000)}`));
        return;
      }
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      dataSubscription = undefined;
      exitSubscription = undefined;
      void releaseExitedPty(terminal).then(
        () => finish(null, output),
        (error) => finish(error),
      );
    });
  });
}

(async () => {
  const first = await runFirstSession();
  const restarted = await runRestartSession();
  const combined = plain(`${first}\n${restarted}`);
  for (const expected of [
    'Usage mode: economy',
    'Budget warning.',
    '"physicalAttempts":9',
    '"compression":{"physicalAttempts":1',
    'PACKAGED RESTART PASS',
  ]) {
    if (!combined.includes(expected)) throw new Error(`Missing packaged interactive evidence: ${expected}`);
  }
  if (combined.includes('controlled-package-value')) throw new Error('Credential sentinel leaked into interactive output.');
  await new Promise((resolve) => setImmediate(resolve));
  const activeHandles = activeSmokeHandles();
  if (activeHandles.length > 0) {
    throw new Error(`Packaged interactive smoke leaked active handles: ${activeHandles.join(', ')}`);
  }
  process.stdout.write(JSON.stringify({
    economy: 'PASS',
    budgetWarning: 'PASS',
    usageReport: 'PASS',
    usageHuman: 'PASS',
    usageDetails: 'PASS',
    compression: 'PASS',
    restartResume: 'PASS',
  }) + '\n');
})().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
