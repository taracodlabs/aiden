import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  MemoryManager,
  MEMORY_CHAR_LIMIT,
  USER_CHAR_LIMIT,
  ENTRY_SEPARATOR,
} from '../../core/v4/memoryManager';
import { resolveAidenPaths, ensureAidenDirsExist } from '../../core/v4/paths';

let tmpDir: string;
let mgr: MemoryManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mem-'));
  const paths = resolveAidenPaths({ rootOverride: tmpDir });
  await ensureAidenDirsExist(paths);
  mgr = new MemoryManager(paths);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readMemory(file: 'memory' | 'user'): Promise<string> {
  const paths = resolveAidenPaths({ rootOverride: tmpDir });
  const target = file === 'user' ? paths.userMd : paths.memoryMd;
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return '';
  }
}

describe('MemoryManager', () => {
  it('1. loadSnapshot reads both files and reports content', async () => {
    await mgr.add('memory', 'I prefer pnpm');
    await mgr.add('user', 'User name is Shiva');
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('I prefer pnpm');
    expect(snap.userMd).toContain('User name is Shiva');
    expect(snap.isEmpty).toBe(false);
    expect(typeof snap.loadedAt).toBe('number');
  });

  it('2. loadSnapshot returns isEmpty=true when both files are missing', async () => {
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toBe('');
    expect(snap.userMd).toBe('');
    expect(snap.isEmpty).toBe(true);
  });

  it('3. add appends to MEMORY.md', async () => {
    const r = await mgr.add('memory', 'first note');
    expect(r.ok).toBe(true);
    expect(await readMemory('memory')).toContain('first note');
  });

  it('4. add no-ops on substring duplicates (ok=true with deduped flag, no disk change)', async () => {
    await mgr.add('memory', 'I prefer pnpm over npm');
    const before = await readMemory('memory');
    // Phase 21 #2: substring-duplicate is a successful no-op — the
    // post-write state already matches user intent, so we don't churn
    // the disk and we don't surface a "verified=false" warning.
    const r = await mgr.add('memory', 'pnpm over npm');
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(await readMemory('memory')).toBe(before);
  });

  it('5. add enforces MEMORY.md capacity (2200 chars)', async () => {
    expect(MEMORY_CHAR_LIMIT).toBe(2200);
    const big = 'x'.repeat(2201);
    const r = await mgr.add('memory', big);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/capacity/i);
  });

  it('6. add enforces USER.md capacity (1375 chars)', async () => {
    expect(USER_CHAR_LIMIT).toBe(1375);
    const big = 'y'.repeat(1376);
    const r = await mgr.add('user', big);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/capacity/i);
  });

  it('7. replace via substring match swaps the matched entry', async () => {
    await mgr.add('memory', 'My favorite color is blue');
    const r = await mgr.replace(
      'memory',
      'favorite color is blue',
      'favorite color is green',
    );
    expect(r.ok).toBe(true);
    const fresh = await readMemory('memory');
    expect(fresh).toContain('green');
    expect(fresh).not.toContain('blue');
  });

  it('8. replace fails when oldText is not found', async () => {
    await mgr.add('memory', 'something');
    const r = await mgr.replace('memory', 'nothing', 'else');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('9. replace fails when oldText matches multiple distinct entries', async () => {
    await mgr.add('memory', 'I like docker compose');
    await mgr.add('memory', 'docker is also useful for testing');
    const r = await mgr.replace('memory', 'docker', 'k8s');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Be more specific/);
  });

  it('10. remove via substring match deletes the matched entry', async () => {
    await mgr.add('memory', 'first entry');
    await mgr.add('memory', 'second entry');
    const r = await mgr.remove('memory', 'first');
    expect(r.ok).toBe(true);
    const fresh = await readMemory('memory');
    expect(fresh).not.toContain('first');
    expect(fresh).toContain('second');
  });

  it('11. remove fails when text not found', async () => {
    await mgr.add('memory', 'present');
    const r = await mgr.remove('memory', 'absent');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('12. remove fails when text matches multiple distinct entries', async () => {
    await mgr.add('memory', 'foo bar');
    await mgr.add('memory', 'foo baz');
    const r = await mgr.remove('memory', 'foo');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Be more specific/);
  });

  it('13. round-trip: add → loadSnapshot returns the new content', async () => {
    await mgr.add('memory', 'persistent note');
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('persistent note');
  });

  it('14. snapshot is frozen — later add() does not mutate it', async () => {
    await mgr.add('memory', 'before snapshot');
    const snap = await mgr.loadSnapshot();
    const before = snap.memoryMd;
    await mgr.add('memory', 'added after snapshot');
    expect(snap.memoryMd).toBe(before);
    expect(snap.memoryMd).not.toContain('added after snapshot');
    // Disk reflects the new write.
    expect(await readMemory('memory')).toContain('added after snapshot');
  });

  it('15. atomic write: failed mutation does not leave half-written file', async () => {
    await mgr.add('memory', 'stable content');
    // Force a capacity failure on replace.
    const huge = 'z'.repeat(MEMORY_CHAR_LIMIT + 1);
    const r = await mgr.replace('memory', 'stable content', huge);
    expect(r.ok).toBe(false);
    expect(await readMemory('memory')).toContain('stable content');
  });

  it('16. entries are joined with the documented separator', async () => {
    await mgr.add('memory', 'A');
    await mgr.add('memory', 'B');
    const raw = await readMemory('memory');
    expect(raw).toBe(['A', 'B'].join(ENTRY_SEPARATOR));
  });

  // ── Phase 16d: mutation listener wiring ─────────────────────────────────

  it('17. onMutation fires after successful add with the right file/action', async () => {
    const events: Array<{ file: string; action: string }> = [];
    mgr.onMutation((file, action) => events.push({ file, action }));
    await mgr.add('memory', 'phase 16d add');
    await mgr.add('user', 'phase 16d user');
    expect(events).toEqual([
      { file: 'memory', action: 'add' },
      { file: 'user', action: 'add' },
    ]);
  });

  it('18. onMutation does NOT fire on no-op add (duplicate) or failed add (capacity)', async () => {
    await mgr.add('memory', 'I prefer pnpm');
    const events: Array<{ file: string; action: string }> = [];
    mgr.onMutation((file, action) => events.push({ file, action }));
    // Phase 21 #2: duplicate is now ok=true with deduped flag (intent
    // satisfied — content is already in the file) but onMutation must
    // still NOT fire because the disk wasn't actually touched.
    const dup = await mgr.add('memory', 'I prefer pnpm');
    expect(dup.ok).toBe(true);
    expect(dup.deduped).toBe(true);
    // Capacity path stays a hard failure.
    const big = await mgr.add('memory', 'x'.repeat(MEMORY_CHAR_LIMIT + 1));
    expect(big.ok).toBe(false);
    expect(events).toEqual([]);
  });

  it('19. onMutation fires on replace and remove', async () => {
    await mgr.add('memory', 'one');
    const events: Array<{ file: string; action: string }> = [];
    mgr.onMutation((file, action) => events.push({ file, action }));
    const rRep = await mgr.replace('memory', 'one', 'two');
    expect(rRep.ok).toBe(true);
    const rRem = await mgr.remove('memory', 'two');
    expect(rRem.ok).toBe(true);
    expect(events).toEqual([
      { file: 'memory', action: 'replace' },
      { file: 'memory', action: 'remove' },
    ]);
  });

  it('20. onMutation unsubscribe stops further notifications', async () => {
    const events: string[] = [];
    const off = mgr.onMutation((_f, action) => events.push(action));
    await mgr.add('memory', 'first');
    off();
    await mgr.add('memory', 'second');
    expect(events).toEqual(['add']);
  });

  it('21. listener that throws does not break the mutation path', async () => {
    mgr.onMutation(() => {
      throw new Error('boom');
    });
    const r = await mgr.add('memory', 'still works');
    expect(r.ok).toBe(true);
    expect(await readMemory('memory')).toContain('still works');
  });
});
