/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/onboarding/speakFirst.ts — v4.12 speaks-first onboarding,
 * v4.14 Personality Layer 1: first-meeting name capture that CLOSES the loop.
 *
 * On the very first REPL session, Aiden introduces itself and asks ONE thing —
 * what to call you — then STORES the answer to USER.md via the existing memory
 * write path (memory.add('user', …)), the same store the `memory_add` tool
 * uses. Because USER.md is injected into the system prompt (promptBuilder), the
 * name is available to the model from the next prompt build, and the boot
 * greeter (buildWelcomeLine) reads it back to greet by name on later boots.
 * Ask → store → USE. Not theater.
 *
 * Trigger guard (same bug class as the wizard config-detection fix): onboard
 * ONLY when the marker is absent AND USER.md is empty. An existing user (marker
 * present OR a non-empty USER.md) is NEVER re-onboarded.
 *
 * No-hang contract: the whole intro is gated on an interactive OUTPUT tty, and
 * the name question is only read when STDIN is a tty — a piped / daemon / test
 * run reads nothing and proceeds gracefully (no store, marker set, no re-ask).
 *
 * Personalization, NOT companionship: calm-and-capable with a warm edge — a
 * good colleague's first hello. Never bubbly, never robotic, never emotional.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { c } from '../../../core/v4/ui/theme';
import type { AidenPaths } from '../../../core/v4/paths';
// v4.14.x — USER.md reads route through the shared UTF-8 memory doorway.
import { readMemoryFile } from '../../../core/v4/memory/io';

const MARKER_NAME = '.onboarding-shown';
/** Keep a captured name short — it's a call-name, not a bio. */
const NAME_MAX = 40;

function markerPath(paths: AidenPaths): string {
  return path.join(paths.root, MARKER_NAME);
}

/** The minimal memory writer onboarding needs — satisfied by MemoryManager. */
export interface OnboardingMemory {
  // v4.14.x — optional provenance source; onboarding passes 'said'.
  add(file: string, content: string, source?: 'said' | 'saw' | 'guess'): Promise<{ ok: boolean }>;
}

export interface OnboardingOptions {
  paths:  AidenPaths;
  out?:   NodeJS.WriteStream;
  /** Route visible text through the active presentation owner. */
  write?: (text: string) => void;
  /** Effective interactive theme supplied by the owning display. */
  style?: {
    accent(value: string): string;
    muted(value: string): string;
  };
  /** Injectable fs for tests. */
  fsImpl?: typeof fs;
  /** Injectable stdin for tests. Default: process.stdin. */
  input?:  NodeJS.ReadStream;
  /**
   * Reuse the real memory store. When provided AND a name is captured, the
   * name is written via `memory.add('user', …)`. Omitted in harness sessions
   * that don't wire memory — onboarding then still runs, just doesn't persist.
   */
  memory?: OnboardingMemory;
  /**
   * Read the user's one-line answer (the question is already printed by the
   * intro, so this just captures a line). Injectable for tests. Default: a
   * transient readline on `input` — but ONLY when `input.isTTY`; otherwise
   * returns null immediately so onboarding never blocks on a non-interactive
   * stdin.
   */
  readAnswer?: () => Promise<string | null>;
}

/** True when the onboarding marker exists (already onboarded). */
export async function isOnboardingShown(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<boolean> {
  try {
    await fsImpl.access(markerPath(paths));
    return true;
  } catch {
    return false;
  }
}

/** USER.md empty or missing → the user has no stored profile yet. */
async function isUserProfileEmpty(paths: AidenPaths, _fsImpl: typeof fs = fs): Promise<boolean> {
  try {
    const txt = await readMemoryFile(paths.userMd);   // ENOENT → '' via the doorway
    return txt.trim().length === 0;
  } catch {
    return true;   // unreadable = treat as empty profile
  }
}

/**
 * Onboard ONLY a brand-new user: marker absent AND USER.md empty. Never
 * re-onboards (marker present) and never onboards a user who already has a
 * profile (non-empty USER.md).
 */
export async function shouldOnboard(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<boolean> {
  if (await isOnboardingShown(paths, fsImpl)) return false;
  return isUserProfileEmpty(paths, fsImpl);
}

/** Write the marker so onboarding fires exactly once. Best-effort. */
export async function markOnboardingShown(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<void> {
  try {
    await fsImpl.mkdir(paths.root, { recursive: true });
    await fsImpl.writeFile(markerPath(paths), new Date().toISOString() + '\n', { encoding: 'utf8' });
  } catch {
    // best-effort — a missed write only means the intro may show once more.
  }
}

// ── name capture ─────────────────────────────────────────────────────────────

/**
 * Extract a clean call-name from a free-form answer. Strips common lead-ins
 * ("I'm", "my name is", "call me"…) and surrounding quotes/punctuation, caps
 * the length. Returns null when nothing usable remains (empty / skipped).
 */
export function normalizeOnboardingName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/[\r\n]+/g, ' ').trim();
  s = s.replace(/^(?:i['’]?m|i am|my name is|call me|it['’]?s|this is|name['’]?s)\s+/i, '').trim();
  s = s.replace(/^["'`]+/, '').replace(/["'`.,!?]+$/, '').trim();
  if (!s) return null;
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX).trim();
  return s || null;
}

/** The stored name line. Single source of truth for the write AND the read. */
export function onboardingNameEntry(name: string): string {
  return `User's name is ${name}. (source: onboarding)`;
}

/** Parse the stored call-name back out of USER.md content. null if absent. */
export function parseUserName(userMdContent: string): string | null {
  const m = /User's name is\s+(.+?)\s*\.\s*(?:\(source:[^)]*\))?/i.exec(userMdContent);
  if (!m) return null;
  const name = m[1].trim();
  return name.length > 0 ? name : null;
}

/** Read the stored user name from USER.md. Never throws; null when unset. */
export async function readUserName(userMdPath: string, _fsImpl: typeof fs = fs): Promise<string | null> {
  try {
    return parseUserName(await readMemoryFile(userMdPath));   // UTF-8 doorway
  } catch {
    return null;
  }
}

/**
 * Default one-line reader: a transient readline on `input`, used ONLY when
 * `input.isTTY`. On a non-interactive stdin (piped / daemon / test) it returns
 * null immediately — the no-hang guarantee. The interface is closed on every
 * path so stdin is left clean for the REPL that starts afterwards.
 */
function defaultReadAnswer(
  input: NodeJS.ReadStream,
  out:   NodeJS.WriteStream,
): () => Promise<string | null> {
  return async () => {
    if (!input.isTTY) return null;
    const rl = createInterface({ input, output: out });
    try {
      // The question is already on screen (written by the intro); read a line
      // with an empty prompt so readline doesn't re-print anything.
      return await rl.question('');
    } catch {
      return null;
    } finally {
      rl.close();
    }
  };
}

/**
 * Aiden speaks first for a brand-new user: a calm intro + ONE question (the
 * name), stored to USER.md. Returns true when the intro was shown (so the
 * caller skips the /walkthrough tip AND the boot greeter — the intro owns the
 * first screen). Idempotent + guarded: shows at most once, never for an
 * existing user, never on a non-TTY caller.
 */
export async function renderOnboardingIntro(opts: OnboardingOptions): Promise<boolean> {
  const out    = opts.out    ?? process.stdout;
  const write  = opts.write  ?? ((text: string) => { out.write(text); });
  const style  = opts.style  ?? { accent: c.accent, muted: c.muted };
  const fsImpl = opts.fsImpl ?? fs;
  const input  = opts.input  ?? process.stdin;
  if (!out.isTTY) return false;
  if (!(await shouldOnboard(opts.paths, fsImpl))) return false;

  // Calm-and-capable, warm edge. Local-first framing; no feelings/intimacy.
  // One question only — just the name. Light, optional. The question is
  // written HERE (not by the reader) so it's always on screen, whichever
  // reader captures the line.
  write(
    '\n' +
    `  ${style.accent("Hi — I'm Aiden.")} ` +
    `${style.muted("I run right here on your machine, and I'll remember what matters as we work.")}\n\n` +
    '  What should I call you? ',
  );

  const read = opts.readAnswer ?? defaultReadAnswer(input, out);
  let name: string | null = null;
  try {
    name = normalizeOnboardingName(await read());
  } catch {
    name = null;   // reader fault → graceful no-name
  }
  write('\n');   // close the question line before the acknowledgement

  // Mark shown BEFORE the store so a store failure can never trigger a re-ask.
  await markOnboardingShown(opts.paths, fsImpl);

  if (name && opts.memory) {
    let stored = false;
    try {
      // The user gave their name → highest-trust provenance.
      stored = (await opts.memory.add('user', onboardingNameEntry(name), 'said')).ok === true;
    } catch {
      stored = false;   // store best-effort; never crash boot
    }
    write(
      stored
        ? `  ${style.muted(`Good to meet you, ${name}. I'll remember that.`)}\n\n`
        : `  ${style.muted(`Good to meet you, ${name}.`)}\n\n`,
    );
  } else {
    // Skipped / empty / non-interactive → graceful, no store, never re-asks.
    write(`  ${style.muted("No problem — just say the word when you're ready.")}\n\n`);
  }
  return true;
}

/** Test/debug — remove the marker so onboarding can fire again. */
export async function resetOnboarding(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<boolean> {
  try {
    await fsImpl.unlink(markerPath(paths));
    return true;
  } catch {
    return false;
  }
}
