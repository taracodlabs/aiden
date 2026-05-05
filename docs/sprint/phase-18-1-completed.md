# Phase 18.1 — OAuth four-fix patchset (completed)

**Branch:** `v4-rewrite` · **Range:** `292c7cd..6b35185` (diag + 3 fix commits)
**Status:** closed. Phase 18 OAuth surface bug-fixed and beta-framed. Phase 18 itself now closes for v4.0 launch.

## Why this patchset exists

Manual smoke of Phase 18 OAuth flows surfaced two upstream errors:
- Claude Pro: `claude.ai/oauth/authorize` rendered "Missing client_id parameter" against a URL that demonstrably contained `client_id=…`.
- ChatGPT Plus: `auth.openai.com/codex/device` rendered "Workspaces not found in client auth session" after the user entered the device code.

Source-code diagnostic (`292c7cd`) re-read Hermes verbatim. **Neither reported error has a code-side explanation** — Hermes's git history shows no OAuth-related commit on these files in 6+ months, so users on Hermes hit the same upstream behaviour. They are account-state issues beyond the client's reach.

But the source verification surfaced **one real bug** plus three parity gaps that would have bitten the next user who got past the browser page.

## Four fixes

| # | Commit | Surface | Change |
|---|---|---|---|
| 1 | `5b4aefc` | `oauthFlow.ts::runCopyPasteFlow` | Login token-exchange POSTs **JSON body** + `Content-Type: application/json` (Hermes verbatim per `anthropic_adapter.py:1092-1109`). Phase 18 audit miss — login is JSON-only, not form-encoded; the form shape is the refresh path. |
| 2 | `657afa8` | `plugins/aiden-plugin-claude-pro/index.js` | Split constants into distinct `loginTokenUrl` / `refreshTokenUrl` pairs. **Login** tries `console.anthropic.com` first (matches `anthropic_adapter.py:1016`); **refresh** tries `platform.claude.com` first (matches `anthropic_adapter.py:785-788`). |
| 3 | `657afa8` | `oauthFlow.ts::runDeviceCodeFlow` | All three POSTs (usercode / poll / exchange) carry `Accept: application/json` per `hermes_cli/auth.py:2264`. Parity gap; doesn't fix the upstream "Workspaces not found" error. |
| 4 | `6b35185` | `/auth status`, setup wizard, `/auth login` error path | Honest **beta framing**: the OAuth providers ship as beta in v4.0; users who hit upstream errors get clear remediation pointing at API-key auth. |

## Tests

7 new (`tests/v4/auth/phase18_1.test.ts`); auth surface total **68 → 75**, full Phase 18 sweep **179 tests, all green**.

- `69` login posts a JSON body with six required fields
- `70` login Content-Type is `application/json` (not form-urlencoded)
- `71` `refreshTokens` stays form-encoded (Hermes refresh shape)
- `72` Claude Pro plugin constants: distinct login vs refresh URL pairs
- `73` `provider.login` passes the login pair (console-first) to `runCopyPasteFlow`
- `74` `runDeviceCodeFlow`: all three POSTs carry `Accept: application/json`
- `75` `Accept` header preserved alongside user-supplied `extraHeaders`

Cost: $0. All HTTP mocked.

## Honesty note

The user's specific reported errors did **not** have a code-side explanation. The source verification still found a real bug (login JSON body) that would have caused 4xx failures for any future user past the browser page, plus three alignment fixes. Both OAuth providers ship marked **beta in v4.0**; v4.1 will lift beta after post-launch verification across more user accounts.

## Next

Phase 19 — Linux + macOS native paths + CI matrix.
