# Known test failures — full-suite baseline (feat/v4.11-streaming)

Purpose: so a full `npx vitest run` can be diffed against this list. Anything
red here is **consciously accepted** (environment-only or pre-existing
non-product-bug). Anything red **not** here is a new regression — investigate.

Last verified at HEAD `2c0d4490`: 11 reds (8 environment-only + 3 pre-existing
non-bugs). Confirmed pre-existing via full-suite bisect against session-start
`d2a6720b` (same failures appear there → not introduced by the v4.11 verifier/
slash-command/streaming work). The environment-only count drifts 7–8 because
the PTY tests are non-deterministic in headless (see framePty note).

## (a) Environment-only — 7–8 failures, 4 files (cannot pass in a headless harness)
These pass on a real terminal / with the dependency running. Confirmed via
`node-pty AttachConsole failed` and missing-daemon errors in the log.

| File | Fails | Why |
|---|---|---|
| `tests/v4/cli/frame/framePty.test.ts` | 3–4 of 5 | node-pty can't attach a console (no real TTY); **flaky count** in headless |
| `tests/v4/cli/aidenPromptFooterGhost.test.ts` | 1 | same node-pty PTY limitation |
| `tests/v4/harness/aidenTermSmoke.test.ts` | 1 | same node-pty PTY limitation |
| `tests/v4/integration/ollamaPromptTools.real.test.ts` | 2 | requires a live Ollama daemon |

## (b) Pre-existing, non-product-bug — 3 failures, 2 files
Confirmed pre-existing via full-suite run at session-start `d2a6720b` (same
reds there). Neither is a real product regression.

| File | Fails | Diagnosis |
|---|---|---|
| `tests/v4/contextCompressor.preflight.test.ts` | 2 | **Test-order pollution.** "adds tool tokens to utilization" / "raise utilization monotonically" pass in isolation (14/14) but fail in the full suite — token utilization depends on the lazily-loaded tiktoken tokenizer singleton, whose loaded/disposed state is mutated by another file's tests. Not a compressor bug; a test-isolation issue. |
| `tests/v4/cli/greeter/integration-real-boot.test.ts` | 1 | **Offer-tier preemption (test can't isolate the lowest offer).** "with seeded update cache: update-available appears" expects the greeter's update line, but in `selectOffer` the update offer is **Tier 4 (lowest)**. Higher-tier offers preempt it: Tier-2 `welcome-back` (`hoursSinceLastSession >= 24` — always true, the fixture's `lastGreetingAt` is a fixed past date) and Tier-3 `time-of-day-evening` (`hourOfDay >= 18`). The test controls neither the clock nor those tiers, so a higher offer wins and the update line never renders. (The seeded `latest: '4.9.99'` is also below the current `4.10.0`, a second-order issue.) Not a product bug — the greeter reasonably prioritizes continuity/time-of-day over an update nudge. Proper fix needs the test to inject a controllable `now` (production change to thread a clock through renderStartupCard→renderGreeter) and tune history to suppress Tier 2/3, OR a product decision to raise the update offer's tier. NOT a one-line fixture bump. |

## (c) Resource-flaky under full-suite parallel load — up to 4 failures, 3 files
These **pass in isolation** (re-verified 16/16 and 21/21 across runs) but
intermittently fail when the full ~465-file suite runs them under parallel
load — docker daemon / sandbox / system-probe integration tests contend for
timeouts and host resources. Not product bugs, not regressions; the tell is
that running the file(s) alone passes every time. Confirmed unrelated to the
v4.11 setup-wizard work (none import the changed modules).

| File | Fails | Diagnosis |
|---|---|---|
| `tests/v4/core/dockerSession.test.ts` | 1–2 | Docker container lifecycle integration; times out under parallel load. Passes alone. |
| `tests/v4/tools/shellExecSandbox.test.ts` | 1 | Sandbox shell execution integration; resource contention. Passes alone. |
| `tests/v4/tools/system.test.ts` | 0–1 | system_info probe; intermittent under load. Passes alone. |

## Not on this list = real regression
A full run now shows ~11 documented reds (cat. a+b) plus up to ~4 flaky
integration reds (cat. c) — anything beyond that set is new; investigate.
To check a cat.(c) suspect, run the file alone: if it passes, it's flake.
(Earlier v4.11 regressions — activityIndicator dot-wave + classifier
TCE-decouple — were fixed in `89efdc25`; surfaceOrphan + riskTier in `2c0d4490`.)
