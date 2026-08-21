/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CodexCliExternalCodingProvider } from '../../../core/v4/coding/codexCliProvider';
import type { ExternalCodingProcessStartRequest } from '../../../core/v4/coding/processHost';
import type { ExternalCodingProviderStartRequest } from '../../../core/v4/coding/provider';

function request(): ExternalCodingProviderStartRequest {
  return {
    codingSessionId: 'coding_session_real', childJobId: 'job_child', childAttemptId: 'attempt_child', generation: 7,
    modelId: 'gpt-5.6-codex',
    workspacePath: 'C:\\isolated\\worktree', sessionHome: 'C:\\isolated\\home',
    environment: {
      PATH: 'C:\\runtime', HOME: 'C:\\isolated\\home', USERPROFILE: 'C:\\isolated\\home',
      SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    },
    sandbox: { required: true, available: true, network: 'disabled' },
    task: {
      goal: 'Fix the exact failing test.', allowedScope: ['src/value.ts'], protectedPaths: ['protected.txt'],
      forbiddenOperations: ['git.commit', 'git.push', 'agent.recursive'],
      acceptanceCriteria: [{ claimId: 'claim_test', statement: 'Focused test passes', required: true }],
      validationCommands: ['npm test -- value'], networkPolicy: 'disabled', packagePolicy: 'deny',
      budgets: { runtimeMs: 60_000, outputBytes: 65_536, commandCount: 10 },
      promotionPolicy: 'human_approval_required',
    },
  };
}

describe('supported structured coding CLI provider', () => {
  it('selects a validated compatible Windows installation when the PATH executable is unsupported', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-discovery-'));
    const installRoot = path.join(root, 'Codex', 'bin');
    const ambient = path.join(root, 'ambient', 'codex.exe');
    const compatible = path.join(installRoot, 'versioned-install', 'codex.exe');
    await mkdir(path.dirname(ambient), { recursive: true });
    await mkdir(path.dirname(compatible), { recursive: true });
    await writeFile(ambient, 'ambient', 'utf8');
    await writeFile(compatible, 'compatible', 'utf8');
    const compatibleResolved = await realpath(compatible);
    const probe = vi.fn(async (executable: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        return executable === compatibleResolved
          ? { code: 0, stdout: 'codex-cli 0.147.0-alpha.6.6\n', stderr: '' }
          : { code: 0, stdout: 'codex-cli 0.130.0-alpha.5\n', stderr: '' };
      }
      return { code: 0, stdout: 'Logged in\n', stderr: '' };
    });
    try {
      const provider = new CodexCliExternalCodingProvider({
        resolveExecutable: () => ambient,
        probe,
        processHost: {} as never,
        platform: 'win32',
        healthEnvironment: { PATH: path.dirname(ambient), CODEX_HOME: path.join(root, 'isolated-auth') },
        knownInstallRoots: [installRoot],
      });

      expect(await provider.detect()).toMatchObject({
        available: true,
        executable: compatibleResolved,
        source: 'known_installation',
      });
      expect(await provider.version()).toMatchObject({ normalized: '0.147.0', supported: true });
      expect(await provider.health()).toMatchObject({ healthy: true, authentication: 'ready' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not replace an explicit executable with a discovered candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-explicit-'));
    const explicit = path.join(root, 'selected', 'codex.exe');
    const compatible = path.join(root, 'Codex', 'bin', 'versioned-install', 'codex.exe');
    await mkdir(path.dirname(explicit), { recursive: true });
    await mkdir(path.dirname(compatible), { recursive: true });
    await writeFile(explicit, 'explicit', 'utf8');
    await writeFile(compatible, 'compatible', 'utf8');
    try {
      const provider = new CodexCliExternalCodingProvider({
        executableName: explicit,
        resolveExecutable: (name) => name,
        probe: async (executable) => executable === compatible
          ? { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }
          : { code: 0, stdout: 'codex-cli 0.130.0\n', stderr: '' },
        processHost: {} as never,
        platform: 'win32',
        healthEnvironment: {},
        knownInstallRoots: [path.join(root, 'Codex', 'bin')],
      });

      expect(await provider.detect()).toMatchObject({ available: true, executable: explicit, source: 'explicit' });
      expect(await provider.version()).toMatchObject({ normalized: '0.130.0', supported: false });
      expect(await provider.health()).toMatchObject({ healthy: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects exact executable/version/health and declares structured capabilities', async () => {
    const probe = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' };
      return { code: 0, stdout: 'Logged in\n', stderr: '' };
    });
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      probe,
      processHost: {} as never,
      healthEnvironment: { PATH: 'C:\\runtime', CODEX_HOME: 'C:\\isolated\\auth' },
    });

    expect(await provider.detect()).toMatchObject({ available: true, executable: 'C:\\runtime\\codex.exe' });
    expect(await provider.version()).toMatchObject({ normalized: '0.147.0', supported: true });
    expect(await provider.health()).toMatchObject({ healthy: true, authentication: 'ready' });
    const capability = await provider.capabilities();
    expect(capability).toMatchObject({
      providerId: 'codex_cli', protocolMode: 'structured',
      supportedFeatures: { structuredProtocol: true, pty: false, commandVisibility: 'observable' },
    });
  });

  it('fails cleanly for an unknown protocol version', async () => {
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'codex',
      probe: async () => ({ code: 0, stdout: 'codex-cli 9.0.0\n', stderr: '' }),
      processHost: {} as never,
      healthEnvironment: {},
    });
    expect(await provider.version()).toMatchObject({ normalized: '9.0.0', supported: false });
  });

  it('fails closed for a coding CLI version without the required Windows shell contract', async () => {
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'codex',
      probe: async () => ({ code: 0, stdout: 'codex-cli 0.130.0\n', stderr: '' }),
      processHost: {} as never,
      healthEnvironment: {},
    });

    expect(await provider.version()).toMatchObject({ normalized: '0.130.0', supported: false });
  });

  it('uses an explicit isolated credential without probing ambient login state or exposing it', async () => {
    const canary = 'OPENAI_TEST_CREDENTIAL_DO_NOT_PRINT';
    const probe = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'ambient login must not be inspected' };
    });
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      probe,
      processHost: {} as never,
      healthEnvironment: { PATH: 'C:\\runtime', OPENAI_API_KEY: canary },
    });

    const health = await provider.health();

    expect(health).toMatchObject({ healthy: true, authentication: 'ready' });
    expect(JSON.stringify(health)).not.toContain(canary);
    expect(probe.mock.calls.map(([, args]) => args)).toEqual([['--version']]);
  });

  it('does not inspect ambient login state without an explicit credential or isolated config home', async () => {
    const probe = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' };
      return { code: 0, stdout: 'ambient login must remain invisible\n', stderr: '' };
    });
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      probe,
      processHost: {} as never,
      healthEnvironment: { PATH: 'C:\\runtime' },
    });

    expect(await provider.health()).toMatchObject({ healthy: false, authentication: 'missing' });
    expect(probe.mock.calls.map(([, args]) => args)).toEqual([['--version']]);
  });

  it('probes the exact configured model in an empty read-only workspace and caches the result', async () => {
    let now = 1_000;
    const modelProbe = vi.fn(async (_executable: string, args: readonly string[], environment: Readonly<Record<string, string>>) => {
      expect(args).toContain('gpt-5.6-codex');
      expect(args).toContain('read-only');
      expect(args).toContain('--skip-git-repo-check');
      expect(args.at(-1)).toContain('AIDEN_CODING_MODEL_READY');
      const workspace = args[args.indexOf('-C') + 1]!;
      expect(workspace).toContain('aiden-coding-model-health-');
      expect(environment.CODEX_HOME).toContain('aiden-coding-model-health-');
      expect(JSON.stringify(args)).not.toContain('private repository content');
      return { code: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' };
    });
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      probe: async (_executable, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }
        : { code: 0, stdout: 'Logged in\n', stderr: '' },
      modelProbe,
      modelProbeTtlMs: 30_000,
      now: () => now,
      processHost: {} as never,
      platform: 'win32',
      healthEnvironment: {
        PATH: 'C:\\runtime', OPENAI_API_KEY: 'PRIVATE_TEST_VALUE',
        SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      },
    });

    expect(await provider.validateModel('gpt-5.6-codex')).toMatchObject({
      ready: true, modelId: 'gpt-5.6-codex', state: 'ready', checkedAt: 1_000,
    });
    now += 5_000;
    expect((await provider.validateModel('gpt-5.6-codex')).checkedAt).toBe(1_000);
    expect(modelProbe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await provider.validateModel('gpt-5.6-codex'))).not.toContain('PRIVATE_TEST_VALUE');
  });

  it('reports an unavailable exact model without exposing provider output', async () => {
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => '/runtime/codex',
      probe: async (_executable, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }
        : { code: 0, stdout: 'Logged in\n', stderr: '' },
      modelProbe: async () => ({
        code: 1, stdout: '', stderr: 'model gpt-private is not available; token=DO_NOT_EXPOSE',
      }),
      processHost: {} as never,
      healthEnvironment: { PATH: '/runtime', OPENAI_API_KEY: 'PRIVATE_TEST_VALUE' },
      platform: 'linux',
    });

    const result = await provider.validateModel('gpt-private');
    expect(result).toMatchObject({ ready: false, modelId: 'gpt-private', state: 'unsupported_model' });
    expect(result.detail).toBe('The exact configured model is not available to this coding runtime.');
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TEST_VALUE');
  });

  it('distinguishes an exact model that is unavailable for the active authentication mode', async () => {
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => '/runtime/codex',
      probe: async (_executable, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }
        : { code: 0, stdout: 'Logged in\n', stderr: '' },
      modelProbe: async () => ({
        code: 1,
        stdout: '',
        stderr: 'model gpt-exact is not supported with the ChatGPT account authentication mode; token=DO_NOT_EXPOSE',
      }),
      processHost: {} as never,
      healthEnvironment: { PATH: '/runtime', OPENAI_API_KEY: 'PRIVATE_TEST_VALUE' },
      platform: 'linux',
    });

    const result = await provider.validateModel('gpt-exact');

    expect(result).toMatchObject({
      ready: false,
      modelId: 'gpt-exact',
      state: 'model_unavailable_for_auth_mode',
    });
    expect(result.detail).toBe('The exact configured model is not available with the active authentication mode.');
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TEST_VALUE');
  });

  it('invalidates an exact-model health result when explicit credential content rotates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-model-cache-'));
    const credentialFile = path.join(root, 'auth.json');
    await writeFile(credentialFile, '{"auth_mode":"api","token":"first"}\n', 'utf8');
    const original = await stat(credentialFile);
    let now = 1_000;
    const modelProbe = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'model gpt-exact is not available' });
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => '/runtime/codex',
      probe: async (_executable, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }
        : { code: 0, stdout: 'Logged in\n', stderr: '' },
      modelProbe,
      modelProbeTtlMs: 30_000,
      now: () => now,
      processHost: {} as never,
      credentialFile,
      healthEnvironment: { PATH: '/runtime' },
      platform: 'linux',
    });
    try {
      expect(await provider.validateModel('gpt-exact')).toMatchObject({ ready: true, checkedAt: 1_000 });
      await writeFile(credentialFile, '{"auth_mode":"api","token":"other"}\n', 'utf8');
      await utimes(credentialFile, original.atime, original.mtime);
      now = 2_000;

      expect(await provider.validateModel('gpt-exact')).toMatchObject({
        ready: false,
        state: 'unsupported_model',
        checkedAt: 2_000,
      });
      expect(modelProbe).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates and stages only an explicitly selected credential file inside the disposable session home', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-auth-'));
    const credentialFile = path.join(root, 'approved-auth.json');
    const sessionHome = path.join(root, 'session-home');
    const workspacePath = path.join(root, 'workspace');
    await writeFile(credentialFile, '{"fixture":"approved"}\n', 'utf8');
    await mkdir(workspacePath, { recursive: true });
    const probes: Array<{ args: readonly string[]; environment: Readonly<Record<string, string>> }> = [];
    let launch: ExternalCodingProcessStartRequest | undefined;
    const processHost = {
      async start(input: ExternalCodingProcessStartRequest) {
        launch = input;
        return {
          processRecordId: 'coding_process_auth', codingSessionId: input.codingSessionId,
          childAttemptId: input.childAttemptId, generation: input.generation,
          identity: { pid: 42, startTime: 100, executable: input.executable, version: input.executableVersion, cwd: input.cwd, mode: 'structured' as const },
        };
      },
      endInput() {},
      inspect() { return { running: true, handle: {}, output: { text: '', stdout: '', stderr: '', observedBytes: 0, storedBytes: 0, truncated: false } }; },
      output() { return { text: '', stdout: '', stderr: '', observedBytes: 0, storedBytes: 0, truncated: false }; },
      async cancel() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async terminate() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async wait() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      dispose() {},
    };
    try {
      const provider = new CodexCliExternalCodingProvider({
        resolveExecutable: () => 'C:\\runtime\\codex.exe',
        probe: async (_executable, args, environment) => {
          probes.push({ args, environment });
          return args[0] === '--version'
            ? { code: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }
            : { code: 0, stdout: 'ready\n', stderr: '' };
        },
        processHost,
        healthEnvironment: { PATH: 'C:\\runtime' },
        credentialFile,
      });

      expect(await provider.health()).toMatchObject({ healthy: true, authentication: 'ready' });
      const loginProbe = probes.find((entry) => entry.args[0] === 'login');
      expect(loginProbe?.environment.CODEX_HOME).toBeTruthy();
      expect(loginProbe?.environment.HOME).toBe(loginProbe?.environment.USERPROFILE);
      expect(loginProbe?.environment.CODEX_HOME).not.toContain(path.dirname(credentialFile));

      await provider.startSession({ ...request(), workspacePath, sessionHome });
      expect(await readFile(path.join(sessionHome, '.codex', 'auth.json'), 'utf8')).toBe('{"fixture":"approved"}\n');
      expect(launch?.environment.CODEX_HOME).toBe(path.join(sessionHome, '.codex'));
      expect(JSON.stringify(launch)).not.toContain('fixture":"approved');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('starts only structured workspace-write mode with network disabled and ignores repository rules', async () => {
    let launch: ExternalCodingProcessStartRequest | undefined;
    let submitted = '';
    const processHost = {
      async start(input: ExternalCodingProcessStartRequest) {
        launch = input;
        return {
          processRecordId: 'coding_process_real', codingSessionId: input.codingSessionId,
          childAttemptId: input.childAttemptId, generation: input.generation,
          identity: { pid: 42, startTime: 100, executable: input.executable, version: input.executableVersion, cwd: input.cwd, mode: 'structured' as const },
        };
      },
      endInput(_id: string, content: string) { submitted = content; },
      inspect() { return { running: true, handle: {}, output: { text: '', stdout: '', stderr: '', observedBytes: 0, storedBytes: 0, truncated: false } }; },
      output() { return { text: '', stdout: '', stderr: '', observedBytes: 0, storedBytes: 0, truncated: false }; },
      async cancel() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async terminate() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async wait() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      dispose() {},
    };
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      platform: 'win32',
      probe: async (_exe, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '' }
        : { code: 0, stdout: 'Logged in', stderr: '' },
      processHost: processHost as never,
      healthEnvironment: { PATH: 'C:\\runtime' },
    });
    const redactionCanary = 'CODING_SESSION_SECRET_CANARY';
    const started = await provider.startSession({ ...request(), redactionCanaries: [redactionCanary] });
    await provider.sendTask({
      providerSessionId: started.providerSessionId,
      codingSessionId: 'coding_session_real', childAttemptId: 'attempt_child', generation: 7,
      modelId: 'gpt-5.6-codex',
      task: request().task,
    });

    expect(launch?.args).toEqual(expect.arrayContaining([
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write',
    ]));
    expect(launch?.args).toEqual(expect.arrayContaining(['-c', 'windows.sandbox="unelevated"']));
    expect(launch?.args).toEqual(expect.arrayContaining([
      '-c', 'windows.shell_path="C:\\\\Windows\\\\System32\\\\cmd.exe"',
    ]));
    expect(launch?.args).toEqual(expect.arrayContaining(['-c', 'shell_environment_policy.inherit=all']));
    expect(launch?.args).not.toContain('shell_environment_policy.inherit=none');
    expect(launch?.args).toEqual(expect.arrayContaining(['--model', 'gpt-5.6-codex']));
    expect(launch?.args.join(' ')).not.toContain('dangerously-bypass');
    expect(launch?.sandbox).toMatchObject({ networkEnforced: true, workspaceWriteBoundaryEnforced: true });
    expect(launch?.environment).toMatchObject({
      HOME: 'C:\\isolated\\home',
      USERPROFILE: 'C:\\isolated\\home',
      CODEX_HOME: 'C:\\isolated\\home\\.codex',
    });
    expect(launch?.redactionCanaries).toEqual([redactionCanary]);
    expect(submitted).toContain('Fix the exact failing test.');
    expect(submitted).toContain('git.commit');
    expect(submitted).toContain('human_approval_required');
  });

  it('retains an incomplete JSONL record until a later output read completes it', async () => {
    let output = '{"type":"item.completed","item":{"type":"agent_mes';
    const processHost = {
      async start(input: ExternalCodingProcessStartRequest) {
        return {
          processRecordId: 'coding_process_fragmented', codingSessionId: input.codingSessionId,
          childAttemptId: input.childAttemptId, generation: input.generation,
          identity: { pid: 43, startTime: 101, executable: input.executable, version: input.executableVersion, cwd: input.cwd, mode: 'structured' as const },
        };
      },
      endInput() {},
      inspect() { return { running: true, handle: {}, output: { text: output, stdout: output, stderr: '', observedBytes: output.length, storedBytes: output.length, truncated: false } }; },
      output: () => ({ text: output, stdout: output, stderr: '', observedBytes: output.length, storedBytes: output.length, truncated: false }),
      async cancel() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async terminate() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async wait() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      dispose() {},
    };
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      probe: async (_exe, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '' }
        : { code: 0, stdout: 'Logged in', stderr: '' },
      processHost: processHost as never,
      healthEnvironment: { PATH: 'C:\\runtime' },
    });
    const started = await provider.startSession(request());

    expect(await provider.events(started.providerSessionId, 1)).toEqual([]);
    output = '{"type":"item.completed","item":{"type":"agent_message","text":"complete"}}\n';

    const events = await provider.events(started.providerSessionId, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result.reported', payload: { summary: 'complete' } });
    expect((await provider.collectResult(started.providerSessionId))?.summary).toBe('complete');
  });

  it('does not consume the trailing JSONL cursor before the next record arrives', async () => {
    let output = '{"type":"thread.started"}\n';
    const processHost = {
      async start(input: ExternalCodingProcessStartRequest) {
        return {
          processRecordId: 'coding_process_incremental', codingSessionId: input.codingSessionId,
          childAttemptId: input.childAttemptId, generation: input.generation,
          identity: { pid: 44, startTime: 102, executable: input.executable, version: input.executableVersion, cwd: input.cwd, mode: 'structured' as const },
        };
      },
      endInput() {},
      inspect() { return { running: true, handle: {}, output: { text: output, stdout: output, stderr: '', observedBytes: output.length, storedBytes: output.length, truncated: false } }; },
      output: () => ({ text: output, stdout: output, stderr: '', observedBytes: output.length, storedBytes: output.length, truncated: false }),
      async cancel() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async terminate() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async wait() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      dispose() {},
    };
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      probe: async (_exe, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '' }
        : { code: 0, stdout: 'Logged in', stderr: '' },
      processHost: processHost as never,
      healthEnvironment: { PATH: 'C:\\runtime' },
    });
    const started = await provider.startSession(request());

    expect(await provider.events(started.providerSessionId, 1)).toMatchObject([{ type: 'session.ready' }]);
    output += '{"type":"item.completed","item":{"type":"agent_message","text":"final-result"}}\n';

    expect(await provider.events(started.providerSessionId, 2)).toMatchObject([{
      type: 'result.reported', payload: { summary: 'final-result' },
    }]);
    expect(await provider.collectResult(started.providerSessionId)).toMatchObject({
      summary: 'final-result', externalOutcome: 'completed',
    });
  });

  it('retains provider-reported file-change paths as non-authoritative candidate information', async () => {
    const output = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          changes: [{ path: 'src/value.js', kind: 'update' }],
        },
      }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'complete' } }),
      '',
    ].join('\n');
    const processHost = {
      async start(input: ExternalCodingProcessStartRequest) {
        return {
          processRecordId: 'coding_process_files', codingSessionId: input.codingSessionId,
          childAttemptId: input.childAttemptId, generation: input.generation,
          identity: { pid: 45, startTime: 103, executable: input.executable, version: input.executableVersion, cwd: input.cwd, mode: 'structured' as const },
        };
      },
      endInput() {},
      inspect() { return { running: false, handle: {}, output: { text: output, stdout: output, stderr: '', observedBytes: output.length, storedBytes: output.length, truncated: false } }; },
      output: () => ({ text: output, stdout: output, stderr: '', observedBytes: output.length, storedBytes: output.length, truncated: false }),
      async cancel() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async terminate() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      async wait() { return { exitCode: 0, signal: null, treeDeadVerified: true }; },
      dispose() {},
    };
    const provider = new CodexCliExternalCodingProvider({
      resolveExecutable: () => 'C:\\runtime\\codex.exe',
      probe: async (_exe, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '' }
        : { code: 0, stdout: 'Logged in', stderr: '' },
      processHost: processHost as never,
      healthEnvironment: { PATH: 'C:\\runtime' },
    });
    const started = await provider.startSession(request());

    expect(await provider.collectResult(started.providerSessionId)).toMatchObject({
      reportedFiles: ['src/value.js'],
      externalOutcome: 'completed',
    });
    expect(await provider.collectResult(started.providerSessionId)).toMatchObject({
      reportedFiles: ['src/value.js'],
      externalOutcome: 'completed',
    });
    const replayedEvents = await provider.events(started.providerSessionId, 0);
    expect(replayedEvents.filter((event) => event.type === 'file.activity')).toHaveLength(1);
    expect(replayedEvents.filter((event) => event.type === 'result.reported')).toHaveLength(1);
  });
});
