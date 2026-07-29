/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { JobEngine } from './jobEngine';
import { runWithJobExecutionContext } from './jobExecutionContext';
import {
  DurableJobDuplicateAdmissionError,
  executeDurableJob,
  type DurableJobHandle,
} from './jobLifecycle';

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
  handle: DurableJobHandle;
  producer: string;
  loanConsumed: boolean;
}

interface HttpExecutionOutcome {
  reason: 'finish' | 'close';
  statusCode: number;
  responseFinished: boolean;
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

  const installProjection = (res: Response, handle: DurableJobHandle): void => {
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
      const attempt = options.engine.getAttempt(borrowed.handle.attemptId);
      if (
        !attempt
        || attempt.jobId !== borrowed.handle.jobId
        || attempt.generation !== borrowed.handle.generation
        || attempt.fenceToken !== borrowed.handle.fenceToken
        || attempt.leaseExpiresAt === null
        || attempt.leaseExpiresAt <= Date.now()
      ) {
        res.status(409).json({ error: 'stale_internal_job' });
        return;
      }
      borrowed.loanConsumed = true;
      installProjection(res, borrowed.handle);
      runWithJobExecutionContext({
        engine: options.engine,
        jobId: borrowed.handle.jobId,
        attemptId: borrowed.handle.attemptId,
        generation: borrowed.handle.generation,
        fenceToken: borrowed.handle.fenceToken,
        producer: borrowed.producer,
      }, () => next());
      return;
    }

    const fingerprint = digestRequest(req);
    const suppliedKey = req.header('idempotency-key')?.trim();
    void executeDurableJob<HttpExecutionOutcome>({
      engine: options.engine,
      ownerId: options.instanceId,
      leaseTtlMs,
      admission: {
        entryPoint: route.entryPoint,
        source: route.source,
        sessionId: sessionIdFor(req),
        workspaceId: process.cwd(),
        instanceId: options.instanceId,
        idempotencyNamespace: `http:${route.entryPoint}`,
        idempotencyKey: suppliedKey || undefined,
        requestFingerprint: fingerprint,
        goal: `${route.entryPoint} request ${fingerprint.slice(0, 16)}`,
      },
      execute: (handle) => new Promise<HttpExecutionOutcome>((resolve, reject) => {
        const token = randomUUID();
        const activeHandle: ActiveHttpJob = {
          token,
          handle,
          producer: route.source,
          loanConsumed: false,
        };
        active.set(token, activeHandle);
        installProjection(res, handle);
        (res.locals as Record<string, unknown>).durableJobToken = token;

        let settled = false;
        const settle = (reason: HttpExecutionOutcome['reason']): void => {
          if (settled) return;
          settled = true;
          active.delete(token);
          resolve({ reason, statusCode: res.statusCode, responseFinished: res.writableFinished });
        };
        res.once('finish', () => settle('finish'));
        res.once('close', () => settle('close'));
        try {
          next();
        } catch (error) {
          active.delete(token);
          reject(error);
        }
      }),
      finalize: (outcome) => {
        const interrupted = outcome.reason === 'close' && !outcome.responseFinished;
        const failed = outcome.statusCode >= 400;
        if (interrupted) {
          return {
            status: 'cancelled',
            outcome: 'cancelled',
            finishReason: 'client_disconnected',
            evidence: { httpStatus: outcome.statusCode, responseFinished: false },
          };
        }
        if (failed) {
          return {
            status: 'failed',
            outcome: 'failed',
            finishReason: 'http_error',
            evidence: { httpStatus: outcome.statusCode, responseFinished: outcome.responseFinished },
          };
        }
        return {
          status: 'completed',
          outcome: 'completed_unverified',
          finishReason: 'http_response_completed',
          evidence: {
            httpStatus: outcome.statusCode,
            responseFinished: outcome.responseFinished,
            verification: 'compatibility_response_only',
          },
        };
      },
    }).catch((error: unknown) => {
      if (error instanceof DurableJobDuplicateAdmissionError) {
        if (res.headersSent) return;
        const existing = options.engine.getJob(error.admission.jobId);
        res.status(existing?.terminalAt === null ? 202 : 200).json({
          accepted: true,
          duplicate: true,
          job_id: error.admission.jobId,
          attempt_id: error.admission.attemptId,
          run_id: error.admission.runId,
        });
        return;
      }
      if (!res.headersSent) next(error);
    });
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
