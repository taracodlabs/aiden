/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  currentJobExecutionContext,
  type JobExecutionContext,
} from '../daemon/jobExecutionContext';
import type {
  BrowserSessionAuthority,
  BrowserSessionBinding,
  BrowserSessionRecord,
} from './browserSessionAuthority';

export interface BrowserExecutionScope {
  authority: BrowserSessionAuthority;
  binding: BrowserSessionBinding;
  session: BrowserSessionRecord;
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<BrowserExecutionScope>();

export function currentBrowserExecutionScope(): BrowserExecutionScope | undefined {
  return storage.getStore();
}

function bindingFor(context: JobExecutionContext): BrowserSessionBinding {
  const job = context.engine.getJob(context.jobId);
  return {
    jobId: context.jobId,
    attemptId: context.attemptId,
    generation: context.generation,
    fenceToken: context.fenceToken,
    workspaceId: job?.workspaceId ?? null,
    mode: process.env.AIDEN_BROWSER_MODE === 'attached' ? 'attached' : 'owned',
    profileIdentity: process.env.AIDEN_BROWSER_PROFILE ?? 'aiden-default',
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason : new Error('Browser operation cancelled');
  throw reason;
}

/**
 * Bind a browser tool invocation to the exact active Job Attempt. Legacy calls
 * without a durable Job context retain their existing local behavior.
 */
export async function runWithAuthorizedBrowserSession<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = currentBrowserExecutionScope();
  if (existing) {
    assertNotAborted(signal ?? existing.signal);
    existing.authority.assertActionable(existing.binding);
    return operation();
  }
  const context = currentJobExecutionContext();
  if (!context) {
    assertNotAborted(signal);
    return operation();
  }
  const binding = bindingFor(context);
  const authority = context.engine.browser;
  const session = authority.ensureSession(binding);
  const activeSignal = signal ?? context.signal;
  assertNotAborted(activeSignal);
  return storage.run({ authority, binding, session, signal: activeSignal }, async () => {
    authority.assertActionable(binding);
    const value = await operation();
    assertNotAborted(activeSignal);
    const current = authority.getSession(session.browserSessionId);
    if (current?.state !== 'user_control_required' && current?.state !== 'user_control') {
      authority.assertActionable(binding);
    }
    return value;
  });
}
