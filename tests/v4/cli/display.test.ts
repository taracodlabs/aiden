import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

// Strip ANSI escape sequences so assertions stay terminal-agnostic.
function stripAnsi(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[A-Za-z]/g,
    '',
  );
}

describe('SkinEngine', () => {
  let engine: SkinEngine;

  beforeEach(() => {
    engine = new SkinEngine({ forceMono: false });
  });

  it('exposes the bundled default skin', () => {
    expect(engine.getActive().name).toBe('default');
    expect(engine.listSkins()).toEqual(
      expect.arrayContaining(['default', 'light', 'monochrome']),
    );
  });

  it('applyColors wraps text with ANSI for the default skin', () => {
    const out = engine.applyColors('hi', 'brand');
    expect(out).not.toBe('hi'); // ANSI codes added
    expect(stripAnsi(out)).toBe('hi');
  });

  it('switching to monochrome strips colour', () => {
    engine.setActive('monochrome');
    expect(engine.applyColors('hi', 'brand')).toBe('hi');
  });

  it('switching skins changes colour bytes', () => {
    const a = engine.applyColors('x', 'brand');
    engine.setActive('light');
    const b = engine.applyColors('x', 'brand');
    expect(a).not.toEqual(b);
  });

  it('forceMono disables colour entirely', () => {
    const mono = new SkinEngine({ forceMono: true });
    expect(mono.applyColors('hi', 'brand')).toBe('hi');
  });

  it('unknown skin name keeps the active skin and reports via onError', () => {
    const errors: string[] = [];
    const e = new SkinEngine({ onError: (m) => errors.push(m) });
    e.setActive('does-not-exist');
    expect(e.getActive().name).toBe('default');
    expect(errors[0]).toMatch(/unknown skin/i);
  });

  it('loadSkin reads custom yaml from skinsDir', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skin-'));
    await fs.writeFile(
      path.join(tmp, 'neon.yaml'),
      'description: neon\ncolors:\n  brand: [255, 0, 255]\n',
    );
    const e = new SkinEngine({ skinsDir: tmp });
    const s = await e.loadSkin('neon');
    expect(s.name).toBe('neon');
    expect(s.colors.brand).toEqual([255, 0, 255]);
  });

  it('loadSkin missing file falls back to default + onError', async () => {
    const errors: string[] = [];
    const e = new SkinEngine({
      skinsDir: path.join(os.tmpdir(), 'aiden-no-such-dir'),
      onError: (m) => errors.push(m),
    });
    const s = await e.loadSkin('ghost');
    expect(s.name).toBe('default');
    expect(errors[0]).toMatch(/failed to load/i);
  });
});

describe('Display', () => {
  let display: Display;
  let skin: SkinEngine;

  beforeEach(() => {
    skin = new SkinEngine({ forceMono: true }); // deterministic output
    display = new Display({ skin });
  });

  it('banner contains the Aiden brand and version line', () => {
    const b = stripAnsi(display.banner('4.2.1'));
    expect(b).toMatch(/Aiden v4\.2\.1/);
    expect(b).toMatch(/\/help/);
  });

  it('userTurn formats with a "you" marker', () => {
    const out = stripAnsi(display.userTurn('hello'));
    expect(out).toMatch(/you/);
    expect(out).toContain('hello');
  });

  it('agentTurn renders markdown by default', () => {
    const out = stripAnsi(display.agentTurn('# Title\n- item'));
    expect(out).toMatch(/Aiden/);
    // marked-terminal upper-cases headers and renders bullets
    expect(out).toMatch(/Title/i);
  });

  it('agentTurn with markdown:false leaves text alone', () => {
    const out = stripAnsi(display.agentTurn('raw text', { markdown: false }));
    expect(out).toContain('raw text');
  });

  it('toolPreview formats name and args', () => {
    const out = stripAnsi(display.toolPreview('read_file', { path: '/tmp/x' }));
    expect(out).toContain('read_file');
    expect(out).toContain('/tmp/x');
  });

  it('toolPreview truncates very long args', () => {
    const big = { blob: 'x'.repeat(2000) };
    const out = stripAnsi(display.toolPreview('huge', big));
    expect(out.length).toBeLessThan(260);
    expect(out).toContain('...');
  });

  it('error includes suggestion when provided', () => {
    const out = stripAnsi(display.error('missing api key', 'run aiden setup'));
    expect(out).toContain('missing api key');
    expect(out).toContain('run aiden setup');
  });

  it('error without suggestion omits the hint line', () => {
    const out = stripAnsi(display.error('boom'));
    expect(out).toContain('boom');
    expect(out).not.toMatch(/hint/);
  });

  it('startSpinner returns a handle that stops cleanly without errors', () => {
    // stdout in vitest is not a TTY, so spinner is a no-op apart from one write
    const h = display.startSpinner('thinking…');
    expect(typeof h.stop).toBe('function');
    expect(typeof h.setText).toBe('function');
    h.setText('still thinking');
    h.stop('done');
    h.stop(); // double stop is a no-op
  });

  it('markdown() handles plain text without throwing', () => {
    const out = display.markdown('plain text');
    expect(typeof out).toBe('string');
    expect(stripAnsi(out)).toContain('plain text');
  });
});
