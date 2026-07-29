/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import { Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { TerminalScreen } from '../harness/terminalScreen';

class MeasuredScreenStream extends Writable {
  isTTY = true;
  columns = 100;
  rows = 30;
  writes = 0;
  bytes = 0;
  readonly screen = new TerminalScreen(this.columns, this.rows);

  constructor() {
    super({
      write: (chunk, _encoding, done) => {
        const text = chunk.toString();
        this.writes += 1;
        this.bytes += Buffer.byteLength(text);
        this.screen.write(text);
        done();
      },
    });
  }
}

function harness() {
  const stream = new MeasuredScreenStream();
  const display = new Display({
    stdout: stream as unknown as NodeJS.WriteStream,
    skin: new SkinEngine({ forceMono: true }),
  });
  display.setStatusFooter('◆ provider · model │ ◉ context 2k/32k │ ⧖ 4s');
  display.setIdleComposer('', 'Type your message · /help');
  return { display, stream };
}

describe('operator screen performance boundaries', () => {
  it('virtualizes ten thousand transcript rows without replaying them on a status frame', () => {
    const { display, stream } = harness();
    const transcript = Array.from({ length: 10_000 }, (_, index) => `row ${index}`).join('\n') + '\n';
    display.write(transcript);
    const writesBefore = stream.writes;
    const bytesBefore = stream.bytes;
    const started = performance.now();

    display.setStatusFooter('◆ provider · model │ ◉ context 3k/32k │ ⧖ 5s');

    const elapsedMs = performance.now() - started;
    expect(stream.writes - writesBefore).toBe(1);
    expect(stream.bytes - bytesBefore).toBeLessThan(20_000);
    expect(Number.isFinite(elapsedMs)).toBe(true);
    expect(stream.screen.lines().at(-1)).toContain('context 3k/32k');
  });

  it('keeps a one-megabyte tool payload out of the live terminal frame', () => {
    const { display, stream } = harness();
    const bytesBefore = stream.bytes;
    const row = display.toolRow('file_read', {
      path: 'C:\\workspace\\result.txt',
      content: 'x'.repeat(1_000_000),
    }, undefined, { activityId: 'large-output' });

    expect(stream.bytes - bytesBefore).toBeLessThan(20_000);
    expect(stream.screen.snapshot()).toContain('result.txt');
    expect(stream.screen.snapshot()).not.toContain('x'.repeat(1_000));
    row.ok(1);
  });

  it('bounds fifty concurrent activities to the available live viewport', () => {
    const { display, stream } = harness();
    const rows = Array.from({ length: 50 }, (_, index) => display.toolRow(
      'file_read',
      { path: `C:\\workspace\\file-${index}.txt` },
      undefined,
      { activityId: `activity-${index}` },
    ));

    expect(stream.screen.snapshot()).toContain('more active');
    expect(stream.screen.lines().filter((line) => line.includes('file-')).length).toBeLessThanOrEqual(25);
    for (const row of rows) row.ok(1);
  });
});
