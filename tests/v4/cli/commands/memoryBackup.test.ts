/**
 * tests/v4/cli/commands/memoryBackup.test.ts — v4.9.0 Slice 9.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMemorySubcommand } from '../../../../cli/v4/commands/memory';

let root: string;
function capture() {
  const out: string[] = [], err: string[] = [];
  return { out, err, writeOut: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) };
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-mem-bk-')); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

describe('aiden memory backup/restore/diff — Slice 9', () => {
  it('backup creates timestamped dir with both files + manifest', async () => {
    await runMemorySubcommand('add', ['user',   'pref A'], { rootDir: root, ...capture() });
    await runMemorySubcommand('add', ['memory', 'env B'],  { rootDir: root, ...capture() });
    const cap = capture();
    const code = await runMemorySubcommand('backup', [], { rootDir: root, ...cap });
    expect(code).toBe(0);
    const out = cap.out.join('');
    const m = /backup: (.+)/.exec(out);
    expect(m).not.toBeNull();
    const dir = m![1].trim();
    expect(fs.existsSync(path.join(dir, 'memory.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'user.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { files: Array<{ name: string; bytes: number; sha256: string }>; spanId: string };
    // v4.9.0 Slice 11 — backup now includes every reachable namespace.
    // From the DevOS repo (project root detected), that's 3 files
    // (memory + user + project); outside a project root, 2 files.
    expect(manifest.files.length).toBeGreaterThanOrEqual(2);
    expect(manifest.spanId).toMatch(/^mem_[0-9a-f]{32}$/);
  });

  it('backup --json emits manifest in JSON', async () => {
    await runMemorySubcommand('add', ['user', 'X'], { rootDir: root, ...capture() });
    const cap = capture();
    await runMemorySubcommand('backup', ['--json'], { rootDir: root, ...cap });
    const parsed = JSON.parse(cap.out.join('')) as { ok: boolean; dir: string; manifest: { timestamp: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.manifest.timestamp).toMatch(/^\d{8}-\d{6}$/);
  });

  it('restore round-trips: backup → mutate → restore → original state', async () => {
    await runMemorySubcommand('add', ['user', 'original entry'], { rootDir: root, ...capture() });
    const backupCap = capture();
    await runMemorySubcommand('backup', [], { rootDir: root, ...backupCap });
    const stamp = /backup: .*memory-backups[\\/](\d{8}-\d{6})/.exec(backupCap.out.join(''))![1];
    // Mutate.
    await runMemorySubcommand('remove', ['user', '--match', 'original'], { rootDir: root, ...capture() });
    const afterRemove = capture();
    await runMemorySubcommand('list', [], { rootDir: root, ...afterRemove });
    expect(afterRemove.out.join('')).not.toContain('original entry');
    // Restore.
    const restoreCap = capture();
    const code = await runMemorySubcommand('restore', [stamp], { rootDir: root, ...restoreCap });
    expect(code).toBe(0);
    const afterRestore = capture();
    await runMemorySubcommand('list', [], { rootDir: root, ...afterRestore });
    expect(afterRestore.out.join('')).toContain('original entry');
  });

  it('restore with missing timestamp errors', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('restore', ['20990101-000000'], { rootDir: root, ...cap });
    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/backup not found/);
  });

  it('diff shows added + removed entries vs latest backup', async () => {
    await runMemorySubcommand('add', ['user', 'keep me'],   { rootDir: root, ...capture() });
    await runMemorySubcommand('add', ['user', 'remove me'], { rootDir: root, ...capture() });
    await runMemorySubcommand('backup', [], { rootDir: root, ...capture() });
    await runMemorySubcommand('remove', ['user', '--match', 'remove'], { rootDir: root, ...capture() });
    await runMemorySubcommand('add',    ['user', 'add me'],            { rootDir: root, ...capture() });
    const cap = capture();
    await runMemorySubcommand('diff', [], { rootDir: root, ...cap });
    const out = cap.out.join('');
    expect(out).toMatch(/\+ add me/);
    expect(out).toMatch(/- remove me/);
  });

  it('diff with no backups errors gracefully', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('diff', [], { rootDir: root, ...cap });
    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/no backups/);
  });
});
