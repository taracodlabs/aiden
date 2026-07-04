/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillReadiness.ts — v4.14 Pillar 6 Slice A.
 *
 * "Can this skill even run HERE?" — the precondition gate. There are three
 * meanings of "works": loadable (the loader already proves that), PLAUSIBLE-
 * here (this module), and actually-works (needs execution — a later slice).
 * We do the middle one: a cheap, pure, no-execution, no-network check of a
 * skill's DECLARED preconditions so a skill honestly reports what it needs
 * BEFORE the model tries it and fails at runtime.
 *
 * Three precondition kinds, all declared in SKILL.md frontmatter:
 *   - platform  → if the skill lists `platforms` and this OS isn't one of them,
 *                 it's UNAVAILABLE here (a hard gate — no amount of setup fixes it).
 *   - env       → `metadata.aiden.required_environment_variables` (v4) AND the
 *                 legacy top-level `env_required` (v3, the 6 security skills).
 *                 A missing var → NEEDS_SETUP (the user can fix it).
 *   - binary    → `metadata.aiden.required_binaries` — a CLI the skill shells out
 *                 to (docker, nano-pdf …). Not on PATH → NEEDS_SETUP.
 *
 * Reuses the (previously-dead) env-precondition logic + the platform field the
 * loader already carries; adds only the binary + platform checks + the wiring.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SkillFrontmatter, Platform } from './skillSpec';

export type ReadinessStatus = 'ready' | 'needs_setup' | 'unavailable';
export type ReadinessGapKind = 'env' | 'binary' | 'platform';

export interface ReadinessGap {
  kind: ReadinessGapKind;
  name: string;
  help?: string;
}

export interface SkillReadiness {
  status:  ReadinessStatus;
  missing: ReadinessGap[];
}

/** Environment probe — injectable so the checks are pure + unit-testable. */
export interface ReadinessProbe {
  hasEnv:    (name: string) => boolean;
  hasBinary: (name: string) => boolean;
  platform:  Platform;
}

export function currentPlatform(): Platform {
  return process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos'
    : 'linux';
}

// Memoized: a binary's presence on PATH doesn't change mid-session, and this
// runs on the skills-list path. Cheap file existence checks, no execution.
const binCache = new Map<string, boolean>();

/** True when `name` resolves to an executable on PATH. No spawn — file probe. */
export function binaryOnPath(name: string): boolean {
  const cached = binCache.get(name);
  if (cached !== undefined) return cached;
  const found = probeBinary(name);
  binCache.set(name, found);
  return found;
}

function probeBinary(name: string): boolean {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  const dirs = raw.split(path.delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const already = ext && name.toLowerCase().endsWith(ext.toLowerCase());
      const candidate = path.join(dir, already ? name : name + ext);
      try { if (fs.existsSync(candidate)) return true; } catch { /* unreadable dir */ }
    }
  }
  return false;
}

/** Test seam — clear the PATH memo (never needed in production). */
export function _resetBinaryCache(): void { binCache.clear(); }

function defaultProbe(): ReadinessProbe {
  return { hasEnv: (n) => !!process.env[n], hasBinary: binaryOnPath, platform: currentPlatform() };
}

// ── declared-precondition collectors (shared with skillsConfig) ──────────

/** Required env vars from BOTH the v4 field and the legacy v3 `env_required`. */
export function requiredEnvVars(fm: SkillFrontmatter): Array<{ name: string; help?: string }> {
  const v4 = fm.metadata?.aiden?.required_environment_variables ?? [];
  const v3raw = (fm as { env_required?: unknown }).env_required;
  const byName = new Map<string, { name: string; help?: string }>();
  if (Array.isArray(v3raw)) {
    for (const x of v3raw) if (typeof x === 'string') byName.set(x, { name: x });
  }
  for (const e of v4) byName.set(e.name, { name: e.name, help: e.help ?? e.prompt });
  return [...byName.values()];
}

export function requiredBinaries(fm: SkillFrontmatter): Array<{ name: string; help?: string }> {
  return (fm.metadata?.aiden?.required_binaries ?? []).map((b) => ({ name: b.name, help: b.help }));
}

export function declaredPlatforms(fm: SkillFrontmatter): Platform[] {
  return Array.isArray(fm.platforms) ? fm.platforms : [];
}

/**
 * The readiness verdict. Platform is the hard gate (unavailable); missing
 * env/binary is fixable (needs_setup); otherwise ready. Never runs the skill.
 */
export function computeReadiness(
  fm: SkillFrontmatter,
  probeOverride?: Partial<ReadinessProbe>,
): SkillReadiness {
  const probe: ReadinessProbe = { ...defaultProbe(), ...probeOverride };

  const platforms = declaredPlatforms(fm);
  if (platforms.length > 0 && !platforms.includes(probe.platform)) {
    return {
      status:  'unavailable',
      missing: [{ kind: 'platform', name: probe.platform, help: `declares platforms: ${platforms.join(', ')}` }],
    };
  }

  const missing: ReadinessGap[] = [];
  for (const e of requiredEnvVars(fm)) {
    if (!probe.hasEnv(e.name)) missing.push({ kind: 'env', name: e.name, help: e.help });
  }
  for (const b of requiredBinaries(fm)) {
    if (!probe.hasBinary(b.name)) missing.push({ kind: 'binary', name: b.name, help: b.help });
  }
  return { status: missing.length > 0 ? 'needs_setup' : 'ready', missing };
}

/** One-line human summary of what a non-ready skill needs. */
export function readinessNote(r: SkillReadiness): string | undefined {
  if (r.status === 'ready') return undefined;
  if (r.status === 'unavailable') {
    const p = r.missing.find((m) => m.kind === 'platform');
    return `unavailable here${p?.help ? ` (${p.help})` : ''}`;
  }
  const items = r.missing.map((m) => `${m.kind === 'env' ? '' : `${m.kind} `}${m.name}`).join(', ');
  return `needs setup: ${items}`;
}
