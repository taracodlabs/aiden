import path from 'node:path';
import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';

describe('masked onboarding input through a real terminal', () => {
  it('returns the complete typed value when Enter submits', async () => {
    const modulePath = path.resolve('dist/cli/v4/onboarding/backNavInput.js');
    const credential = ['fixture', 'masked', 'value'].join('-');
    const childCode = [
      `const { backNavInput } = require(${JSON.stringify(modulePath)});`,
      `backNavInput({ message: 'API key', mask: true }).then((value) => {`,
      `  process.stdout.write('RESULT_LENGTH=' + String(typeof value === 'string' ? value.length : -1) + '\\n');`,
      `  process.exit(0);`,
      `}, () => process.exit(1));`,
    ].join('\n');

    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const terminal = pty.spawn(process.execPath, ['-e', childCode], {
        cwd: process.cwd(),
        cols: 100,
        rows: 30,
        env: { ...process.env, NO_COLOR: '1' } as Record<string, string>,
      });
      let output = '';
      let submitted = false;
      const timeout = setTimeout(() => {
        try { terminal.kill(); } catch { /* best effort */ }
        reject(new Error('masked input fixture did not settle'));
      }, 10_000);
      terminal.onData((chunk) => {
        output += chunk;
        if (!submitted && output.includes('API key')) {
          submitted = true;
          terminal.write(`${credential}\r`);
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve({ code: exitCode, output });
      });
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain(`RESULT_LENGTH=${credential.length}`);
    expect(result.output).not.toContain(credential);
  });
});
