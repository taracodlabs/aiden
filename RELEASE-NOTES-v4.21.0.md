# Aiden v4.21.0

Aiden 4.21 brings the latest execution runtime and Workbench experience
together in one public release under AGPL-3.0.

## Highlights

- **Premium Workbench v2** with clearer task control, responsive navigation,
  durable continuity, live execution, safe Markdown, and improved accessibility.
- **Reliable Automations** with durable schedules, occurrence identity,
  overlap control, approval continuation, restart recovery, and readiness
  diagnostics.
- **Agentic Presence** with durable attention policy, bounded observations,
  proposed Jobs, feedback, and restart-safe state.
- **Evidence-linked Learning** that stores verified, scoped sources and uses
  bounded context without treating unverified content as fact.
- **Skill Intelligence** with immutable versions, exact invocation identity,
  compatibility checks, outcome tracking, and management surfaces.
- **Secure Capability runtime** with permission declarations, immutable package
  identities, process isolation, recovery, and explicit activation.
- **Modern MCP support** across stdio and Streamable HTTP, including protocol
  negotiation, OAuth discovery, reconnects, capability review, and fail-closed
  external tool authorization.
- **A2A read-only delegation** with durable remote-task identity, trust state,
  artifact quarantine, recovery, and local parent verification.
- **Browser Operator, Apps, and external coding workflows** integrated with
  durable Jobs, approvals, Evidence, and Workbench projections.

## CLI and Workbench

`aiden` starts the interactive CLI.

`aiden web` starts the Workbench, prints its local URL, opens the browser when
enabled, and shuts down cleanly with Ctrl+C.

Both surfaces use the same durable runtime authorities for Job and Attempt
identity, cancellation, approvals, Evidence, Verification, recovery, and stale
result rejection.

## Reliability and trust

- Mutating actions remain approval-gated and bound to exact action identity.
- Durable execution records survive restart and reject stale generations,
  expired leases, and late completion.
- Evidence and Verification remain separate from model prose.
- Worker and remote-task results remain subject to parent-side verification.
- Unknown outcomes remain explicit instead of being converted into ordinary
  success or failure.

## Supported runtimes

Aiden v4.21.0 supports Node 20 and Node 22. The dependency-light launcher
rejects unsupported Node versions before native SQLite modules load.

Some optional isolated Capability validation requires Docker. A2A mutation
remains disabled; remote delegation is read-only and locally verified.

## Install

```bash
npm install -g aiden-runtime@4.21.0
aiden
```

To open the Workbench:

```bash
aiden web
```

Existing settings, workspaces, Jobs, Evidence, and provider configuration remain
outside the replaceable npm package and are preserved during reinstall or
update.
