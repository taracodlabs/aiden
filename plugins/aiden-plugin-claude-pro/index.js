/**
 * plugins/aiden-plugin-claude-pro/index.js — Aiden v4.0.0 (Phase 18 Task 2)
 *
 * Bundled OAuth provider for Claude Pro / Max subscriptions. Direct port
 * of Hermes's flow (audit § Claude Pro OAuth — agent/anthropic_adapter.py:
 * 1011-1142). PKCE auth-code with out-of-band copy-paste; tokens land
 * in <aiden-home>/auth/claude-pro.json via the runtime's tokenStore.
 *
 * UX (per Phase 18 Task 2 review):
 *   - URL printed on its own line (clickable in modern terminals)
 *   - 5-step explicit instructions
 *   - Paste prompt accepts <code> or <code>#<state>; whitespace trimmed
 *   - Bad-code error explains how to retry (`/auth login claude-pro`)
 *   - "Authed as <account>" on success when the token response carries
 *     an account hint; otherwise plain "Login successful"
 *
 * Constants matching Hermes (audit doc has the rationale):
 *   client_id    = 9d1c250a-e61b-44d9-88ed-5944d1962f5e
 *   auth URL     = https://claude.ai/oauth/authorize
 *   token URL    = https://platform.claude.com/v1/oauth/token (preferred)
 *                  https://console.anthropic.com/v1/oauth/token (fallback)
 *   redirect URI = https://console.anthropic.com/oauth/code/callback
 *   scopes       = org:create_api_key user:profile user:inference
 *
 * User-Agent header: `aiden-cli/<ver> (external, cli)` per Hermes
 * convention. Anthropic's OAuth endpoints reject some default UAs.
 */

'use strict';

const CLAUDE_PRO = {
  id: 'claude-pro',
  displayName: 'Claude Pro / Max',
  description:
    'Sign in with your Claude Pro or Max subscription. Uses your existing claude.ai login — no API key needed.',
  defaultModels: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],

  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  fallbackTokenUrls: ['https://console.anthropic.com/v1/oauth/token'],
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference',
  apiMode: 'anthropic_messages',
  baseUrl: 'https://api.anthropic.com',
  headerName: 'Authorization',
  headerPrefix: 'Bearer ',
};

function aidenVersion() {
  // Read from package.json synchronously — single time at module load.
  // Fallback to 'dev' if the file isn't reachable (e.g. when the plugin
  // is loaded from a forked location outside the package).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json');
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
}

function userAgentHeader() {
  return {
    'User-Agent': `aiden-cli/${aidenVersion()} (external, cli)`,
  };
}

/**
 * Build the OAuthProvider (typed as OAuthProvider in core/v4/auth/providerAuth.ts).
 * Pulled out for tests so the provider can be exercised against a fake `auth`
 * helpers bundle without going through register().
 */
function buildProvider(authHelpers) {
  return {
    id: CLAUDE_PRO.id,
    displayName: CLAUDE_PRO.displayName,
    defaultModels: CLAUDE_PRO.defaultModels,
    description: CLAUDE_PRO.description,

    async login(ua) {
      ua.log('');
      ua.log('Sign in to Claude Pro / Max');
      ua.log('');
      ua.log('Steps:');
      ua.log('  1. Open the URL above in your browser.');
      ua.log('  2. Sign in to Claude.');
      ua.log('  3. Authorise Aiden.');
      ua.log(
        '  4. Copy the code shown after redirect (it may include a "#state" suffix).',
      );
      ua.log('  5. Paste it back here and press Enter.');
      ua.log('');

      let result;
      try {
        result = await authHelpers.runCopyPasteFlow(
          {
            authUrl: CLAUDE_PRO.authUrl,
            tokenUrl: CLAUDE_PRO.tokenUrl,
            fallbackTokenUrls: CLAUDE_PRO.fallbackTokenUrls,
            clientId: CLAUDE_PRO.clientId,
            redirectUri: CLAUDE_PRO.redirectUri,
            scope: CLAUDE_PRO.scope,
            extraHeaders: userAgentHeader(),
          },
          // Wrap the user agent so the inner prompt trims whitespace
          // (users will paste with trailing newline) and the inner flow
          // doesn't print its own banner — we already printed the 5 steps.
          {
            log: ua.log.bind(ua),
            openBrowser: ua.openBrowser.bind(ua),
            sleep: ua.sleep.bind(ua),
            prompt: async (q) => {
              const raw = await ua.prompt(q);
              return (typeof raw === 'string' ? raw : '').trim();
            },
          },
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        // Honest retry guidance in the thrown message — /auth login surfaces it.
        const retryHint =
          ' If the code expired or you pasted the wrong value, run ' +
          '`/auth login claude-pro` to start over.';
        const e = new Error(msg + retryHint);
        e.cause = err;
        throw e;
      }

      // Add account hint to extras if the token response carried one
      // (some providers do, Anthropic typically does not — kept for forward
      // compat). Caller (OAuthProviderRuntime.persist) writes this into
      // the saved tokens; /auth status surfaces it as "Authed as ...".
      const account =
        result.extras && typeof result.extras.account === 'string'
          ? result.extras.account
          : result.extras && typeof result.extras.email === 'string'
            ? result.extras.email
            : null;

      if (account) {
        ua.log('');
        ua.log(`Authed as ${account}`);
      } else {
        ua.log('');
        ua.log('Login successful.');
      }
      return result;
    },

    async refresh(refreshToken) {
      return authHelpers.refreshTokens(refreshToken, {
        tokenUrl: CLAUDE_PRO.tokenUrl,
        fallbackTokenUrls: CLAUDE_PRO.fallbackTokenUrls,
        clientId: CLAUDE_PRO.clientId,
        formEncoded: true,
        extraHeaders: userAgentHeader(),
      });
    },

    describeRuntime() {
      return {
        apiMode: CLAUDE_PRO.apiMode,
        baseUrl: CLAUDE_PRO.baseUrl,
        headerName: CLAUDE_PRO.headerName,
        headerPrefix: CLAUDE_PRO.headerPrefix,
      };
    },
  };
}

async function register(ctx) {
  const provider = buildProvider(ctx.auth);
  ctx.registerOAuthProvider(provider);
}

module.exports = {
  register,
  // Exposed for tests:
  buildProvider,
  CLAUDE_PRO,
};
