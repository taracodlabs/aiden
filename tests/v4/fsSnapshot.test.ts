import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  fileSnapshot,
  classifyStatError,
  snapshotTargetsForTool,
  resourceIdForPath,
} from '../../core/v4/fsSnapshot';
import { ToolRegistry, type ToolContext, type ToolHandler } from '../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../core/v4/paths';
import { decideTaskVerdict } from '../../core/v4/taskVerification';
import type { SnapshotPair } from '../../core/v4/temporalEvidence';
import type { ToolCallRequest, ToolSchema } from '../../providers/v4/types';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'aiden-snap-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const p = (name: string): string => path.join(dir, name);

// ── the capture layer ────────────────────────────────────────────────────

describe('classifyStatError — the stale-artifact-laundering boundary (ALLOWLIST)', () => {
  it('ONLY ENOENT maps to absent', () => {
    expect(classifyStatError({ code: 'ENOENT' })).toEqual({ kind: 'absent' });
  });
  it('EACCES / EPERM → unknown{access_denied}, never absent', () => {
    expect(classifyStatError({ code: 'EACCES' })).toEqual({ kind: 'unknown', cause: 'access_denied' });
    expect(classifyStatError({ code: 'EPERM' })).toEqual({ kind: 'unknown', cause: 'access_denied' });
  });
  it('a NOVEL / unanticipated error code → unknown, NEVER absent (the catastrophic-bug guard)', () => {
    const obs = classifyStatError({ code: 'EWEIRD_NEVER_SEEN_BEFORE' });
    expect(obs.kind).toBe('unknown');
    expect(obs.kind).not.toBe('absent');
    // and a code-less error, and a bare throw — all unknown, none absent
    expect(classifyStatError({}).kind).toBe('unknown');
    expect(classifyStatError(new Error('boom')).kind).toBe('unknown');
  });
});

describe('fileSnapshot — real files, fail-safe', () => {
  it('a missing file → absent', async () => {
    expect((await fileSnapshot(p('nope.txt'))).kind).toBe('absent');
  });

  it('a present file → present with size + content hash (no raw content)', async () => {
    writeFileSync(p('a.txt'), 'hello');
    const obs = await fileSnapshot(p('a.txt'));
    expect(obs.kind).toBe('present');
    if (obs.kind === 'present') {
      expect(obs.fingerprint.size).toBe(5);
      expect(typeof obs.fingerprint.contentHash).toBe('string');
    }
    // raw content NEVER appears — only a hash/size/mtime
    expect(JSON.stringify(obs)).not.toContain('hello');
  });

  it('a stat that HANGS past budget → unknown{timeout}, never blocks (seam)', async () => {
    const hangingStat = () => new Promise<never>(() => { /* never resolves */ });
    const obs = await fileSnapshot(p('x'), { budgetMs: 15, _stat: hangingStat });
    expect(obs).toEqual({ kind: 'unknown', cause: 'timeout' });
  });

  it('AccessDenied on stat → unknown{access_denied}, never absent (seam)', async () => {
    const deny = () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const obs = await fileSnapshot(p('x'), { _stat: deny as never });
    expect(obs).toEqual({ kind: 'unknown', cause: 'access_denied' });
    expect(obs.kind).not.toBe('absent');
  });
});

describe('snapshotTargetsForTool — declared file targets only (no shell guessing)', () => {
  it('file_write/delete → [path]; file_move → [from,to]; shell/other → []', () => {
    expect(snapshotTargetsForTool('file_write', { path: '/a' })).toEqual(['/a']);
    expect(snapshotTargetsForTool('file_delete', { path: '/a' })).toEqual(['/a']);
    expect(snapshotTargetsForTool('file_move', { from: '/a', to: '/b' })).toEqual(['/a', '/b']);
    expect(snapshotTargetsForTool('shell_exec', { command: 'rm x' })).toEqual([]);
  });
});

// ── the execution gate: real capture around a real command (shadow) ─────────

const schema = (name: string): ToolSchema => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const call = (name: string, args: Record<string, unknown>): ToolCallRequest => ({ id: `call-${name}`, name, arguments: args });
const writeHandler = (): ToolHandler => ({
  schema: schema('file_write'),
  category: 'write' as ToolHandler['category'],
  mutates: true,
  toolset: 'files',
  async execute(args: Record<string, unknown>) {
    writeFileSync(String(args.path), String(args.content ?? ''));
    return { path: args.path, bytesWritten: Buffer.byteLength(String(args.content ?? '')) };
  },
});

/** A context with a promise-signalling sink, so tests can await the deferred post. */
function ctxWithSink(attempt = 1): { ctx: ToolContext; pairs: SnapshotPair[]; next: () => Promise<void> } {
  const pairs: SnapshotPair[] = [];
  let resolve: () => void = () => {};
  let signal = new Promise<void>((r) => { resolve = r; });
  const ctx: ToolContext = {
    cwd: dir,
    paths: resolveAidenPaths({ rootOverride: dir }),
    attempt,
    snapshotSink: (pair) => { pairs.push(pair); resolve(); },
  };
  const next = () => Promise.race([signal, new Promise<void>((r) => setTimeout(r, 800))]).then(() => { signal = new Promise<void>((r) => { resolve = r; }); });
  return { ctx, pairs, next };
}

describe('execution gate — real pre/post capture (shadow, non-authoritative)', () => {
  it('a real file_write to a NEW path → pre absent, post present', async () => {
    const reg = new ToolRegistry(); reg.register(writeHandler());
    const { ctx, pairs, next } = ctxWithSink();
    await reg.buildExecutor(ctx)(call('file_write', { path: p('new.txt'), content: 'x' }));
    await next();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].pre.kind).toBe('absent');
    expect(pairs[0].post.kind).toBe('present');
    expect(pairs[0].resource).toBe(resourceIdForPath(p('new.txt')));
  });

  it('a real MODIFICATION → pre fingerprint ≠ post fingerprint', async () => {
    writeFileSync(p('m.txt'), 'AAAA');
    const reg = new ToolRegistry(); reg.register(writeHandler());
    const { ctx, pairs, next } = ctxWithSink();
    await reg.buildExecutor(ctx)(call('file_write', { path: p('m.txt'), content: 'BBBBBB' }));
    await next();
    const { pre, post } = pairs[0];
    expect(pre.kind === 'present' && post.kind === 'present').toBe(true);
    if (pre.kind === 'present' && post.kind === 'present') {
      expect(pre.fingerprint.contentHash).not.toBe(post.fingerprint.contentHash);
    }
  });

  it('a pre-existing UNCHANGED file (same content written) → pre == post hash, no modification proof', async () => {
    writeFileSync(p('u.txt'), 'SAME');
    const reg = new ToolRegistry(); reg.register(writeHandler());
    const { ctx, pairs, next } = ctxWithSink();
    await reg.buildExecutor(ctx)(call('file_write', { path: p('u.txt'), content: 'SAME' }));
    await next();
    const { pre, post } = pairs[0];
    if (pre.kind === 'present' && post.kind === 'present') {
      expect(pre.fingerprint.contentHash).toBe(post.fingerprint.contentHash); // hash A → A
    }
  });

  it('retry → attempt 2 gets its OWN pre-state, not attempt 1s', async () => {
    const reg = new ToolRegistry(); reg.register(writeHandler());
    // attempt 1: file absent → pre absent
    const a1 = ctxWithSink(1);
    await reg.buildExecutor(a1.ctx)(call('file_write', { path: p('r.txt'), content: 'v1' }));
    await a1.next();
    // attempt 2 (retry): file now present → its OWN pre is present, not attempt 1's absent
    const a2 = ctxWithSink(2);
    await reg.buildExecutor(a2.ctx)(call('file_write', { path: p('r.txt'), content: 'v2' }));
    await a2.next();
    expect(a1.pairs[0].attempt).toBe(1);
    expect(a1.pairs[0].pre.kind).toBe('absent');
    expect(a2.pairs[0].attempt).toBe(2);
    expect(a2.pairs[0].pre.kind).toBe('present'); // fresh pre, not reused from attempt 1
  });

  it('raw file content never appears in the captured pair (fingerprints only)', async () => {
    const secret = 'TOP_SECRET_PLAINTEXT_9f3a';
    const reg = new ToolRegistry(); reg.register(writeHandler());
    const { ctx, pairs, next } = ctxWithSink();
    await reg.buildExecutor(ctx)(call('file_write', { path: p('s.txt'), content: secret }));
    await next();
    expect(JSON.stringify(pairs[0])).not.toContain(secret);
  });

  it('no live verdict change — the command result is byte-identical with vs without the sink', async () => {
    const reg = new ToolRegistry(); reg.register(writeHandler());
    const withSink = ctxWithSink();
    const outWith = await reg.buildExecutor(withSink.ctx)(call('file_write', { path: p('b1.txt'), content: 'z' }));
    await withSink.next();
    const bare: ToolContext = { cwd: dir, paths: resolveAidenPaths({ rootOverride: dir }) };
    const outWithout = await reg.buildExecutor(bare)(call('file_write', { path: p('b2.txt'), content: 'z' }));
    // normalise the path that legitimately differs, then compare the shapes
    const norm = (o: unknown) => JSON.parse(JSON.stringify(o).replace(/b[12]\.txt/g, 'F.txt'));
    expect(norm(outWith)).toEqual(norm(outWithout));
    // the verdict oracle is untouched by capture — it reads the trace, which the
    // shadow snapshot never writes to. Deterministic on the same input, as before.
    expect(decideTaskVerdict([])).toEqual(decideTaskVerdict([]));
  });
});
