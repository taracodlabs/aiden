# Phase 16f — Together+Qwen3 primary, smart approval, browser strategy, CAPTCHA honesty, planner reset

## Audits (5 in 1 commit)
[`hermes-approval-modes-audit.md`](hermes-approval-modes-audit.md) ·
[`hermes-browser-launch-audit.md`](hermes-browser-launch-audit.md) ·
[`hermes-model-picker-audit.md`](hermes-model-picker-audit.md) ·
[`hermes-web-search-audit.md`](hermes-web-search-audit.md) ·
[`hermes-tool-honesty-audit.md`](hermes-tool-honesty-audit.md)

Two audits returned **defer** decisions: model picker (existing
implementation meets bar, polish to Phase 17) and web-search (Hermes
ships paid-only; `open_url` subsumes the v4.0 use case). Phase 16f
shrunk from 5 tasks to 3.

## Task 0 — Together AI + Qwen3-235B as primary
[`168c9cc`] User cleared all 4 Groq slots after 16e least-used spreading
helped but Groq's free-tier TPM cap was still too tight. Together
(throughput tier ~$0.20/M, $5-10 free credit) becomes the chain primary
with `Qwen/Qwen3-235B-A22B-Instruct-2507-tput`. Llama-3.3-Turbo demoted
to the secondary Together slot (same key). Live verified: 200 from
`/v1/models`, 5-sentence story round-trip 122 tokens, OpenAI-clean
tool_calls (no `<function=...>` recovery needed).

## Task 1 — Smart approval + open_url shell launch
[`9e59b11`] **Smart approval** (per Audit A — adapt Hermes pattern):
- New `BUILTIN_SAFE_TOOLS` set: file_read, file_list, fetch_url,
  web_search, session_search, memory_*, system_info, now_playing,
  browser_screenshot, browser_get_url, open_url. Auto-approved in
  smart mode without prompt or LLM call.
- New `BUILTIN_SAFE_DOMAINS` set: google, wikipedia, github, stackoverflow,
  npmjs, pypi, mdn, taracod, etc. browser_navigate to these domains
  auto-approves; non-allowlisted prompts.
- Default `approval_mode` flips manual → smart.
- Smart-mode default tier tightens from `safe` → `caution` for
  unflagged calls (was the bug that made approvals feel useless).
- Disk persistence: `~/.aiden/approvals.json` for "Allow always"
  decisions, atomic tmp-then-rename.

[`8bd0456`] **`open_url`** (per Audit B — diverge from Hermes CDP):
Platform-aware shell launch (`cmd.exe /c start "" <url>` / `open` /
`xdg-open`) for "open X in browser" requests. Real user profile, no
Playwright detection, no CAPTCHA. Pre-flagged in BUILTIN_SAFE_TOOLS
so it auto-approves. Reserved for fire-and-forget; `browser_navigate`
still handles programmatic interaction.

## Task 3 — CAPTCHA detection + tool honesty
[`dcb3a94`] (per Audit E — copy `{success, error}` shape + extend):
New `tools/v4/browser/captchaCheck.ts` matches 20+ markers across
Cloudflare, Akamai, hCaptcha, reCAPTCHA, PerimeterX, AWS WAF.
`browser_navigate` calls `pwSnapshot()` after navigation, runs the
detector, returns `success: false` with a clear next-step pointing the
agent at `open_url`. Bias toward sensitivity per audit — false
negatives caused the original bug.

## Task 5 — PlannerGuard reset per user turn
[`94c7818`] AidenAgent.runConversation now calls
`plannerGuard.resetActivation()` before each `decide()`. Eliminates
latent stickiness in the (currently-dead-code) `activateToolsets`
contract. Skills needing persistent toolset activation should re-fire
`skill_view` per turn.

## Tests + tsc
v4 unit suite **1113 / 1 skip / 0 fail** (was 1083 in Task 0).
- approval engine: +8 tests (built-in safe tools/domains, persistent
  allowlist, hostnameOf parsing)
- open_url: +10 tests (platform launchers, URL validation, schema)
- captcha detector: +11 tests (Cloudflare, Akamai, h/reCaptcha,
  PerimeterX, false-positive resistance)
- planner reset: +1 test (per-turn carryover prevention)
- Together primary slot: +1 test in providerFallback (chain order)
- 3 existing tests updated for the new chain order / model defaults

`tsc --noEmit` clean throughout.

## Smoke gates flagged for manual REPL run
1. **Together+Qwen3:** boot REPL → "tell me a 5-sentence story" →
   smooth Qwen3 response, no Groq fallback hits.
2. **Smart approval:** "list files in C:\Users\shiva\Documents" →
   silent (BUILTIN_SAFE_TOOLS); "delete a test file" → prompts
   (file_delete is non-safe); allow-always persists across restarts.
3. **open_url:** "open chrome and go to google.com" →
   `cmd.exe /c start "" https://google.com` fires, real Chrome opens,
   no Playwright lifecycle, no CAPTCHA.
4. **CAPTCHA honesty:** browser_navigate to a bot-walled page →
   response surfaces "blocked by CAPTCHA, retry via open_url" instead
   of "search completed."
5. **Planner reset:** turn-1 search task → turn-2 "remember concise
   answers" → web_search NOT in selected tools.

## Deferred / flagged
- **Task 2** (model picker UI polish) — existing picker meets bar;
  Phase 17 polish.
- **Task 4** (bundled web-search skill) — Hermes ships paid-only
  (Tavily/Exa/Parallel); v4.1 plugin territory. `open_url` to
  `google.com/search?q=…` covers the v4.0 use case.
- **Multi-tool batching prompt (1F)** — built-in safe-list eliminates
  most prompts; batching is a v4.1 polish.

## Commits (in order)
- `168c9cc` feat(providers): Together AI key + Qwen3-235B primary (Task 0)
- `ff83712` docs(v4): 5 hermes audits (Phase 16f prep)
- `9e59b11` feat(approval): smart mode + safe tools/domains + disk allowlist (Task 1A-D)
- `8bd0456` feat(tools): open_url shell-launch (Task 1E)
- `dcb3a94` fix(browser): CAPTCHA detection + success:false (Task 3)
- `94c7818` fix(planner): reset activeToolsets per user turn (Task 5)
- `<this commit>` docs(v4): phase 16f summary

All on `backup/v4-rewrite`. Origin untouched.
