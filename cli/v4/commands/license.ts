/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/license.ts — Aiden v4.0.0 (Phase 20)
 *
 * `/license [status|activate|deactivate|refresh] [key]`
 *
 * Subcommands:
 *   status              — current tier (Free / Pro), plan, expiry, machine
 *                         fingerprint, cache file path. Default with no args.
 *   activate <key>      — POST /license/activate. On success, write cache.
 *                         On failure, surface server error verbatim.
 *   deactivate          — POST /license/deactivate, then clear local cache.
 *                         Always clears the local file even if the server
 *                         is unreachable so the user can move machines.
 *   refresh             — POST /license/verify (bypassing the 24h cache).
 *                         Useful after the user changes plans on the web.
 *
 * Honest framing throughout:
 *   - Free tier never tells the user they're "missing" anything; it lists
 *     what Pro adds and the upgrade URL once.
 *   - Activation errors quote the server response; we don't pretend the
 *     network came back when it didn't.
 *   - The machine-bound cache is described as obfuscation, not protection
 *     (same threat-model framing as /auth status from Phase 18).
 */

import type { SlashCommand } from '../commandRegistry';
import {
  LicenseClient,
  isWellFormedKey,
  getMachineFingerprint,
  getMachineDisplayName,
  getLicenseFilePath,
  type LicenseCache,
} from '../../../core/v4/license';
import { FEATURE_FLAGS } from '../../../core/v4/license/featureGate';

const UPGRADE_URL = 'https://aiden.taracod.com/pro';

/** "in 47 days" / "expired 3 hours ago". Pure. */
function relativeTime(targetMs: number, nowMs = Date.now()): string {
  const delta = targetMs - nowMs;
  const abs = Math.abs(delta);
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  let unit: string;
  let value: number;
  if (day > 0) {
    unit = day === 1 ? 'day' : 'days';
    value = day;
  } else if (hr > 0) {
    unit = hr === 1 ? 'hour' : 'hours';
    value = hr;
  } else if (min > 0) {
    unit = min === 1 ? 'minute' : 'minutes';
    value = min;
  } else {
    unit = sec === 1 ? 'second' : 'seconds';
    value = sec;
  }
  return delta >= 0 ? `in ${value} ${unit}` : `${value} ${unit} ago`;
}

function maskKey(key: string): string {
  // AIDEN-PRO-XXXXX-XXXXX-XXXXX → AIDEN-PRO-XXXXX-•••••-•••••
  const parts = key.split('-');
  if (parts.length !== 5) return key.slice(0, 12) + '...';
  return [parts[0], parts[1], parts[2], '•••••', '•••••'].join('-');
}

function renderProStatus(
  ctx: import('../commandRegistry').SlashCommandContext,
  cache: LicenseCache,
  cached: boolean,
  offline?: boolean,
): void {
  ctx.display.success(`Pro license active`);
  ctx.display.write(`  plan         : ${cache.plan}\n`);
  ctx.display.write(`  key          : ${maskKey(cache.key)}\n`);
  if (cache.expiresAt) {
    const t = Date.parse(cache.expiresAt);
    if (!Number.isNaN(t)) {
      ctx.display.write(
        `  expires      : ${cache.expiresAt} (${relativeTime(t)})\n`,
      );
    } else {
      ctx.display.write(`  expires      : ${cache.expiresAt}\n`);
    }
  } else {
    ctx.display.write(`  expires      : lifetime\n`);
  }
  const features = Object.keys(cache.features).filter(
    (k) => cache.features[k] === true || (typeof cache.features[k] === 'number' && (cache.features[k] as number) > 0),
  );
  ctx.display.write(
    `  features     : ${features.length > 0 ? features.join(', ') : '(default Pro feature set)'}\n`,
  );
  ctx.display.write(`  machine      : ${getMachineDisplayName()} (${getMachineFingerprint()})\n`);
  if (cached) {
    const ageMin = Math.max(0, Math.round((Date.now() - cache.lastVerified) / 60000));
    const tag = offline ? 'offline grace' : 'cache';
    ctx.display.dim(`  last verified ${ageMin} min ago (${tag} — run /license refresh to re-check now)`);
  }
}

function renderFreeStatus(ctx: import('../commandRegistry').SlashCommandContext): void {
  ctx.display.info('Free tier — no license active');
  ctx.display.write(`  machine      : ${getMachineDisplayName()} (${getMachineFingerprint()})\n`);
  ctx.display.write('\n');
  ctx.display.dim('Pro tier adds:');
  ctx.display.dim(`  • ${FEATURE_FLAGS.MULTI_TOOL_APPROVAL.replace(/_/g, ' ')} — single prompt for tool sequences`);
  ctx.display.dim(`  • ${FEATURE_FLAGS.SILENT_OAUTH_REFRESH.replace(/_/g, ' ')} — no /auth refresh interruptions`);
  ctx.display.dim(`  • ${FEATURE_FLAGS.CUSTOM_PERSONALITIES.replace(/_/g, ' ')} — install user-authored personalities`);
  ctx.display.dim(`  • Priority support email contact`);
  ctx.display.write('\n');
  ctx.display.dim(`Run \`/license activate <key>\` after purchasing at ${UPGRADE_URL}.`);
}

export const license: SlashCommand = {
  name: 'license',
  description: 'Manage Aiden Pro license activation and verification.',
  category: 'system',
  icon: '🪪',
  handler: async (ctx) => {
    if (!ctx.paths) {
      ctx.display.warn('License paths not wired (boot may still be in progress).');
      return {};
    }
    const sub = (ctx.args[0] ?? 'status').toLowerCase();
    const client = new LicenseClient({ paths: ctx.paths });

    // ── status ──────────────────────────────────────────────────
    if (sub === 'status') {
      const status = await client.statusFromCache();
      ctx.display.info('Aiden license status');
      if (status.tier === 'pro') {
        renderProStatus(ctx, status.cache, true);
      } else {
        renderFreeStatus(ctx);
      }
      ctx.display.write('\n');
      ctx.display.dim(
        `Cache file: ${getLicenseFilePath(ctx.paths)} (encrypted with machine-derived key — obfuscation, not protection).`,
      );
      return {};
    }

    // ── activate ────────────────────────────────────────────────
    if (sub === 'activate') {
      const rawKey = ctx.args[1];
      if (!rawKey) {
        ctx.display.printError(
          'Usage: /license activate <key>',
          'Get a key at https://aiden.taracod.com/pro',
        );
        return {};
      }
      if (!isWellFormedKey(rawKey)) {
        ctx.display.printError(
          'Key format invalid. Expected AIDEN-PRO-XXXXX-XXXXX-XXXXX (uppercase letters and digits).',
        );
        return {};
      }
      ctx.display.info('Contacting license server...');
      const r = await client.activate(rawKey);
      if (r.ok !== true) {
        ctx.display.printError(`Activation failed: ${r.error}`);
        return {};
      }
      renderProStatus(ctx, r.cache, false);
      ctx.display.success(
        `License bound to this machine (${getMachineDisplayName()}). ` +
          `Run /license deactivate to free this seat for another machine.`,
      );
      return {};
    }

    // ── deactivate ──────────────────────────────────────────────
    if (sub === 'deactivate') {
      const before = await client.statusFromCache();
      if (before.tier !== 'pro') {
        ctx.display.dim('No active license to deactivate.');
        return {};
      }
      ctx.display.info('Deactivating this machine...');
      const r = await client.deactivate();
      if (r.error) {
        ctx.display.warn(
          `Server did not confirm deactivation: ${r.error}. Local cache cleared anyway — the seat will be reclaimed on the next server-side audit.`,
        );
      } else {
        ctx.display.success('License deactivated. The seat is now free for another machine.');
      }
      return {};
    }

    // ── refresh ─────────────────────────────────────────────────
    if (sub === 'refresh') {
      ctx.display.info('Re-verifying license against server...');
      const r = await client.verify();
      if (r.tier === 'pro') {
        if (r.cached && !r.offline) {
          ctx.display.dim('Cache still fresh — no server round-trip needed.');
        }
        renderProStatus(ctx, r.cache, r.cached, r.offline);
      } else {
        ctx.display.warn(
          'License is no longer valid (server rejected, expired, or revoked). Now on Free tier.',
        );
      }
      return {};
    }

    ctx.display.printError(
      `Unknown subcommand: ${sub}`,
      'Try: /license status | activate <key> | deactivate | refresh',
    );
    return {};
  },
};
