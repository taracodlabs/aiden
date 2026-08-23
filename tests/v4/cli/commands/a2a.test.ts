/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { describe, expect, it, vi } from 'vitest';

import { a2a } from '../../../../cli/v4/commands/a2a';
import { CommandRegistry, type SlashCommandContext } from '../../../../cli/v4/commandRegistry';

function display() {
  const output: string[] = [];
  return {
    output,
    write: (text: string) => output.push(text),
    dim: (text: string) => output.push(text),
    warn: (text: string) => output.push(text),
    info: (text: string) => output.push(text),
  };
}

function context(args: string[]): { ctx: SlashCommandContext; output: string[] } {
  const rendered = display();
  const identity = {
    externalIdentityId: 'external_a2a_1', displayName: 'Repository reader',
    canonicalEndpoint: 'https://agent.example.test/a2a', trustState: 'verified_key',
    observedIdentityKeyDigest: 'a'.repeat(64), stateVersion: 2,
  };
  const task = {
    remoteTaskRecordId: 'remote_task_1', externalIdentityId: identity.externalIdentityId,
    localJobId: 'job_child_1', localAttemptId: 'attempt_1', localGeneration: 1,
    remoteTaskId: 'remote-44', remoteContextId: 'context-9', state: 'unknown',
    locallyVerified: false, verificationId: null, evidenceIds: [], stateVersion: 4,
  };
  const external = {
    listIdentities: vi.fn(() => [identity]),
    getIdentity: vi.fn((id: string) => id === identity.externalIdentityId ? identity : null),
    latestCapabilities: vi.fn(() => ({
      protocolVersion: '1.0', capabilityDigest: 'b'.repeat(64),
      changeClass: 'same', reviewRequired: false,
    })),
    listRecoverableRemoteTasks: vi.fn(() => [task]),
    getRemoteTask: vi.fn((id: string) => id === task.remoteTaskRecordId ? task : null),
    listRemoteTaskEvents: vi.fn(() => [{
      remoteTaskEventId: 'remote_event_1', sequence: 1, kind: 'unknown', taskState: 'unknown',
    }]),
    listRemoteArtifacts: vi.fn(() => [{
      remoteArtifactId: 'remote_artifact_1', declaredName: 'report.txt',
      quarantineState: 'quarantined', byteLength: 12,
    }]),
  };
  return {
    output: rendered.output,
    ctx: {
      args, rawArgs: args.join(' '), display: rendered as never,
      registry: new CommandRegistry(),
      jobEngine: { external } as never,
    },
  };
}

describe('/a2a read-only operator projection', () => {
  it('lists exact durable agent trust and makes mutation unavailability explicit', async () => {
    const { ctx, output } = context([]);
    await a2a.handler(ctx);
    const text = output.join('');
    expect(text).toContain('Repository reader');
    expect(text).toContain('verified_key');
    expect(text).toContain('external_a2a_1');
    expect(text).toContain('Mutation delegation is disabled');
  });

  it('renders exact RemoteTask lineage, events, and quarantined artifacts', async () => {
    const { ctx, output } = context(['task', 'remote_task_1']);
    await a2a.handler(ctx);
    const text = output.join('');
    expect(text).toContain('remote_task_1');
    expect(text).toContain('job_child_1');
    expect(text).toContain('attempt_1');
    expect(text).toContain('remote-44');
    expect(text).toContain('remote_event_1');
    expect(text).toContain('report.txt');
    expect(text).toContain('quarantined');
    expect(text).not.toContain('[object Object]');
  });

  it('fails closed when durable external authority is unavailable', async () => {
    const rendered = display();
    await a2a.handler({
      args: [], rawArgs: '', display: rendered as never, registry: new CommandRegistry(),
    });
    expect(rendered.output.join('')).toContain('durable external authority is unavailable');
  });
});
