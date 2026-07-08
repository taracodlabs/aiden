/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/license/licenseStore.ts — Aiden v4.0.0 (Phase 20)
 *
 * Encrypted on-disk storage for the active Pro license cache. Lives at
 * `<aiden-home>/license/<machine-fingerprint>.json`. The fingerprinted
 * filename means a token store synced between machines (e.g. via Dropbox
 * over `~/.aiden`) doesn't accidentally let machine B use machine A's
 * activated key — each machine reads its own file.
 *
 *   ============================================================
 *   THREAT MODEL — READ THIS BEFORE TRUSTING THE FILE CONTENTS.
 *   ============================================================
 *
 * Same shape as `core/v4/auth/tokenStore.ts`: AES-256-GCM with a key
 * derived from machine identity (`AIDEN_MACHINE_KEY` override accepted).
 * Protects against:
 *
 *   - Casual filesystem inspection — an attacker who can read the file
 *     without code-execution as this user learns nothing.
 *   - Cloud-sync of `~/.aiden` leaking license keys in plaintext.
 *
 * Does NOT protect against:
 *
 *   - Code execution under this user account on this machine. Anything
 *     that can run `node` as this user can call `loadLicense()` and read
 *     the same key out. A real secret boundary would require OS keychain
 *     bindings (DPAPI / Keychain / libsecret), which Aiden does not bundle.
 *
 * Honest framing: this is OBFUSCATION, not PROTECTION. The /license
 * status surface and the audit doc both say so explicitly.
 *
 * `licenseManager.ts` stored license cache as plaintext JSON at
 * `workspace/license.json`. v4 upgrades that to machine-bound encryption
 * for parity with `tokenStore` and so users on shared machines (corporate
 * VDI, family computers) don't expose their key in `~/.aiden`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

import type { AidenPaths } from '../paths';
import { getMachineFingerprint } from './machineFingerprint';

/** Persisted license cache. Shape mirrors v3 `ProLicenseCache`. */
export interface LicenseCache {
  /** The Pro license key (e.g. `AIDEN-PRO-XXXXX-XXXXX-XXXXX`). */
  key: string;
  /** True if last server response said the key is valid. */
  valid: boolean;
  /** Plan id from the worker (`pro_monthly`, `pro_yearly`, `pro_lifetime`). */
  plan: string;
  /** ISO 8601 expiry, or empty string for lifetime keys. */
  expiresAt: string;
  /**
   * Per-feature flags from the worker. Free tier returns an empty object;
   * Pro returns `{ multi_tool_approval: true, silent_oauth_refresh: true,
   * custom_personalities: true, ... }`. Open-ended so the worker can ship
   * new gates without an Aiden release.
   */
  features: Record<string, boolean | number>;
  /** Epoch ms of last successful server validation. */
  lastVerified: number;
}

interface OnDiskShape {
  version: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
}

const FORMAT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT = Buffer.from('aiden-v4-license-store-salt-2026', 'utf8');

/**
 * Derive the AES key from machine identity. Same construction as
 * `tokenStore.deriveKey()` but with a different salt, so a leaked
 * tokenStore key (somehow) doesn't give plaintext access to licenses.
 */
function deriveKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const override = env.AIDEN_MACHINE_KEY;
  const ident = override && override.length > 0 ? override : getMachineFingerprint(env);
  return scryptSync(ident, SCRYPT_SALT, SCRYPT_KEYLEN);
}

function licenseDir(paths: AidenPaths): string {
  return path.join(paths.root, 'license');
}

function licenseFile(paths: AidenPaths, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(licenseDir(paths), `${getMachineFingerprint(env)}.json`);
}

function encrypt(plain: string, env: NodeJS.ProcessEnv = process.env): OnDiskShape {
  const key = deriveKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    version: FORMAT_VERSION,
    iv: iv.toString('hex'),
    ciphertext: enc.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

function decrypt(record: OnDiskShape, env: NodeJS.ProcessEnv = process.env): string {
  if (record.version !== FORMAT_VERSION) {
    throw new Error(
      `licenseStore: unknown format version ${record.version} (expected ${FORMAT_VERSION})`,
    );
  }
  const key = deriveKey(env);
  const iv = Buffer.from(record.iv, 'hex');
  const ciphertext = Buffer.from(record.ciphertext, 'hex');
  const authTag = Buffer.from(record.authTag, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

/** Persist the license cache. POSIX mode 0600 on non-Windows. */
export async function saveLicense(
  paths: AidenPaths,
  cache: LicenseCache,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = licenseDir(paths);
  await fs.mkdir(dir, { recursive: true });
  const record = encrypt(JSON.stringify(cache), env);
  const file = licenseFile(paths, env);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o600).catch(() => undefined);
  }
}

/**
 * Load the license cache. Returns null on missing file or any read/decrypt
 * failure (treat as "free tier"). Decrypt failure on a present file is a
 * real problem — surface via `onError` so /license and /doctor can show it.
 */
export async function loadLicense(
  paths: AidenPaths,
  opts: { onError?: (msg: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<LicenseCache | null> {
  const env = opts.env ?? process.env;
  const file = licenseFile(paths, env);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let record: OnDiskShape;
  try {
    record = JSON.parse(text) as OnDiskShape;
  } catch {
    opts.onError?.(`licenseStore: cache is not JSON at ${file}`);
    return null;
  }
  let plaintext: string;
  try {
    plaintext = decrypt(record, env);
  } catch (err) {
    opts.onError?.(
      `licenseStore: decrypt failed (${(err as Error).message}). ` +
        `Likely cause: cache copied from another machine, or AIDEN_MACHINE_KEY changed. ` +
        `Run /license activate <key> to re-bind.`,
    );
    return null;
  }
  try {
    return JSON.parse(plaintext) as LicenseCache;
  } catch {
    opts.onError?.(`licenseStore: payload is not valid JSON at ${file}`);
    return null;
  }
}

/** Delete the license cache file (used by /license deactivate). */
export async function clearLicense(
  paths: AidenPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await fs.rm(licenseFile(paths, env), { force: true });
}

/** True if a license file exists on disk (regardless of validity). */
export async function hasLicense(
  paths: AidenPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await fs.access(licenseFile(paths, env));
    return true;
  } catch {
    return false;
  }
}

/** Path to the cache file — used by /doctor and /license status. */
export function getLicenseFilePath(
  paths: AidenPaths,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return licenseFile(paths, env);
}
