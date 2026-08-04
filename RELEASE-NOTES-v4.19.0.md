# Aiden v4.19.0

Aiden v4.19.0 is the stable Worker and Model Bridge release for
`aiden-runtime`.

## Highlights

- Durable Worker contracts and read-only repository Workers.
- Parent and child execution authority with immutable provider and model binding.
- Separate logical provider-call and physical-attempt accounting.
- Durable token and usage accounting, budget reservation, and pre-send enforcement.
- Bounded retries and provider fallback.
- Cancellation during provider work and rejection of late provider results.
- Worker restart and reopen.
- Child Evidence with parent Verification.
- Parallel Worker admission and reservations.
- Stable joins and deterministic reconciliation.

## Validation

The release candidate evidence was accepted across the supported runtime and
integration gates:

- Windows Node 20 non-PTY: 7,533 passed, 48 skipped.
- Windows Node 22 non-PTY: 7,533 passed, 48 skipped.
- Windows PTY Node 20: 45 passed.
- Windows PTY Node 22: 45 passed.
- Built CLI ConPTY: 11 passed.
- Worker/recovery/cancellation: 122/122.
- Focused lifecycle: 50/50.
- Integration: 39 passed, 7 credential-dependent skipped.
- Two-hour soak: 1,414 cycles, 4,548 provider calls, 0 failures, 0 crashes,
  0 hangs, 0 database locks, 0 duplicate effects, and 0 process leaks.

## Known issue

Aggressive terminal resizing may produce cosmetic activity-row projection
artifacts. Investigation found no duplicate tool execution, duplicate mutating
effect, durable-state corruption, approval corruption, lost input, or crash.
This remains classified as a P2 cosmetic issue and is not a correctness
failure.
