/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/auth/tokenStore.ts — Aiden v4.0.0 (Phase 18)
 *
 * Per-provider OAuth bearer-token storage at <aiden-home>/auth/<provider>.json.
 * Used by the Claude Pro and ChatGPT Plus plugins; new providers can adopt
 * by writing their tokens through this module.
 *
 *   ============================================================
 *   THREAT MODEL — READ THIS BEFORE TRUSTING THE FILE CONTENTS.
 *   ============================================================
 *
 * Tokens are encrypted with a key derived from the machine identity
 * (host + user + fixed salt). This protects against:
 *
 *   - Casual filesystem inspection (an attacker who reads the file
 *     without code-execution on this user's account learns nothing).
 *   - Cloud-sync of the user's home directory leaking plaintext tokens
 *     (the encrypted blob is host-bound and won't decrypt on another
 *     machine).
 *
 * It does NOT protect against:
 *
 *   - Code execution under the same user account on this machine.
 *     Any process that can run `node` as this user can call into this
 *     module and read the same key out. There is no OS-level secret
 *     boundary — that requires Windows DPAPI / macOS Keychain / Linux
 *     libsecret bindings (a native module like `keytar` or
 *     `node-windows-dpapi`), which Aiden does not currently bundle.
 *
 * Honest framing: this is OBFUSCATION, not PROTECTION. The /auth status
 * surface and the audit doc both say so explicitly. Users deserve to
 * know what they're getting.
 *
 * encryption at all. v4.0's machine-bound encryption is a deliberate
 * step up from prior-art CLIs; v4.1's keychain integration brings it
 * to parity with keychain-backed CLI credential stores.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';

import type { AidenPaths } from '../paths';

/**
 * Persisted token shape. `expiresAtMs` is epoch milliseconds.
 *
 * `provider` is redundant with the file name but kept for sanity-checking
 * mismatches (a user copying files between profiles).
 */
export interface OAuthTokens {
  /** Provider id (e.g. 'chatgpt-plus'). */
  provider: string;
  /** Bearer token sent on each inference request. */
  accessToken: string;
  /** Refresh token, if the provider issued one. Null when expired-only. */
  refreshToken?: string | null;
  /** Epoch ms when accessToken expires. Required for the pre-flight refresh window. */
  expiresAtMs: number;
  /** Optional account email / display name from the userinfo endpoint. */
  account?: string;
  /** Optional model whitelist surfaced by the provider (e.g. ['opus','sonnet']). */
  models?: string[];
  /** Provider-specific extras (base URL overrides, etc.). */
  extras?: Record<string, unknown>;
  /** ISO 8601 string of the last successful write — diagnostic only. */
  savedAt?: string;
}

interface OnDiskShape {
  version: 1;
  iv: string; // hex
  ciphertext: string; // hex
  authTag: string; // hex
}

const FORMAT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const SCRYPT_KEYLEN = 32;
/**
 * Fixed salt — does NOT need to be secret. Acts as a domain separator so
 * keys derived for the token store don't collide with any future Aiden
 * subsystem deriving from the same `host:user` pair (e.g. session DB).
 */
const SCRYPT_SALT = Buffer.from('aiden-v4-tokenstore-salt-2026', 'utf8');

/**
 * Derive a 32-byte AES key from the machine identity. Pure function —
 * the same machine + user always produces the same key, so a copy of the
 * encrypted blob to another machine fails to decrypt.
 *
 * The `AIDEN_TOKEN_KEY` env var, when set, overrides the host/user inputs
 * — used by tests for deterministic round-trips and by power users who
 * want to share a token store across machines (e.g. dev VM + host).
 */
function deriveKey(): Buffer {
  const override = process.env.AIDEN_TOKEN_KEY;
  if (override && override.length > 0) {
    return scryptSync(override, SCRYPT_SALT, SCRYPT_KEYLEN);
  }
  const ident =
    `${os.hostname()}::${os.userInfo().username}::${process.platform}`;
  return scryptSync(ident, SCRYPT_SALT, SCRYPT_KEYLEN);
}

function authDir(paths: AidenPaths): string {
  return path.join(paths.root, 'auth');
}

function tokenFile(paths: AidenPaths, provider: string): string {
  // Sanitise provider id so a malicious manifest can't escape the auth dir.
  const safe = provider.replace(/[^a-z0-9-_]/gi, '_');
  return path.join(authDir(paths), `${safe}.json`);
}

/** Produce the encrypted on-disk record for a token bundle. */
function encrypt(plain: string): OnDiskShape {
  const key = deriveKey();
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

/** Decrypt; throws on integrity-check failure or wrong machine key. */
function decrypt(record: OnDiskShape): string {
  if (record.version !== FORMAT_VERSION) {
    throw new Error(
      `tokenStore: unknown format version ${record.version} (expected ${FORMAT_VERSION})`,
    );
  }
  const key = deriveKey();
  const iv = Buffer.from(record.iv, 'hex');
  const ciphertext = Buffer.from(record.ciphertext, 'hex');
  const authTag = Buffer.from(record.authTag, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Persist tokens for a provider. Overwrites any existing file. POSIX
 * mode is set to 0600 after write so other local users can't read it
 * even before the encryption layer. On Windows we rely on user-profile
 * ACLs (and the encryption).
 */
export async function saveTokens(
  paths: AidenPaths,
  tokens: OAuthTokens,
): Promise<void> {
  const dir = authDir(paths);
  await fs.mkdir(dir, { recursive: true });

  const stamped: OAuthTokens = {
    ...tokens,
    savedAt: new Date().toISOString(),
  };
  const plaintext = JSON.stringify(stamped);
  const record = encrypt(plaintext);

  const file = tokenFile(paths, tokens.provider);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o600).catch(() => undefined);
  }
}

/**
 * Read tokens for a provider. Returns null on missing file or any
 * error during read/decrypt — callers treat that as "not authed".
 *
 * A decrypt failure on a present file is a real problem (file corrupted,
 * key changed, sync from another machine). We log the reason via the
 * optional `onError` callback so /auth and the boot path can surface it.
 */
export async function loadTokens(
  paths: AidenPaths,
  provider: string,
  opts: { onError?: (msg: string) => void } = {},
): Promise<OAuthTokens | null> {
  const file = tokenFile(paths, provider);
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
    opts.onError?.(`tokenStore: ${provider} record is not JSON`);
    return null;
  }
  let plaintext: string;
  try {
    plaintext = decrypt(record);
  } catch (err) {
    opts.onError?.(
      `tokenStore: ${provider} decrypt failed (${(err as Error).message}). ` +
        `Likely cause: token file copied from another machine, or AIDEN_TOKEN_KEY changed. ` +
        `Run /auth login ${provider} to re-authenticate.`,
    );
    return null;
  }
  try {
    return JSON.parse(plaintext) as OAuthTokens;
  } catch {
    opts.onError?.(`tokenStore: ${provider} payload is not valid JSON`);
    return null;
  }
}

/** Delete the token file for a provider (used by /auth logout). */
export async function clearTokens(
  paths: AidenPaths,
  provider: string,
): Promise<void> {
  const file = tokenFile(paths, provider);
  await fs.rm(file, { force: true });
}

/** True if a token file exists on disk (regardless of validity). */
export async function hasTokens(
  paths: AidenPaths,
  provider: string,
): Promise<boolean> {
  try {
    await fs.access(tokenFile(paths, provider));
    return true;
  } catch {
    return false;
  }
}

/** List provider ids with token files on disk. */
export async function listAuthedProviders(paths: AidenPaths): Promise<string[]> {
  const dir = authDir(paths);
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

/** Diagnostic — check whether a token bundle is past its expiry. */
export function isExpired(tokens: OAuthTokens, skewMs = 0): boolean {
  return Date.now() + skewMs >= tokens.expiresAtMs;
}

/**
 * Five-minute pre-flight refresh window — same value Phase 4's
 * CredentialResolver uses for symmetry.
 */
export const PREFLIGHT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Compute a stable fingerprint of the machine-binding so /auth status
 * can show "tokens were saved on machine X" diagnostics. Not a secret —
 * just a SHA-256 of the same identity string the key derivation uses.
 */
export function machineFingerprint(): string {
  const ident =
    `${os.hostname()}::${os.userInfo().username}::${process.platform}`;
  return createHash('sha256').update(ident).digest('hex').slice(0, 12);
}
