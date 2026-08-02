/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createParallelWorkerFixture, type ParallelWorkerFixture } from './workerParallelFixture';

function runContender(payload: Record<string, unknown>, cwd: string): Promise<string> {
  const script = [
    "const fs=require('node:fs');",
    "const Database=require('better-sqlite3');",
    "const {createJobEngine}=require('./core/v4/daemon/jobEngine.ts');",
    'const input=JSON.parse(process.env.WORKER_SLOT_INPUT);',
    'while(!fs.existsSync(input.gate)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}',
    'const db=new Database(input.databasePath);db.pragma(\'foreign_keys = ON\');db.pragma(\'busy_timeout = 5000\');',
    'try{createJobEngine({db}).resources.reserveWorkerProviderConcurrency(input.command);process.stdout.write(\'reserved\');}',
    'catch(error){process.stdout.write(`rejected:${error instanceof Error?error.message:String(error)}`);}',
    'finally{db.close();}',
  ].join('');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd,
      env: { ...process.env, WORKER_SLOT_INPUT: JSON.stringify(payload) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
  });
}

describe('parallel Worker multi-process provider admission', () => {
  let fixture: ParallelWorkerFixture | undefined;
  let root: string | undefined;
  afterEach(async () => {
    await fixture?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('cannot exceed the durable provider limit across two Node processes', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'aiden-worker-multiprocess-'));
    const databasePath = path.join(root, 'jobs.db');
    const gate = path.join(root, 'start');
    fixture = await createParallelWorkerFixture(databasePath);
    const groupId = 'worker_group_multiprocess';
    fixture.engine.worker.createWorkerGroup({
      parentJobId: fixture.authority.jobId,
      parentAttemptId: fixture.authority.attemptId,
      parentGeneration: fixture.authority.generation,
      parentFenceToken: fixture.authority.fenceToken,
      producer: 'test',
      idempotencyKey: 'multiprocess-group',
      groupId,
      schemaVersion: 1,
      policy: 'allow_partial',
      members: [
        { memberId: 'worker_member_process_one', ordinal: 1, requestedProviderId: 'custom_openai' },
        { memberId: 'worker_member_process_two', ordinal: 2, requestedProviderId: 'custom_openai' },
      ],
    });
    const base = {
      groupId,
      parentJobId: fixture.authority.jobId,
      parentAttemptId: fixture.authority.attemptId,
      parentGeneration: fixture.authority.generation,
      parentFenceToken: fixture.authority.fenceToken,
      providerId: 'custom_openai',
      limit: 1,
    };
    const cwd = path.resolve(__dirname, '../../..');
    const contenders = [1, 2].map((ordinal) => runContender({
      databasePath,
      gate,
      command: {
        ...base,
        providerSlotId: `worker_provider_slot_process_${ordinal}`,
        idempotencyKey: `provider-slot-process-${ordinal}`,
        memberId: `worker_member_process_${ordinal === 1 ? 'one' : 'two'}`,
      },
    }, cwd));
    await writeFile(gate, 'go');
    const results = await Promise.all(contenders);
    expect(results.filter((value) => value === 'reserved')).toHaveLength(1);
    expect(results.filter((value) => /limit exceeded/iu.test(value))).toHaveLength(1);
    expect(fixture.engine.resources.listWorkerProviderConcurrencyForGroup(groupId)).toHaveLength(1);
  });
});
