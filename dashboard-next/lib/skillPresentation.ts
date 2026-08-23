export function skillSourceLabel(source: unknown): string {
  if (typeof source !== 'string' || !source.trim()) return 'Installed';
  const normalized = source.trim();
  return ({
    'built-in': 'Bundled with Aiden',
    workspace: 'Workspace',
    learned: 'Learned from verified work',
    approved: 'Reviewed and approved',
    runtime: 'Runtime-discovered',
  } as Record<string, string>)[normalized] ?? `Source: ${normalized.replaceAll('_', ' ')}`;
}
