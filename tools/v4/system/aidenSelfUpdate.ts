/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/aidenSelfUpdate.ts — Phase v4.1.2-update.
 *
 * Natural-language entry point for self-update. When the user asks
 * Aiden to update / install latest / upgrade itself, the model calls
 * this tool. Routes to the same shared executor (`executeInstall`)
 * that `/update install` uses — single source of truth for install
 * behavior.
 *
 * Two-step confirmation contract (consent gate):
 *   1. First call with `confirm: false` — returns status + a prompt
 *      asking the user to confirm. NEVER spawns.
 *   2. Model surfaces the prompt to the user; waits for explicit
 *      agreement ("yes update", "go ahead", "do it").
 *   3. Second call with `confirm: true` — only after explicit user
 *      agreement; spawns the install.
 *
 * The contract is enforced via tool DESCRIPTION (model-facing rule).
 * Tool-side, we don't track "did the user actually consent" — that
 * needs a runtime approval object (request_id + fresh-confirmation
 * verification) which is a v4.2+ design. For v4.1.2 the description
 * carries the rule and the tool trusts the model to follow it.
 *
 * Acceptable risk: failure mode of a misbehaving model is "user gets
 * an unwanted install they have to /quit to apply" — not data loss.
 * Phase D's promotion path is the more sensitive consent surface and
 * is user-driven UI.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { VERSION as INSTALLED_VERSION } from '../../../core/version';
import { checkForUpdate } from '../../../core/v4/update/checkUpdate';
import { executeInstall } from '../../../core/v4/update/executeInstall';

export const aidenSelfUpdateTool: ToolHandler = {
  schema: {
    name: 'aiden_self_update',
    description:
      'Update Aiden to the latest version via npm install -g aiden-runtime@latest. ' +
      'TWO-STEP CONFIRMATION REQUIRED: first call with confirm:false to check status ' +
      'and surface to the user; only call with confirm:true AFTER the user explicitly ' +
      'agrees in their next message ("yes update", "go ahead", "do it"). NEVER call ' +
      'with confirm:true autonomously. ' +
      'Call this tool ONLY when the user explicitly asks Aiden to update / install ' +
      'latest / upgrade itself. Example user phrases that warrant a call: ' +
      '"update yourself", "can you install the latest version?", "upgrade to the latest", ' +
      '"self-update". DO NOT call when: user asks about update status without requesting ' +
      'action ("are there updates?") — for status queries, just answer from your context; ' +
      'user mentions updates of OTHER software ("update VSCode"); user has not explicitly ' +
      'asked Aiden to update itself.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description:
            'False on first call (status check, no install). True on second call AFTER ' +
            'the user explicitly agreed to proceed in their last message.',
        },
      },
      required: ['confirm'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'system',
  async execute(args, ctx) {
    if (!ctx.paths) {
      return {
        success: false,
        error:   'aiden_self_update needs Aiden user-data paths — not configured in this context.',
      };
    }
    const confirm = args.confirm === true;

    // Status probe — bypass the 6h boot cache for user-initiated checks.
    const status = await checkForUpdate({
      paths:            ctx.paths,
      installedVersion: INSTALLED_VERSION,
      cacheTtlMs:       0,
    });

    // ── First call: confirm:false → status + prompt. NEVER spawn. ─────
    if (!confirm) {
      if (status.latest === null) {
        return {
          success: true,
          stage:   'status',
          message:
            "Couldn't check for updates (registry unreachable). " +
            'Try again in a moment, or run `npm install -g aiden-runtime@latest` manually.',
          installed: status.installed,
          latest:    null,
          updateAvailable: false,
        };
      }
      if (!status.updateAvailable) {
        return {
          success: true,
          stage:   'status',
          message: `You're on the latest version (v${status.installed}). Nothing to update.`,
          installed:       status.installed,
          latest:          status.latest,
          updateAvailable: false,
        };
      }
      return {
        success: true,
        stage:   'status',
        message:
          `Update available: v${status.installed} → v${status.latest}. ` +
          `Confirm by saying "yes update" or "go ahead". This runs ` +
          `\`npm install -g aiden-runtime@latest\` and you'll need to ` +
          `restart Aiden after.`,
        installed:       status.installed,
        latest:          status.latest,
        updateAvailable: true,
      };
    }

    // ── Second call: confirm:true → install. ────────────────────────
    if (status.latest === null) {
      return {
        success: false,
        stage:   'install',
        error:
          "Can't install — registry unreachable. " +
          'Try again or run `npm install -g aiden-runtime@latest` manually.',
        installed: status.installed,
      };
    }
    if (!status.updateAvailable) {
      return {
        success: true,
        stage:   'install',
        message: `Already on v${status.installed}. Nothing to install.`,
        installed:       status.installed,
        latest:          status.latest,
        updateAvailable: false,
      };
    }

    const result = await executeInstall();
    if (result.success) {
      const v = result.installedVersion ?? status.latest;
      return {
        success: true,
        stage:   'install',
        message:
          `✓ aiden-runtime v${v} installed. Restart Aiden to apply: ` +
          `type /quit then re-run \`aiden\`.`,
        installed:    status.installed,
        installedVersion: v,
      };
    }
    return {
      success: false,
      stage:   'install',
      error:   result.error ?? 'Install failed (no error message).',
      installed:  status.installed,
      latestSeen: status.latest,
      // Keep stdout/stderr off the model-visible response to avoid
      // prompt bloat; user-actionable copy-paste is already in error.
    };
  },
};
