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
import { inspectUpdateInstall } from '../../../core/v4/update/installPreflight';

export const aidenSelfUpdateTool: ToolHandler = {
  schema: {
    name: 'aiden_self_update',
    description:
      'Update Aiden through its verified installation method. ' +
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
  riskTier: 'dangerous',   // v4.4 Phase 1
  // v4.4 Phase 4 — dry-run refuses; self-update bootstrapping is not
  // safe to model with a no-op preview.
  buildPreview(args) {
    return {
      tool: 'aiden_self_update',
      args,
      riskTier: 'dangerous',
      sideEffects: [{
        type: 'refuse',
        reason: 'aiden_self_update is not safe to preview in dry-run mode. Set AIDEN_DRYRUN=0 to perform a real self-update (with the usual approval-engine confirmation).',
      }],
      detectedRisks: ['self_update'],
      summary: 'Refused: aiden_self_update cannot be previewed in dry-run mode',
    };
  },
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
          'Confirm by saying "yes update" or "go ahead". Aiden will first ' +
          'verify the active installation target and its writability.',
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

    const plan = await inspectUpdateInstall({ targetVersion: status.latest });
    if (!plan.installAllowed) {
      return {
        success: false,
        stage: 'preflight',
        error: plan.guidance.join('\n'),
        installed: status.installed,
        latestSeen: status.latest,
        provenance: plan.provenance,
      };
    }
    const result = await executeInstall({
      targetVersion: status.latest,
      plan,
      updateStateDir: ctx.paths.root,
    });
    if (result.success) {
      if (result.scheduled) {
        return {
          success: true,
          stage: 'prepared',
          message:
            `Update ${status.latest} is prepared. Type /quit so Windows can replace ` +
            'the running package, then re-run `aiden`.',
          installed: status.installed,
          targetVersion: status.latest,
        };
      }
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
