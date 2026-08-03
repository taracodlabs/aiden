import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { showDisclaimer } from '../../../cli/v4/onboarding/disclaimer';
import { AIDEN_LOGO_LINES } from '../../../core/v4/ui/identity';

function startupStreams(columns: number): {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  chunks: string[];
} {
  const chunks: string[] = [];
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(input, { isTTY: true });
  Object.assign(output, { isTTY: true, columns });
  return { input, output, chunks };
}

describe('first-run startup identity', () => {
  it('renders the canonical identity before setup copy', async () => {
    const { input, output, chunks } = startupStreams(80);
    const pending = showDisclaimer({ in: input, out: output, version: '4.18.0' });
    (input as unknown as PassThrough).write('\n');
    const result = await pending;
    const rendered = chunks.join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

    expect(result.ok).toBe(true);
    for (const line of AIDEN_LOGO_LINES) expect(rendered).toContain(line);
    expect(rendered).not.toContain('A I D E N');
    expect(rendered.indexOf(AIDEN_LOGO_LINES.at(-1)!)).toBeLessThan(rendered.indexOf('Aiden can:'));
  });

  it('waits at a narrow width before rendering the first-run identity', async () => {
    const { input, output, chunks } = startupStreams(40);
    let settled = false;
    const pending = showDisclaimer({ in: input, out: output, version: '4.18.0' })
      .then((value) => { settled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    const blocked = chunks.join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    expect(settled).toBe(false);
    expect(blocked).toContain('Aiden requires at least 41 columns');
    expect(blocked).not.toContain('A I D E N');
    expect(blocked).not.toContain(AIDEN_LOGO_LINES[0]);

    (output as unknown as { columns: number }).columns = 44;
    output.emit('resize');
    (input as unknown as PassThrough).write('\n');
    await pending;
    const rendered = chunks.join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    for (const line of AIDEN_LOGO_LINES) expect(rendered.split(line)).toHaveLength(2);
  });
});
