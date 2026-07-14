/**
 * plugins/aiden-plugin-chatgpt-plus/index.js — Aiden v4.0.0 (Phase 18 Task 3)
 *
 * Bundled OAuth provider for ChatGPT Plus subscriptions. Device-code
 * flow against auth.openai.com; tokens land in
 * <aiden-home>/auth/chatgpt-plus.json via the runtime's tokenStore.
 *
 * Inference base URL is `https://chatgpt.com/backend-api/codex` (the
 * Codex Responses API), NOT api.openai.com. Token type maps to v4's
 * existing `codex_responses` apiMode.
 *
 * UX (per Phase 18 Task 3 review):
 *   - URL + user_code printed prominently with whitespace-padded boxing
 *     so the code is visually distinct
 *   - Polling status printed up-front; periodic "still waiting…" line
 *     at the 5-minute mark with remaining-time hint
 *   - Timeout / cancellation surfaces as a thrown error with explicit
 *     retry guidance: "Code expired. Run /auth login chatgpt-plus."
 *   - "Authed as <account>" on success when token response carries an
 *     account hint, plain "Login successful" otherwise
 *
 * Constants:
 *   client_id           = app_EMoamEEZ73f0CkXaXp7hrann
 *   issuer              = https://auth.openai.com
 *   inference base URL  = https://chatgpt.com/backend-api/codex
 *
 * Deliberately NOT supported in v4.0:
 *   - Reading tokens from ~/.codex/auth.json (the official Codex CLI's
 *     shared file). Adds extra surface area; v4.0 ships the device-code
 *     flow only. v4.1 may add.
 */

'use strict';

const SUBSCRIPTION_AUTH = {
  id: 'chatgpt-plus',
  displayName: 'ChatGPT Plus',
  description:
    'Sign in with your ChatGPT Plus subscription. Uses your existing ChatGPT login — no API key needed. Inference is routed through the Codex Responses API.',
  // v4.9.0 — `defaultModels[0]` is what `setupWizard.ts:810` picks
  // as a new ChatGPT-Plus user's first model. The Codex OAuth backend
  // rejects `gpt-5` outright with a 400 ("not supported when using
  // Codex with a ChatGPT account") for new accounts; `gpt-5.5` is the
  // first non-codex slug in the registry's modelIds and works
  // reliably. `gpt-5` stays in the array so users who specifically
  // want it can still see it in /model. `gpt-5-mini` was removed —
  // it's a direct OpenAI API name and is NOT valid on the Codex OAuth
  // endpoint (see providers/v4/registry.ts:117–119).
  defaultModels: ['gpt-5.5', 'gpt-5'],

  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  issuer: 'https://auth.openai.com',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  apiMode: 'codex_responses',
  headerName: 'Authorization',
  headerPrefix: 'Bearer ',

  // The "still waiting" reminder fires after this much elapsed time.
  REMINDER_AT_MS: 5 * 60 * 1000,
  // Anthropic + OpenAI both expect a CLI-style UA on these endpoints.
  // OpenAI is more permissive than Anthropic but we set one for parity.
};

function aidenVersion() {
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

/** Render the user-code as a visually-distinct boxed line. Pure helper. */
function renderUserCodeBox(code) {
  // Two-space horizontal padding, padded to a min width so short codes
  // don't look cramped. ASCII box-drawing chars work in every Windows
  // terminal we ship to (Windows Terminal, ConHost on Win11).
  const inner = `   ${code}   `;
  const width = Math.max(inner.length, 18);
  const padded = inner.padEnd(width, ' ');
  const top = '┌' + '─'.repeat(width) + '┐';
  const mid = '│' + padded + '│';
  const bot = '└' + '─'.repeat(width) + '┘';
  return [top, mid, bot];
}

/** Format a remaining-time as "Mm Ss" for the still-waiting reminder. */
function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
}

/**
 * Wrap a user-agent so the polling sleep() also runs a periodic
 * "still waiting…" reminder. Pure: tests inject a fake date source.
 */
function buildPollingUa(outer, deadlineAt, now = Date.now) {
  let reminderShown = false;
  let started = now();
  return {
    log: outer.log.bind(outer),
    openBrowser: outer.openBrowser.bind(outer),
    prompt: outer.prompt.bind(outer),
    async sleep(ms) {
      // Print the "still waiting" reminder once when we cross the
      // 5-minute mark mid-poll. Without it, a silent terminal for 15
      // minutes would frustrate first-run users.
      const elapsed = now() - started;
      if (
        !reminderShown &&
        elapsed >= SUBSCRIPTION_AUTH.REMINDER_AT_MS &&
        deadlineAt - now() > 0
      ) {
        reminderShown = true;
        outer.log(
          `Still waiting… your code expires in ${formatRemaining(deadlineAt - now())}`,
        );
      }
      await outer.sleep(ms);
    },
  };
}

function buildProvider(authHelpers) {
  return {
    id: SUBSCRIPTION_AUTH.id,
    displayName: SUBSCRIPTION_AUTH.displayName,
    defaultModels: SUBSCRIPTION_AUTH.defaultModels,
    description: SUBSCRIPTION_AUTH.description,

    async login(ua) {
      ua.log('');
      ua.log('Sign in to ChatGPT Plus');
      ua.log('');
      ua.log(
        'How this works: OpenAI shows you a short code in your browser.',
      );
      ua.log(
        'You enter that code on the OpenAI device-auth page; we poll',
      );
      ua.log('until OpenAI confirms, then save the tokens locally.');
      ua.log('');

      // Wrap the ua so the device-code flow's sleep is augmented with a
      // mid-poll "still waiting…" reminder at the 5-minute mark. The
      // remainder of the flow's logging (URL + code, "Waiting for sign-in…")
      // comes from runDeviceCodeFlow itself; we hijack it here only for
      // the visually-distinct boxed code rendering.
      const startedAtMs = Date.now();
      const deadlineMs = startedAtMs + 15 * 60 * 1000;
      const innerUa = buildPollingUa(
        {
          log: (line) => {
            // Detect the flow's "Enter the code: <CODE>" line and replace
            // it with the boxed rendering. Cleaner than patching the
            // runDeviceCodeFlow primitive itself.
            const m = /^\s*2\.\s+Enter the code:\s*(.*)$/.exec(line);
            if (m) {
              ua.log('  2. Enter this code on that page:');
              for (const boxLine of renderUserCodeBox(m[1].trim())) {
                ua.log(`     ${boxLine}`);
              }
              return;
            }
            ua.log(line);
          },
          openBrowser: ua.openBrowser.bind(ua),
          prompt: ua.prompt.bind(ua),
          sleep: ua.sleep.bind(ua),
        },
        deadlineMs,
      );

      let result;
      try {
        result = await authHelpers.runDeviceCodeFlow(
          {
            issuer: SUBSCRIPTION_AUTH.issuer,
            clientId: SUBSCRIPTION_AUTH.clientId,
            extraHeaders: userAgentHeader(),
          },
          innerUa,
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const retryHint =
          /timed out/i.test(msg)
            ? ' Code expired. Run `/auth login chatgpt-plus` to retry.'
            : ' Run `/auth login chatgpt-plus` to retry.';
        const e = new Error(msg + retryHint);
        e.cause = err;
        throw e;
      }

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
        // OpenAI's refresh endpoint is the same as the token-exchange one.
        tokenUrl: `${SUBSCRIPTION_AUTH.issuer}/oauth/token`,
        clientId: SUBSCRIPTION_AUTH.clientId,
        formEncoded: true,
        extraHeaders: userAgentHeader(),
      });
    },

    describeRuntime() {
      return {
        apiMode: SUBSCRIPTION_AUTH.apiMode,
        baseUrl: SUBSCRIPTION_AUTH.baseUrl,
        headerName: SUBSCRIPTION_AUTH.headerName,
        headerPrefix: SUBSCRIPTION_AUTH.headerPrefix,
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
  buildPollingUa,
  renderUserCodeBox,
  formatRemaining,
  SUBSCRIPTION_AUTH,
};
