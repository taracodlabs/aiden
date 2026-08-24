/** Writable surface used to settle queued process output before an explicit exit. */
export interface FlushableWritable {
  write(chunk: string, callback?: (error?: Error | null) => void): unknown;
}

/**
 * Wait until every supplied stream has processed all writes queued before the
 * empty marker. A stream that is already unavailable must not pin shutdown.
 */
export async function flushWritableStreams(
  streams: readonly FlushableWritable[],
): Promise<void> {
  await Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      stream.write('', finish);
    } catch {
      finish();
    }
  })));
}

/** Settle stdout and stderr before a non-interactive command force-exits. */
export async function flushStandardStreams(): Promise<void> {
  await flushWritableStreams([
    process.stdout as unknown as FlushableWritable,
    process.stderr as unknown as FlushableWritable,
  ]);
}
