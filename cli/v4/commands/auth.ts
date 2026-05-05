/**
 * cli/v4/commands/auth.ts — Aiden v4.0.0 (Phase 18 Task 5)
 *
 * `/auth [status|login|logout|refresh] [provider]`
 *
 * Subcommands:
 *   status [provider] — auth state, account, expiry, file path, encryption
 *                       note. With no provider: render every OAuth provider
 *                       Aiden knows about. Default sub when /auth is called
 *                       with no args.
 *   login <provider>  — kick off OAuth flow via OAuthProviderRuntime;
 *                       reuses the same loadOAuthProvider helper the wizard
 *                       uses (single entry point per Phase 18 Task 4 review).
 *   logout <provider> — clear tokens (tokenStore file deleted).
 *   refresh <provider>— manual token refresh; if refresh-token missing or
 *                       provider rejects refresh, surface clear "run /auth
 *                       login" remediation.
 *
 * Multi-provider note: v4.0's setup wizard is single-provider. To use
 * multiple providers, edit %LOCALAPPDATA%\\aiden\\config.yaml directly
 * (Linux/macOS: ~/.aiden/config.yaml). v4.1 adds an "alongside vs replace"
 * UX in the wizard.
 */

import type { SlashCommand } from '../commandRegistry';
import {
  OAuthProviderRuntime,
  type OAuthUserAgent,
} from '../../../core/v4/auth/providerAuth';
import {
  loadTokens,
  hasTokens,
  isExpired,
  PREFLIGHT_REFRESH_WINDOW_MS,
  machineFingerprint,
  type OAuthTokens,
} from '../../../core/v4/auth/tokenStore';
import {
  PRO_PROVIDER_IDS,
  PRO_PLUGIN_DIRS,
  loadOAuthProvider,
  openOAuthBrowserUrl,
} from '../auth/loadProvider';
import path from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────

/** "expires in 47 minutes" / "expired 2 days ago". Pure. */
function formatRelativeExpiry(expiresAtMs: number, nowMs = Date.now()): string {
  const delta = expiresAtMs - nowMs;
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
  return delta >= 0
    ? `expires in ${value} ${unit}`
    : `expired ${value} ${unit} ago`;
}

/** Render the status block for one provider to ctx.display. */
function renderStatus(
  ctx: import('../commandRegistry').SlashCommandContext,
  providerId: string,
  tokens: OAuthTokens | null,
): void {
  ctx.display.write(`\n${providerId}:\n`);
  if (!tokens) {
    ctx.display.dim('  state: not authenticated');
    ctx.display.dim(`  → run /auth login ${providerId} to sign in`);
    return;
  }
  const expired = isExpired(tokens);
  const stale = isExpired(tokens, PREFLIGHT_REFRESH_WINDOW_MS);
  const stateLabel = expired ? 'expired' : stale ? 'expiring soon' : 'authed';
  ctx.display.write(`  state: ${stateLabel}\n`);
  if (tokens.account) ctx.display.write(`  account: ${tokens.account}\n`);
  ctx.display.write(`  ${formatRelativeExpiry(tokens.expiresAtMs)}\n`);
  if (tokens.models?.length) {
    ctx.display.write(`  models: ${tokens.models.join(', ')}\n`);
  }
  if (ctx.paths) {
    ctx.display.dim(
      `  file: ${path.join(ctx.paths.root, 'auth', `${providerId}.json`)}`,
    );
  }
  if (expired || stale) {
    ctx.display.dim(`  → run /auth refresh ${providerId} to re-issue`);
  }
}

/** OAuthUserAgent backed by the slash-command context. */
function buildUserAgent(
  ctx: import('../commandRegistry').SlashCommandContext,
): OAuthUserAgent {
  const askPrompt = ctx.prompt;
  return {
    log: (line: string) => ctx.display.write(line + '\n'),
    openBrowser: openOAuthBrowserUrl,
    async prompt(question: string) {
      if (!askPrompt) {
        throw new Error(
          '/auth login needs a prompt hook — run from the chat REPL, not /auth tests',
        );
      }
      return askPrompt(question);
    },
    async sleep(ms: number) {
      return new Promise<void>((r) => setTimeout(r, ms));
    },
  };
}

// ─── Command ─────────────────────────────────────────────────────────

export const auth: SlashCommand = {
  name: 'auth',
  description: 'Manage OAuth subscription auth (Claude Pro, ChatGPT Plus).',
  category: 'system',
  icon: '🔑',
  handler: async (ctx) => {
    if (!ctx.paths) {
      ctx.display.warn('Plugin paths not wired (boot may still be in progress).');
      return {};
    }
    const sub = (ctx.args[0] ?? 'status').toLowerCase();

    // ── status ───────────────────────────────────────────────────
    if (sub === 'status') {
      const targetId = ctx.args[1];
      const ids =
        targetId && PRO_PROVIDER_IDS.includes(targetId)
          ? [targetId]
          : (PRO_PROVIDER_IDS as readonly string[]);
      if (targetId && !PRO_PROVIDER_IDS.includes(targetId)) {
        ctx.display.printError(
          `Unknown provider '${targetId}'. Known: ${PRO_PROVIDER_IDS.join(', ')}.`,
        );
        return {};
      }
      ctx.display.info('OAuth provider status');
      for (const id of ids) {
        const tokens = await loadTokens(ctx.paths, id, {
          onError: (msg) => ctx.display.warn(msg),
        });
        renderStatus(ctx, id, tokens);
      }
      // Encryption + multi-provider notes.
      ctx.display.write('\n');
      ctx.display.dim(
        `Tokens encrypted with machine-derived key (fingerprint ${machineFingerprint()}). ` +
          `Protects against casual file inspection but NOT against code execution on this machine. ` +
          `Real OS keychain in v4.1.`,
      );
      ctx.display.dim(
        `To use multiple providers, edit ${path.join(ctx.paths.root, 'config.yaml')} directly.`,
      );
      // Phase 18.1: OAuth providers are beta in v4.0. Some upstream errors
      // (Anthropic "Missing client_id", OpenAI "Workspaces not found") are
      // account-state-specific and have no client-side fix.
      ctx.display.dim(
        `OAuth in beta — provider-side errors may require account state we cannot detect from this side. ` +
          `If signin fails, use API key auth instead.`,
      );
      return {};
    }

    // Subcommands below all need a provider arg.
    const providerId = ctx.args[1];
    if (!providerId) {
      ctx.display.printError(
        `Usage: /auth ${sub} <provider>`,
        `Known providers: ${PRO_PROVIDER_IDS.join(', ')}`,
      );
      return {};
    }
    if (!PRO_PROVIDER_IDS.includes(providerId)) {
      ctx.display.printError(
        `Unknown provider '${providerId}'. Known: ${PRO_PROVIDER_IDS.join(', ')}.`,
      );
      return {};
    }

    // ── login ────────────────────────────────────────────────────
    if (sub === 'login') {
      let provider;
      try {
        provider = await loadOAuthProvider(providerId);
      } catch (err) {
        ctx.display.printError(
          `Could not load OAuth plugin: ${(err as Error).message}`,
        );
        return {};
      }
      const runtime = new OAuthProviderRuntime(provider, ctx.paths);
      const ua = buildUserAgent(ctx);
      try {
        const tokens = await runtime.login(ua);
        const accountSuffix = tokens.account ? ` as ${tokens.account}` : '';
        ctx.display.success(`${providerId} authed${accountSuffix}.`);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        // Phase 18.1: distinguish auth-level failures (bad code, expired)
        // from upstream provider/account-state failures so the hint is
        // honest rather than blanket. Auth-level errors keep the existing
        // /auth login retry guidance the plugin throws (e.g. claude-pro's
        // 'run /auth login claude-pro to start over'). The 'beta' fallback
        // hint surfaces for the cloudier cases — 4xx HTTP shape, "client_id"
        // / "workspace" diagnostics from the provider.
        const looksUpstream =
          /HTTP\s4\d\d/i.test(msg) ||
          /missing client_id/i.test(msg) ||
          /workspaces? not found/i.test(msg);
        ctx.display.printError(`${providerId} sign-in failed: ${msg}`);
        if (looksUpstream) {
          ctx.display.dim(
            `OAuth providers are beta in v4.0. If this persists, configure an API-key provider via \`aiden setup\`, or switch with /model.`,
          );
        }
      }
      return {};
    }

    // ── logout ───────────────────────────────────────────────────
    if (sub === 'logout') {
      if (!(await hasTokens(ctx.paths, providerId))) {
        ctx.display.dim(`${providerId}: nothing to log out.`);
        return {};
      }
      // Build a minimal runtime (no plugin needed — logout just deletes
      // the file; same path /plugins remove takes for plugin teardown).
      const provider = await loadOAuthProvider(providerId).catch(() => null);
      if (provider) {
        const rt = new OAuthProviderRuntime(provider, ctx.paths);
        await rt.logout();
      } else {
        // Fallback: delete the file directly even if the plugin can't be
        // loaded for some reason — never let "logout failed" leave a
        // dangling token file.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs') as typeof import('node:fs');
        try {
          fs.rmSync(
            path.join(ctx.paths.root, 'auth', `${providerId}.json`),
            { force: true },
          );
        } catch {
          /* swallow */
        }
      }
      ctx.display.success(`${providerId} signed out (tokens cleared).`);
      return {};
    }

    // ── refresh ──────────────────────────────────────────────────
    if (sub === 'refresh') {
      let provider;
      try {
        provider = await loadOAuthProvider(providerId);
      } catch (err) {
        ctx.display.printError(
          `Could not load OAuth plugin: ${(err as Error).message}`,
        );
        return {};
      }
      const runtime = new OAuthProviderRuntime(provider, ctx.paths);
      try {
        const tokens = await runtime.refreshNow();
        ctx.display.success(
          `${providerId} refreshed. ${formatRelativeExpiry(tokens.expiresAtMs)}.`,
        );
      } catch (err) {
        ctx.display.printError(
          `${providerId} refresh failed: ${(err as Error).message}`,
          `Try: /auth login ${providerId}`,
        );
      }
      return {};
    }

    ctx.display.printError(
      `Unknown subcommand: ${sub}`,
      'Try: /auth status [provider] | login <provider> | logout <provider> | refresh <provider>',
    );
    return {};
  },
};

// Re-export the relative-expiry helper so tests don't reach into module internals.
export { formatRelativeExpiry, PRO_PROVIDER_IDS, PRO_PLUGIN_DIRS };
