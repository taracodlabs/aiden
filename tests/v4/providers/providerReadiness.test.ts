import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager } from '../../../core/v4/config';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ProviderAdapter, ProviderCallOutput } from '../../../providers/v4/types';
import {
  initialReadiness,
  markConfiguredUnverified,
  runRuntimeReadinessTransaction,
} from '../../../providers/v4/providerReadiness';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-readiness-'));
  roots.push(root);
  const paths = resolveAidenPaths({ rootOverride: root });
  const config = new ConfigManager(paths);
  await config.load();
  config.set('model.provider', 'groq');
  config.set('model.modelId', 'private/model');
  config.set('providers.groq.modelVerification', 'unverified');
  await config.save();
  return { paths, config };
}

const result = (overrides: Partial<ProviderCallOutput> = {}): ProviderCallOutput => ({
  content: 'READY', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, ...overrides,
});

describe('persisted runtime readiness transaction', () => {
  it('marks skipped smoke verification as configured-unverified', async () => {
    const { paths, config } = await fixture();
    const record = await markConfiguredUnverified(config, initialReadiness('groq', 'private/model'));
    expect(record.state).toBe('configured_unverified');
    const restarted = new ConfigManager(paths);
    await restarted.load();
    expect(restarted.getValue('providers.groq.readiness.state')).toBe('configured_unverified');
  });

  it('reloads persisted state and records a complete real adapter cycle', async () => {
    const { paths, config } = await fixture();
    let call = 0;
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() {
        call += 1;
        if (call === 2) return result({ content: null, finishReason: 'tool_use', toolCalls: [{ id: 'tc', name: 'runtime_readiness_probe', arguments: { marker: 'ready' } }] });
        return result();
      },
      async *callStream() {
        yield { type: 'done', output: result({ content: 'STREAM READY' }) };
      },
    };
    const resolver = {
      async describe() {
        return {
          provider: 'groq', apiMode: 'chat_completions' as const, baseUrl: 'https://example.invalid/v1', apiKey: null, source: 'env' as const,
          effectiveCredential: { provider: 'groq', credentialSource: 'managed_environment' as const, endpointSource: 'registry_default' as const, credentialFingerprint: 'hidden', endpointFingerprint: 'endpoint', configured: true, conflicts: [] },
        };
      },
      async resolve() { return adapter; },
    };
    const record = await runRuntimeReadinessTransaction({
      paths, config, resolver: resolver as any, providerId: 'groq', modelId: 'private/model', modelVerification: 'unverified',
    });
    expect(record.state).toBe('complete');
    expect(record.plainCompletionStatus).toBe('verified');
    expect(record.streamingStatus).toBe('verified');
    expect(record.toolCallStatus).toBe('verified');
    expect(record.toolResultReplayStatus).toBe('verified');
    expect(record.structuredArgumentsStatus).toBe('verified');
    const restarted = new ConfigManager(paths);
    await restarted.load();
    expect(restarted.get('providers.groq.modelVerification')).toBe('verified');
    expect(restarted.getValue('providers.groq.readiness.state')).toBe('complete');
  });

  it('rejects a setup/runtime Aiden-home mismatch before resolution', async () => {
    const first = await fixture();
    const second = await fixture();
    let resolved = false;
    const record = await runRuntimeReadinessTransaction({
      paths: first.paths,
      config: second.config,
      resolver: {
        async describe() { resolved = true; throw new Error('must not resolve'); },
        async resolve() { resolved = true; throw new Error('must not resolve'); },
      } as any,
      providerId: 'groq',
      modelId: 'private/model',
      modelVerification: 'unverified',
    });

    expect(record.state).toBe('failed_requires_user_action');
    expect(record.verificationErrorCategory).toBe('configuration_conflict');
    expect(resolved).toBe(false);
  });

  it('persists a probe-level network failure as retryable', async () => {
    const { paths, config } = await fixture();
    const networkError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const adapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      async call() { throw networkError; },
      async *callStream() { throw networkError; },
    };
    const resolver = {
      async describe() {
        return {
          provider: 'groq', apiMode: 'chat_completions' as const, baseUrl: 'https://example.invalid/v1', apiKey: null, source: 'env' as const,
          effectiveCredential: { provider: 'groq', credentialSource: 'managed_environment' as const, endpointSource: 'registry_default' as const, credentialFingerprint: 'hidden', endpointFingerprint: 'endpoint', configured: true, conflicts: [] },
        };
      },
      async resolve() { return adapter; },
    };

    const record = await runRuntimeReadinessTransaction({
      paths, config, resolver: resolver as any, providerId: 'groq', modelId: 'private/model', modelVerification: 'unverified',
    });

    expect(record.verificationErrorCategory).toBe('network_failure');
    expect(record.state).toBe('failed_retryable');
  });
});
