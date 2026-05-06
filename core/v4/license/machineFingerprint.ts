/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/license/machineFingerprint.ts — Aiden v4.0.0 (Phase 20)
 *
 * Deterministic, anonymised machine identifier used to bind a Pro license
 * to one host. The Cloudflare worker stores `(licenseKey, machineId)` pairs
 * to enforce per-key seat counts; `/license deactivate` releases the seat.
 *
 * Design (mirrors `tokenStore.deriveKey()` so a single host has a single
 * stable identity across the auth + license subsystems):
 *
 *   identity = hostname() + ':' + username + ':' + platform + ':' + cpuCount
 *   machineId = sha256(salt + identity)  — first 32 hex chars
 *
 * The salt is a fixed compile-time constant. It does NOT need to be secret;
 * its job is to make the hash domain-distinct from any other subsystem that
 * might hash the same identity string in the future.
 *
 * Override: `AIDEN_MACHINE_KEY` env var. When set, used verbatim as the
 * pre-hash identity string. Used by tests for determinism and by power
 * users who want to share a license across a dev VM and host (e.g. WSL
 * → Windows). The Pro license terms allow this — it counts as one seat.
 *
 * Hermes reference: none. Hermes has no license subsystem. Aiden v3 had
 * `core/machineId.ts` that pulled CPU/disk/baseboard serials via wmic;
 * v4 deliberately drops those. Reasoning:
 *
 *  - wmic was deprecated on Windows 11 build 22000+; the v3 PowerShell
 *    fallback adds 1–3 s to boot which is unacceptable for a slash command.
 *  - Hardware serials are PII-adjacent and the v4 audit doc commits to
 *    minimal collection. Hostname/user/platform are sufficient to bind a
 *    license without ever leaving the user's machine in raw form.
 *  - The hash is one-way and salted — even Cloudflare KV only sees a 32-
 *    char hex string with no recovery path.
 */

import os from 'node:os';
import { createHash } from 'node:crypto';

/**
 * Domain-separator salt. Distinct from `tokenStore`'s salt so the same
 * identity string yields different bytes for the two subsystems.
 */
const SALT = 'aiden-v4-license-fingerprint-2026';

/** Pre-hash identity string. Pure, deterministic per machine. */
function identityString(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AIDEN_MACHINE_KEY;
  if (override && override.length > 0) {
    return override;
  }
  return [
    os.hostname(),
    os.userInfo().username,
    process.platform,
    String(os.cpus().length),
  ].join(':');
}

/**
 * Compute the machine fingerprint. Returns a 32-char lower-case hex string.
 *
 * Stable across boots on the same machine. Different on every machine
 * (because hostname differs). Cannot be reversed back to host/user.
 */
export function getMachineFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const id = identityString(env);
  return createHash('sha256').update(SALT + ':' + id).digest('hex').slice(0, 32);
}

/**
 * Human-readable machine name for the license server's UI ("you have a
 * license seat on `Shiva-Desktop`"). Does NOT include the username or any
 * platform-specific identifier — just the hostname.
 */
export function getMachineDisplayName(): string {
  return os.hostname();
}
