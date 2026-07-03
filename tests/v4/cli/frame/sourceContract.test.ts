/**
 * v4.11 Slice 1 — source-contract guard for cli/v4/frame/.
 *
 * Locked invariant: terminalDriver.ts is the SOLE writer to
 * process.stdout in the frame module. Every other file (composer,
 * status, runtime, state, index) must NEVER reach for raw stdout,
 * cursor-positioning helpers, or ANSI escape sequences directly.
 *
 * This test greps the source files in the frame module and fails
 * loud if a forbidden token appears anywhere except terminalDriver.
 * It catches the "someone added a console.log / process.stdout.write
 * for quick debugging" class of regression at lint time, before it
 * survives into a commit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FRAME_DIR = join(__dirname, '..', '..', '..', '..', 'cli', 'v4', 'frame');
const ALLOWED   = new Set(['terminalDriver.ts']);

/**
 * Forbidden patterns. Anything that bypasses the frame's single-
 * writer contract.
 *
 * - `process.stdout.write` — the raw escape hatch (driver-only).
 * - `process.stdout.cursorTo` / `clearLine` — Node-native stream
 *   helpers; equivalent to writing ANSI escape sequences manually.
 * - `\x1b[` — embedded CSI escape sequences. Cursor positioning,
 *   colour codes, etc. should come from Ink's declarative layout.
 * - `console.log`/`error`/`warn` — patches stdout indirectly; we
 *   handed `patchConsole: false` to Ink so these would leak through
 *   the writer-singleton guard otherwise.
 */
const FORBIDDEN_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: 'process.stdout.write',     rx: /\bprocess\.stdout\.write\b/ },
  { name: 'process.stdout.cursorTo',  rx: /\bprocess\.stdout\.cursorTo\b/ },
  { name: 'process.stdout.clearLine', rx: /\bprocess\.stdout\.clearLine\b/ },
  // eslint-disable-next-line no-control-regex
  { name: 'embedded CSI escape',      rx: /\x1b\[/ },
  { name: 'console.log/error/warn',   rx: /\bconsole\.(log|error|warn|info)\b/ },
];

function listFrameSources(): string[] {
  return readdirSync(FRAME_DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !ALLOWED.has(f));
}

describe('frame source-contract guard', () => {
  it('frame directory exists with the expected source set', () => {
    const files = readdirSync(FRAME_DIR).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    expect(files.sort()).toEqual([
      'composer.ts',
      // v4.12.1 Pillar 4 Slice 1 — pure glass-dashboard models (no stdout/ANSI;
      // the frame renderer paints them; the driver-only contract still holds).
      'glassHelpers.ts',
      'index.ts',
      'interruptControls.ts',
      'runtime.ts',
      'state.ts',
      'status.ts',
      'statusBar.ts',
      'terminalDriver.ts',
      'toolRowModel.ts',
    ]);
  });

  for (const file of listFrameSources()) {
    it(`${file} writes nothing directly to stdout (driver-only contract)`, () => {
      const text = readFileSync(join(FRAME_DIR, file), 'utf8');
      // Strip line comments so doc-string explanations like
      // "...write to process.stdout..." don't trip the guard.
      const stripped = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const { name, rx } of FORBIDDEN_PATTERNS) {
        const hit = rx.exec(stripped);
        if (hit) {
          throw new Error(
            `[frame source-contract] ${file} contains forbidden token "${name}" ` +
            `(matched "${hit[0]}"). Only terminalDriver.ts is allowed to touch ` +
            `stdout / write ANSI sequences. Route through the driver instead.`,
          );
        }
      }
    });
  }

  it('terminalDriver.ts IS allowed to reference forbidden tokens (sanity)', () => {
    const text = readFileSync(join(FRAME_DIR, 'terminalDriver.ts'), 'utf8');
    // We expect terminalDriver to mention process.stdout.write — it
    // owns the patch. If it stops mentioning it, the contract is
    // probably broken.
    expect(text).toMatch(/process\.stdout\.write/);
  });
});
