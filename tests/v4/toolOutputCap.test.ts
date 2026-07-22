/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 TOC.1 — Layer-1 per-tool output caps + universal recoverability handle.
 *
 * Over cap → head40/tail60 + marker, ANSI stripped, secrets redacted AFTER
 * truncation (boundary-split secret can't leak). Under cap → byte-identical.
 * file_read paginates (offset/limit) + stubs repeated identical reads; truncated
 * results carry {truncated, summary, full_output_ref, suggested_next}.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { capToolOutput, DEFAULT_OUTPUT_CAP } from '../../core/v4/toolOutputCap';
import { fileReadTool, __resetFileReadCache } from '../../tools/v4/files/fileRead';

describe('capToolOutput', () => {
  it('under cap → byte-identical passthrough (no marker/ansi/redact/handle)', () => {
    const raw = 'small output with a token sk-ant-should-stay-since-under-cap';
    const r = capToolOutput(raw, 10_000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(raw);            // byte-identical, secret NOT touched under cap
    expect(r.omittedChars).toBe(0);
  });

  it('over cap → head 40% / tail 60% + omitted marker', () => {
    const raw = 'H'.repeat(400) + 'M'.repeat(200) + 'T'.repeat(600); // 1200 chars
    const r = capToolOutput(raw, 1000); // head 400, tail 600, 200 omitted (the M middle)
    expect(r.truncated).toBe(true);
    expect(r.omittedChars).toBe(200);
    expect(r.text).toMatch(/\[\.\.\. 200 chars omitted \.\.\.\]/);
    expect(r.text.startsWith('H'.repeat(400))).toBe(true);   // head 40% kept
    expect(r.text.endsWith('T'.repeat(600))).toBe(true);     // tail 60% kept
    expect(r.text).not.toContain('M'.repeat(200));           // middle dropped
  });

  it('strips ANSI on the truncated output', () => {
    const raw = '\x1b[31mred\x1b[0m ' + 'x'.repeat(2000);
    const r = capToolOutput(raw, 1000);
    expect(r.text).not.toContain('\x1b[');
    expect(r.text).toContain('red');
  });

  it('★ redacts a full secret in the reassembled TAIL (redact-after-truncation catches it)', () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(24);
    // secret sits wholly in the kept tail, right after the omitted boundary
    const raw = 'x'.repeat(4000) + secret + 'y'.repeat(200);
    const r = capToolOutput(raw, 1000);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain(secret);   // redacted in the final truncated string
    expect(r.text).toContain('[REDACTED]');
  });

  it('★ a secret SPLIT across the truncation boundary cannot leak the full key', () => {
    const secret = 'sk-' + 'ant-' + 'a'.repeat(24);
    // full secret straddles head-end/omitted-start → its tail is omitted
    const raw = 'x'.repeat(390) + secret + 'y'.repeat(2000);
    const r = capToolOutput(raw, 1000);
    expect(r.text).not.toContain(secret);          // the whole key never survives
    expect(r.text).not.toContain('a'.repeat(24));  // the secret body was omitted
  });

  it('a secret fully inside the kept head is redacted', () => {
    const secret = 'sk-' + 'ant-' + 'b'.repeat(24);
    const raw = secret + ' ' + 'z'.repeat(5000);
    const r = capToolOutput(raw, 1000);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain('[REDACTED]');
  });
});

// ── file_read pagination + stub ──────────────────────────────────────────────

describe('file_read pagination + repeated-read stub', () => {
  let dir: string; let fp: string; const ctx = { cwd: process.cwd() } as never;
  beforeEach(async () => {
    __resetFileReadCache();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-fr-'));
    fp = path.join(dir, 'big.txt');
    await fs.writeFile(fp, 'A'.repeat(5000) + 'B'.repeat(5000) + 'C'.repeat(2000)); // 12000 chars
  });

  it('page 1 (default) returns first 5000 + a recoverability handle to page on', async () => {
    const r = await fileReadTool.execute!({ path: fp }, ctx) as any;
    expect(r.content.length).toBe(5000);
    expect(r.content[0]).toBe('A');
    expect(r.truncated).toBe(true);
    expect(r.full_output_ref).toMatchObject({ offset: 5000, limit: 5000 });
    expect(r.suggested_next).toMatch(/offset=5000/);
  });

  it('page 2 (offset from the handle) returns the NEXT section', async () => {
    const r = await fileReadTool.execute!({ path: fp, offset: 5000, limit: 5000 }, ctx) as any;
    expect(r.content[0]).toBe('B');           // the next section
    expect(r.offset).toBe(5000);
    expect(r.full_output_ref).toMatchObject({ offset: 10000 });
  });

  it('final page → truncated false, no handle', async () => {
    const r = await fileReadTool.execute!({ path: fp, offset: 10000, limit: 5000 }, ctx) as any;
    expect(r.content).toBe('C'.repeat(2000));
    expect(r.truncated).toBe(false);
    expect(r.full_output_ref).toBeUndefined();
  });

  it('★ repeated identical read → lightweight stub (content omitted)', async () => {
    const first = await fileReadTool.execute!({ path: fp, offset: 5000, limit: 5000 }, ctx) as any;
    expect(first.content).toBeDefined();
    const second = await fileReadTool.execute!({ path: fp, offset: 5000, limit: 5000 }, ctx) as any;
    expect(second.stub).toBe(true);
    expect(second.content).toBeUndefined();   // not re-sent
    expect(second.note).toMatch(/identical/i);
  });

  it('a changed file (different content) re-sends, not stubbed', async () => {
    await fileReadTool.execute!({ path: fp, offset: 0, limit: 5000 }, ctx); // seed
    await fs.writeFile(fp, 'Z'.repeat(12000)); // change content
    const r = await fileReadTool.execute!({ path: fp, offset: 0, limit: 5000 }, ctx) as any;
    expect(r.stub).toBeUndefined();
    expect(r.content[0]).toBe('Z');
  });

  it('a small file → content + truncated:false (byte-identical behaviour)', async () => {
    const small = path.join(dir, 'small.txt');
    await fs.writeFile(small, 'tiny');
    const r = await fileReadTool.execute!({ path: small }, ctx) as any;
    expect(r.content).toBe('tiny');
    expect(r.truncated).toBe(false);
  });

  it('centrally clamps a caller-selected page limit', async () => {
    const r = await fileReadTool.execute!({ path: fp, limit: 999_999 }, ctx) as any;
    expect(r.content.length).toBe(5000);
    expect(r.full_output_ref).toMatchObject({ offset: 5000, limit: 5000 });
  });

  it('does not suppress an identical read in a different session', async () => {
    const first = await fileReadTool.execute!({ path: fp }, { ...ctx, sessionId: 'session-a' } as never) as any;
    const second = await fileReadTool.execute!({ path: fp }, { ...ctx, sessionId: 'session-b' } as never) as any;
    expect(first.content).toBeDefined();
    expect(second.content).toBeDefined();
    expect(second.stub).toBeUndefined();
  });
});

describe('DEFAULT_OUTPUT_CAP sanity', () => {
  it('is a sensible large default', () => expect(DEFAULT_OUTPUT_CAP).toBeGreaterThanOrEqual(20_000));
});
