export interface CompatibilityUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  usage_source: 'provider_reported' | 'locally_estimated';
  estimated: boolean;
}

export function estimateCompatibilityUsage(
  messages: readonly { role: string; content: unknown }[],
  completion: string,
): CompatibilityUsage {
  const request = safeJson(messages);
  const promptTokens = Math.ceil(Buffer.byteLength(request, 'utf8') / 4);
  const completionTokens = Math.ceil(Buffer.byteLength(completion, 'utf8') / 4);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    usage_source: 'locally_estimated',
    estimated: true,
  };
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}
