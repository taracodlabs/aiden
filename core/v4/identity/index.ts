/**
 * core/v4/identity/index.ts — v4.9.0 Slice 4 barrel.
 */
export {
  ID_PREFIXES,
  uuidv7Bytes,
  newUuidV7,
  newUuidV7Compact,
  newDaemonId,
  newIncarnationId,
  newTriggerId,
  newRunId,
  newAttemptId,
  newTraceId,
  newSpanId,
  newRequestId,
  newToolCallId,
  newMemoryId,
  newHookId,
  parseId,
  isIdWithPrefix,
  type IdPrefix,
  type ParsedId,
} from './ids';
export {
  serializeContext,
  deserializeContext,
  childSpan,
  type ExecutionContext,
  type ExecutionSource,
} from './executionContext';
export {
  runWithContext,
  currentContext,
  requireContext,
} from './contextManager';
export { loadOrCreateDaemonId, daemonIdFilePath } from './daemonId';
// v4.9.0 Slice 7 — HTTP / subprocess / hook boundaries.
export {
  parseTraceparent,
  emitTraceparent,
  stripPrefix,
  validateExternalRequestId,
  type ParsedTraceparent,
} from './traceparent';
export {
  injectContextHeaders,
  maybeInjectContextHeaders,
} from './httpContext';
export {
  spawnEnvWithContext,
  readContextFromEnv,
} from './subprocessContext';
export {
  executeHookWithBoundary,
  HookTimeoutError,
  type HookExecutionOpts,
  type HookOutcome,
} from './hookExecution';
// v4.9.0 Slice 8 — enforcement layer for missing-context events.
export {
  getEnforcementMode,
  reportMissingContext,
  ContextMissingError,
  getContextMissingCounter,
  getAllContextMissingCounters,
  _resetContextMissingCountersForTests,
  type EnforcementMode,
  type EnforcementKind,
} from './enforcement';
