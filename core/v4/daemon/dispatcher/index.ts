/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/index.ts — v4.5 Phase 5a barrel.
 *
 * Single import point for the trigger dispatcher subsystem.
 * Callers should import from here (`../dispatcher`) rather than
 * the individual module files so internal refactors stay
 * encapsulated.
 */

export {
  createDispatcher,
  _dispatcherOwnerId,
} from './dispatcher';
export type {
  Dispatcher,
  DispatcherInflight,
  DispatcherLogFn,
  CreateDispatcherOptions,
} from './dispatcher';

export {
  buildTriggerSessionId,
  parseTriggerSessionId,
} from './sessionId';
export type { BuildSessionIdInput } from './sessionId';

export {
  renderPromptTemplate,
  flattenPayloadToVars,
} from './promptTemplate';
export type { RenderedTemplate, TemplateVar } from './promptTemplate';

export {
  createFireRateLimiter,
  getFireRateLimiter,
  __resetFireRateLimiterSingletonForTests,
} from './fireRateLimiter';
export type {
  FireRateLimiter,
  CreateFireRateLimiterOptions,
} from './fireRateLimiter';

export {
  buildInitialHistory,
  deliverOnlyStub,
  makeRunner,
} from './agentRunner';
export type {
  DaemonAgentInput,
  DaemonAgentResult,
  DaemonAgentRunner,
  TriggerInvocationContext,
} from './agentRunner';
