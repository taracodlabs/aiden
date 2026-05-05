# Phase 20 — Pro license + npm publish pipeline + auto-update (completed)

**Branch:** `v4-rewrite` · **Range:** `58494ec..814a083` (audit + 7 task commits)
**Status:** closed. Aiden v4.0-beta is publish-ready: Pro license activation works against the existing api.taracod.com worker, the npm publish workflow gates on tag/version match, and a non-blocking auto-update check surfaces new versions on boot.

## What shipped

### Hermes audit (audit doc)
- `docs/sprint/hermes-license-pipeline-audit.md` — Hermes has **no Pro tier** (MIT, single-tier free). Versioning is git-only; updates are git-fetch-based with a 6h JSON cache invalidated on `HERMES_REVISION` change. Aiden ports the cache shape to npm-registry land and keeps everything else as designed.

### License client + store + machine fingerprint (Task 1)
- `core/v4/license/machineFingerprint.ts` — sha256 of `hostname:user:platform:cpuCount` salted; `AIDEN_MACHINE_KEY` env override for VM portability + tests. v3 used wmic/PowerShell hardware probes; v4 drops them (slow on Win11, PII-adjacent).
- `core/v4/license/licenseStore.ts` — AES-256-GCM at `<aiden-home>/license/<fingerprint>.json`, machine-bound key (parity with Phase 18 `tokenStore`). v3 stored plaintext in `workspace/license.json` — strict upgrade.
- `core/v4/license/licenseClient.ts` — wraps `/license/{activate,verify,deactivate}` on `api.taracod.com`. 24h server cache + 7-day offline grace (kept from v3). `LicenseFetch` injection makes it 100%-mockable.
- `core/v4/license/featureGate.ts` — three flags (`MULTI_TOOL_APPROVAL`, `SILENT_OAUTH_REFRESH`, `CUSTOM_PERSONALITIES`) + honest degradation messages.

### `/license` slash command (Task 2)
- `/license`             — current tier, plan, expiry, machine, masked key, cache file path
- `/license activate`    — strict format pre-check, server round-trip, persist on success
- `/license deactivate`  — releases seat; clears local cache even when server unreachable
- `/license refresh`     — bypass 24h cache, re-verify
- Free tier sees Pro features listed once + single upgrade hint to `aiden.taracod.com/pro`

### Pro feature gates (Task 3)
- `OAuthProviderRuntime` accepts an optional `silentRefreshAllowed` predicate. Pro: pre-flight refresh window. Free: only refreshes on hard expiry (so OAuth never breaks mid-session — interpreted spec to avoid degrading free-tier OAuth completely).
- `ApprovalEngine.setBatchGate()` / `getBatchGate()` — gate exposed for the upcoming batch-approval UI; engine itself never imports `core/v4/license`, preserving the moat → core direction.
- `/personality install <name>` — Pro-gated; scaffolds a starter `<name>.md` in `personalitiesDir` with a tone/focus/avoid template.

### npm publish pipeline (Task 4)
- `package.json`: version bumped to `4.0.0-beta.1` · `publishConfig.access = public` · `prepublishOnly = typecheck + test + build` · `publish:beta` / `publish:stable` scripts.
- `.github/workflows/publish.yml` — triggers on `v4.*.*-beta.*` and `v4.*.*` tag pushes. Verifies tag matches `package.json.version` before publishing (catches "tagged v4.0.0-beta.1 but package.json still at 3.19.9"). Uses npm provenance attestation. Auto-generates a GitHub release with commit-walk changelog; pre-release flag set on `-beta.*` tags.
- `tests/v4/license/publishConfig.test.ts` — guards version pattern and workflow shape against drift.

### Auto-update check (Tasks 5 + 6)
- `core/v4/update/checkUpdate.ts` — GETs `registry.npmjs.org/aiden-runtime/latest`, 4s AbortController timeout, 6h JSON cache at `<aiden-home>/.update_check.json`. Cache invalidates on installed-version change (Hermes `HERMES_REVISION` pattern, ported).
- `compareVersions()` — strict `MAJOR.MINOR.PATCH[-beta.N]` semver subset (no extra dependency).
- `AIDEN_NO_UPDATE_CHECK=1` env opt-out (skips both cache + network).
- `aidenCLI.ts` — fires the check via `setImmediate` so REPL boot is never blocked. Subsequent boots show the update line at `dim()`; first-ever boot uses `warn()` (Task 6 surfacing).

### `/doctor` extended (Task 7)
- `checkLicense` — hasLicense probe + statusFromCache (no network); free / pro / stale all reported honestly.
- `checkUpdate` — reuses `checkForUpdate()`; cache hit is sub-ms, network bounded by per-check timeout.
- Reads installed version from `package.json`; tag-vs-package mismatch surfaces as a doctor row.

## Tests
**+30 unit tests** (spec asked ≥25):
- machineFingerprint (2) · licenseStore (3) · licenseClient (5) · featureGate (4) · /license command (4) · publishConfig (2) · checkUpdate (7) · doctorPhase20 (3)
- Full v4 suite: **1313 passed / 1 skipped** (1314). Pre-existing failures in `native-modules/` and `scripts/test-suite/regression/` are unrelated to Phase 20.

## Verified stop conditions
- ✅ Cloudflare worker schema unchanged — v4 reuses v3 `/license/{activate,verify,deactivate}` endpoints exactly.
- ✅ npm scope: `aiden-runtime` is unscoped + already public on the v3 trajectory; no naming negotiation needed.
- ✅ Boot perf: update check is fully async via `setImmediate`. Manual boot timing unchanged.
- ✅ No actual npm publish — `4.0.0-beta.1` is staged in package.json but no `npm publish` ran. Phase 21 manual QA happens before the first tag push.

## Author / publishing discipline
All 7 commits authored by Shiva Deore. No Claude trailers. Pushed to `backup/v4-rewrite` per the v3.19.9 origin freeze.

## Next: Phase 21 — manual QA matrix on Win / macOS / Linux.
