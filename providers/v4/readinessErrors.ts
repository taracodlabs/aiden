import { ProviderError, ProviderPhaseTimeoutError, ProviderRateLimitError, ProviderTimeoutError } from './errors';

export type ProviderReadinessErrorCategory =
  | 'credential_missing'
  | 'credential_invalid'
  | 'credential_forbidden'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'model_unavailable'
  | 'model_not_entitled'
  | 'model_gated'
  | 'provider_unavailable'
  | 'network_dns'
  | 'network_tls'
  | 'network_failure'
  | 'connection_timeout'
  | 'first_byte_timeout'
  | 'body_idle_timeout'
  | 'total_timeout'
  | 'malformed_response'
  | 'streaming_unsupported'
  | 'tool_call_unsupported'
  | 'tool_schema_rejected'
  | 'tool_replay_unsupported'
  | 'endpoint_invalid'
  | 'configuration_conflict'
  | 'unknown_provider_error';

const RETRYABLE_READINESS_CATEGORIES = new Set<ProviderReadinessErrorCategory>([
  'quota_exhausted',
  'rate_limited',
  'provider_unavailable',
  'network_dns',
  'network_tls',
  'network_failure',
  'connection_timeout',
  'first_byte_timeout',
  'body_idle_timeout',
  'total_timeout',
  'malformed_response',
]);

export function isRetryableReadinessCategory(category: ProviderReadinessErrorCategory): boolean {
  return RETRYABLE_READINESS_CATEGORIES.has(category);
}

export class ProviderReadinessError extends Error {
  constructor(
    public readonly category: ProviderReadinessErrorCategory,
    message: string,
    public readonly retryable: boolean,
    public readonly diagnostic?: unknown,
  ) {
    super(message);
    this.name = 'ProviderReadinessError';
  }
}

export class ProviderLifecycleTimeoutError extends ProviderReadinessError {
  constructor(
    category: 'connection_timeout' | 'first_byte_timeout' | 'body_idle_timeout' | 'total_timeout',
    timeoutMs: number,
  ) {
    super(category, `Provider request exceeded the ${category.replace(/_/g, ' ')} (${timeoutMs}ms).`, true);
    this.name = 'ProviderLifecycleTimeoutError';
  }
}

function bodyText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw ?? ''); } catch { return ''; }
}

export function classifyReadinessError(
  error: unknown,
  stage?: 'configuration' | 'model' | 'plain' | 'streaming' | 'tool_schema' | 'tool_cycle',
): ProviderReadinessError {
  if (error instanceof ProviderReadinessError) return error;
  if (error instanceof ProviderRateLimitError) {
    const text = bodyText(error.raw).toLowerCase();
    const exhausted = /quota|credit|billing|limit exceeded/.test(text);
    return new ProviderReadinessError(
      exhausted ? 'quota_exhausted' : 'rate_limited',
      exhausted ? 'Provider quota is exhausted.' : 'Provider rate limit was reached.',
      true,
      error,
    );
  }
  if (error instanceof ProviderPhaseTimeoutError) {
    return new ProviderReadinessError(error.phase, error.message, true, error);
  }
  if (error instanceof ProviderTimeoutError) {
    return new ProviderReadinessError('total_timeout', 'Provider request timed out.', true, error);
  }
  if (error instanceof ProviderError) {
    const status = error.statusCode;
    const raw = bodyText(error.raw).toLowerCase();
    if (status === 401) return new ProviderReadinessError('credential_invalid', 'The configured credential was rejected.', false, error);
    if (status === 403) {
      const gated = stage === 'model' && /gated|access request|terms.*accept/.test(raw);
      const modelDenied = stage === 'model' || /model|entitl|permission/.test(raw);
      return new ProviderReadinessError(
        gated ? 'model_gated' : modelDenied ? 'model_not_entitled' : 'credential_forbidden',
        gated
          ? 'The selected model is gated for this account.'
          : modelDenied
            ? 'The account is not entitled to use this model.'
            : 'The provider denied this credential.',
        false,
        error,
      );
    }
    if (status === 404) {
      return new ProviderReadinessError(
        stage === 'model' ? 'model_unavailable' : 'endpoint_invalid',
        stage === 'model' ? 'The selected model is unavailable.' : 'The configured endpoint was not found.',
        false,
        error,
      );
    }
    if (status === 429) {
      const exhausted = /quota|credit|billing|limit exceeded/.test(raw);
      return new ProviderReadinessError(exhausted ? 'quota_exhausted' : 'rate_limited', exhausted ? 'Provider quota is exhausted.' : 'Provider rate limit was reached.', true, error);
    }
    if (status && status >= 500) return new ProviderReadinessError('provider_unavailable', 'The provider is temporarily unavailable.', true, error);
    if (status === 400 && stage === 'tool_schema') return new ProviderReadinessError('tool_schema_rejected', 'The provider rejected the probe tool schema.', false, error);
    if (/non-json|malformed|parse|invalid json/.test(error.message.toLowerCase())) {
      return new ProviderReadinessError('malformed_response', 'The provider returned a malformed response.', true, error);
    }
  }

  const record = error && typeof error === 'object' ? error as { code?: string; message?: string } : {};
  const code = record.code?.toUpperCase();
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ProviderReadinessError('network_dns', 'Provider hostname resolution failed.', true, error);
  if (code?.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new ProviderReadinessError('network_tls', 'A secure connection to the provider could not be established.', true, error);
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') {
    return new ProviderReadinessError('network_failure', 'The provider connection failed.', true, error);
  }
  const message = record.message ?? String(error ?? '');
  if (/no api key|credentials? missing|requires oauth login/i.test(message)) {
    return new ProviderReadinessError('credential_missing', 'No usable credential is configured.', false, error);
  }
  if (/model .*not found|unknown model/i.test(message)) {
    return new ProviderReadinessError('model_unavailable', 'The selected model is unavailable.', false, error);
  }
  if (/provider .*not found|unsupported apimode/i.test(message)) {
    return new ProviderReadinessError('configuration_conflict', 'Provider configuration is inconsistent.', false, error);
  }
  return new ProviderReadinessError('unknown_provider_error', 'The provider could not be verified.', false, error);
}
