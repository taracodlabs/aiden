import { describe, expect, it } from 'vitest';
import { ProviderError, ProviderRateLimitError } from '../../../providers/v4/errors';
import {
  classifyReadinessError,
  ProviderLifecycleTimeoutError,
  ProviderReadinessError,
  type ProviderReadinessErrorCategory,
} from '../../../providers/v4/readinessErrors';

describe('provider readiness error taxonomy', () => {
  const cases: Array<[ProviderReadinessErrorCategory, unknown, Parameters<typeof classifyReadinessError>[1]?]> = [
    ['credential_missing', new Error('No API key found for provider')],
    ['credential_invalid', new ProviderError('request failed', 'test', 401)],
    ['credential_forbidden', new ProviderError('request failed', 'test', 403)],
    ['quota_exhausted', new ProviderRateLimitError('test', { error: { message: 'billing quota exhausted' } })],
    ['rate_limited', new ProviderRateLimitError('test', { error: { message: 'too many requests' } })],
    ['model_unavailable', new ProviderError('request failed', 'test', 404), 'model'],
    ['model_not_entitled', new ProviderError('request failed', 'test', 403, { error: { message: 'model permission denied' } }), 'model'],
    ['model_gated', new ProviderError('request failed', 'test', 403, { error: { message: 'gated model access required' } }), 'model'],
    ['provider_unavailable', new ProviderError('server error', 'test', 503)],
    ['network_dns', Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' })],
    ['network_tls', Object.assign(new Error('certificate failed'), { code: 'CERT_HAS_EXPIRED' })],
    ['network_failure', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })],
    ['connection_timeout', new ProviderLifecycleTimeoutError('connection_timeout', 10)],
    ['first_byte_timeout', new ProviderLifecycleTimeoutError('first_byte_timeout', 10)],
    ['body_idle_timeout', new ProviderLifecycleTimeoutError('body_idle_timeout', 10)],
    ['total_timeout', new ProviderLifecycleTimeoutError('total_timeout', 10)],
    ['malformed_response', new ProviderError('returned non-JSON body', 'test', 200)],
    ['tool_call_unsupported', new ProviderReadinessError('tool_call_unsupported', 'no tool call', false)],
    ['streaming_unsupported', new ProviderReadinessError('streaming_unsupported', 'no stream', false)],
    ['tool_schema_rejected', new ProviderError('bad request', 'test', 400), 'tool_schema'],
    ['tool_replay_unsupported', new ProviderReadinessError('tool_replay_unsupported', 'no replay', false)],
    ['endpoint_invalid', new ProviderError('request failed', 'test', 404)],
    ['configuration_conflict', new Error("Provider 'missing' not found")],
    ['unknown_provider_error', new Error('opaque failure')],
  ];

  for (const [category, error, stage] of cases) {
    it(`classifies ${category}`, () => {
      expect(classifyReadinessError(error, stage).category).toBe(category);
    });
  }

  it('does not classify an arbitrary 403 as an invalid credential', () => {
    expect(classifyReadinessError(new ProviderError('forbidden', 'test', 403)).category)
      .toBe('credential_forbidden');
  });
});
