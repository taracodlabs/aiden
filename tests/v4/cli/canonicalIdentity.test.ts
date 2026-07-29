/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import { AIDEN_LOGO_LINES, AIDEN_LOGO_TEXT } from '../../../core/v4/ui/identity';
import { renderBanner } from '../../../core/v4/ui/banner';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

describe('canonical Aiden identity', () => {
  it('keeps the established six-line wordmark byte-for-byte stable', () => {
    expect(AIDEN_LOGO_LINES).toHaveLength(6);
    expect(createHash('sha256').update(AIDEN_LOGO_TEXT).digest('hex')).toBe(
      'b8fdf0e24b1010acfc61ebf344798e8fe82cc4a76dcf5c2d7a8ff55b6144ddc4',
    );
  });

  it('renders the display banner from the canonical source without extra logo rows', () => {
    const out = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as NodeJS.WriteStream;
    const display = new Display({ stdout: out, skin: new SkinEngine({ forceMono: true }) });
    const rows = display.banner().split('\n').filter((line) => line.trim().length > 0)
      .map((line) => line.slice(2));
    expect(rows).toEqual([...AIDEN_LOGO_LINES]);
  });

  it('defines the block wordmark in one production source file', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
      }
    };
    visit(path.join(repoRoot, 'cli', 'v4'));
    visit(path.join(repoRoot, 'core', 'v4'));
    const definitions = files.filter((file) => readFileSync(file, 'utf8').includes(AIDEN_LOGO_LINES[0]));
    expect(definitions.map((file) => path.relative(repoRoot, file))).toEqual([
      path.join('core', 'v4', 'ui', 'identity.ts'),
    ]);
  });

  it('does not force color when the terminal requests monochrome output', () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const rendered = renderBanner({ version: '4.16.1', width: 80 });
      expect(rendered).not.toContain('\x1b[');
      for (const line of AIDEN_LOGO_LINES) expect(rendered).toContain(line);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
