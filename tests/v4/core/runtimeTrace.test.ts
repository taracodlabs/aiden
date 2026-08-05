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

  it('covers the complete turn, tool, proof, and render phase boundary', () => {
    const root = join(__dirname, '../../..');
    const session = readFileSync(join(root, 'cli/v4/chatSession.ts'), 'utf8');
    const agent = readFileSync(join(root, 'core/v4/aidenAgent.ts'), 'utf8');
    const proof = readFileSync(join(root, 'core/v4/daemon/jobProofAuthority.ts'), 'utf8');
    for (const event of [
      'input.accepted', 'planning.start', 'planning.end', 'first_token',
      'final_stream.complete', 'markdown_settlement.start', 'markdown_settlement.end',
      'final_frame.accepted', 'stable_ready',
    ]) expect(session).toContain(`'${event}'`);
    for (const event of [
      'provider.request', 'provider.complete', 'tool.admitted', 'tool.start',
      'tool.complete', 'verification.start', 'verification.end',
    ]) expect(agent).toContain(`'${event}'`);
    for (const event of [
      'evidence.recorded', 'claim_verification.start', 'claim_verification.end',
      'verdict.computed', 'proof.persisted',
    ]) expect(proof).toContain(`'${event}'`);
  });
});
