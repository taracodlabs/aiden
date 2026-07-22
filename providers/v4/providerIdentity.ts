export interface ProviderRuntimeIdentityParts {
  provider: string;
  endpointFingerprint: string;
  credentialFingerprint: string | null;
  model: string;
}

/** Canonical identity used to prevent duplicate attempts across runtime slots. */
export function providerRuntimeIdentity(parts: ProviderRuntimeIdentityParts): string {
  return [
    parts.provider.trim().toLowerCase(),
    parts.endpointFingerprint,
    parts.credentialFingerprint ?? 'no-credential',
    parts.model,
  ].join('|');
}

/** Keep first occurrence order while removing only exact, known runtime identities. */
export function deduplicateRuntimeSlots<T extends { identity?: string }>(
  slots: readonly T[],
  reservedIdentities: readonly string[] = [],
): T[] {
  const seen = new Set(reservedIdentities.filter(Boolean));
  return slots.filter((slot) => {
    if (!slot.identity) return true;
    if (seen.has(slot.identity)) return false;
    seen.add(slot.identity);
    return true;
  });
}
