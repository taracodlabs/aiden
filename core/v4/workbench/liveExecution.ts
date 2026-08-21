/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';

import type { BrowserSessionRecord, BrowserTabRecord } from '../browser/browserSessionAuthority';
import type { ExternalCodingWorkbenchProjection } from '../coding/projection';
import type { ExternalCodingRawOutputRecord } from '../coding/types';
import { projectExternalCodingSessions } from '../coding/projection';
import type { ArtifactStore } from '../daemon/artifactStore';
import type { JobEngine } from '../daemon/jobEngine';
import type { RunEventRich } from '../daemon/runStore';
import type { RunStore } from '../daemon/runStore';
import { projectWorkbenchJob, type WorkbenchJobProjection } from './projection';

export type ExecutionSurfaceKind =
  | 'terminal' | 'browser' | 'workspace' | 'changes'
  | 'validation' | 'artifact' | 'app_action';

export type ExecutionSurfaceStatus =
  | 'declared' | 'attaching' | 'live' | 'waiting'
  | 'paused' | 'disconnected' | 'closed' | 'failed';

export interface ExecutionSurfaceIdentity {
  surfaceId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  runId: number;
}

export interface TerminalStreamChunk {
  surfaceId: string;
  terminalId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  streamSeq: number;
  encoding: 'utf8';
  stream: 'stdout' | 'stderr' | 'pty';
  data: string;
  timestamp: number;
}

export interface ExecutionSurface extends ExecutionSurfaceIdentity {
  kind: ExecutionSurfaceKind;
  title: string;
  status: ExecutionSurfaceStatus;
  interactive: boolean;
  owner: Readonly<Record<string, string | number | null>>;
  eventCursor: number;
  streamCursor: number;
  snapshotRef: string | null;
  createdAt: number;
  updatedAt: number;
  terminal?: {
    terminalId: string;
    processState: string;
    mode: 'structured' | 'pty';
    cwd: string | null;
    readOnly: true;
    latestStreamSeq: number;
    truncated: boolean;
    chunks: TerminalStreamChunk[];
  };
  browser?: {
    browserSessionId: string;
    tabId: string | null;
    url: string | null;
    title: string | null;
    navigationStatus: string;
    snapshotId: string | null;
    captureAgeMs: number | null;
    stale: boolean;
    frame: { artifactId: string; capturedAt: number } | null;
  };
  workspace?: { workspaceId: string | null; leaseId: string; baseHead: string; baseBranch: string | null; state: string };
  changes?: { paths: string[]; count: number; source: 'reconciliation' };
  validation?: { refs: string[]; count: number; verified: boolean };
  artifact?: { ids: string[]; names: string[]; count: number };
  appAction?: { eventId: number; provider: string; action: string; state: string };
}

export interface LiveExecutionProjection {
  schemaVersion: 1;
  job: {
    jobId: string;
    attemptId: string;
    generation: number;
    runId: number;
    status: string;
    terminal: boolean;
  };
  connection: 'live' | 'settled' | 'degraded';
  activeSurface: ExecutionSurface | null;
  surfaces: ExecutionSurface[];
  progress: Array<{ id: string; sequence: number; type: string; status: string | null; summary: string | null; createdAt: number }>;
  approvals: unknown[];
  artifacts: LiveExecutionArtifact[];
  evidence: unknown[];
  eventCursor: number;
  projectedAt: number;
}

export interface LiveExecutionArtifact {
  id: string;
  name?: string;
  path?: string;
  kind: string;
  tool: string;
  action: string;
  runId: number | null;
  taskId: string | null;
  sessionId: string;
  createdAt: number;
  bytes: number | null;
  preview: string | null;
}

export interface LiveExecutionSource {
  projection: WorkbenchJobProjection;
  runEvents: RunEventRich[];
  codingSessions: ExternalCodingWorkbenchProjection[];
  codingOutput(codingSessionId: string): ExternalCodingRawOutputRecord[];
  browser: { session: BrowserSessionRecord; tabs: BrowserTabRecord[] } | null;
  artifacts: LiveExecutionArtifact[];
}

export interface LiveExecutionRequest {
  jobId: string;
  attemptId: string;
  generation: number;
  runId: number;
}

export interface LiveExecutionProjectionOptions {
  terminalChunkLimit?: number;
  terminalByteLimit?: number;
  progressLimit?: number;
  now?: number;
}

const CREDENTIAL_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi;
const URL_CREDENTIALS = /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi;
const URL_SECRET = /([?&](?:token|key|secret|signature|password|auth|credential)=)[^&#\s]*/gi;
const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g;

/** Redaction runs before terminal data crosses the Workbench projection boundary. */
export function redactTerminalOutput(value: string): string {
  return value
    .replace(BEARER, '$1 [redacted]')
    .replace(CREDENTIAL_ASSIGNMENT, '$1=[redacted]')
    .replace(URL_CREDENTIALS, (match) => match.replace(/\/\/.*@/, '//[redacted]@'))
    .replace(URL_SECRET, '$1[redacted]')
    .replace(KNOWN_TOKEN, '[redacted]');
}

function surfaceIdentity(projection: WorkbenchJobProjection, surfaceId: string): ExecutionSurfaceIdentity {
  return {
    surfaceId,
    jobId: projection.identity.jobId,
    attemptId: projection.identity.attemptId,
    generation: projection.identity.generation,
    runId: projection.identity.runId,
  };
}

function terminalStatus(session: ExternalCodingWorkbenchProjection): ExecutionSurfaceStatus {
  if (session.process?.state === 'unknown') return 'disconnected';
  if (session.process?.state === 'running' || session.process?.state === 'starting') return 'live';
  if (session.state === 'failed') return 'failed';
  if (session.terminalAt !== null || session.process?.state === 'exited') return 'closed';
  return 'waiting';
}

function browserStatus(session: BrowserSessionRecord): ExecutionSurfaceStatus {
  if (session.state === 'initializing') return 'attaching';
  if (session.state === 'ready' || session.state === 'user_control') return 'live';
  if (session.state === 'user_control_required' || session.state === 'reconciling') return 'waiting';
  if (session.state === 'failed') return 'failed';
  if (session.state === 'lost') return 'disconnected';
  return 'closed';
}

function parsePayload(event: RunEventRich): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function artifactName(artifact: LiveExecutionArtifact): string {
  return artifact.name ?? path.basename((artifact.path ?? artifact.id).replace(/\\/g, '/'));
}

function tailWithinUtf8Bytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  const points = Array.from(value);
  while (points.length > 0 && Buffer.byteLength(points.join(''), 'utf8') > limit) points.shift();
  return points.join('');
}

function chooseActiveSurface(surfaces: readonly ExecutionSurface[]): ExecutionSurface | null {
  const priority: ExecutionSurfaceKind[] = ['app_action', 'changes', 'validation', 'browser', 'terminal', 'workspace', 'artifact'];
  return [...surfaces]
    .sort((a, b) => {
      const actionable = (surface: ExecutionSurface) => surface.status === 'live' || surface.status === 'waiting' ? 0 : 1;
      return actionable(a) - actionable(b)
        || priority.indexOf(a.kind) - priority.indexOf(b.kind)
        || b.updatedAt - a.updatedAt
        || a.surfaceId.localeCompare(b.surfaceId);
    })[0] ?? null;
}

export function projectLiveExecution(
  source: LiveExecutionSource,
  request: LiveExecutionRequest = source.projection.identity,
  options: LiveExecutionProjectionOptions = {},
): LiveExecutionProjection | null {
  const identity = source.projection.identity;
  if (request.jobId !== identity.jobId || request.attemptId !== identity.attemptId
    || request.generation !== identity.generation || request.runId !== identity.runId) return null;

  const now = options.now ?? Date.now();
  const terminalChunkLimit = Math.max(1, Math.min(2_000, options.terminalChunkLimit ?? 400));
  const terminalByteLimit = Math.max(1_024, Math.min(2 * 1024 * 1024, options.terminalByteLimit ?? 256 * 1024));
  const surfaces: ExecutionSurface[] = [];
  const exactArtifacts = source.artifacts.filter((artifact) => artifact.taskId === identity.jobId
    && (artifact.runId === null || artifact.runId === identity.runId));

  for (const session of source.codingSessions) {
    const terminalId = `coding:${session.codingSessionId}`;
    const surfaceId = `surface:terminal:${session.codingSessionId}`;
    const allChunks = [...source.codingOutput(session.codingSessionId)].sort((a, b) => a.chunkSequence - b.chunkSequence);
    const chunks: TerminalStreamChunk[] = [];
    let projectedBytes = 0;
    for (const chunk of allChunks.slice(-terminalChunkLimit).reverse()) {
      const redacted = redactTerminalOutput(chunk.content);
      const remaining = terminalByteLimit - projectedBytes;
      if (remaining <= 0) break;
      const data = tailWithinUtf8Bytes(redacted, remaining);
      chunks.unshift({
        surfaceId, terminalId, jobId: identity.jobId, attemptId: identity.attemptId,
        generation: identity.generation, streamSeq: chunk.chunkSequence, encoding: 'utf8',
        stream: chunk.stream, data, timestamp: chunk.createdAt,
      });
      projectedBytes += Buffer.byteLength(data, 'utf8');
    }
    const latestStreamSeq = allChunks.length > 0 ? allChunks[allChunks.length - 1].chunkSequence : 0;
    const latestCodingEvent = session.events.length > 0 ? session.events[session.events.length - 1] : null;
    const terminalSnapshotRef = chunks.length > 0
      ? createHash('sha256').update(chunks.map((chunk) => `${chunk.streamSeq}\0${chunk.stream}\0${chunk.data}`).join('\0')).digest('hex')
      : null;
    surfaces.push({
      ...surfaceIdentity(source.projection, surfaceId), kind: 'terminal', title: 'Terminal',
      status: terminalStatus(session), interactive: false,
      owner: {
        codingSessionId: session.codingSessionId, childJobId: session.childJobId,
        childAttemptId: session.childAttemptId, childGeneration: session.generation,
        processState: session.process?.state ?? null,
      },
      eventCursor: latestCodingEvent?.sequence ?? 0, streamCursor: latestStreamSeq,
      snapshotRef: terminalSnapshotRef,
      createdAt: session.createdAt, updatedAt: session.lastActivityAt,
      terminal: {
        terminalId, processState: session.process?.state ?? 'unavailable', mode: 'structured',
        cwd: null, readOnly: true, latestStreamSeq,
        truncated: allChunks.length > chunks.length || projectedBytes < allChunks.reduce((sum, chunk) => sum + Buffer.byteLength(redactTerminalOutput(chunk.content), 'utf8'), 0)
          || allChunks.some((chunk) => chunk.truncated), chunks,
      },
    });

    if (session.workspace) {
      surfaces.push({
        ...surfaceIdentity(source.projection, `surface:workspace:${session.workspace.workspaceLeaseId}`),
        kind: 'workspace', title: 'Workspace', status: session.workspace.state === 'failed' ? 'failed' : 'live',
        interactive: false, owner: { codingSessionId: session.codingSessionId }, eventCursor: latestCodingEvent?.sequence ?? 0,
        streamCursor: 0, snapshotRef: session.workspace.baseHead, createdAt: session.createdAt, updatedAt: session.lastActivityAt,
        workspace: {
          workspaceId: identity.workspaceId, leaseId: session.workspace.workspaceLeaseId,
          baseHead: session.workspace.baseHead, baseBranch: session.workspace.baseBranch, state: session.workspace.state,
        },
      });
    }
    if (session.changedPaths.length > 0) {
      surfaces.push({
        ...surfaceIdentity(source.projection, `surface:changes:${session.codingSessionId}`),
        kind: 'changes', title: 'Changes', status: session.promotion ? 'waiting' : 'live', interactive: false,
        owner: { codingSessionId: session.codingSessionId, promotionId: session.promotion?.promotionId ?? null },
        eventCursor: latestCodingEvent?.sequence ?? 0, streamCursor: 0,
        snapshotRef: session.promotion?.promotionId ?? null, createdAt: session.createdAt, updatedAt: session.lastActivityAt,
        changes: { paths: [...session.changedPaths], count: session.changedPaths.length, source: 'reconciliation' },
      });
    }
    if (session.validationRefs.length > 0) {
      surfaces.push({
        ...surfaceIdentity(source.projection, `surface:validation:${session.codingSessionId}`),
        kind: 'validation', title: 'Validation', status: session.state === 'failed' ? 'failed' : session.terminalAt ? 'closed' : 'live',
        interactive: false, owner: { codingSessionId: session.codingSessionId },
        eventCursor: latestCodingEvent?.sequence ?? 0, streamCursor: 0,
        snapshotRef: session.validationRefs.length > 0 ? session.validationRefs[session.validationRefs.length - 1] : null, createdAt: session.createdAt, updatedAt: session.lastActivityAt,
        validation: { refs: [...session.validationRefs], count: session.validationRefs.length, verified: session.reconciliation?.safeForIndependentValidation === true },
      });
    }
  }

  if (source.browser && source.browser.session.jobId === identity.jobId
    && source.browser.session.attemptId === identity.attemptId
    && source.browser.session.generation === identity.generation) {
    const session = source.browser.session;
    const tab = source.browser.tabs.find((candidate) => candidate.tabId === session.controlledTabId) ?? null;
    const frameArtifact = [...exactArtifacts]
      .filter((artifact) => artifact.tool === 'browser_screenshot' || artifact.tool === 'screenshot')
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    const observedAt = Math.max(tab?.lastObservedAt ?? 0, frameArtifact?.createdAt ?? 0) || null;
    const captureAgeMs = observedAt === null ? null : Math.max(0, now - observedAt);
    surfaces.push({
      ...surfaceIdentity(source.projection, `surface:browser:${session.browserSessionId}`),
      kind: 'browser', title: 'Browser', status: browserStatus(session),
      interactive: session.state === 'user_control', owner: { browserSessionId: session.browserSessionId, leaseEpoch: session.leaseEpoch },
      eventCursor: session.leaseEpoch, streamCursor: 0, snapshotRef: tab?.lastStateDigest ?? null,
      createdAt: session.createdAt, updatedAt: session.updatedAt,
      browser: {
        browserSessionId: session.browserSessionId, tabId: tab?.tabId ?? null,
        url: tab?.url ?? null, title: tab?.title ?? null, navigationStatus: session.state,
        snapshotId: tab?.lastStateDigest ?? null, captureAgeMs, stale: captureAgeMs !== null && captureAgeMs > 30_000,
        frame: frameArtifact ? { artifactId: frameArtifact.id, capturedAt: frameArtifact.createdAt } : null,
      },
    });
  }

  if (exactArtifacts.length > 0) {
    surfaces.push({
      ...surfaceIdentity(source.projection, `surface:artifact:${identity.jobId}:${identity.runId}`),
      kind: 'artifact', title: 'Artifacts', status: source.projection.receipt.terminal ? 'closed' : 'live', interactive: false,
      owner: { sessionId: identity.sessionId }, eventCursor: source.projection.eventCursor, streamCursor: 0,
      snapshotRef: exactArtifacts.length > 0 ? exactArtifacts[exactArtifacts.length - 1].id : null,
      createdAt: exactArtifacts[0].createdAt, updatedAt: exactArtifacts[exactArtifacts.length - 1].createdAt,
      artifact: { ids: exactArtifacts.map((item) => item.id), names: exactArtifacts.map(artifactName), count: exactArtifacts.length },
    });
  }

  for (const event of source.runEvents.filter((candidate) => candidate.runId === identity.runId
    && (candidate.category === 'integration' || candidate.kind.startsWith('app.')))) {
    const payload = parsePayload(event);
    const provider = typeof payload.provider === 'string' ? payload.provider : event.source ?? 'App';
    surfaces.push({
      ...surfaceIdentity(source.projection, `surface:app:${event.toolCallId ?? event.id}`),
      kind: 'app_action', title: String(provider), status: event.status === 'failed' ? 'failed' : event.status === 'waiting' ? 'waiting' : 'closed',
      interactive: false, owner: { toolCallId: event.toolCallId, eventId: event.id }, eventCursor: event.seq,
      streamCursor: 0, snapshotRef: String(event.id), createdAt: event.ts, updatedAt: event.ts,
      appAction: { eventId: event.id, provider: String(provider), action: event.summary ?? event.name ?? event.kind, state: event.status ?? 'completed' },
    });
  }

  const surfaceMap = new Map<string, ExecutionSurface>();
  for (const surface of surfaces) {
    const existing = surfaceMap.get(surface.surfaceId);
    if (!existing || surface.eventCursor > existing.eventCursor
      || (surface.eventCursor === existing.eventCursor && surface.updatedAt >= existing.updatedAt)) {
      surfaceMap.set(surface.surfaceId, surface);
    }
  }
  const exactSurfaces = Array.from(surfaceMap.values());
  const progressLimit = Math.max(1, Math.min(100, options.progressLimit ?? 20));
  const progressById = new Map<number, RunEventRich>();
  for (const event of source.runEvents) {
    if (event.runId === identity.runId) progressById.set(event.id, event);
  }
  const progress = Array.from(progressById.values())
    .sort((a, b) => a.seq - b.seq || a.id - b.id)
    .slice(-progressLimit)
    .map((event) => ({ id: String(event.id), sequence: event.seq, type: event.kind, status: event.status, summary: event.summary, createdAt: event.ts }));
  const activeSurface = chooseActiveSurface(exactSurfaces);
  return {
    schemaVersion: 1,
    job: {
      jobId: identity.jobId, attemptId: identity.attemptId, generation: identity.generation,
      runId: identity.runId, status: source.projection.receipt.status, terminal: source.projection.receipt.terminal,
    },
    connection: source.projection.receipt.terminal ? 'settled'
      : surfaces.some((surface) => surface.status === 'disconnected') ? 'degraded' : 'live',
    activeSurface,
    surfaces: exactSurfaces,
    progress,
    approvals: source.projection.approvals,
    artifacts: exactArtifacts,
    evidence: source.projection.evidence,
    eventCursor: source.projection.eventCursor,
    projectedAt: now,
  };
}

export interface WorkbenchLiveExecutionPort {
  get(request: LiveExecutionRequest): LiveExecutionProjection | null;
}

/** Adapter over existing durable authorities. It owns no execution state. */
export function createWorkbenchLiveExecutionPort(input: {
  jobs: JobEngine;
  runs: RunStore;
  artifacts?: ArtifactStore;
  now?: () => number;
}): WorkbenchLiveExecutionPort {
  return {
    get(request) {
      const projection = projectWorkbenchJob(input.jobs, request);
      if (!projection || projection.identity.generation !== request.generation) return null;
      const browserSession = input.jobs.browser.getSessionForAttempt(
        request.jobId, request.attemptId, request.generation,
      );
      const artifacts = input.artifacts?.listRecent({ sessionId: projection.identity.sessionId, limit: 500 })
        .map((artifact) => ({ ...artifact })) ?? [];
      return projectLiveExecution({
        projection,
        runEvents: input.runs.listEventsScoped({ scope: 'run_id', runId: request.runId, limit: 5_000 }),
        codingSessions: projectExternalCodingSessions(input.jobs, request.jobId),
        codingOutput: (codingSessionId) => input.jobs.coding.listRawOutput(codingSessionId),
        browser: browserSession ? {
          session: browserSession,
          tabs: input.jobs.browser.listTabs(browserSession.browserSessionId),
        } : null,
        artifacts,
      }, request, { now: input.now?.() });
    },
  };
}
