/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/plugins/pluginBootCard.ts — Aiden v4.0.0 (Phase 17 Task 5)
 *
 * Formats the [plugins] boot summary that aidenCLI prints right after
 * `pluginLoader.discoverAndLoad()`. Pure function — caller renders.
 *
 * Three states the card has to communicate:
 *
 *   all loaded             → single green line "[plugins] N loaded"
 *   any pending grant      → multi-line yellow with /plugins grant hints
 *   any suspended          → multi-line red with re-grant hints
 *
 * Per Phase 17 spec note 1: keep it minimal when everything is fine,
 * expand only when remediation is needed.
 */

import type { LoadedPlugin } from './pluginRegistry';

export type BootCardSeverity = 'green' | 'yellow' | 'red';

export interface BootCardLine {
  severity: BootCardSeverity | 'dim';
  text: string;
}

export interface BootCardResult {
  lines: BootCardLine[];
  /** Convenience: the summary's first-line severity for the caller's color choice. */
  severity: BootCardSeverity;
}

/**
 * Build the boot card from the loader's registry list. Empty list ⇒
 * single green "0 loaded" line.
 */
export function formatPluginBootCard(plugins: ReadonlyArray<LoadedPlugin>): BootCardResult {
  const counts = {
    loaded: 0,
    pendingGrant: 0,
    suspended: 0,
    error: 0,
  };
  const pendingNames: LoadedPlugin[] = [];
  const suspendedNames: LoadedPlugin[] = [];
  const erroredNames: LoadedPlugin[] = [];

  for (const p of plugins) {
    switch (p.status) {
      case 'loaded':
      case 'activated':
        counts.loaded++;
        break;
      case 'pending-grant':
        counts.pendingGrant++;
        pendingNames.push(p);
        break;
      case 'suspended':
        counts.suspended++;
        suspendedNames.push(p);
        break;
      case 'error':
        counts.error++;
        erroredNames.push(p);
        break;
      default:
        break;
    }
  }

  // ── Happy path: every discovered plugin is loaded ──────────────────
  if (counts.pendingGrant === 0 && counts.suspended === 0 && counts.error === 0) {
    return {
      severity: 'green',
      lines: [
        {
          severity: 'green',
          text: `[plugins] ${counts.loaded} loaded`,
        },
      ],
    };
  }

  // ── Multi-line surface ──────────────────────────────────────────────
  const lines: BootCardLine[] = [];
  const summarySeverity: BootCardSeverity = counts.suspended > 0 ? 'red' : 'yellow';
  lines.push({
    severity: summarySeverity,
    text: `[plugins] ${counts.loaded} loaded · ${counts.pendingGrant} pending grant · ${counts.suspended} suspended`,
  });

  for (const p of pendingNames) {
    const tools = p.contributions.tools;
    const toolsText = tools.length > 0 ? ` to enable ${tools.join(', ')}` : '';
    lines.push({
      severity: 'dim',
      text: `  → run /plugins grant ${p.manifest.name}${toolsText}`,
    });
  }
  for (const p of suspendedNames) {
    const missing = p.missingPermissions ?? [];
    const missingText = missing.length > 0 ? ` (new perms: ${missing.join(', ')})` : '';
    lines.push({
      severity: 'dim',
      text: `  → run /plugins grant ${p.manifest.name}${missingText}`,
    });
  }
  for (const p of erroredNames) {
    lines.push({
      severity: 'dim',
      text: `  ! ${p.manifest.name}: ${p.error ?? 'unknown error'}`,
    });
  }

  return { severity: summarySeverity, lines };
}
