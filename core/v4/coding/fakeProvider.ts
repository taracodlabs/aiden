/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createExternalCodingCapabilitySnapshot } from './capability';
import {
  ExternalCodingProviderError,
  type ExternalCodingAgentProvider,
  type ExternalCodingProviderEvent,
  type ExternalCodingProviderInputRequest,
  type ExternalCodingProviderReconciliation,
  type ExternalCodingProviderSessionHandle,
  type ExternalCodingProviderStartRequest,
  type ExternalCodingProviderState,
  type ExternalCodingProviderTaskRequest,
  type ExternalCodingProviderVersion,
} from './provider';
import type { ExternalCodingCandidateResult } from './types';

export type FakeExternalCodingScenario =
  | 'success'
  | 'false_success'
  | 'hang'
  | 'crash'
  | 'crash_after_edit'
  | 'clarification'
  | 'approval'
  | 'large_output'
  | 'spawn_child'
  | 'forbidden_path'
  | 'network_attempt'
  | 'unknown_outcome'
  | 'start_failure'
  | 'transport_loss_after_edit';

export interface FakeExternalCodingProviderOptions {
  scenario: FakeExternalCodingScenario;
  version?: string;
  supported?: boolean;
  now?: () => number;
}

interface FakeSession {
  request: ExternalCodingProviderStartRequest;
  handle: ExternalCodingProviderSessionHandle;
  state: ExternalCodingProviderState['state'];
  events: ExternalCodingProviderEvent[];
  result: ExternalCodingCandidateResult | null;
  cancelled: boolean;
  closed: boolean;
  nextInputSequence: number;
}

function assertContained(workspace: string, target: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new ExternalCodingProviderError('OUTSIDE_WORKSPACE', 'Fake coding scenario attempted an outside-workspace path');
}

/** Deterministic failure-injection provider used as the CI authority. */
export class FakeExternalCodingProvider implements ExternalCodingAgentProvider {
  readonly id = 'fake_coding';
  readonly label = 'Deterministic coding fixture';
  private readonly sessions = new Map<string, FakeSession>();
  private readonly now: () => number;

  constructor(private readonly options: FakeExternalCodingProviderOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async detect() {
    return { available: true, executable: 'fake-coding-runtime', reason: null } as const;
  }

  async health() {
    return { healthy: true, authentication: 'not_required', detail: 'ready' } as const;
  }

  async version(): Promise<ExternalCodingProviderVersion> {
    const normalized = this.options.version ?? '1.0.0';
    return { raw: normalized, normalized, supported: this.options.supported ?? true };
  }

  async capabilities() {
    const version = await this.version();
    return createExternalCodingCapabilitySnapshot({
      capabilityId: 'external-coding:fake',
      providerId: this.id,
      providerVersion: version.normalized,
      protocolMode: 'structured',
      protocolVersion: '1',
      supportedFeatures: {
        structuredProtocol: true,
        pty: false,
        resume: false,
        semanticEvents: true,
        clarification: true,
        approvalEvents: true,
        nativeDiff: false,
        nativeTestEvents: true,
        networkRequired: false,
        processTreeGuarantee: 'supervised',
        commandVisibility: 'mediated',
      },
      runtimeCompatibility: { platforms: ['darwin', 'linux', 'win32'], node: '>=20' },
      capturedAt: 1,
    });
  }

  async startSession(request: ExternalCodingProviderStartRequest): Promise<ExternalCodingProviderSessionHandle> {
    if (request.sandbox.required && !request.sandbox.available) {
      throw new ExternalCodingProviderError('SANDBOX_UNAVAILABLE', 'Required coding sandbox is unavailable');
    }
    if (this.options.scenario === 'start_failure') {
      throw new ExternalCodingProviderError('START_FAILED', 'Fake coding runtime failed before task dispatch');
    }
    if (this.sessions.has(request.codingSessionId)) {
      const prior = this.sessions.get(request.codingSessionId)!;
      if (prior.request.childAttemptId !== request.childAttemptId || prior.request.generation !== request.generation) {
        throw new ExternalCodingProviderError('SESSION_IDENTITY_CONFLICT', 'Provider session identity has different authority');
      }
      return prior.handle;
    }
    const handle: ExternalCodingProviderSessionHandle = {
      providerSessionId: `fake_provider_session_${randomBytes(12).toString('hex')}`,
      codingSessionId: request.codingSessionId,
      protocolMode: 'structured',
      processIdentity: null,
    };
    const session: FakeSession = {
      request,
      handle,
      state: 'running',
      events: [],
      result: null,
      cancelled: false,
      closed: false,
      nextInputSequence: 2,
    };
    this.sessions.set(request.codingSessionId, session);
    this.emit(session, 'session.started', { protocolMode: 'structured' });
    this.emit(session, 'session.ready', { workspace: 'isolated' });
    return handle;
  }

  async sendTask(request: ExternalCodingProviderTaskRequest): Promise<void> {
    const session = this.require(request.providerSessionId);
    this.assertAuthority(session, request);
    if (session.cancelled || session.state === 'terminal') {
      throw new ExternalCodingProviderError('SESSION_TERMINAL', 'Provider session is terminal');
    }
    const workspace = session.request.workspacePath;
    switch (this.options.scenario) {
      case 'success': {
        const target = assertContained(workspace, 'result.txt');
        await writeFile(target, 'FAKE_CODING_RESULT\n', 'utf8');
        this.emit(session, 'file.activity', { operation: 'write', path: 'result.txt' });
        session.result = {
          summary: 'Requested candidate change was prepared.',
          reportedFiles: ['result.txt'],
          reportedValidations: [],
          externalOutcome: 'completed',
        };
        this.emit(session, 'result.reported', session.result as unknown as Record<string, unknown>);
        session.state = 'terminal';
        break;
      }
      case 'false_success':
        session.result = {
          summary: 'Reported a change that was not made.',
          reportedFiles: ['result.txt'],
          reportedValidations: ['tests passed'],
          externalOutcome: 'completed',
        };
        this.emit(session, 'result.reported', session.result as unknown as Record<string, unknown>);
        session.state = 'terminal';
        break;
      case 'hang':
        this.emit(session, 'inspection.started', { target: 'repository' });
        break;
      case 'crash':
        this.emit(session, 'process.terminal', { exitCode: 17, outcomeKnown: true });
        session.result = { summary: 'Process failed.', reportedFiles: [], reportedValidations: [], externalOutcome: 'failed' };
        session.state = 'terminal';
        break;
      case 'crash_after_edit':
      case 'transport_loss_after_edit':
      case 'unknown_outcome': {
        await writeFile(assertContained(workspace, 'partial.txt'), 'partial\n', 'utf8');
        this.emit(session, 'file.activity', { operation: 'write', path: 'partial.txt' });
        this.emit(session, 'process.terminal', { exitCode: null, outcomeKnown: false });
        session.result = { summary: 'Outcome is unknown.', reportedFiles: [], reportedValidations: [], externalOutcome: 'unknown' };
        session.state = 'unknown';
        break;
      }
      case 'clarification':
        this.emit(session, 'clarification.requested', { requestId: 'fake_clarification', question: 'Which storage should be used?' });
        session.state = 'waiting';
        break;
      case 'approval':
        this.emit(session, 'approval.requested', { requestId: 'fake_approval', operation: 'package.install' });
        session.state = 'waiting';
        break;
      case 'large_output':
        this.emit(session, 'command.completed', { output: 'x'.repeat(256 * 1024), truncated: false });
        session.result = { summary: 'Large output produced.', reportedFiles: [], reportedValidations: [], externalOutcome: 'completed' };
        this.emit(session, 'result.reported', session.result as unknown as Record<string, unknown>);
        session.state = 'terminal';
        break;
      case 'spawn_child':
        this.emit(session, 'command.started', { commandClass: 'child_process', childRequested: true });
        break;
      case 'forbidden_path':
        await mkdir(path.dirname(assertContained(workspace, 'protected.txt')), { recursive: true });
        await writeFile(assertContained(workspace, 'protected.txt'), 'forbidden mutation\n', 'utf8');
        this.emit(session, 'file.activity', { operation: 'write', path: 'protected.txt', policyViolation: true });
        session.result = { summary: 'Protected mutation attempted.', reportedFiles: ['protected.txt'], reportedValidations: [], externalOutcome: 'completed' };
        this.emit(session, 'result.reported', session.result as unknown as Record<string, unknown>);
        session.state = 'terminal';
        break;
      case 'network_attempt':
        this.emit(session, 'command.requested', { commandClass: 'network', policyViolation: true });
        session.state = 'waiting';
        break;
    }
  }

  async sendInput(request: ExternalCodingProviderInputRequest): Promise<void> {
    const session = this.require(request.providerSessionId);
    this.assertAuthority(session, request);
    if (request.sequence !== session.nextInputSequence) {
      throw new ExternalCodingProviderError('INPUT_SEQUENCE_CONFLICT', 'Provider input sequence is not the next expected value');
    }
    session.nextInputSequence += 1;
    if (request.kind === 'clarification') {
      this.emit(session, 'inspection.started', { clarificationRequestId: request.requestId });
      session.result = {
        summary: 'Clarification was received and the coding task completed.',
        reportedFiles: [],
        reportedValidations: [],
        externalOutcome: 'completed',
      };
      this.emit(session, 'result.reported', session.result as unknown as Record<string, unknown>);
      session.state = 'terminal';
      return;
    }
    if (request.kind === 'approval') {
      this.emit(session, 'command.requested', { approvalRequestId: request.requestId, responseReceived: true });
      if (request.content === 'approved') {
        await writeFile(assertContained(session.request.workspacePath, 'approved.txt'), 'approved operation\n', 'utf8');
      }
      session.result = {
        summary: request.content === 'approved' ? 'Approved operation completed.' : 'Operation was not approved.',
        reportedFiles: request.content === 'approved' ? ['approved.txt'] : [],
        reportedValidations: [],
        externalOutcome: 'completed',
      };
      this.emit(session, 'result.reported', session.result as unknown as Record<string, unknown>);
      session.state = 'terminal';
    }
  }

  async events(providerSessionId: string, afterCursor: number): Promise<readonly ExternalCodingProviderEvent[]> {
    const session = this.require(providerSessionId);
    if (this.options.scenario === 'transport_loss_after_edit') {
      throw new ExternalCodingProviderError('TRANSPORT_LOST', 'Fake coding transport was lost after a possible mutation');
    }
    return session.events.filter((event) => event.cursor > afterCursor);
  }

  async cancel(providerSessionId: string, reason: string): Promise<void> {
    const session = this.require(providerSessionId);
    if (session.state === 'terminal') return;
    session.cancelled = true;
    if (session.state === 'unknown') {
      this.emit(session, 'process.terminal', { cancelled: true, reason, outcomeKnown: false });
      return;
    }
    session.state = 'terminal';
    session.result = { summary: reason, reportedFiles: [], reportedValidations: [], externalOutcome: 'cancelled' };
    this.emit(session, 'process.terminal', { cancelled: true, reason });
  }

  async terminate(providerSessionId: string): Promise<void> {
    await this.cancel(providerSessionId, 'terminated');
  }

  async inspectState(providerSessionId: string): Promise<ExternalCodingProviderState> {
    const session = this.require(providerSessionId);
    return {
      state: session.state,
      processIdentity: null,
      lastCursor: session.events[session.events.length - 1]?.cursor ?? 0,
      detail: session.cancelled ? 'cancelled' : session.state,
    };
  }

  async collectResult(providerSessionId: string): Promise<ExternalCodingCandidateResult | null> {
    return this.require(providerSessionId).result;
  }

  async reconcile(providerSessionId: string): Promise<ExternalCodingProviderReconciliation> {
    const session = this.require(providerSessionId);
    if (session.result?.externalOutcome === 'unknown' || session.state === 'unknown') {
      return {
        outcome: 'unknown', retrySafe: false, reason: 'A mutation may have occurred before process loss.',
        observedProcessTreeDead: true, result: session.result,
      };
    }
    return {
      outcome: session.result?.externalOutcome ?? (session.state === 'running' ? 'running' : 'not_started'),
      retrySafe: session.result === null,
      reason: session.result?.summary ?? session.state,
      observedProcessTreeDead: session.state === 'terminal',
      result: session.result,
    };
  }

  async close(providerSessionId: string): Promise<void> {
    this.require(providerSessionId).closed = true;
  }

  private emit(session: FakeSession, type: ExternalCodingProviderEvent['type'], payload: Record<string, unknown>): void {
    const cursor = session.events.length + 1;
    session.events.push({
      providerEventId: `fake_event_${cursor}`,
      cursor,
      type,
      payload,
      observedAt: this.now(),
    });
  }

  private require(providerSessionId: string): FakeSession {
    const session = [...this.sessions.values()].find((item) => item.handle.providerSessionId === providerSessionId);
    if (!session) throw new ExternalCodingProviderError('PROVIDER_SESSION_NOT_FOUND', 'Coding provider session was not found');
    return session;
  }

  private assertAuthority(
    session: FakeSession,
    input: { codingSessionId: string; childAttemptId: string; generation: number },
  ): void {
    if (session.request.codingSessionId !== input.codingSessionId
      || session.request.childAttemptId !== input.childAttemptId
      || session.request.generation !== input.generation) {
      throw new ExternalCodingProviderError('STALE_PROVIDER_INPUT', 'Coding provider input authority is stale');
    }
  }
}
