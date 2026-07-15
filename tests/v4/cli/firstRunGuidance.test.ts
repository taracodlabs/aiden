import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { renderFirstRunHint } from '../../../cli/v4/repl/firstRunHint';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

function output(columns = 100): { out: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, done) { chunks.push(String(chunk)); done(); } }) as Writable & { isTTY?: boolean; columns?: number };
  stream.isTTY = true;
  stream.columns = columns;
  return { out: stream as unknown as NodeJS.WriteStream, text: () => chunks.join('') };
}

describe('first-run guidance', () => {
  it('shows one practical starter task once without a tutorial flood', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-first-guidance-'));
    roots.push(root);
    const sink = output();
    const paths = { root } as any;

    expect(await renderFirstRunHint({ paths, out: sink.out })).toBe(true);
    expect(sink.text()).toContain('Read this folder and explain what this project does.');
    expect(sink.text()).not.toContain('/walkthrough');
    expect(await renderFirstRunHint({ paths, out: sink.out })).toBe(false);
    expect(sink.text().match(/Try asking:/g)).toHaveLength(1);
  });

  it('keeps the narrow first-run prompt bounded and capability-neutral', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-first-guidance-'));
    roots.push(root);
    const sink = output(44);

    await renderFirstRunHint({ paths: { root } as any, out: sink.out });
    expect(sink.text()).toContain('Explain this folder');
    expect(sink.text()).not.toMatch(/download|install|authorize/i);
  });
});
