/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import {
  buildDockerValidationInvocation,
  DockerExternalCodingValidationExecutor,
  parseExternalCodingValidationCommand,
} from '../../../core/v4/coding/validationExecutor';

describe('external coding independent validation sandbox', () => {
  it('parses one direct command while preserving quoted arguments', () => {
    expect(parseExternalCodingValidationCommand('npm test -- --testNamePattern "safe result"'))
      .toEqual(['npm', 'test', '--', '--testNamePattern', 'safe result']);
  });

  it.each([
    'npm test && curl https://example.invalid',
    'npm test | tee result.txt',
    'node $(whoami)',
    'npm test\nwhoami',
  ])('rejects shell composition: %s', (command) => {
    expect(() => parseExternalCodingValidationCommand(command)).toThrow(/direct command|shell operators/i);
  });

  it('builds a network-off container with a read-only source and disposable validation copy', () => {
    const invocation = buildDockerValidationInvocation({
      command: 'npm test', cwd: 'C:\\safe fixture', image: 'node:22-test',
      dockerExecutable: 'docker.exe', sourceEnvironment: {
        PATH: 'C:\\bin', OPENAI_API_KEY: 'must-not-cross', USERPROFILE: 'C:\\real-home',
      }, nonce: 'fixed',
    });
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '-w', '/workspace', 'node:22-test',
    ]));
    expect(invocation.args.join('\0')).toContain(':/source:ro');
    expect(invocation.args.join('\0')).toContain('cp -a /source/. /workspace/ && exec "$@"');
    expect(invocation.environment).toEqual({ PATH: 'C:\\bin' });
  });

  it('fails closed when the independent sandbox is unavailable', async () => {
    const executor = new DockerExternalCodingValidationExecutor({ available: () => false });
    await expect(executor.execute({
      command: 'npm test', cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: 'VALIDATION_SANDBOX_UNAVAILABLE' });
  });
});
