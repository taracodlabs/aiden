/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 — speaks-first onboarding trigger guard + idempotency.
 *
 * The load-bearing rule (same bug class as the wizard config-detection fix):
 * onboard ONLY a brand-new user — marker absent AND USER.md empty — and
 * NEVER re-onboard an existing user (marker present OR non-empty USER.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  shouldOnboard,
  renderOnboardingIntro,
  isOnboardingShown,
  resetOnboarding,
  normalizeOnboardingName,
  parseUserName,
  readUserName,
  type OnboardingMemory,
} from '../../../../cli/v4/onboarding/speakFirst';
import { resolveAidenPaths, type AidenPaths } from '../../../../core/v4/paths';

/** In-memory MemoryManager stand-in that writes to the real USER.md path so
 *  the ask→store→use loop can be asserted end-to-end against disk. */
function fakeMemory(paths: AidenPaths): OnboardingMemory & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    async add(file: string, content: string) {
      writes.push(`${file}:${content}`);
      if (file === 'user') {
        await fs.mkdir(path.dirname(paths.userMd), { recursive: true });
        const prev = await fs.readFile(paths.userMd, 'utf8').catch(() => '');
        await fs.writeFile(paths.userMd, prev ? `${prev}\n§\n${content}` : content, 'utf8');
      }
      return { ok: true };
    },
  };
}

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-onboard-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.userMd), { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** TTY out stub capturing writes. */
function ttyOut(isTTY = true): { out: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const out = {
    isTTY,
    write(s: string): boolean { chunks.push(s); return true; },
  } as unknown as NodeJS.WriteStream;
  return { out, text: () => chunks.join('') };
}

describe('shouldOnboard — trigger guard', () => {
  it('true for a brand-new user: no marker, no USER.md', async () => {
    expect(await shouldOnboard(paths)).toBe(true);
  });

  it('false once the marker exists (already onboarded)', async () => {
    await fs.writeFile(path.join(tmp, '.onboarding-shown'), '2026-01-01T00:00:00Z\n');
    expect(await shouldOnboard(paths)).toBe(false);
  });

  it('false when USER.md is non-empty (existing user — never re-onboard)', async () => {
    await fs.writeFile(paths.userMd, 'Name: Shiva\nWorks on: dev tools\n', 'utf8');
    expect(await shouldOnboard(paths)).toBe(false);
  });

  it('true when USER.md exists but is whitespace-only', async () => {
    await fs.writeFile(paths.userMd, '   \n\n', 'utf8');
    expect(await shouldOnboard(paths)).toBe(true);
  });
});

describe('renderOnboardingIntro', () => {
  it('uses the injected interactive theme authority for visible startup text', async () => {
    const { out } = ttyOut(true);
    const chunks: string[] = [];
    await renderOnboardingIntro({
      paths,
      out,
      write: (text) => { chunks.push(text); },
      style: {
        accent: (value) => `<accent>${value}</accent>`,
        muted: (value) => `<muted>${value}</muted>`,
      },
      readAnswer: async () => null,
    } as never);
    const text = chunks.join('');
    expect(text).toContain(`<accent>Hi — I'm Aiden.</accent>`);
    expect(text).toContain('<muted>I run right here on your machine');
  });

  it('brand-new + TTY: paints the calm intro, asks ONE thing (the name)', async () => {
    const { out, text } = ttyOut(true);
    const fired = await renderOnboardingIntro({ paths, out, readAnswer: async () => null });
    expect(fired).toBe(true);
    const t = text();
    expect(t).toMatch(/Hi — I'm Aiden/);
    expect(t).toMatch(/right here on your machine/);
    expect(t).toMatch(/What should I call you\?/);
    // One question only — no "what are you working on" survey this slice.
    expect(t).not.toMatch(/what are you working on/i);
    // Personalization, not companionship — no feelings/intimacy framing.
    expect(t).not.toMatch(/miss you|love|lonely|feelings/i);
    expect(await isOnboardingShown(paths)).toBe(true);
  });

  // ★ the whole point — ask → STORE → (USE tested via the greeter elsewhere).
  it('captures the name and STORES it to USER.md via the memory write path', async () => {
    const mem = fakeMemory(paths);
    const { out, text } = ttyOut(true);
    const fired = await renderOnboardingIntro({ paths, out, memory: mem, readAnswer: async () => 'Shiva' });
    expect(fired).toBe(true);
    // Stored through the real namespace, exact durable format.
    expect(mem.writes).toEqual(["user:User's name is Shiva. (source: onboarding)"]);
    expect(await readUserName(paths.userMd)).toBe('Shiva');
    expect(text()).toMatch(/Good to meet you, Shiva/);
    expect(await isOnboardingShown(paths)).toBe(true);
  });

  it('normalizes a chatty answer to a clean call-name before storing', async () => {
    const mem = fakeMemory(paths);
    await renderOnboardingIntro({ paths, out: ttyOut(true).out, memory: mem, readAnswer: async () => "I'm Shiva" });
    expect(await readUserName(paths.userMd)).toBe('Shiva');
  });

  it('empty answer → NO store, marker still set, graceful, never re-asks', async () => {
    const mem = fakeMemory(paths);
    const { out, text } = ttyOut(true);
    const fired = await renderOnboardingIntro({ paths, out, memory: mem, readAnswer: async () => '   ' });
    expect(fired).toBe(true);
    expect(mem.writes).toEqual([]);                    // nothing stored
    expect(await readUserName(paths.userMd)).toBeNull();
    expect(text()).toMatch(/just say the word/i);      // graceful fallback
    expect(await isOnboardingShown(paths)).toBe(true); // marker set → no re-ask
    // Proof of no re-ask: a second run does not fire.
    expect(await renderOnboardingIntro({ paths, out: ttyOut(true).out, memory: mem, readAnswer: async () => 'Late' })).toBe(false);
    expect(await readUserName(paths.userMd)).toBeNull();
  });

  it('idempotent: second call does not fire (marker written on first)', async () => {
    const a = await renderOnboardingIntro({ paths, out: ttyOut().out, readAnswer: async () => 'Shiva', memory: fakeMemory(paths) });
    const b = await renderOnboardingIntro({ paths, out: ttyOut().out, readAnswer: async () => 'Again', memory: fakeMemory(paths) });
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it('non-TTY out: never paints, no hang, marker not written', async () => {
    const { out, text } = ttyOut(false);
    expect(await renderOnboardingIntro({ paths, out })).toBe(false);
    expect(text()).toBe('');
    expect(await isOnboardingShown(paths)).toBe(false);
  });

  it('non-interactive STDIN (piped): fires but reads nothing → no store, no hang', async () => {
    const mem = fakeMemory(paths);
    const { out } = ttyOut(true);                       // output IS a tty…
    const pipedStdin = { isTTY: false } as unknown as NodeJS.ReadStream;   // …but stdin is piped
    const fired = await renderOnboardingIntro({ paths, out, memory: mem, input: pipedStdin });
    expect(fired).toBe(true);                           // intro shown
    expect(mem.writes).toEqual([]);                     // default reader returned null → no store
    expect(await isOnboardingShown(paths)).toBe(true);  // still marks (no re-ask)
  });

  it('existing user (non-empty USER.md): never paints', async () => {
    await fs.writeFile(paths.userMd, 'Name: Shiva\n', 'utf8');
    const { out, text } = ttyOut(true);
    expect(await renderOnboardingIntro({ paths, out, readAnswer: async () => 'X' })).toBe(false);
    expect(text()).toBe('');
  });

  it('resetOnboarding clears the marker so it can fire again', async () => {
    await renderOnboardingIntro({ paths, out: ttyOut().out, readAnswer: async () => null });
    expect(await resetOnboarding(paths)).toBe(true);
    expect(await shouldOnboard(paths)).toBe(true);
  });
});

describe('name parsing helpers', () => {
  it('normalizeOnboardingName strips lead-ins, quotes, punctuation; caps length', () => {
    expect(normalizeOnboardingName('Shiva')).toBe('Shiva');
    expect(normalizeOnboardingName("I'm Shiva")).toBe('Shiva');
    expect(normalizeOnboardingName('my name is Shiva Deore')).toBe('Shiva Deore');
    expect(normalizeOnboardingName('call me "Shiv".')).toBe('Shiv');
    expect(normalizeOnboardingName('   ')).toBeNull();
    expect(normalizeOnboardingName(null)).toBeNull();
    expect(normalizeOnboardingName('x'.repeat(80))!.length).toBe(40);
  });

  it('parseUserName round-trips the stored line and tolerates other entries', () => {
    expect(parseUserName("User's name is Shiva. (source: onboarding)")).toBe('Shiva');
    expect(parseUserName("Likes dark mode\n§\nUser's name is Ada. (source: onboarding)")).toBe('Ada');
    expect(parseUserName('no name here')).toBeNull();
  });
});
