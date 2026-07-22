/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { JobEngine } from './jobEngine';
import { runWithJobExecutionContext } from './jobExecutionContext';

export interface HttpJobCoordinatorOptions {
  engine: JobEngine;
  instanceId: string;
  leaseTtlMs?: number;
}

export interface HttpJobRouteOptions {
  entryPoint: string;
  source: string;
}

interface ActiveHttpJob {
  token: string;
  jobId: string;
  attemptId: string;
  runId: number;
  generation: number;
  fenceToken: string;
  jobStateVersion: number;
  attemptStateVersion: number;
  producer: string;
  heartbeat: ReturnType<typeof setInterval>;
  settled: boolean;
  loanConsumed: boolean;
}

const TOKEN_HEADER = 'x-aiden-internal-job-token';

function digestRequest(req: Request): string {
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  return createHash('sha256')
    .update(JSON.stringify({ method: req.method, originalUrl: req.originalUrl, body }))
    .digest('hex');
}

function sessionIdFor(req: Request): string {
  const body = req.body as Record<string, unknown> | undefined;
  const candidate = body?.sessionId ?? body?.user;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate.slice(0, 200)
    : `http:${randomUUID()}`;
}

export interface HttpJobCoordinator {
  middleware(options: HttpJobRouteOptions): RequestHandler;
  internalToken(res: Response): string | null;
  internalHeaders(token: string | null): Record<string, string>;
}

export function createHttpJobCoordinator(options: HttpJobCoordinatorOptions): HttpJobCoordinator {
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  const active = new Map<string, ActiveHttpJob>();

  const installProjection = (res: Response, handle: ActiveHttpJob): void => {
    res.setHeader('X-Aiden-Job-Id', handle.jobId);
    res.setHeader('X-Aiden-Attempt-Id', handle.attemptId);
    res.setHeader('X-Aiden-Run-Id', String(handle.runId));
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const projected = body as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(projected, 'job_id')) projected.job_id = handle.jobId;
        if (!Object.prototype.hasOwnProperty.call(projected, 'attempt_id')) projected.attempt_id = handle.attemptId;
        if (!Object.prototype.hasOwnProperty.call(projected, 'run_id')) projected.run_id = handle.runId;
      }
      return originalJson(body);
    }) as Response['json'];
  };

  const settle = (handle: ActiveHttpJob, res: Response, reason: 'finish' | 'close'): void => {
    if (handle.settled) return;
    handle.settled = true;
    clearInterval(handle.heartbeat);
    active.delete(handle.token);

    const interrupted = reason === 'close' && !res.writableFinished;
    const failed = res.statusCode >= 400;
    const attemptStatus = interrupted ? 'cancelled' : failed ? 'failed' : 'succeeded';
    const jobStatus = interrupted ? 'cancelled' : failed ? 'failed' : 'completed';
    const finishReason = interrupted ? 'client_disconnected' : failed ? 'http_error' : 'stop';
    const attempt = options.engine.transitionAttempt({
      attemptId: handle.attemptId,
      expectedStateVersion: handle.attemptStateVersion,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      to: attemptStatus,
      eventIdempotencyKey: `http-attempt-final:${handle.attemptId}:${handle.generation}`,
      producer: handle.producer,
      finishReason,
    });
    if (!attempt.applied) return;
    options.engine.finalizeJob({
      jobId: handle.jobId,
      attemptId: handle.attemptId,
      generation: handle.generation,
      fenceToken: handle.fenceToken,
      expectedStateVersion: handle.jobStateVersion,
      status: jobStatus,
      outcome: jobStatus,
      finishReason,
      evidence: { httpStatus: res.statusCode, responseFinished: res.writableFinished },
      eventIdempotencyKey: `http-job-final:${handle.jobId}:${handle.generation}`,
      producer: handle.producer,
    });
  };

  const middleware = (route: HttpJobRouteOptions): RequestHandler => (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const borrowedToken = req.header(TOKEN_HEADER);
    const borrowed = borrowedToken ? active.get(borrowedToken) : undefined;
    if (borrowedToken && !borrowed) {
      res.status(409).json({ error: 'invalid_internal_job_token' });
      return;
    }
    if (borrowed) {
      if (borrowed.loanConsumed) {
        res.status(409).json({ error: 'internal_job_token_consumed' });
        return;
      }
      const attempt = options.engine.getAttempt(borrowed.attemptId);
      if (
        !attempt
        || attempt.jobId !== borrowed.jobId
        || attempt.generation !== borrowed.generation
        || attempt.fenceToken !== borrowed.fenceToken
        || attempt.leaseExpiresAt === null
        || attempt.leaseExpiresAt <= Date.now()
      ) {
        res.status(409).json({ error: 'stale_internal_job' });
        return;
      }
      borrowed.loanConsumed = true;
      installProjection(res, borrowed);
      runWithJobExecutionContext({
        engine: options.engine,
        jobId: borrowed.jobId,
        attemptId: borrowed.attemptId,
        generation: borrowed.generation,
        fenceToken: borrowed.fenceToken,
        producer: borrowed.producer,
      }, () => next());
      return;
    }

    try {
      const fingerprint = digestRequest(req);
      const suppliedKey = req.header('idempotency-key')?.trim();
      const admitted = options.engine.submitJob({
        entryPoint: route.entryPoint,
        source: route.source,
        sessionId: sessionIdFor(req),
        instanceId: options.instanceId,
        idempotencyNamespace: `http:${route.entryPoint}`,
        idempotencyKey: suppliedKey || undefined,
        requestFingerprint: fingerprint,
        goal: `${route.entryPoint} request ${fingerprint.slice(0, 16)}`,
      });
      if (admitted.reused) {
        const existing = options.engine.getJob(admitted.jobId);
        res.status(existing?.terminalAt === null ? 202 : 200).json({
          accepted: true,
          duplicate: true,
          job_id: admitted.jobId,
          attempt_id: admitted.attemptId,
          run_id: admitted.runId,
        });
        return;
      }
      const lease = options.engine.claimAttempt({
        attemptId: admitted.attemptId,
        ownerId: options.instanceId,
        ttlMs: leaseTtlMs,
      });
      if (!lease.acquired || lease.generation === undefined || !lease.fenceToken || lease.stateVersion === undefined) {
        res.status(409).json({ error: 'job_lease_unavailable' });
        return;
      }
      const attemptRunning = options.engine.transitionAttempt({
        attemptId: admitted.attemptId,
        expectedStateVersion: lease.stateVersion,
        generation: lease.generation,
        fenceToken: lease.fenceToken,
        to: 'running',
        eventIdempotencyKey: `http-attempt-running:${admitted.attemptId}:${lease.generation}`,
        producer: route.source,
      });
      if (!attemptRunning.applied || attemptRunning.stateVersion === undefined) {
        res.status(409).json({ error: 'job_attempt_start_rejected' });
        return;
      }
      const jobRunning = options.engine.transitionJob({
        jobId: admitted.jobId,
        attemptId: admitted.attemptId,
        generation: lease.generation,
        fenceToken: lease.fenceToken,
        expectedStateVersion: 0,
        to: 'running',
        eventIdempotencyKey: `http-job-running:${admitted.jobId}:${lease.generation}`,
        producer: route.source,
      });
      if (!jobRunning.applied || jobRunning.stateVersion === undefined) {
        res.status(409).json({ error: 'job_start_rejected' });
        return;
      }

      const token = randomUUID();
      const handle: ActiveHttpJob = {
        token,
        jobId: admitted.jobId,
        attemptId: admitted.attemptId,
        runId: admitted.runId,
        generation: lease.generation,
        fenceToken: lease.fenceToken,
        jobStateVersion: jobRunning.stateVersion,
        attemptStateVersion: attemptRunning.stateVersion,
        producer: route.source,
        heartbeat: undefined as unknown as ReturnType<typeof setInterval>,
        settled: false,
        loanConsumed: false,
      };
      handle.heartbeat = setInterval(() => {
        const renewed = options.engine.renewAttemptLease({
          attemptId: handle.attemptId,
          ownerId: options.instanceId,
          generation: handle.generation,
          fenceToken: handle.fenceToken,
          ttlMs: leaseTtlMs,
        });
        if (!renewed.applied || renewed.stateVersion === undefined) {
          clearInterval(handle.heartbeat);
          return;
        }
        handle.attemptStateVersion = renewed.stateVersion;
      }, Math.max(1_000, Math.floor(leaseTtlMs / 3)));
      handle.heartbeat.unref?.();
      active.set(token, handle);
      installProjection(res, handle);
      res.once('finish', () => settle(handle, res, 'finish'));
      res.once('close', () => settle(handle, res, 'close'));
      (res.locals as Record<string, unknown>).durableJobToken = token;
      runWithJobExecutionContext({
        engine: options.engine,
        jobId: handle.jobId,
        attemptId: handle.attemptId,
        generation: handle.generation,
        fenceToken: handle.fenceToken,
        producer: handle.producer,
      }, () => next());
    } catch (error) {
      next(error);
    }
  };

  return {
    middleware,
    internalToken(res) {
      const value = (res.locals as Record<string, unknown>).durableJobToken;
      return typeof value === 'string' ? value : null;
    },
    internalHeaders(token) {
      return token ? { [TOKEN_HEADER]: token } : {};
    },
  };
}
