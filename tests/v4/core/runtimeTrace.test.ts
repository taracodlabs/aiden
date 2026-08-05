import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeTrace } from '../../../core/v4/runtimeTrace';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime trace sink', () => {
  it('writes structured records only to the configured file', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-runtime-trace-'));
    roots.push(root);
    const target = join(root, 'trace.jsonl');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runtimeTrace('turn', 'accepted', { turnId: 7 }, {
      AIDEN_RUNTIME_TRACE_FILE: target,
    });

    const record = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ scope: 'turn', event: 'accepted', turnId: 7 });
    expect(record.monoMs).toEqual(expect.any(Number));
    expect(stderr).not.toHaveBeenCalled();
  });

  it('stays silent when no file sink is configured', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runtimeTrace('turn', 'accepted', {}, { AIDEN_P2A_DIAG: '1' });

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
