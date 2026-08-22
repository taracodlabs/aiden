/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type AutomationTriggerSpec =
  | { kind: 'schedule'; expression: string; timezone: string }
  | { kind: 'webhook'; bindingId: string }
  | { kind: 'app_event'; bindingId: string }
  | { kind: 'file'; bindingId: string }
  | { kind: 'manual' };

export type AutomationActionSpec =
  | { kind: 'prompt'; prompt: string }
  | { kind: 'script'; script: ScriptSpec }
  | { kind: 'delivery'; prompt: string; delivery: AutomationDeliveryTargetSpec };

export interface ScriptSpec {
  version: 1;
  steps: readonly ScriptStep[];
  maxRuntimeMs: number;
}

export type ScriptStep =
  | { kind: 'read_file'; path: string; maxBytes?: number }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'list_directory'; path: string; maxEntries?: number }
  | { kind: 'http_request'; method: 'GET'; url: string };

export type AutomationOverlapPolicy = 'skip' | 'queue' | 'cancel_previous';
export type AutomationMisfirePolicy =
  | { kind: 'skip' }
  | { kind: 'run_once'; maxAgeMs?: number }
  | { kind: 'catch_up'; maxOccurrences: number; maxAgeMs?: number };

export interface AutomationPolicies {
  misfire: AutomationMisfirePolicy;
  overlap: AutomationOverlapPolicy;
  retry: { maxAttempts: number };
}

export interface AutomationBudgetSpec {
  runtimeMs?: number;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  externalCost?: number;
  effects?: number;
}

export interface AutomationApprovalSpec {
  mode: 'policy' | 'always';
}

export interface AutomationDeliveryTargetSpec {
  destinationRef: string;
  providerId: string;
  toolkitId: string;
  actionId: string;
  schemaVersion: string;
  providerActionVersion: string;
  input: Readonly<Record<string, unknown>>;
  /** Optional action-input field populated from the completed work result. */
  contentField?: string;
}

export interface AutomationDeliverySpec extends AutomationDeliveryTargetSpec {
  mode: 'on_success' | 'on_failure' | 'always';
}

export interface AutomationRevisionSpec {
  action: AutomationActionSpec;
  trigger: AutomationTriggerSpec;
  policies: AutomationPolicies;
  capabilities: readonly string[];
  credentialRefs: readonly string[];
  /** Immutable execution root chosen by the trusted host, never by trigger data. */
  workspace?: { rootPath: string };
  budget?: AutomationBudgetSpec;
  approval?: AutomationApprovalSpec;
  delivery?: AutomationDeliverySpec;
}

export interface AutomationDefinitionRecord {
  id: string;
  name: string;
  enabled: boolean;
  currentRevisionId: string;
  ownerId: string;
  workspaceId: string | null;
  commercialContext: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRevisionRecord {
  id: string;
  automationId: string;
  revisionNumber: number;
  spec: AutomationRevisionSpec;
  createdBy: string;
  createdAt: number;
}

export type AutomationOccurrenceState =
  | 'detected' | 'admitted' | 'queued_overlap' | 'skipped_overlap'
  | 'waiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled'
  | 'blocked' | 'unknown';

export interface AutomationOccurrenceRecord {
  id: string;
  occurrenceKey: string;
  automationId: string;
  revisionId: string;
  triggerKind: AutomationTriggerSpec['kind'];
  sourceIdentity: string;
  scheduledFor: string | null;
  triggeredAt: number;
  admittedAt: number | null;
  triggerEventId: number | null;
  jobId: string | null;
  attemptId: string | null;
  state: AutomationOccurrenceState;
  replayOfOccurrenceId: string | null;
  createdAt: number;
  updatedAt: number;
}
