import { describe, it, expect } from 'vitest';
import { renderTable } from '../../../cli/v4/table';

// Strip ANSI escape sequences so chrome assertions stay deterministic
// regardless of skin color.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

interface Row { name: string; count: string }
const cols = [
  { key: 'name' as const,  header: 'name',  align: 'left'  as const },
  { key: 'count' as const, header: 'count', align: 'right' as const },
];
const rows: Row[] = [
  { name: 'alpha',   count: '3'  },
  { name: 'bravo',   count: '12' },
  { name: 'charlie', count: '7'  },
];

describe('table v4.8.0 Slice 3 chrome', () => {
  it('plain table (no title) keeps the legacy top border with column tees', () => {
    const out = stripAnsi(renderTable(rows, cols, { maxWidth: 60 }));
    // Legacy top has inner `┬` between column segments.
    expect(out).toMatch(/^[\s\S]*┌.*┬.*┐/);
    expect(out).toContain('name');
    expect(out).toContain('count');
    expect(out).toContain('charlie');
  });

  it('title + totalCount embed into the top border', () => {
    const out = stripAnsi(renderTable(rows, cols, {
      title: 'Skills', totalCount: '3 installed', maxWidth: 60,
    }));
    const firstLine = out.split('\n')[0];
    expect(firstLine).toMatch(/^ *┌/);
    expect(firstLine).toMatch(/┐$/);
    expect(firstLine).toContain('Skills');
    expect(firstLine).toContain('3 installed');
  });

  it('title-style top pairs with a plain bottom border (no inner tees)', () => {
    const out = stripAnsi(renderTable(rows, cols, {
      title: 'Skills', maxWidth: 60,
    }));
    const lines = out.trim().split('\n');
    const bot = lines[lines.length - 1];
    expect(bot).toMatch(/└─+┘/);
    // No `┴` in the title-style bottom (token-sourced plain horizontal).
    expect(bot).not.toContain('┴');
  });

  it('pagination footer renders when page metadata is supplied', () => {
    const out = stripAnsi(renderTable(rows, cols, {
      title: 'Recent runs', page: { current: 2, total: 5 }, maxWidth: 80,
    }));
    expect(out).toContain('← prev');
    expect(out).toContain('page 2/5');
    expect(out).toContain('next →');
  });

  it('no pagination footer when page metadata is absent', () => {
    const out = stripAnsi(renderTable(rows, cols, { maxWidth: 60 }));
    expect(out).not.toContain('← prev');
    expect(out).not.toContain('page');
    expect(out).not.toContain('next →');
  });

  it('empty rows + emptyMessage renders mini-frame; no header row', () => {
    const out = stripAnsi(renderTable([], cols, {
      title: 'Skills', totalCount: '0 installed', emptyMessage: 'no skills installed',
      maxWidth: 60,
    }));
    const lines = out.trim().split('\n');
    // Three lines: top, message, bottom. No header row.
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('Skills');
    expect(lines[1]).toContain('no skills installed');
    expect(lines[2]).toMatch(/└─+┘/);
    expect(out).not.toContain('name');
    expect(out).not.toContain('count');
  });

  it('empty rows without emptyMessage falls through to header-only (legacy)', () => {
    const out = stripAnsi(renderTable([], cols, { maxWidth: 60 }));
    // Legacy behavior: still paints header even when no data. Backward
    // compat for callers that don't supply emptyMessage.
    expect(out).toContain('name');
    expect(out).toContain('count');
  });
});
