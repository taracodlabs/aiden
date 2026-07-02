/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/memory/vaultExporter.test.ts — v4.11 vault mirror
 *
 * Covers:
 *   - resolveVaultPath precedence (env > config > unset)
 *   - exportNamespace splits MEMORY.md on \n§\n into per-entry notes
 *   - frontmatter is well-formed YAML with all expected fields
 *   - filenames follow `<slug>-<4hex>.md`, stable across re-exports
 *   - re-export is idempotent (no duplicate notes for the same entry)
 *   - source memory files are NEVER mutated by the exporter
 *   - distillation JSON renders as readable markdown
 *   - SOUL.md mirrors with readonly:true frontmatter
 *   - exportAll is a no-op when source files are missing (skips, no crash)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveVaultPath,
  exportAll,
  exportNamespace,
  exportSessions,
  exportSoul,
} from '../../../core/v4/memory/vaultExporter';
import type { AidenPaths } from '../../../core/v4/paths';

// ── Fixture: a throwaway aiden root + vault under os.tmpdir ────────────

let aidenRoot: string;
let vaultRoot: string;
let paths: AidenPaths;

beforeEach(async () => {
  aidenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-vault-test-'));
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-vault-vault-'));
  await fs.mkdir(path.join(aidenRoot, 'memories'),      { recursive: true });
  await fs.mkdir(path.join(aidenRoot, 'distillations'), { recursive: true });
  paths = {
    root:              aidenRoot,
    soulMd:            path.join(aidenRoot, 'SOUL.md'),
    memoryMd:          path.join(aidenRoot, 'memories', 'MEMORY.md'),
    userMd:            path.join(aidenRoot, 'memories', 'USER.md'),
    distillationsDir:  path.join(aidenRoot, 'distillations'),
  } as AidenPaths;
});
afterEach(async () => {
  await fs.rm(aidenRoot, { recursive: true, force: true });
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

// ── resolveVaultPath precedence ────────────────────────────────────────

describe('resolveVaultPath', () => {
  it('env wins over config', () => {
    expect(resolveVaultPath('/env/path', '/cfg/path')).toBe(path.resolve('/env/path'));
  });
  it('config used when env empty/undefined', () => {
    expect(resolveVaultPath(undefined, '/cfg/path')).toBe(path.resolve('/cfg/path'));
    expect(resolveVaultPath('',         '/cfg/path')).toBe(path.resolve('/cfg/path'));
  });
  it('returns null when both unset', () => {
    expect(resolveVaultPath(undefined, undefined)).toBeNull();
    expect(resolveVaultPath('', '')).toBeNull();
  });
  it('trims whitespace', () => {
    expect(resolveVaultPath('  /env/p  ', undefined)).toBe(path.resolve('/env/p'));
  });

  // ── v4.12.1 — quote healing + poisoned-value guard ───────────────────
  //
  // Class bug: a value with literal surrounding quotes (setx / hand-edited
  // config) doesn't start with a root, so the old `path.resolve` glued it
  // onto the cwd. Now healed via resolveUserPath.

  it('heals a double-quoted absolute env value (the setx footgun)', () => {
    const q = '"C:\\Users\\shiva\\Documents\\Obsidian\\aiden-memory"';
    const expected = path.resolve('C:\\Users\\shiva\\Documents\\Obsidian\\aiden-memory');
    expect(resolveVaultPath(q, undefined)).toBe(expected);
  });

  it('heals a single-quoted config value', () => {
    expect(resolveVaultPath(undefined, "'/vault/dir'")).toBe(path.resolve('/vault/dir'));
  });

  it('REGRESSION: a config poisoned by the pre-v4.11 link bug (glued path, quote mid-string) → warn + null, never a garbage dir', () => {
    // The EXACT malformed shape reported from the field: repo cwd glued to
    // a quoted absolute Windows path. It IS absolute (starts C:\), so no
    // resolver can un-glue it — the guard must disable the vault loudly
    // instead of exporting into `...DevOS\"C:\...`.
    const poisoned = 'C:\\Users\\shiva\\DevOS\\"C:\\Users\\shiva\\Documents\\Obsidian\\aiden-memory\\memory';
    const warns: string[] = [];
    expect(resolveVaultPath(undefined, poisoned, (m) => warns.push(m))).toBeNull();
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/malformed/i);
    expect(warns[0]).toMatch(/vault link/);
  });

  it('poisoned guard is silent when no onWarn is supplied (no throw)', () => {
    expect(resolveVaultPath('a\\"b', undefined)).toBeNull();
  });
});

// ── exportNamespace: split + frontmatter + filename ─────────────────────

describe('exportNamespace — MEMORY.md split + frontmatter', () => {
  it('splits on \\n§\\n and writes one note per entry', async () => {
    await fs.writeFile(paths.memoryMd, 'first entry text\n§\n## second entry\nbody', 'utf8');
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, summary);
    expect(summary.errors).toEqual([]);
    expect(summary.written).toBe(2);
    const files = await fs.readdir(path.join(vaultRoot, 'aiden-memory', 'memory'));
    expect(files.length).toBe(2);
    // Every filename matches `<slug>-<4hex>.md`
    for (const f of files) expect(f).toMatch(/^[a-z0-9][a-z0-9-]*-[0-9a-f]{4}\.md$/);
  });

  it('frontmatter contains namespace, source_file, entry_id, created, updated, scope, readonly', async () => {
    await fs.writeFile(paths.memoryMd, 'just one entry', 'utf8');
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, summary);
    const dir   = path.join(vaultRoot, 'aiden-memory', 'memory');
    const file  = (await fs.readdir(dir))[0];
    const body  = await fs.readFile(path.join(dir, file), 'utf8');
    expect(body.startsWith('---')).toBe(true);
    expect(body).toMatch(/^namespace: memory$/m);
    expect(body).toMatch(/^source_file: memories\/MEMORY\.md$/m);
    expect(body).toMatch(/^entry_id: [0-9a-f]{4}$/m);
    expect(body).toMatch(/^created: /m);
    expect(body).toMatch(/^updated: /m);
    expect(body).toMatch(/^scope: aiden-auto$/m);
    expect(body).toMatch(/^readonly: false$/m);
    // Body includes the entry verbatim + a Related backlink
    expect(body).toContain('just one entry');
    expect(body).toContain('[[memory]]');
  });

  it('re-export is idempotent — same entry → same filename, no dupes', async () => {
    await fs.writeFile(paths.memoryMd, 'stable entry', 'utf8');
    const s1 = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, s1);
    const filesAfter1 = await fs.readdir(path.join(vaultRoot, 'aiden-memory', 'memory'));
    expect(filesAfter1.length).toBe(1);

    const s2 = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, s2);
    const filesAfter2 = await fs.readdir(path.join(vaultRoot, 'aiden-memory', 'memory'));
    expect(filesAfter2.length).toBe(1);
    expect(filesAfter2).toEqual(filesAfter1);  // same filename
  });

  it('preserves `created` timestamp across re-exports', async () => {
    await fs.writeFile(paths.memoryMd, 'entry', 'utf8');
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, summary);
    const dir   = path.join(vaultRoot, 'aiden-memory', 'memory');
    const file  = (await fs.readdir(dir))[0];
    const first = await fs.readFile(path.join(dir, file), 'utf8');
    const createdMatch = first.match(/^created: (.+)$/m);
    expect(createdMatch).not.toBeNull();

    // Re-export — created must stay, updated may change
    await new Promise((r) => setTimeout(r, 10));
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, summary);
    const second = await fs.readFile(path.join(dir, file), 'utf8');
    expect(second).toContain(`created: ${createdMatch![1]}`);
  });

  it('removes stale auto-notes when an entry disappears', async () => {
    await fs.writeFile(paths.memoryMd, 'first\n§\nsecond', 'utf8');
    const s1 = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, s1);
    expect((await fs.readdir(path.join(vaultRoot, 'aiden-memory', 'memory'))).length).toBe(2);

    // Remove `second` from the source — re-export should drop the stale note
    await fs.writeFile(paths.memoryMd, 'first', 'utf8');
    const s2 = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, s2);
    const after = await fs.readdir(path.join(vaultRoot, 'aiden-memory', 'memory'));
    expect(after.length).toBe(1);
    expect(s2.removed).toBe(1);
  });

  it('preserves user-added files in the namespace dir', async () => {
    await fs.writeFile(paths.memoryMd, 'auto entry', 'utf8');
    const dir = path.join(vaultRoot, 'aiden-memory', 'memory');
    await fs.mkdir(dir, { recursive: true });
    // User drops a hand-written file with a non-pattern name
    await fs.writeFile(path.join(dir, 'my-notes.md'), 'user scratch', 'utf8');
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, summary);
    const files = await fs.readdir(dir);
    expect(files).toContain('my-notes.md');  // user file survives
    expect(files.some((f) => /^[a-z0-9][a-z0-9-]*-[0-9a-f]{4}\.md$/.test(f))).toBe(true);
  });

  it('export does NOT mutate the source MEMORY.md', async () => {
    const sourceContent = 'one\n§\ntwo';
    await fs.writeFile(paths.memoryMd, sourceContent, 'utf8');
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportNamespace({ paths, vaultPath: vaultRoot }, 'memory', paths.memoryMd, summary);
    const after = await fs.readFile(paths.memoryMd, 'utf8');
    expect(after).toBe(sourceContent);
  });
});

// ── Distillations → readable markdown ───────────────────────────────────

describe('exportSessions — distillation JSON → markdown', () => {
  it('renders bullets/decisions/open_items/keywords as H2 sections', async () => {
    const distillation = {
      schema_version: 1,
      session_id:     'abc-123',
      started_at:     '2026-05-28T10:00:00Z',
      ended_at:       '2026-05-28T10:30:00Z',
      exit_path:      'quit',
      user_turns:     5,
      bullets:        ['Did the thing', 'Then did the other thing'],
      decisions:      ['Chose option A over B'],
      open_items:     ['Follow up on X'],
      keywords:       ['kw1', 'kw2'],
    };
    await fs.writeFile(
      path.join(paths.distillationsDir, 'abc-123.json'),
      JSON.stringify(distillation),
      'utf8',
    );
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportSessions({ paths, vaultPath: vaultRoot }, summary);
    expect(summary.errors).toEqual([]);
    expect(summary.written).toBe(1);
    const file = (await fs.readdir(path.join(vaultRoot, 'aiden-memory', 'sessions')))[0];
    const body = await fs.readFile(
      path.join(vaultRoot, 'aiden-memory', 'sessions', file),
      'utf8',
    );
    expect(body).toContain('namespace: sessions');
    expect(body).toContain('## Bullets');
    expect(body).toContain('- Did the thing');
    expect(body).toContain('## Decisions');
    expect(body).toContain('- Chose option A over B');
    expect(body).toContain('## Open items');
    expect(body).toContain('## Keywords');
    expect(body).toContain('**Exit:** quit');
    expect(body).toContain('**User turns:** 5');
  });

  it('skips malformed JSON files with logged error, continues', async () => {
    await fs.writeFile(path.join(paths.distillationsDir, 'bad.json'),  'not json', 'utf8');
    await fs.writeFile(
      path.join(paths.distillationsDir, 'good.json'),
      JSON.stringify({ session_id: 'g', started_at: '2026-01-01', bullets: ['ok'] }),
      'utf8',
    );
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportSessions({ paths, vaultPath: vaultRoot }, summary);
    expect(summary.written).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.errors.some((e) => e.includes('bad.json'))).toBe(true);
  });
});

// ── SOUL.md read-only mirror ────────────────────────────────────────────

describe('exportSoul', () => {
  it('mirrors SOUL.md with readonly:true frontmatter + warning footer', async () => {
    await fs.writeFile(paths.soulMd, '# My SOUL\nMy identity prose.', 'utf8');
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportSoul({ paths, vaultPath: vaultRoot }, summary);
    expect(summary.written).toBe(1);
    const file = (await fs.readdir(path.join(vaultRoot, 'aiden-memory', 'soul')))[0];
    const body = await fs.readFile(
      path.join(vaultRoot, 'aiden-memory', 'soul', file),
      'utf8',
    );
    expect(body).toMatch(/^namespace: soul$/m);
    expect(body).toMatch(/^scope: aiden-identity$/m);
    expect(body).toMatch(/^readonly: true$/m);
    expect(body).toContain('My identity prose');
    expect(body).toContain('Read-only mirror');
  });

  it('skips silently when SOUL.md is missing', async () => {
    const summary = { written: 0, removed: 0, skipped: 0, errors: [] as string[] };
    await exportSoul({ paths, vaultPath: vaultRoot }, summary);
    expect(summary.written).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

// ── exportAll end-to-end ────────────────────────────────────────────────

describe('exportAll', () => {
  it('creates all six subdirs (memory/user/project/sessions/soul/notes) even when most sources are empty', async () => {
    await exportAll({ paths, vaultPath: vaultRoot });
    for (const sub of ['memory', 'user', 'project', 'sessions', 'soul', 'notes']) {
      const exists = await fs.stat(path.join(vaultRoot, 'aiden-memory', sub))
        .then(() => true).catch(() => false);
      expect(exists, `expected dir ${sub}`).toBe(true);
    }
  });

  it('runs end-to-end with all sources populated', async () => {
    await fs.writeFile(paths.memoryMd, 'mem entry', 'utf8');
    await fs.writeFile(paths.userMd,   'usr entry', 'utf8');
    await fs.writeFile(paths.soulMd,   'my soul',  'utf8');
    await fs.writeFile(
      path.join(paths.distillationsDir, 's1.json'),
      JSON.stringify({ session_id: 's1', started_at: '2026-01-01', bullets: ['ok'] }),
      'utf8',
    );
    const summary = await exportAll({ paths, vaultPath: vaultRoot });
    expect(summary.errors).toEqual([]);
    expect(summary.written).toBeGreaterThanOrEqual(4);  // 1 mem + 1 user + 1 session + 1 soul
  });
});
