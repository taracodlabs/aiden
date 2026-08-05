import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('interactive output ownership', () => {
  it('routes provider progress through the active display projection', () => {
    const text = source('cli/v4/chatSession.ts');
    const start = text.indexOf('onProgress: streamingEnabled');
    const end = text.indexOf('const result = await runAgent()', start);
    const block = text.slice(start, end);

    expect(block).toContain('progressProjection(');
    expect(block).toContain('createProgressBar(');
  });

  it('projects interactive crash notices instead of writing to stderr', () => {
    const text = source('cli/v4/aidenCLI.ts');
    const start = text.indexOf('installReplCrashHandlers({');
    const end = text.indexOf('gateway.attachLogger', start);
    const block = text.slice(start, end);

    expect(block).toContain('display.writeError(');
    expect(block).not.toContain('process.stderr.write');
  });

  it('keeps optional runtime diagnostics off interactive stdout and stderr', () => {
    const files = [
      'cli/v4/activityRegistry.ts',
      'cli/v4/callbacks.ts',
      'cli/v4/chatSession.ts',
      'cli/v4/inputAuthority.ts',
      'core/v4/aidenAgent.ts',
      'providers/v4/responseStreamAdapter.ts',
      'tools/v4/clarify/clarifyTool.ts',
    ];
    for (const file of files) {
      const text = source(file);
      const diagnosticWrites = text.match(
        /AIDEN_P2A_DIAG[\s\S]{0,900}?process\.(?:stdout|stderr)\.write/g,
      ) ?? [];
      expect(diagnosticWrites, file).toEqual([]);
    }
  });
});
