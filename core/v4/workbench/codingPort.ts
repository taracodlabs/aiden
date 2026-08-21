/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ActionAuthority } from '../actionAuthority';
import type { DurableJobExecutionResult } from '../daemon/jobLifecycle';
import {
  projectExternalCodingSessions,
  type ExternalCodingWorkbenchProjection,
} from '../coding/projection';
import type { ExternalCodingPromotionResult } from '../coding/promotionAuthority';
import type { JobEngine } from '../daemon/jobEngine';
import type {
  ExternalCodingModelHealth,
  ExternalCodingProviderDetection,
  ExternalCodingProviderHealth,
  ExternalCodingProviderVersion,
} from '../coding/provider';

export interface WorkbenchCodingPort {
  health(): Promise<ExternalCodingHealthProjection>;
  configure(input: { model: string }): Promise<ExternalCodingHealthProjection>;
  list(parentJobId: string): ExternalCodingWorkbenchProjection[];
  review(promotionId: string): Promise<ExternalCodingPromotionReview>;
  apply(promotionId: string): Promise<DurableJobExecutionResult<ExternalCodingPromotionResult>>;
  discard(promotionId: string): Promise<DurableJobExecutionResult<ExternalCodingPromotionResult>>;
  discardUnknown(codingSessionId: string): Promise<ExternalCodingDiscardResult>;
}

export interface ExternalCodingDiscardResult {
  readonly codingSessionId: string;
  readonly state: string;
  readonly reconciliationState: string;
  readonly workspaceState: string | null;
}

export interface ExternalCodingHealthProjection {
  readonly ready: boolean;
  readonly state: 'ready' | 'provider_unreachable' | 'unsupported_cli'
    | 'authentication_missing' | 'authentication_invalid' | 'not_configured'
    | 'unsupported_model' | 'model_unavailable_for_auth_mode' | 'sandbox_unavailable' | 'not_checked';
  readonly provider: string;
  readonly executable: string | null;
  readonly executableSource: 'explicit' | 'path' | 'known_installation' | 'unavailable';
  readonly version: string;
  readonly model: string | null;
  readonly modelValidation: ExternalCodingModelHealth['state'] | 'not_configured' | 'not_checked';
  readonly authentication: string;
  readonly authenticationMode: 'api_key' | 'chatgpt_account' | 'not_configured' | 'unknown';
  readonly isolation: 'available' | 'unavailable';
  readonly network: 'disabled_by_default';
  readonly reason: string;
  readonly unsupportedAmbient?: { executable: string; version: string } | null;
}

export function projectExternalCodingHealth(input: {
  provider: string;
  detection: ExternalCodingProviderDetection;
  version: ExternalCodingProviderVersion;
  health: ExternalCodingProviderHealth;
  model: string | null;
  modelHealth: ExternalCodingModelHealth | null;
  isolation: 'available' | 'unavailable';
}): ExternalCodingHealthProjection {
  const ready = input.detection.available
    && input.version.supported
    && input.health.healthy
    && input.model !== null
    && input.modelHealth?.ready === true
    && input.isolation === 'available';
  const reason = !input.detection.available
    ? (input.detection.reason ?? 'External coding provider is unavailable.')
    : !input.version.supported
      ? `Unsupported external coding CLI version ${input.version.raw || input.version.normalized}.`
      : !input.health.healthy
        ? input.health.detail
        : input.model === null
          ? 'External coding model is not configured; set coding.external_model or AIDEN_CODING_MODEL.'
          : !input.modelHealth?.ready
            ? (input.modelHealth?.detail ?? 'The exact configured model has not been validated.')
            : input.isolation === 'unavailable'
              ? 'Independent coding validation is unavailable.'
              : 'External coding is ready with exact-model authentication and isolated validation.';
  const state: ExternalCodingHealthProjection['state'] = !input.detection.available
    ? 'provider_unreachable'
    : !input.version.supported
      ? 'unsupported_cli'
      : input.health.authentication === 'missing'
        ? 'authentication_missing'
        : input.health.authentication === 'invalid'
          ? 'authentication_invalid'
          : input.model === null
            ? 'not_configured'
            : !input.modelHealth?.ready
              ? (input.modelHealth?.state ?? 'not_checked')
              : input.isolation === 'unavailable'
                ? 'sandbox_unavailable'
                : 'ready';
  return {
    ready,
    state,
    provider: input.provider,
    executable: input.detection.executable,
    executableSource: input.detection.source ?? (input.detection.available ? 'path' : 'unavailable'),
    version: input.version.raw || input.version.normalized || 'unavailable',
    model: input.model,
    modelValidation: input.model === null
      ? 'not_configured'
      : (input.modelHealth?.state ?? 'not_checked'),
    authentication: input.health.authentication,
    authenticationMode: input.health.authenticationMode ?? 'unknown',
    isolation: input.isolation,
    network: 'disabled_by_default',
    reason,
    unsupportedAmbient: input.detection.ambientExecutable
      ? { executable: input.detection.ambientExecutable, version: input.detection.ambientVersion ?? 'unknown' }
      : null,
  };
}

export interface ExternalCodingPromotionReviewFile {
  readonly path: string;
  readonly operation: 'create' | 'update' | 'delete';
  readonly before: string | null;
  readonly after: string | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly truncated: boolean;
}

export interface ExternalCodingPromotionReview {
  readonly promotionId: string;
  readonly codingSessionId: string;
  readonly state: string;
  readonly files: readonly ExternalCodingPromotionReviewFile[];
  readonly truncated: boolean;
}

const REVIEW_FILE_LIMIT = 100;
const REVIEW_CONTENT_LIMIT = 128 * 1024;

async function readReviewFile(
  engine: JobEngine,
  snapshotId: string,
  relativePath: string,
): Promise<{ content: string; hash: string; truncated: boolean } | null> {
  try {
    const read = await engine.repository.readFile(snapshotId, relativePath, {
      limit: REVIEW_CONTENT_LIMIT,
    });
    if (read.encoding !== 'utf8' || typeof read.content !== 'string') {
      return { content: '[binary content omitted]', hash: String(read.fullContentHash ?? ''), truncated: true };
    }
    return {
      content: read.content,
      hash: String(read.fullContentHash ?? ''),
      truncated: read.truncated === true,
    };
  } catch {
    return null;
  }
}

export function createWorkbenchCodingPort(input: {
  engine: JobEngine;
  actions: ActionAuthority;
  instanceId: string;
  sessionHomeParent?: string;
  health?: () => Promise<ExternalCodingHealthProjection>;
  configure?: (input: { model: string }) => Promise<ExternalCodingHealthProjection>;
}): WorkbenchCodingPort {
  return {
    async health() {
      return input.health
        ? input.health()
        : {
            ready: false, state: 'not_checked', provider: 'Codex CLI', executable: null, executableSource: 'unavailable',
            version: 'unavailable', model: null, modelValidation: 'not_checked', authentication: 'unknown', authenticationMode: 'unknown', isolation: 'unavailable',
            network: 'disabled_by_default', reason: 'External coding health is unavailable in this runtime.',
          };
    },
    async configure(request) {
      if (!input.configure) throw new Error('External coding configuration is unavailable in this runtime');
      const model = request.model.trim();
      if (!model || model.length > 256) throw new Error('A valid external coding model is required');
      return input.configure({ model });
    },
    list(parentJobId) {
      return projectExternalCodingSessions(input.engine, parentJobId);
    },
    async review(promotionId) {
      const promotion = input.engine.codingPromotions.get(promotionId);
      if (!promotion) throw new Error('Coding promotion was not found');
      const paths = promotion.changedPaths.slice(0, REVIEW_FILE_LIMIT);
      const files = await Promise.all(paths.map(async (relativePath) => {
        const [before, after] = await Promise.all([
          readReviewFile(input.engine, promotion.targetSnapshotId, relativePath),
          readReviewFile(input.engine, promotion.candidateSnapshotId, relativePath),
        ]);
        return {
          path: relativePath,
          operation: before === null ? 'create' as const : after === null ? 'delete' as const : 'update' as const,
          before: before?.content ?? null,
          after: after?.content ?? null,
          beforeHash: before?.hash ?? null,
          afterHash: after?.hash ?? null,
          truncated: before?.truncated === true || after?.truncated === true,
        };
      }));
      return {
        promotionId: promotion.promotionId,
        codingSessionId: promotion.codingSessionId,
        state: promotion.state,
        files,
        truncated: promotion.changedPaths.length > paths.length || files.some((file) => file.truncated),
      };
    },
    apply(promotionId) {
      return input.engine.codingPromotions.apply({
        promotionId,
        ownerId: `workbench-coding:${input.instanceId}`,
        instanceId: input.instanceId,
        actions: input.actions,
        requestApproval: async () => ({
          decision: 'approved',
          decidedBy: 'workbench-user',
          decisionChannel: 'workbench-coding-review',
        }),
      });
    },
    discard(promotionId) {
      return input.engine.codingPromotions.discard({
        promotionId,
        ownerId: `workbench-coding:${input.instanceId}`,
        instanceId: input.instanceId,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench-coding-review',
      });
    },
    async discardUnknown(codingSessionId) {
      if (!input.sessionHomeParent) {
        throw new Error('Coding reconciliation is unavailable in this runtime');
      }
      const session = await input.engine.coding.discardUnknown({
        codingSessionId,
        sessionHomeParent: input.sessionHomeParent,
        decidedBy: 'workbench-user',
        decisionChannel: 'workbench-coding-reconciliation',
        idempotencyKey: `workbench-discard-unknown:${codingSessionId}`,
      });
      return {
        codingSessionId: session.codingSessionId,
        state: session.state,
        reconciliationState: session.reconciliationState,
        workspaceState: input.engine.codingWorkspaces.get(session.workspaceLeaseId)?.state ?? null,
      };
    },
  };
}
