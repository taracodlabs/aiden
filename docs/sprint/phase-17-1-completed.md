# Phase 17.1 — Three small fixes from manual smoke

**Branch:** `v4-rewrite` · **Range:** `70d1293..865e1ae` (3 commits + 1 doc)
**Status:** closed.

## Fixes

| # | Bug | Fix | Commit |
|---|-----|-----|--------|
| 1 | `/plugins grant` printed "Grant cancelled" before user could type — the readline prompt never blocked. | `chatSession.ts` confirm hook read `this.opts.promptApi?` (undefined when no override is passed); silent optional-chain → false. Use the resolved local `promptApi` (`createDefaultPromptApi()` default) already constructed at line 196. | `88a3ef2` |
| 2 | Together returned 400 once the CDP plugin loaded: `tools[40].function: missing field 'parameters'`. | The CDP plugin's three tool defs used `input_schema` (snake_case) but the canonical `ToolSchema` interface is `inputSchema` (camelCase). Adapter read `undefined` and dropped the wire field. Rename in `plugins/aiden-plugin-cdp-browser/index.js` + 4 test fixtures. Schemas themselves were already correct (selector required for click, script for eval, optional selector for extract). | `a0ec3ba` |
| 3 | "NEW permissions requested" warning fired on FIRST install — `previous=[]` made every declared perm look new. | Gate the NEW framing on `isUpgrade = previous.length > 0 && newPerms > 0`. First install shows plain "Permissions requested: …"; warn fires only when the granted file actually narrows the manifest's declared set. Confirm copy follows the same gate. | `865e1ae` |

## Tests

5 new (`tests/v4/plugins/phase17_1.test.ts`); plugin total **62 → 67**, all green:

- `63.` confirm hook invoked exactly once with a `[y/N]` prompt string
- `64.` confirm rejected → granted file NOT written
- `65.` all three CDP tools expose JSON Schema `inputSchema` block (with required fields enforced)
- `66.` first install → no "NEW" framing, plain "Permissions requested: …"
- `67.` upgrade → "NEW" framing on the diff only (existing perms not re-flagged)

## Cost

$0 — every test mocks file system and confirm; no live API calls. Manual user smoke (real Together + real Chrome for the play-song loop) is the next gate.

## Known follow-up (banked, not Phase 17.x)

- The "broken `/watch?v=` URL" pattern observed in Phase 16h is a media-search skill bug (web_search returning stale or non-`/watch?v=` URLs) and is **not** a plugin-system regression. Banked for **Phase 22**.

## Next

Manual user smoke validates the full architectural loop with real Together + real Chrome. Then **Phase 18** (Windows native build + OAuth providers as bundled plugins).
