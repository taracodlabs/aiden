/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import {
  externalCodingReconciliationTruth,
  type ExternalCodingMutationReceipt,
  type ExternalCodingReconciliationTruth,
} from './mutationAuthority';
import type { ExternalCodingPromotionPlanRecord } from './promotionAuthority';
import type {
  ExternalCodingEventRecord,
  ExternalCodingProcessRecord,
  ExternalCodingSessionRecord,
  ExternalCodingWorkspaceLeaseRecord,
} from './types';

export interface ExternalCodingProjectionReader {
  coding: {
    listForJob(parentJobId: string): ExternalCodingSessionRecord[];
    listEvents(codingSessionId: string, afterSequence?: number): ExternalCodingEventRecord[];
    getProcess(codingSessionId: string): ExternalCodingProcessRecord | null;
  };
  codingWorkspaces: {
    get(workspaceLeaseId: string): ExternalCodingWorkspaceLeaseRecord | null;
  };
  codingMutations: {
    getForSession(codingSessionId: string): ExternalCodingMutationReceipt | null;
  };
  codingPromotions: {
    getForSession(codingSessionId: string): ExternalCodingPromotionPlanRecord | null;
  };
}

export interface ExternalCodingWorkbenchProjection {
  readonly codingSessionId: string;
  readonly childJobId: string;
  readonly childAttemptId: string;
  readonly generation: number;
  readonly assignmentId: string;
  readonly workerRunId: string;
  readonly state: ExternalCodingSessionRecord['state'];
  readonly reconciliationState: ExternalCodingSessionRecord['reconciliationState'];
  readonly provider: Readonly<{
    id: string;
    version: string;
    protocolMode: string;
    protocolVersion: string;
    capabilityDigest: string;
  }>;
  readonly workspace: Readonly<{
    workspaceLeaseId: string;
    state: ExternalCodingWorkspaceLeaseRecord['state'];
    baseHead: string;
    baseBranch: string | null;
  }> | null;
  readonly process: Readonly<{
    state: ExternalCodingProcessRecord['state'];
    exitCode: number | null;
    exitSignal: string | null;
    treeDeadVerified: boolean;
  }> | null;
  readonly events: readonly ExternalCodingEventRecord[];
  readonly changedPaths: readonly string[];
  readonly mutationState: ExternalCodingMutationReceipt['state'] | null;
  readonly reconciliation: (ExternalCodingReconciliationTruth & Readonly<{
    processTreeSettled: boolean | null;
  }>) | null;
  readonly promotion: ExternalCodingPromotionPlanRecord | null;
  readonly validationRefs: readonly string[];
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly lastActivityAt: number;
  readonly terminalAt: number | null;
}

/** Bounded Workbench projection; raw subprocess output and session HOME stay private. */
export function projectExternalCodingSessions(
  reader: ExternalCodingProjectionReader,
  parentJobId: string,
): ExternalCodingWorkbenchProjection[] {
  return reader.coding.listForJob(parentJobId).map((session) => {
    const workspace = reader.codingWorkspaces.get(session.workspaceLeaseId);
    const processRecord = reader.coding.getProcess(session.codingSessionId);
    const mutation = reader.codingMutations.getForSession(session.codingSessionId);
    const receiptTruth = mutation ? externalCodingReconciliationTruth(mutation) : null;
    const processTreeSettled = processRecord?.treeDeadVerified ?? null;
    const reconciliation = receiptTruth ? {
      ...receiptTruth,
      actualOutcomeKnown: receiptTruth.actualOutcomeKnown && processTreeSettled === true,
      safeForIndependentValidation: receiptTruth.safeForIndependentValidation && processTreeSettled === true,
      processTreeSettled,
    } : null;
    return {
      codingSessionId: session.codingSessionId,
      childJobId: session.childJobId,
      childAttemptId: session.childAttemptId,
      generation: session.childGeneration,
      assignmentId: session.assignmentId,
      workerRunId: session.workerRunId,
      state: session.state,
      reconciliationState: session.reconciliationState,
      provider: {
        id: session.providerId,
        version: session.providerVersion,
        protocolMode: session.protocolMode,
        protocolVersion: session.protocolVersion,
        capabilityDigest: session.capabilityDigest,
      },
      workspace: workspace ? {
        workspaceLeaseId: workspace.workspaceLeaseId,
        state: workspace.state,
        baseHead: workspace.baseHead,
        baseBranch: workspace.baseBranch,
      } : null,
      process: processRecord ? {
        state: processRecord.state,
        exitCode: processRecord.exitCode,
        exitSignal: processRecord.exitSignal,
        treeDeadVerified: processRecord.treeDeadVerified,
      } : null,
      events: reader.coding.listEvents(session.codingSessionId),
      changedPaths: mutation?.changedPaths ?? [],
      mutationState: mutation?.state ?? null,
      reconciliation,
      promotion: reader.codingPromotions.getForSession(session.codingSessionId),
      validationRefs: session.validationRefs,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      terminalAt: session.terminalAt,
    };
  });
}
