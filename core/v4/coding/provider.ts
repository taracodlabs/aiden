/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type {
  ExternalCodingCandidateResult,
  ExternalCodingCapabilitySnapshot,
  ExternalCodingEventType,
  ExternalCodingInputKind,
  ExternalCodingProcessIdentity,
  ExternalCodingTaskEnvelope,
} from './types';

export interface ExternalCodingProviderDetection {
  readonly available: boolean;
  readonly executable: string | null;
  readonly reason: string | null;
  /** How the executable was selected; omitted by providers without discovery. */
  readonly source?: 'explicit' | 'path' | 'known_installation';
  /** Incompatible PATH executable bypassed in favour of a validated candidate. */
  readonly ambientExecutable?: string | null;
  readonly ambientVersion?: string | null;
}

export interface ExternalCodingProviderHealth {
  readonly healthy: boolean;
  readonly authentication: 'ready' | 'missing' | 'invalid' | 'not_required' | 'unknown';
  readonly authenticationMode?: 'api_key' | 'chatgpt_account' | 'not_configured' | 'unknown';
  readonly detail: string;
}

export type ExternalCodingModelHealthState =
  | 'ready'
  | 'unsupported_model'
  | 'model_unavailable_for_auth_mode'
  | 'authentication_missing'
  | 'authentication_invalid'
  | 'provider_unreachable'
  | 'unsupported_cli';

export interface ExternalCodingModelHealth {
  readonly ready: boolean;
  readonly modelId: string;
  readonly state: ExternalCodingModelHealthState;
  readonly detail: string;
  readonly checkedAt: number;
}

export interface ExternalCodingProviderVersion {
  readonly raw: string;
  readonly normalized: string;
  readonly supported: boolean;
}

export interface ExternalCodingProviderSessionHandle {
  readonly providerSessionId: string;
  readonly codingSessionId: string;
  readonly protocolMode: 'structured' | 'pty';
  readonly processIdentity: ExternalCodingProcessIdentity | null;
  readonly processRecordId?: string | null;
}

export interface ExternalCodingProviderForensicOutput {
  readonly processRecordId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly observedBytes: number;
  readonly storedBytes: number;
  readonly truncated: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly treeDeadVerified: boolean;
}

export interface ExternalCodingProviderStartRequest {
  readonly codingSessionId: string;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  /** Immutable model selection carried by the durable Worker binding. */
  readonly modelId: string;
  readonly workspacePath: string;
  readonly sessionHome: string;
  readonly task: ExternalCodingTaskEnvelope;
  readonly environment: Readonly<Record<string, string>>;
  /** Exact secret values that must be redacted from bounded forensic output. */
  readonly redactionCanaries?: readonly string[];
  readonly sandbox: Readonly<{
    required: true;
    available: boolean;
    network: 'disabled' | 'adapter_only';
  }>;
}

export interface ExternalCodingProviderTaskRequest {
  readonly providerSessionId: string;
  readonly codingSessionId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly modelId: string;
  readonly task: ExternalCodingTaskEnvelope;
}

export interface ExternalCodingProviderInputRequest {
  readonly providerSessionId: string;
  readonly codingSessionId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly sequence: number;
  readonly kind: ExternalCodingInputKind;
  readonly content: string;
}

export interface ExternalCodingProviderEvent {
  readonly providerEventId: string;
  readonly cursor: number;
  readonly type: ExternalCodingEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly observedAt: number;
}

export interface ExternalCodingProviderState {
  readonly state: 'starting' | 'running' | 'waiting' | 'terminal' | 'missing' | 'unknown';
  readonly processIdentity: ExternalCodingProcessIdentity | null;
  readonly lastCursor: number;
  readonly detail: string;
}

export interface ExternalCodingProviderReconciliation {
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'running' | 'not_started' | 'unknown';
  readonly retrySafe: boolean;
  readonly reason: string;
  readonly observedProcessTreeDead: boolean | null;
  readonly result: ExternalCodingCandidateResult | null;
}

/**
 * A persistent coding runtime contract. It is deliberately separate from the
 * ordinary model request/response provider abstraction.
 */
export interface ExternalCodingAgentProvider {
  readonly id: string;
  readonly label: string;
  detect(): Promise<ExternalCodingProviderDetection>;
  health(): Promise<ExternalCodingProviderHealth>;
  /** Bounded, content-free execution probe for the exact configured model. */
  validateModel?(modelId: string): Promise<ExternalCodingModelHealth>;
  version(): Promise<ExternalCodingProviderVersion>;
  capabilities(): Promise<ExternalCodingCapabilitySnapshot>;
  startSession(request: ExternalCodingProviderStartRequest): Promise<ExternalCodingProviderSessionHandle>;
  sendTask(request: ExternalCodingProviderTaskRequest): Promise<void>;
  sendInput(request: ExternalCodingProviderInputRequest): Promise<void>;
  events(providerSessionId: string, afterCursor: number): Promise<readonly ExternalCodingProviderEvent[]>;
  cancel(providerSessionId: string, reason: string): Promise<void>;
  terminate(providerSessionId: string): Promise<void>;
  inspectState(providerSessionId: string): Promise<ExternalCodingProviderState>;
  collectResult(providerSessionId: string): Promise<ExternalCodingCandidateResult | null>;
  reconcile(providerSessionId: string): Promise<ExternalCodingProviderReconciliation>;
  forensicOutput?(providerSessionId: string): Promise<ExternalCodingProviderForensicOutput | null>;
  close(providerSessionId: string): Promise<void>;
}

export interface ExternalCodingProviderSelection {
  readonly provider: ExternalCodingAgentProvider;
  readonly detection: ExternalCodingProviderDetection;
  readonly health: ExternalCodingProviderHealth;
  readonly version: ExternalCodingProviderVersion;
  readonly capability: ExternalCodingCapabilitySnapshot;
}

export class ExternalCodingProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingProviderError';
  }
}
