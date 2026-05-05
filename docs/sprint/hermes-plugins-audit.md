# Phase 17 — Hermes plugin system audit

Date: 2026-05-05  
Reference: `C:\Users\shiva\references\hermes-agent` (graphify-out present)  
Token budget: under 12k. Decisions on copy/adapt/diverge per surface below.

## TL;DR

Hermes ships a small but complete plugin architecture in **two files** plus a per-plugin `plugin.yaml` + `__init__.py` convention. The whole system is in-process (no separate workers), discovers four sources, and isolates plugin failures via try/catch around hooks and `_load_plugin`. There is **no fine-grained capability/permission grant** in Hermes — the security model is "the user explicitly opted in via `plugins.enabled` and the manifest declared `requires_env`." That is the one place where Phase 17 must add net-new design (permission declaration + grant + persisted grant file).

The architecture ports cleanly to TS/Node. Process-model (workers) is **not** required and is explicitly out of scope for v4.0 per the prompt's stop-condition.

## Files of record (Hermes)

| Surface | File | Lines |
|---|---|---|
| Plugin manager (loader, registry, hook dispatch) | `hermes_cli/plugins.py` | full file (~1115 lines) |
| Manifest dataclass | `hermes_cli/plugins.py` | L179–L213 |
| `LoadedPlugin` runtime state | `hermes_cli/plugins.py` | L216–L226 |
| `PluginContext` (handed to `register(ctx)`) | `hermes_cli/plugins.py` | L233–L455 |
| `PluginManager.discover_and_load` | `hermes_cli/plugins.py` | L617–L750 |
| Directory scanner (flat + category) | `hermes_cli/plugins.py` | L756–L835 |
| Manifest parser | `hermes_cli/plugins.py` | L837–L907 |
| Entry-point (pip) scanner | `hermes_cli/plugins.py` | L913–L937 |
| Module loader + `register(ctx)` invocation | `hermes_cli/plugins.py` | L943–L993 |
| Hook invocation (try/except per callback) | `hermes_cli/plugins.py` | L1055–L1089 |
| `hermes plugins` CLI subcommand | `hermes_cli/plugins_cmd.py` | full file (~1500 lines) |
| Example bundled plugin (Spotify, kind=backend) | `plugins/spotify/plugin.yaml` + `__init__.py` | full files |
| Example bundled hook plugin | `plugins/disk-cleanup/plugin.yaml` | full file |

Valid hooks set: `plugins.py:78–114`.

## Manifest shape (Hermes — `plugin.yaml`)

Free-form YAML, parsed into `PluginManifest` dataclass at `plugins.py:179`:

```yaml
name: spotify
version: 1.0.0
description: "..."
author: NousResearch
kind: backend                 # standalone | backend | exclusive | platform
provides_tools: [spotify_playback, spotify_search, ...]
provides_hooks: [post_tool_call, ...]
requires_env: [SPOTIFY_CLIENT_ID, ...]
manifest_version: 1           # optional, schema-version gate
```

No `permissions` field. Security gating is via `plugins.enabled` (opt-in) and `requires_env` (declarative env-var requirement). Bundled `kind: backend|platform` auto-loads (`plugins.py:720`); everything else is opt-in.

## Discovery (Hermes)

Four sources, later wins on key collision (`plugins.py:638–671`):

1. Bundled — `<repo>/plugins/<name>/`
2. User — `~/.hermes/plugins/<name>/`
3. Project — `./.hermes/plugins/<name>/` (env-gated `HERMES_ENABLE_PROJECT_PLUGINS`)
4. Pip entry-points — group `hermes_agent.plugins`

Two layouts: flat (`plugins/disk-cleanup/`) and category (`plugins/image_gen/openai/`). Depth capped at 2 (`plugins.py:790`).

## Loading + sandboxing

Each plugin import + `register(ctx)` call is wrapped in `_load_plugin` try/except (`plugins.py:943–993`) — a broken plugin populates `LoadedPlugin.error` and the rest of the system continues. Hook callbacks are individually wrapped (`plugins.py:1077–1088`):

```python
for cb in callbacks:
    try:
        ret = cb(**kwargs)
        ...
    except Exception as exc:
        logger.warning("Hook %s callback %s raised: %s", ...)
```

That's the entire isolation model. **No process boundary, no resource limits, no syscall sandbox.** Sufficient for v4.0.

## CLI (`hermes plugins`)

Subcommands at `plugins_cmd.py`: `install` (L398), `remove` (L521), `enable` (L618-area), `disable` (L906-area `cmd_toggle`), `list` (composite UI), plus dashboard variants. Install accepts a Git URL or `owner/repo` shorthand, clones into `~/.hermes/plugins/<name>/`, prompts for `requires_env` vars (`_prompt_plugin_env_vars` L176), renders `after-install.md` if shipped. Plugin name is sanitised against path traversal (`_sanitize_plugin_name` L43).

## Permission model (Hermes — minimal)

This is the **gap** for Aiden Phase 17. Hermes has no declared-capability grants; the trust model is "user opted in via config + manifest declared env vars." Phase 17 spec needs more: `permissions: [network, shell, filesystem, subprocess, ...]`, surfaced at install time, persisted as `.granted-permissions.json`, checked at tool dispatch.

This is **net-new design**, not a port. It is also advisory only (no OS-level sandbox in v4.0 — flag per stop-condition #3, real sandbox in v4.1).

## Decisions (per surface): copy / adapt / diverge

| Surface | Decision | Notes |
|---|---|---|
| Manifest schema (name/version/description/author/provides_tools/provides_hooks) | **Copy** | Match Hermes field names verbatim so future tooling/lint can be shared. |
| Manifest format | **Adapt: JSON** | TS ecosystem default. `plugin.json`. Validate with hand-rolled schema check (no ajv dep — keeps `npm install` lean). |
| `kind` field | **Adapt: simplify to `standalone` + `bundled`** | v4.0 has no exclusive/platform/backend categories yet. Add later when needed. |
| `permissions` field | **Diverge: net-new, advisory-only** | Hermes has no permissions field; Aiden adds advisory-only permissions for Pro-tier trust UX, **not as a security boundary**. Manifest validator enforces declared-equals-actual usage; install flow shows user a permission summary; granted set persists. No OS sandbox, no runtime enforcement beyond honest declaration. v4.1 may revisit. Set: `["network","shell","filesystem","subprocess","browser","memory"]`. |
| `requires_env` | **Copy** | Same semantics. |
| 4-source discovery | **Adapt to 3** | Bundled (`<package>/plugins/`), user (`paths.pluginsDir`), npm entry-points (via `package.json#aiden.plugin` field). Drop project-local for v4.0 — opens injection vector, low value. |
| `register(ctx)` entrypoint pattern | **Copy** | TS export: `export function register(ctx: PluginContext): void`. |
| `PluginContext.register_tool` | **Copy + adapt** | Wraps existing `ToolRegistry.register(handler)` and tracks plugin-ownership for `/plugins info`. |
| Lifecycle hooks | **Adapt: minimal set** | v4.0 ships `onLoad`, `onActivate`, `onTeardown` only. Per-tool-call hooks (Hermes's `pre_tool_call` etc.) are deferred — they need careful threading through `aidenAgent` and aren't required by Task 2's CDP plugin. |
| Per-plugin try/catch isolation | **Copy** | Wrap `register()` and every tool execute in try/catch. Surface errors honestly via `/plugins`. |
| Process-model sandbox | **Defer to v4.1** | Per stop-condition #1. In-process only. Document in phase-17 summary. |
| Permission grant flow | **Diverge: net-new** | Install-time confirmation, all-or-nothing grant for v4.0, persist to `<plugin-dir>/.granted-permissions.json`. |
| Permission enforcement | **Advisory only** | v4.0: tool dispatch checks `permissions[]` against granted set, refuses with "permission not granted" error. No OS-level sandbox. Document gap. |
| `hermes plugins` CLI commands | **Copy + adapt** | Map to slash commands `/plugins list/install/remove/reload/info`. Drop Git-clone install path (security; npm-install path covers entry-points; local-path install for dev/testing). |
| Manifest version gate | **Copy** | `manifestVersion: 1` field, future-proofing. |
| Plugin name path-traversal sanitiser | **Copy verbatim** | `plugins_cmd.py::_sanitize_plugin_name` (L43) — direct port. |

## Stop-conditions check (vs prompt)

1. *Hermes plugin architecture requires a process model Aiden can't match.* — **Resolved.** Hermes is in-process. No separate workers needed. Adopting in-process; document divergence vs. spec since spec already permitted in-process.
2. *CDP attach to user's real Chrome requires Chrome flags users won't enable.* — **Defer to Task 2**. Plan: ship a Chrome launch helper that starts Chrome with `--remote-debugging-port=9222` on plugin activate; instruct user if helper fails (e.g., Chrome already running without the flag).
3. *Plugin permissions need OS-level sandboxing.* — **Confirmed gap.** v4.0 ships advisory-only permissions (declare + grant + dispatch-time check) — Pro-tier trust UX, not a security boundary. Real sandbox revisited in v4.1.
4. *Hermes plugin format conflicts with existing skill/tool registrations.* — **No conflict.** Plugins use `ctx.register_tool(handler)` which delegates to existing `ToolRegistry.register()`. Same registry, no adapter layer needed. Skills and plugins are orthogonal: skills are markdown bundles loaded by `skillLoader`; plugins are TS modules loaded by `pluginLoader`. A plugin *can* register skills via `ctx.register_skill(...)` (Phase 17.5 if needed; not blocking Task 2).

## Bundled plugins inventory (Hermes)

For reference (decision-making for v4.x roadmap, not Phase 17 ports):

- `plugins/disk-cleanup/` — file cleanup hooks
- `plugins/spotify/` — 7 Spotify Web API tools (closest analog to Aiden's CDP/media goal)
- `plugins/google_meet/` — meet tools
- `plugins/image_gen/<backend>/` — image-gen backend plugins (category layout)
- `plugins/memory/<provider>/` — exclusive-kind memory providers (honcho, mem0, etc.)
- `plugins/observability/<backend>/` — langfuse etc.
- `plugins/platforms/<adapter>/` — gateway adapters (IRC etc.)
- `plugins/context_engine/`, `plugins/kanban/`, `plugins/example-dashboard/`, etc.

Aiden v4.0 ships **one** bundled plugin: `aiden-plugin-cdp-browser` (per Phase 17 Task 2). The others inform Phase 18+ (OAuth providers as bundled plugins).

## Plugin vs skill distinction (locked)

- **Skill** = markdown bundle in `skills/<name>/SKILL.md`. Pure prompt/instructions. Loaded by `skillLoader`. No code.
- **Plugin** = TS module in `plugins/<name>/` with a `plugin.json` + `index.js` exporting `register(ctx)`. Can register tools, hooks, and (later) skills. Has executable code.

A plugin can *contribute* skills (drop SKILL.md files into a directory the loader scans), but skills cannot contribute tools. Same boundary Hermes draws.

## Targets for Task 1 (concrete file plan)

- `core/v4/plugins/pluginManifest.ts` — `PluginManifest` interface, `parseManifest(json)`, `validateManifest(m)` (returns `{ok: true} | {ok: false, errors: string[]}`), `MANIFEST_VERSION = 1`.
- `core/v4/plugins/pluginRegistry.ts` — `PluginRegistry` class tracking `LoadedPlugin` records (manifest + module + state + error). Mirrors Hermes `_plugins` Dict.
- `core/v4/plugins/pluginLoader.ts` — `discoverAndLoad(paths, registry, ctx)`. Scans bundled dir + `paths.pluginsDir`, parses manifests, dynamic `import()` of each plugin's `index.js`, calls `register(ctx)` in try/catch.
- `core/v4/plugins/pluginContext.ts` — `PluginContext` class, exposes `registerTool(handler)`, `registerHook(name, fn)`, `manifest` getter.
- `core/v4/plugins/pluginPermissions.ts` — `PERMISSION_TYPES` const, `loadGrantedPermissions(pluginDir)`, `saveGrantedPermissions(pluginDir, perms)`, `hasPermission(loaded, perm)`.

Replaces the existing `core/v4/pluginManager.ts` scaffold with the full module set.

## End

Audit complete. Begin Task 1 in next commit. Token usage for audit: well under the 12k budget.
