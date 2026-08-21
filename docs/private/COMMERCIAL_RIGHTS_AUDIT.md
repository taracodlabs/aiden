# Aiden commercial rights inventory

Engineering inventory only. This is not legal advice. Closed-source distribution or relicensing remains subject to qualified legal review.

## Public baseline

- Tag: `v4.20.0`
- Commit: `eedd6c639843db08d235e4e11435c30e6dbbcd73`
- License: `AGPL-3.0-only`
- Imported history: complete Git history from `taracodlabs/aiden`
- Existing AGPL notices: retained

## Primary copyright owner

- Known owner: Shiva Deore / TARACOD for commits authored through Shiva's documented identities.
- Evidence: 1,822 of 1,828 commits are authored by Shiva identities; repository copyright headers and package metadata name Shiva Deore/Taracod.
- Limits: Git authorship is evidence of contribution, not by itself a complete chain-of-title determination.

## External contributors

| Contributor | Email | Commits / PRs | Files affected | Agreement evidence | Relicensing status |
|---|---|---:|---|---|---|
| Kumar Ayush (`Ayush9924`) | `152469050+Ayush9924@users.noreply.github.com` | 1 commit, PR #68 | `cli/aiden.ts` | Commit has a DCO-style `Signed-off-by`; no CLA acceptance comment or review record was found. The CLA present at the time described a future skills repository rather than this core repository. | unclear |
| Dependabot | GitHub application identity | 5 commits | dependency manifests and lockfile | Automated dependency update identity; upstream package licences govern imported dependency code. | not applicable as a human copyright grant |

PR #68 changed one display expression from an enabled-skill count to an enabled/total count. The current `cli/aiden.ts` still contains that expression and Git blame attributes it to the external commit. The contribution is small, but no legal conclusion is inferred from size.

## Contributor terms

- `.github/CLA.md` existed before PR #68, but its then-current text targeted a future `aiden-skills` repository and did not clearly cover Aiden core.
- The current `.github/CLA.md` contains unresolved merge-conflict markers and two text variants. It is not a reliable operative agreement in its current form.
- `.github/cla-bot-config.yml` states that actual authorization depends on the external CLA Assistant dashboard.
- GitHub PR comments and reviews for PR #68 contain no recorded CLA acceptance statement.
- The `Signed-off-by` line is evidence of a DCO sign-off, not evidence of a proprietary relicensing grant.

## File-level risk map

| Area | External human patch found | Current risk |
|---|---|---|
| Core runtime | No | Owner history plus third-party dependencies; verify notices before distribution. |
| Workbench | No | Owner history plus dependency obligations. |
| Browser Operator | No | Owner history plus Playwright/Chromium distribution obligations. |
| Apps | No | Owner history plus provider SDK licences and service terms. |
| External Coding | No | Owner history plus external executable/service terms. |
| Live Execution | No | Owner history plus runtime dependencies. |
| v4 CLI | No | Owner history plus dependencies. |
| Legacy CLI | Yes, `cli/aiden.ts` one-line banner count | Relicensing unclear; replace independently or keep under AGPL before proprietary distribution. |
| Tests | No external human patch identified | Owner history plus fixture provenance review. |
| Documentation | No external human patch identified | Owner history; preserve third-party notices and links. |

## Third-party code and notices

The lockfile is the dependency-version authority. Direct production dependencies are predominantly MIT, with these other declared licences:

- Apache-2.0: `discord.js`, `dockerode`, `playwright`, optional `decibri`.
- BSD-2-Clause: `dotenv`.
- ISC: `epub2`, `lru-cache`, optional `@composio/core`, optional `node-record-lpcm16`.
- MIT-0: `nodemailer`.
- `qrcode-terminal` uses an Apache-2.0 declaration in its package metadata; the lockfile does not normalize it into a `license` field, so its distributed notice must be checked directly.
- Bundled skills are governed by `LICENSE-SKILLS.md` and any per-skill notices.
- Browser binaries, native modules, generated dashboard assets, and Electron artifacts require a release-time notice/content audit; they are not reclassified by this repository inventory.

Required action before commercial distribution:

1. Generate a complete transitive software bill of materials from the exact release lockfile.
2. Preserve copyright and licence texts required by MIT, Apache-2.0, BSD, ISC, and other transitive packages.
3. Review browser-binary, FFmpeg/Electron, native-module, and optional-plugin notices for the exact artifact.
4. Do not treat generated or vendored output as TARACOD-owned source without tracing its origin.

## Relicensing conclusion

**YELLOW — some rights require legal confirmation.**

Private development may continue while the imported baseline remains AGPL and notices are preserved. Closed-source distribution or relicensing must not proceed until counsel confirms the contributor/CLA chain and the exact distribution's third-party obligations. The specific external legacy banner line can be independently replaced or excluded, but that engineering action alone is not a legal opinion about the complete codebase.

