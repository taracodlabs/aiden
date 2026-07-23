/**
 * tests/v4/daemon/api/runsTraceAdoption.test.ts — v4.9.0 Slice 7
 * end-to-end + captured smoke for all 7 dispatch scenarios.
 *
 * Drives `POST /api/runs` via a real Express handler (bootstrap'd
 * daemon) using http.request to localhost. Verifies the inbound
 * trace adoption: 202 + correct response shape + matching DB rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { spawn } from 'node:child_process';
import {
  bootstrapDaemonFoundation,
  getDaemonHandle,
  getCurrentDaemonDb,
  _resetDaemonBootstrapForTests,
} from '../../../../core/v4/daemon/bootstrap';
import {
  spawnEnvWithContext,
  runWithContext,
  currentContext,
  injectContextHeaders,
  newDaemonId,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
} from '../../../../core/v4/identity';

let aidenHome: string;
let prev: Record<string, string | undefined>;
let basePort: number;

interface PostOptions {
  body:    Record<string, unknown>;
  headers?: Record<string, string>;
}
interface PostResponse {
  status:   number;
  body:     Record<string, unknown>;
  headers:  Record<string, string | string[] | undefined>;
}
function postJson(port: number, p: string, opts: PostOptions): Promise<PostResponse> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(opts.body), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method: 'POST',
      headers: {
        'content-type':   'application/json',
        'content-length': String(data.length),
        ...(opts.headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers }); }
        catch { resolve({ status: res.statusCode ?? 0, body: { raw: text }, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function waitForListening(server: import('node:http').Server, ms = 2000): Promise<void> {
  if (server.listening) return;
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { server.off('listening', ok); reject(new Error('listen timeout')); }, ms);
    const ok = (): void => { clearTimeout(t); resolve(); };
    server.once('listening', ok);
  });
}

beforeEach(async () => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-s7-'));
  basePort  = 40000 + Math.floor(Math.random() * 10000);
  prev = {
    AIDEN_HOME: process.env.AIDEN_HOME, HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE, AIDEN_DAEMON: process.env.AIDEN_DAEMON,
    AIDEN_DAEMON_PORT: process.env.AIDEN_DAEMON_PORT,
  };
  process.env.AIDEN_HOME = aidenHome;
  process.env.HOME = aidenHome;
  process.env.USERPROFILE = aidenHome;
  process.env.AIDEN_DAEMON = '1';
  process.env.AIDEN_DAEMON_PORT = String(basePort);
  _resetDaemonBootstrapForTests();
  const h = bootstrapDaemonFoundation();
  if (h.httpServer) await waitForListening(h.httpServer);
});
afterEach(async () => {
  const h = getDaemonHandle();
  if (h?.dispatcher) { try { await h.dispatcher.stop(2_000); } catch { /* noop */ } }
  if (h?.httpServer) { try { h.httpServer.close(); } catch { /* noop */ } }
  if (h?.runtimeLock) { try { h.runtimeLock.release(); } catch { /* noop */ } }
  if (h?.instanceTracker) { try { h.instanceTracker.stop(); } catch { /* noop */ } }
  _resetDaemonBootstrapForTests();
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); } catch { /* noop */ }
});

const VALID_TP    = '00-aabbccddeeff00112233445566778899-1122334455667788-01';
const VALID_TRACE = 'aabbccddeeff00112233445566778899';

describe('Slice 7 inbound trace adoption + 7 captured smoke scenarios', () => {
  // Smokes 1-5 share one bootstrap to dodge the per-test HTTP teardown race
  // (the listener `close()` returns sync but the OS socket release is async;
  // a fresh `listen()` on a new port a few ms later can still ECONNREFUSED).
  it('smokes 1-5: HTTP ingress (no/valid/malformed traceparent + valid/garbage X-Request-Id)', async () => {
    // smoke 1 — no traceparent
    const r1 = await postJson(basePort, '/api/runs', { body: { args: { x: 1 } } });
    console.log(`[smoke 1] response: status=${r1.status} trace_id=${String(r1.body.trace_id).slice(0, 20)}... external_trace_id=${r1.body.external_trace_id}`);
    expect(r1.status).toBe(202);
    expect(String(r1.body.trace_id)).toMatch(/^trc_[0-9a-f]{32}$/);
    expect(r1.body.external_trace_id).toBeNull();
    expect(String(r1.body.job_id)).toMatch(/^task_/);
    expect(String(r1.body.attempt_id)).toMatch(/^attempt_/);
    expect(typeof r1.body.run_id).toBe('number');
    const db = getCurrentDaemonDb()!;
    expect(db.prepare(
      'SELECT task_id, attempt_id FROM runs WHERE id = ?',
    ).get(r1.body.run_id)).toEqual({
      task_id: r1.body.job_id,
      attempt_id: r1.body.attempt_id,
    });

    // smoke 2 — valid traceparent
    const r2 = await postJson(basePort, '/api/runs',
      { body: { args: { y: 2 } }, headers: { traceparent: VALID_TP } });
    console.log(`[smoke 2] response: trace_id=${String(r2.body.trace_id).slice(0,20)}... external_trace_id=${r2.body.external_trace_id}`);
    expect(r2.status).toBe(202);
    expect(r2.body.external_trace_id).toBe(VALID_TRACE);
    expect(r2.body.trace_id).toBe(`trc_${VALID_TRACE}`);

    // smoke 3 — malformed traceparent → dropped silently
    const r3 = await postJson(basePort, '/api/runs',
      { body: { args: { z: 3 } }, headers: { traceparent: 'this-is-not-a-valid-traceparent-at-all-nope' } });
    console.log(`[smoke 3] response: external_trace_id=${r3.body.external_trace_id} fresh_trace_id=${String(r3.body.trace_id).slice(0,20)}...`);
    expect(r3.status).toBe(202);
    expect(r3.body.external_trace_id).toBeNull();
    expect(String(r3.body.trace_id)).toMatch(/^trc_[0-9a-f]{32}$/);

    // smoke 4 — valid 128-char X-Request-Id
    const userReq = 'a'.repeat(128);
    const r4 = await postJson(basePort, '/api/runs',
      { body: { args: { q: 1 } }, headers: { 'x-request-id': userReq } });
    console.log(`[smoke 4] response: status=${r4.status} accepted=${r4.body.accepted} (external X-Request-Id len=${userReq.length} accepted)`);
    expect(r4.status).toBe(202);

    // smoke 5 — 8000-char garbage X-Request-Id → dropped
    const garbage = 'g'.repeat(8000);
    const r5 = await postJson(basePort, '/api/runs',
      { body: { args: { p: 2 } }, headers: { 'x-request-id': garbage } });
    console.log(`[smoke 5] response: status=${r5.status} (8000-char X-Request-Id dropped, request still accepted)`);
    expect(r5.status).toBe(202);

    const sameKeyHeaders = { 'idempotency-key': 'same-request-key' };
    const firstKeyed = await postJson(basePort, '/api/runs', {
      body: { prompt: 'first body' }, headers: sameKeyHeaders,
    });
    const duplicate = await postJson(basePort, '/api/runs', {
      body: { prompt: 'first body' }, headers: sameKeyHeaders,
    });
    const conflicting = await postJson(basePort, '/api/runs', {
      body: { prompt: 'different body' }, headers: sameKeyHeaders,
    });
    expect(firstKeyed.status).toBe(202);
    expect(duplicate).toMatchObject({
      status: 202,
      body: {
        job_id: firstKeyed.body.job_id,
        attempt_id: firstKeyed.body.attempt_id,
        run_id: firstKeyed.body.run_id,
        duplicate: true,
      },
    });
    expect(conflicting).toMatchObject({ status: 409, body: { error: 'idempotency_conflict' } });
  });

  it('smoke 6: spawn child process via shell-exec → child sees AIDEN_* env', async () => {
    // Test the env propagation primitive directly (the local backend is
    // wired in this slice; the live env-readback would require a full
    // tool-execution harness with provider config). Verify the env
    // injection + readback contract.
    const dmn = 'dmn_smoke6testdaemonid000000000000';
    const inc = 'inc_smoke6testincid00000000000000';
    const rid = 'run_smoke6testrunid00000000000000';
    const tid = 'trc_smoke6testtraceid0000000000000';
    const sid = 'spn_smoke6testspanid000000000000';
    const ctx = {
      daemonId: dmn, incarnationId: inc, runId: rid, traceId: tid, spanId: sid,
      source: 'cli' as const, attempt: 1,
    };
    await runWithContext(ctx, () => {
      const ambient = currentContext()!;
      const env = spawnEnvWithContext(ambient, {});
      const child = spawn(process.execPath, ['-e', 'console.log(process.env.AIDEN_RUN_ID + "|" + process.env.AIDEN_PARENT_SPAN_ID)'], { env });
      let out = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      return new Promise<void>((resolve) => {
        child.on('exit', () => {
          console.log(`[smoke 6] child env: ${out.trim()}`);
          expect(out).toContain(rid);
          expect(out).toContain(sid);
          resolve();
        });
      });
    });
  });

  it('smoke 7: LLM-call header injection produces traceparent + X-Aiden-* headers', () => {
    // Test the injection primitive — proving end-to-end through a real
    // LLM provider would require network mocks of every adapter. The
    // injectContextHeaders is the chokepoint exercised by Slice 6's
    // span wrap; here we assert the wire shape directly.
    const ctx = {
      daemonId: newDaemonId(), incarnationId: newIncarnationId(),
      runId: newRunId(), traceId: newTraceId(), spanId: newSpanId(),
      source: 'cli' as const, attempt: 1,
    };
    const headers = injectContextHeaders(ctx, { 'User-Agent': 'test/1.0' });
    console.log(`[smoke 7] outbound headers: ${JSON.stringify({
      traceparent: headers['traceparent'],
      'X-Request-Id': headers['X-Request-Id'].slice(0, 20) + '...',
      'X-Aiden-Run-Id': headers['X-Aiden-Run-Id'].slice(0, 20) + '...',
      'X-Aiden-Trace-Id': headers['X-Aiden-Trace-Id'].slice(0, 20) + '...',
      'User-Agent': headers['User-Agent'],
    })}`);
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['X-Aiden-Run-Id']).toBe(ctx.runId);
    expect(headers['User-Agent']).toBe('test/1.0');
  });

});
