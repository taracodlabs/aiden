/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Shared durable trust, capability-drift, and remote-task authority used by
 * external protocol adapters. It never transitions a local Job or Attempt;
 * remote facts remain observations until local verification settles them.
 */

import { createHash } from 'node:crypto';

import type { Db } from '../daemon/db/connection';

export type ExternalKind = 'mcp' | 'a2a';
export type ExternalTrustState =
  | 'unverified'
  | 'verified_endpoint'
  | 'verified_key'
  | 'revoked'
  | 'changed';

export interface ExternalIdentityRecord {
  externalIdentityId: string;
  kind: ExternalKind;
  canonicalEndpoint: string;
  displayName: string;
  observedIdentityKeyDigest: string | null;
  trustedIdentityKeyDigest: string | null;
  trustState: ExternalTrustState;
  stateVersion: number;
  firstObservedAt: number;
  lastObservedAt: number;
  verifiedAt: number | null;
  revokedAt: number | null;
}

export type ExternalCapabilityChangeClass = 'initial' | 'same' | 'read_only' | 'mutation' | 'identity';

export interface ExternalCapabilitySnapshotRecord {
  capabilitySnapshotId: string;
  externalIdentityId: string;
  protocol: ExternalKind;
  protocolVersion: string;
  capabilityDigest: string;
  readCapabilityDigest: string;
  mutationCapabilityDigest: string;
  capabilities: Record<string, unknown>;
  priorSnapshotId: string | null;
  changeClass: ExternalCapabilityChangeClass;
  reviewRequired: boolean;
  acceptedBy: string | null;
  acceptedAt: number | null;
  stateVersion: number;
  idempotencyKey: string;
  observedAt: number;
}

export type RemoteTaskState =
  | 'admitted'
  | 'sending'
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'completed_observed'
  | 'failed_observed'
  | 'cancel_requested'
  | 'cancelled_observed'
  | 'unknown'
  | 'verified'
  | 'rejected';

export interface LocalRemoteTaskBinding {
  localJobId: string;
  localAttemptId: string;
  localGeneration: number;
  localFenceToken: string;
}

export interface RemoteTaskRecord {
  remoteTaskRecordId: string;
  externalIdentityId: string;
  capabilitySnapshotId: string;
  capabilityDigest: string;
  protocolVersion: string;
  binding: string;
  parentJobId: string;
  localJobId: string;
  localAttemptId: string;
  localGeneration: number;
  requestDigest: string;
  idempotencyKey: string;
  remoteTaskId: string | null;
  remoteContextId: string | null;
  remoteMessageId: string | null;
  state: RemoteTaskState;
  locallyVerified: boolean;
  verificationId: string | null;
  evidenceIds: string[];
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
  cancelRequestedAt: number | null;
  terminalAt: number | null;
}

export type RemoteTaskEventKind =
  | 'created'
  | 'sent'
  | 'accepted'
  | 'status_observed'
  | 'artifact_observed'
  | 'cancel_requested'
  | 'cancel_observed'
  | 'reconnected'
  | 'identity_changed'
  | 'unknown'
  | 'verified'
  | 'settled';

export interface RemoteTaskEventRecord {
  remoteTaskEventId: string;
  remoteTaskRecordId: string;
  remoteEventId: string;
  sequence: number;
  kind: RemoteTaskEventKind;
  taskState: RemoteTaskState;
  payloadDigest: string;
  observedAt: number;
}

export type RemoteArtifactQuarantineState = 'quarantined' | 'rejected' | 'released';

export interface RemoteArtifactRecord {
  remoteArtifactId: string;
  remoteTaskRecordId: string;
  externalIdentityId: string;
  remoteArtifactKey: string;
  declaredName: string;
  declaredMediaType: string | null;
  detectedMediaType: string | null;
  byteLength: number;
  contentDigest: string;
  quarantineState: RemoteArtifactQuarantineState;
  rejectionReason: string | null;
  artifactId: string | null;
  metadata: Record<string, unknown>;
  stateVersion: number;
  createdAt: number;
  releasedAt: number | null;
}

interface IdentityRow {
  external_identity_id: string;
  kind: ExternalKind;
  canonical_endpoint: string;
  display_name: string;
  observed_identity_key_digest: string | null;
  trusted_identity_key_digest: string | null;
  trust_state: ExternalTrustState;
  state_version: number;
  first_observed_at: number;
  last_observed_at: number;
  verified_at: number | null;
  revoked_at: number | null;
}

interface CapabilityRow {
  capability_snapshot_id: string;
  external_identity_id: string;
  protocol: ExternalKind;
  protocol_version: string;
  capability_digest: string;
  read_capability_digest: string;
  mutation_capability_digest: string;
  capabilities_json: string;
  prior_snapshot_id: string | null;
  change_class: ExternalCapabilityChangeClass;
  review_required: number;
  accepted_by: string | null;
  accepted_at: number | null;
  state_version: number;
  idempotency_key: string;
  observed_at: number;
}

interface RemoteTaskRow {
  remote_task_record_id: string;
  external_identity_id: string;
  capability_snapshot_id: string;
  capability_digest: string;
  protocol_version: string;
  binding: string;
  parent_job_id: string;
  local_job_id: string;
  local_attempt_id: string;
  local_generation: number;
  local_fence_digest: string;
  request_digest: string;
  idempotency_key: string;
  remote_task_id: string | null;
  remote_context_id: string | null;
  remote_message_id: string | null;
  state: RemoteTaskState;
  locally_verified: number;
  verification_id: string | null;
  evidence_ids_json: string;
  state_version: number;
  created_at: number;
  updated_at: number;
  cancel_requested_at: number | null;
  terminal_at: number | null;
}

interface RemoteArtifactRow {
  remote_artifact_id: string;
  remote_task_record_id: string;
  external_identity_id: string;
  remote_artifact_key: string;
  declared_name: string;
  declared_media_type: string | null;
  detected_media_type: string | null;
  byte_length: number;
  content_digest: string;
  quarantine_state: RemoteArtifactQuarantineState;
  rejection_reason: string | null;
  artifact_id: string | null;
  metadata_json: string;
  state_version: number;
  created_at: number;
  released_at: number | null;
}

interface RemoteTaskEventRow {
  remote_task_event_id: string;
  remote_task_record_id: string;
  remote_event_id: string;
  sequence: number;
  kind: RemoteTaskEventKind;
  task_state: RemoteTaskState;
  payload_digest: string;
  observed_at: number;
}

export interface ExternalAuthority {
  observeIdentity(input: {
    kind: ExternalKind;
    endpoint: string;
    displayName: string;
    identityKeyDigest?: string | null;
    now?: number;
  }): ExternalIdentityRecord;
  getIdentity(externalIdentityId: string): ExternalIdentityRecord | null;
  listIdentities(kind?: ExternalKind): ExternalIdentityRecord[];
  setTrust(input: {
    externalIdentityId: string;
    expectedStateVersion: number;
    to: ExternalTrustState;
    expectedIdentityKeyDigest?: string | null;
    now?: number;
  }): ExternalIdentityRecord;
  recordCapabilities(input: {
    externalIdentityId: string;
    protocol: ExternalKind;
    protocolVersion: string;
    capabilityDigest: string;
    readCapabilityDigest: string;
    mutationCapabilityDigest: string;
    capabilities: Record<string, unknown>;
    idempotencyKey: string;
    now?: number;
  }): ExternalCapabilitySnapshotRecord;
  acceptCapabilities(input: {
    capabilitySnapshotId: string;
    expectedStateVersion: number;
    acceptedBy: string;
    now?: number;
  }): ExternalCapabilitySnapshotRecord;
  getCapabilities(capabilitySnapshotId: string): ExternalCapabilitySnapshotRecord | null;
  latestCapabilities(externalIdentityId: string): ExternalCapabilitySnapshotRecord | null;
  canUseMutation(externalIdentityId: string): boolean;
  admitRemoteTask(input: LocalRemoteTaskBinding & {
    externalIdentityId: string;
    capabilitySnapshotId: string;
    capabilityDigest: string;
    protocolVersion: string;
    binding: string;
    parentJobId: string;
    requestDigest: string;
    idempotencyKey: string;
    now?: number;
  }): RemoteTaskRecord;
  getRemoteTask(remoteTaskRecordId: string): RemoteTaskRecord | null;
  findRemoteTaskByLocalJob(localJobId: string): RemoteTaskRecord | null;
  findRemoteTaskByIdempotency(externalIdentityId: string, idempotencyKey: string): RemoteTaskRecord | null;
  listRecoverableRemoteTasks(): RemoteTaskRecord[];
  listRemoteTaskEvents(remoteTaskRecordId: string): RemoteTaskEventRecord[];
  markRemoteSending(input: Omit<LocalRemoteTaskBinding, 'localJobId'> & {
    remoteTaskRecordId: string;
    expectedStateVersion: number;
    now?: number;
  }): RemoteTaskRecord;
  rebindRemoteTask(input: LocalRemoteTaskBinding & {
    remoteTaskRecordId: string;
    expectedStateVersion: number;
    now?: number;
  }): RemoteTaskRecord;
  bindRemoteIdentity(input: Omit<LocalRemoteTaskBinding, 'localJobId'> & {
    remoteTaskRecordId: string;
    expectedStateVersion: number;
    remoteTaskId: string;
    remoteContextId?: string | null;
    remoteMessageId?: string | null;
    now?: number;
  }): RemoteTaskRecord;
  observeRemoteState(input: Omit<LocalRemoteTaskBinding, 'localJobId'> & {
    remoteTaskRecordId: string;
    expectedStateVersion: number;
    state: Extract<RemoteTaskState,
      'working' | 'input_required' | 'completed_observed' | 'failed_observed' | 'cancelled_observed' | 'unknown'>;
    remoteEventId: string;
    payloadDigest: string;
    now?: number;
  }): RemoteTaskRecord;
  markRemoteIdentityChanged(input: Omit<LocalRemoteTaskBinding, 'localJobId'> & {
    remoteTaskRecordId: string;
    expectedStateVersion: number;
    identityStateVersion: number;
    identityKeyDigest?: string | null;
    now?: number;
  }): RemoteTaskRecord;
  requestRemoteCancellation(input: Omit<LocalRemoteTaskBinding, 'localJobId'> & {
    remoteTaskRecordId: string;
    expectedStateVersion: number;
    now?: number;
  }): RemoteTaskRecord;
  markLocallyVerified(input: Omit<LocalRemoteTaskBinding, 'localJobId'> & {
    remoteTaskRecordId: string;
    expectedStateVersion: number;
    verificationId: string;
    evidenceIds: string[];
    now?: number;
  }): RemoteTaskRecord;
  recordRemoteArtifact(input: Omit<LocalRemoteTaskBinding, 'localJobId'> & {
    remoteTaskRecordId: string;
    remoteArtifactKey: string;
    declaredName: string;
    declaredMediaType?: string | null;
    detectedMediaType?: string | null;
    byteLength: number;
    contentDigest: string;
    quarantineState: Extract<RemoteArtifactQuarantineState, 'quarantined' | 'rejected'>;
    rejectionReason?: string | null;
    metadata?: Record<string, unknown>;
    now?: number;
  }): RemoteArtifactRecord;
  getRemoteArtifact(remoteArtifactId: string): RemoteArtifactRecord | null;
  listRemoteArtifacts(remoteTaskRecordId: string): RemoteArtifactRecord[];
  releaseRemoteArtifact(input: {
    remoteArtifactId: string;
    expectedStateVersion: number;
    artifactId: string;
    now?: number;
  }): RemoteArtifactRecord;
}

export interface CreateExternalAuthorityOptions {
  db: Db;
  /** Exact current Job/Attempt/generation/fence validation supplied by JobEngine. */
  validateLocalAuthority?: (binding: LocalRemoteTaskBinding) => boolean;
  /** Exact cancelled Job lineage used only after cancellation was persisted. */
  validateCancelledLocalAuthority?: (binding: LocalRemoteTaskBinding) => boolean;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function requireBoundedString(value: string, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) throw new Error(`${label} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds the bounded ${maxLength}-character limit`);
  return normalized;
}

function boundedJson(value: Record<string, unknown>, label: string, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds the bounded ${maxBytes}-byte limit`);
  }
  return serialized;
}

function canonicalEndpoint(raw: string): string {
  requireBoundedString(raw, 'External endpoint', 2_048);
  const parsed = new URL(raw);
  if (!['https:', 'http:', 'stdio:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported external endpoint scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) throw new Error('External endpoint must not contain credentials');
  parsed.hash = '';
  parsed.search = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }
  const serialized = parsed.toString();
  const canonical = serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
  requireBoundedString(canonical, 'External endpoint', 2_048);
  return canonical;
}

function mapIdentity(row: IdentityRow): ExternalIdentityRecord {
  return {
    externalIdentityId: row.external_identity_id,
    kind: row.kind,
    canonicalEndpoint: row.canonical_endpoint,
    displayName: row.display_name,
    observedIdentityKeyDigest: row.observed_identity_key_digest,
    trustedIdentityKeyDigest: row.trusted_identity_key_digest,
    trustState: row.trust_state,
    stateVersion: row.state_version,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
  };
}

function parseRecord(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch { return {}; }
}

function parseStrings(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function mapCapabilities(row: CapabilityRow): ExternalCapabilitySnapshotRecord {
  return {
    capabilitySnapshotId: row.capability_snapshot_id,
    externalIdentityId: row.external_identity_id,
    protocol: row.protocol,
    protocolVersion: row.protocol_version,
    capabilityDigest: row.capability_digest,
    readCapabilityDigest: row.read_capability_digest,
    mutationCapabilityDigest: row.mutation_capability_digest,
    capabilities: parseRecord(row.capabilities_json),
    priorSnapshotId: row.prior_snapshot_id,
    changeClass: row.change_class,
    reviewRequired: row.review_required === 1,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    stateVersion: row.state_version,
    idempotencyKey: row.idempotency_key,
    observedAt: row.observed_at,
  };
}

function mapRemoteTask(row: RemoteTaskRow): RemoteTaskRecord {
  return {
    remoteTaskRecordId: row.remote_task_record_id,
    externalIdentityId: row.external_identity_id,
    capabilitySnapshotId: row.capability_snapshot_id,
    capabilityDigest: row.capability_digest,
    protocolVersion: row.protocol_version,
    binding: row.binding,
    parentJobId: row.parent_job_id,
    localJobId: row.local_job_id,
    localAttemptId: row.local_attempt_id,
    localGeneration: row.local_generation,
    requestDigest: row.request_digest,
    idempotencyKey: row.idempotency_key,
    remoteTaskId: row.remote_task_id,
    remoteContextId: row.remote_context_id,
    remoteMessageId: row.remote_message_id,
    state: row.state,
    locallyVerified: row.locally_verified === 1,
    verificationId: row.verification_id,
    evidenceIds: parseStrings(row.evidence_ids_json),
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelRequestedAt: row.cancel_requested_at,
    terminalAt: row.terminal_at,
  };
}

function mapRemoteArtifact(row: RemoteArtifactRow): RemoteArtifactRecord {
  return {
    remoteArtifactId: row.remote_artifact_id,
    remoteTaskRecordId: row.remote_task_record_id,
    externalIdentityId: row.external_identity_id,
    remoteArtifactKey: row.remote_artifact_key,
    declaredName: row.declared_name,
    declaredMediaType: row.declared_media_type,
    detectedMediaType: row.detected_media_type,
    byteLength: row.byte_length,
    contentDigest: row.content_digest,
    quarantineState: row.quarantine_state,
    rejectionReason: row.rejection_reason,
    artifactId: row.artifact_id,
    metadata: parseRecord(row.metadata_json),
    stateVersion: row.state_version,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

function mapRemoteTaskEvent(row: RemoteTaskEventRow): RemoteTaskEventRecord {
  return {
    remoteTaskEventId: row.remote_task_event_id,
    remoteTaskRecordId: row.remote_task_record_id,
    remoteEventId: row.remote_event_id,
    sequence: row.sequence,
    kind: row.kind,
    taskState: row.task_state,
    payloadDigest: row.payload_digest,
    observedAt: row.observed_at,
  };
}

export function createExternalAuthority(opts: CreateExternalAuthorityOptions): ExternalAuthority {
  const { db } = opts;

  const identityRow = (id: string): IdentityRow | undefined => db.prepare(
    'SELECT * FROM external_identities WHERE external_identity_id = ?',
  ).get(id) as IdentityRow | undefined;
  const capabilityRow = (id: string): CapabilityRow | undefined => db.prepare(
    'SELECT * FROM external_capability_snapshots WHERE capability_snapshot_id = ?',
  ).get(id) as CapabilityRow | undefined;
  const remoteTaskRow = (id: string): RemoteTaskRow | undefined => db.prepare(
    'SELECT * FROM remote_tasks WHERE remote_task_record_id = ?',
  ).get(id) as RemoteTaskRow | undefined;
  const remoteArtifactRow = (id: string): RemoteArtifactRow | undefined => db.prepare(
    'SELECT * FROM remote_artifacts WHERE remote_artifact_id = ?',
  ).get(id) as RemoteArtifactRow | undefined;

  const assertStoredAuthority = (
    row: RemoteTaskRow,
    input: Omit<LocalRemoteTaskBinding, 'localJobId'>,
    allowPersistedCancellation = false,
  ): LocalRemoteTaskBinding => {
    const binding: LocalRemoteTaskBinding = {
      localJobId: row.local_job_id,
      localAttemptId: input.localAttemptId,
      localGeneration: input.localGeneration,
      localFenceToken: input.localFenceToken,
    };
    const active = !opts.validateLocalAuthority || opts.validateLocalAuthority(binding);
    const cancelled = allowPersistedCancellation
      && !!opts.validateCancelledLocalAuthority
      && opts.validateCancelledLocalAuthority(binding);
    if (row.local_attempt_id !== input.localAttemptId
      || row.local_generation !== input.localGeneration
      || row.local_fence_digest !== digest(input.localFenceToken)
      || (!active && !cancelled)) {
      throw new Error('Local Attempt authority is stale or does not match the RemoteTask binding');
    }
    return binding;
  };

  const requireTrustedIdentity = (id: string): IdentityRow => {
    const row = identityRow(id);
    if (!row) throw new Error(`External identity not found: ${id}`);
    if (!['verified_endpoint', 'verified_key'].includes(row.trust_state)) {
      throw new Error(`External identity is not trusted: ${row.trust_state}`);
    }
    return row;
  };

  const latestCapabilityRow = (externalIdentityId: string): CapabilityRow | undefined => db.prepare(
    `SELECT * FROM external_capability_snapshots
      WHERE external_identity_id = ?
      ORDER BY observed_at DESC, capability_snapshot_id DESC LIMIT 1`,
  ).get(externalIdentityId) as CapabilityRow | undefined;

  const getRemoteTask = (id: string): RemoteTaskRecord | null => {
    const row = remoteTaskRow(id);
    return row ? mapRemoteTask(row) : null;
  };

  const appendRemoteTaskEvent = (input: {
    remoteTaskRecordId: string;
    remoteEventId: string;
    kind: RemoteTaskEventKind;
    taskState: RemoteTaskState;
    payloadDigest: string;
    observedAt: number;
  }): boolean => {
    requireBoundedString(input.remoteEventId, 'Remote event identity', 1_024);
    requireDigest(input.payloadDigest, 'Remote event payload');
    const existing = db.prepare(
      'SELECT 1 FROM remote_task_events WHERE remote_task_record_id=? AND remote_event_id=?',
    ).get(input.remoteTaskRecordId, input.remoteEventId);
    if (existing) return false;
    const next = (db.prepare(
      'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM remote_task_events WHERE remote_task_record_id=?',
    ).get(input.remoteTaskRecordId) as { sequence: number }).sequence;
    db.prepare(
      `INSERT INTO remote_task_events (
         remote_task_event_id,remote_task_record_id,remote_event_id,sequence,kind,
         task_state,payload_digest,observed_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      `remote_event_${digest(`${input.remoteTaskRecordId}\0${input.remoteEventId}`).slice(0, 32)}`,
      input.remoteTaskRecordId,
      input.remoteEventId,
      next,
      input.kind,
      input.taskState,
      input.payloadDigest,
      input.observedAt,
    );
    return true;
  };

  return {
    observeIdentity(input) {
      const endpoint = canonicalEndpoint(input.endpoint);
      const displayName = requireBoundedString(input.displayName, 'External display name', 256, true);
      const now = input.now ?? Date.now();
      if (input.identityKeyDigest) requireDigest(input.identityKeyDigest, 'External identity key');
      const id = `external_${digest(`${input.kind}\0${endpoint}`).slice(0, 32)}`;
      const existing = identityRow(id);
      if (!existing) {
        db.prepare(
          `INSERT INTO external_identities (
             external_identity_id,kind,canonical_endpoint,display_name,
             observed_identity_key_digest,trust_state,state_version,
             first_observed_at,last_observed_at
           ) VALUES (?,?,?,?,?,'unverified',1,?,?)`,
        ).run(id, input.kind, endpoint, displayName || endpoint, input.identityKeyDigest ?? null, now, now);
        return mapIdentity(identityRow(id)!);
      }
      let trust = existing.trust_state;
      let nextVersion = existing.state_version;
      if (existing.trust_state === 'verified_key'
        && input.identityKeyDigest
        && existing.trusted_identity_key_digest !== input.identityKeyDigest) {
        trust = 'changed';
        nextVersion += 1;
      }
      db.prepare(
        `UPDATE external_identities
            SET display_name=?,observed_identity_key_digest=?,trust_state=?,state_version=?,last_observed_at=?
          WHERE external_identity_id=?`,
      ).run(
        displayName || existing.display_name,
        input.identityKeyDigest ?? existing.observed_identity_key_digest,
        trust,
        nextVersion,
        now,
        id,
      );
      return mapIdentity(identityRow(id)!);
    },
    getIdentity(externalIdentityId) {
      const row = identityRow(externalIdentityId);
      return row ? mapIdentity(row) : null;
    },
    listIdentities(kind) {
      const rows = (kind
        ? db.prepare('SELECT * FROM external_identities WHERE kind=? ORDER BY first_observed_at,external_identity_id').all(kind)
        : db.prepare('SELECT * FROM external_identities ORDER BY first_observed_at,external_identity_id').all()) as IdentityRow[];
      return rows.map(mapIdentity);
    },
    setTrust(input) {
      const existing = identityRow(input.externalIdentityId);
      if (!existing) throw new Error(`External identity not found: ${input.externalIdentityId}`);
      if (existing.state_version !== input.expectedStateVersion) throw new Error('External identity state version conflict');
      if (input.to === 'verified_key') {
        if (!input.expectedIdentityKeyDigest) throw new Error('Verified-key trust requires an exact identity key digest');
        requireDigest(input.expectedIdentityKeyDigest, 'Trusted identity key');
        if (existing.observed_identity_key_digest !== input.expectedIdentityKeyDigest) {
          throw new Error('Observed external identity key does not match the trusted key');
        }
      }
      const now = input.now ?? Date.now();
      const changed = db.prepare(
        `UPDATE external_identities
            SET trust_state=?,trusted_identity_key_digest=?,verified_at=?,revoked_at=?,
                state_version=state_version+1,last_observed_at=?
          WHERE external_identity_id=? AND state_version=?`,
      ).run(
        input.to,
        input.to === 'verified_key' ? input.expectedIdentityKeyDigest : null,
        ['verified_endpoint', 'verified_key'].includes(input.to) ? now : existing.verified_at,
        input.to === 'revoked' ? now : null,
        now,
        input.externalIdentityId,
        input.expectedStateVersion,
      );
      if (changed.changes !== 1) throw new Error('External identity state version conflict');
      return mapIdentity(identityRow(input.externalIdentityId)!);
    },
    recordCapabilities(input) {
      const capabilityIdentity = identityRow(input.externalIdentityId);
      if (!capabilityIdentity) throw new Error(`External identity not found: ${input.externalIdentityId}`);
      if (capabilityIdentity.trust_state === 'revoked') throw new Error('External identity is revoked');
      requireDigest(input.capabilityDigest, 'Capability');
      requireDigest(input.readCapabilityDigest, 'Read capability');
      requireDigest(input.mutationCapabilityDigest, 'Mutation capability');
      const protocolVersion = requireBoundedString(input.protocolVersion, 'External protocol version', 64);
      const idempotencyKey = requireBoundedString(input.idempotencyKey, 'External capability idempotency key', 512);
      const capabilitiesJson = boundedJson(input.capabilities, 'External capability metadata', 1_048_576);
      const byIdempotency = db.prepare(
        'SELECT * FROM external_capability_snapshots WHERE external_identity_id=? AND idempotency_key=?',
      ).get(input.externalIdentityId, idempotencyKey) as CapabilityRow | undefined;
      if (byIdempotency) {
        if (byIdempotency.capability_digest !== input.capabilityDigest) {
          throw new Error('External capability idempotency conflict');
        }
        return mapCapabilities(byIdempotency);
      }
      const exact = db.prepare(
        'SELECT * FROM external_capability_snapshots WHERE external_identity_id=? AND capability_digest=?',
      ).get(input.externalIdentityId, input.capabilityDigest) as CapabilityRow | undefined;
      if (exact) return mapCapabilities(exact);
      const prior = latestCapabilityRow(input.externalIdentityId);
      let changeClass: ExternalCapabilityChangeClass = 'initial';
      if (prior) {
        if (prior.capability_digest === input.capabilityDigest) changeClass = 'same';
        else if (prior.mutation_capability_digest !== input.mutationCapabilityDigest) changeClass = 'mutation';
        else if (prior.read_capability_digest !== input.readCapabilityDigest) changeClass = 'read_only';
        else changeClass = 'identity';
      }
      const reviewRequired = changeClass === 'initial'
        || changeClass === 'mutation'
        || changeClass === 'identity'
        || (input.protocol === 'a2a' && changeClass === 'read_only')
        || (prior?.review_required === 1);
      const now = input.now ?? Date.now();
      const id = `external_caps_${digest(`${input.externalIdentityId}\0${input.capabilityDigest}`).slice(0, 32)}`;
      db.prepare(
        `INSERT INTO external_capability_snapshots (
           capability_snapshot_id,external_identity_id,protocol,protocol_version,
           capability_digest,read_capability_digest,mutation_capability_digest,
           capabilities_json,prior_snapshot_id,change_class,review_required,
           state_version,idempotency_key,observed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      ).run(
        id, input.externalIdentityId, input.protocol, protocolVersion,
        input.capabilityDigest, input.readCapabilityDigest, input.mutationCapabilityDigest,
        capabilitiesJson, prior?.capability_snapshot_id ?? null,
        changeClass, reviewRequired ? 1 : 0, idempotencyKey, now,
      );
      return mapCapabilities(capabilityRow(id)!);
    },
    acceptCapabilities(input) {
      const acceptedBy = requireBoundedString(input.acceptedBy, 'Capability reviewer identity', 256);
      const row = capabilityRow(input.capabilitySnapshotId);
      if (!row) throw new Error(`External capability snapshot not found: ${input.capabilitySnapshotId}`);
      requireTrustedIdentity(row.external_identity_id);
      const now = input.now ?? Date.now();
      const changed = db.prepare(
        `UPDATE external_capability_snapshots
            SET review_required=0,accepted_by=?,accepted_at=?,state_version=state_version+1
          WHERE capability_snapshot_id=? AND state_version=?`,
      ).run(acceptedBy, now, input.capabilitySnapshotId, input.expectedStateVersion);
      if (changed.changes !== 1) throw new Error('External capability state version conflict');
      return mapCapabilities(capabilityRow(input.capabilitySnapshotId)!);
    },
    getCapabilities(capabilitySnapshotId) {
      const row = capabilityRow(capabilitySnapshotId);
      return row ? mapCapabilities(row) : null;
    },
    latestCapabilities(externalIdentityId) {
      const row = latestCapabilityRow(externalIdentityId);
      return row ? mapCapabilities(row) : null;
    },
    canUseMutation(externalIdentityId) {
      const identity = identityRow(externalIdentityId);
      if (!identity || !['verified_endpoint', 'verified_key'].includes(identity.trust_state)) return false;
      const latest = latestCapabilityRow(externalIdentityId);
      return !!latest && latest.review_required === 0;
    },
    admitRemoteTask(input) {
      requireTrustedIdentity(input.externalIdentityId);
      requireDigest(input.requestDigest, 'Remote task request');
      requireDigest(input.capabilityDigest, 'Remote task capability');
      const protocolVersion = requireBoundedString(input.protocolVersion, 'Remote task protocol version', 64);
      const binding = requireBoundedString(input.binding, 'Remote task binding', 64);
      const idempotencyKey = requireBoundedString(input.idempotencyKey, 'Remote task idempotency key', 512);
      const capability = capabilityRow(input.capabilitySnapshotId);
      if (!capability
        || capability.external_identity_id !== input.externalIdentityId
        || capability.capability_digest !== input.capabilityDigest
        || capability.review_required !== 0) {
        throw new Error('Remote task capability snapshot is not accepted for this identity');
      }
      if (opts.validateLocalAuthority && !opts.validateLocalAuthority(input)) {
        throw new Error('Local Attempt authority is stale or unavailable');
      }
      const existing = db.prepare(
        'SELECT * FROM remote_tasks WHERE external_identity_id=? AND idempotency_key=?',
      ).get(input.externalIdentityId, idempotencyKey) as RemoteTaskRow | undefined;
      if (existing) {
        if (existing.request_digest !== input.requestDigest
          || existing.capability_snapshot_id !== input.capabilitySnapshotId
          || existing.capability_digest !== input.capabilityDigest
          || existing.protocol_version !== protocolVersion
          || existing.binding !== binding
          || existing.parent_job_id !== input.parentJobId
          || existing.local_job_id !== input.localJobId
          || existing.local_attempt_id !== input.localAttemptId
          || existing.local_generation !== input.localGeneration
          || existing.local_fence_digest !== digest(input.localFenceToken)) {
          throw new Error('Remote task idempotency conflict');
        }
        return mapRemoteTask(existing);
      }
      const now = input.now ?? Date.now();
      const id = `remote_task_${digest(`${input.externalIdentityId}\0${idempotencyKey}`).slice(0, 32)}`;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO remote_tasks (
             remote_task_record_id,external_identity_id,capability_snapshot_id,
             capability_digest,protocol_version,binding,parent_job_id,local_job_id,local_attempt_id,
             local_generation,local_fence_digest,request_digest,idempotency_key,
             state,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'admitted',?,?)`,
        ).run(
          id, input.externalIdentityId, input.capabilitySnapshotId,
          input.capabilityDigest, protocolVersion, binding, input.parentJobId,
          input.localJobId, input.localAttemptId,
          input.localGeneration, digest(input.localFenceToken), input.requestDigest,
          idempotencyKey, now, now,
        );
        appendRemoteTaskEvent({
          remoteTaskRecordId: id,
          remoteEventId: `local:created:${idempotencyKey}`,
          kind: 'created',
          taskState: 'admitted',
          payloadDigest: digest(`${input.requestDigest}\0${input.capabilityDigest}`),
          observedAt: now,
        });
      })();
      return mapRemoteTask(remoteTaskRow(id)!);
    },
    getRemoteTask,
    findRemoteTaskByLocalJob(localJobId) {
      const row = db.prepare(
        'SELECT * FROM remote_tasks WHERE local_job_id=? ORDER BY created_at,remote_task_record_id LIMIT 1',
      ).get(localJobId) as RemoteTaskRow | undefined;
      return row ? mapRemoteTask(row) : null;
    },
    findRemoteTaskByIdempotency(externalIdentityId, idempotencyKey) {
      const row = db.prepare(
        'SELECT * FROM remote_tasks WHERE external_identity_id=? AND idempotency_key=?',
      ).get(externalIdentityId, idempotencyKey) as RemoteTaskRow | undefined;
      return row ? mapRemoteTask(row) : null;
    },
    listRecoverableRemoteTasks() {
      const rows = db.prepare(
        `SELECT * FROM remote_tasks
          WHERE state NOT IN ('verified','rejected','cancelled_observed')
          ORDER BY created_at,remote_task_record_id`,
      ).all() as RemoteTaskRow[];
      return rows.map(mapRemoteTask);
    },
    listRemoteTaskEvents(remoteTaskRecordId) {
      return (db.prepare(
        'SELECT * FROM remote_task_events WHERE remote_task_record_id=? ORDER BY sequence',
      ).all(remoteTaskRecordId) as RemoteTaskEventRow[]).map(mapRemoteTaskEvent);
    },
    rebindRemoteTask(input) {
      const row = remoteTaskRow(input.remoteTaskRecordId);
      if (!row) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      if (row.local_job_id !== input.localJobId) throw new Error('Remote task cannot move to another local Job');
      if (opts.validateLocalAuthority && !opts.validateLocalAuthority(input)) {
        throw new Error('Replacement local Attempt authority is stale or unavailable');
      }
      if (row.state_version !== input.expectedStateVersion) throw new Error('Remote task state version conflict');
      if (['verified', 'rejected', 'cancelled_observed'].includes(row.state)) {
        throw new Error('Terminal RemoteTask cannot be rebound');
      }
      const now = input.now ?? Date.now();
      db.transaction(() => {
        const changed = db.prepare(
          `UPDATE remote_tasks
              SET local_attempt_id=?,local_generation=?,local_fence_digest=?,
                  state_version=state_version+1,updated_at=?
            WHERE remote_task_record_id=? AND state_version=?`,
        ).run(
          input.localAttemptId, input.localGeneration, digest(input.localFenceToken), now,
          input.remoteTaskRecordId, input.expectedStateVersion,
        );
        if (changed.changes !== 1) throw new Error('Remote task rebind conflict');
        appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: `local:reconnected:${input.localAttemptId}:${input.localGeneration}`,
          kind: 'reconnected',
          taskState: row.state,
          payloadDigest: digest(`${input.localAttemptId}\0${input.localGeneration}`),
          observedAt: now,
        });
      })();
      return getRemoteTask(input.remoteTaskRecordId)!;
    },
    markRemoteSending(input) {
      const row = remoteTaskRow(input.remoteTaskRecordId);
      if (!row) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      assertStoredAuthority(row, input);
      const now = input.now ?? Date.now();
      db.transaction(() => {
        const changed = db.prepare(
          `UPDATE remote_tasks SET state='sending',state_version=state_version+1,updated_at=?
            WHERE remote_task_record_id=? AND state_version=? AND state='admitted'`,
        ).run(now, input.remoteTaskRecordId, input.expectedStateVersion);
        if (changed.changes !== 1) throw new Error('Remote task send boundary conflict');
        appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: `local:sent:${input.expectedStateVersion}`,
          kind: 'sent', taskState: 'sending',
          payloadDigest: digest(`${row.request_digest}\0${row.capability_digest}`),
          observedAt: now,
        });
      })();
      return getRemoteTask(input.remoteTaskRecordId)!;
    },
    bindRemoteIdentity(input) {
      const row = remoteTaskRow(input.remoteTaskRecordId);
      if (!row) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      assertStoredAuthority(row, input);
      if (row.state_version !== input.expectedStateVersion) throw new Error('Remote task state version conflict');
      if (row.remote_task_id && row.remote_task_id !== input.remoteTaskId) {
        throw new Error('Remote task identity cannot be replaced');
      }
      const remoteTaskId = requireBoundedString(input.remoteTaskId, 'Remote Task identity', 512);
      const remoteContextId = input.remoteContextId == null
        ? null : requireBoundedString(input.remoteContextId, 'Remote context identity', 512, true);
      const remoteMessageId = input.remoteMessageId == null
        ? null : requireBoundedString(input.remoteMessageId, 'Remote message identity', 512, true);
      const now = input.now ?? Date.now();
      db.transaction(() => {
        const changed = db.prepare(
          `UPDATE remote_tasks
              SET remote_task_id=?,remote_context_id=?,remote_message_id=?,state='submitted',
                  state_version=state_version+1,updated_at=?
            WHERE remote_task_record_id=? AND state_version=? AND state IN ('admitted','sending','submitted')`,
        ).run(
          remoteTaskId, remoteContextId, remoteMessageId,
          now, input.remoteTaskRecordId, input.expectedStateVersion,
        );
        if (changed.changes !== 1) throw new Error('Remote task binding conflict');
        appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: `remote:accepted:${remoteTaskId}`,
          kind: 'accepted', taskState: 'submitted',
          payloadDigest: digest(`${remoteTaskId}\0${remoteContextId ?? ''}\0${remoteMessageId ?? ''}`),
          observedAt: now,
        });
      })();
      return getRemoteTask(input.remoteTaskRecordId)!;
    },
    observeRemoteState(input) {
      const row = remoteTaskRow(input.remoteTaskRecordId);
      if (!row) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      // Once local cancellation is durable, a late remote completion/failure is
      // still useful forensic truth. It may be observed under the cancelled
      // lineage, but it can never restore active local Job authority.
      assertStoredAuthority(row, input, row.cancel_requested_at !== null);
      if (row.state_version !== input.expectedStateVersion) throw new Error('Remote task state version conflict');
      requireDigest(input.payloadDigest, 'Remote event payload');
      const duplicate = db.prepare(
        'SELECT 1 FROM remote_task_events WHERE remote_task_record_id=? AND remote_event_id=?',
      ).get(input.remoteTaskRecordId, input.remoteEventId);
      if (duplicate) return mapRemoteTask(row);
      if (['verified', 'rejected', 'cancelled_observed'].includes(row.state)) {
        throw new Error('Remote task is terminal and cannot accept late observations');
      }
      const now = input.now ?? Date.now();
      db.transaction(() => {
        const kind: RemoteTaskEventKind = input.state === 'unknown'
          ? 'unknown'
          : input.state === 'cancelled_observed'
            ? 'cancel_observed'
            : 'status_observed';
        if (!appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: input.remoteEventId,
          kind,
          taskState: input.state,
          payloadDigest: input.payloadDigest,
          observedAt: now,
        })) return;
        const changed = db.prepare(
          `UPDATE remote_tasks SET state=?,state_version=state_version+1,updated_at=?,terminal_at=?
            WHERE remote_task_record_id=? AND state_version=?`,
        ).run(
          input.state, now,
          ['completed_observed', 'failed_observed', 'cancelled_observed'].includes(input.state) ? now : row.terminal_at,
          input.remoteTaskRecordId, input.expectedStateVersion,
        );
        if (changed.changes !== 1) throw new Error('Remote task state version conflict');
        if (['failed_observed', 'cancelled_observed'].includes(input.state)) {
          appendRemoteTaskEvent({
            remoteTaskRecordId: input.remoteTaskRecordId,
            remoteEventId: `local:settled:${input.remoteEventId}`,
            kind: 'settled', taskState: input.state,
            payloadDigest: input.payloadDigest,
            observedAt: now,
          });
        }
      })();
      return getRemoteTask(input.remoteTaskRecordId)!;
    },
    markRemoteIdentityChanged(input) {
      const row = remoteTaskRow(input.remoteTaskRecordId);
      if (!row) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      assertStoredAuthority(row, input, row.cancel_requested_at !== null);
      if (row.state_version !== input.expectedStateVersion) throw new Error('Remote task state version conflict');
      if (['verified', 'rejected', 'cancelled_observed'].includes(row.state)) {
        throw new Error('Terminal RemoteTask cannot be changed by a later identity observation');
      }
      const now = input.now ?? Date.now();
      const remoteEventId = `local:identity-changed:${input.identityStateVersion}`;
      const payloadDigest = digest(`${input.identityStateVersion}\0${input.identityKeyDigest ?? ''}`);
      db.transaction(() => {
        if (!appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId,
          kind: 'identity_changed',
          taskState: 'unknown',
          payloadDigest,
          observedAt: now,
        })) return;
        const changed = db.prepare(
          `UPDATE remote_tasks SET state='unknown',state_version=state_version+1,updated_at=?,terminal_at=NULL
            WHERE remote_task_record_id=? AND state_version=?`,
        ).run(now, input.remoteTaskRecordId, input.expectedStateVersion);
        if (changed.changes !== 1) throw new Error('Remote task identity-change conflict');
      })();
      return getRemoteTask(input.remoteTaskRecordId)!;
    },
    requestRemoteCancellation(input) {
      const row = remoteTaskRow(input.remoteTaskRecordId);
      if (!row) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      assertStoredAuthority(row, input, true);
      const now = input.now ?? Date.now();
      db.transaction(() => {
        const changed = db.prepare(
          `UPDATE remote_tasks
              SET state='cancel_requested',cancel_requested_at=?,state_version=state_version+1,updated_at=?
            WHERE remote_task_record_id=? AND state_version=?
              AND state NOT IN ('verified','rejected','cancelled_observed','failed_observed')`,
        ).run(now, now, input.remoteTaskRecordId, input.expectedStateVersion);
        if (changed.changes !== 1) throw new Error('Remote task cancellation conflict');
        appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: `local:cancel-requested:${input.expectedStateVersion}`,
          kind: 'cancel_requested', taskState: 'cancel_requested',
          payloadDigest: digest(`${row.remote_task_id ?? ''}\0${row.request_digest}`),
          observedAt: now,
        });
      })();
      return getRemoteTask(input.remoteTaskRecordId)!;
    },
    markLocallyVerified(input) {
      const row = remoteTaskRow(input.remoteTaskRecordId);
      if (!row) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      assertStoredAuthority(row, input);
      if (row.state !== 'completed_observed') {
        throw new Error('Only a remotely completed observation can be locally verified');
      }
      const now = input.now ?? Date.now();
      db.transaction(() => {
        const verificationId = requireBoundedString(input.verificationId, 'Remote verification identity', 512);
        if (input.evidenceIds.length > 256) throw new Error('Remote verification Evidence set exceeds the bounded limit');
        const evidenceIds = [...new Set(input.evidenceIds.map((id) => (
          requireBoundedString(id, 'Remote verification Evidence identity', 512)
        )))];
        const changed = db.prepare(
          `UPDATE remote_tasks
              SET state='verified',locally_verified=1,verification_id=?,evidence_ids_json=?,
                  state_version=state_version+1,updated_at=?,terminal_at=?
            WHERE remote_task_record_id=? AND state_version=? AND locally_verified=0`,
        ).run(
          verificationId, JSON.stringify(evidenceIds), now, now,
          input.remoteTaskRecordId, input.expectedStateVersion,
        );
        if (changed.changes !== 1) throw new Error('Remote task verification conflict');
        const verificationDigest = digest(`${verificationId}\0${evidenceIds.join('\0')}`);
        appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: `local:verified:${verificationId}`,
          kind: 'verified', taskState: 'verified', payloadDigest: verificationDigest, observedAt: now,
        });
        appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: `local:settled:${verificationId}`,
          kind: 'settled', taskState: 'verified', payloadDigest: verificationDigest, observedAt: now,
        });
      })();
      return getRemoteTask(input.remoteTaskRecordId)!;
    },
    recordRemoteArtifact(input) {
      const task = remoteTaskRow(input.remoteTaskRecordId);
      if (!task) throw new Error(`Remote task not found: ${input.remoteTaskRecordId}`);
      assertStoredAuthority(task, input);
      requireDigest(input.contentDigest, 'Remote artifact content');
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) throw new Error('Remote artifact byte length is invalid');
      const remoteArtifactKey = requireBoundedString(input.remoteArtifactKey, 'Remote artifact key', 512);
      const declaredName = requireBoundedString(input.declaredName, 'Remote artifact name', 512);
      const declaredMediaType = input.declaredMediaType == null
        ? null : requireBoundedString(input.declaredMediaType, 'Remote artifact media type', 256, true);
      const detectedMediaType = input.detectedMediaType == null
        ? null : requireBoundedString(input.detectedMediaType, 'Detected artifact media type', 256, true);
      const rejectionReason = input.rejectionReason == null
        ? null : requireBoundedString(input.rejectionReason, 'Remote artifact rejection reason', 2_048, true);
      const metadataJson = boundedJson(input.metadata ?? {}, 'Remote artifact metadata', 64 * 1024);
      const existing = db.prepare(
        'SELECT * FROM remote_artifacts WHERE remote_task_record_id=? AND remote_artifact_key=?',
      ).get(input.remoteTaskRecordId, remoteArtifactKey) as RemoteArtifactRow | undefined;
      if (existing) {
        if (existing.content_digest !== input.contentDigest
          || existing.byte_length !== input.byteLength
          || existing.quarantine_state !== input.quarantineState) {
          throw new Error('Remote artifact identity conflict');
        }
        return mapRemoteArtifact(existing);
      }
      const now = input.now ?? Date.now();
      const id = `remote_artifact_${digest(`${input.remoteTaskRecordId}\0${remoteArtifactKey}`).slice(0, 32)}`;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO remote_artifacts (
             remote_artifact_id,remote_task_record_id,external_identity_id,remote_artifact_key,
             declared_name,declared_media_type,detected_media_type,byte_length,content_digest,
             quarantine_state,rejection_reason,metadata_json,state_version,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        ).run(
          id, input.remoteTaskRecordId, task.external_identity_id, remoteArtifactKey,
          declaredName, declaredMediaType, detectedMediaType,
          input.byteLength, input.contentDigest, input.quarantineState,
          rejectionReason, metadataJson, now,
        );
        appendRemoteTaskEvent({
          remoteTaskRecordId: input.remoteTaskRecordId,
          remoteEventId: `remote:artifact:${remoteArtifactKey}:${input.contentDigest}`,
          kind: 'artifact_observed', taskState: task.state,
          payloadDigest: digest(`${remoteArtifactKey}\0${input.contentDigest}\0${input.quarantineState}`),
          observedAt: now,
        });
      })();
      return mapRemoteArtifact(remoteArtifactRow(id)!);
    },
    getRemoteArtifact(remoteArtifactId) {
      const row = remoteArtifactRow(remoteArtifactId);
      return row ? mapRemoteArtifact(row) : null;
    },
    listRemoteArtifacts(remoteTaskRecordId) {
      return (db.prepare(
        'SELECT * FROM remote_artifacts WHERE remote_task_record_id=? ORDER BY created_at,remote_artifact_id',
      ).all(remoteTaskRecordId) as RemoteArtifactRow[]).map(mapRemoteArtifact);
    },
    releaseRemoteArtifact(input) {
      const row = remoteArtifactRow(input.remoteArtifactId);
      if (!row) throw new Error(`Remote artifact not found: ${input.remoteArtifactId}`);
      if (row.quarantine_state !== 'quarantined') throw new Error('Only a quarantined artifact can be released');
      const now = input.now ?? Date.now();
      const changed = db.prepare(
        `UPDATE remote_artifacts
            SET quarantine_state='released',artifact_id=?,state_version=state_version+1,released_at=?
          WHERE remote_artifact_id=? AND state_version=? AND quarantine_state='quarantined'`,
      ).run(input.artifactId, now, input.remoteArtifactId, input.expectedStateVersion);
      if (changed.changes !== 1) throw new Error('Remote artifact release conflict');
      return mapRemoteArtifact(remoteArtifactRow(input.remoteArtifactId)!);
    },
  };
}
