/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export const CAPABILITY_MANIFEST_VERSION = 1 as const;
export const CAPABILITY_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: JsonValue[];
  const?: JsonValue;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

export type CapabilityPermissionKind =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'network.egress'
  | 'secret.use'
  | 'process.spawn'
  | 'artifact.create'
  | 'app.action';

export interface CapabilityPermissionScope {
  paths?: string[];
  hosts?: string[];
  secretSlots?: string[];
  applications?: string[];
}

export interface CapabilityPermissionDeclaration {
  kind: CapabilityPermissionKind;
  scope: CapabilityPermissionScope;
}

export interface CapabilityEffectDeclaration {
  tool: string;
  kind: string;
  approval: 'policy' | 'required';
  reversible: boolean;
}

export interface CapabilitySecretSlot {
  id: string;
  description?: string;
  provider?: string;
  required: boolean;
}

export interface CapabilityCompatibility {
  aiden: string;
  node: string;
  os: Array<'win32' | 'linux' | 'darwin'>;
  architectures: Array<'x64' | 'arm64'>;
}

export interface CapabilityLimits {
  runtimeMs: number;
  maxMessageBytes: number;
  maxTotalOutputBytes: number;
  maxBrokerRequests: number;
  maxEvidenceClaims: number;
}

export interface CapabilityToolDeclaration {
  name: string;
  description: string;
  mutates: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export interface CapabilityManifest {
  manifestVersion: typeof CAPABILITY_MANIFEST_VERSION;
  id: string;
  version: string;
  displayName: string;
  description?: string;
  runtime: {
    kind: 'node';
    protocolVersion: typeof CAPABILITY_PROTOCOL_VERSION;
  };
  entrypoint: string;
  tools: CapabilityToolDeclaration[];
  permissions: CapabilityPermissionDeclaration[];
  effects: CapabilityEffectDeclaration[];
  secretSlots: CapabilitySecretSlot[];
  compatibility: CapabilityCompatibility;
  limits: CapabilityLimits;
  digest: string;
}

export interface CapabilityIdentity {
  capabilityId: string;
  version: string;
  manifestVersion: number;
  protocolVersion: number;
  digest: string;
}

export type HostCapabilityMessage =
  | CapabilityHelloMessage
  | CapabilityInvokeMessage
  | CapabilityBrokerResultMessage
  | CapabilityCancelMessage
  | CapabilityShutdownMessage;

export type ChildCapabilityMessage =
  | CapabilityHelloMessage
  | CapabilityBrokerRequestMessage
  | CapabilityProgressMessage
  | CapabilityEvidenceClaimMessage
  | CapabilityResultMessage
  | CapabilityErrorMessage;

export interface CapabilityMessageBase {
  type: string;
  sequence: number;
  invocationId: string;
  identity: CapabilityIdentity;
}

export interface CapabilityHelloMessage extends CapabilityMessageBase {
  type: 'HELLO';
  protocolVersion: number;
  nonce: string;
}

export interface CapabilityInvokeMessage extends CapabilityMessageBase {
  type: 'INVOKE';
  tool: string;
  input: JsonValue;
}

export interface CapabilityBrokerRequestMessage extends CapabilityMessageBase {
  type: 'BROKER_REQUEST';
  requestId: string;
  operation: 'filesystem.read' | 'filesystem.list' | 'filesystem.write' | 'artifact.create';
  resource: string;
  arguments: Record<string, JsonValue>;
  effectId?: string;
}

export interface CapabilityBrokerResultMessage extends CapabilityMessageBase {
  type: 'BROKER_RESULT';
  requestId: string;
  ok: boolean;
  value?: JsonValue;
  error?: { code: string; message: string };
  authority?: {
    toolCallId: string;
    effectId?: string;
    evidenceIds: string[];
  };
}

export interface CapabilityProgressMessage extends CapabilityMessageBase {
  type: 'PROGRESS';
  message: string;
}

export interface CapabilityEvidenceClaimMessage extends CapabilityMessageBase {
  type: 'EVIDENCE_CLAIM';
  claimId: string;
  category: string;
  statement: string;
  references?: string[];
}

export interface CapabilityResultMessage extends CapabilityMessageBase {
  type: 'RESULT';
  output: JsonValue;
}

export interface CapabilityErrorMessage extends CapabilityMessageBase {
  type: 'ERROR';
  code: string;
  message: string;
  outcome: 'failed' | 'unknown';
}

export interface CapabilityCancelMessage extends CapabilityMessageBase {
  type: 'CANCEL';
  reason: string;
}

export interface CapabilityShutdownMessage extends CapabilityMessageBase {
  type: 'SHUTDOWN';
}

export interface CapabilityExecutionContext {
  readonly invocationId: string;
  readonly signal: AbortSignal;
  progress(message: string): void;
  claimEvidence(claim: {
    claimId: string;
    category: string;
    statement: string;
    references?: string[];
  }): void;
  broker(request: {
    requestId: string;
    operation: CapabilityBrokerRequestMessage['operation'];
    resource: string;
    arguments?: Record<string, JsonValue>;
  }): Promise<JsonValue>;
}

export type CapabilityToolImplementation = (
  input: JsonValue,
  context: CapabilityExecutionContext,
) => Promise<JsonValue> | JsonValue;

export interface CapabilityModule {
  tools: Record<string, CapabilityToolImplementation>;
}
