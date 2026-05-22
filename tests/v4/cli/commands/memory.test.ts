/**
 * tests/v4/cli/commands/memory.test.ts — v4.9.0 Slice 9.
 *
 * Covers list/show/add/remove/edit happy paths + --json variants + invalid
 * args + verifies MemoryGuard verification surface.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMemorySubcommand } from '../../../../cli/v4/commands/memory';

let root: string;
function mkRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-mem-')); }

function capture(): { out: string[]; err: string[]; writeOut: (s:string)=>void; writeErr: (s:string)=>void } {
  const out: string[] = [], err: string[] = [];
  return { out, err, writeOut: (s) => out.push(s), writeErr: (s) => err.push(s) };
}

beforeEach(() => { root = mkRoot(); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

describe('aiden memory CLI — Slice 9', () => {
  it('list (no args) shows empty state', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('list', [], { rootDir: root, ...cap });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toMatch(/memory: 0 \/ 2200/);
    expect(text).toMatch(/user:   0 \/ 1375/);
  });

  it('list --json emits machine-parseable shape', async () => {
    const cap = capture();
    await runMemorySubcommand('list', ['--json'], { rootDir: root, ...cap });
    const parsed = JSON.parse(cap.out.join('')) as { memory: { chars: number; limit: number }; user: { chars: number; limit: number } };
    expect(parsed.memory.limit).toBe(2200);
    expect(parsed.user.limit).toBe(1375);
    expect(parsed.memory.chars).toBe(0);
  });

  it('add appends an entry + list reflects it', async () => {
    const cap1 = capture();
    const code = await runMemorySubcommand('add', ['user', 'prefers concise responses'], { rootDir: root, ...cap1 });
    expect(code).toBe(0);
    expect(cap1.out.join('')).toMatch(/added to user/);
    const cap2 = capture();
    await runMemorySubcommand('list', [], { rootDir: root, ...cap2 });
    expect(cap2.out.join('')).toContain('prefers concise responses');
  });

  it('add --json returns mem_id matching prefix', async () => {
    const cap = capture();
    await runMemorySubcommand('add', ['memory', 'built by Taracod Labs', '--json'], { rootDir: root, ...cap });
    const parsed = JSON.parse(cap.out.join('')) as { ok: boolean; mem_id: string; chars: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.mem_id).toMatch(/^mem_[0-9a-f]{32}$/);
    expect(parsed.chars).toBeGreaterThan(0);
  });

  it('show prints with line numbers', async () => {
    await runMemorySubcommand('add', ['memory', 'first entry'], { rootDir: root, ...capture() });
    const cap = capture();
    await runMemorySubcommand('show', ['memory'], { rootDir: root, ...cap });
    expect(cap.out.join('')).toMatch(/   1 \| first entry/);
  });

  it('remove --match deletes the unique entry', async () => {
    await runMemorySubcommand('add', ['user', 'likes Python'], { rootDir: root, ...capture() });
    await runMemorySubcommand('add', ['user', 'lives in India'], { rootDir: root, ...capture() });
    const cap = capture();
    const code = await runMemorySubcommand('remove', ['user', '--match', 'Python'], { rootDir: root, ...cap });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/removed entry containing "Python"/);
    const list = capture();
    await runMemorySubcommand('list', [], { rootDir: root, ...list });
    expect(list.out.join('')).not.toContain('Python');
    expect(list.out.join('')).toContain('India');
  });

  it('invalid file arg rejected with exit 2', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('show', ['banana'], { rootDir: root, ...cap });
    expect(code).toBe(2);
    expect(cap.err.join('')).toMatch(/pass `memory` or `user`/);
  });

  it('missing file arg on add rejected', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('add', [], { rootDir: root, ...cap });
    expect(code).toBe(2);
  });

  it('unknown action exits 2 with help', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('frobnicate', [], { rootDir: root, ...cap });
    expect(code).toBe(2);
    expect(cap.err.join('')).toMatch(/Unknown memory action/);
  });

  it('edit prints path (file gets created if absent)', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('edit', ['memory'], { rootDir: root, ...cap });
    expect(code).toBe(0);
    expect(cap.out.join('').trim()).toMatch(/memories[\\/]MEMORY\.md$/);
    expect(fs.existsSync(path.join(root, 'memories', 'MEMORY.md'))).toBe(true);
  });

  it('help action prints usage', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('help', [], { rootDir: root, ...cap });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/Usage: aiden memory/);
    expect(cap.out.join('')).toMatch(/backup/);
  });
});
