/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/index.ts — v4.9.0 Slice 12a barrel.
 *
 * Public surface for the hook subsystem. Other v4 modules should
 * import from here, not from the individual files, so the internal
 * layout stays free to evolve.
 */

export {
  parseHookManifest,
  HOOK_EVENTS,
  AUTHORITIES,
  MODES,
  ON_ERROR_POLICIES,
  type HookEvent,
  type HookAuthority,
  type HookMode,
  type OnErrorPolicy,
  type HookSubscriptionSpec,
  type HookCapabilities,
  type HookManifest,
} from './manifest';

export {
  scanAndLoadHooks,
  listHooks,
  type ScanResult,
  type HookRow,
} from './registry';

export {
  markTrusted,
  markRevoked,
  markUntrusted,
} from './trust';

export {
  dispatchHook,
  runHookSubprocess,
  setAutoDisableLogger,
  CONSECUTIVE_FAILURE_THRESHOLD,
  type DispatchContext,
  type DispatchResult,
  type AutoDisableLogger,
} from './dispatcher';

export {
  fireSessionStart,
  fireSessionEnd,
  fireApprovalRequested,
  fireApprovalResponded,
} from './lifecycle';

export {
  queryHookExecutions,
  failureRates,
  countByStatus,
  type AuditRow,
  type AuditQuery,
  type FailureRateRow,
} from './auditQuery';

export {
  type RunnerInput,
  type RunnerOutcome,
  type RunnerStatus,
} from './runtime/subprocessRunner';

export { runToolWithHooks, HookBlockedError } from './toolHookGate';
