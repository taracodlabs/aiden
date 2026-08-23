/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

/** A run event exactly as the Workbench bridge streams it. */
export interface V4Event {
  id: number;
  runId: number;
  sessionId: string | null;
  ts: number;
  category: string;
  kind: string;
  name: string | null;
  status: string | null;
  durationMs: number | null;
  summary: string | null;
  payload: any;
  seq?: number;
  turnId?: string | null;
  toolCallId?: string | null;
  parentEventId?: number | null;
}

export interface SessionSummary {
  id: string;
  label: string;
  lastActive: number;
  provider?: string | null;
  model?: string | null;
}

export interface ActivityItem {
  id: string;
  eventId: number;
  kind: 'tool' | 'verify' | 'note' | 'worker' | 'skill';
  label: string;
  detail?: string;
  status: 'running' | 'ok' | 'failed' | 'warn';
  durationMs?: number | null;
}

export type WorkbenchConnectionState =
  | 'connected' | 'reconnecting' | 'stalled' | 'uncertain' | 'terminal';

export interface TurnHandlers {
  onAdmission?: (admission: TaskAdmission) => void;
  onReattached?: (admission: TaskAdmission) => void;
  onRunId?: (runId: number) => void;
  onReply?: (chunk: string) => void;
  /** Idempotent durable replacement used when terminal reconciliation repairs
   * missed or reordered live chunks. */
  onReplySnapshot?: (content: string) => void;
  onThinking?: (stage: string, message: string) => void;
  onActivity?: (item: ActivityItem) => void;
  onTokens?: (total: number) => void;
  onDone?: (info: { stopped?: boolean; summary?: string; status?: string }) => void;
  onError?: (message: string) => void;
  onConnectionState?: (state: WorkbenchConnectionState) => void;
}

/** Exact durable identity returned by task admission. Event order is never an
 * identity source. */
export interface TaskAdmission {
  accepted: true;
  jobId: string;
  attemptId: string;
  runId: number;
  triggerEventId?: number;
  duplicate: boolean;
}

/** Reload-safe client handle. Presentation is rebuilt from durable records. */
export interface WorkbenchRunHandle {
  admission: TaskAdmission;
  lastEventId: number;
}

const ACTIVE_RUN_STORAGE_KEY = 'aiden.workbench.active-run.v1';

function admissionFromSearch(search: string): TaskAdmission | null {
  const query = new URLSearchParams(search);
  const jobId = requiredString(query.get('job'));
  const attemptId = requiredString(query.get('attempt'));
  const runRaw = query.get('run');
  const runId = runRaw === null ? Number.NaN : Number(runRaw);
  if (!jobId || !attemptId || !Number.isSafeInteger(runId) || runId < 0) return null;
  return { accepted: true, jobId, attemptId, runId, duplicate: false };
}

export function persistRunHandle(handle: WorkbenchRunHandle): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(handle));
  if (window.location && window.history?.replaceState) {
    const next = new URL(window.location.href);
    next.searchParams.set('job', handle.admission.jobId);
    next.searchParams.set('attempt', handle.admission.attemptId);
    next.searchParams.set('run', String(handle.admission.runId));
    window.history.replaceState(window.history.state, '', next);
  }
}

export function clearRunHandle(expected?: Pick<TaskAdmission, 'jobId' | 'attemptId' | 'runId'>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (expected) {
    const raw = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
    try {
      const stored = raw ? JSON.parse(raw) as { admission?: Partial<TaskAdmission> } : {};
      if (stored.admission?.jobId !== expected.jobId
        || stored.admission?.attemptId !== expected.attemptId
        || stored.admission?.runId !== expected.runId) return;
    } catch { return; }
  }
  window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
  // Settling an exact restore handle must not erase the durable selection.
  // The Job/Attempt/run deep link remains the authority for terminal projection
  // and browser navigation; only an unscoped stale-handle cleanup owns URL
  // removal.
  if (expected) return;
  if (window.location && window.history?.replaceState) {
    const next = new URL(window.location.href);
    next.searchParams.delete('job');
    next.searchParams.delete('attempt');
    next.searchParams.delete('run');
    window.history.replaceState(window.history.state, '', next);
  }
}

export function restoreRunHandle(): WorkbenchRunHandle | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  const linked = window.location ? admissionFromSearch(window.location.search) : null;
  const raw = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
  if (!raw) return linked ? { admission: linked, lastEventId: 0 } : null;
  try {
    const value = JSON.parse(raw) as { admission?: unknown; lastEventId?: unknown };
    const stored = value.admission && typeof value.admission === 'object'
      ? value.admission as Record<string, unknown> : {};
    const admission = parseTaskAdmission({
      accepted: stored.accepted,
      job_id: stored.jobId,
      attempt_id: stored.attemptId,
      run_id: stored.runId,
      triggerEventId: stored.triggerEventId,
      duplicate: stored.duplicate,
    });
    const lastEventId = typeof value.lastEventId === 'number'
      && Number.isSafeInteger(value.lastEventId) && value.lastEventId >= 0
      ? value.lastEventId : 0;
    if (linked && (
      linked.jobId !== admission.jobId
      || linked.attemptId !== admission.attemptId
      || linked.runId !== admission.runId
    )) return { admission: linked, lastEventId: 0 };
    return { admission: linked ?? admission, lastEventId };
  } catch {
    window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
    return linked ? { admission: linked, lastEventId: 0 } : null;
  }
}

export interface WorkbenchResultReceipt {
  terminal: boolean;
  status: string;
  summary?: string | null;
  stopped?: boolean;
  verdict?: { verdict: string } | null;
}

export interface WorkbenchRunProjection {
  identity: { jobId: string; attemptId: string; runId: number; generation?: number };
  job?: { id?: string; status?: string; terminalOutcome?: string | null; finishReason?: string | null };
  receipt: WorkbenchResultReceipt;
  attempts?: Array<{ rowId?: number; id: string; generation: number; status: string }>;
  timeline?: Array<{ eventId: number; jobSequence: number; type: string; createdAt: number }>;
  workers?: unknown[];
  approvals?: Array<{
    approval_id?: unknown; job_id?: unknown; attempt_id?: unknown; generation?: unknown;
    tool_call_id?: unknown; effect_id?: unknown; tool_name?: unknown; risk_tier?: unknown;
    normalized_execution_plan?: unknown; state?: unknown; requested_at?: unknown;
  }>;
  evidence?: unknown[];
  verification?: unknown;
  assistantOutput?: Array<{ eventId: number; sequence: number; text: string }>;
}

export type ExecutionSurfaceKind = 'terminal' | 'browser' | 'workspace' | 'changes' | 'validation' | 'artifact' | 'app_action';
export type ExecutionSurfaceStatus = 'declared' | 'attaching' | 'live' | 'waiting' | 'paused' | 'disconnected' | 'closed' | 'failed';

export interface WorkbenchExecutionSurface {
  surfaceId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  runId: number;
  kind: ExecutionSurfaceKind;
  title: string;
  status: ExecutionSurfaceStatus;
  interactive: boolean;
  owner: Record<string, string | number | null>;
  eventCursor: number;
  streamCursor: number;
  snapshotRef: string | null;
  createdAt: number;
  updatedAt: number;
  terminal?: {
    terminalId: string; processState: string; mode: 'structured' | 'pty'; cwd: string | null;
    readOnly: true; latestStreamSeq: number; truncated: boolean;
    chunks: Array<{ streamSeq: number; stream: 'stdout' | 'stderr' | 'pty'; data: string; timestamp: number }>;
  };
  browser?: {
    browserSessionId: string; tabId: string | null; url: string | null; title: string | null;
    navigationStatus: string; snapshotId: string | null; captureAgeMs: number | null; stale: boolean;
    frame: { artifactId: string; capturedAt: number } | null;
  };
  workspace?: { workspaceId: string | null; leaseId: string; baseHead: string; baseBranch: string | null; state: string };
  changes?: { paths: string[]; count: number; source: 'reconciliation' };
  validation?: { refs: string[]; count: number; verified: boolean };
  artifact?: { ids: string[]; names: string[]; count: number };
  appAction?: { eventId: number; provider: string; action: string; state: string };
}

export interface WorkbenchLiveExecutionProjection {
  schemaVersion: 1;
  job: { jobId: string; attemptId: string; generation: number; runId: number; status: string; terminal: boolean };
  connection: 'live' | 'settled' | 'degraded';
  activeSurface: WorkbenchExecutionSurface | null;
  surfaces: WorkbenchExecutionSurface[];
  progress: Array<{ id: string; sequence: number; type: string; status: string | null; summary: string | null; createdAt: number }>;
  approvals: unknown[];
  artifacts: WorkbenchArtifact[];
  evidence: unknown[];
  eventCursor: number;
  projectedAt: number;
}

export interface WorkbenchAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface WorkbenchArtifact {
  id: string;
  name: string;
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

export interface ExternalCodingHealth {
  ready: boolean;
  state: 'ready' | 'provider_unreachable' | 'unsupported_cli' | 'authentication_missing'
    | 'authentication_invalid' | 'not_configured' | 'unsupported_model'
    | 'model_unavailable_for_auth_mode' | 'sandbox_unavailable' | 'not_checked';
  provider: string;
  executable: string | null;
  executableSource: 'explicit' | 'path' | 'known_installation' | 'unavailable';
  version: string;
  model: string | null;
  modelValidation: 'ready' | 'unsupported_model' | 'model_unavailable_for_auth_mode' | 'authentication_missing' | 'authentication_invalid' | 'provider_unreachable' | 'unsupported_cli' | 'not_configured' | 'not_checked';
  authentication: string;
  authenticationMode: 'api_key' | 'chatgpt_account' | 'not_configured' | 'unknown';
  isolation: 'available' | 'unavailable';
  network: 'disabled_by_default';
  reason: string;
  unsupportedAmbient?: { executable: string; version: string } | null;
}

export interface WorkbenchCapabilities {
  modelSwitch: { available: boolean; reason?: string };
  skills: Array<{ name: string; description: string; version: string; category?: string; trustLevel?: string; readiness?: unknown }>;
  plugins: Array<{ name: string; version: string; description: string; author?: string; status: string; permissions: string[] }>;
  extensions?: CapabilityExtensionsSnapshot;
}

export interface CapabilityExtensionItem {
  capabilityId: string;
  displayName: string;
  active: null | { version: string; digest: string; enabled: boolean };
  rollbackTarget: null | { version: string; digest: string };
  health: null | { state: string; consecutiveFailures: number; reason: string | null; checkedAt: number };
  requestedPermissions: Array<{ kind: string; scope: Record<string, unknown> }>;
  grantedPermissions: Array<{ permission: string; scope: Record<string, unknown> }>;
  permissionChanges: {
    added: Array<{ kind: string; scope: Record<string, unknown> }>;
    removed: Array<{ kind: string; scope: Record<string, unknown> }>;
  };
  versions: Array<{ version: string; digest: string; installedAt: number }>;
  recentInvocations: Array<{
    invocationId: string; version: string; digest: string; state: string;
    startedAt: number; terminalAt: number | null;
  }>;
}

export interface CapabilityExtensionsSnapshot {
  executionEnabled: boolean;
  sandbox: { available: boolean; mechanism: 'docker'; image: string; reason?: string };
  items: CapabilityExtensionItem[];
}

export interface WorkbenchSkillStep {
  id: string;
  operation: string;
  kind: 'tool' | 'skill';
  mutates: boolean;
  childSkillVersionId?: string;
  fallbackStepIds?: string[];
}

export interface WorkbenchSkillCapabilityRequirement {
  capabilityId: string;
  versionRange?: string;
  requiredPermissions: string[];
  required: boolean;
  fallbackGroup?: string;
}

export interface WorkbenchSkillCandidate {
  id: string; scopeId: string; patternId: string; digest: string; proposedName: string; purpose: string;
  steps: WorkbenchSkillStep[]; capabilityRequirements: WorkbenchSkillCapabilityRequirement[];
  positiveTraceIds: string[]; negativeTraceIds: string[]; learningEntryIds: string[];
  state: 'candidate' | 'accepted' | 'dismissed' | 'stale'; executable: false; stateVersion: number;
  createdAt: number; updatedAt: number;
}

export interface WorkbenchSkillDraft {
  id: string; skillId: string; candidateId: string | null; scopeId: string; name: string; description: string;
  steps: WorkbenchSkillStep[]; capabilityRequirements: WorkbenchSkillCapabilityRequirement[];
  composition: string[]; expectedEvidence: string[]; digest: string;
  state: 'draft' | 'evaluating' | 'evaluated' | 'stale' | 'archived'; executable: false;
  stateVersion: number; createdAt: number; updatedAt: number;
}

export interface WorkbenchSkillEvaluation {
  id: string; draftId: string; draftDigest: string; digest: string; evaluatorVersion: number;
  capabilityEnvironmentDigest: string;
  sourceFixtureDigest: string;
  sourceFixtures: Array<{
    traceId: string;
    classification: 'positive' | 'negative';
    sourceDigest: string;
    evidenceIds: string[];
  }>;
  checks: Array<{ code: string; passed: boolean; detail: string }>;
  passed: boolean; state: 'running' | 'passed' | 'failed' | 'interrupted';
  startedAt: number; completedAt: number | null;
}

export interface WorkbenchSkillApproval {
  id: string; skillId: string; draftId: string; evaluationId: string; scopeId: string;
  draftDigest: string; evaluationDigest: string; capabilityRequirementsDigest: string;
  state: 'pending' | 'approved' | 'denied' | 'stale'; requestedAt: number; decidedAt: number | null;
  stateVersion: number;
}

export interface WorkbenchSkillVersion {
  id: string; skillId: string; version: number; digest: string;
  canonicalSpec: Record<string, unknown>;
  capabilityRequirements: WorkbenchSkillCapabilityRequirement[]; composition: string[];
  evaluationId: string | null; approvalId: string | null; patternId: string | null; candidateId: string | null;
  sourceKind: 'intelligence' | 'legacy'; legacy: boolean; createdAt: number;
}

export interface WorkbenchSkillActiveItem {
  pointer: {
    skillId: string; scopeId: string; skillVersionId: string; digest: string; enabled: boolean;
    driftState: 'clean' | 'drifted' | 'missing' | 'unknown'; stateVersion: number; activatedAt: number;
  };
  version: WorkbenchSkillVersion;
  versions: WorkbenchSkillVersion[];
  health: { state: 'insufficient_data' | 'healthy' | 'degraded' | 'disabled'; attributableSamples: number; successes: number; failures: number; unknowns: number; failureRate: number | null };
  outcomes: Array<{ id: string; skillVersionId: string; outcome: string; verdict: string; attributable: boolean; reason: string | null; recordedAt: number }>;
  rollbackTarget: WorkbenchSkillVersion | null;
}

export interface WorkbenchSkillIntelligenceSnapshot {
  enabled: boolean;
  doctor: { enabled: boolean; schemaReady: boolean; traces: number; patterns: number; candidates: number; drafts: number; active: number; degraded: number; drifted: number; prerequisiteIssues: number };
  candidates: WorkbenchSkillCandidate[];
  drafts: WorkbenchSkillDraft[];
  evaluations: WorkbenchSkillEvaluation[];
  approvals: WorkbenchSkillApproval[];
  active: WorkbenchSkillActiveItem[];
}

export interface WorkbenchSkillCandidateReview {
  candidate: WorkbenchSkillCandidate;
  pattern: { objectiveClass: string; observedCount: number; verifiedCount: number; failureCount: number; unknownCount: number; confidence: number };
  traces: Array<{ id: string; classification: 'positive' | 'negative' | 'unknown'; verdict: string; evidenceIds: string[]; observedAt: number }>;
}

export interface WorkbenchAppProvider {
  id: string;
  label: string;
  health: string;
  detail?: string;
}

export interface WorkbenchAppToolkit {
  providerId: string;
  toolkitId: string;
  label: string;
}

export interface WorkbenchConnectedAccount {
  accountId: string;
  providerId: string;
  toolkitId: string;
  label: string;
  status: string;
  health: string;
  scopes: string[];
  lastCheckedAt: number | null;
}

export interface WorkbenchAppsSnapshot {
  providers: WorkbenchAppProvider[];
  toolkits: WorkbenchAppToolkit[];
  accounts: WorkbenchConnectedAccount[];
  configuration: { workbench: boolean; command?: string };
}

export interface WorkbenchAutomationSummary {
  automationId: string;
  name: string;
  enabled: boolean;
  revisionId: string;
  revisionNumber: number;
  trigger: { kind: string; expression?: string; timezone?: string };
  nextFireAt: string | null;
  lastOccurrence: { occurrenceId: string; state: string; jobId: string | null; createdAt: number } | null;
}

export interface WorkbenchAutomationSnapshot {
  capability: { available: boolean; reason?: string };
  scheduler: { ready: boolean; dueBindings: number };
  automations: WorkbenchAutomationSummary[];
  history: WorkbenchAutomationOccurrence[];
  attention: Array<{ automationId: string; state: string; occurrenceId: string }>;
}

export interface WorkbenchAutomationOccurrence {
  occurrenceId: string;
  automationId: string;
  revisionId: string;
  triggerKind: string;
  scheduledFor: string | null;
  triggeredAt: number;
  admittedAt: number | null;
  jobId: string | null;
  attemptId: string | null;
  state: string;
  replayOfOccurrenceId: string | null;
  updatedAt: number;
  detail: {
    reason?: string;
    delivery?: { state: 'completed' | 'failed' | 'unknown'; detail?: string; updatedAt?: number };
  };
}

export interface WorkbenchAppConnection {
  connectionId: string;
  authorizationUrl?: string;
  userCode?: string;
  expiresAt?: number;
}

export interface WorkbenchProviderModel {
  id: string;
  displayName: string;
  contextLength?: number;
  supportsToolCalling?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  available: boolean;
}

export interface WorkbenchProviderProjection {
  id: string;
  displayName: string;
  description: string;
  authKinds: Array<'oauth' | 'api_key' | 'local' | 'device_code' | 'subscription' | 'none'>;
  requiredFields: string[];
  actions: Array<'connect' | 'disconnect' | 'replaceCredential' | 'test' | 'refreshModels'>;
  connectionState: 'connected' | 'not_configured' | 'needs_attention' | 'local_ready' | 'local_unavailable';
  configured: boolean;
  healthy: boolean;
  credentialHint?: string;
  account?: string;
  models: WorkbenchProviderModel[];
  currentModel: string | null;
  default: boolean;
  detail?: string;
}

export interface WorkbenchProviderSnapshot {
  providers: WorkbenchProviderProjection[];
  defaultSelection: { providerId: string; modelId: string } | null;
  sessionSelection: { sessionId: string; providerId: string; modelId: string } | null;
  secretStorage: { backend: string; available: boolean; protectedByOs: boolean; detail: string };
}

export interface WorkbenchAuthSession {
  authSessionId: string;
  providerId: string;
  method: 'oauth' | 'device_code';
  state: 'starting' | 'waiting_for_user' | 'connected' | 'failed' | 'expired';
  createdAt: number;
  expiresAt: number;
  verificationUri?: string;
  userCode?: string;
  account?: string;
  detail?: string;
}

export interface SystemReadinessItem {
  id: string;
  category: 'chat' | 'coding' | 'browser' | 'validation' | 'apps' | 'workspace' | 'approvals' | 'evidence';
  state: 'ready' | 'setup_available' | 'needs_setup' | 'needs_attention' | 'unavailable' | 'checking' | 'degraded';
  title: string;
  detail: string;
  configured: boolean;
  available: boolean;
  healthy: boolean;
  blocking: boolean;
  severity: 'info' | 'warning' | 'error';
  availableActions: string[];
  checkedAt: number;
}

export interface SystemReadinessProjection {
  overall: 'ready' | 'needs_attention';
  items: SystemReadinessItem[];
  issues: SystemReadinessItem[];
  checkedAt: number;
}

export interface WorkbenchBrowserSetup {
  ready: boolean;
  detail: string;
  grantRequired: boolean;
  permissions: string[];
}

export interface WorkbenchBrowserSession {
  browserSessionId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  workspaceId: string | null;
  mode: 'owned' | 'attached';
  profileIdentity: string;
  state: 'initializing' | 'ready' | 'user_control_required' | 'user_control'
    | 'reconciling' | 'closing' | 'closed' | 'lost' | 'failed' | 'cancelled';
  controlledTabId: string | null;
  recoveryState: string;
  leaseEpoch: number;
  usage: Record<string, number>;
  budget: Record<string, number>;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface WorkbenchCodingPromotion {
  promotionId: string;
  state: 'prepared' | 'approval_required' | 'approved' | 'applying' | 'applied' | 'blocked_drift' | 'rejected' | 'unknown';
  changedPaths: string[];
  validationRefs: string[];
  blockedReason: string | null;
}

export interface WorkbenchCodingSession {
  codingSessionId: string;
  childJobId: string;
  childAttemptId: string;
  generation: number;
  assignmentId: string;
  workerRunId: string;
  state: string;
  reconciliationState: string;
  provider: { id: string; version: string; protocolMode: string; protocolVersion: string; capabilityDigest: string };
  workspace: { workspaceLeaseId: string; state: string; baseHead: string; baseBranch: string | null } | null;
  process: { state: string; exitCode: number | null; exitSignal: string | null; treeDeadVerified: boolean } | null;
  events: Array<{ eventId: string; sequence: number; type: string; payload: Record<string, unknown>; createdAt: number }>;
  changedPaths: string[];
  mutationState: string | null;
  reconciliation: {
    actualOutcomeKnown: boolean;
    providerReportMatches: boolean;
    actualChangedFiles: string[];
    reportedChangedFiles: string[];
    mismatchReasons: string[];
    protectedPathsIntact: boolean;
    workspaceContained: boolean;
    safeForIndependentValidation: boolean;
    processTreeSettled: boolean | null;
  } | null;
  promotion: WorkbenchCodingPromotion | null;
  validationRefs: string[];
  createdAt: number;
  startedAt: number | null;
  lastActivityAt: number;
  terminalAt: number | null;
}

export interface WorkbenchCodingReviewFile {
  path: string;
  operation: 'create' | 'update' | 'delete';
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  truncated: boolean;
}

export interface WorkbenchCodingReview {
  promotionId: string;
  codingSessionId: string;
  state: string;
  files: WorkbenchCodingReviewFile[];
  truncated: boolean;
}

export function assistantOutputText(projection: WorkbenchRunProjection): string {
  const seen = new Set<number>();
  return [...(projection.assistantOutput ?? [])]
    .sort((a, b) => a.sequence - b.sequence || a.eventId - b.eventId)
    .filter((chunk) => {
      if (seen.has(chunk.eventId)) return false;
      seen.add(chunk.eventId);
      return true;
    })
    .map((chunk) => chunk.text)
    .join('');
}

export interface WorkbenchRuntimeInfo {
  service: 'aiden-workbench-bridge';
  version: string;
  readOnly: boolean;
}

export interface WorkbenchBootstrap {
  runtime: { version: string; status: string; local: boolean; edition: 'community' | 'pro' | 'team' | 'enterprise' };
  provider: { configured?: boolean; id?: string; displayName?: string };
  model: { id?: string; displayName?: string };
  connection: 'connected' | 'unavailable' | 'reconnecting';
  readOnly: boolean;
  activeJobCount: number;
  execution: {
    available: boolean;
    runner: 'real' | 'unavailable';
    workerCount: number;
    pending: number;
    claimed: number;
    inflight: number;
    oldestPendingMs: number | null;
    processed: number;
  };
  activeJobs: Array<{
    sessionId: string | null;
    jobId: string;
    attemptId: string | null;
    runId: number | null;
    status: string;
    title?: string;
    statusDetail?: string;
    updatedAt: number;
    triggerEventId: number | null;
    triggerStatus: string | null;
    queue?: { pending: number; claimed: number; oldestPendingMs: number | null };
  }>;
}

export interface ContinuityCheckpointView {
  checkpointId: string;
  jobId: string;
  attemptId: string;
  attemptGeneration: number;
  reason: string;
  validity: string;
  blockers: string[];
  proposedNext: string[];
}

function token(): string {
  if (typeof window === 'undefined') return '';
  return (window as any).__WB_TOKEN__ || '';
}

export function hasWriteToken(): boolean { return token().length > 0; }

export async function listSessions(): Promise<SessionSummary[]> {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return [];
    const value = await response.json();
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export async function cancelTask(target: number | WorkbenchRunHandle | null): Promise<boolean> {
  const runId = typeof target === 'number' ? target : target?.admission.runId ?? null;
  if (runId == null) return false;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(String(runId))}/cancel`, {
      method: 'POST', headers: { 'x-workbench-token': token() },
    });
    if (!response.ok) return false;
    const body = await response.json() as { accepted?: unknown; runId?: unknown };
    return body.accepted === true && Number(body.runId) === runId;
  } catch { return false; }
}

const TOOL_VERB: Record<string, string> = {
  file_read: 'Read', file_list: 'List', fetch_url: 'Fetch', fetch_page: 'Fetch', open_url: 'Open',
  web_search: 'Search', deep_research: 'Research', execute_code: 'Run code', read_pdf: 'Read PDF',
  browser_screenshot: 'Screenshot', browser_click: 'Click', browser_type: 'Type', browser_extract: 'Extract',
  screenshot: 'Screenshot',
};
function verb(name: string): string {
  if (TOOL_VERB[name]) return TOOL_VERB[name];
  const value = String(name || 'tool').replace(/_/g, ' ');
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function activityIdentity(ev: V4Event, prefix: string): string {
  if (typeof ev.toolCallId === 'string' && ev.toolCallId) return `${prefix}:${ev.toolCallId}`;
  const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload as Record<string, unknown> : {};
  const exact = payload.toolCallId ?? payload.evidenceId ?? payload.workerId ?? payload.skillInvocationId;
  return typeof exact === 'string' && exact ? `${prefix}:${exact}` : `event:${ev.id}`;
}

function safeTarget(payload: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file', 'url', 'query', 'target']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 180);
  }
  let args: unknown = payload.args;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  if (args && typeof args === 'object') {
    for (const key of ['path', 'file', 'url', 'query', 'target']) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 180);
    }
  }
  return undefined;
}

interface TurnState { gotReply: boolean }
type RoutedTerminal =
  | { kind: 'candidate' }
  | { kind: 'reconcile' }
  | { kind: 'cancelled' }
  | { kind: 'rejected'; message: string };

function routeEvent(ev: V4Event, handlers: TurnHandlers, state: TurnState): RoutedTerminal | null {
  const name = ev.name || ev.kind || '';
  const payload = ev.payload || {};
  switch (name) {
    case 'assistant_message':
      state.gotReply = true;
      handlers.onReply?.(String(payload.text ?? ''));
      return null;
    case 'tool_call_started':
      handlers.onActivity?.({
        id: activityIdentity(ev, 'tool'), eventId: ev.id,
        kind: 'tool', label: verb(payload.toolName || 'tool'), detail: safeTarget(payload),
        status: 'running', durationMs: ev.durationMs,
      });
      return null;
    case 'tool_call_completed':
      handlers.onActivity?.({
        id: activityIdentity(ev, 'tool'), eventId: ev.id,
        kind: 'tool', label: verb(payload.toolName || 'tool'),
        detail: safeTarget(payload),
        status: ev.status === 'failed' ? 'failed' : 'ok',
        durationMs: ev.durationMs,
      });
      return null;
    case 'artifact_verified': {
      const presentation = payload.presentation && typeof payload.presentation === 'object'
        ? payload.presentation as Record<string, unknown> : undefined;
      const kind: string =
        (payload.outcome && typeof payload.outcome === 'object' && payload.outcome.kind)
        || (payload.verified ? 'verified' : 'unverifiable');
      const ok = kind === 'verified';
      const label = typeof presentation?.label === 'string' ? presentation.label
        : kind === 'verified' ? 'Verified'
          : kind === 'no_evidence' ? 'No evidence'
            : kind === 'failed' ? 'Failed' : 'Unverified';
      const severity = presentation?.severity;
      handlers.onActivity?.({
        id: activityIdentity(ev, 'verify'), eventId: ev.id,
        kind: 'verify', label, detail: payload.verdict,
        status: severity === 'error' || severity === 'warning' ? 'warn' : ok ? 'ok' : 'warn',
        durationMs: ev.durationMs,
      });
      return null;
    }
    case 'cost_updated':
      if (payload.totalTokens != null) handlers.onTokens?.(payload.totalTokens);
      return null;
    case 'ui_task_update':
      handlers.onThinking?.(
        String(payload.stage || 'working'),
        String(payload.text || payload.message || `step ${payload.step ?? ''}`),
      );
      return null;
    case 'ui_task_done':
      // The model-level UI marker only describes ephemeral activity. Final
      // synthesis and durable assistant output may still be in flight, so it
      // can never arm terminal convergence or settle the run. It is still a
      // useful prompt to refresh durable state in case the terminal receipt
      // was already committed before this UI event reached the browser.
      handlers.onThinking?.('responding', 'Preparing response…');
      return { kind: 'reconcile' };
    case 'task_cancelled':
      return { kind: 'cancelled' };
    default:
      break;
  }
  if (ev.kind === 'dispatcher.completed') return { kind: 'candidate' };
  if (ev.kind === 'job.finalized') return { kind: 'candidate' };
  if (ev.kind === 'dispatcher.rejected' || ev.kind === 'dispatcher.builder_failed') {
    return { kind: 'rejected', message: ev.summary || 'the run could not start' };
  }
  return null;
}

const IDLE_MS = 25_000;

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function parseTaskAdmission(value: unknown): TaskAdmission {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const jobId = requiredString(body.job_id);
  const attemptId = requiredString(body.attempt_id);
  const runId = typeof body.run_id === 'number' && Number.isSafeInteger(body.run_id) && body.run_id >= 0
    ? body.run_id : null;
  if (body.accepted !== true || !jobId || !attemptId || runId === null) {
    throw new Error('task admission did not return one exact Job, Attempt, and run identity');
  }
  const triggerEventId = typeof body.triggerEventId === 'number' && Number.isSafeInteger(body.triggerEventId)
    ? body.triggerEventId : undefined;
  return { accepted: true, jobId, attemptId, runId, triggerEventId, duplicate: body.duplicate === true };
}

export async function admitTask(message: string, sessionId?: string, attachmentIds: readonly string[] = []): Promise<WorkbenchRunHandle> {
  let response: Response;
  try {
    response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
      body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) }),
    });
  } catch { throw new Error('could not reach Aiden (is `aiden web` running?)'); }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* classified below */ }
  if (!response.ok) {
    const detail = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? String((body as { error: string }).error) : `send failed (HTTP ${response.status})`;
    if (response.status === 401 || response.status === 503) {
      throw new Error('writes are disabled — open the dashboard via `aiden web` (it carries the local token)');
    }
    throw new Error(detail);
  }
  const handle = { admission: parseTaskAdmission(body), lastEventId: 0 };
  persistRunHandle(handle);
  return handle;
}

export async function uploadAttachment(file: File): Promise<WorkbenchAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const stride = 0x8000;
  for (let index = 0; index < bytes.length; index += stride) {
    const end = Math.min(bytes.length, index + stride);
    for (let cursor = index; cursor < end; cursor += 1) binary += String.fromCharCode(bytes[cursor]);
  }
  const response = await fetch('/api/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify({ name: file.name, mime: file.type || 'application/octet-stream', base64: btoa(binary) }),
  });
  const body = await response.json() as Partial<WorkbenchAttachment> & { error?: string };
  if (!response.ok || typeof body.id !== 'string' || typeof body.name !== 'string' || typeof body.size !== 'number') {
    throw new Error(body.error || `attachment upload failed (HTTP ${response.status})`);
  }
  return { id: body.id, name: body.name, mime: body.mime || file.type || 'application/octet-stream', size: body.size };
}

export async function listArtifacts(runId?: number): Promise<WorkbenchArtifact[]> {
  const query = runId === undefined ? '' : `?runId=${encodeURIComponent(String(runId))}`;
  const response = await fetch(`/api/artifacts${query}`, {
    cache: 'no-store', headers: { 'x-workbench-token': token() },
  });
  if (response.status === 503) return [];
  if (!response.ok) throw new Error(`artifact projection unavailable (HTTP ${response.status})`);
  const body = await response.json();
  return Array.isArray(body) ? body as WorkbenchArtifact[] : [];
}

export async function loadArtifactContent(artifactId: string): Promise<{ blob: Blob; mime: string }> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/content`, {
    cache: 'no-store', headers: { 'x-workbench-token': token() },
  });
  if (!response.ok) throw new Error(`artifact content unavailable (HTTP ${response.status})`);
  return { blob: await response.blob(), mime: response.headers.get('content-type') || 'application/octet-stream' };
}

export async function decideApproval(approvalId: string, decision: 'approved' | 'denied'): Promise<{ accepted: boolean; state?: string }> {
  const response = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify({ decision }),
  });
  const body = await response.json() as { accepted?: unknown; state?: string; error?: string };
  if (!response.ok || body.accepted !== true) throw new Error(body.error || 'approval decision was not accepted');
  return { accepted: true, state: body.state };
}

export async function loadWorkbenchCapabilities(): Promise<WorkbenchCapabilities> {
  const response = await fetch('/api/workbench/capabilities', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Workbench capabilities unavailable (HTTP ${response.status})`);
  const body = await response.json() as Partial<WorkbenchCapabilities>;
  return {
    modelSwitch: body.modelSwitch?.available === true
      ? { available: true }
      : { available: false, reason: body.modelSwitch?.reason || 'Model changes are managed by the Aiden runtime.' },
    skills: Array.isArray(body.skills) ? body.skills : [],
    plugins: Array.isArray(body.plugins) ? body.plugins : [],
    ...(body.extensions && Array.isArray(body.extensions.items) ? { extensions: body.extensions } : {}),
  };
}

async function capabilityRequest(path: string, body: Record<string, unknown>): Promise<CapabilityExtensionsSnapshot> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify(body),
  });
  const value = await response.json() as CapabilityExtensionsSnapshot & { snapshot?: CapabilityExtensionsSnapshot; error?: string };
  if (!response.ok) throw new Error(value.error || `Capability operation failed (HTTP ${response.status})`);
  return value.snapshot ?? value;
}

export async function installCapability(sourcePath: string): Promise<CapabilityExtensionsSnapshot> {
  return capabilityRequest('/api/capabilities/install', { path: sourcePath });
}

export async function activateCapability(capabilityId: string, version: string): Promise<CapabilityExtensionsSnapshot> {
  return capabilityRequest(`/api/capabilities/${encodeURIComponent(capabilityId)}/activate`, {
    version,
    acceptPermissions: true,
  });
}

export async function rollbackCapability(capabilityId: string): Promise<CapabilityExtensionsSnapshot> {
  return capabilityRequest(`/api/capabilities/${encodeURIComponent(capabilityId)}/rollback`, {});
}

export async function disableCapability(capabilityId: string): Promise<CapabilityExtensionsSnapshot> {
  return capabilityRequest(`/api/capabilities/${encodeURIComponent(capabilityId)}/disable`, {});
}

export async function testCapability(capabilityId: string): Promise<CapabilityExtensionsSnapshot> {
  return capabilityRequest(`/api/capabilities/${encodeURIComponent(capabilityId)}/test`, {});
}

export async function uninstallCapability(capabilityId: string, version: string): Promise<CapabilityExtensionsSnapshot> {
  return capabilityRequest(`/api/capabilities/${encodeURIComponent(capabilityId)}/uninstall`, { version });
}

export function loadSkillIntelligence(): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest('/api/skill-intelligence');
}

export function loadSkillCandidate(candidateId: string): Promise<WorkbenchSkillCandidateReview> {
  return managementRequest(`/api/skill-intelligence/candidates/${encodeURIComponent(candidateId)}`);
}

export function dismissSkillCandidate(candidateId: string, expectedVersion: number): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/candidates/${encodeURIComponent(candidateId)}/dismiss`, {
    method: 'POST', body: JSON.stringify({ expectedVersion }),
  });
}

export function createSkillDraft(input: {
  candidateId: string; name: string; description: string; steps: WorkbenchSkillStep[];
  capabilityRequirements: WorkbenchSkillCapabilityRequirement[]; composition: string[]; expectedEvidence: string[];
}): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest('/api/skill-intelligence/drafts', { method: 'POST', body: JSON.stringify(input) });
}

export function updateSkillDraft(draftId: string, input: {
  expectedVersion: number; name?: string; description?: string; steps?: WorkbenchSkillStep[];
  capabilityRequirements?: WorkbenchSkillCapabilityRequirement[]; composition?: string[]; expectedEvidence?: string[];
}): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/drafts/${encodeURIComponent(draftId)}/edit`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function evaluateSkillDraft(draftId: string): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/drafts/${encodeURIComponent(draftId)}/evaluate`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export function requestSkillApproval(draftId: string, evaluationId: string): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/drafts/${encodeURIComponent(draftId)}/approval`, {
    method: 'POST', body: JSON.stringify({ evaluationId }),
  });
}

export function decideSkillApproval(
  approvalId: string,
  input: { decision: 'approved' | 'denied'; draftDigest: string; evaluationDigest: string },
): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function activateSkillApproval(approvalId: string): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/approvals/${encodeURIComponent(approvalId)}/activate`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export function disableManagedSkill(skillId: string): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/skills/${encodeURIComponent(skillId)}/disable`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export function rollbackManagedSkill(skillId: string, targetVersionId: string): Promise<WorkbenchSkillIntelligenceSnapshot> {
  return managementRequest(`/api/skill-intelligence/skills/${encodeURIComponent(skillId)}/rollback`, {
    method: 'POST', body: JSON.stringify({ targetVersionId }),
  });
}

async function appsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      'x-workbench-token': token(),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Apps request failed (HTTP ${response.status})`);
  return body;
}

async function managementRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      'x-workbench-token': token(),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Workbench setup request failed (HTTP ${response.status})`);
  return body;
}

export function loadProviderSetup(sessionId?: string): Promise<WorkbenchProviderSnapshot> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return managementRequest<WorkbenchProviderSnapshot>(`/api/providers${query}`);
}

export function connectProvider(input: { providerId: string; modelId: string; credential: string }): Promise<WorkbenchProviderProjection> {
  return managementRequest<WorkbenchProviderProjection>(`/api/providers/${encodeURIComponent(input.providerId)}/connect`, {
    method: 'POST', body: JSON.stringify({ modelId: input.modelId, credential: input.credential }),
  });
}

export function replaceProviderCredential(input: { providerId: string; modelId: string; credential: string }): Promise<WorkbenchProviderProjection> {
  return managementRequest<WorkbenchProviderProjection>(`/api/providers/${encodeURIComponent(input.providerId)}/replace-credential`, {
    method: 'POST', body: JSON.stringify({ modelId: input.modelId, credential: input.credential }),
  });
}

export function testProvider(input: { providerId: string; modelId: string; credential?: string }): Promise<WorkbenchProviderProjection> {
  return managementRequest<WorkbenchProviderProjection>(`/api/providers/${encodeURIComponent(input.providerId)}/test`, {
    method: 'POST', body: JSON.stringify({ modelId: input.modelId, ...(input.credential ? { credential: input.credential } : {}) }),
  });
}

export function disconnectProvider(providerId: string): Promise<WorkbenchProviderProjection> {
  return managementRequest<WorkbenchProviderProjection>(`/api/providers/${encodeURIComponent(providerId)}/disconnect`, {
    method: 'POST', body: JSON.stringify({ confirmed: true }),
  });
}

export function refreshProviderModels(providerId: string): Promise<WorkbenchProviderProjection> {
  return managementRequest<WorkbenchProviderProjection>(`/api/providers/${encodeURIComponent(providerId)}/refresh-models`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export function setSessionModel(input: { sessionId: string; providerId: string; modelId: string }): Promise<{ sessionId: string; providerId: string; modelId: string }> {
  return managementRequest('/api/providers/model/session', { method: 'POST', body: JSON.stringify(input) });
}

export function setDefaultModel(input: { providerId: string; modelId: string }): Promise<{ providerId: string; modelId: string }> {
  return managementRequest('/api/providers/model/default', { method: 'POST', body: JSON.stringify(input) });
}

export function startProviderOAuth(providerId: string): Promise<WorkbenchAuthSession> {
  return managementRequest<WorkbenchAuthSession>(`/api/providers/${encodeURIComponent(providerId)}/oauth/start`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export function loadProviderAuthSession(authSessionId: string): Promise<WorkbenchAuthSession> {
  return managementRequest<WorkbenchAuthSession>(`/api/providers/auth-sessions/${encodeURIComponent(authSessionId)}`);
}

export function loadSystemReadiness(sessionId?: string): Promise<SystemReadinessProjection> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return managementRequest<SystemReadinessProjection>(`/api/workbench/readiness${query}`);
}

export function loadBrowserSetup(): Promise<WorkbenchBrowserSetup> {
  return managementRequest<WorkbenchBrowserSetup>('/api/browser/setup');
}

export function grantBrowserPermission(): Promise<WorkbenchBrowserSetup> {
  return managementRequest<WorkbenchBrowserSetup>('/api/browser/setup/grant', {
    method: 'POST', body: JSON.stringify({ confirmed: true }),
  });
}

export function loadApps(): Promise<WorkbenchAppsSnapshot> {
  return appsRequest<WorkbenchAppsSnapshot>('/api/apps');
}

export type WorkbenchPresenceState = 'active' | 'snoozed' | 'dismissed' | 'resolved' | 'expired' | 'suppressed';

export interface WorkbenchPresenceItem {
  id: string;
  sourceKind: string;
  sourceIdentity: string;
  sourceRevision: string;
  sourceDigest: string;
  workspaceId: string | null;
  ownerId: string | null;
  jobId: string | null;
  automationId: string | null;
  category: string;
  priority: number;
  state: WorkbenchPresenceState;
  title: string;
  summary: string;
  reasonCode: string;
  reason: string;
  recommendedAction: string | null;
  payload: Record<string, unknown>;
  occurrenceCount: number;
  version: number;
  firstObservedAt: number;
  lastObservedAt: number;
  snoozedUntil: number | null;
  expiresAt: number | null;
  resolvedAt: number | null;
}

export interface WorkbenchPresenceSnapshot {
  enabled: boolean;
  quietHours: boolean;
  interruptions: WorkbenchPresenceItem[];
  needsYou: WorkbenchPresenceItem[];
  reviewWhenReady: WorkbenchPresenceItem[];
  recentlyResolved: WorkbenchPresenceItem[];
}

export interface WorkbenchProposedJob {
  id: string;
  itemId: string;
  prompt: string;
  goal: string;
  state: 'proposed' | 'accepting' | 'accepted' | 'dismissed' | 'expired' | 'invalidated';
  version: number;
  invalidationReason: string | null;
  jobId: string | null;
  attemptId: string | null;
  runId: number | null;
}

export interface WorkbenchPresenceBriefing {
  briefingId: string;
  duplicate: boolean;
  items: WorkbenchPresenceItem[];
  groups: {
    changed: WorkbenchPresenceItem[];
    resolved: WorkbenchPresenceItem[];
    blocked: WorkbenchPresenceItem[];
    ready: WorkbenchPresenceItem[];
    next: WorkbenchPresenceItem[];
  };
}

export type WorkbenchLearningConfidence = 'CANDIDATE' | 'OBSERVED' | 'CORROBORATED' | 'TRUSTED';
export type WorkbenchLearningLifecycle = 'ACTIVE' | 'CONFLICTED' | 'STALE' | 'DEMOTED' | 'ARCHIVED' | 'DELETED';
export type WorkbenchLearningType =
  | 'USER_PREFERENCE' | 'USER_CORRECTION' | 'WORKSPACE_CONVENTION'
  | 'VERIFIED_PROCEDURE_LESSON' | 'TOOL_RELIABILITY_LESSON' | 'SKILL_RELIABILITY'
  | 'PRESENCE_FEEDBACK' | 'RECOVERY_LESSON';
export type WorkbenchLearningScopeKind = 'USER_GLOBAL' | 'WORKSPACE' | 'PROJECT' | 'REPOSITORY' | 'AUTOMATION' | 'SKILL';

export interface WorkbenchLearningEntry {
  id: string;
  scope: { kind: WorkbenchLearningScopeKind; key: string; ownerId: string; workspaceId: string | null };
  type: WorkbenchLearningType;
  subjectKey: string;
  confidence: WorkbenchLearningConfidence;
  lifecycle: WorkbenchLearningLifecycle;
  content: string | null;
  contentDigest: string | null;
  eligible: boolean;
  sourceCount: number;
  version: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface WorkbenchLearningConflict {
  id: string; leftEntryId: string; rightEntryId: string; state: 'OPEN' | 'RESOLVED';
  reasonCode: string; createdAt: number; resolvedAt: number | null;
}

export interface WorkbenchLearningSnapshot {
  enabled: boolean;
  trusted: WorkbenchLearningEntry[];
  needsReview: WorkbenchLearningEntry[];
  archived: WorkbenchLearningEntry[];
  conflicts: WorkbenchLearningConflict[];
  counts: { trusted: number; needsReview: number; conflicts: number; archived: number };
}

export interface WorkbenchLearningReview {
  entry: WorkbenchLearningEntry;
  history: Array<{ id: string; type: string; entryVersion: number; confidence: string; lifecycle: string; expiresAt: number | null; createdAt: number }>;
  versions: Array<{ id: string; entryId: string; content: string; contentDigest: string; createdAt: number }>;
  sources: Array<{
    id: string; entryId: string; kind: string; identity: string; revision: string; verification: string;
    jobId: string | null; attemptId: string | null; generation: number | null;
    evidenceId: string | null; effectId: string | null;
    presenceId: string | null; automationId: string | null; skillName: string | null; recoveryId: string | null;
    occurredAt: number;
  }>;
  conflicts: WorkbenchLearningConflict[];
}

export function loadLearning(): Promise<WorkbenchLearningSnapshot> {
  return managementRequest('/api/learning');
}

export function loadLearningReview(entryId: string): Promise<WorkbenchLearningReview> {
  return managementRequest(`/api/learning/${encodeURIComponent(entryId)}`);
}

export function rememberLearning(input: {
  content: string; subjectKey: string; type: WorkbenchLearningType;
  scopeKind: WorkbenchLearningScopeKind; idempotencyKey: string;
}): Promise<WorkbenchLearningEntry> {
  return managementRequest('/api/learning/remember', { method: 'POST', body: JSON.stringify(input) });
}

export function editLearning(entryId: string, input: { expectedVersion: number; content: string; idempotencyKey: string }): Promise<WorkbenchLearningEntry> {
  return managementRequest(`/api/learning/${encodeURIComponent(entryId)}/edit`, { method: 'POST', body: JSON.stringify(input) });
}

export function rollbackLearning(entryId: string, input: { expectedVersion: number; versionId: string; idempotencyKey: string }): Promise<WorkbenchLearningEntry> {
  return managementRequest(`/api/learning/${encodeURIComponent(entryId)}/rollback`, { method: 'POST', body: JSON.stringify(input) });
}

export function demoteLearning(entryId: string, expectedVersion: number): Promise<WorkbenchLearningEntry> {
  return managementRequest(`/api/learning/${encodeURIComponent(entryId)}/demote`, {
    method: 'POST', body: JSON.stringify({ expectedVersion, reason: 'disabled_by_user' }),
  });
}

export function archiveLearning(entryId: string, expectedVersion: number): Promise<WorkbenchLearningEntry> {
  return managementRequest(`/api/learning/${encodeURIComponent(entryId)}/archive`, {
    method: 'POST', body: JSON.stringify({ expectedVersion, reason: 'archived_by_user' }),
  });
}

export function deleteLearning(entryId: string, expectedVersion: number): Promise<WorkbenchLearningEntry> {
  return managementRequest(`/api/learning/${encodeURIComponent(entryId)}/delete`, {
    method: 'POST', body: JSON.stringify({ expectedVersion, reason: 'privacy_request' }),
  });
}

export function exportLearning(): Promise<Record<string, unknown>> {
  return managementRequest('/api/learning/export');
}

export function loadAutomations(): Promise<WorkbenchAutomationSnapshot> {
  return appsRequest<WorkbenchAutomationSnapshot>('/api/automations');
}

export function previewAutomationSchedule(input: { expression: string; timezone: string }): Promise<{ instants: string[] }> {
  return appsRequest('/api/automations/preview', { method: 'POST', body: JSON.stringify(input) });
}

export function createAutomation(input: {
  name: string; prompt: string; expression: string; timezone: string;
  overlap: 'queue' | 'skip' | 'cancel_previous';
  misfire: 'run_once' | 'skip' | 'catch_up';
  allowWrite: boolean;
}): Promise<WorkbenchAutomationSummary> {
  return appsRequest('/api/automations', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      action: { kind: 'prompt', prompt: input.prompt },
      trigger: { kind: 'schedule', expression: input.expression, timezone: input.timezone },
      policies: {
        misfire: input.misfire === 'catch_up'
          ? { kind: 'catch_up', maxOccurrences: 3, maxAgeMs: 86400000 }
          : { kind: input.misfire, maxAgeMs: input.misfire === 'run_once' ? 86400000 : undefined },
        overlap: input.overlap,
        retry: { maxAttempts: 2 },
      },
      capabilities: input.allowWrite ? ['repository.read', 'repository.write'] : ['repository.read'],
      credentialRefs: [],
      budget: { runtimeMs: 300000, modelCalls: 8, toolCalls: 40, effects: input.allowWrite ? 10 : 0 },
      approval: { mode: 'policy' },
    }),
  });
}

export function runAutomationNow(automationId: string): Promise<{ triggerEventId: number }> {
  return appsRequest(`/api/automations/${encodeURIComponent(automationId)}/run`, { method: 'POST' });
}

export function setAutomationEnabled(automationId: string, enabled: boolean): Promise<WorkbenchAutomationSummary> {
  return appsRequest(`/api/automations/${encodeURIComponent(automationId)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
}

export function replayAutomationOccurrence(occurrenceId: string): Promise<{ triggerEventId: number }> {
  return appsRequest(`/api/automation-occurrences/${encodeURIComponent(occurrenceId)}/replay`, { method: 'POST' });
}

export function configureAppsProvider(input: { providerId: string; credential: string }): Promise<WorkbenchAppProvider> {
  return appsRequest<WorkbenchAppProvider>(`/api/apps/providers/${encodeURIComponent(input.providerId)}/configure`, {
    method: 'POST', body: JSON.stringify({ credential: input.credential }),
  });
}

export function connectApp(input: {
  providerId: string;
  toolkitId: string;
  label?: string;
}): Promise<WorkbenchAppConnection> {
  return appsRequest<WorkbenchAppConnection>('/api/apps/connect', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function completeAppConnection(connectionId: string): Promise<WorkbenchConnectedAccount> {
  const result = await appsRequest<{ account: WorkbenchConnectedAccount }>(
    `/api/apps/connections/${encodeURIComponent(connectionId)}/complete`,
    { method: 'POST' },
  );
  return result.account;
}

export async function refreshAppAccount(accountId: string): Promise<WorkbenchConnectedAccount> {
  const result = await appsRequest<{ account: WorkbenchConnectedAccount }>(
    `/api/apps/accounts/${encodeURIComponent(accountId)}/refresh`,
    { method: 'POST' },
  );
  return result.account;
}

export function reconnectAppAccount(accountId: string): Promise<WorkbenchAppConnection> {
  return appsRequest<WorkbenchAppConnection>(
    `/api/apps/accounts/${encodeURIComponent(accountId)}/reconnect`,
    { method: 'POST' },
  );
}

export async function disconnectAppAccount(accountId: string): Promise<WorkbenchConnectedAccount> {
  const result = await appsRequest<{ account: WorkbenchConnectedAccount }>(
    `/api/apps/accounts/${encodeURIComponent(accountId)}/disconnect`,
    { method: 'POST', body: JSON.stringify({ confirmed: true }) },
  );
  return result.account;
}

export async function loadBrowserSession(jobId: string): Promise<WorkbenchBrowserSession | null> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/browser`, { cache: 'no-store' });
  if (response.status === 404 || response.status === 503) return null;
  if (!response.ok) throw new Error(`browser session unavailable (HTTP ${response.status})`);
  const body = await response.json() as { browser?: WorkbenchBrowserSession | null };
  return body.browser ?? null;
}

export async function loadCodingSessions(jobId: string): Promise<WorkbenchCodingSession[]> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/coding`, { cache: 'no-store' });
  if (response.status === 404 || response.status === 503) return [];
  if (!response.ok) throw new Error(`coding session projection unavailable (HTTP ${response.status})`);
  const body = await response.json() as { sessions?: unknown };
  return Array.isArray(body.sessions) ? body.sessions as WorkbenchCodingSession[] : [];
}

export async function loadExternalCodingHealth(): Promise<ExternalCodingHealth> {
  const response = await fetch('/api/coding/health', { cache: 'no-store' });
  const body = await response.json() as ExternalCodingHealth & { error?: string };
  if (!response.ok) throw new Error(body.error || 'external coding health unavailable');
  return body;
}

export async function configureExternalCoding(model: string): Promise<ExternalCodingHealth> {
  const response = await fetch('/api/coding/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify({ model }),
  });
  const body = await response.json() as ExternalCodingHealth & { error?: string };
  if (!response.ok) throw new Error(body.error || 'external coding configuration failed');
  return body;
}

export async function decideCodingPromotion(
  promotionId: string,
  decision: 'apply' | 'discard',
): Promise<unknown> {
  const response = await fetch(`/api/coding/promotions/${encodeURIComponent(promotionId)}/${decision}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify({ confirmed: true }),
  });
  const body = await response.json() as { accepted?: unknown; result?: unknown; error?: string };
  if (!response.ok || body.accepted !== true) throw new Error(body.error || `coding ${decision} was not accepted`);
  return body.result;
}

export async function discardUnknownCodingSession(codingSessionId: string): Promise<unknown> {
  const response = await fetch(`/api/coding/sessions/${encodeURIComponent(codingSessionId)}/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify({ confirmed: true }),
  });
  const body = await response.json() as { accepted?: unknown; result?: unknown; error?: string };
  if (!response.ok || body.accepted !== true) {
    throw new Error(body.error || 'coding reconciliation discard was not accepted');
  }
  return body.result;
}

export async function loadCodingReview(promotionId: string): Promise<WorkbenchCodingReview> {
  const response = await fetch(`/api/coding/promotions/${encodeURIComponent(promotionId)}/review`, {
    cache: 'no-store',
    headers: { 'x-workbench-token': token() },
  });
  const body = await response.json() as WorkbenchCodingReview & { error?: string };
  if (!response.ok) throw new Error(body.error || 'coding review unavailable');
  return body;
}

export async function controlBrowserSession(
  jobId: string,
  action: 'take' | 'return' | 'clear',
): Promise<WorkbenchBrowserSession | null> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/browser/${action}`, {
    method: 'POST',
    headers: { 'x-workbench-token': token() },
  });
  const body = await response.json() as {
    accepted?: unknown;
    browser?: WorkbenchBrowserSession | null;
    error?: string;
  };
  if (!response.ok || body.accepted !== true) {
    throw new Error(body.error || `browser ${action} was not accepted`);
  }
  return body.browser ?? null;
}

export async function loadRunProjection(jobId: string, attemptId?: string, runId?: number): Promise<WorkbenchRunProjection | null> {
  const query = new URLSearchParams();
  if (attemptId) query.set('attemptId', attemptId);
  if (runId !== undefined) query.set('runId', String(runId));
  const response = await fetch(
    `/api/jobs/${encodeURIComponent(jobId)}/projection?${query.toString()}`,
    { cache: 'no-store' },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`durable run projection unavailable (HTTP ${response.status})`);
  return response.json() as Promise<WorkbenchRunProjection>;
}

export async function loadLiveExecution(input: {
  jobId: string; attemptId: string; generation: number; runId: number;
}): Promise<WorkbenchLiveExecutionProjection | null> {
  const query = new URLSearchParams({
    attemptId: input.attemptId,
    generation: String(input.generation),
    runId: String(input.runId),
  });
  const response = await fetch(
    `/api/jobs/${encodeURIComponent(input.jobId)}/live-execution?${query.toString()}`,
    { cache: 'no-store' },
  );
  if (response.status === 404 || response.status === 503) return null;
  if (!response.ok) throw new Error(`live execution projection unavailable (HTTP ${response.status})`);
  return response.json() as Promise<WorkbenchLiveExecutionProjection>;
}

export async function loadRuntimeInfo(): Promise<WorkbenchRuntimeInfo> {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error(`Workbench runtime metadata unavailable (HTTP ${response.status})`);
  const body = await response.json() as Partial<WorkbenchRuntimeInfo>;
  if (body.service !== 'aiden-workbench-bridge' || typeof body.version !== 'string' || !body.version.trim()) {
    throw new Error('Workbench runtime metadata is invalid');
  }
  return { service: body.service, version: body.version, readOnly: body.readOnly === true };
}

export async function loadWorkbenchBootstrap(): Promise<WorkbenchBootstrap> {
  const response = await fetch('/api/workbench/bootstrap');
  if (!response.ok) throw new Error(`Workbench bootstrap unavailable (HTTP ${response.status})`);
  const body = await response.json() as Partial<WorkbenchBootstrap>;
  if (!body.runtime || typeof body.runtime.version !== 'string' || !body.provider || !body.model) {
    throw new Error('Workbench bootstrap metadata is invalid');
  }
  return {
    runtime: {
      version: body.runtime.version,
      status: body.runtime.status ?? 'unknown',
      local: body.runtime.local === true,
      edition: ['pro', 'team', 'enterprise'].includes(body.runtime.edition)
        ? body.runtime.edition
        : 'community',
    },
    provider: body.provider,
    model: body.model,
    connection: body.connection === 'unavailable' || body.connection === 'reconnecting' ? body.connection : 'connected',
    readOnly: body.readOnly === true,
    execution: {
      available: body.execution?.available === true,
      runner: body.execution?.runner === 'real' ? 'real' : 'unavailable',
      workerCount: typeof body.execution?.workerCount === 'number' ? body.execution.workerCount : 0,
      pending: typeof body.execution?.pending === 'number' ? body.execution.pending : 0,
      claimed: typeof body.execution?.claimed === 'number' ? body.execution.claimed : 0,
      inflight: typeof body.execution?.inflight === 'number' ? body.execution.inflight : 0,
      oldestPendingMs: typeof body.execution?.oldestPendingMs === 'number' ? body.execution.oldestPendingMs : null,
      processed: typeof body.execution?.processed === 'number' ? body.execution.processed : 0,
    },
    activeJobs: Array.isArray(body.activeJobs) ? body.activeJobs.flatMap((job) => {
      if (!job || typeof job !== 'object' || typeof job.jobId !== 'string') return [];
      const value = job as Partial<WorkbenchBootstrap['activeJobs'][number]>;
      return [{
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
        jobId: value.jobId,
        attemptId: typeof value.attemptId === 'string' ? value.attemptId : null,
        runId: typeof value.runId === 'number' && Number.isSafeInteger(value.runId) ? value.runId : null,
        status: typeof value.status === 'string' ? value.status : 'unknown',
        title: typeof value.title === 'string' ? value.title : undefined,
        statusDetail: typeof value.statusDetail === 'string' ? value.statusDetail : undefined,
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
        triggerEventId: typeof value.triggerEventId === 'number' ? value.triggerEventId : null,
        triggerStatus: typeof value.triggerStatus === 'string' ? value.triggerStatus : null,
        queue: value.queue && typeof value.queue.pending === 'number' && typeof value.queue.claimed === 'number'
          ? {
              pending: value.queue.pending,
              claimed: value.queue.claimed,
              oldestPendingMs: typeof value.queue.oldestPendingMs === 'number' ? value.queue.oldestPendingMs : null,
            }
          : undefined,
      }];
    }) : [],
    activeJobCount: typeof body.activeJobCount === 'number'
      ? body.activeJobCount
      : (Array.isArray(body.activeJobs) ? body.activeJobs.length : 0),
  };
}

function writeHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-workbench-token': token() };
}

async function presenceRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: { ...writeHeaders(), ...(init?.headers ?? {}) },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Presence request failed (HTTP ${response.status})`);
  return body;
}

export function loadPresenceSnapshot(): Promise<WorkbenchPresenceSnapshot> {
  return presenceRequest<WorkbenchPresenceSnapshot>('/api/presence');
}

export function loadPresenceProposals(): Promise<WorkbenchProposedJob[]> {
  return presenceRequest<WorkbenchProposedJob[]>('/api/presence/proposals');
}

export function loadPresenceBriefing(briefingId: string): Promise<WorkbenchPresenceBriefing> {
  return presenceRequest(`/api/presence/briefing?briefingId=${encodeURIComponent(briefingId)}`);
}

export function explainPresenceItem(itemId: string): Promise<{
  itemId: string; reason: string; reasonCode: string;
  source: { kind: string; identity: string; revision: string };
  history: Array<{ eventId: string; type: string; createdAt: number }>;
}> {
  return presenceRequest(`/api/presence/${encodeURIComponent(itemId)}/explain`);
}

export function snoozePresenceItem(itemId: string, expectedVersion: number, until: number): Promise<WorkbenchPresenceItem> {
  return presenceRequest(`/api/presence/${encodeURIComponent(itemId)}/snooze`, {
    method: 'POST', body: JSON.stringify({ expectedVersion, until }),
  });
}

export function dismissPresenceItem(itemId: string, expectedVersion: number): Promise<WorkbenchPresenceItem> {
  return presenceRequest(`/api/presence/${encodeURIComponent(itemId)}/dismiss`, {
    method: 'POST', body: JSON.stringify({ expectedVersion }),
  });
}

export function sendPresenceFeedback(itemId: string, kind: 'helpful' | 'not_helpful' | 'too_frequent' | 'wrong_priority'): Promise<{ accepted: true; eventId: string }> {
  return presenceRequest(`/api/presence/${encodeURIComponent(itemId)}/feedback`, {
    method: 'POST', body: JSON.stringify({ kind }),
  });
}

export function proposePresenceJob(itemId: string, prompt: string, goal: string): Promise<WorkbenchProposedJob> {
  return presenceRequest(`/api/presence/${encodeURIComponent(itemId)}/proposals`, {
    method: 'POST', body: JSON.stringify({ prompt, goal }),
  });
}

export function acceptPresenceProposal(proposalId: string, expectedVersion: number, sessionId?: string): Promise<WorkbenchProposedJob> {
  return presenceRequest(`/api/presence/proposals/${encodeURIComponent(proposalId)}/accept`, {
    method: 'POST', body: JSON.stringify({ expectedVersion, ...(sessionId ? { sessionId } : {}) }),
  });
}

export async function loadContinuity(jobId: string): Promise<ContinuityCheckpointView | null> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/continuity`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`continuity unavailable (HTTP ${response.status})`);
  return response.json() as Promise<ContinuityCheckpointView>;
}

export async function continueTask(checkpointId: string, jobId: string, idempotencyKey: string): Promise<{
  accepted: boolean; decision?: string; reason?: string; attemptId?: string; generation?: number; runId?: number;
}> {
  const response = await fetch(`/api/checkpoints/${encodeURIComponent(checkpointId)}/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': token() },
    body: JSON.stringify({ jobId, idempotencyKey }),
  });
  const body = await response.json() as {
    accepted?: unknown; decision?: string; reason?: string; attemptId?: string; generation?: number; runId?: number;
  };
  return {
    accepted: response.ok && body.accepted === true,
    decision: body.decision,
    reason: body.reason,
    ...(typeof body.attemptId === 'string' ? { attemptId: body.attemptId } : {}),
    ...(typeof body.generation === 'number' ? { generation: body.generation } : {}),
    ...(typeof body.runId === 'number' ? { runId: body.runId } : {}),
  };
}

function projectionMatches(handle: WorkbenchRunHandle, projection: WorkbenchRunProjection): boolean {
  const identity = projection?.identity;
  return identity?.jobId === handle.admission.jobId
    && identity?.attemptId === handle.admission.attemptId
    && identity?.runId === handle.admission.runId;
}

export type RestoredRunResolution =
  | { kind: 'missing' }
  | { kind: 'terminal'; projection: WorkbenchRunProjection; handle: WorkbenchRunHandle }
  | { kind: 'inactive'; projection: WorkbenchRunProjection; handle: WorkbenchRunHandle }
  | { kind: 'active'; projection: WorkbenchRunProjection; handle: WorkbenchRunHandle };

const NONTERMINAL_ATTEMPT_STATUSES = new Set([
  'queued', 'claimed', 'leased', 'running', 'waiting', 'paused',
  'cancelling', 'cancel_requested', 'recovering',
]);

const RESTORABLE_ACTIVE_RECEIPT_STATUSES = new Set([
  'queued', 'running', 'waiting', 'paused', 'cancelling',
]);

function restoredProjectionKind(projection: WorkbenchRunProjection): 'terminal' | 'inactive' | 'active' {
  if (projection.receipt.terminal) return 'terminal';
  return RESTORABLE_ACTIVE_RECEIPT_STATUSES.has(projection.receipt.status) ? 'active' : 'inactive';
}

function currentRecoveryHandle(
  handle: WorkbenchRunHandle,
  projection: WorkbenchRunProjection,
): WorkbenchRunHandle | null {
  const exactAttempt = projection.attempts?.find((attempt) => attempt.id === handle.admission.attemptId);
  const currentAttempt = [...(projection.attempts ?? [])]
    .filter((attempt) => Number.isSafeInteger(attempt.rowId))
    .sort((a, b) => b.generation - a.generation)[0];
  if (!exactAttempt || NONTERMINAL_ATTEMPT_STATUSES.has(exactAttempt.status)
    || !currentAttempt || currentAttempt.id === exactAttempt.id
    || currentAttempt.generation <= exactAttempt.generation) return null;
  return {
    admission: {
      accepted: true,
      jobId: handle.admission.jobId,
      attemptId: currentAttempt.id,
      runId: currentAttempt.rowId!,
      duplicate: false,
    },
    lastEventId: 0,
  };
}

/** Resolve persisted browser state against exact durable identity before SSE.
 * A stored handle is only a reconnect hint; the durable projection owns truth. */
export async function reconcileRestoredRunHandle(handle: WorkbenchRunHandle): Promise<RestoredRunResolution> {
  const projection = await loadRunProjection(
    handle.admission.jobId,
    handle.admission.attemptId,
    handle.admission.runId,
  );
  if (!projection || !projectionMatches(handle, projection)) return { kind: 'missing' };
  const currentHandle = currentRecoveryHandle(handle, projection);
  if (currentHandle) {
    const currentProjection = await loadRunProjection(
      currentHandle.admission.jobId,
      currentHandle.admission.attemptId,
      currentHandle.admission.runId,
    );
    if (!currentProjection || !projectionMatches(currentHandle, currentProjection)) return { kind: 'missing' };
    return { kind: restoredProjectionKind(currentProjection), projection: currentProjection, handle: currentHandle };
  }
  return { kind: restoredProjectionKind(projection), projection, handle };
}

async function readProjection(handle: WorkbenchRunHandle): Promise<{
  projection: WorkbenchRunProjection;
  reattached: TaskAdmission | null;
}> {
  const response = await fetch(
    `/api/jobs/${encodeURIComponent(handle.admission.jobId)}/projection`
    + `?attemptId=${encodeURIComponent(handle.admission.attemptId)}&runId=${handle.admission.runId}`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`durable run projection unavailable (HTTP ${response.status})`);
  const projection = await response.json() as WorkbenchRunProjection;
  if (!projectionMatches(handle, projection)) throw new Error('durable run projection identity mismatch');
  const currentHandle = currentRecoveryHandle(handle, projection);
  if (!currentHandle) return { projection, reattached: null };
  const currentProjection = await loadRunProjection(
    currentHandle.admission.jobId,
    currentHandle.admission.attemptId,
    currentHandle.admission.runId,
  );
  if (!currentProjection || !projectionMatches(currentHandle, currentProjection)) {
    throw new Error('durable recovery projection identity mismatch');
  }
  handle.admission = currentHandle.admission;
  handle.lastEventId = 0;
  persistRunHandle(handle);
  return { projection: currentProjection, reattached: currentHandle.admission };
}

export interface FollowRunOptions {
  stallMs?: number;
  signal?: AbortSignal;
  /** Optional restored-run safety bound. Normal admitted runs leave this unset. */
  maxUncertainMs?: number;
}

export function followRun(
  handle: WorkbenchRunHandle,
  handlers: TurnHandlers,
  options: FollowRunOptions = {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let terminalCheck = false;
    let pendingTerminalCandidate = false;
    let uncertainSince: number | null = null;
    let stall: ReturnType<typeof setTimeout> | null = null;
    let terminalPoll: ReturnType<typeof setTimeout> | null = null;
    let terminalCandidateSince: number | null = null;
    let es: EventSource | null = null;
    const state: TurnState = { gotReply: false };
    const stallMs = Math.max(1, options.stallMs ?? IDLE_MS);
    const maxUncertainMs = options.maxUncertainMs === undefined
      ? null : Math.max(1, options.maxUncertainMs);

    const cleanup = (): void => {
      if (stall) clearTimeout(stall);
      if (terminalPoll) clearTimeout(terminalPoll);
      options.signal?.removeEventListener('abort', abort);
      try { es?.close(); } catch { /* noop */ }
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const finish = (info: { stopped?: boolean; summary?: string; status?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      handlers.onConnectionState?.('terminal');
      if (info.error) handlers.onError?.(info.error);
      else handlers.onDone?.({ stopped: info.stopped, summary: info.summary, status: info.status });
      resolve();
    };
    const armStall = (): void => {
      if (settled) return;
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => {
        if (uncertainSince === null) uncertainSince = Date.now();
        handlers.onConnectionState?.('stalled');
        void reconcile(false);
      }, stallMs);
    };
    const uncertaintyExpired = (): boolean => maxUncertainMs !== null
      && uncertainSince !== null
      && Date.now() - uncertainSince >= maxUncertainMs;
    const scheduleTerminalReconcile = (): void => {
      if (settled || terminalPoll) return;
      terminalPoll = setTimeout(() => {
        terminalPoll = null;
        void reconcile(true);
      }, 100);
    };
    const reconcile = async (terminalCandidate: boolean): Promise<void> => {
      if (settled) return;
      if (terminalCheck) {
        if (terminalCandidate) pendingTerminalCandidate = true;
        return;
      }
      terminalCheck = true;
      try {
        const resolvedProjection = await readProjection(handle);
        const projection = resolvedProjection.projection;
        if (projection.receipt.terminal) {
          const authoritativeReply = assistantOutputText(projection);
          if (authoritativeReply) {
            state.gotReply = true;
            handlers.onReplySnapshot?.(authoritativeReply);
          }
          if (['failed', 'blocked', 'unknown'].includes(projection.receipt.status)) {
            finish({ error: projection.receipt.summary || `durable run ended ${projection.receipt.status}` });
          } else {
            finish({
              stopped: projection.receipt.stopped || projection.receipt.status === 'cancelled',
              summary: projection.receipt.summary ?? undefined,
              status: projection.receipt.status,
            });
          }
        } else {
          if (resolvedProjection.reattached) {
            handlers.onReattached?.(resolvedProjection.reattached);
            try { es?.close(); } catch { /* noop */ }
            openStream();
            armStall();
            return;
          }
          if (terminalCandidate) {
            terminalCandidateSince ??= Date.now();
            const terminalBoundMs = maxUncertainMs ?? stallMs;
            if (Date.now() - terminalCandidateSince >= terminalBoundMs) {
              finish({ error: 'durable terminal state did not converge after completion was observed' });
              return;
            }
            handlers.onConnectionState?.('uncertain');
            scheduleTerminalReconcile();
            return;
          }
          if (uncertaintyExpired()) {
            finish({ error: 'durable activity could not be confirmed after reconnecting' });
            return;
          }
          handlers.onConnectionState?.(terminalCandidate ? 'uncertain' : 'stalled');
          armStall();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A projection identity mismatch is an integrity failure, not a
        // transient reconnect condition. Waiting for another poll could
        // leave the browser following a foreign Job indefinitely.
        if (/identity mismatch/i.test(message)) finish({ error: message });
        else if (terminalCandidate) finish({ error: message });
        else if (uncertaintyExpired()) finish({ error: 'durable activity could not be confirmed after reconnecting' });
        else { handlers.onConnectionState?.('uncertain'); armStall(); }
      } finally {
        terminalCheck = false;
        if (!settled && pendingTerminalCandidate) {
          pendingTerminalCandidate = false;
          void reconcile(true);
        }
      }
    };

    const openStream = (): void => {
      const query = handle.lastEventId > 0 ? `?message=1&lastId=${handle.lastEventId}` : '?message=1';
      try { es = new EventSource(`/api/runs/${handle.admission.runId}/events${query}`); }
      catch { finish({ error: 'could not open the event stream' }); return; }
      handlers.onConnectionState?.('connected');
      es.onmessage = (message: MessageEvent): void => {
        let ev: V4Event;
        try { ev = JSON.parse(message.data); } catch { return; }
        if (ev.runId !== handle.admission.runId || !Number.isSafeInteger(ev.id) || ev.id <= handle.lastEventId) return;
        handle.lastEventId = ev.id;
        uncertainSince = null;
        persistRunHandle(handle);
        const terminal = routeEvent(ev, handlers, state);
        if (terminal?.kind === 'candidate') { void reconcile(true); return; }
        if (terminal?.kind === 'reconcile') { void reconcile(false); return; }
        armStall();
      };
      es.onerror = (): void => {
        if (settled) return;
        if (uncertainSince === null) uncertainSince = Date.now();
        handlers.onConnectionState?.('reconnecting');
        void reconcile(false);
      };
    };

    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    openStream();
    armStall();
  });
}

export function runTask(
  message: string,
  handlers: TurnHandlers,
  options: FollowRunOptions = {},
  admission: { sessionId?: string; attachmentIds?: readonly string[] } = {},
): Promise<void> {
  return admitTask(message, admission.sessionId, admission.attachmentIds)
    .then((handle) => {
      handlers.onAdmission?.(handle.admission);
      handlers.onRunId?.(handle.admission.runId);
      return followRun(handle, handlers, options);
    })
    .catch((error) => { handlers.onError?.(error instanceof Error ? error.message : String(error)); });
}
