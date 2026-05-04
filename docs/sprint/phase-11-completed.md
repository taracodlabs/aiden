# Phase 11 — Completed

**Date:** 2026-05-04
**Branch:** `v4-rewrite`
**Commits (5 feature + this summary):**
- `b8eb4b0` — feat(v4): MCP transports + tool filter + credential filter
- `bec537f` — feat(v4): MCP client with auto-discovery + tool prefix
- `1b46545` — feat(v4): MCP server stub (full impl deferred to v4.1)
- `1596682` — feat(v4): MCP config wiring helper
- `164bcda` — test(v4): integration test with real filesystem MCP server
- (this file) — docs(v4): phase 11 summary

## Goal

Add MCP support to v4. AidenAgent can now connect to external MCP
servers (stdio + HTTP), discover their tools through the
`notifications/tools/list_changed` mechanism, and dispatch calls to
them through the v4 ToolRegistry under `mcp_<server>_<tool>`. Stdio
subprocesses run with a credential-filtered env. Aiden as MCP server
is stubbed — the gateway-dependent tools (`messages_send`, `events_*`,
`permissions_*`) land in v4.1.

## Task 1 — Inventory

| Item | Source | Strategy |
|---|---|---|
| Hermes MCP client | `tools/mcp_tool.py` (~3.1k LOC) | Port patterns: `_build_safe_env`, `_sanitize_error`, sampling refusal, list_changed handling. Don't port literally. |
| v3 MCP client | `core/mcpClient.ts` (~531 LOC, `MCPClient` + `McpManager`) | Already has stdio + HTTP + reconnect. Used as protocol reference but **not reused** — v4 builds clean against transport interface. |
| v3 prefix | `<server>:<tool>` | v4 switches to `mcp_<server>_<tool>` per architecture spec |
| Hermes safe env | L252 `_SAFE_ENV_KEYS` | Extended for Windows: `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `SYSTEMROOT`, `COMSPEC`, etc. |
| Hermes credential regex | L257 | Extended to 12 patterns (Anthropic, OpenAI legacy + project, Groq, Together, GitHub PAT classic + fine-grained, Slack, AWS, Bearer, generic key=) |
| Real test target | `@modelcontextprotocol/server-filesystem` | Reliable; works with Windows once we bypass `npx.cmd` (Node 18.20+ EINVAL on `.cmd` shims with shell:false) and spawn `node <npx-cli.js>` directly. |

## Subsystem APIs

```ts
// core/v4/mcp/transport.ts (~360 lines)
interface McpTransport {
  request(method, params?, opts?): Promise<unknown>;
  notify(method, params?): void;
  onNotification(handler): void;
  close(): Promise<void>;
  readonly label: string;
}
class StdioTransport implements McpTransport     // newline-delimited JSON-RPC
class HttpTransport  implements McpTransport     // POST /messages + SSE notifications

// core/v4/mcp/filters.ts (~50 lines)
class McpToolFilter { filter, allows, matches }   // include/exclude with `*` and `?` globs

// core/v4/mcp/credentialFilter.ts (~150 lines)
class McpCredentialFilter {
  buildEnv({explicit, allowlist, source}): Record<string,string>;  // safe-env allowlist
  redact(text): string;                                            // 12 token patterns
}

// core/v4/mcpClient.ts (~330 lines, replaces Phase 1 stub)
class McpClient {
  connect(config): Promise<McpServer>;
  disconnect(serverName): Promise<void>;
  reload(): Promise<void>;          // /reload-mcp wires here in Phase 14
  callTool(serverName, rawName, args): Promise<unknown>;
  closeAll(): Promise<void>;
  list(): McpServer[]; get(name): McpServer | undefined;
}
function createMcpClient(registry, opts?): McpClient;

// core/v4/mcpServerStub.ts (~85 lines)
class AidenMcpServer { start() throws "Phase 11 stub"; stop() noop; }
const AIDEN_MCP_SERVER_TOOLS  // 10-tool surface for v4.1

// tools/v4/mcpSetup.ts (~75 lines)
async function setupMcpFromConfig(config, registry, opts?):
  Promise<{ client, connected: string[], failures: Record<string,string> }>
```

## Token format coverage (credential redaction)

| Pattern | Example | Status |
|---|---|---|
| Anthropic | `sk-ant-…` | ✅ |
| OpenAI legacy | `sk-…32+` | ✅ |
| OpenAI project | `sk-proj-…` | ✅ |
| Groq | `gsk_…40+` | ✅ |
| Together v1/v2 | `tgp_v[12]_…` | ✅ |
| GitHub PAT classic | `ghp_…30+` | ✅ |
| GitHub PAT fine-grained | `github_pat_…` | ✅ |
| Slack bot/user/etc. | `xox[baprs]-…` | ✅ |
| AWS access key id | `AKIA[16 alphanum]` | ✅ |
| Bearer header | `Bearer …` | ✅ |
| Generic `token=`, `api_key=`, `password=`, `secret=` | k/v query strings | ✅ |

12 patterns total. Defensive: token-shaped values are also stripped from inherited env vars before they reach the subprocess.

## Test coverage

| File | New cases |
|---|---:|
| `tests/v4/mcp/transport.test.ts` | 18 |
| `tests/v4/mcp/filters.test.ts` | 8 |
| `tests/v4/mcp/credentialFilter.test.ts` | 22 |
| `tests/v4/mcpClient.test.ts` | 13 |
| `tests/v4/mcpServerStub.test.ts` | 4 |
| `tests/v4/mcpSetup.test.ts` | 5 |
| `tests/v4/integration/mcpClient.real.test.ts` | 4 (3 real-protocol + 1 npx probe) |
| **Phase 11 new** | **74** |

Cumulative v4: **545 passed, 5 skipped** (was 469 in Phase 10 — +76 net,
the extra two beyond the unit count come from the integration suite).

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run tests/v4/ --no-file-parallelism` | ✅ 545 passed, 5 skipped, 2 file-skipped |
| Real MCP filesystem server: connect → tools/list → list_directory + read_file round-trip | ✅ via `node <npx-cli.js>` shim — see [resolveNpxLaunch](../../tests/v4/integration/mcpClient.real.test.ts) |
| AidenAgent + MCP plumbing: registry executor dispatches `mcp_fs_*` tool | ✅ proves the agent loop's call path without burning provider quota |
| `npm test --no-file-parallelism` (full regression) | ✅ **1959 passed**, 1 failed, 5 skipped, 1 todo. 17 pre-existing file failures (16 from Phase 10 + 1 flaky Groq live test). The single test failure is the flaky Together AI integration test seen since Phase 7. |
| Zero v3 regressions | ✅ |

## Cost spent

Zero LLM calls. The "AidenAgent + MCP plumbing" test deliberately bypasses the provider and exercises `registry.buildExecutor(ctx)` directly — that proves the same dispatch path the agent loop uses, without burning quota. A live LLM-driven version is a Phase 13 prompt-builder concern (the model picks tool names from advertised schemas; whether it picks `mcp_fs_list_directory` reliably is prompt design, not plumbing).

## Graphify

| Metric | Pre-Phase 11 | Post-Phase 11 | Δ |
|---|---:|---:|---:|
| Nodes | 2256 | **2342** | +86 |
| Edges | 4028 | 4147 | +119 |
| Communities | 148 | 148 (some restructured) | 0 |

Hook fired on each commit; rebuild ran inline.

## Windows note (worth keeping)

Node 18.20+ refuses to spawn `.cmd` / `.bat` shims with `shell: false`
(returns EINVAL — security patch around CVE-2024-27980). `shell: true`
"works" but mangles arguments containing path separators when cmd.exe
parses them. The clean workaround: bypass the shim. For npx, that
means spawning `node "<install>/node_modules/npm/bin/npx-cli.js"`
directly with the original args. The integration test's
`resolveNpxLaunch()` is the reference implementation — Phase 14's CLI
should reuse this pattern when MCP servers point at npm-bundled
binaries.

## What Phase 12 needs

- **Aiden moat (PlannerGuard, HonestyEnforcement, SkillTeacher Tier 3).**
  These are the v3.19.x fabrication band-aids reframed as architectural
  guards now that the single-loop agent has landed. PlannerGuard and
  HonestyEnforcement plug into the agent-loop control flow; SkillTeacher
  Tier 3 plugs into the skills hub registered in Phase 10.
- **Aiden as MCP server (deferred from Phase 11)** — full impl needs
  the gateway, lands v4.1.
- **MCP Sampling support** — currently refused with `sampling/error`.
  v4.1 wires it back to the running provider. Loop control flow must
  support the round-trip without re-entering the conversation.

## Acceptance check (Phase 11)

- [x] Task 1 inventory reported BEFORE coding
- [x] Stdio + HTTP transports implemented behind common interface
- [x] McpClient with auto-discovery + `mcp_<server>_<tool>` prefix
- [x] Credential filter strips 12 token formats from env + logs
- [x] Server stub documented with the 10-tool v4.1 surface (no impl)
- [x] Config wiring helper graceful on connect failures
- [x] All 74 new tests pass
- [x] Real filesystem MCP server integration test passes
- [x] AidenAgent + MCP plumbing test passes
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression preserved (1882 → 1959, no new non-flaky failures)
- [x] Five feature commits pushed to `backup`
- [x] Phase summary under 200 lines (this file)
