import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Phase 22 Group C, Task 8 — CI guard.
 *
 * Every bundled skill's description must fit on a single 80-column
 * terminal line so /skills, /help completion menus, and the boot-card
 * skill summary don't wrap. The audit + tightening pass landed 56
 * descriptions; this test prevents regression as new skills are added.
 *
 * To bump the cap, justify the change here AND in the audit doc at
 * `_internal/hermes-ux-patterns.md` §8C.a.
 */
const MAX_DESCRIPTION_CHARS = 80;
const SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', 'skills');

describe('bundled skill description length', () => {
  it(`every skill.json description fits in ${MAX_DESCRIPTION_CHARS} chars`, async () => {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    const overflow: { skill: string; length: number; description: string }[] = [];
    for (const name of dirs) {
      const manifestPath = path.join(SKILLS_DIR, name, 'skill.json');
      let raw: string;
      try {
        raw = await fs.readFile(manifestPath, 'utf8');
      } catch {
        continue; // not a real skill (e.g. installed/, learned/ buckets)
      }
      let manifest: { description?: string };
      try {
        manifest = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Could not parse ${manifestPath}: ${(err as Error).message}`);
      }
      const desc = manifest.description ?? '';
      if (desc.length > MAX_DESCRIPTION_CHARS) {
        overflow.push({ skill: name, length: desc.length, description: desc });
      }
    }

    if (overflow.length > 0) {
      const detail = overflow
        .map((o) => `  - ${o.skill} (${o.length} chars): ${o.description}`)
        .join('\n');
      throw new Error(
        `${overflow.length} skill description(s) exceed ${MAX_DESCRIPTION_CHARS} chars:\n${detail}\n\n` +
          `Run \`node scripts/tighten-skill-descriptions.cjs\` after adding the offending skill(s) to its REWRITES map.`,
      );
    }
    expect(overflow).toEqual([]);
  });

  it('every bundled skill manifest has a non-empty description', async () => {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const missing: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(SKILLS_DIR, e.name, 'skill.json');
      try {
        const raw = await fs.readFile(p, 'utf8');
        const m = JSON.parse(raw);
        if (typeof m.description !== 'string' || m.description.trim().length === 0) {
          missing.push(e.name);
        }
      } catch {
        // No manifest — bucket directory like installed/, skip.
      }
    }
    expect(missing).toEqual([]);
  });
});
