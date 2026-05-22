/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/namespaceRegistry.ts — v4.9.0 Slice 11.
 *
 * Generalizes Aiden's two-file memory model (`memory` + `user`) to a
 * registry. Adds a third default namespace — `project` — keyed off
 * the caller's current working directory. The registry is the single
 * authority every other surface (tool schemas, CLI parser, prompt
 * injector, reviewer, backup) consults; adding a namespace is one
 * registration call instead of an N-place patch.
 *
 * Slice 11 ships THREE default namespaces:
 *
 *   memory   — Aiden environment / project & technical notes.    2200 chars
 *   user     — User identity / preferences / workflow style.     1375 chars
 *   project  — Per-project context at `<projectRoot>/.aiden/PROJECT.md`. 1800 chars
 *
 * The `'memory'` vs `'project'` distinction:
 *   - `memory` is GLOBAL per-install (Aiden-wide notes).
 *   - `project` is PER-DIRECTORY (one PROJECT.md per repo / workdir).
 *
 * Char limit for `project` (1800) sits between `user` (1375) and the
 * legacy `memory` (2200) — project context is verbose but not as
 * verbose as full environment notes.
 */

import path from 'node:path';
import type { AidenPaths } from '../paths';

export interface MemoryNamespace {
  /** Wire-format name used in CLI args, tool args, file references. */
  name: string;
  /** Human-readable label for help text. */
  label: string;
  /** Short description shown in `aiden memory --help` / namespaces. */
  description: string;
  /** Hard char cap per file. */
  charLimit: number;
  /**
   * Resolve the on-disk path. `projectRoot` is consulted only by
   * namespaces with `requiresProject: true`; others ignore it.
   */
  resolve: (paths: AidenPaths, projectRoot?: string | null) => string;
  /** Whether this namespace is loaded into the system prompt by default. */
  injectIntoPrompt: boolean;
  /** Header rendered above the slot when injected (omitted = use label). */
  promptHeader?: string;
  /**
   * When true, `resolve(paths, null)` MUST throw. The CLI catches this
   * and surfaces a helpful "no project root detected" message.
   */
  requiresProject?: boolean;
}

const BUILTIN: MemoryNamespace[] = [
  {
    name:        'memory',
    label:       'Memory (project & environment)',
    description: 'Global notes about Aiden\'s environment + this project.',
    charLimit:   2200,
    injectIntoPrompt: true,
    promptHeader:     'Project & Environment',
    resolve:          (paths) => paths.memoryMd,
  },
  {
    name:        'user',
    label:       'User (identity & preferences)',
    description: 'User identity, preferences, workflow style.',
    charLimit:   1375,
    injectIntoPrompt: true,
    promptHeader:     'User Identity & Preferences',
    resolve:          (paths) => paths.userMd,
  },
  {
    name:        'project',
    label:       'Project (per-repo context)',
    description: 'Per-project context at <projectRoot>/.aiden/PROJECT.md.',
    charLimit:   1800,
    injectIntoPrompt: true,
    promptHeader:     'Current Project Context',
    requiresProject:  true,
    resolve: (_paths, projectRoot) => {
      if (!projectRoot) {
        throw new Error('project namespace requires a project root (run from inside a git repo or directory with .aiden/PROJECT.md)');
      }
      return path.join(projectRoot, '.aiden', 'PROJECT.md');
    },
  },
];

const REGISTRY: Map<string, MemoryNamespace> = new Map(BUILTIN.map((n) => [n.name, n]));

/** Throw-on-unknown getter. Callers MUST check `has()` first if the
 *  name is user-supplied — `getNamespace` is for trusted callsites. */
export function getNamespace(name: string): MemoryNamespace {
  const ns = REGISTRY.get(name);
  if (!ns) {
    const known = Array.from(REGISTRY.keys()).join(', ');
    throw new Error(`unknown memory namespace '${name}' (known: ${known})`);
  }
  return ns;
}

/** Soft check — does this name resolve to a registered namespace. */
export function hasNamespace(name: string): boolean {
  return REGISTRY.has(name);
}

/** Iteration order matches registration order. */
export function listNamespaces(): MemoryNamespace[] {
  return Array.from(REGISTRY.values());
}

/** Names only — for tool schema enums + CLI argument validation. */
export function listNamespaceNames(): string[] {
  return Array.from(REGISTRY.keys());
}

/**
 * Reserved for v4.10+ user-defined namespaces (plugins). Not wired to
 * config.yaml or plugin loaders in this slice; the entry point exists
 * so the runtime can extend without further refactor.
 */
export function registerNamespace(ns: MemoryNamespace): void {
  if (REGISTRY.has(ns.name)) {
    throw new Error(`memory namespace '${ns.name}' is already registered`);
  }
  REGISTRY.set(ns.name, ns);
}

/** Test seam — restore registry to the three built-ins. */
export function _resetNamespacesForTests(): void {
  REGISTRY.clear();
  for (const ns of BUILTIN) REGISTRY.set(ns.name, ns);
}
