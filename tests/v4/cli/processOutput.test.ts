import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { flushWritableStreams } from '../../../cli/v4/processOutput';

type WriteCallback = (error?: Error | null) => void;

class DeferredWritable {
  readonly callbacks: WriteCallback[] = [];

  write(_chunk: string, callback?: WriteCallback): boolean {
    if (callback) this.callbacks.push(callback);
    return false;
  }
}

describe('process output settlement', () => {
  it('waits for every queued writable stream before resolving', async () => {
    const stdout = new DeferredWritable();
    const stderr = new DeferredWritable();
    let resolved = false;

    const pending = flushWritableStreams([stdout, stderr]).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(stdout.callbacks).toHaveLength(1);
    expect(stderr.callbacks).toHaveLength(1);

    stdout.callbacks[0]();
    await Promise.resolve();
    expect(resolved).toBe(false);

    stderr.callbacks[0]();
    await pending;
    expect(resolved).toBe(true);
  });

  it('does not turn an unavailable stream into a shutdown hang', async () => {
    const unavailable = {
      write(): boolean {
        throw new Error('stream unavailable');
      },
    };

    await expect(flushWritableStreams([unavailable])).resolves.toBeUndefined();
  });

  it('settles standard output before the doctor command exits', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../cli/v4/aidenCLI.ts'),
      'utf8',
    );
    const doctorBlock = source.match(
      /\.command\('doctor'\)[\s\S]*?\.command\('auth <action> \[provider\]'\)/u,
    )?.[0];

    expect(doctorBlock).toBeDefined();
    expect(doctorBlock).toContain('await flushStandardStreams();');
    expect(doctorBlock?.indexOf('await flushStandardStreams();')).toBeLessThan(
      doctorBlock?.indexOf('process.exit();') ?? -1,
    );
  });
});
