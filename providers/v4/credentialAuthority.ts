import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from '../../core/v4/paths';

export type EffectiveCredentialSource =
  | 'explicit_override'
  | 'inline_config'
  | 'managed_environment'
  | 'process_environment'
  | 'oauth_store'
  | 'legacy_store'
  | 'local_runtime'
  | 'missing';

export type EffectiveEndpointSource =
  | 'explicit_override'
  | 'inline_config'
  | 'registry_default';

export interface CredentialConflict {
  preferred: EffectiveCredentialSource;
  shadowed: EffectiveCredentialSource;
}

export interface EffectiveCredentialResolution {
  provider: string;
  credentialSource: EffectiveCredentialSource;
  endpointSource: EffectiveEndpointSource;
  credentialFingerprint: string | null;
  endpointFingerprint: string;
  configured: boolean;
  conflicts: CredentialConflict[];
}

export interface CredentialConfigView {
  get(key: string): string | undefined;
  getRaw?(key: string): string | undefined;
}

export interface ResolveApiCredentialOptions {
  providerId: string;
  envVar: string | null;
  registryEndpoint: string;
  override?: string;
  endpointOverride?: string;
  config?: CredentialConfigView;
  paths?: AidenPaths;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedApiCredential {
  apiKey: string | null;
  endpoint: string;
  effective: EffectiveCredentialResolution;
}

export type ManagedCredentialPersistenceErrorCode =
  | 'credential_missing'
  | 'credential_write_failed'
  | 'credential_verification_failed';

export class ManagedCredentialPersistenceError extends Error {
  constructor(
    public readonly code: ManagedCredentialPersistenceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'ManagedCredentialPersistenceError';
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface PersistManagedCredentialOptions {
  paths: AidenPaths;
  envVar: string;
  credential: string;
  env?: NodeJS.ProcessEnv;
}

export interface PersistedManagedCredential {
  credentialSource: 'managed_environment';
  credentialFingerprint: string;
  envFile: string;
}

export interface ManagedCredentialFileSnapshot {
  existed: boolean;
  body: string;
}

const PLACEHOLDER_RE = /^\s*\$\{[A-Za-z_][A-Za-z0-9_]*\}\s*$/;

export function isUnresolvedCredentialPlaceholder(value: string | null | undefined): boolean {
  return typeof value === 'string' && PLACEHOLDER_RE.test(value);
}

function usable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || isUnresolvedCredentialPlaceholder(trimmed)) return null;
  return trimmed;
}

export function credentialFingerprint(value: string): string {
  return createHash('sha256')
    .update('provider-credential\0')
    .update(value)
    .digest('hex')
    .slice(0, 24);
}

export function endpointFingerprint(value: string): string {
  return createHash('sha256')
    .update('provider-endpoint\0')
    .update(value.replace(/\/+$/, '').toLowerCase())
    .digest('hex')
    .slice(0, 24);
}

async function managedEnvValue(envFile: string | undefined, key: string | null): Promise<string | null> {
  if (!envFile || !key) return null;
  let body: string;
  try {
    body = await fs.readFile(envFile, 'utf8');
  } catch {
    return null;
  }
  let found: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    found = usable(value);
  }
  return found;
}

export async function snapshotManagedCredentialFile(paths: AidenPaths): Promise<ManagedCredentialFileSnapshot> {
  try {
    return { existed: true, body: await fs.readFile(paths.envFile, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, body: '' };
    throw new ManagedCredentialPersistenceError(
      'credential_write_failed',
      'Could not snapshot the managed credential file.',
      { cause: error },
    );
  }
}

export async function restoreManagedCredentialFile(options: {
  paths: AidenPaths;
  snapshot: ManagedCredentialFileSnapshot;
  envVar: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const temporary = `${options.paths.envFile}.${process.pid}.${randomUUID()}.restore.tmp`;
  try {
    if (options.snapshot.existed) {
      await fs.mkdir(path.dirname(options.paths.envFile), { recursive: true });
      await fs.writeFile(temporary, options.snapshot.body, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, options.paths.envFile);
    } else {
      await fs.rm(options.paths.envFile, { force: true });
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new ManagedCredentialPersistenceError(
      'credential_write_failed',
      'Could not restore the managed credential file.',
      { cause: error },
    );
  }
  const restored = await managedEnvValue(options.paths.envFile, options.envVar);
  const env = options.env ?? process.env;
  if (restored) env[options.envVar] = restored;
  else delete env[options.envVar];
}

/**
 * Atomically persist one managed provider credential and verify the durable
 * value before making it visible to the current process. Secret values are
 * never returned; callers receive only a stable fingerprint and source.
 */
export async function persistManagedCredential(
  options: PersistManagedCredentialOptions,
): Promise<PersistedManagedCredential> {
  const envVar = options.envVar.trim().toUpperCase();
  const credential = usable(options.credential);
  if (!credential || /[\r\n]/.test(options.credential)) {
    throw new ManagedCredentialPersistenceError(
      'credential_missing',
      `A non-empty ${envVar} credential is required.`,
    );
  }

  let existing = '';
  try {
    existing = await fs.readFile(options.paths.envFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ManagedCredentialPersistenceError(
        'credential_write_failed',
        `Could not read the managed credential file for ${envVar}.`,
        { cause: error },
      );
    }
  }

  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const assignment = `${envVar}=${credential}`;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || match[1].toUpperCase() !== envVar) continue;
    lines[index] = assignment;
    replaced = true;
  }
  if (!replaced) lines.push(assignment);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const temporary = `${options.paths.envFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(options.paths.envFile), { recursive: true });
    await fs.writeFile(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, options.paths.envFile);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new ManagedCredentialPersistenceError(
      'credential_write_failed',
      `Could not persist the managed credential for ${envVar}.`,
      { cause: error },
    );
  }

  const durable = await managedEnvValue(options.paths.envFile, envVar);
  if (!durable || credentialFingerprint(durable) !== credentialFingerprint(credential)) {
    throw new ManagedCredentialPersistenceError(
      'credential_verification_failed',
      `The managed credential for ${envVar} could not be verified after writing.`,
    );
  }

  (options.env ?? process.env)[envVar] = credential;
  return {
    credentialSource: 'managed_environment',
    credentialFingerprint: credentialFingerprint(credential),
    envFile: options.paths.envFile,
  };
}

export async function resolveApiCredential(
  options: ResolveApiCredentialOptions,
): Promise<ResolvedApiCredential> {
  const configKey = `providers.${options.providerId}.apiKey`;
  const endpointKey = `providers.${options.providerId}.baseUrl`;
  const rawConfig = options.config?.getRaw?.(configKey);
  const configValue = usable(rawConfig ?? options.config?.get(configKey));
  const managedValue = await managedEnvValue(options.paths?.envFile, options.envVar);
  const processValue = usable(options.envVar ? (options.env ?? process.env)[options.envVar] : null);
  const overrideValue = usable(options.override);

  const candidates: Array<{ source: EffectiveCredentialSource; value: string | null }> = [
    { source: 'explicit_override', value: overrideValue },
    { source: 'inline_config', value: configValue },
    { source: 'managed_environment', value: managedValue },
    { source: 'process_environment', value: processValue },
  ];
  const selected = candidates.find((candidate) => candidate.value !== null)
    ?? { source: 'missing' as const, value: null };
  const selectedFingerprint = selected.value ? credentialFingerprint(selected.value) : null;
  const conflicts: CredentialConflict[] = [];
  if (selected.value) {
    for (const candidate of candidates) {
      if (!candidate.value || candidate.source === selected.source) continue;
      if (credentialFingerprint(candidate.value) !== selectedFingerprint) {
        conflicts.push({ preferred: selected.source, shadowed: candidate.source });
      }
    }
  }

  const configuredEndpoint = usable(options.config?.getRaw?.(endpointKey) ?? options.config?.get(endpointKey));
  const endpoint = (usable(options.endpointOverride) ?? configuredEndpoint ?? options.registryEndpoint).replace(/\/+$/, '');
  const endpointSource: EffectiveEndpointSource = usable(options.endpointOverride)
    ? 'explicit_override'
    : configuredEndpoint
      ? 'inline_config'
      : 'registry_default';

  return {
    apiKey: selected.value,
    endpoint,
    effective: {
      provider: options.providerId,
      credentialSource: selected.source,
      endpointSource,
      credentialFingerprint: selectedFingerprint,
      endpointFingerprint: endpointFingerprint(endpoint),
      configured: selected.value !== null,
      conflicts,
    },
  };
}

export function effectiveStoredCredential(
  provider: string,
  source: 'oauth_store' | 'legacy_store' | 'local_runtime',
  endpoint: string,
  credential?: string | null,
): EffectiveCredentialResolution {
  return {
    provider,
    credentialSource: source,
    endpointSource: 'registry_default',
    credentialFingerprint: credential ? credentialFingerprint(credential) : null,
    endpointFingerprint: endpointFingerprint(endpoint),
    configured: source === 'local_runtime' || !!credential,
    conflicts: [],
  };
}
