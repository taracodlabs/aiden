# Aiden v4.17.0

## Durable Autonomy Kernel + Operator TUI

Aiden v4.17.0 strengthens durable execution and unifies the terminal operator experience.

### Durable execution

- Production entry points share one authoritative Job and Attempt lifecycle.
- Generations, leases, fence tokens, terminal-state guards, and persist-first cancellation reject stale execution.
- Durable input, execution graphs, effect reconciliation, child supervision, and budgets retain recovery-safe state.

### Evidence and verification

- Completion is projected from authoritative evidence rather than response prose.
- File mutations require fresh exact readback before verified completion.
- Replay, migration, recovery, and failure-injection coverage protect durable state transitions.

### Operator experience

- The canonical Aiden startup identity adapts across terminal widths.
- The boxed composer and separate provider, model, context, and timer strip remain stable while work runs.
- Theme-aware rendering, compact outcomes, durable queued input, `/cls`, `/clear`, and clean shutdown improve daily operation.

### Platform reliability

- Windows terminal ownership, process cleanup, and ConPTY behavior are covered alongside Ubuntu and macOS CI.
- Node 20 and Node 22 remain covered by the release matrix.

### Known non-blocking polish

- `/cls` may leave a visually empty terminal region.
- `/quit` output remains more verbose than desired.
- First-run name extraction and onboarding transitions can be polished later.
