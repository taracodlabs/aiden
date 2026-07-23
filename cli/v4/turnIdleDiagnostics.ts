import { appendFileSync } from 'node:fs';

let composerGeneration = 0;

export function nextComposerGeneration(): number {
  composerGeneration += 1;
  return composerGeneration;
}

export function turnIdleDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.AIDEN_TEST_TURN_IDLE_DIAG !== '1') return;
  try {
    const stdin = process.stdin;
    const monoMs = Number(process.hrtime.bigint() / 1_000_000n);
    const line = `[turn-idle] ${JSON.stringify({
      monoMs,
      event,
      stdin: {
        isRaw: stdin.isRaw === true,
        isPaused: stdin.isPaused(),
        readableFlowing: stdin.readableFlowing,
        dataListeners: stdin.listenerCount('data'),
        keypressListeners: stdin.listenerCount('keypress'),
        readableListeners: stdin.listenerCount('readable'),
      },
      sigintListeners: process.listenerCount('SIGINT'),
      ...data,
    })}\n`;
    const diagnosticFile = process.env.AIDEN_TEST_TURN_IDLE_DIAG_FILE;
    if (diagnosticFile) {
      appendFileSync(diagnosticFile, line, 'utf8');
    } else {
      process.stderr.write(line);
    }
  } catch { /* test diagnostics must not affect the terminal lifecycle */ }
}
