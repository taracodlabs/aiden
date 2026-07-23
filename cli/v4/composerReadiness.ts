/** Test-only semantic marker emitted after an interactive composer mounts. */
export const COMPOSER_READY_TOKEN = '__COMPOSER_READY__';

/**
 * Emit a non-printing terminal marker only for PTY tests. OSC framing keeps
 * cursor position and normal production output unchanged.
 */
export function emitComposerReadyForTests(
  write: (value: string) => void = (value) => process.stderr.write(value),
): void {
  if (process.env.AIDEN_TEST_COMPOSER_READY !== '1') return;
  try { write(`\x1b]9;${COMPOSER_READY_TOKEN}\x07`); } catch { /* test seam only */ }
}
