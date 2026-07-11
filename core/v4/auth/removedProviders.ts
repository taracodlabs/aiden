/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/auth/removedProviders.ts — single source of truth for OAuth
 * providers Aiden used to support and has since removed.
 *
 * A removed provider may still have an encrypted token file on disk from a
 * prior install. Nothing reads it anymore, but silently deleting a credential
 * is a consent violation — so we SURFACE it (a boot notice / a `/auth` line)
 * and let the user purge it explicitly. `cleanupRemovedProviderToken` is the
 * ONLY code that deletes such a file, and it is scoped to this list — never a
 * general delete-any-token path.
 */

import type { AidenPaths } from '../paths';
import { hasTokens, clearTokens, tokenFilePath } from './tokenStore';

/** Providers whose OAuth support was removed; their token files are orphans. */
export const REMOVED_OAUTH_PROVIDERS: readonly string[] = ['claude-pro'];

/** User-facing one-line explanation, shown the moment the feature is gone. */
const HEADLINES: Record<string, string> = {
  'claude-pro':
    'Your Claude subscription login is no longer supported and has been removed.',
};

export function isRemovedOAuthProvider(id: string): boolean {
  return REMOVED_OAUTH_PROVIDERS.includes(id);
}

export function removedProviderHeadline(id: string): string {
  return HEADLINES[id] ?? `The ${id} login is no longer supported and has been removed.`;
}

/**
 * Removed providers that still have a token file on disk. Cheap on a clean
 * install — one filesystem access per removed provider, nothing more.
 */
export async function findOrphanedRemovedTokens(paths: AidenPaths): Promise<string[]> {
  const found: string[] = [];
  for (const id of REMOVED_OAUTH_PROVIDERS) {
    if (await hasTokens(paths, id)) found.push(id);
  }
  return found;
}

/**
 * The ONLY path that deletes a removed provider's token file. Scoped to
 * REMOVED_OAUTH_PROVIDERS — a live provider is refused, so this can never be
 * turned into a general delete-any-token surface.
 */
export async function cleanupRemovedProviderToken(
  paths: AidenPaths,
  provider: string,
): Promise<{ ok: boolean; removed: boolean; message: string }> {
  if (!isRemovedOAuthProvider(provider)) {
    return {
      ok: false,
      removed: false,
      message:
        `'${provider}' is not a removed OAuth provider. ` +
        `cleanup only applies to: ${REMOVED_OAUTH_PROVIDERS.join(', ')}.`,
    };
  }
  if (!(await hasTokens(paths, provider))) {
    return { ok: true, removed: false, message: `No stored ${provider} credential to remove.` };
  }
  await clearTokens(paths, provider);
  return { ok: true, removed: true, message: `Removed the stored ${provider} credential.` };
}

export interface AnnounceDeps {
  paths: AidenPaths;
  /** true only when there is a TTY and we are not headless. */
  interactive: boolean;
  /** Where notice/diagnostic lines go (stdout interactive, stderr headless). */
  write: (line: string) => void;
  /** Interactive delete/keep prompt. Absent ⇒ non-interactive: diagnose, never delete. */
  confirm?: (question: string) => Promise<boolean>;
}

/**
 * Surface every orphaned removed-provider credential at the moment the feature
 * is gone. Interactive: notice + delete/keep prompt (honours the choice —
 * nothing auto-deletes). Non-interactive: a diagnostic naming the file + the
 * purge command, and NEVER a delete — silence/headless is not consent.
 */
export async function announceRemovedProviderOrphans(
  deps: AnnounceDeps,
): Promise<{ diagnosed: string[]; deleted: string[]; kept: string[] }> {
  const out = { diagnosed: [] as string[], deleted: [] as string[], kept: [] as string[] };
  for (const id of REMOVED_OAUTH_PROVIDERS) {
    if (!(await hasTokens(deps.paths, id))) continue; // clean install pays one access
    const file = tokenFilePath(deps.paths, id);
    deps.write(removedProviderHeadline(id));

    if (!deps.interactive || !deps.confirm) {
      // Non-interactive: name the file + the purge command. Never delete.
      deps.write(`A stored credential remains at ${file}.`);
      deps.write(`Run \`aiden auth cleanup ${id}\` to remove it.`);
      out.diagnosed.push(id);
      continue;
    }

    const del = await deps.confirm(`Delete the stored ${id} credential now?`);
    if (del) {
      await clearTokens(deps.paths, id);
      deps.write(`Removed ${file}.`);
      out.deleted.push(id);
    } else {
      deps.write(
        `Kept ${file}. Run \`/auth cleanup ${id}\` (or \`aiden auth cleanup ${id}\`) to remove it later.`,
      );
      out.kept.push(id);
    }
  }
  return out;
}
