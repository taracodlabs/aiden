/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeExternalCodingProvider } from '../../../core/v4/coding/fakeProvider';
import { ExternalCodingProviderRegistry } from '../../../core/v4/coding/providerRegistry';
import type { ExternalCodingProviderStartRequest } from '../../../core/v4/coding/provider';

const roots: string[] = [];

async function startRequest(overrides: Partial<ExternalCodingProviderStartRequest> = {}): Promise<ExternalCodingProviderStartRequest> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-provider-workspace-'));
  const sessionHome = await mkdtemp(path.join(os.tmpdir(), 'aiden-coding-provider-home-'));
  roots.push(workspacePath, sessionHome);
  return {
    codingSessionId: 'coding_session_provider',
    childJobId: 'job_child',
    childAttemptId: 'attempt_child',
    generation: 3,
    workspacePath,
    sessionHome,
    environment: { PATH: process.env.PATH ?? '', HOME: sessionHome, USERPROFILE: sessionHome },
    sandbox: { required: true, available: true, network: 'disabled' },
    task: {
      goal: 'Create result.txt.',
      allowedScope: ['result.txt'],
      protectedPaths: ['protected.txt'],
      forbiddenOperations: ['git.commit', 'git.push'],
      acceptanceCriteria: [{ claimId: 'claim_result', statement: 'result.txt exists', required: true }],
      validationCommands: [],
      networkPolicy: 'disabled',
      packagePolicy: 'deny',
      budgets: { runtimeMs: 30_000, outputBytes: 4_096, commandCount: 4, eventCount: 20, inputCount: 4 },
      promotionPolicy: 'human_approval_required',
    },
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('external coding provider registry', () => {
  it('selects one healthy version-pinned immutable capability and rejects duplicates', async () => {
    const registry = new ExternalCodingProviderRegistry();
    const provider = new FakeExternalCodingProvider({ scenario: 'success' });
    registry.register(provider);
    expect(() => registry.register(new FakeExternalCodingProvider({ scenario: 'success' }))).toThrow(/already registered/i);

    const selected = await registry.select('fake_coding');
    expect(selected.detection).toMatchObject({ available: true, executable: 'fake-coding-runtime' });
    expect(selected.version).toMatchObject({ normalized: '1.0.0', supported: true });
    expect(selected.capability.capabilityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(selected.capability)).toBe(true);
  });

  it('fails closed for an unsupported provider version', async () => {
    const registry = new ExternalCodingProviderRegistry();
    registry.register(new FakeExternalCodingProvider({ scenario: 'success', version: '0.0.0', supported: false }));
    await expect(registry.select('fake_coding')).rejects.toMatchObject({ code: 'UNSUPPORTED_PROVIDER_VERSION' });
  });
});

describe('deterministic external coding provider', () => {
  it('emits ordered semantic events and changes only the isolated workspace', async () => {
    const provider = new FakeExternalCodingProvider({ scenario: 'success' });
    const request = await startRequest();
    const handle = await provider.startSession(request);
    await provider.sendTask({
      providerSessionId: handle.providerSessionId,
      codingSessionId: request.codingSessionId,
      childAttemptId: request.childAttemptId,
      generation: request.generation,
      task: request.task,
    });

    const events = await provider.events(handle.providerSessionId, 0);
    expect(events.map((event) => event.cursor)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.type)).toEqual([
      'session.started', 'session.ready', 'file.activity', 'result.reported',
    ]);
    expect(await readFile(path.join(request.workspacePath, 'result.txt'), 'utf8')).toBe('FAKE_CODING_RESULT\n');
    expect(await provider.collectResult(handle.providerSessionId)).toMatchObject({ externalOutcome: 'completed' });
  });

  it('can report false success without making a matching change', async () => {
    const provider = new FakeExternalCodingProvider({ scenario: 'false_success' });
    const request = await startRequest();
    const handle = await provider.startSession(request);
    await provider.sendTask({
      providerSessionId: handle.providerSessionId,
      codingSessionId: request.codingSessionId,
      childAttemptId: request.childAttemptId,
      generation: request.generation,
      task: request.task,
    });
    expect(await provider.collectResult(handle.providerSessionId)).toMatchObject({
      externalOutcome: 'completed',
      reportedFiles: ['result.txt'],
    });
    await expect(readFile(path.join(request.workspacePath, 'result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unavailable sandbox and stale generation input', async () => {
    const provider = new FakeExternalCodingProvider({ scenario: 'clarification' });
    const unavailable = await startRequest({ sandbox: { required: true, available: false, network: 'disabled' } });
    await expect(provider.startSession(unavailable)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });

    const request = await startRequest({ codingSessionId: 'coding_session_input' });
    const handle = await provider.startSession(request);
    await expect(provider.sendInput({
      providerSessionId: handle.providerSessionId,
      codingSessionId: request.codingSessionId,
      childAttemptId: request.childAttemptId,
      generation: request.generation + 1,
      requestId: 'clarification_one',
      sequence: 1,
      kind: 'clarification',
      content: 'Use SQLite.',
    })).rejects.toMatchObject({ code: 'STALE_PROVIDER_INPUT' });
  });
});

