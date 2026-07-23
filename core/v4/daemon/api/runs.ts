/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/api/runs.ts — v4.9.0 Slice 5.
 *
 * `POST /api/runs` — durable run-acceptance ingress. The handler:
 *
 *   1. Validates the body (must contain at least `args` or `prompt`).
 *   2. Computes a fingerprint from a canonical JSON of the body.
 *   3. Honours a caller-supplied `Idempotency-Key` header (Stripe/RFC
 *      pattern). If absent, falls back to the body fingerprint itself.
 *   4. Calls `triggerBus.insert({source:'api',...})`, which (with
 *      `enableRunIdempotency:true`) atomically writes both the
 *      `trigger_events` row AND the `run_idempotency_keys` anchor.
 *   5. Returns `202` with the persisted trigger_event id — the
 *      dispatcher picks the row up off the queue and creates the
 *      `runs` row downstream. This is the "202 only after durable
 *      insert" guarantee.
 *
 * AUTH: the existing bind-safety check covers non-loopback binds; this
 * endpoint inherits the same `AIDEN_API_KEY` requirement when the
 * daemon binds beyond 127.0.0.1. Loopback-only callers (the common
 * case) authenticate by being on-host.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';

import type { TriggerBus } from '../triggerBus';
import type { Db } from '../db/connection';
import { IdempotencyConflictError, type JobEngine } from '../jobEngine';
import { createJobControlAuthority, type JobControlAuthority } from '../jobControlAuthority';
import { fingerprintCanonical } from '../idempotency/runIdempotencyStore';
// v4.9.0 Slice 7 — inbound trace adoption.
import {
  parseTraceparent,
  validateExternalRequestId,
  runWithContext,
  newTraceId,
  newSpanId,
  newRequestId,
  newRunId,
  type ExecutionContext,
} from '../../identity';
import { getCurrentDaemonId, getCurrentIncarnationId, getCurrentDaemonDb } from '../bootstrap';

export interface MountRunsRoutesOptions {
  app:        Express;
  triggerBus: TriggerBus;
  db:         Db;
  jobEngine:  JobEngine;
  instanceId: string;
  jobControlAuthority?: JobControlAuthority;
  log:        (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Optional shared-secret check via `AIDEN_API_KEY` env var. */
  apiKeyRequired?: boolean;
}

export interface MountedRunsRoutes {
  /** Endpoint path (diagnostic). */
  path: string;
}

export function mountRunsRoutes(opts: MountRunsRoutesOptions): MountedRunsRoutes {
  const PATH = '/api/runs';
  const controlAuthority = opts.jobControlAuthority ?? createJobControlAuthority({
    db: opts.db,
    jobEngine: opts.jobEngine,
  });

  const authorized = (req: Request, res: Response): boolean => {
    if (!opts.apiKeyRequired) return true;
    const expected = process.env.AIDEN_API_KEY ?? '';
    const auth = req.header('authorization') ?? '';
    const tokenMatch = /^Bearer\s+(\S+)/i.exec(auth);
    const provided = tokenMatch ? tokenMatch[1] : '';
    if (expected && expected === provided) return true;
    res.status(401).json({ error: 'unauthorized' });
    return false;
  };

  opts.app.post(
    PATH,
    express.json({ limit: '1mb' }),
    (req: Request, res: Response, _next: NextFunction): void => {
      // Optional shared-secret auth.
      if (!authorized(req, res)) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ error: 'body must be a JSON object' });
        return;
      }
      if (!body.args && !body.prompt) {
        res.status(400).json({ error: 'body requires `args` or `prompt`' });
        return;
      }

      const fingerprint = fingerprintCanonical(body);
      const headerKey   = (req.header('idempotency-key') ?? '').trim();
      const idempotencyKey = headerKey.length > 0 ? headerKey : fingerprint;
      const sourceKey = (typeof body.client_id === 'string' && body.client_id.length > 0)
        ? body.client_id
        : 'default';

      // v4.9.0 Slice 7 — inbound trace adoption.
      const incomingTp = parseTraceparent(req.header('traceparent'));
      const rawIncomingTp = req.header('traceparent');
      if (rawIncomingTp && !incomingTp) {
        opts.log('warn',
          `[api/runs] dropped malformed traceparent header (length=${rawIncomingTp.length})`);
      }
      const rawExternalReqId = req.header('x-request-id');
      const externalReqId = validateExternalRequestId(rawExternalReqId);
      if (rawExternalReqId && externalReqId === null) {
        opts.log('warn',
          `[api/runs] dropped invalid X-Request-Id header (length=${rawExternalReqId.length})`);
      }

      const ctx: ExecutionContext = {
        daemonId:          getCurrentDaemonId()      ?? '',
        incarnationId:     getCurrentIncarnationId() ?? '',
        runId:             newRunId(),  // pre-claim run id (dispatcher assigns final numeric id)
        traceId:           incomingTp ? `trc_${incomingTp.traceId}` : newTraceId(),
        spanId:            newSpanId(),
        parentSpanId:      incomingTp?.parentSpanId ?? undefined,
        requestId:         newRequestId(),
        externalRequestId: externalReqId ?? undefined,
        source:            'api',
        attempt:           1,
      };

      void runWithContext(ctx, () => {
        try {
          const accepted = opts.db.transaction(() => {
            const result = opts.triggerBus.insert({
              source:         'manual',
              sourceKey,
              idempotencyKey,
              payload:        {
                body, fingerprint, headerKey,
                external_trace_id:  incomingTp?.traceId ?? null,
                external_request_id: externalReqId ?? null,
              },
            });
            const sessionId = `api:${sourceKey}:${idempotencyKey.slice(0, 24)}`;
            const admission = opts.jobEngine.submitJob({
              entryPoint: 'daemon_api',
              source: 'api',
              sessionId,
              instanceId: opts.instanceId,
              idempotencyNamespace: `daemon-api:${sourceKey}`,
              idempotencyKey,
              requestFingerprint: fingerprint,
              goal: `Daemon API request ${fingerprint.slice(0, 16)}`,
              triggerEventId: result.id,
            });
            opts.db.prepare(
              `UPDATE trigger_events
                  SET payload_json = ?
                WHERE id = ?`,
            ).run(JSON.stringify({
              body, fingerprint, headerKey,
              external_trace_id: incomingTp?.traceId ?? null,
              external_request_id: externalReqId ?? null,
              durable_job: {
                job_id: admission.jobId,
                attempt_id: admission.attemptId,
                run_id: admission.runId,
              },
            }), result.id);
            return { result, admission };
          })();
          const { result, admission } = accepted;
          // Persist `external_trace_id` on the trigger payload so the
          // dispatcher can copy it onto the `runs` row when it
          // creates one. We can't write to `runs` here (no run row
          // yet), but the payload carries the value.
          opts.log('info',
            `[api/runs] accepted trigger_event_id=${result.id} ` +
            `${incomingTp ? `external_trace_id=${incomingTp.traceId} ` : ''}` +
            `${externalReqId ? `external_request_id=${externalReqId}` : ''}`);
          res.status(202).json({
            accepted:            true,
            duplicate:           !result.inserted,
            trigger_event_id:    result.id,
            idempotency_key:     idempotencyKey,
            run_id:              admission.runId,
            job_id:              admission.jobId,
            attempt_id:          admission.attemptId,
            trace_id:            ctx.traceId,
            external_trace_id:   incomingTp?.traceId ?? null,
          });
        } catch (e) {
          if (e instanceof IdempotencyConflictError) {
            opts.log('warn', `[api/runs] idempotency conflict namespace=${e.namespace}`);
            res.status(409).json({ error: 'idempotency_conflict' });
            return;
          }
          opts.log('error', `[api/runs] insert failed: ${e instanceof Error ? e.message : String(e)}`);
          res.status(500).json({ error: 'internal_error' });
        }
      });
      // Quiet unused-warning on the db handle; future Slice 8 uses it
      // to back-fill the `runs.external_trace_id` column on creation.
      void getCurrentDaemonDb;
    },
  );

  opts.app.post(
    `${PATH}/:attemptId/:command`,
    express.json({ limit: '64kb' }),
    (req: Request, res: Response): void => {
      if (!authorized(req, res)) return;
      const command = String(req.params.command ?? '');
      if (!['input', 'pause', 'resume', 'cancel', 'interrupt'].includes(command)) {
        res.status(404).json({ error: 'unknown_run_command' });
        return;
      }
      const attempt = opts.jobEngine.getAttempt(String(req.params.attemptId ?? ''));
      if (!attempt) { res.status(404).json({ error: 'attempt_not_found' }); return; }
      const job = attempt.jobId ? opts.jobEngine.getJob(attempt.jobId) : null;
      if (!job) { res.status(404).json({ error: 'job_not_found' }); return; }
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const providedKey = (req.header('idempotency-key') ?? '').trim();
      const key = providedKey || newRequestId();
      try {
        if (command === 'input') {
          const content = typeof body.message === 'string' ? body.message : '';
          if (!content.trim()) { res.status(400).json({ error: 'message_required' }); return; }
          const received = controlAuthority.inputs.receive({
            jobId: attempt.jobId,
            targetAttemptId: attempt.id,
            targetGeneration: attempt.generation,
            sessionId: job.sessionId,
            channelId: 'daemon-api',
            source: 'api',
            kind: 'message',
            content,
            idempotencyNamespace: 'daemon-api-input',
            idempotencyKey: key,
          });
          res.status(202).json({
            accepted: true,
            duplicate: received.duplicate,
            input_id: received.record.inputId,
            job_id: attempt.jobId,
            attempt_id: attempt.id,
          });
          return;
        }
        if (command === 'resume') {
          const resumed = controlAuthority.commands.resume({
            jobId: attempt.jobId,
            source: 'api',
            instanceId: opts.instanceId,
            idempotencyNamespace: 'daemon-api-control',
            idempotencyKey: key,
          });
          const trigger = opts.triggerBus.insert({
            source: 'manual',
            sourceKey: `api-resume:${attempt.jobId}`,
            idempotencyKey: `resume:${key}`,
            payload: {
              body: { prompt: job.goal, source: 'api-resume' },
              sessionId: job.sessionId,
              durable_job: {
                job_id: job.id,
                attempt_id: resumed.attemptId,
                run_id: resumed.runId,
              },
            },
          });
          opts.db.prepare('UPDATE runs SET trigger_event_id = ? WHERE attempt_id = ?')
            .run(trigger.id, resumed.attemptId);
          res.status(202).json({
            accepted: true,
            duplicate: resumed.duplicate,
            control_id: resumed.controlId,
            job_id: attempt.jobId,
            attempt_id: resumed.attemptId,
            run_id: resumed.runId,
            generation: resumed.generation,
            trigger_event_id: trigger.id,
          });
          return;
        }
        const result = controlAuthority.commands.request({
          jobId: attempt.jobId,
          attemptId: attempt.id,
          generation: attempt.generation,
          kind: command as 'pause' | 'cancel' | 'interrupt',
          source: 'api',
          reason: typeof body.reason === 'string' ? body.reason : command,
          idempotencyNamespace: 'daemon-api-control',
          idempotencyKey: key,
        });
        res.status(202).json({
          accepted: true,
          persisted: result.persisted,
          applied: result.applied,
          duplicate: result.duplicate,
          control_id: result.controlId,
          job_id: attempt.jobId,
          attempt_id: attempt.id,
        });
      } catch (error) {
        opts.log('warn', `[api/runs] ${command} rejected: ${error instanceof Error ? error.message : String(error)}`);
        res.status(409).json({ error: 'run_command_rejected' });
      }
    },
  );

  return { path: PATH };
}
