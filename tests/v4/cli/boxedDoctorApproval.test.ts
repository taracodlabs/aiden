import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';

import { renderHealthBox, type DoctorReport } from '../../../cli/v4/doctor';
import { renderApprovalBox } from '../../../cli/v4/callbacks';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay(opts: { mono: boolean; columns?: number }): Display {
  const out = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  }) as Writable & { isTTY?: boolean; columns?: number };
  out.isTTY = true;
  out.columns = opts.columns ?? 100;
  return new Display({
    skin: new SkinEngine({ forceMono: opts.mono }),
    stdout: out as unknown as NodeJS.WriteStream,
  });
}

// v4.1.3-essentials doctor-polish: every CheckResult now carries a
// `group` field that the renderer buckets by. Fixtures updated to
// match the production shape — fixtures without `group` would render
// as empty (groupResults drops them).
const SAMPLE_REPORT: DoctorReport = {
  results: [
    { name: 'config file',   group: 'Storage',   passed: true,  message: '/home/x/.aiden/config.yaml', durationMs: 1 },
    { name: 'provider auth', group: 'Providers', passed: true,  message: '1 provider key (TOGETHER_API_KEY)', durationMs: 1 },
    {
      name: 'ollama',
      group: 'Inference',
      passed: false,
      message: 'not reachable',
      suggestion: 'install from https://ollama.com',
      durationMs: 5,
    },
    { name: 'python', group: 'System tools', passed: true, message: '3.11.9', durationMs: 30 },
    { name: 'docker', group: 'System tools', passed: true, message: '29.2.1', durationMs: 28 },
  ],
  passed: false,
  totalMs: 468,
};

describe('renderHealthBox (Phase 22 Task 5A)', () => {
  it('opens with a rounded box top titled "Health Check"', () => {
    const display = makeDisplay({ mono: true });
    const out = renderHealthBox(SAMPLE_REPORT, display);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^┌── Health Check /);
  });

  it('closes with a rounded box bottom border', () => {
    const display = makeDisplay({ mono: true });
    const lines = renderHealthBox(SAMPLE_REPORT, display).split('\n');
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
  });

  it('renders one row per check with the passed/warn/failed glyph', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(SAMPLE_REPORT, display));
    // Passed: ✓; failed: ✗ (ollama row).
    expect(out).toMatch(/✓\s+config file\s+\/home\/x\/\.aiden\/config\.yaml/);
    expect(out).toMatch(/✓\s+python\s+3\.11\.9/);
    expect(out).toMatch(/✗\s+ollama\s+not reachable/);
  });

  it('emits a hint continuation line for failed checks with a suggestion', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(SAMPLE_REPORT, display));
    expect(out).toMatch(/hint: install from https:\/\/ollama\.com/);
  });

  it('top summary shows passing/warning/failing counts + total + duration', () => {
    // v4.1.3-essentials doctor-polish: bottom `N of M checks passed in
    // Xms` replaced by a TOP summary with three buckets — passing
    // (clean ok), warning (passed-with-suggestion), failing (not
    // passed). SAMPLE_REPORT: 4 passing, 0 warning, 1 failing.
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(SAMPLE_REPORT, display));
    expect(out).toMatch(/Overall:.*4 passing.*0 warning.*1 failing/);
    expect(out).toMatch(/5 checks, 468 ms/);
  });

  it('coloured output uses the brand orange #FF6B35 for box borders', () => {
    const display = makeDisplay({ mono: false });
    const out = renderHealthBox(SAMPLE_REPORT, display);
    expect(out).toContain('\x1b[38;2;255;107;53m');
    // No grey #808080.
    expect(out).not.toContain('\x1b[38;2;128;128;128m');
  });

  it('auto-fits width to widest content row (no mid-word truncation on long paths)', () => {
    // Phase 22 Group C smoke-fix #3: pre-fix the box was clamped at
    // a fixed 70 chars and Windows paths > 65 chars got truncated
    // mid-word. The auto-fit now grows the box to fit the widest row.
    const longPathReport: DoctorReport = {
      results: [
        {
          name: 'config file',
          group: 'Storage',
          passed: true,
          message: 'found at C:\\Users\\shiva\\AppData\\Local\\aiden\\config.yaml',
          durationMs: 1,
        },
        {
          name: 'bundled manifest',
          group: 'Storage',
          passed: true,
          message: 'present at C:\\Users\\shiva\\AppData\\Local\\aiden\\.bundled_manifest',
          durationMs: 1,
        },
      ],
      passed: true,
      totalMs: 50,
    };
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(longPathReport, display));
    // Both full paths must appear intact — no `con` / `.bun` truncation.
    expect(out).toContain('C:\\Users\\shiva\\AppData\\Local\\aiden\\config.yaml');
    expect(out).toContain('C:\\Users\\shiva\\AppData\\Local\\aiden\\.bundled_manifest');
    // Top, all rows, and bottom share the same visible width.
    const lines = out.split('\n').filter((l) => l.length > 0);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it('floors at the 60-char minimum even with trivially short rows', () => {
    const tinyReport: DoctorReport = {
      results: [{ name: 'x', group: 'Storage', passed: true, message: 'ok', durationMs: 1 }],
      passed: true,
      totalMs: 1,
    };
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(tinyReport, display));
    const topLine = out.split('\n')[0];
    expect(topLine.length).toBeGreaterThanOrEqual(60 + 2); // 60 inner + 2 corners
  });

  it('caps at the 100-char maximum even with extremely long messages', () => {
    const giantReport: DoctorReport = {
      results: [
        {
          name: 'oversized',
          group: 'Storage',
          passed: true,
          message: 'x'.repeat(500),
          durationMs: 1,
        },
      ],
      passed: true,
      totalMs: 1,
    };
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderHealthBox(giantReport, display));
    const topLine = out.split('\n')[0];
    expect(topLine.length).toBeLessThanOrEqual(100 + 2); // 100 inner + 2 corners
  });

  it('all-pass report shows summary in success colour', () => {
    const display = makeDisplay({ mono: false });
    const allPass: DoctorReport = {
      ...SAMPLE_REPORT,
      results: SAMPLE_REPORT.results.map((r) => ({ ...r, passed: true, suggestion: undefined })),
      passed: true,
    };
    const out = renderHealthBox(allPass, display);
    // success colour in default skin = #4CAF50 → rgb 76, 175, 80.
    expect(out).toContain('\x1b[38;2;76;175;80m');
  });
});

describe('renderApprovalBox (Phase 22 Task 5B)', () => {
  const SAMPLE_REQ = {
    toolName: 'file_delete',
    category: 'filesystem',
    args: { path: 'C:\\Users\\shiva\\backups\\old.zip' },
    riskTier: 'caution' as const,
    reason: 'destructive operation',
  };

  it('Slice 6 hotfix: every content line carries the 2-space indent + │ accent bar', () => {
    const display = makeDisplay({ mono: true });
    const out = renderApprovalBox(SAMPLE_REQ as any, display);
    // Output leads + trails with a blank line for breathing room;
    // every non-blank line carries the indented bar.
    // v4.8.0 Slice 11c — panel bar swapped ▎ → │ (universal-font glyph).
    for (const line of out.split('\n').filter(l => l.length > 0)) {
      expect(line.startsWith('  │')).toBe(true);
    }
    // The ASCII-box corners are gone.
    expect(out).not.toContain('┌');
    expect(out).not.toContain('┐');
    expect(out).not.toContain('└');
    expect(out).not.toContain('┘');
  });

  it('Slice 6 hotfix: NO duplicate "Approval needed" title row (Phase 2.5 event owns the headline)', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderApprovalBox(SAMPLE_REQ as any, display));
    expect(out).not.toMatch(/Approval needed/);
  });

  it('Slice 6 hotfix: leading + trailing blank lines for breathing room', () => {
    const display = makeDisplay({ mono: true });
    const out = renderApprovalBox(SAMPLE_REQ as any, display);
    expect(out.startsWith('\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('Slice 6 hotfix: key column is consistently aligned across all rows', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderApprovalBox(SAMPLE_REQ as any, display));
    // Pull the col-index where each key starts. tool/reason/args must
    // share the same x position.
    const keyCols = ['tool', 'reason', 'args']
      .map(k => out.split('\n').find(l => l.includes(k))?.indexOf(k) ?? -1);
    expect(new Set(keyCols).size).toBe(1);
  });

  it('renders key/value rows for tool, reason, and args', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderApprovalBox(SAMPLE_REQ as any, display));
    expect(out).toMatch(/tool\s+file_delete/);
    expect(out).toMatch(/reason\s+destructive operation/);
    expect(out).toMatch(/args\s+\{"path":"C:\\\\Users\\\\shiva\\\\backups\\\\old\.zip"\}/);
  });

  it('omits the reason row when no reason is supplied', () => {
    const display = makeDisplay({ mono: true });
    const noReason = { ...SAMPLE_REQ, reason: undefined };
    const out = stripAnsi(renderApprovalBox(noReason as any, display));
    expect(out).not.toMatch(/^.*reason\s+/m);
    expect(out).toMatch(/tool\s+file_delete/);
  });

  it('truncates oversized args with an ellipsis', () => {
    const display = makeDisplay({ mono: true });
    const big = { ...SAMPLE_REQ, args: { blob: 'x'.repeat(500) } };
    const out = stripAnsi(renderApprovalBox(big as any, display));
    expect(out).toMatch(/args\s+\{"blob":"x+…/);
  });

  it('Slice 6 hotfix: footer hint matches the inquirer mechanic (arrow nav)', () => {
    const display = makeDisplay({ mono: true });
    const out = stripAnsi(renderApprovalBox(SAMPLE_REQ as any, display));
    expect(out).toMatch(/↑↓ navigate · enter select · esc cancel/);
    // The old [y]/[a]/[n] hint LIED about the input mechanic; it must not
    // appear in the new chrome.
    expect(out).not.toMatch(/\[y\] allow once/);
  });

  it('Slice 6 hotfix: left bar paints brand orange (#FF6B35)', () => {
    const display = makeDisplay({ mono: false });
    const out = renderApprovalBox(SAMPLE_REQ as any, display);
    // brand orange = #FF6B35 → rgb 255, 107, 53.
    expect(out).toContain('\x1b[38;2;255;107;53m');
  });

  it.each([120, 80, 60, 44, 24])('fits every approval-preview line within %i columns', (columns) => {
    const display = makeDisplay({ mono: true, columns });
    const req = {
      ...SAMPLE_REQ,
      reason: 'a deliberately long approval reason that must not wrap into the prompt',
      args: { command: 'Write-Output ' + 'x'.repeat(160) },
    };
    const out = stripAnsi(renderApprovalBox(req as any, display));
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(columns - 1);
    expect(out).toContain('tool');
    expect(out).toContain('file_delete');
  });
});
