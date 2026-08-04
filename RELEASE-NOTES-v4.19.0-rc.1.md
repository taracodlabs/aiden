# Aiden v4.19.0-rc.1

## Release candidate overview

Aiden v4.19.0-rc.1 is a release candidate for the durable autonomy, Codebase Mode, Operator TUI, and Worker reliability work completed across v4.17, v4.18, and v4.19 development.

This build is intended for review and release-candidate validation. It is not the stable v4.19.0 release.

### Durable Autonomy Kernel

- Durable Job and Attempt authority preserves execution identity across entry points and restarts.
- Generations, leases, fence tokens, terminal-state protection, and stale-owner rejection prevent late execution from changing current truth.
- Persist-first cancellation and restart recovery preserve durable state before physical interruption.
- Exact-action approvals bind decisions to the normalized action and authoritative execution identity.
- Effect reconciliation retains unknown outcomes for safe review instead of converting them into ordinary failures.
- Evidence, Verification, Verdict, and Proof project completion from recorded execution facts rather than response prose.
- Durable queued input preserves ordering, acknowledgement, recovery, and exactly-once consumption semantics.

### Operator TUI

- Startup identity and responsive terminal presentation remain usable across normal and narrow widths.
- Semantic activity, compact outcomes, composer ownership, queued-input visibility, and approval restoration improve operator control.
- Windows terminal cleanup, resize handling, native scrollback, and clean shutdown have expanded automated and physical coverage.

### Codebase Mode

- Repository snapshots capture immutable file and VCS state for source-backed inspection.
- Source-fenced mutations reject stale repository state and preserve conflict evidence.
- Structured TestRun and BuildRun records retain validation results durably.
- Git Effects record and reconcile repository mutations without bypassing effect authority.
- Repository understanding projects inspected structure and durable coding plans into existing execution state.

### Worker and Model Bridge

- Read-only repository Workers execute through durable parent and child authority.
- Provider and model bindings remain immutable for each admitted Worker execution.
- Logical provider calls and physical attempts are accounted separately across retries and fallbacks.
- Retries are bounded, and provider budgets and reservations are enforced before dispatch.
- Cancellation fences late provider results and prevents stale Worker completion.
- Parent-side Evidence verification decides whether child results are accepted.
- Worker restart, recovery, bounded parallel coordination, stable reservations, and deterministic joins preserve durable ordering.

### Cross-platform and packaging hardening

- Windows, Ubuntu, and macOS validation covers supported Node 20 and Node 22 runtimes.
- Source, built, and packaged CLI paths are exercised for startup, version reporting, command help, and clean exit.
- Package-content, process-cleanup, database-reopen, migration, and failure-injection gates protect the release candidate.

## Known issues

- Aggressive terminal resizing can still produce cosmetic activity-row projection artifacts.
- Current evidence classifies this as presentation-only: no duplicated semantic tool execution or durable-state corruption was found.

## Review status

This release candidate must complete review and CI before any npm publication, Git tag, or GitHub Release is created.
